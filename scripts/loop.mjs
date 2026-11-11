// Keeps the ladder fresh without relying on GitHub's cron, which only fires every few hours.
// Runs blizzard.mjs every 5 minutes for 5.5 hours, then queues the next run of the workflow and
// exits (GitHub stops jobs at 6 hours). Between fetches it checks ntfy.sh for pings from the page's
// Force refresh button and fetches straight away, at most once a minute.
// The ntfy topic is read from index.html (NTFY_TOPIC) so the page and this script always match.

import { readFile, rm } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";

const env = process.env;
const EVERY = Number(env.LOOP_EVERY_MS) || 5 * 60_000;
const RUN_FOR = Number(env.LOOP_RUN_FOR_MS) || 5.5 * 3600_000;
const POLL = Number(env.LOOP_POLL_MS) || 10_000;
const MIN_GAP = Number(env.LOOP_MIN_GAP_MS) || 60_000;
const IN_ACTIONS = env.GITHUB_ACTIONS === "true";

const html = await readFile("index.html", "utf8");
const TOPIC = env.NTFY_TOPIC || html.match(/NTFY_TOPIC\s*=\s*"([^"]+)"/)?.[1];
if (!TOPIC) throw new Error("NTFY_TOPIC not found in index.html");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
let since = String(Math.floor(started / 1000)); // ntfy cursor: a unix time, then the last message id

// Pull the latest main first so script and roster edits apply without restarting the loop.
async function fetchOnce() {
  if (IN_ACTIONS) {
    try {
      execFileSync("git", ["fetch", "-q", "--depth=1", "origin", env.GITHUB_REF_NAME || "main"], { stdio: "inherit" });
      execFileSync("git", ["reset", "-q", "--hard", "FETCH_HEAD"], { stdio: "inherit" });
    } catch { console.log("Could not update the checkout, using the current one."); }
  }
  await rm("out", { recursive: true, force: true });
  const r = spawnSync(process.execPath, ["scripts/blizzard.mjs", "out", "--publish"], { stdio: "inherit" });
  if (r.status !== 0) console.log(`blizzard.mjs exited with ${r.status}`);
}

async function pinged() {
  try {
    const res = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${since}`);
    if (!res.ok) return false;
    const msgs = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
    if (!msgs.length) return false;
    since = msgs[msgs.length - 1].id;
    return true;
  } catch {
    return false;
  }
}

async function queueNext() {
  if (!IN_ACTIONS) { console.log("Not in GitHub Actions, not queueing another run."); return; }
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/blizzard.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: env.GITHUB_REF_NAME || "main" })
  });
  console.log(res.ok ? "Queued the next run." : `Could not queue the next run: HTTP ${res.status}`);
}

while (Date.now() - started < RUN_FOR) {
  await fetchOnce();
  const last = Date.now();
  while (Date.now() - last < EVERY) {
    await sleep(POLL);
    if (await pinged()) {
      const wait = MIN_GAP - (Date.now() - last);
      console.log(`Refresh requested${wait > 0 ? `, waiting ${Math.ceil(wait / 1000)}s` : ""}`);
      if (wait > 0) await sleep(wait);
      break;
    }
  }
}
await queueNext();
