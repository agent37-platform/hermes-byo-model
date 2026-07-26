import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashProxyToken } from "@/lib/proxy-token";
import {
  extractUsage,
  listCatalog,
  modelAllowed,
  openrouterKey,
  usageFromSse,
  OPENROUTER_BASE,
  type LlmUsage,
} from "@/lib/openrouter";
import { DEFAULT_MODEL } from "@/config/models";
import { branding } from "@/config/branding";
import { publicSiteOrigin } from "@/lib/site-url";

// The money proxy — an OpenAI-compatible endpoint that agents talk to instead of a model provider.
// This is the whole point of the kit: your OPENROUTER_API_KEY stays here, on your server, and each
// agent instance holds only a per-agent token that this route maps back to its row.
//
//   instance ~/.hermes/config.yaml  base_url: {this app}/api/llm/v1   api_key: orp_…
//        │
//        ├─ 401  unknown / revoked token
//        ├─ 402  this agent is over its monthly cap
//        └─ else forward to OpenRouter with YOUR key, then meter the real cost it reports
//
// Hermes only ever calls two routes on a custom provider: GET /v1/models (to resolve model ids for
// the picker) and POST /v1/chat/completions (the turn). Everything else 404s.
export const maxDuration = 300;

// A turn carries the full conversation plus every tool result, so bodies are big — read them whole
// rather than streaming, since a re-serialize is needed anyway to inject usage accounting.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

type Ctx = { params: Promise<{ path: string[] }> };

interface AgentAuth {
  agentId: string;
  capMicros: number;
}

function errorJson(status: number, message: string, code: string): Response {
  // OpenAI-shaped so Hermes surfaces the message instead of a bare status.
  return Response.json({ error: { message, type: "invalid_request_error", code } }, { status });
}

async function authenticate(request: Request): Promise<AgentAuth | Response> {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) return errorJson(401, "Missing bearer token.", "missing_token");

  const db = createAdminClient();
  const { data, error } = await db
    .from("agents")
    .select("agent37_id, spend_cap_micros")
    .eq("proxy_token_hash", hashProxyToken(token))
    .maybeSingle<{ agent37_id: string; spend_cap_micros: number }>();

  // A DB outage must not read as a permanent auth failure to the agent.
  if (error) return errorJson(503, "Token lookup unavailable.", "lookup_unavailable");
  if (!data) return errorJson(401, "Invalid or revoked token.", "invalid_token");

  return { agentId: data.agent37_id, capMicros: data.spend_cap_micros };
}

// GET /api/llm/v1/models — the agent's model picker. Passes your OpenRouter catalog through
// (filtered by ALLOWED_MODELS when you curate one). If OpenRouter is unreachable, answer with the
// default id alone so the agent can still run a turn.
async function models(): Promise<Response> {
  try {
    const data = await listCatalog();
    return Response.json({
      object: "list",
      data: data.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.id.split("/")[0] || "openrouter",
      })),
    });
  } catch {
    return Response.json({
      object: "list",
      data: [{ id: DEFAULT_MODEL, object: "model", created: 0, owned_by: "openrouter" }],
    });
  }
}

// POST /api/llm/v1/chat/completions — the turn.
async function chatCompletions(request: Request, auth: AgentAuth): Promise<Response> {
  const key = openrouterKey();
  if (!key) return errorJson(500, "OPENROUTER_API_KEY is not set on the server.", "not_configured");

  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return errorJson(413, "Request body too large.", "body_too_large");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return errorJson(400, "Body must be JSON.", "invalid_body");
  }

  const model = typeof payload.model === "string" && payload.model ? payload.model : DEFAULT_MODEL;
  if (!modelAllowed(model)) {
    return errorJson(400, `Model ${model} is not allowed by this app.`, "model_not_allowed");
  }

  const db = createAdminClient();
  const { data: spent, error: spendError } = await db.rpc("llm_month_spend_micros", {
    p_agent37_id: auth.agentId,
  });
  // Fail open on a metering read error — a broken meter shouldn't take the agent down.
  if (!spendError && typeof spent === "number" && spent >= auth.capMicros) {
    return errorJson(
      402,
      `This agent has reached its monthly model budget of $${(auth.capMicros / 1_000_000).toFixed(2)}. Raise the cap in the dashboard to continue.`,
      "budget_exhausted"
    );
  }

  // Ask OpenRouter for exact per-call cost. It rides the JSON body when not streaming and the final
  // chunk before [DONE] when streaming — this is the meter's only cost source.
  const usageOption = (payload.usage ?? {}) as Record<string, unknown>;
  const body = JSON.stringify({ ...payload, model, usage: { ...usageOption, include: true } });

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        // Optional OpenRouter attribution — shows this app in your OpenRouter activity feed.
        "HTTP-Referer": publicSiteOrigin(),
        "X-Title": branding.appName,
      },
      body,
      cache: "no-store",
    });
  } catch {
    return errorJson(502, "OpenRouter is unreachable.", "upstream_unavailable");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);

  if (upstream.body && contentType.includes("text/event-stream")) {
    // Stream mode: tee the SSE through untouched and read the copy after the response is sent, so
    // metering never delays a token. after() keeps the serverless instance alive for it.
    const [toClient, toMeter] = upstream.body.tee();
    after(async () => {
      const text = await new Response(toMeter).text();
      await record(auth.agentId, usageFromSse(text, model));
    });
    return new Response(toClient, { status: upstream.status, headers });
  }

  // Non-stream mode: forward the body verbatim, then meter what it carries.
  const text = await upstream.text();
  if (upstream.ok) {
    after(async () => {
      try {
        await record(auth.agentId, extractUsage(JSON.parse(text), model));
      } catch {
        /* not JSON — nothing to meter */
      }
    });
  }
  return new Response(text, { status: upstream.status, headers });
}

async function record(agentId: string, usage: LlmUsage | null): Promise<void> {
  if (!usage) return;
  const { error } = await createAdminClient().rpc("increment_llm_usage", {
    p_agent37_id: agentId,
    p_model: usage.model,
    p_input: usage.inputTokens,
    p_output: usage.outputTokens,
    p_cost_micros: usage.costMicros,
  });
  // Metering must never break the transport; a lost row is visible in the logs.
  if (error) console.warn("[llm] usage row failed:", error.message);
}

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  if (path.join("/") !== "v1/models") return errorJson(404, "Not found.", "not_found");

  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  return models();
}

export async function POST(request: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  if (path.join("/") !== "v1/chat/completions") return errorJson(404, "Not found.", "not_found");

  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  return chatCompletions(request, auth);
}
