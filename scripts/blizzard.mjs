// Pulls every roster character from Blizzard's WoW Forever API and writes:
//   <out>/data.json            small file the page reads (one entry per character)
//   <out>/raw/<slug>/<x>.json  full responses, for finding new stats to show
// Usage: BLIZZARD_CLIENT_ID=... BLIZZARD_SECRET=... node scripts/blizzard.mjs out [--publish]
// --publish force-pushes <out> as the single commit of the "data" branch (needs GH_TOKEN and
// GITHUB_REPOSITORY, which the GitHub Actions job provides).
// The roster is read from index.html so there is only one list to edit.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const OUT = process.argv[2] || "out";
const PUBLISH = process.argv.includes("--publish");
const ID = process.env.BLIZZARD_CLIENT_ID;
const SECRET = process.env.BLIZZARD_SECRET || process.env.BLIZZARD_CLIENT_SECRET;
const REGION = "us";
const HOST = `https://${REGION}.api.blizzard.com`;
const NAMESPACE = `profile-forever-${REGION}`;

// Character sub-pages to save. "" is the profile summary.
const ENDPOINTS = [
  "", "/statistics", "/achievements", "/achievements/statistics", "/equipment", "/professions",
  "/pvp-summary", "/quests", "/quests/completed", "/reputations", "/titles", "/specializations",
  "/collections/mounts", "/collections/pets", "/character-media", "/appearance", "/encounters"
];

if (!ID || !SECRET) {
  console.log("BLIZZARD_CLIENT_ID / BLIZZARD_SECRET not set, skipping.");
  process.exit(0);
}

const html = await readFile("index.html", "utf8");
const roster = [...html.matchAll(/first:\s*"([^"]+)",\s*last:\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
if (!roster.length) throw new Error("No characters found in index.html ROSTER");

const tokenRes = await fetch("https://oauth.battle.net/token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body: "grant_type=client_credentials"
});
if (!tokenRes.ok) {
  console.error(`Token request failed: HTTP ${tokenRes.status}. Check the two repo secrets.`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

async function get(path) {
  const url = `${HOST}${path}${path.includes("?") ? "&" : "?"}namespace=${NAMESPACE}&locale=en_US`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    const body = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  }
  return { status: 503, body: null };
}

const slugOf = (name) => name.toLowerCase().replace(/\s+/g, "-");
const iso = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);

const characters = {};
for (const name of roster) {
  const slug = slugOf(name);
  const base = `/profile/wow/character/${encodeURIComponent(slug)}`;
  const found = {};
  const statuses = {};
  for (const ep of ENDPOINTS) {
    const { status, body } = await get(base + ep);
    statuses[ep || "/"] = status;
    if (status === 200 && body) {
      found[ep || "/"] = body;
      const file = join(OUT, "raw", slug, (ep || "/summary").slice(1).replace(/\//g, "_") + ".json");
      await mkdir(join(OUT, "raw", slug), { recursive: true });
      await writeFile(file, JSON.stringify(body, null, 2));
    }
    if (!ep && status !== 200) break; // no profile means nothing else will work
  }
  const s = found["/"];
  characters[name] = {
    status: s ? "ok" : "missing",
    http: statuses,
    ...(s && {
      name: [s.name, s.surname].filter(Boolean).join(" ") || name,
      level: s.level ?? null,
      race: s.race?.name ?? null,
      class: s.character_class?.name ?? null,
      faction: s.faction?.name ?? s.faction?.type ?? null,
      ruleset: s.ruleset?.name ?? s.ruleset?.slug ?? null,
      ilvl: s.equipped_item_level ?? s.average_item_level ?? null,
      achievement_points: s.achievement_points ?? null,
      last_login: iso(s.last_login_timestamp)
    })
  };
  console.log(`${name}: ${characters[name].status}`, JSON.stringify(statuses));
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "data.json"), JSON.stringify({ updated_at: new Date().toISOString(), characters }, null, 2));
console.log(`Wrote ${join(OUT, "data.json")}`);

if (PUBLISH) {
  const remote = process.env.PUBLISH_REMOTE
    || `https://x-access-token:${process.env.GH_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
  const git = (...args) => execFileSync("git", args, { cwd: OUT, stdio: ["ignore", "inherit", "inherit"] });
  git("init", "-q", "-b", "data");
  git("add", "-A");
  git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-q", "-m", "Update Blizzard data");
  git("push", "-fq", remote, "data");
  console.log("Published to the data branch");
}
