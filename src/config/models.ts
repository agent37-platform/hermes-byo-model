// The model side of this kit. Everything an agent can run comes from YOUR OpenRouter account, so
// this file is the whole model configuration — there is no managed catalog behind it.

// Written into each new agent's config as its default model. The chat model picker can switch to
// any other model in the catalog per turn; this is just where a fresh agent starts.
// Model ids and prices: https://openrouter.ai/models
export const DEFAULT_MODEL = "moonshotai/kimi-k2.7-code";

// Default monthly LLM budget for a new agent, in USD. The proxy stops the agent with a 402 once
// month-to-date spend on your key reaches this; each agent's cap is editable in its Settings tab.
export const DEFAULT_SPEND_CAP_USD = 5;

// The models this app exposes. Empty = pass OpenRouter's whole catalog through (the default: the
// picker lists every model your key can reach). To offer a curated set instead, list the ids here
// — the proxy then filters GET /v1/models down to them AND rejects a chat turn on anything else,
// so an agent can't spend on a model you didn't allow:
//
//   export const ALLOWED_MODELS = ["moonshotai/kimi-k2.7-code", "anthropic/claude-sonnet-5"];
export const ALLOWED_MODELS: string[] = [];
