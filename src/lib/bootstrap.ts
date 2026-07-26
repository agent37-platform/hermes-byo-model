import "server-only";
import { agent37, instanceFetch } from "@/lib/agent37";
import { mintProxyToken, hashProxyToken } from "@/lib/proxy-token";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_MODEL } from "@/config/models";

// Post-create bootstrap: point a fresh instance's agent at YOUR model.
//
// Agents here run on `hermes-base`, the clean image Agent37 publishes for exactly this — it boots
// with no LLM provider at all. So right after create, this module writes the agent's config over
// the control-plane exec endpoint:
//
//   ~/.hermes/config.yaml
//     model:            provider custom:OpenRouter, default <DEFAULT_MODEL>
//     custom_providers: OpenRouter -> {this app}/api/llm/v1, api_key <the agent's orp_ token>
//
// …then restarts the instance so Hermes loads it. Config lives on the persistent volume, and
// nothing on the image rewrites it at boot, so one bootstrap survives restarts, image updates and
// resizes — there is no refresh hook to maintain.
//
// Runs in the background (create returns immediately); the fleet GET shows the agent as starting
// until `bootstrapped_at` lands and re-kicks bootstrap when it's owed — the server died mid-run, or
// the app's public URL moved (a dev tunnel gets a new URL every run) and the wired proxy URL is
// now dead.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two layers keep bootstraps single-flight. In-process: the dashboard polls the fleet GET every 5s
// while agents transition, and each poll may re-kick — dedupe + cool down locally. Across processes
// (serverless runs many): a DB lease (`bootstrap_claimed_at`) is claimed atomically before any
// work, so two lambdas can't interleave token mints and config writes.
const inflight = new Set<string>();
const lastAttempt = new Map<string, number>();
const RETRY_COOLDOWN_MS = 60_000;
const CLAIM_STALE_MS = 10 * 60_000; // > the worst-case run (wait-running + execs + restart)

export function kickBootstrap(agentId: string): void {
  if (inflight.has(agentId)) return;
  const last = lastAttempt.get(agentId) ?? 0;
  if (Date.now() - last < RETRY_COOLDOWN_MS) return;

  inflight.add(agentId);
  lastAttempt.set(agentId, Date.now());
  bootstrapAgent(agentId)
    .catch((e) => console.warn(`[bootstrap] ${agentId} failed:`, e instanceof Error ? e.message : e))
    .finally(() => inflight.delete(agentId));
}

// True when the agent still owes a wiring step: never bootstrapped, or wired to a proxy URL that is
// no longer this app's.
export function needsBootstrap(row: { bootstrapped_at?: string | null; proxy_url?: string | null }): boolean {
  if (!row.bootstrapped_at) return true;
  const url = llmProxyUrl();
  return !!url && row.proxy_url !== url;
}

// The URL the INSTANCE (running in Agent37's cloud) uses to reach this app's proxy. It must be
// publicly reachable — an agent can't call your laptop, so localhost is treated as "not set".
// Deploy, or run `npm run tunnel`.
export function llmProxyUrl(): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (!site || !/^https?:\/\//.test(site) || site.includes("localhost") || site.includes("127.0.0.1")) {
    return null;
  }
  return `${site}/api/llm/v1`;
}

async function waitForStatus(agentId: string, wanted: string, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const agent = await agent37.getAgent(agentId);
      if (agent.status === wanted) return true;
      if (agent.status === "failed" || agent.status === "deleted") return false;
    } catch {
      /* transient */
    }
    await sleep(2000);
  }
  return false;
}

async function waitHealthy(agentId: string, attempts = 45): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await instanceFetch(agentId, "/v1/health");
      if (res.ok) return true;
    } catch {
      /* booting */
    }
    await sleep(2000);
  }
  return false;
}

async function bootstrapAgent(agentId: string): Promise<void> {
  const db = createAdminClient();

  // Claim the cross-process lease: an atomic conditional UPDATE — zero rows back means another
  // server instance owns this bootstrap right now.
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("agents")
    .update({ bootstrap_claimed_at: new Date().toISOString() })
    .eq("agent37_id", agentId)
    .or(`bootstrap_claimed_at.is.null,bootstrap_claimed_at.lt.${staleBefore}`)
    .select("bootstrapped_at, model");
  if (claimError) throw new Error(`bootstrap claim failed: ${claimError.message}`);
  if (!claimed?.length) return;
  const row = claimed[0] as { bootstrapped_at: string | null; model: string | null };

  const releaseClaim = () =>
    db.from("agents").update({ bootstrap_claimed_at: null }).eq("agent37_id", agentId).then(() => {});

  try {
    const proxyUrl = llmProxyUrl();
    if (!proxyUrl) {
      // Nothing useful to do: an agent wired to a URL it can't reach is worse than one left alone.
      console.warn(`[bootstrap] ${agentId}: NEXT_PUBLIC_SITE_URL is unset or local — deploy or run \`npm run tunnel\`.`);
      await releaseClaim();
      return;
    }

    if (!(await waitForStatus(agentId, "running", 90))) {
      console.warn(`[bootstrap] ${agentId} never reached running; will retry on the next fleet poll.`);
      await releaseClaim();
      return;
    }

    await wireAgent(db, agentId, proxyUrl, row.model || DEFAULT_MODEL);

    await agent37.restart(agentId);
    await sleep(3000);
    await waitHealthy(agentId);

    const { error: stampError } = await db
      .from("agents")
      .update({
        bootstrapped_at: row.bootstrapped_at ?? new Date().toISOString(),
        proxy_url: proxyUrl,
        bootstrap_claimed_at: null,
      })
      .eq("agent37_id", agentId);
    if (stampError) throw new Error(`stamping bootstrap completion failed: ${stampError.message}`);
    console.log(`[bootstrap] ${agentId} ready on your OpenRouter key.`);
  } catch (e) {
    await releaseClaim();
    throw e;
  }
}

// Mint this agent's proxy token, store its hash, and write the config that uses it. Also the
// rotation path: minting again invalidates the old token the moment the hash is stored, and the
// instance picks up the new one on the restart that follows.
async function wireAgent(
  db: ReturnType<typeof createAdminClient>,
  agentId: string,
  proxyUrl: string,
  model: string
): Promise<void> {
  const token = mintProxyToken();
  const { error } = await db
    .from("agents")
    .update({ proxy_token_hash: hashProxyToken(token), model })
    .eq("agent37_id", agentId);
  if (error) throw new Error(`storing proxy token hash failed: ${error.message}`);

  // The raw token and URL live in a small state file; the apply script merges them into the agent's
  // config. Re-wiring is then just "replace the state file, re-run, restart" — and the merge never
  // clobbers a model the user picked in the agent's own UI.
  await execWriteFile(
    agentId,
    "~/.agent37/byo-model.json",
    JSON.stringify({ base_url: proxyUrl, api_key: token, model }) + "\n"
  );
  await execWriteFile(agentId, "~/.agent37/apply-byo-model.py", APPLY_SCRIPT);

  const result = await agent37.exec(
    agentId,
    `"\${HERMES_PYTHON:-/usr/local/lib/hermes/hermes-agent/venv/bin/python}" ~/.agent37/apply-byo-model.py`
  );
  if (result.exit_code !== 0) {
    throw new Error(`writing the agent config failed: ${result.stderr || result.stdout}`);
  }
}

// Rotate an agent's proxy token (Settings tab): re-wire with a fresh token, then restart so Hermes
// reloads. The old token stops working immediately.
export async function rotateProxyToken(agentId: string): Promise<void> {
  const proxyUrl = llmProxyUrl();
  if (!proxyUrl) throw new Error("NEXT_PUBLIC_SITE_URL is unset or local — agents can't reach this app.");

  const db = createAdminClient();
  const { data } = await db
    .from("agents")
    .select("model")
    .eq("agent37_id", agentId)
    .maybeSingle<{ model: string | null }>();

  await wireAgent(db, agentId, proxyUrl, data?.model || DEFAULT_MODEL);
  await agent37.restart(agentId);
  await db.from("agents").update({ proxy_url: proxyUrl }).eq("agent37_id", agentId);
}

async function execWriteFile(agentId: string, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const result = await agent37.exec(
    agentId,
    `mkdir -p "$(dirname ${path})" && echo ${b64} | base64 -d > ${path}`
  );
  if (result.exit_code !== 0) {
    throw new Error(`writing ${path} failed: ${result.stderr || result.stdout}`);
  }
}

// Merges the state file into ~/.hermes/config.yaml. Idempotent: it upserts the OpenRouter provider
// and only sets the default model when the config doesn't already name one, so re-running it after
// a URL change or a token rotation leaves the user's own choices intact.
const APPLY_SCRIPT = `#!/usr/bin/env python3
# Managed by the app: point Hermes at the app's OpenRouter proxy.
import json, os, yaml

state = json.load(open(os.path.expanduser("~/.agent37/byo-model.json")))
path = os.path.expanduser("~/.hermes/config.yaml")
try:
    with open(path) as f:
        config = yaml.safe_load(f) or {}
except FileNotFoundError:
    config = {}
if not isinstance(config, dict):
    config = {}

entry = {
    "name": "OpenRouter",
    "base_url": state["base_url"],
    "api_key": state["api_key"],
    "api_mode": "chat_completions",
    "model": state["model"],
}
providers = config.get("custom_providers")
if not isinstance(providers, list):
    providers = []
for i, existing in enumerate(providers):
    if isinstance(existing, dict) and existing.get("name") == "OpenRouter":
        providers[i] = {**existing, **entry}
        break
else:
    providers.append(entry)
config["custom_providers"] = providers

model = config.get("model")
if not isinstance(model, dict) or not (model.get("default") or model.get("model")):
    config["model"] = {"provider": "custom:OpenRouter", "default": state["model"]}

# Hermes gates non-bundled plugins behind this allow-list; agent37-environment documents the
# instance's persistent paths and web hosting to the agent.
plugins = config.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
enabled = [p for p in (plugins.get("enabled") or []) if isinstance(p, str)]
if "agent37-environment" not in enabled:
    enabled.append("agent37-environment")
plugins["enabled"] = enabled
config["plugins"] = plugins

os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    yaml.safe_dump(config, f, sort_keys=False)
`;
