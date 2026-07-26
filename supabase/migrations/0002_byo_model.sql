-- Bring-your-own-model additions.
--
-- proxy_token_hash: SHA-256 of the per-agent token that authenticates this agent's instance to
-- /api/llm. The raw token exists only inside the instance's ~/.hermes/config.yaml (never logged,
-- never returned to the browser); the proxy reverse-looks-up the presented Bearer token by hash on
-- every LLM call. Rotating = mint a new one, rewrite the config, restart.
-- bootstrapped_at: set once the instance's config has been written and it has restarted onto the
-- proxy. Null on a running agent means bootstrap is owed — the fleet GET re-kicks it.
-- proxy_url: the /api/llm URL the agent was wired with. When it differs from the app's current
-- public URL (a dev tunnel changes every run), the fleet GET re-wires the agent.
-- bootstrap_claimed_at: a short lease so only one server instance bootstraps an agent at a time
-- (serverless runs many).
-- model: the default model id written into the agent's config; the chat model picker can override
-- it per turn.
-- spend_cap_micros: this agent's monthly LLM budget on YOUR OpenRouter key, in USD micros. The
-- proxy refuses the turn with 402 once month-to-date spend reaches it.
alter table public.agents add column if not exists proxy_token_hash text;
alter table public.agents add column if not exists bootstrapped_at timestamptz;
alter table public.agents add column if not exists proxy_url text;
alter table public.agents add column if not exists bootstrap_claimed_at timestamptz;
alter table public.agents add column if not exists model text;
alter table public.agents add column if not exists spend_cap_micros bigint not null default 5000000;

create index if not exists agents_proxy_token_hash_idx on public.agents (proxy_token_hash);

-- Per-agent LLM metering, one row per (agent, model, day). The proxy writes the REAL cost
-- OpenRouter reports for each call (usage accounting), not an estimate — this is what the spend
-- column in the dashboard reads, and what you would bill a customer from.
create table if not exists public.llm_usage (
  agent37_id    text not null references public.agents (agent37_id) on delete cascade,
  model         text not null,
  day           date not null default current_date,
  calls         integer not null default 0,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micros   bigint not null default 0,
  primary key (agent37_id, model, day)
);

create index if not exists llm_usage_agent_idx on public.llm_usage (agent37_id, day);

-- Atomic increment (two concurrent calls must not lose a count).
create or replace function public.increment_llm_usage(
  p_agent37_id text,
  p_model text,
  p_input bigint,
  p_output bigint,
  p_cost_micros bigint
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.llm_usage (agent37_id, model, day, calls, input_tokens, output_tokens, cost_micros)
  values (p_agent37_id, p_model, current_date, 1, p_input, p_output, p_cost_micros)
  on conflict (agent37_id, model, day) do update set
    calls         = llm_usage.calls + 1,
    input_tokens  = llm_usage.input_tokens + excluded.input_tokens,
    output_tokens = llm_usage.output_tokens + excluded.output_tokens,
    cost_micros   = llm_usage.cost_micros + excluded.cost_micros;
$$;

-- Month-to-date spend for one agent. The proxy calls this before forwarding a turn; the dashboard
-- calls it to show the number next to the cap.
create or replace function public.llm_month_spend_micros(p_agent37_id text)
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(cost_micros), 0)::bigint
  from public.llm_usage
  where agent37_id = p_agent37_id
    and day >= date_trunc('month', current_date)::date;
$$;

-- Month-to-date spend for every agent in a workspace, for the fleet table.
create or replace function public.llm_month_spend_by_workspace(p_workspace uuid)
returns table (agent37_id text, cost_micros bigint)
language sql
security definer
set search_path = public
stable
as $$
  select a.agent37_id, coalesce(sum(u.cost_micros), 0)::bigint
  from public.agents a
  left join public.llm_usage u
    on u.agent37_id = a.agent37_id
   and u.day >= date_trunc('month', current_date)::date
  where a.workspace_id = p_workspace
  group by a.agent37_id;
$$;

alter table public.llm_usage enable row level security;
grant all on public.llm_usage to service_role;

-- SECURITY DEFINER + Postgres's default EXECUTE-to-PUBLIC would let anon callers inflate the meter
-- (or read other tenants' spend) through PostgREST /rpc — service_role only.
revoke execute on function public.increment_llm_usage(text, text, bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.llm_month_spend_micros(text) from public, anon, authenticated;
revoke execute on function public.llm_month_spend_by_workspace(uuid) from public, anon, authenticated;
grant execute on function public.increment_llm_usage(text, text, bigint, bigint, bigint) to service_role;
grant execute on function public.llm_month_spend_micros(text) to service_role;
grant execute on function public.llm_month_spend_by_workspace(uuid) to service_role;
