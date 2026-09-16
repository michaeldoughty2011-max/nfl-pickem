import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ *
 * Weekly NFL Pick'em — single API function.
 * Storage: Netlify Blobs. Live data: Sleeper public NFL scores feed.
 * ------------------------------------------------------------------ */

const SEASON = 2026;
const MAX_WEEK = 18;
const SCORE_TTL_LIVE = 20_000;   // ms — while a game is in progress
// Shortened only by the local test harness; unset in production.
const SCORE_TTL_IDLE = Number(process.env.PICKEM_IDLE_TTL) || 300_000;

const store = () => getStore({ name: "pickem", consistency: "strong" });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const fail = (message, status = 400) => json({ ok: false, error: message }, status);

const hash = (salt, pin) =>
  crypto.createHash("sha256").update(`pickem:${salt}:${String(pin)}`).digest("hex");

const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) ||
  "player";

async function readJSON(key, fallback = null) {
  try {
    const v = await store().get(key, { type: "json" });
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

async function writeJSON(key, value) {
  await store().setJSON(key, value);
}

/* ---------------------------- live feed ---------------------------- */

function normalizeGame(raw) {
  const m = raw.metadata || {};
  const home = m.home_team;
  const away = m.away_team;
  // Negative = home favored. The feed sometimes carries a pickem_spread object
  // with no entry for a given team, so fall through value by value rather than
  // object by object — otherwise one game with a gap has no line at all.
  const spreadHome = (() => {
    const sources = [m.pickem_spread, m.spread];
    for (const s of sources) if (s && typeof s[home] === "number") return s[home];
    for (const s of sources) if (s && typeof s[away] === "number") return -s[away];
    return null;
  })();

  const quarters = (side) =>
    [1, 2, 3, 4].reduce((t, q) => t + (Number(m[`${side}_score_quarter${q}`]) || 0), 0) +
    (Number(m[`${side}_score_overtime`]) || 0);

  const homeScore = typeof m.home_score === "number" ? m.home_score : quarters("home");
  const awayScore = typeof m.away_score === "number" ? m.away_score : quarters("away");

  const over = Boolean(m.is_over || m.closed || m.status === "closed" || m.quarter === "F");
  const started = Boolean(m.has_started || m.is_in_progress || over);
  const live = started && !over;

  return {
    id: String(raw.game_id),
    kickoff: Number(raw.start_time) || Date.parse(m.date_time) || 0,
    away,
    home,
    spreadHome,
    channel: m.channel || "",
    city: (m.stadium_details && m.stadium_details.city) || "",
    state: over ? "final" : live ? "live" : "pre",
    homeScore: started ? homeScore : 0,
    awayScore: started ? awayScore : 0,
    quarter: m.quarter || "",
    clock: m.time_remaining || "",
    possession: m.possession || "",
    down: m.down_and_distance || "",
    yardLine: m.yard_line === 0 || m.yard_line ? String(m.yard_line) : "",
    yardSide: m.yard_line_territory || "",
    redZone: Boolean(m.red_zone),
    overtime: Boolean(m.is_overtime),
    canceled: Boolean(m.canceled),
  };
}

async function fetchWeekGames(week) {
  const cacheKey = `cache:${SEASON}:${week}`;
  const cached = await readJSON(cacheKey, null);
  const anyLive = cached && cached.games.some((g) => g.state === "live");
  const ttl = anyLive ? SCORE_TTL_LIVE : SCORE_TTL_IDLE;
  if (cached && Date.now() - cached.at < ttl) return { games: cached.games, at: cached.at };

  try {
    const res = await fetch(
      `https://api.sleeper.app/scores/nfl/regular/${SEASON}/${week}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const raw = await res.json();
    const games = (Array.isArray(raw) ? raw : [])
      .map(normalizeGame)
      .filter((g) => g.home && g.away)
      .sort((a, b) => a.kickoff - b.kickoff || a.home.localeCompare(b.home));
    const at = Date.now();
    if (games.length) await writeJSON(cacheKey, { at, games });
    return { games, at };
  } catch (err) {
    if (cached) return { games: cached.games, at: cached.at, stale: true };
    return { games: [], at: 0, error: String(err.message || err) };
  }
}

/* ------------------------------ league ----------------------------- */

const emptyLeague = () => ({
  name: "Pickem",
  season: SEASON,
  currentWeek: 1,
  adminPinHash: "",
  createdAt: 0,
});

async function getLeague() {
  return (await readJSON("league", null)) || emptyLeague();
}

/* Players the commissioner has taken out of KOTH. Applied once, then the
   Commish tab's per-player toggle owns it. */
const KOTH_OUT_ON_UPGRADE = ["bc"];

async function getPlayers() {
  const p = await readJSON("players", []);
  if (!Array.isArray(p) || !p.length) return [];
  const league = await readJSON("league", null);
  if (league && !league.kothOptOutApplied) {
    let touched = false;
    for (const player of p) {
      if (KOTH_OUT_ON_UPGRADE.includes(player.id) && player.koth !== false) {
        player.koth = false;
        touched = true;
      }
    }
    league.kothOptOutApplied = true;
    await writeJSON("league", league);
    if (touched) await writeJSON("players", p);
  }
  return p;
}

async function getPicks(week) {
  const out = {};
  try {
    const prefix = `pick:${SEASON}:${week}:`;
    const { blobs } = await store().list({ prefix });
    await Promise.all(
      blobs.map(async (b) => {
        const entry = await readJSON(b.key, null);
        if (entry && entry.playerId) out[entry.playerId] = entry;
      })
    );
  } catch {
    /* empty week */
  }
  return out;
}

async function getWeekDoc(week) {
  return (
    (await readJSON(`week:${SEASON}:${week}`, null)) || {
      week,
      season: SEASON,
      published: false,
      gameIds: [],
      reopened: false,
      updatedAt: 0,
    }
  );
}

function lockTime(weekDoc, games) {
  const slate = games.filter((g) => weekDoc.gameIds.includes(g.id));
  if (!slate.length) return null;
  return Math.min(...slate.map((g) => g.kickoff));
}

/** True once the first game on the slate has kicked off, regardless of
 *  whether the commissioner has since reopened picks. */
function kickoffPassed(weekDoc, games) {
  const t = lockTime(weekDoc, games);
  return t !== null && Date.now() >= t;
}

function weekIsLocked(weekDoc, games) {
  if (weekDoc.reopened) return false;
  return kickoffPassed(weekDoc, games);
}

/* --------------------------- frozen lines --------------------------- */
/* The feed moves all week. The slate's lines are snapshotted continuously
   until Wednesday 5:00 PM Eastern, and whatever stood then is the number
   every pick is graded against for the rest of the week. */

const ET = "America/New_York";
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function etParts(ms) {
  const p = {};
  for (const x of etFmt.formatToParts(ms)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: p.weekday };
}

/** The UTC instant for a wall-clock time in Eastern, DST included. */
function etToUtc(y, m, d, h, mi) {
  let t = Date.UTC(y, m - 1, d, h + 5, mi); // start from the EST guess
  for (let i = 0; i < 3; i++) {
    const p = etParts(t);
    const drift = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Date.UTC(y, m - 1, d, h, mi);
    if (!drift) break;
    t -= drift;
  }
  return t;
}

/** Wednesday 5:00 PM Eastern immediately before the slate's first kickoff. */
function linesLockAt(weekDoc, games) {
  const first = lockTime(weekDoc, games);
  if (first === null) return null;
  let probe = first;
  for (let i = 0; i < 9; i++) {
    const p = etParts(probe);
    if (p.wd === "Wed") {
      const t = etToUtc(p.y, p.m, p.d, 17, 0);
      if (t <= first) return t;
    }
    probe -= 86_400_000;
  }
  return null;
}

function applyLines(games, weekDoc) {
  const lines = weekDoc.lines || {};
  return games.map((g) =>
    lines[g.id] === undefined ? g : { ...g, spreadHome: lines[g.id], lineFrozen: !!weekDoc.linesFrozen }
  );
}

async function syncLines(week, weekDoc, games) {
  if (!weekDoc.published || !weekDoc.gameIds.length) return weekDoc;

  const deadline = linesLockAt(weekDoc, games);
  const past = deadline !== null && Date.now() >= deadline;
  const held = { ...(weekDoc.lines || {}) };
  let changed = false;

  for (const g of games) {
    if (!weekDoc.gameIds.includes(g.id) || g.spreadHome === null) continue;
    // Before the deadline every line tracks the feed. After it, only a game
    // that never got a line at all can still be filled in — anything already
    // captured is final and never moves again.
    if (past && held[g.id] !== undefined) continue;
    if (held[g.id] !== g.spreadHome) {
      held[g.id] = g.spreadHome;
      changed = true;
    }
  }

  // The deadline locks the week even if a game's line never showed up. A
  // missing number must never hold the whole week open.
  const freezeNow = past && !weekDoc.linesFrozen;
  if (!changed && !freezeNow) return weekDoc;

  weekDoc.lines = held;
  if (changed) weekDoc.linesUpdatedAt = Date.now();
  if (freezeNow) {
    weekDoc.linesFrozen = true;
    weekDoc.linesFrozenAt = deadline;
  }
  await writeJSON(`week:${SEASON}:${week}`, weekDoc);
  return weekDoc;
}

/** Everything one week needs, with frozen lines already applied. */
async function loadWeek(week) {
  const [feed, doc0] = await Promise.all([fetchWeekGames(week), getWeekDoc(week)]);
  const doc = await syncLines(week, doc0, feed.games);
  return { doc, games: applyLines(feed.games, doc), feed };
}

/* ------------------------ King of the Hill -------------------------- */
/* Survivor: one team a week, must win outright, never the same team twice.
   A loss ends that life; an outright tie survives but burns the team. Missing
   a completed week ends it too.
   BUYBACK: losing your FIRST life in week 1-5 earns one second life, usable
   only in the very next week — take a team that week and you're back in on
   entry 2. Skip it and the option is gone. Two lives is the ceiling, and every
   team used across both lives stays burned. */

const BUYBACK_LAST_LOSS_WEEK = 5;

function kothResult(game, team) {
  if (!game) return "none";
  if (game.state !== "final") return game.state === "live" ? "live" : "pending";
  if (game.homeScore === game.awayScore) return "push";
  return (game.homeScore > game.awayScore ? game.home : game.away) === team ? "win" : "loss";
}

async function computeKoth(upto) {
  const players = await getPlayers();
  const weeks = await Promise.all(
    Array.from({ length: upto }, (_, i) => i + 1).map(async (w) => {
      const [{ games }, picks, doc] = await Promise.all([
        fetchWeekGames(w),
        getPicks(w),
        getWeekDoc(w),
      ]);
      const slate = games.filter((g) => doc.gameIds.includes(g.id));
      return {
        week: w,
        games,
        picks,
        published: doc.published && slate.length > 0,
        complete: slate.length > 0 && slate.every((g) => g.state === "final"),
        firstKick: slate.length ? Math.min(...slate.map((g) => g.kickoff)) : 0,
      };
    })
  );

  const out = {};
  for (const p of players) {
    if (p.koth === false) {
      out[p.id] = {
        excluded: true, used: [], teams: [], entry: 0, entriesUsed: 0,
        alive: false, eliminatedWeek: 0, reason: "not in KOTH", buybackWeek: 0,
      };
      continue;
    }

    const used = [];
    let entry = 1;          // which KOTH life they're on
    let entriesUsed = 1;
    let alive = true;
    let eliminatedWeek = 0;
    let reason = "";
    let buybackWeek = 0;    // the one week a buyback may be taken

    for (const wk of weeks) {
      if (!wk.published) continue;
      // The buyback is good for exactly one week; once it's behind us it's gone.
      if (buybackWeek && wk.week > buybackWeek) buybackWeek = 0;

      const picked = wk.picks[p.id];
      const team = picked && picked.koth;

      if (!alive) {
        if (buybackWeek === wk.week && team) {
          // Taking a team in the buyback week starts the second life.
          alive = true;
          entry = 2;
          entriesUsed = 2;
          eliminatedWeek = 0;
          reason = "";
          buybackWeek = 0;
        } else {
          // The window shuts the moment that week's picks lock, not when its
          // games finish — otherwise it can close while picks are still open.
          if (buybackWeek === wk.week && wk.firstKick && Date.now() >= wk.firstKick) {
            buybackWeek = 0;
          }
          continue;
        }
      }

      if (!team) {
        // An alive player who sits out a finished week is done.
        if (wk.complete && (p.createdAt || 0) < wk.firstKick) {
          alive = false;
          eliminatedWeek = wk.week;
          reason = "missed the week";
          if (entry === 1 && wk.week <= BUYBACK_LAST_LOSS_WEEK) buybackWeek = wk.week + 1;
        }
        continue;
      }

      const game = wk.games.find((g) => g.home === team || g.away === team);
      const result = kothResult(game, team);
      used.push({
        week: wk.week,
        team,
        result,
        entry,
        opponent: game ? (game.home === team ? `@${game.away}` : `vs ${game.away}`) : "",
      });
      if (result === "loss") {
        alive = false;
        eliminatedWeek = wk.week;
        reason = `${team} lost`;
        if (entry === 1 && wk.week <= BUYBACK_LAST_LOSS_WEEK) buybackWeek = wk.week + 1;
      }
    }

    out[p.id] = {
      excluded: false,
      used,
      teams: used.map((u) => u.team), // burned across BOTH lives
      entry,
      entriesUsed,
      alive,
      eliminatedWeek,
      reason,
      buybackWeek,
    };
  }
  return out;
}

async function getKoth(upto) {
  const memo = await readJSON("koth:memo", null);
  if (memo && memo.upto === upto && Date.now() - memo.at < 60_000) return memo.data;
  const data = await computeKoth(upto);
  await writeJSON("koth:memo", { at: Date.now(), upto, data });
  return data;
}

const dropKothMemo = () => store().delete("koth:memo").catch(() => {});

/* Sealing helpers — strip one week's KOTH team from anything sent to the
   whole league. Who picked stays visible; what they picked does not. */

function sealPicks(rawPicks) {
  const out = {};
  for (const [id, entry] of Object.entries(rawPicks)) {
    const { koth: hidden, ...rest } = entry;
    out[id] = { ...rest, koth: "", kothIn: Boolean(hidden) };
  }
  return out;
}

function sealKoth(rawKoth, week) {
  const out = {};
  for (const [id, info] of Object.entries(rawKoth)) {
    const used = info.used.map((u) =>
      u.week === week ? { week: u.week, entry: u.entry, result: "pending", hidden: true } : u
    );
    out[id] = { ...info, used, teams: used.filter((u) => !u.hidden).map((u) => u.team) };
  }
  return out;
}

/* ------------------------- request handling ------------------------ */

export default async (req) => {
  const url = new URL(req.url);
  let route = url.pathname
    .replace(/^\/\.netlify\/functions\/api/, "")
    .replace(/^\/api/, "")
    .replace(/^\//, "");
  route = route.split("/")[0] || "state";

  let body = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return fail("Could not read that request.");
    }
  }

  try {
    switch (route) {
      case "state":
        return await handleState(url);
      case "season":
        return await handleSeason();
      case "setup":
        return await handleSetup(body);
      case "login":
        return await handleLogin(body);
      case "picks":
        return await handlePicks(body);
      case "avatar":
        return req.method === "POST" ? await handleAvatarSet(body) : await handleAvatarGet(url);
      case "mine":
        return await handleMine(body);
      case "admin":
        return await handleAdmin(body);
      default:
        return fail("Unknown request.", 404);
    }
  } catch (err) {
    return fail(`Server error: ${err.message || err}`, 500);
  }
};

/* -------------------------------- state ---------------------------- */

async function handleState(url) {
  const league = await getLeague();
  const players = await getPlayers();

  let week = Number(url.searchParams.get("week"));
  const explicit = Number.isFinite(week) && week >= 1 && week <= MAX_WEEK;
  if (!explicit) week = league.currentWeek || 1;

  const { doc: weekDoc, games, feed } = await loadWeek(week);
  const { at, stale, error } = feed;
  const rawPicks = await getPicks(week);
  const rawKoth = await getKoth(Math.max(week, Number(league.currentWeek) || 1));

  // KOTH teams stay sealed until the first kickoff. Everyone can see WHO has
  // picked; nobody sees WHAT until the games start. A signed-in player reads
  // their own back through /api/mine.
  const revealAt = lockTime(weekDoc, games);
  const sealed = revealAt !== null && Date.now() < revealAt;

  const picks = sealed ? sealPicks(rawPicks) : rawPicks;
  const koth = sealed ? sealKoth(rawKoth, week) : rawKoth;

  // Roll the league forward once every game on the published slate is final.
  if (
    !explicit &&
    league.adminPinHash &&
    week < MAX_WEEK &&
    weekDoc.published &&
    weekDoc.gameIds.length &&
    games.length
  ) {
    const slate = games.filter((g) => weekDoc.gameIds.includes(g.id));
    const allDone = slate.length > 0 && slate.every((g) => g.state === "final");
    const last = slate.length ? Math.max(...slate.map((g) => g.kickoff)) : 0;
    if (allDone && Date.now() > last + 8 * 3600_000) {
      league.currentWeek = week + 1;
      await writeJSON("league", league);
    }
  }

  return json({
    ok: true,
    now: Date.now(),
    season: SEASON,
    maxWeek: MAX_WEEK,
    week,
    league: {
      name: league.name,
      currentWeek: league.currentWeek,
      configured: Boolean(league.adminPinHash),
    },
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      hasPin: Boolean(p.pinHash),
      active: p.active !== false,
      avatar: p.avatar || 0, // version stamp; 0 = no photo
      koth: p.koth !== false,
    })),
    kothSealed: sealed,
    kothRevealAt: revealAt,
    slate: {
      gameIds: weekDoc.gameIds,
      published: weekDoc.published,
      reopened: !!weekDoc.reopened,
      linesFrozen: !!weekDoc.linesFrozen,
      linesAt: weekDoc.linesUpdatedAt || 0,
      missingLines: weekDoc.gameIds.filter((id) => (weekDoc.lines || {})[id] === undefined),
    },
    locked: weekIsLocked(weekDoc, games),
    lockAt: lockTime(weekDoc, games),
    linesLockAt: linesLockAt(weekDoc, games),
    games,
    picks,
    koth,
    feed: { at, stale: !!stale, error: error || null },
  });
}

/* ------------------------------- season ---------------------------- */

const compact = (g) => ({
  id: g.id,
  home: g.home,
  away: g.away,
  spreadHome: g.spreadHome,
  state: g.state,
  homeScore: g.homeScore,
  awayScore: g.awayScore,
  kickoff: g.kickoff,
});

async function handleSeason() {
  const league = await getLeague();
  const upto = Math.min(MAX_WEEK, Math.max(1, Number(league.currentWeek) || 1));
  const weeks = await Promise.all(
    Array.from({ length: upto }, (_, i) => i + 1).map(async (w) => {
      const { doc, games } = await loadWeek(w);
      if (!doc.published || !doc.gameIds.length) return null;
      const raw = await getPicks(w);
      const slate = games.filter((g) => doc.gameIds.includes(g.id));
      if (!slate.length) return null;
      // Seal this week's KOTH here too, so the season view can't be used to
      // peek at what the live week's picks are.
      const kick = Math.min(...slate.map((g) => g.kickoff));
      const sealed = Date.now() < kick;
      return {
        week: w,
        gameIds: doc.gameIds,
        games: slate.map(compact),
        picks: sealed ? sealPicks(raw) : raw,
        sealed,
      };
    })
  );
  const live = weeks.filter(Boolean).find((w) => w.sealed);
  let koth = await getKoth(upto);
  if (live) koth = sealKoth(koth, live.week);
  return json({ ok: true, weeks: weeks.filter(Boolean), koth });
}

/* -------------------------------- setup ---------------------------- */

async function handleSetup(body) {
  const league = await getLeague();
  if (league.adminPinHash) return fail("This league is already set up.");

  const name = String(body.leagueName || "").trim().slice(0, 60) || "Pickem";
  const pin = String(body.adminPin || "").trim();
  if (!/^\d{4,8}$/.test(pin)) return fail("The commissioner PIN must be 4-8 digits.");

  const names = (Array.isArray(body.players) ? body.players : [])
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, 24);
  if (names.length < 2) return fail("Add at least two players.");

  const used = new Set();
  const players = names.map((n) => {
    let id = slug(n);
    let i = 2;
    while (used.has(id)) id = `${slug(n)}-${i++}`;
    used.add(id);
    return { id, name: n.slice(0, 32), pinHash: "", active: true, createdAt: Date.now() };
  });

  await writeJSON("players", players);
  await writeJSON("league", {
    name,
    season: SEASON,
    currentWeek: Number(body.currentWeek) || 1,
    adminPinHash: hash("admin", pin),
    createdAt: Date.now(),
  });
  return json({ ok: true });
}

/* -------------------------------- login ---------------------------- */

async function handleLogin(body) {
  const players = await getPlayers();
  const player = players.find((p) => p.id === body.playerId);
  if (!player) return fail("That player is not in the league.");

  const pin = String(body.pin || "").trim();
  if (!/^\d{4,8}$/.test(pin)) return fail("Your PIN must be 4-8 digits.");

  if (!player.pinHash) {
    player.pinHash = hash(player.id, pin);
    await writeJSON("players", players);
    return json({ ok: true, created: true });
  }
  if (player.pinHash !== hash(player.id, pin)) return fail("That PIN doesn't match.", 401);
  return json({ ok: true });
}

async function requirePlayer(body) {
  const players = await getPlayers();
  const player = players.find((p) => p.id === body.playerId);
  if (!player) return { error: fail("That player is not in the league.") };
  const pin = String(body.pin || "").trim();
  if (!player.pinHash || player.pinHash !== hash(player.id, pin))
    return { error: fail("Sign in again — that PIN doesn't match.", 401) };
  return { player, players };
}

async function requireAdmin(body) {
  const league = await getLeague();
  const pin = String(body.adminPin || "").trim();
  if (!league.adminPinHash || league.adminPinHash !== hash("admin", pin))
    return { error: fail("Wrong commissioner PIN.", 401) };
  return { league };
}

/* ------------------------------- mine ------------------------------ */
/* KOTH picks are hidden from everyone until kickoff, so a signed-in player
   needs an authenticated way to see their own. */

async function handleMine(body) {
  const { player, error } = await requirePlayer(body);
  if (error) return error;
  const league = await getLeague();
  const week = Number(body.week) || Number(league.currentWeek) || 1;
  const entry = await readJSON(`pick:${SEASON}:${week}:${player.id}`, null);
  const koth = await getKoth(Math.max(week, Number(league.currentWeek) || 1));
  return json({ ok: true, week, entry, koth: koth[player.id] || null });
}

/* ------------------------------ avatars ---------------------------- */
/* Stored one blob per player, served with a long cache and busted by the
   version stamp carried in /api/state. Kept out of the state payload so the
   30-second poll stays small. */

const AVATAR_TYPES = { "image/jpeg": true, "image/png": true, "image/webp": true };
const AVATAR_MAX = 300_000; // bytes, decoded — the client resizes well below this

async function handleAvatarGet(url) {
  const id = String(url.searchParams.get("p") || "");
  const rec = id ? await readJSON(`avatar:${id}`, null) : null;
  if (!rec || !rec.b64) return new Response("", { status: 404 });
  return new Response(Buffer.from(rec.b64, "base64"), {
    headers: {
      "content-type": rec.type || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function handleAvatarSet(body) {
  const players = await getPlayers();
  const player = players.find((p) => p.id === body.playerId);
  if (!player) return fail("That player is not in the league.");

  // Either the player with their own PIN, or the commissioner.
  let allowed = false;
  if (body.adminPin) {
    const league = await getLeague();
    allowed = league.adminPinHash === hash("admin", String(body.adminPin).trim());
    if (!allowed) return fail("Wrong commissioner PIN.", 401);
  } else {
    const pin = String(body.pin || "").trim();
    allowed = Boolean(player.pinHash) && player.pinHash === hash(player.id, pin);
    if (!allowed) return fail("Sign in again — that PIN doesn't match.", 401);
  }

  const dataUrl = String(body.dataUrl || "");

  if (!dataUrl) {
    await store().delete(`avatar:${player.id}`);
    player.avatar = 0;
    await writeJSON("players", players);
    return json({ ok: true, avatar: 0 });
  }

  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) return fail("That image didn't come through. Try a different photo.");
  const [, type, b64] = m;
  if (!AVATAR_TYPES[type.toLowerCase()]) return fail("Use a JPEG, PNG or WebP image.");
  if (Math.floor((b64.length * 3) / 4) > AVATAR_MAX)
    return fail("That image is too big even after resizing. Try another one.");

  const version = Date.now();
  await writeJSON(`avatar:${player.id}`, { type: type.toLowerCase(), b64, at: version });
  player.avatar = version;
  await writeJSON("players", players);
  return json({ ok: true, avatar: version });
}

/* -------------------------------- picks ---------------------------- */

function validateEntry(entry, weekDoc, games, kothInfo) {
  const slate = games.filter((g) => weekDoc.gameIds.includes(g.id));
  if (!weekDoc.published || !slate.length)
    return "This week's games aren't posted yet.";

  const picks = entry.picks || {};
  for (const g of slate) {
    const pick = picks[g.id];
    if (!pick) return `Pick a team in ${g.away} @ ${g.home}.`;
    if (pick !== g.home && pick !== g.away) return `${pick} isn't in ${g.away} @ ${g.home}.`;
  }
  for (const id of Object.keys(picks)) {
    if (!weekDoc.gameIds.includes(id)) delete picks[id];
  }
  if (!entry.lock || !weekDoc.gameIds.includes(entry.lock))
    return "Choose your Lock of the Week.";

  // King of the Hill. Players out of KOTH entirely, or eliminated with no
  // buyback available, simply carry no KOTH pick.
  const buybackOpen = Boolean(kothInfo && kothInfo.buybackWeek === entry.week);
  const alive = !kothInfo || kothInfo.alive || kothInfo.eliminatedWeek >= entry.week;
  if (kothInfo && kothInfo.excluded) {
    entry.koth = "";
    return null;
  }
  if (!alive && !buybackOpen) {
    entry.koth = "";
    return null;
  }
  const team = entry.koth;
  // A buyback is optional — you may sit it out and stay eliminated.
  if (!team && buybackOpen && !alive) return null;
  if (!team) return "Choose your King of the Hill team.";
  if (!games.some((g) => g.home === team || g.away === team))
    return `${team} isn't playing in Week ${entry.week}.`;
  const spent = (kothInfo ? kothInfo.used : []).filter((u) => u.week !== entry.week);
  if (spent.some((u) => u.team === team))
    return `You already used ${team} in Week ${spent.find((u) => u.team === team).week}.`;
  return null;
}

async function handlePicks(body) {
  const { player, error } = await requirePlayer(body);
  if (error) return error;

  const week = Number(body.week);
  if (!(week >= 1 && week <= MAX_WEEK)) return fail("That week doesn't exist.");

  const { doc: weekDoc, games } = await loadWeek(week);
  if (weekIsLocked(weekDoc, games))
    return fail("Picks are locked for this week — kickoff has passed.", 423);

  const league = await getLeague();
  const koth = await getKoth(Math.max(week, Number(league.currentWeek) || 1));

  const entry = {
    playerId: player.id,
    week,
    season: SEASON,
    picks: { ...(body.picks || {}) },
    lock: body.lock || "",
    koth: String(body.koth || "").trim().toUpperCase(),
    updatedAt: Date.now(),
    enteredBy: "player",
  };
  const problem = validateEntry(entry, weekDoc, games, koth[player.id]);
  if (problem) return fail(problem);

  await writeJSON(`pick:${SEASON}:${week}:${player.id}`, entry);
  await dropKothMemo();
  return json({ ok: true, entry });
}

/* -------------------------------- admin ---------------------------- */

async function handleAdmin(body) {
  const { error } = await requireAdmin(body);
  if (error) return error;

  const action = String(body.action || "");

  if (action === "setCurrentWeek") {
    const week = Number(body.week);
    if (!(week >= 1 && week <= MAX_WEEK)) return fail("That week doesn't exist.");
    const league = await getLeague();
    league.currentWeek = week;
    await writeJSON("league", league);
    return json({ ok: true });
  }

  if (action === "publishSlate") {
    const week = Number(body.week);
    if (!(week >= 1 && week <= MAX_WEEK)) return fail("That week doesn't exist.");
    const { games } = await loadWeek(week);
    const valid = new Set(games.map((g) => g.id));
    const gameIds = (Array.isArray(body.gameIds) ? body.gameIds : [])
      .map(String)
      .filter((id) => valid.has(id));
    if (!gameIds.length) return fail("Pick at least one game for the slate.");
    const weekDoc = await getWeekDoc(week);
    weekDoc.gameIds = gameIds;
    weekDoc.published = body.published !== false;
    weekDoc.updatedAt = Date.now();
    await writeJSON(`week:${SEASON}:${week}`, weekDoc);
    return json({ ok: true, slate: weekDoc });
  }

  if (action === "freezeLines") {
    const week = Number(body.week);
    if (!(week >= 1 && week <= MAX_WEEK)) return fail("That week doesn't exist.");
    const { doc, games } = await loadWeek(week);
    if (!doc.published || !doc.gameIds.length) return fail("Post the slate first.");
    const lines = { ...(doc.lines || {}) };
    for (const g of games) {
      if (doc.gameIds.includes(g.id) && g.spreadHome !== null) lines[g.id] = g.spreadHome;
    }
    doc.lines = lines;
    doc.linesFrozen = true;
    doc.linesFrozenAt = Date.now();
    doc.linesUpdatedAt = Date.now();
    await writeJSON(`week:${SEASON}:${week}`, doc);
    return json({ ok: true, frozen: Object.keys(lines).length, of: doc.gameIds.length });
  }

  if (action === "setReopened") {
    const week = Number(body.week);
    const weekDoc = await getWeekDoc(week);
    weekDoc.reopened = Boolean(body.reopened);
    weekDoc.updatedAt = Date.now();
    await writeJSON(`week:${SEASON}:${week}`, weekDoc);
    return json({ ok: true, slate: weekDoc });
  }

  if (action === "savePlayers") {
    const incoming = Array.isArray(body.players) ? body.players : [];
    if (incoming.length > 24) return fail("24 players is the ceiling.");
    const existing = await getPlayers();
    const used = new Set();
    const players = incoming
      .map((p) => {
        const name = String(p.name || "").trim().slice(0, 32);
        if (!name) return null;
        const prior = existing.find((e) => e.id === p.id);
        let id = prior ? prior.id : slug(name);
        let i = 2;
        while (used.has(id)) id = `${slug(name)}-${i++}`;
        used.add(id);
        return {
          id,
          name,
          pinHash: prior ? prior.pinHash : "",
          avatar: prior ? prior.avatar || 0 : 0,
          koth: prior ? prior.koth !== false : true,
          active: p.active !== false,
          createdAt: prior ? prior.createdAt : Date.now(),
        };
      })
      .filter(Boolean);
    if (!players.length) return fail("Keep at least one player.");
    await writeJSON("players", players);
    return json({ ok: true, players });
  }

  if (action === "setKothIn") {
    const players = await getPlayers();
    const player = players.find((p) => p.id === body.playerId);
    if (!player) return fail("No such player.");
    player.koth = Boolean(body.inKoth);
    await writeJSON("players", players);
    await dropKothMemo();
    return json({ ok: true, koth: player.koth });
  }

  if (action === "resetPin") {
    const players = await getPlayers();
    const player = players.find((p) => p.id === body.playerId);
    if (!player) return fail("No such player.");
    player.pinHash = "";
    await writeJSON("players", players);
    return json({ ok: true });
  }

  if (action === "setPicksFor") {
    const week = Number(body.week);
    const players = await getPlayers();
    const player = players.find((p) => p.id === body.playerId);
    if (!player) return fail("No such player.");
    const { doc: weekDoc, games } = await loadWeek(week);
    const league = await getLeague();
    const koth = await getKoth(Math.max(week, Number(league.currentWeek) || 1));
    const entry = {
      playerId: player.id,
      week,
      season: SEASON,
      picks: { ...(body.picks || {}) },
      lock: body.lock || "",
      koth: String(body.koth || "").trim().toUpperCase(),
      updatedAt: Date.now(),
      enteredBy: "commissioner",
    };
    const problem = validateEntry(entry, weekDoc, games, koth[player.id]);
    if (problem) return fail(problem);
    await writeJSON(`pick:${SEASON}:${week}:${player.id}`, entry);
    await dropKothMemo();
    return json({ ok: true, entry });
  }

  if (action === "clearPicksFor") {
    const week = Number(body.week);
    await store().delete(`pick:${SEASON}:${week}:${String(body.playerId)}`);
    await dropKothMemo();
    return json({ ok: true });
  }

  if (action === "renameLeague") {
    const league = await getLeague();
    league.name = String(body.name || "").trim().slice(0, 60) || league.name;
    await writeJSON("league", league);
    return json({ ok: true });
  }

  if (action === "verify") return json({ ok: true });

  return fail("Unknown commissioner action.");
}

export const config = { path: "/api/*" };
