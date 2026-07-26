#!/usr/bin/env node
// Publish this kit's agent template to your Agent37 workspace — run once before creating agents
// (`npm run templates:publish`), and again to move to a newer base image.
//
//   hermes-byo-model — registered straight from Agent37's public CLEAN Hermes base image. No
//                      Dockerfile, no build: it's one POST /v1/templates.
//
// Why the clean base and not the stock `agent37-hermes` template? The stock image wires Agent37's
// MANAGED model into the agent at every boot. This kit runs the agent on YOUR OpenRouter key, and
// `hermes-base` is the image Agent37 publishes for exactly that — it boots with no LLM provider at
// all, so the config this app writes (src/lib/bootstrap.ts) is the only one there is.
//
// The name here must match TEMPLATE_NAME in src/config/agents.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = "hermes-byo-model";

// The current clean Hermes base release. Newer tags:
// https://github.com/orgs/agent37-platform/packages/container/package/hermes-base
const BASE_IMAGE = "ghcr.io/agent37-platform/hermes-base:2026.07.24b";

const API = process.env.AGENT37_API_BASE || "https://api.agent37.com";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readEnvLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(path.join(root, ".env.local"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith(`${name}=`))
      .pop();
    return line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
}

const apiKey = readEnvLocal("AGENT37_API_KEY");
if (!apiKey || !apiKey.startsWith("sk_live_")) {
  console.error("AGENT37_API_KEY missing — set it in .env.local (dashboard → Cloud → API keys).");
  process.exit(1);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API}/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  return { status: res.status, data };
}

console.log(`→ ${TEMPLATE}: registering ${BASE_IMAGE}`);
const existing = await api(`/templates/${TEMPLATE}`);

if (existing.status === 200) {
  const res = await api(`/templates/${TEMPLATE}`, {
    method: "PATCH",
    body: JSON.stringify({ image_ref: BASE_IMAGE }),
  });
  if (res.status !== 200) {
    console.error(`  update failed (${res.status}): ${JSON.stringify(res.data)}`);
    process.exit(1);
  }
  console.log(`  updated (revision ${res.data.revision ?? "?"})`);
} else if (existing.status === 404) {
  const res = await api("/templates", {
    method: "POST",
    body: JSON.stringify({
      name: TEMPLATE,
      image_ref: BASE_IMAGE,
      description: "Hermes on the clean base — runs on your own OpenRouter key",
    }),
  });
  if (res.status !== 200 && res.status !== 201) {
    console.error(`  create failed (${res.status}): ${JSON.stringify(res.data)}`);
    process.exit(1);
  }
  console.log("  created");
} else {
  console.error(`  template check failed (${existing.status}): ${JSON.stringify(existing.data)}`);
  process.exit(1);
}

console.log("\nDone. Create agents from the dashboard — they'll run on your OpenRouter key.");
