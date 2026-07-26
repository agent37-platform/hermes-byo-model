import "server-only";
import { ALLOWED_MODELS } from "@/config/models";

// The OpenRouter egress. Your key lives here and nowhere else on the server; nothing in this file
// is reachable from the browser.

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function openrouterKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? key : null;
}

export interface CatalogModel {
  id: string;
  name: string;
}

// The catalog changes rarely and Hermes re-probes /v1/models on every model-picker open, so cache
// it briefly per server instance. A failure is not fatal: the caller falls back to the default id.
let catalog: { at: number; data: CatalogModel[] } | null = null;
const CATALOG_TTL_MS = 10 * 60_000;

export async function listCatalog(): Promise<CatalogModel[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.data;

  const key = openrouterKey();
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`openrouter /models failed (${res.status})`);

  const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[] };
  const data: CatalogModel[] = (body.data ?? [])
    .filter((m): m is { id: string; name?: string } => typeof m.id === "string")
    .filter((m) => !ALLOWED_MODELS.length || ALLOWED_MODELS.includes(m.id))
    .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id }));

  catalog = { at: Date.now(), data };
  return data;
}

// An off-catalog model is only rejected when you've curated ALLOWED_MODELS (see src/config/models.ts).
// With the default empty list every model your key can reach is allowed.
export function modelAllowed(model: string): boolean {
  return !ALLOWED_MODELS.length || ALLOWED_MODELS.includes(model);
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Pull the usage block off a chat-completions payload (non-streamed body, or one streamed chunk).
// `cost` is the real USD OpenRouter charged your key for this call — it only appears because the
// proxy sets `usage: { include: true }` on the way out.
export function extractUsage(payload: unknown, fallbackModel: string): LlmUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as { model?: unknown; usage?: Record<string, unknown> | null };
  const usage = body.usage;
  if (!usage || typeof usage !== "object") return null;

  return {
    model: typeof body.model === "string" && body.model ? body.model : fallbackModel,
    inputTokens: toNumber(usage.prompt_tokens),
    outputTokens: toNumber(usage.completion_tokens),
    costMicros: Math.round(toNumber(usage.cost) * 1_000_000),
  };
}

// Scan an SSE stream's text for the usage-bearing chunk. OpenRouter emits usage exactly once, in
// the final chunk before [DONE] — take the last one seen and ignore everything else.
export function usageFromSse(text: string, fallbackModel: string): LlmUsage | null {
  let found: LlmUsage | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const usage = extractUsage(JSON.parse(data), fallbackModel);
      if (usage) found = usage;
    } catch {
      /* partial or non-JSON chunk */
    }
  }
  return found;
}
