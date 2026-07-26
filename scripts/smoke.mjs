#!/usr/bin/env node
// Check the two things that have to be true before an agent can think, without creating one:
//
//   1. Your OpenRouter key works and has credit (one ~$0.0001 completion).
//   2. Your proxy is reachable from the internet at NEXT_PUBLIC_SITE_URL, and rejects an unknown
//      token — which is exactly the path an agent takes for every turn.
//
//   npm run smoke                            # uses NEXT_PUBLIC_SITE_URL
//   npm run smoke -- https://x.trycloudflare.com   # the URL `npm run dev` printed
//
// Run it when an agent answers "I couldn't reach the model": it tells you which half is broken.
import { readFileSync } from "node:fs";

function readEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(new RegExp(`^${name}=(.*)$`));
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* no .env.local */
  }
  return undefined;
}

const args = process.argv.slice(2);
const key = readEnv("OPENROUTER_API_KEY");
// In local dev the public URL lives only in the dev server's process (npm run dev prints it), so
// take it as an argument too.
const site = (args.find((a) => a.startsWith("http")) || readEnv("NEXT_PUBLIC_SITE_URL") || "").replace(/\/$/, "");
const model = args.find((a) => !a.startsWith("http")) || "moonshotai/kimi-k2.7-code";
let failed = false;

if (!key) {
  console.error("✗ OPENROUTER_API_KEY is not set (env or .env.local).");
  failed = true;
} else {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 5,
      usage: { include: true },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    const cost = body.usage?.cost ?? 0;
    console.log(`✓ OpenRouter key works (${model}, this call cost $${cost}).`);
  } else {
    console.error(`✗ OpenRouter rejected the key (${res.status}): ${body.error?.message ?? "unknown error"}`);
    failed = true;
  }
}

if (!site || site.includes("localhost") || site.includes("127.0.0.1")) {
  console.error(
    `✗ NEXT_PUBLIC_SITE_URL is ${site ? `local (${site})` : "unset"} — agents run in the cloud and can't reach it.\n` +
      "  Deploy and set it, or run `npm run dev` and pass the URL it prints: npm run smoke -- <url>"
  );
  failed = true;
} else {
  // redirect:"manual" matters — an agent can't follow a login redirect either, so a 307 here is a
  // failure to report, not something to chase.
  const res = await fetch(`${site}/api/llm/v1/models`, {
    headers: { authorization: "Bearer orp_not-a-real-token" },
    redirect: "manual",
  }).catch((e) => ({ ok: false, status: 0, error: e }));
  if (res.status === 401) {
    console.log(`✓ Proxy is reachable at ${site}/api/llm and rejects unknown tokens.`);
  } else if (res.status === 0) {
    console.error(`✗ Could not reach ${site} at all — is the tunnel (or deployment) up?`);
    failed = true;
  } else {
    console.error(`✗ ${site}/api/llm/v1/models answered ${res.status}; expected 401 for a bogus token.`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
