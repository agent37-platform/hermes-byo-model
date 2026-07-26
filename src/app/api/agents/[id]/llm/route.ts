import { requireAgentAccess } from "@/lib/auth";
import { llmProxyUrl } from "@/lib/bootstrap";
import { usdToMicros } from "@/lib/format";
import { ApiError, handleError, json, readJson } from "@/lib/http";
import { DEFAULT_MODEL } from "@/config/models";
import type { LlmStatus } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

// This agent's model wiring: what it runs on, what it has spent on your OpenRouter key this month,
// and the cap the proxy enforces.
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { db, row } = await requireAgentAccess(id, "member");

    const { data: spent, error } = await db.rpc("llm_month_spend_micros", { p_agent37_id: id });
    if (error) throw new ApiError(500, "db_error", error.message);

    const status: LlmStatus = {
      model: row.model || DEFAULT_MODEL,
      spend_micros: typeof spent === "number" ? spent : 0,
      cap_micros: row.spend_cap_micros,
      wired: !!row.proxy_token_hash && row.proxy_url === llmProxyUrl(),
      proxy_url: row.proxy_url,
    };
    return json(status);
  } catch (e) {
    return handleError(e);
  }
}

// Change this agent's monthly cap. Takes effect on the next turn — the proxy reads it per call.
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { db } = await requireAgentAccess(id, "admin");

    const { cap_usd } = await readJson<{ cap_usd?: number }>(request);
    if (typeof cap_usd !== "number" || !Number.isFinite(cap_usd) || cap_usd < 0 || cap_usd > 10_000) {
      throw new ApiError(400, "invalid_request", "cap_usd must be a number between 0 and 10000.");
    }

    const { error } = await db
      .from("agents")
      .update({ spend_cap_micros: usdToMicros(cap_usd) })
      .eq("agent37_id", id);
    if (error) throw new ApiError(500, "db_error", error.message);

    return json({ cap_micros: usdToMicros(cap_usd) });
  } catch (e) {
    return handleError(e);
  }
}
