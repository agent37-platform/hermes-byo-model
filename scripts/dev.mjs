#!/usr/bin/env node
// `npm run dev` — Next.js dev plus the one thing localhost can't do by itself: agents run in
// Agent37's cloud and call this app's /api/llm proxy for EVERY model turn, so the app has to be
// reachable over the public internet. When no public URL is configured, this starts a free
// cloudflared quick tunnel (no Cloudflare account, no token) and hands its URL to the app as
// NEXT_PUBLIC_SITE_URL — in process, so nothing stale is written to .env.local.
//
// In production none of this runs: set NEXT_PUBLIC_SITE_URL to your deployed URL and the app uses
// that. Quick-tunnel hostnames change every run, which is fine — agents record the URL they were
// wired with and re-wire themselves on the next dashboard poll (src/lib/bootstrap.ts).
//
// No cloudflared? The app still runs — sign-in, the dashboard, existing agents' files — but agents
// can't be created or chat until there's a public URL (`brew install cloudflared`, or deploy).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.PORT || "3000";

function envLocal(name) {
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

function isPublicUrl(url) {
  return /^https?:\/\//.test(url) && !url.includes("localhost") && !url.includes("127.0.0.1");
}

async function startTunnel() {
  const probe = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    console.log(
      "\n! cloudflared not found — agents reach their model through this app, so they need it on a\n" +
        "  public URL. Install it (`brew install cloudflared`) and rerun, or set NEXT_PUBLIC_SITE_URL\n" +
        "  to a deployed URL. Creating an agent is refused until then.\n"
    );
    return null;
  }

  const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise((resolve) => {
    let buffer = "";
    const timeout = setTimeout(() => resolve(null), 30_000);
    tunnel.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    tunnel.on("exit", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
  if (!url) {
    console.log("\n! Tunnel did not come up; continuing without one (agents can't be created).\n");
    try {
      tunnel.kill();
    } catch {
      /* already gone */
    }
    return null;
  }
  return { tunnel, url };
}

const configured = envLocal("NEXT_PUBLIC_SITE_URL");
let siteUrl = isPublicUrl(configured) ? configured : "";
let tunnel = null;

if (!envLocal("OPENROUTER_API_KEY")) {
  console.log("\n! OPENROUTER_API_KEY is not set — agents have no model to run on (see .env.example).\n");
}

if (siteUrl) {
  console.log(`\n→ Agents reach this app at ${siteUrl} (NEXT_PUBLIC_SITE_URL)\n`);
} else {
  const started = await startTunnel();
  if (started) {
    tunnel = started.tunnel;
    siteUrl = started.url;
    console.log(`\n→ Agents reach this app at ${siteUrl} (auto-tunnel; new URL each run — agents re-wire themselves)\n`);
  }
}

const next = spawn("npx", ["next", "dev", "--port", port], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(siteUrl ? { NEXT_PUBLIC_SITE_URL: siteUrl } : {}) },
});

function shutdown() {
  try {
    tunnel?.kill();
  } catch {
    /* already gone */
  }
  try {
    next.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
next.on("exit", (code) => {
  try {
    tunnel?.kill();
  } catch {
    /* already gone */
  }
  process.exit(code ?? 0);
});
