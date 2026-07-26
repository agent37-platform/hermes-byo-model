# Agents on your own OpenRouter key

An agent app on the [Agent37](https://www.agent37.com) Cloud API where the model is **yours**. Agents
run on Agent37's clean Hermes image, which ships with no LLM provider, and every model call goes
through a proxy in this app to **your** OpenRouter account.

```
agent instance ──▶ https://your-app.com/api/llm/v1   (per-agent token, orp_…)
                        │  401  unknown or rotated token
                        │  402  this agent hit its monthly budget
                        ▼
                   openrouter.ai   (your sk-or- key, never leaves your server)
                        │
                        └─▶ real cost per call ──▶ Supabase: spend per agent, per model, per day
```

Each agent gets its own token, its own budget, and its own line in the spend table. Revoke one and
that agent stops; the rest keep working.

## Setup

**1. Get three keys** (all behind a login, so only you can fetch them):

- `AGENT37_API_KEY` — Agent37 dashboard → **Cloud → API keys**, then **fund the wallet** (Cloud → Billing).
- `OPENROUTER_API_KEY` — [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys), with credit on it.
- `SUPABASE_ACCESS_TOKEN` — [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

**2. Hand it to your coding agent.** Open this folder in Claude Code / Codex and paste:

```
Set this repo up and run it locally, end to end — follow SETUP.md. Ask me for the three
login-gated keys it needs, then do everything else and tell me the local URL.
```

Or do it yourself:

```bash
npm install
npm run setup              # keys → Supabase project, schema, auth
npm run templates:publish  # register the agent image in your Agent37 workspace (once)
npm run dev                # http://localhost:3000
npm run tunnel             # second terminal: a public URL, so cloud agents can reach the proxy
```

Sign up in the app, create an agent, and chat. The turn runs on your OpenRouter key, and the
**Settings** tab shows what it cost within a few seconds of the reply.

## Make it yours

- **Model** — `DEFAULT_MODEL` in `src/config/models.ts`. The chat model picker lists every model your
  key can reach; set `ALLOWED_MODELS` to narrow that to a list you approve, enforced in the proxy.
- **Budgets** — `DEFAULT_SPEND_CAP_USD` for new agents, editable per agent in its Settings tab. At the
  cap the proxy answers 402 and the agent says so in chat.
- **Branding** — `src/config/branding.ts`.
- **Billing your own users** — `llm_usage` (per agent, per model, per day, real dollars) is the table
  to invoice from; the create route has a `canCreateAgent()` seam for an entitlement gate.

Deploy steps, the manual Supabase path, and troubleshooting: **[SETUP.md](SETUP.md)**.
Architecture and conventions: **[AGENTS.md](AGENTS.md)**.
Guide: **[Use your own model](https://www.agent37.com/docs/agents-api/byo-model)**.
