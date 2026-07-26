# Setup

This app runs on three secrets you supply (all behind a login, so a human must fetch them):

- **`AGENT37_API_KEY`** (`sk_live_…`) — Agent37 dashboard → **Cloud → API keys**. Then
  **fund the wallet** (Cloud → Billing): creating an agent costs real money (the computer it runs
  on), and an empty wallet returns a `402` at create time.
- **`OPENROUTER_API_KEY`** (`sk-or-…`) — [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys),
  with credit on the account. Every agent's model calls are billed here, through this app's proxy.
- **`SUPABASE_ACCESS_TOKEN`** (`sbp_…`) — [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) (~30s).

`npm run setup` does everything else: creates a free Supabase project (or configures the one whose
URL you paste into `NEXT_PUBLIC_SUPABASE_URL`), runs the migrations, enables email auth, and writes
the Supabase URL, anon key, and **server-only service-role key** back into `.env.local`. (Clients
never touch the DB directly — the app reads/writes every table server-side with the service-role
key; see [`AGENTS.md`](AGENTS.md).) It's idempotent and fills only blank values. Per-variable docs
live in [`.env.example`](.env.example).

Two things are specific to this kit:

- **`npm run templates:publish`** registers the agent image (Agent37's clean `hermes-base`) as a
  template in your workspace. One API call, no Docker. Run it once before creating agents.
- **A public URL.** Agents run in Agent37's cloud and call this app for *every* model turn, so
  `NEXT_PUBLIC_SITE_URL` must be reachable from the internet. In production that's your deployment.
  Locally, run `npm run tunnel` in a second terminal — it opens a Cloudflare quick tunnel (no
  account, no token) and writes the URL into `.env.local`, which the dev server reloads on its own.
  Creating an agent without a public URL is refused, rather than making an agent that can't think.

## For your coding agent

The README tells adopters to paste a one-liner that points here. If you're that agent, follow these
steps in order; don't skip the checks.

1. **Scaffold.** Run `npm install`, then `npm run setup` once. On a fresh clone this creates
   `.env.local` from `.env.example` and exits asking for secrets — that exit is **expected**, not an
   error.
2. **Ask me for the three secrets.** You can't fetch them (all behind a login). Print where to get
   each, then stop and wait for my reply:
   - `AGENT37_API_KEY` (starts with `sk_live_`): Agent37 dashboard → Cloud → API keys
     (<https://www.agent37.com/dashboard/cloud/api-keys>). Creating agents also needs a **funded**
     wallet (Cloud → Billing), or it later fails with a `402`.
   - `OPENROUTER_API_KEY` (starts with `sk-or-`): <https://openrouter.ai/settings/keys>. Tell me to
     put credit on it, and that a per-key limit there is a good safety net.
   - `SUPABASE_ACCESS_TOKEN` (starts with `sbp_`): <https://supabase.com/dashboard/account/tokens>.
3. **Validate.** Confirm the prefixes (`sk_live_`, `sk-or-`, `sbp_`). If one's wrong, ask again —
   don't proceed.
4. **Write the secrets into `.env.local` only** (confirm it's gitignored first). Fill only those
   three lines; leave everything else as-is. Never print a full key back (mask as `sk_live_…last4`),
   never `cat .env.local`, never `git add`/commit it.
5. **Complete setup.** Run `npm run setup` again. If it fails, read its message and act on it
   instead of retrying blind:
   - "free-project limit" → ask me for an existing project's URL in `NEXT_PUBLIC_SUPABASE_URL` (or
     free a slot at supabase.com/dashboard), then re-run.
   - "more than one organization" / `403` on create → my account has multiple Supabase orgs (or
     can't create in the default one). Setup prints the orgs with a `SUPABASE_ORG=<slug>` for each;
     re-run as `SUPABASE_ORG=<slug> npm run setup` for the one I want (usually my personal org).
   - `401` → my Supabase token is wrong/expired; ask for a new one.
   - `404` → `NEXT_PUBLIC_SUPABASE_URL` points at a project this token can't see.
6. **Publish the template.** Run `npm run templates:publish`. A `404` on the base image means the
   pinned tag in `scripts/templates.mjs` is gone — pick a newer one from the
   [hermes-base package page](https://github.com/orgs/agent37-platform/packages/container/package/hermes-base).
7. **Verify.** Run `npm run typecheck` and `npm run build` (no test suite — these two are the gate).
8. **Start.** Run `npm run dev`, then `npm run tunnel` in a second terminal, then `npm run smoke` to
   confirm both halves (key live, proxy publicly reachable). Report the local URL
   (<http://localhost:3000>): I sign up with email + password (open signup, no email verification) →
   land in a fresh workspace → create an agent. Tell me the first turn may take a minute while the
   agent is configured and restarted, and that a `402` at create time is the Agent37 wallet.

Constraints: keep changes minimal; add no features; no key ever leaves the server; branding stays
code-side (`src/config/branding.ts`).

## By hand

```bash
npm install
npm run setup              # first run creates .env.local and prints the keys to paste
#                          → paste all three into .env.local, then:
npm run setup              # creates/configures Supabase, runs the migrations, sets up auth
npm run templates:publish  # register the agent image (once per workspace)
npm run dev                # http://localhost:3000 → sign up with email + password
npm run tunnel             # second terminal — leave it running
```

<details>
<summary><b>Manual Supabase setup</b> — if you'd rather not use an access token</summary>

Leave `SUPABASE_ACCESS_TOKEN` blank, skip `npm run setup`, create a free
[Supabase](https://supabase.com) project, then: (1) **SQL Editor** → run
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and then
[`supabase/migrations/0002_byo_model.sql`](supabase/migrations/0002_byo_model.sql) (the first sets up
the schema *and* revokes direct client table access; the second adds the proxy tokens and the spend
table); (2) **Authentication → Providers** → enable **Email**; (3) **Authentication → URL
Configuration** → Site URL `http://localhost:3000`, add `http://localhost:3000/auth/callback` to
Redirect URLs. Paste the project URL, anon key, and **service-role key** (Project Settings → API)
into `.env.local` (`SUPABASE_SERVICE_ROLE_KEY` — server-only), then `npm run dev`.
</details>

## Deploy to production (Vercel)

Run setup locally once first (it can't be done from the Vercel button — that deploys the app but
can't create your Supabase backend or register your sign-in URLs), then:

1. Run `npm run setup` and `npm run templates:publish` locally.
2. Push your fork to GitHub, then in Vercel: **Add New → Project → Import Git Repository**.
3. Add **only these** env vars: `AGENT37_API_KEY`, `OPENROUTER_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only — the runtime needs it
   for all DB access), `NEXT_PUBLIC_SITE_URL` (your prod URL).
   **Never add** `SUPABASE_ACCESS_TOKEN` — it's setup-only (used to create/configure the project,
   never at runtime).
4. Register your prod sign-in URL with Supabase: set `NEXT_PUBLIC_SITE_URL` to your prod URL in
   `.env.local` and re-run `npm run setup` (it adds `<prod>/auth/callback` for you).
5. Agents created against a tunnel URL re-wire themselves to the production URL the next time the
   dashboard polls, one restart each. Nothing to do by hand.

## Troubleshooting

| Symptom | What it is |
|---|---|
| Create is refused with "needs a public URL" | `NEXT_PUBLIC_SITE_URL` is unset or localhost. Deploy, or run `npm run tunnel`. |
| Agent stays "starting" for minutes | Bootstrap is retrying. Check the server log for `[bootstrap]`; a dead tunnel is the usual cause. |
| Chat says the model is unreachable | Run `npm run smoke`. It tells you whether the OpenRouter key or the public URL is the broken half. |
| Chat returns a budget message | That agent hit its monthly cap. Raise it in the agent's Settings tab; spend resets on the 1st. |
| `402` when creating an agent | The Agent37 wallet, not OpenRouter — fund it under Cloud → Billing. |
| Spend stays at $0 after a reply | Metering runs after the response finishes; give it a few seconds and reload. Persistent zeros mean the `increment_llm_usage` RPC is failing — check the server log. |
