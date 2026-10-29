# AGENTS.md

Guidance for AI coding agents (and humans) working in **hermes-byo-model** — the bring-your-own-model
agent app on Agent37. `CLAUDE.md` imports this file via `@AGENTS.md`, so this is the single source of
truth — edit here, not there.

## First-time setup

Setting this up from a fresh clone? Follow **[`SETUP.md`](SETUP.md)** — the complete runbook (it's
what the README tells adopters to hand you). Three login-gated secrets are human-supplied:
`AGENT37_API_KEY` (plus a **funded** Agent37 wallet), `OPENROUTER_API_KEY` (with credit), and
`SUPABASE_ACCESS_TOKEN`; `npm run setup` + `npm run templates:publish` do the rest. Never print or
commit any of them.

## What this project is

A full-stack agent app built on the public **[Agent37](https://www.agent37.com) B2B Agents API**,
where the **model** comes from the operator's own OpenRouter account instead of Agent37's managed
one: email + password auth (open signup, no verification), a multi-agent fleet, and — for each agent
— native in-dashboard **Chat**, a **Files** browser, and a **Settings** tab with its model budget and
spend. Forkers rebrand it (`src/config/branding.ts`) and ship it.

It is the sibling of the [Agent37 Starter Kit](https://github.com/agent37-platform/starter-kit)
(managed model, managed Composio) and of
[hermes-openclaw-composio](https://github.com/agent37-platform/hermes-openclaw-composio) (your own
Composio). The differences here are exactly the bring-your-own-model pieces:

1. **A clean-base template.** Agents run on `hermes-byo-model`, a workspace template this repo
   registers straight from Agent37's public `hermes-base` image (`scripts/templates.mjs` — one POST,
   no Dockerfile, no build). The stock `agent37-hermes` template is NOT used: its boot script wires
   Agent37's managed model into the config at every start, which would leave a managed model sitting
   in the picker next to yours. `hermes-base` injects nothing, so the config this app writes is the
   only one the agent has.
2. **Post-create bootstrap** (`src/lib/bootstrap.ts`). After create, the app writes
   `~/.hermes/config.yaml` over `/v1` exec — a `custom_providers` entry pointing at this app's
   `/api/llm/v1` with a per-agent `orp_` token — then restarts the instance. Config lives on the
   persistent volume and nothing rewrites it at boot, so one bootstrap survives restarts, image
   updates and resizes; there is no refresh hook. Runs in the background; the fleet GET shows the
   agent as starting until `bootstrapped_at` lands, re-kicks bootstrap when it's owed, and re-wires
   any agent whose recorded `proxy_url` isn't this app's current one (dev tunnels move).
3. **The money proxy** (`src/app/api/llm/[...path]/route.ts`). The ONLY place agent traffic meets
   `OPENROUTER_API_KEY`: per-agent Bearer token → agent lookup by SHA-256 hash → month-to-date spend
   vs that agent's cap (402 when over) → forward to OpenRouter with `usage: { include: true }` →
   stream the SSE through verbatim while teeing a copy to read the final usage chunk → record the
   real dollars into `llm_usage`. Serves the two routes Hermes uses on a custom provider:
   `GET /v1/models` (the picker) and `POST /v1/chat/completions` (the turn).
4. **Spend as a first-class column.** `llm_usage` is per agent, per model, per day, in USD micros, and
   the numbers are what OpenRouter charged — not an estimate from token counts.

Everything else this app does is a **subset of the Agent37 `/v1` API** — control plane *and* data
plane. This repo is a *client* of that API; **the API docs, not this code, are the authority on what
an agent can and cannot do.**

## The API this is built on — read the docs first

- **<https://www.agent37.com/docs/llms.txt>** — concise index of every doc page. *Start here.*
- **<https://www.agent37.com/docs/llms-full.txt>** — the entire documentation in one file.
- Human-browsable docs: **<https://www.agent37.com/docs>** (append `.md` for raw markdown).

Key pages: [Core concepts](https://www.agent37.com/docs/agents-api/concepts),
[Instances](https://www.agent37.com/docs/agents-api/instances),
[Templates](https://www.agent37.com/docs/agents-api/templates) (incl. the base images),
[Run commands](https://www.agent37.com/docs/agents-api/exec) (bootstrap rides this),
[Use your own model](https://www.agent37.com/docs/agents-api/byo-model) (this kit's guide),
[Instance URLs](https://www.agent37.com/docs/agents-api/urls),
[Chat](https://www.agent37.com/docs/agents-api/chat) /
[Streaming](https://www.agent37.com/docs/agents-api/streaming) /
[Sessions](https://www.agent37.com/docs/agents-api/sessions) /
[Files](https://www.agent37.com/docs/agents-api/files) (the data plane behind the Chat and Files
tabs), [Errors](https://www.agent37.com/docs/agents-api/errors).

For OpenRouter surfaces (models, chat completions, usage accounting), the authority is
**<https://openrouter.ai/docs>**.

## How this app fits together

```
Browser ─▶ Next.js (this app) ─▶ control plane  https://api.agent37.com/v1        (instances)
   │            │              └▶ sandbox        https://sandbox.agent37.app/v1     (exec)
   │            │              └▶ data plane     https://{instance}.agent37.app/v1  (chat, files)
   │            │
   │            └─▶ Supabase: Auth (browser, anon key) + Postgres (server-only, service-role key):
   │                          users, workspaces, members, agent mirror, llm_usage
   │
agent instance ─▶ https://your-app/api/llm/v1  ─▶ openrouter.ai   (per-agent orp_ token in;
                                                                   YOUR sk-or- key out)
```

- **One `sk_live_` key, many app workspaces**, server-side only; agents tagged
  `metadata.app_workspace`, mirrored in Supabase.
- **One `OPENROUTER_API_KEY`, one revocable token per agent.** Instances never hold anything that
  works anywhere but this app's proxy.
- **Isolation is enforced in the server (BFF), not the browser.** Clients have no direct table
  access; the TypeScript checks in `src/lib/auth.ts` are the authorization boundary (RLS stays on as
  a dormant backstop).
- **Naming:** the upstream API calls these resources **instances**; this app brands them **agents**.
  Paths stay `/instances`; the client methods read `agent…`.

## Where things live

| Path | What |
|---|---|
| `src/app/api/llm/[...path]/route.ts` | The money proxy: token auth, cap, forward, meter |
| `src/lib/openrouter.ts` | The OpenRouter egress: catalog, usage/cost extraction |
| `src/lib/bootstrap.ts` | Post-create config write over exec (+ re-wire, token rotation) |
| `src/lib/proxy-token.ts` | Per-agent `orp_` token mint + SHA-256 hash |
| `src/lib/agent37.ts` | The Agent37 `/v1` client — the single egress to both planes (incl. `exec`) |
| `src/app/api/agents/[id]/llm/**` | Settings-tab BFF: status, cap edit, token rotation |
| `src/app/api/agents/[id]/{chat,files}/**` | Data-plane BFF: native Chat + Files proxied to the instance |
| `src/config/models.ts` | `DEFAULT_MODEL`, `DEFAULT_SPEND_CAP_USD`, `ALLOWED_MODELS` |
| `src/config/agents.ts` | `TEMPLATE_NAME`, `AGENT_TYPES`, shapes, `SERVICE_PORTS`, `PORT_LABELS` |
| `scripts/templates.mjs` | Registers the workspace template (`npm run templates:publish`) |
| `scripts/dev.mjs` | `npm run dev`: Next plus a local-only Cloudflare quick tunnel for the proxy |
| `scripts/smoke.mjs` | Checks the key works and the proxy is publicly reachable (`npm run smoke`) |
| `supabase/migrations/` | `0001_init.sql` (schema, dormant RLS, RPCs) + `0002_byo_model.sql` (tokens, metering) |

## Commands

```bash
npm install
npm run setup               # configure Supabase end-to-end (idempotent)
npm run templates:publish   # register the agent template (no Docker; one API call)
npm run dev                 # http://localhost:3000, plus an auto tunnel so agents can reach /api/llm
npm run dev:next            # plain `next dev`, no tunnel
npm run smoke -- <url>      # is the OpenRouter key live, and is the proxy reachable?
npm run build
npm run typecheck           # tsc --noEmit
```

There is no test suite; the gate before shipping is a clean `npm run typecheck` and `npm run build`,
plus a real chat turn through the proxy.

## House rules

- **The proxy is the only path to the model.** Never put `OPENROUTER_API_KEY` (or any provider key)
  into an instance's config — the whole design is that an instance holds a token that is worthless
  outside this app.
- **Don't point agents at the stock system templates** (`agent37-hermes` / `agent37-openclaw`): they
  wire Agent37's managed model at every boot, which defeats the point of this kit.
- **A public URL is load-bearing.** Agents call this app for every turn, so `NEXT_PUBLIC_SITE_URL`
  must be internet-reachable — `npm run dev` supplies it locally via a quick tunnel, production
  supplies it as an env var. Agent creation is refused when it isn't, rather than producing an agent
  that can't think.
- **Metering must never break the transport.** Usage recording happens after the response is sent and
  swallows its own errors; a lost row is a logged warning, not a failed turn.
- **The API is the final authority.** Shapes, disks, templates — the `/v1` API can reject anything
  your account's tier disallows, regardless of what `src/config` lists.
- **Payments are intentionally excluded.** The create route has a commented `canCreateAgent()` seam
  where an entitlement gate would go; `llm_usage` is the metering you'd bill from.
- Keep changes small and focused; don't add unrequested features or touch unrelated code.
