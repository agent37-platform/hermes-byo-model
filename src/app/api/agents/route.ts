import { agent37 } from "@/lib/agent37";
import { requireAdmin, requireMember, requireUser } from "@/lib/auth";
import { AGENT_TEMPLATES, DEFAULT_AGENT, SERVICE_PORTS } from "@/config/agents";
import { DEFAULT_MODEL, DEFAULT_SPEND_CAP_USD } from "@/config/models";
import { kickBootstrap, llmProxyUrl, needsBootstrap } from "@/lib/bootstrap";
import { usdToMicros } from "@/lib/format";
import { ApiError, handleError, json, readJson } from "@/lib/http";
import type { Agent, AgentRow, MergedAgent, Template } from "@/lib/types";

// The image catalog barely changes, but the dashboard polls this route every 5s while any agent is
// transitioning — so cache the template list briefly rather than re-fetching /templates on every
// poll (and on create). Module-scoped + best-effort: a stale entry only delays an agent's
// `update_available` flag by at most the TTL.
let templateCache: { at: number; data: Template[] } | null = null;
const TEMPLATES_TTL_MS = 60_000;

async function getTemplates(): Promise<Template[]> {
  if (templateCache && Date.now() - templateCache.at < TEMPLATES_TTL_MS) return templateCache.data;
  const { data } = await agent37.listTemplates();
  templateCache = { at: Date.now(), data };
  return data;
}

async function resolveTemplate(): Promise<string | undefined> {
  try {
    const data = await getTemplates();
    const preferred = data.find((t) => t.name === DEFAULT_AGENT.template);
    if (preferred) return preferred.name;
    const builtin = data.find((t) => t.scope === "system");
    return (builtin ?? data[0])?.name;
  } catch {
    return DEFAULT_AGENT.template;
  }
}

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const workspaceId = new URL(request.url).searchParams.get("workspace");
    if (!workspaceId) throw new ApiError(400, "invalid_request", "workspace query param is required");

    const role = await requireMember(db, workspaceId, user.id);

    const { data: rows, error } = await db
      .from("agents")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw new ApiError(500, "db_error", error.message);

    let live = new Map<string, Agent>();
    let templateImages = new Map<string, string>();
    const [liveRes, tmplRes, spendRes] = await Promise.allSettled([
      agent37.listAgents(),
      getTemplates(),
      db.rpc("llm_month_spend_by_workspace", { p_workspace: workspaceId }),
    ]);
    if (liveRes.status === "fulfilled") {
      live = new Map(liveRes.value.data.map((i) => [i.id, i]));
    }
    if (tmplRes.status === "fulfilled") {
      templateImages = new Map(
        tmplRes.value.filter((t) => t.image_ref).map((t) => [t.name, t.image_ref])
      );
    }
    const spend = new Map<string, number>(
      spendRes.status === "fulfilled" && Array.isArray(spendRes.value.data)
        ? (spendRes.value.data as { agent37_id: string; cost_micros: number }[]).map((r) => [
            r.agent37_id,
            r.cost_micros,
          ])
        : []
    );

    const agents: MergedAgent[] = (rows as AgentRow[]).map((row) => {
      const l = live.get(row.agent37_id);
      if (l && l.status !== row.status) {
        // Best-effort mirror sync. Authorized already: these rows belong to workspaceId, which the
        // caller is a member of (requireMember above).
        db.from("agents").update({ status: l.status }).eq("agent37_id", row.agent37_id).then(() => {});
      }
      const latestImage = l ? templateImages.get(l.template) : undefined;
      // An agent whose config hasn't been written (or was wired to a URL this app no longer serves)
      // owes a bootstrap. Re-kick it here — this poll runs every 5s while anything is transitioning,
      // and kickBootstrap dedupes — and show it as busy until it lands.
      const bootstrapping = needsBootstrap(row);
      if (bootstrapping && (l?.status ?? row.status) === "running") kickBootstrap(row.agent37_id);
      return {
        ...row,
        cpu: l?.resources.cpu ?? row.cpu,
        memory: l?.resources.memory ?? row.memory,
        disk: l?.resources.disk ?? row.disk,
        live_status: bootstrapping && l?.status === "running" ? "starting" : l?.status ?? row.status,
        status_reason: l?.status_reason ?? null,
        past_due: l?.past_due ?? false,
        // Workspace templates report no service ports (the field is absent, not empty), so offer
        // the base image's own web apps instead.
        ports: l?.ports?.length
          ? l.ports
          : SERVICE_PORTS.map((port) => ({ port, default: false, url: "" })),
        update_available: !!(l?.image_ref && latestImage && l.image_ref !== latestImage),
        bootstrapping,
        spend_micros: spend.get(row.agent37_id) ?? 0,
      };
    });

    return json({ agents, role });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    // Shape is fixed server-side (DEFAULT_AGENT); the client picks the workspace and agent type.
    const body = await readJson<{ workspace_id?: string; template?: string }>(request);

    const workspaceId = body.workspace_id;
    if (!workspaceId) throw new ApiError(400, "invalid_request", "workspace_id is required");
    await requireAdmin(db, workspaceId, user.id);

    // Agents run on YOUR model, reached through this app — so an agent created while the app has no
    // public URL would boot with no way to think. Refuse instead of making a dead agent.
    if (!llmProxyUrl()) {
      throw new ApiError(
        400,
        "no_public_url",
        "Agents call this app for every model turn, so it needs a public URL. Deploy and set NEXT_PUBLIC_SITE_URL, or run `npm run dev` locally (it opens a tunnel)."
      );
    }

    // Paywall/entitlement seam: a fork can gate agent creation here, e.g.
    // if (!(await canCreateAgent(db, workspaceId))) throw new ApiError(403, "forbidden", "Agent creation is not enabled for this workspace.");

    const template =
      body.template && AGENT_TEMPLATES.includes(body.template)
        ? body.template
        : await resolveTemplate();

    const agent = await agent37.createAgent({
      template,
      resources: {
        cpu: DEFAULT_AGENT.cpu,
        memory: DEFAULT_AGENT.memory,
        disk: DEFAULT_AGENT.disk,
      },
      metadata: { app_workspace: workspaceId },
      // No Agent37 budget: this agent uses no managed services — every model call is billed to your
      // OpenRouter account instead, capped per agent by `spend_cap_micros` below.
    });

    const { error } = await db.from("agents").insert({
      agent37_id: agent.id,
      workspace_id: workspaceId,
      name: agent.name || null,
      status: agent.status,
      template: agent.template,
      cpu: agent.resources.cpu,
      memory: agent.resources.memory,
      disk: agent.resources.disk,
      created_by: user.id,
      model: DEFAULT_MODEL,
      spend_cap_micros: usdToMicros(DEFAULT_SPEND_CAP_USD),
    });
    if (error) {
      // Roll back the orphaned agent so we never bill for an untracked box.
      try {
        await agent37.deleteAgent(agent.id);
      } catch {
        /* best-effort */
      }
      throw new ApiError(500, "db_error", error.message);
    }

    // Write the agent's model config as soon as it's running, in the background — create returns
    // now, and the fleet poll shows the agent as starting until it lands.
    kickBootstrap(agent.id);

    return json(agent, 201);
  } catch (e) {
    return handleError(e);
  }
}
