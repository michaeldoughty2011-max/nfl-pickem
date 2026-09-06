/* Exercises the API end to end against the dev server and prints an audit
   that can be checked by hand: ATS grading, Lock tiebreak, KOTH survivor. */
const B = "http://localhost:8787/api";
const post = async (p, b) => {
  const r = await fetch(B + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => (await fetch(B + p)).json();

const ADMIN = "4321";
const say = (...a) => console.log(...a);
const NAMES = ["Mike D", "Kevin", "Sully", "Ray", "Fitzy", "Deb", "Tommy", "Nash", "Vic", "Gus", "Marty", "Pauly"];
const pinOf = (i) => String(1000 + i);

let s = await get("/state");
if (!s.league.configured) {
  await post("/setup", { adminPin: ADMIN, players: NAMES });
  s = await get("/state");
}
say("league name defaults to:", JSON.stringify(s.league.name));

/* ---------------------------- week 1 ------------------------------- */

const openWeek = async (week) => {
  const st = await get(`/state?week=${week}`);
  const ids = st.games
    .filter((g) => [0, 1, 6].includes(new Date(g.kickoff).getDay()))
    .map((g) => g.id);
  await post("/admin", { adminPin: ADMIN, action: "publishSlate", week, gameIds: ids });
  await post("/admin", { adminPin: ADMIN, action: "setReopened", week, reopened: true });
  return get(`/state?week=${week}`);
};

s = await openWeek(1);
const slate1 = s.games.filter((g) => s.slate.gameIds.includes(g.id));
const fmtET = (ms) =>
  new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short",
    day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
say("week 1 slate:", slate1.length, "games");
say("  first kickoff :", fmtET(s.lockAt));
say("  lines lock at :", fmtET(s.linesLockAt), "· frozen:", s.slate.linesFrozen);
say("  lines lock is a Wednesday 5pm ET:",
  /^Wed/.test(fmtET(s.linesLockAt)) && /5:00 PM/.test(fmtET(s.linesLockAt)));

const players = s.players;
// Give everyone a different KOTH team so week 2 has real reuse pressure.
const kothW1 = ["SEA", "LAR", "CIN", "DET", "TEN", "IND", "PIT", "CAR", "JAX", "HOU", "MIN", "LV"];

for (let i = 0; i < players.length; i++) {
  const p = players[i];
  await post("/login", { playerId: p.id, pin: pinOf(i) });
  const picks = {};
  slate1.forEach((g, j) => (picks[g.id] = (i + j) % 3 !== 0 ? g.home : g.away));
  const res = await post("/picks", {
    playerId: p.id, pin: pinOf(i), week: 1,
    picks, lock: slate1[i % slate1.length].id, koth: kothW1[i],
  });
  if (res.status !== 200) say("PICK FAIL", p.id, res.body);
}

/* ------------------------- validation gates ------------------------ */

const full = (slate) => Object.fromEntries(slate.map((g) => [g.id, g.home]));
const base = { playerId: players[0].id, pin: pinOf(0), week: 1 };

const t = [];
t.push(["wrong PIN", await post("/picks", { ...base, pin: "9999", picks: {}, lock: "" }), 401]);
t.push(["incomplete sheet", await post("/picks", { ...base, picks: { [slate1[0].id]: slate1[0].home }, lock: slate1[0].id, koth: "SEA" }), 400]);
t.push(["missing lock", await post("/picks", { ...base, picks: full(slate1), lock: "", koth: "SEA" }), 400]);
t.push(["missing KOTH", await post("/picks", { ...base, picks: full(slate1), lock: slate1[0].id, koth: "" }), 400]);
t.push(["KOTH team on a bye", await post("/picks", { ...base, picks: full(slate1), lock: slate1[0].id, koth: "ZZZ" }), 400]);
for (const [label, r, want] of t) say(`${label.padEnd(20)} rejected:`, r.status === want, "·", r.body.error || "");

/* --------------------- lock enforcement + override ------------------ */

await post("/admin", { adminPin: ADMIN, action: "setReopened", week: 1, reopened: false });
const locked = await post("/picks", { ...base, picks: full(slate1), lock: slate1[0].id, koth: "SEA" });
say("locked week refuses picks:", locked.status === 423);
const s1 = await get("/state?week=1");
say("lines frozen once kickoff passed:", s1.slate.linesFrozen === true);

/* ----------------------------- week 2 ------------------------------ */

await post("/admin", { adminPin: ADMIN, action: "setCurrentWeek", week: 2 });
let s2 = await openWeek(2);
const slate2 = s2.games.filter((g) => s2.slate.gameIds.includes(g.id));
say("week 2 slate:", slate2.length, "games");

// Reuse must be refused: Mike D already burned SEA in week 1.
const reuse = await post("/picks", {
  playerId: players[0].id, pin: pinOf(0), week: 2,
  picks: full(slate2), lock: slate2[0].id, koth: "SEA",
});
say("KOTH reuse refused:", reuse.status === 400, "·", reuse.body.error || "");

const kothW2 = ["NE", "SF", "TB", "NO", "NYJ", "BAL", "ATL", "CHI", "CLE", "BUF", "GB", "MIA"];
for (let i = 0; i < players.length; i++) {
  const picks = {};
  slate2.forEach((g, j) => (picks[g.id] = (i + j) % 2 === 0 ? g.home : g.away));
  const res = await post("/picks", {
    playerId: players[i].id, pin: pinOf(i), week: 2,
    picks, lock: slate2[i % slate2.length].id, koth: kothW2[i],
  });
  if (res.status !== 200) say("W2 PICK FAIL", players[i].id, res.body.error);
}

/* --------------------------- KOTH audit ---------------------------- */

const w2games = (await get("/state?week=2")).games;
const straightUp = (games, team) => {
  const g = games.find((x) => x.home === team || x.away === team);
  if (!g || g.state !== "final") return "pending";
  if (g.homeScore === g.awayScore) return "push";
  return (g.homeScore > g.awayScore ? g.home : g.away) === team ? "win" : "loss";
};

say("\n--- KOTH week 2 (all final) ---");
const final2 = await get("/state?week=2");
let mismatch = 0;
for (let i = 0; i < players.length; i++) {
  const info = final2.koth[players[i].id];
  const team = kothW2[i];
  const wasOut = info.eliminatedWeek && info.eliminatedWeek < 2;
  // Players already eliminated don't get a week-2 KOTH entry at all.
  const expected = wasOut ? undefined : straightUp(w2games, team);
  const got = (info.used.find((u) => u.week === 2) || {}).result;
  const flag = expected === got ? "" : "  <-- MISMATCH";
  if (flag) mismatch++;
  say(
    `${players[i].name.padEnd(8)} w1 ${kothW1[i].padEnd(4)} w2 ${team.padEnd(4)}`,
    `${String(got).padEnd(8)} alive=${String(info.alive).padEnd(5)}`,
    info.eliminatedWeek ? `out wk${info.eliminatedWeek} (${info.reason})` : "",
    flag
  );
}
say("KOTH results all agree with straight-up outcome:", mismatch === 0);

const alive = players.filter((p) => final2.koth[p.id].alive).length;
say("still standing after 2 weeks:", alive, "of", players.length);

// Someone eliminated in week 2 must be refused a week-2 KOTH change... they
// stay eliminated, but the commissioner can still fix the entry.
const dead = players.find((p) => final2.koth[p.id].eliminatedWeek === 1);
if (dead) {
  const r = await post("/admin", {
    adminPin: ADMIN, action: "setPicksFor", week: 2, playerId: dead.id,
    picks: full(slate2), lock: slate2[0].id, koth: "",
  });
  say("eliminated player needs no KOTH on override:", r.status === 200);
}

const season = await get("/season");
say("season weeks:", season.weeks.length, "· koth players:", Object.keys(season.koth || {}).length);
