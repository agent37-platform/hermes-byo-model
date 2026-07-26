#!/usr/bin/env node
// Give your local dev server a public URL, for local development only.
//
// Agents run in Agent37's cloud and call back into this app for every LLM turn, so the app has to
// be reachable from the internet — an agent can't reach http://localhost:3000. In production that
// URL is just your deployment's (set NEXT_PUBLIC_SITE_URL and nothing here is involved). Locally,
// this opens a Cloudflare quick tunnel — no Cloudflare account, no token — and writes the URL it
// prints into .env.local, which the dev server picks up automatically.
//
//   Terminal 1: npm run dev
//   Terminal 2: npm run tunnel      (leave it running)
//
// Quick tunnels get a NEW hostname every run. That's fine here: agents record the proxy URL they
// were wired with, and the dashboard re-wires any agent whose URL no longer matches (a restart per
// agent, a minute or so). If you'd rather keep one hostname across sessions, create a named tunnel
// on your own domain (`cloudflared tunnel create` + `route dns`) and set NEXT_PUBLIC_SITE_URL to it
// by hand instead of running this.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, ".env.local");
const PORT = process.env.PORT || "3000";

if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error(
    "cloudflared is not installed.\n\n" +
      "  macOS:  brew install cloudflared\n" +
      "  other:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n\n" +
      "Or deploy the app and set NEXT_PUBLIC_SITE_URL to its URL instead."
  );
  process.exit(1);
}

function writeSiteUrl(url) {
  const line = `NEXT_PUBLIC_SITE_URL=${url}`;
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = current.split("\n").filter((l) => !l.startsWith("NEXT_PUBLIC_SITE_URL="));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(envPath, [...lines, line, ""].join("\n"));
}

console.log(`Opening a Cloudflare quick tunnel to http://localhost:${PORT} …`);
const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

let announced = false;
function watch(chunk) {
  const text = chunk.toString();
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  if (match && !announced) {
    announced = true;
    writeSiteUrl(match[0]);
    console.log(
      `\n  Public URL: ${match[0]}\n` +
        `  Written to .env.local as NEXT_PUBLIC_SITE_URL — the dev server reloads it on its own.\n` +
        `  Leave this running. Existing agents re-wire themselves on the dashboard's next poll.\n`
    );
  }
}

child.stdout.on("data", watch);
child.stderr.on("data", watch); // cloudflared prints the URL on stderr
child.on("exit", (code) => {
  console.error(`\ncloudflared exited (${code}). Agents can't reach this app until a tunnel is up again.`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
