/* Proves the Wednesday 5:00 PM Eastern line deadline:
   lines follow the feed before it, and freeze to the number that stood at
   the deadline afterwards — even if the feed moves later. */
const B = "http://localhost:8787";
const post = async (p, b) =>
  (await fetch(B + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  })).json();
const get = async (p) => (await fetch(B + p)).json();
const say = (...a) => console.log(...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const fmt = (ms) =>
  new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short",
    day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

const ADMIN = "4321";
let s = await get("/api/state");
if (!s.league.configured) await post("/api/setup", { adminPin: ADMIN, players: ["A", "B"] });

/* 1. A game 30 days out — the Wednesday deadline is still ahead of us. */
await post("/__test/week3", { kickoff: Date.now() + 30 * DAY, spread: -3.5 });
let st = await get("/api/state?week=3");
await post("/api/admin", { adminPin: ADMIN, action: "publishSlate", week: 3, gameIds: [st.games[0].id] });
st = await get("/api/state?week=3");
say("deadline ahead of us      :", fmt(st.linesLockAt));
say("  frozen?                 :", st.slate.linesFrozen, "(expect false)");
say("  line captured           :", st.games[0].spreadHome, "(expect -3.5)");

/* 2. The line moves while we're still before the deadline — app follows it. */
await post("/__test/week3", { kickoff: Date.now() + 30 * DAY, spread: -6.5 });
await wait(400);
st = await get("/api/state?week=3");
say("line moves before deadline:", st.games[0].spreadHome, "(expect -6.5)");
say("  still unfrozen          :", st.slate.linesFrozen === false);

/* 3. Kickoff moves to tomorrow, so the Wednesday deadline is now behind us,
      and the feed simultaneously shows a very different number. The app must
      freeze the number it was holding, not the new one. */
await post("/__test/week3", { kickoff: Date.now() + DAY, spread: -14.5 });
await wait(400);
st = await get("/api/state?week=3");
say("deadline now behind us    :", fmt(st.linesLockAt));
say("  frozen?                 :", st.slate.linesFrozen, "(expect true)");
say("  graded line             :", st.games[0].spreadHome, "(expect -6.5, NOT -14.5)");

/* 4. Feed keeps moving after the freeze — nothing may change. */
await post("/__test/week3", { kickoff: Date.now() + DAY, spread: 2.5 });
await wait(400);
st = await get("/api/state?week=3");
say("feed moves after freeze   :", st.games[0].spreadHome, "(expect -6.5)");

const pass = st.games[0].spreadHome === -6.5 && st.slate.linesFrozen === true;
say("\nWednesday deadline holds:", pass);
