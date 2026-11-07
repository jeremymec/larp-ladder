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

const QUALITY = { POOR: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, ARTIFACT: 6, HEIRLOOM: 7 };
// Slots that count as "empty" (shirt, tabard, ammo and off-hand left out: cosmetic or two-handers).
const SLOTS = ["HEAD", "NECK", "SHOULDER", "BACK", "CHEST", "WRIST", "HANDS", "WAIST", "LEGS", "FEET",
  "FINGER_1", "FINGER_2", "TRINKET_1", "TRINKET_2", "MAIN_HAND", "RANGED"];

// Every achievement statistic as { "Total deaths": 15, ... }.
function flatStats(body) {
  const out = {};
  const walk = (cat) => {
    for (const s of cat.statistics || []) if (typeof s.quantity === "number") out[s.name] = s.quantity;
    for (const sub of cat.sub_categories || []) walk(sub);
  };
  for (const cat of body?.categories || []) walk(cat);
  return out;
}

function gearOf(body) {
  const items = body?.equipped_items;
  if (!items) return null;
  const bySlot = Object.fromEntries(items.map((i) => [i.slot?.type, i]));
  let worst = null;
  for (const i of items) {
    if (["SHIRT", "TABARD", "AMMO"].includes(i.slot?.type)) continue;
    const it = { name: i.name, q: QUALITY[i.quality?.type] ?? 1, ilvl: i.level?.value ?? 0 };
    if (!worst || it.ilvl < worst.ilvl || (it.ilvl === worst.ilvl && it.q < worst.q)) worst = it;
  }
  return {
    worst,
    empty: SLOTS.filter((s) => !bySlot[s]).map((s) => s.toLowerCase().replace("_", "")),
    grey: items.filter((i) => i.quality?.type === "POOR").length
  };
}

function professionsOf(body) {
  return (body?.primaries || []).map((p) => {
    const tier = (p.tiers || [])[0] || {};
    return { name: p.profession?.name, skill: tier.skill_points ?? 0, max: tier.max_skill_points ?? null };
  }).filter((p) => p.name);
}

// XP needed to go from level N to N+1, assumed to match the original 1-60 table.
const XP_TO_NEXT = [0, 400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600, 8800, 10100, 11400, 12900, 14400,
  16000, 17700, 19400, 21300, 23200, 25200, 27300, 29400, 31700, 34000, 36400, 38900, 41400, 44300, 47400, 50800,
  54500, 58600, 62800, 67100, 71600, 76100, 80800, 85700, 90700, 95800, 101000, 106300, 111800, 117500, 123200,
  129100, 135100, 141200, 147500, 153900, 160400, 167100, 173900, 180800, 187900, 195000, 202300, 209800];
function exactLevel(level, xp) {
  const need = XP_TO_NEXT[level];
  if (!need || typeof xp !== "number") return level;
  return Math.round((level + Math.min(xp / need, 0.999)) * 100) / 100;
}

const LAUNCH = Date.parse("2026-11-04T23:00:00Z"); // WoW Forever went live 3pm PST, Nov 4
const DAY = 86400000;

// history.json on the data branch: { "Name Surname": [[seenAt, exactLevel, lastLogin], ...] }
async function loadHistory() {
  try {
    if (process.env.HISTORY_IN) return JSON.parse(await readFile(process.env.HISTORY_IN, "utf8"));
    if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return {};
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/history.json?ref=data`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github.raw" }
    });
    return res.ok ? await res.json() : {};
  } catch (e) {
    console.log("No previous history:", e.message);
    return {};
  }
}

// Levels gained over the last 24h (or since tracking began, if that is sooner), and when they last dinged.
function progressOf(points, now) {
  if (!points?.length) return {};
  const cur = points[points.length - 1];
  let ding = null;
  for (let i = points.length - 1; i > 0; i--) {
    if (Math.floor(points[i][1]) > Math.floor(points[i - 1][1])) { ding = points[i][2] || points[i][0]; break; }
  }
  const cutoff = now - DAY;
  let from = points[0];
  for (const p of points) { if (p[0] <= cutoff) from = p; else break; }
  const hours = Math.round((now - Math.max(from[0], cutoff)) / 3600000);
  return {
    last_ding: ding ? new Date(ding).toISOString() : null,
    gained: hours >= 1 ? { levels: Math.round((cur[1] - from[1]) * 10) / 10, hours: Math.min(hours, 24) } : null
  };
}

const history = await loadHistory();
const now = Date.now();
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
  if (!s || s.level == null) {
    characters[name] = { status: "missing", http: statuses };
    console.log(`${name}: missing`, JSON.stringify(statuses));
    continue;
  }
  const stats = flatStats(found["/achievements/statistics"]);
  const lvl = exactLevel(s.level, s.experience);
  const lastLogin = s.last_login_timestamp || 0;

  // Log a point whenever level/XP or the logout time changes; keep 30 days.
  const points = (history[name] || []).filter((p) => p[0] > now - 30 * DAY);
  const prev = points[points.length - 1];
  if (!prev || prev[1] !== lvl || prev[2] !== lastLogin) points.push([now, lvl, lastLogin]);
  history[name] = points;

  characters[name] = {
    status: "ok",
    http: statuses,
    name: [s.name, s.surname].filter(Boolean).join(" ") || name,
    level: s.level,
    level_exact: lvl,
    race: s.race?.name ?? null,
    class: s.character_class?.name ?? null,
    ilvl: s.equipped_item_level ?? s.average_item_level ?? null,
    last_login: iso(lastLogin),
    deaths: stats["Total deaths"] ?? 0,
    quests: stats["Quests completed"] ?? 0,
    need: stats["Need rolls made on loot"] ?? 0,
    greed: stats["Greed rolls made on loot"] ?? 0,
    professions: professionsOf(found["/professions"]),
    worst_item: gearOf(found["/equipment"])?.worst ?? null,
    speed: Math.round(((lvl - 1) / Math.max((now - LAUNCH) / DAY, 0.5)) * 10) / 10, // levels per day since launch
    ...progressOf(points, now),
    stats
  };
  console.log(`${name}: ok`, JSON.stringify(statuses));
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "data.json"), JSON.stringify({ updated_at: new Date(now).toISOString(), characters }, null, 2));
await writeFile(join(OUT, "history.json"), JSON.stringify(history));
console.log(`Wrote ${join(OUT, "data.json")} and history.json`);

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
