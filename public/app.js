/* Weekly NFL Pick'em — client */
(() => {
  "use strict";

  const S = {
    data: null,
    week: null,
    tab: "picks",
    me: null,          // { playerId, pin }
    mine: null,        // own unsealed entry + KOTH state, from /api/mine
    adminPin: null,
    draft: null,       // { picks:{gameId:team}, lock:string, koth:string }
    dirty: false,
    open: new Set(),   // game ids whose pick list is expanded
    season: null,      // week -> compact payload, for standings
    seasonLoading: false,
    timer: null,
    busy: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $("#view");

  /* Team colours, picked from each club's palette but shifted where the
     brand primary is too dark to read on the app's dark ground. Used as a
     tint and edge, never as text, so contrast holds in both themes. */
  const TEAM_COLOR = {
    ARI: "#c41e3a", ATL: "#e01933", BAL: "#6a4fd8", BUF: "#2f7ce0",
    CAR: "#0085ca", CHI: "#e64100", CIN: "#fb4f14", CLE: "#ff6a13",
    DAL: "#a7b3c4", DEN: "#fa6a1e", DET: "#4ca9e8", GB: "#ffb612",
    HOU: "#d6273b", IND: "#4a90d9", JAX: "#3fa9bc", KC: "#e31837",
    LV: "#c4cbd2", LAC: "#33a6e8", LAR: "#ffa300", MIA: "#00b0a8",
    MIN: "#8b5fd6", NE: "#e0334d", NO: "#d3bc8d", NYG: "#3b6fd4",
    NYJ: "#2e9e5b", PHI: "#21a0a0", PIT: "#ffc72c", SEA: "#69be28",
    SF: "#e04a4a", TB: "#e23b3b", TEN: "#5fa9e8", WAS: "#b3474a",
  };
  const teamColor = (t) => TEAM_COLOR[t] || "#8892a4";

  /* ------------------------------ utils ----------------------------- */

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const kickoffLabel = (ms) => {
    if (!ms) return "TBD";
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const dayLabel = (ms) =>
    new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  const lineFor = (game, team) => {
    if (game.spreadHome === null || game.spreadHome === undefined) return "—";
    const v = team === game.home ? game.spreadHome : -game.spreadHome;
    if (v === 0) return "PK";
    return (v > 0 ? "+" : "") + v;
  };

  const favoriteLabel = (g) => {
    if (g.spreadHome === null || g.spreadHome === undefined) return "line TBD";
    if (g.spreadHome === 0) return "pick 'em";
    const fav = g.spreadHome < 0 ? g.home : g.away;
    return `${fav} ${-Math.abs(g.spreadHome)}`;
  };

  // Positive => home covered by this much. Null => no line yet.
  const coverMargin = (g) => {
    if (g.spreadHome === null || g.spreadHome === undefined) return null;
    return g.homeScore + g.spreadHome - g.awayScore;
  };

  const resultFor = (g, pick) => {
    if (!pick) return "none";
    if (g.state === "pre") return "pending";
    const m = coverMargin(g);
    if (m === null) return "pending";
    if (m === 0) return "push";
    return pick === (m > 0 ? g.home : g.away) ? "win" : "loss";
  };

  const coverBlurb = (g) => {
    const m = coverMargin(g);
    if (m === null || g.state === "pre") return "";
    if (m === 0) return g.state === "final" ? "Push" : "On the number";
    const side = m > 0 ? g.home : g.away;
    return g.state === "final" ? `${side} covered` : `${side} covering`;
  };

  /* King of the Hill: straight up, no spread. */
  const kothResultFor = (g, team) => {
    if (!g) return "none";
    if (g.state !== "final") return g.state === "live" ? "live" : "pending";
    if (g.homeScore === g.awayScore) return "push";
    return (g.homeScore > g.awayScore ? g.home : g.away) === team ? "win" : "loss";
  };

  const gameForTeam = (games, team) =>
    games.find((g) => g.home === team || g.away === team) || null;

  /* YOUR record picking each team: every time you took them in a previous
     Pick'em week, did that pick win, lose or push? Graded against the spread,
     because that's how picks are graded — but it counts only the games you
     actually picked, so a team you've never taken sits at 0-0. */
  function myPickRecords() {
    const id = S.me && S.me.playerId;
    if (!id || !S.season) return null;
    const rec = {};
    for (const wk of S.season) {
      const entry = wk.picks[id];
      if (!entry || !entry.picks) continue;
      const onSlate = new Set(wk.gameIds);
      for (const g of wk.games) {
        if (!onSlate.has(g.id) || g.state !== "final") continue;
        const pick = entry.picks[g.id];
        if (!pick) continue;
        const r = resultFor(g, pick);
        if (r !== "win" && r !== "loss" && r !== "push") continue;
        rec[pick] = rec[pick] || { w: 0, l: 0, t: 0 };
        rec[pick][r === "win" ? "w" : r === "loss" ? "l" : "t"]++;
      }
    }
    return rec;
  }

  /* Cached per signed-in player, rebuilt when the player or the season data
     changes so it can never belong to the wrong person. */
  function teamRecords() {
    if (!S.season || !S.me) return null;
    if (!S.teamRecords || S.teamRecordsFor !== S.me.playerId) {
      S.teamRecords = myPickRecords();
      S.teamRecordsFor = S.me.playerId;
    }
    return S.teamRecords;
  }

  const teamsPlaying = (games) => {
    const out = [];
    for (const g of games) {
      out.push({ team: g.away, note: `@ ${g.home}`, kickoff: g.kickoff, game: g });
      out.push({ team: g.home, note: `vs ${g.away}`, kickoff: g.kickoff, game: g });
    }
    return out.sort((a, b) => a.team.localeCompare(b.team));
  };

  // Prefer the unsealed copy of my own KOTH state when it's loaded.
  const myKoth = () => {
    if (S.mine && S.mine.koth && S.mine.week === (S.data && S.data.week)) return S.mine.koth;
    const id = S.me && S.me.playerId;
    return (id && S.data && S.data.koth && S.data.koth[id]) || null;
  };

  const myEntry = () => {
    const id = S.me && S.me.playerId;
    if (!id || !S.data) return null;
    if (S.mine && S.mine.week === S.data.week) return S.mine.entry;
    return S.data.picks[id] || null;
  };

  const kothAliveFor = (info, week) =>
    !info || info.alive || (info.eliminatedWeek && info.eliminatedWeek >= week);

  /* Live drive detail. The feed only fills these while a game is in progress,
     and not every game carries every field, so render whatever is there. */
  const driveLine = (g) => {
    if (g.state !== "live") return "";
    const bits = [];
    if (g.possession) bits.push(`<strong>${esc(g.possession)}</strong> ball`);
    if (g.down) bits.push(esc(g.down));
    const spot = [g.yardSide, g.yardLine].filter(Boolean).join(" ");
    if (spot) bits.push(esc(spot));
    if (!bits.length) return "";
    return `<span class="drive${g.redZone ? " rz" : ""}">${
      g.redZone ? "<em>RED ZONE</em> · " : ""
    }${bits.join(" · ")}</span>`;
  };

  const statusLabel = (g) => {
    if (g.state === "final") return g.overtime ? "Final / OT" : "Final";
    if (g.state === "live") {
      const q = g.quarter ? (String(g.quarter).match(/^\d+$/) ? `Q${g.quarter}` : g.quarter) : "Live";
      return g.clock ? `${q} ${g.clock}` : q;
    }
    return kickoffLabel(g.kickoff);
  };

  /* ------------------------------ avatars --------------------------- */

  const initialsOf = (name) =>
    String(name).trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const hueFor = (id) => {
    let h = 7;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  };

  function avatarHtml(p, cls = "") {
    if (!p) return "";
    if (p.avatar)
      return `<span class="avatar ${cls}"><img src="/api/avatar?p=${encodeURIComponent(
        p.id
      )}&v=${p.avatar}" alt="" loading="lazy"></span>`;
    return `<span class="avatar ${cls}" style="background:hsl(${hueFor(
      p.id
    )} 50% 40%);color:#fff">${esc(initialsOf(p.name))}</span>`;
  }

  const loadImage = (file) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That file didn't open as an image."));
      };
      img.src = url;
    });

  /* Square-crop and shrink in the browser so a 4 MB phone photo becomes a
     ~15 KB upload. */
  async function shrinkImage(file, size = 176) {
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error("That image came through empty.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size
    );
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  function pickImageFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => resolve(input.files && input.files[0]);
      input.click();
    });
  }

  async function changePhoto(playerId, { adminPin } = {}) {
    const file = await pickImageFile();
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file);
      await api("/api/avatar", {
        playerId,
        dataUrl,
        ...(adminPin ? { adminPin } : { pin: S.me.pin }),
      });
      toast("Photo updated.", "info");
      closeModal();
      await load(S.week);
    } catch (err) {
      toast(err.message, "bad");
    }
  }

  async function removePhoto(playerId, { adminPin } = {}) {
    try {
      await api("/api/avatar", {
        playerId,
        dataUrl: "",
        ...(adminPin ? { adminPin } : { pin: S.me.pin }),
      });
      toast("Photo removed.", "info");
      closeModal();
      await load(S.week);
    } catch (err) {
      toast(err.message, "bad");
    }
  }

  const linesNote = (d) => {
    if (d.slate.linesFrozen) return "Lines are final for this week.";
    if (!d.linesLockAt) return "";
    return `Lines are still moving — they lock ${kickoffLabel(d.linesLockAt)}.`;
  };

  const slateOf = (data) =>
    data.games.filter((g) => data.slate.gameIds.includes(g.id));

  function recordFor(entry, slate) {
    const r = { w: 0, l: 0, t: 0, pending: 0, pts: 0, lockResult: "none" };
    if (!entry) {
      r.pending = slate.length;
      return r;
    }
    for (const g of slate) {
      const res = resultFor(g, entry.picks[g.id]);
      if (res === "win") r.w++;
      else if (res === "loss") r.l++;
      else if (res === "push") r.t++;
      else r.pending++;
      if (entry.lock === g.id) r.lockResult = res;
    }
    r.pts = r.w + r.t * 0.5;
    return r;
  }

  // Lock of the Week is the tiebreaker: a won lock beats a push, a push beats
  // one still on the board, and any of those beats a lock that lost.
  const lockRank = (res) =>
    res === "win" ? 4 : res === "push" ? 3 : res === "pending" ? 2 : res === "loss" ? 1 : 0;

  function rankPlayers(players, picks, slate) {
    return players
      .filter((p) => p.active)
      .map((p) => ({ player: p, entry: picks[p.id] || null, rec: recordFor(picks[p.id], slate) }))
      .sort(
        (a, b) =>
          b.rec.pts - a.rec.pts ||
          lockRank(b.rec.lockResult) - lockRank(a.rec.lockResult) ||
          a.player.name.localeCompare(b.player.name)
      );
  }

  function weekWinners(rows) {
    const scored = rows.filter((r) => r.entry);
    if (!scored.length) return [];
    const top = scored[0];
    if (top.rec.w + top.rec.l + top.rec.t === 0) return [];
    return scored.filter(
      (r) => r.rec.pts === top.rec.pts && lockRank(r.rec.lockResult) === lockRank(top.rec.lockResult)
    );
  }

  const fmtRec = (r) => `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}`;

  const pct = (w, l, t) => {
    const n = w + l + t;
    if (!n) return "—";
    return ((w + t * 0.5) / n).toFixed(3).replace(/^0/, "");
  };

  /* ------------------------------- api ------------------------------ */

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      throw new Error("The server sent something unreadable. Try again.");
    }
    if (!res.ok || payload.ok === false) throw new Error(payload.error || "That didn't work.");
    return payload;
  }

  async function load(week, { quiet = false } = {}) {
    if (!quiet) setSpin(true);
    try {
      const q = week ? `?week=${week}` : "";
      const data = await api(`/api/state${q}`);
      S.data = data;
      S.week = data.week;
      if (!S.mine || S.mine.week !== data.week) S.mine = null;
      if (!S.draft || S.draft.week !== data.week) resetDraft();
      render();
      loadMine();
    } catch (err) {
      if (!S.data) {
        view.innerHTML = `<div class="banner bad">Couldn't reach the league: ${esc(err.message)}</div>`;
      } else {
        toast(err.message, "bad");
      }
    } finally {
      setSpin(false);
      scheduleRefresh();
    }
  }

  async function loadMine() {
    if (!S.me || !S.data) return;
    try {
      const res = await api("/api/mine", {
        playerId: S.me.playerId,
        pin: S.me.pin,
        week: S.data.week,
      });
      S.mine = { week: res.week, entry: res.entry, koth: res.koth };
      resetDraft();
      render();
    } catch {
      /* stay with the sealed view */
    }
  }

  function resetDraft() {
    const mine = myEntry();
    S.draft = {
      week: S.data ? S.data.week : null,
      picks: mine ? { ...mine.picks } : {},
      lock: mine ? mine.lock : "",
      koth: mine ? mine.koth || "" : "",
    };
    S.dirty = false;
  }

  function scheduleRefresh() {
    clearTimeout(S.timer);
    const anyLive = S.data && S.data.games.some((g) => g.state === "live");
    S.timer = setTimeout(() => load(S.week, { quiet: true }), anyLive ? 30000 : 240000);
  }

  const setSpin = (on) => $("#refreshBtn").classList.toggle("spin", on);

  function toast(message, kind = "info") {
    const el = document.createElement("div");
    el.className = `banner ${kind}`;
    el.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:50;max-width:92vw;box-shadow:var(--shadow)";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ------------------------------ render ---------------------------- */

  function render() {
    const d = S.data;
    if (!d) return;

    $("#leagueName").textContent = d.league.name || "Pickem";
    const live = d.games.filter((g) => g.state === "live").length;
    $("#subline").textContent = live
      ? `Week ${d.week} · ${live} live`
      : !d.slate.published
      ? `Week ${d.week} · not posted`
      : d.locked
      ? `Week ${d.week} · locked`
      : `Week ${d.week} · open`;

    const me = S.me && d.players.find((p) => p.id === S.me.playerId);
    $("#whoBtn").innerHTML = me
      ? `${avatarHtml(me, "sm")}<span>${esc(me.name)}</span>`
      : `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
           stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"></circle>
           <path d="M4.8 20a7.4 7.4 0 0 1 14.4 0"></path></svg><span>Sign in</span>`;

    const age = d.feed.at ? Math.round((Date.now() - d.feed.at) / 1000) : null;
    $("#feedStamp").textContent = d.feed.error
      ? "Score feed unreachable — showing the last good data."
      : age === null
      ? "No score data yet."
      : `Scores updated ${age < 60 ? `${age}s` : `${Math.round(age / 60)} min`} ago · lines and scores via Sleeper`;

    $("#weekJump").innerHTML =
      `<label class="pill" style="gap:6px">Week
        <select id="weekPick" style="all:unset;font-weight:700;cursor:pointer">
        ${Array.from({ length: d.maxWeek }, (_, i) => i + 1)
          .map((w) => `<option value="${w}" ${w === d.week ? "selected" : ""}>${w}</option>`)
          .join("")}
        </select></label>`;
    $("#weekPick").onchange = (e) => load(Number(e.target.value));

    if (!d.league.configured) return renderSetup();

    if (S.tab === "picks") renderPicks();
    else if (S.tab === "live") renderLive();
    else if (S.tab === "standings") renderStandings();
    else renderAdmin();
  }

  /* ------------------------------ setup ----------------------------- */

  // Prefilled roster — edit the box on screen if anyone's in or out.
  const ROSTER = [
    "TC", "Lav", "Greg", "Jay", "Grayson", "BC", "Muff",
    "Gate", "Doug", "Tom", "Matt", "BU", "Vagner",
  ];

  function renderSetup() {
    view.innerHTML = `
      <section class="section">
        <div class="section-head"><div>
          <p class="eyebrow">One-time setup</p>
          <h2>Start the league</h2>
        </div></div>
        <div class="panel panel-pad" style="display:flex;flex-direction:column;gap:14px">
          <p class="note">You're the commissioner. Set a PIN only you know — you'll need it to choose each week's games and to fix anyone's picks.</p>
          <div class="field"><label for="lgPin">Commissioner PIN (4-8 digits)</label>
            <input id="lgPin" type="tel" inputmode="numeric" maxlength="8" placeholder="••••"></div>
          <div class="field"><label for="lgPlayers">Players — one name per line</label>
            <textarea id="lgPlayers" rows="13">${ROSTER.join("\n")}</textarea>
            <p class="note">Add, remove or rename anyone here now — or later in the Commish tab.</p></div>
          <button class="btn wide" id="setupGo">Create the league</button>
        </div>
      </section>`;
    $("#setupGo").onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api("/api/setup", {
          adminPin: $("#lgPin").value,
          players: $("#lgPlayers").value.split("\n").map((s) => s.trim()).filter(Boolean),
        });
        S.adminPin = $("#lgPin").value.trim();
        S.tab = "admin";
        syncTabs();
        await load();
        toast("League created. Now pick this week's games.", "info");
      } catch (err) {
        toast(err.message, "bad");
        e.target.disabled = false;
      }
    };
  }

  /* ------------------------------ picks ----------------------------- */

  function renderPicks() {
    const d = S.data;
    const slate = slateOf(d);
    const parts = [];
    ensureSeason(); // fills in your per-team records

    if (!d.slate.published || !slate.length) {
      view.innerHTML = `
        <div class="banner info">Week ${d.week} isn't posted yet. The commissioner picks the slate under <strong>Commish</strong>, then everyone can get their picks in.</div>`;
      return;
    }

    const meId = S.me && S.me.playerId;
    const editable = !d.locked && !!meId;
    const mine = myEntry();

    if (!meId) {
      parts.push(
        `<div class="banner info">Tap <strong>Sign in</strong> up top to pick your name and put your picks in.</div>`
      );
    } else if (d.locked) {
      parts.push(
        `<div class="banner warn">Picks are locked for Week ${d.week}${
          mine ? "" : " — you didn't get an entry in"
        }.</div>`
      );
    } else {
      const kick = d.lockAt ? kickoffLabel(d.lockAt) : "kickoff";
      parts.push(
        `<div class="banner info">Picks lock at <strong>${esc(kick)}</strong> — first kickoff on the slate. ${
          mine ? "Your picks are in; you can still change them." : "Pick every game and flag one Lock."
        } ${esc(linesNote(d))}</div>`
      );
    }

    // Group games by day.
    let lastDay = "";
    const cards = [];
    for (const g of slate) {
      const day = dayLabel(g.kickoff);
      if (day !== lastDay) {
        cards.push(`<p class="eyebrow" style="margin:6px 0 0">${esc(day)}</p>`);
        lastDay = day;
      }
      cards.push(gameCard(g, { editable, entry: mine, showEveryone: d.locked }));
    }

    parts.push(`<div class="games">${cards.join("")}</div>`);
    parts.push(kothSection({ editable, entry: mine }));

    if (editable) {
      const picked = slate.filter((g) => S.draft.picks[g.id]).length;
      const needsKoth = kothAliveFor(myKoth(), d.week);
      const ready = picked === slate.length && S.draft.lock && (!needsKoth || S.draft.koth);
      const missing = !S.draft.lock
        ? "no Lock yet"
        : needsKoth && !S.draft.koth
        ? "no KOTH yet"
        : "";
      parts.push(`
        <div class="sticky-save">
          <div class="grow"><strong class="num">${picked}/${slate.length}</strong> picked${
        missing ? ` · <span style="color:var(--loss)">${missing}</span>` : " · ready"
      }</div>
          <button class="btn" id="savePicks" ${ready ? "" : "disabled"}>${
        mine ? "Update picks" : "Submit picks"
      }</button>
        </div>`);
    }

    view.innerHTML = parts.join("");
    wirePickSheet();
  }

  function gameCard(g, { editable, entry, showEveryone, forPlayerName = null }) {
    const d = S.data;
    const chosen = editable ? S.draft.picks[g.id] : entry && entry.picks[g.id];
    const isLock = editable ? S.draft.lock === g.id : entry && entry.lock === g.id;
    const res = resultFor(g, chosen);
    const started = g.state !== "pre";

    const records = teamRecords();
    const teamBtn = (team, score) => {
      const sel = chosen === team;
      const cls = ["team"];
      if (sel && started && res !== "pending" && res !== "none") cls.push(`result-${res}`);
      const r = records && (records[team] || { w: 0, l: 0, t: 0 });
      const played = r && r.w + r.l + r.t > 0;
      // Green when they cover more than they don't, red the other way,
      // yellow dead even. No games yet stays neutral.
      const tone = !played ? "blank" : r.w > r.l ? "win" : r.l > r.w ? "loss" : "push";
      return `<button class="${cls.join(" ")}" ${editable ? "" : "disabled"} data-game="${g.id}" data-team="${team}"
        aria-pressed="${sel}">
        <span><span class="abbr">${team}</span> <span class="line num">${esc(lineFor(g, team))}</span>
        ${
          r
            ? `<span class="yourrec num ${tone}" title="Your record when you pick ${team}">You ${
                r.w
              }-${r.l}${r.t ? `-${r.t}` : ""}</span>`
            : ""
        }</span>
        ${started ? `<span class="score">${score}</span>` : ""}
      </button>`;
    };

    const blurb = coverBlurb(g);

    return `<article class="game ${isLock ? "is-lock" : ""}">
      <div class="game-meta">
        ${g.state === "live" ? '<span class="dot" aria-hidden="true"></span>' : ""}
        <span class="num">${esc(statusLabel(g))}</span>
        ${g.channel ? `<span>· ${esc(g.channel)}</span>` : ""}
        <span class="spacer"></span>
        <span>${esc(favoriteLabel(g))}</span>
      </div>
      <div class="matchup">
        ${teamBtn(g.away, g.awayScore)}
        ${teamBtn(g.home, g.homeScore)}
      </div>
      ${driveLine(g) ? `<div class="drive-row">${driveLine(g)}</div>` : ""}
      <div class="game-foot">
        ${
          editable
            ? `<button class="lock-btn" data-lock="${g.id}" aria-pressed="${!!isLock}">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                   <rect x="4.5" y="10.5" width="15" height="10" rx="2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>
                 </svg> Lock</button>`
            : isLock
            ? `<span class="pill lock">🔒 ${esc(forPlayerName || "Lock of the week")}</span>`
            : ""
        }
        ${blurb ? `<span class="pill ${res === "push" ? "push" : ""}">${esc(blurb)}</span>` : ""}
        ${
          chosen && !editable && (res === "win" || res === "loss")
            ? `<span class="pill ${res}">${res === "win" ? "Your win" : "Your loss"}</span>`
            : ""
        }
      </div>
      ${showEveryone ? everyonesPicks(g) : ""}
    </article>`;
  }

  function everyonesPicks(g) {
    const d = S.data;
    const rows = d.players
      .filter((p) => p.active && d.picks[p.id] && d.picks[p.id].picks[g.id])
      .map((p) => {
        const entry = d.picks[p.id];
        const pick = entry.picks[g.id];
        return { name: p.name, pick, res: resultFor(g, pick), isLock: entry.lock === g.id };
      });
    if (!rows.length) return "";

    const open = S.open.has(g.id);
    const dots = rows
      .map((r) => `<i class="${r.res === "pending" ? "" : r.res}"></i>`)
      .join("");
    // Before kickoff a pick carries no result, so it wears its team's colour.
    // Once the game starts, win/push/loss takes over.
    const tags = rows
      .map((r) => {
        const pending = r.res === "pending";
        return `<span class="tag ${pending ? "team" : r.res}"${
          pending ? ` style="--team:${teamColor(r.pick)}"` : ""
        }>${esc(r.name)} · ${esc(r.pick)}${r.isLock ? '<span class="lk">🔒</span>' : ""}</span>`;
      })
      .join("");

    return `<button class="reveal" data-reveal="${g.id}" aria-expanded="${open}">
        <span>${rows.length} pick${rows.length > 1 ? "s" : ""}</span>
        <span class="tally" aria-hidden="true">${dots}</span>
        <span class="caret"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg></span>
      </button>
      ${open ? `<div class="picks-strip">${tags}</div>` : ""}`;
  }

  /* --------------------------- King of the Hill --------------------- */

  function kothSection({ editable, entry }) {
    const d = S.data;
    const meId = S.me && S.me.playerId;
    if (!meId) return "";

    const info = myKoth();
    if (info && info.excluded) return "";

    const alive = kothAliveFor(info, d.week);
    const buyback = Boolean(info && info.buybackWeek === d.week && !alive);
    const mine = editable ? S.draft.koth : entry && entry.koth;
    const game = mine ? gameForTeam(d.games, mine) : null;
    const res = mine ? kothResultFor(game, mine) : "none";
    const entryNo = info ? (buyback && mine ? 2 : info.entry || 1) : 1;

    if (!alive && !buyback) {
      return `<section class="section">
        <div class="section-head"><div><p class="eyebrow">King of the Hill</p><h2>You're out</h2></div>
          <span class="pill out">Out · Week ${info.eliminatedWeek}</span></div>
        <div class="panel panel-pad"><p class="note">${esc(
          info.reason || "Eliminated"
        )} in Week ${info.eliminatedWeek}${
        info.entriesUsed > 1 ? " on your second entry" : ""
      }. You still pick every game against the spread — KOTH just isn't part of your week any more.</p></div>
      </section>`;
    }

    const spent = new Set((info ? info.used : []).filter((u) => u.week !== d.week).map((u) => u.team));

    const status = mine
      ? `<span class="pill ${res === "pending" || res === "live" || res === "none" ? "" : res}">${esc(
          mine
        )}${res === "win" ? " won" : res === "loss" ? " lost" : res === "push" ? " tied" : ""}</span>`
      : `<span class="pill">no pick yet</span>`;

    const grid = editable
      ? `<div class="koth-grid">${teamsPlaying(d.games)
          .map((t) => {
            const used = spent.has(t.team);
            return `<button class="koth-team" data-koth="${t.team}" ${used ? "disabled" : ""}
              aria-pressed="${S.draft.koth === t.team}"
              title="${used ? "already used this season" : esc(t.note)}">
              ${t.team}<small>${used ? "used" : esc(t.note)}</small></button>`;
          })
          .join("")}</div>`
      : `<div class="panel-pad"><p class="note">${
          mine ? `Your team: <strong>${esc(mine)}</strong>${game ? ` ${esc(
            game.home === mine ? `vs ${game.away}` : `@ ${game.home}`
          )}` : ""}` : "You didn't make a KOTH pick this week."
        }</p></div>`;

    const history = info && info.used.length
      ? `<p class="note" style="padding:0 12px 12px">Used so far: ${info.used
          .map((u) => `<span class="tag ${u.result === "pending" || u.result === "live" ? "" : u.result}">${esc(
            u.team
          )}</span>`)
          .join(" ")}</p>`
      : "";

    const banner = buyback
      ? `<div class="banner warn"><strong>This is your buyback week.</strong> ${esc(
          info.reason || "You were knocked out"
        )} in Week ${info.eliminatedWeek}. Taking a team here starts your <strong>second and final</strong> KOTH entry — and it only works this week. Skip it and you're done for the season. Every team you've already used stays burned.</div>`
      : `<div class="banner info">Straight up, no spread — your team just has to win. One loss and your KOTH season is over, and you can't use the same team twice.${
          entryNo > 1 ? " You're on your <strong>second entry</strong>." : ""
        }</div>`;

    return `<section class="section">
      <div class="section-head"><div><p class="eyebrow">King of the Hill${
        entryNo > 1 ? " · 2nd entry" : ""
      }</p>
        <h2>${buyback ? "Buy back in?" : "Pick one winner"}</h2></div>${status}</div>
      ${banner}
      <div class="panel">${grid}${history}</div>
    </section>`;
  }

  function wireReveals() {
    view.querySelectorAll("[data-reveal]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.reveal;
        if (S.open.has(id)) S.open.delete(id);
        else S.open.add(id);
        render();
      };
    });
  }

  function wirePickSheet() {
    wireReveals();
    view.querySelectorAll("[data-koth]").forEach((btn) => {
      btn.onclick = () => {
        S.draft.koth = S.draft.koth === btn.dataset.koth ? "" : btn.dataset.koth;
        S.dirty = true;
        renderPicks();
      };
    });
    view.querySelectorAll(".team[data-team]").forEach((btn) => {
      btn.onclick = () => {
        S.draft.picks[btn.dataset.game] = btn.dataset.team;
        S.dirty = true;
        renderPicks();
      };
    });
    view.querySelectorAll("[data-lock]").forEach((btn) => {
      btn.onclick = () => {
        S.draft.lock = S.draft.lock === btn.dataset.lock ? "" : btn.dataset.lock;
        S.dirty = true;
        renderPicks();
      };
    });
    const save = $("#savePicks");
    if (save)
      save.onclick = async () => {
        save.disabled = true;
        try {
          await api("/api/picks", {
            playerId: S.me.playerId,
            pin: S.me.pin,
            week: S.data.week,
            picks: S.draft.picks,
            lock: S.draft.lock,
            koth: S.draft.koth,
          });
          S.dirty = false;
          toast("Picks are in. Good luck.", "info");
          await load(S.week);
        } catch (err) {
          toast(err.message, "bad");
          save.disabled = false;
        }
      };
  }

  /* ------------------------------- live ----------------------------- */

  function renderLive() {
    const d = S.data;
    const slate = slateOf(d);
    if (!d.slate.published || !slate.length) {
      view.innerHTML = `<div class="banner info">Nothing posted for Week ${d.week} yet.</div>`;
      return;
    }

    const rows = rankPlayers(d.players, d.picks, slate);
    const entered = rows.filter((r) => r.entry);
    const winners = weekWinners(rows);
    const anyStarted = slate.some((g) => g.state !== "pre");
    const meId = S.me && S.me.playerId;

    const leader = !anyStarted
      ? `<div class="leader"><div><p class="eyebrow">Week ${d.week}</p>
           <strong class="display" style="font-size:22px">${entered.length} of ${
          d.players.filter((p) => p.active).length
        } entries in</strong>
           <p class="note">Results light up as the games kick off.</p></div></div>`
      : `<div class="leader">
           <div class="big num">${winners.length ? fmtRec(winners[0].rec) : "—"}</div>
           <div><p class="eyebrow">${slate.every((g) => g.state === "final") ? "Week winner" : "Leading this week"}</p>
             <strong class="display" style="font-size:22px">${
               winners.length ? winners.map((w) => esc(w.player.name)).join(" & ") : "Nobody yet"
             }</strong>
             ${
               winners.length && winners[0].rec.lockResult !== "none"
                 ? `<p class="note">Lock ${
                     winners[0].rec.lockResult === "pending" ? "still out there" : winners[0].rec.lockResult
                   }</p>`
                 : ""
             }</div></div>`;

    const table = `
      <div class="panel"><div class="table-wrap"><table>
        <thead><tr><th class="rank"></th><th>Player</th><th class="num">Record</th>
          <th class="num">Pts</th><th>Lock</th></tr></thead>
        <tbody>${rows
          .map((r, i) => {
            const lockGame = r.entry && slate.find((g) => g.id === r.entry.lock);
            const lockTeam = lockGame && r.entry.picks[lockGame.id];
            return `<tr class="${r.player.id === meId ? "me" : ""}">
              <td class="rank">${i + 1}</td>
              <td class="name"><span class="name-cell">${avatarHtml(r.player, "sm")}<span>${esc(
              r.player.name
            )}</span>${r.entry ? "" : ' <span class="pill">no entry</span>'}</span></td>
              <td class="num">${r.entry ? fmtRec(r.rec) : "—"}${
              r.entry && r.rec.pending
                ? `<span style="color:var(--ink-3)"> · ${r.rec.pending} left</span>`
                : ""
            }</td>
              <td class="num">${r.entry ? r.rec.pts.toFixed(1) : "—"}</td>
              <td>${
                lockTeam
                  ? `<span class="pill ${
                      r.rec.lockResult === "pending" ? "" : r.rec.lockResult
                    }">${esc(lockTeam)}</span>`
                  : "—"
              }</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div></div>`;

    const cards = slate
      .map((g) => gameCard(g, { editable: false, entry: null, showEveryone: true }))
      .join("");

    view.innerHTML = `
      ${leader}
      <section class="section">
        <div class="section-head"><h2>Week ${d.week} board</h2><span class="eyebrow">W-L-T · push = half</span></div>
        ${table}
      </section>
      ${kothBoard()}
      <section class="section">
        <div class="section-head"><h2>Games</h2><span class="eyebrow">${
          d.slate.linesFrozen ? "final lines" : "lines not locked yet"
        }</span></div>
        <div class="games">${cards}</div>
      </section>`;
    wireReveals();
  }

  function kothBoard() {
    const d = S.data;
    if (!d.koth) return "";
    const players = d.players.filter((p) => p.active && p.koth !== false);
    if (!players.length) return "";
    const alive = players.filter((p) => kothAliveFor(d.koth[p.id], d.week + 1));
    const sealed = Boolean(d.kothSealed);
    const meId = S.me && S.me.playerId;

    const rows = players
      .map((p) => {
        const info = d.koth[p.id] || { used: [], alive: true, eliminatedWeek: 0 };
        let thisWeek = info.used.find((u) => u.week === d.week);
        // My own pick is never hidden from me.
        if (sealed && p.id === meId && S.mine && S.mine.koth) {
          thisWeek = S.mine.koth.used.find((u) => u.week === d.week) || thisWeek;
        }
        const out = !kothAliveFor(info, d.week + 1);
        const submitted = Boolean(
          thisWeek || (d.picks[p.id] && (d.picks[p.id].kothIn || d.picks[p.id].koth))
        );
        return { p, info, thisWeek, out, submitted, res: thisWeek ? thisWeek.result : "none" };
      })
      .sort((a, b) => a.out - b.out || a.p.name.localeCompare(b.p.name));

    const code = (r) => {
      if (r.out) return "—";
      if (r.thisWeek && !r.thisWeek.hidden) return esc(r.thisWeek.team);
      if (r.submitted) return "🔒";
      return "—";
    };

    return `<section class="section">
      <div class="section-head"><div><p class="eyebrow">King of the Hill${
        sealed ? " · sealed" : ""
      }</p><h2>Still standing</h2></div>
        <span class="pill alive">${alive.length} alive</span></div>
      ${
        sealed
          ? `<div class="banner info">KOTH picks stay hidden until kickoff${
              d.kothRevealAt ? ` at ${esc(kickoffLabel(d.kothRevealAt))}` : ""
            }. You can see who's in, not what they took.</div>`
          : ""
      }
      <div class="panel">${rows
        .map(
          (r) => `<div class="crown-row">
            <span class="team-code" style="color:${
              r.out
                ? "var(--ink-3)"
                : r.res === "win"
                ? "var(--win)"
                : r.res === "loss"
                ? "var(--loss)"
                : "var(--ink)"
            }">${code(r)}</span>
            ${avatarHtml(r.p, "sm")}
            <span>${esc(r.p.name)}${
            r.info.entry > 1 ? ' <span class="pill">2nd</span>' : ""
          }${
            r.thisWeek && !r.thisWeek.hidden
              ? ` <span style="color:var(--ink-3)">${esc(r.thisWeek.opponent || "")}</span>`
              : ""
          }</span>
            <span class="trail">${
              r.out
                ? `<span class="loss">out wk ${r.info.eliminatedWeek}</span>`
                : sealed && !r.submitted
                ? `<span>no pick yet</span>`
                : r.info.used
                    .filter((u) => !u.hidden)
                    .slice(-6)
                    .map(
                      (u) =>
                        `<span class="${
                          u.result === "pending" || u.result === "live" ? "" : u.result
                        }">${esc(u.team)}</span>`
                    )
                    .join("")
            }</span>
          </div>`
        )
        .join("")}</div>
    </section>`;
  }

  /* ---------------------------- standings --------------------------- */

  async function ensureSeason() {
    if (S.season || S.seasonLoading) return;
    S.seasonLoading = true;
    try {
      const res = await api("/api/season");
      S.season = res.weeks;
      S.seasonKoth = res.koth || null;
    } catch (err) {
      toast(err.message, "bad");
    } finally {
      S.seasonLoading = false;
      S.teamRecords = null; // rebuilt on demand for whoever is signed in
      render();
    }
  }

  function renderStandings() {
    const d = S.data;
    if (!S.season) {
      ensureSeason();
      view.innerHTML = `<p class="skel">Adding up the season…</p>`;
      return;
    }

    const players = d.players.filter((p) => p.active);
    const totals = new Map(
      players.map((p) => [p.id, { w: 0, l: 0, t: 0, weeks: 0, lockW: 0, lockL: 0, played: 0 }])
    );
    const weekRows = [];

    for (const wk of S.season) {
      const slate = wk.games.filter((g) => wk.gameIds.includes(g.id));
      if (!slate.length || !slate.some((g) => g.state !== "pre")) continue;
      const rows = rankPlayers(players, wk.picks, slate);
      const winners = weekWinners(rows);
      const done = slate.every((g) => g.state === "final");
      weekRows.push({ week: wk.week, winners, rows, done });

      for (const r of rows) {
        if (!r.entry) continue;
        const t = totals.get(r.player.id);
        t.w += r.rec.w;
        t.l += r.rec.l;
        t.t += r.rec.t;
        t.played++;
        if (r.rec.lockResult === "win") t.lockW++;
        if (r.rec.lockResult === "loss") t.lockL++;
        // Co-winners split the week, so a shared week is worth half each.
        if (done && winners.some((x) => x.player.id === r.player.id))
          t.weeks += 1 / winners.length;
      }
    }

    const standing = players
      .map((p) => ({ p, t: totals.get(p.id) }))
      .sort(
        (a, b) =>
          b.t.w + b.t.t * 0.5 - (a.t.w + a.t.t * 0.5) ||
          b.t.weeks - a.t.weeks ||
          a.p.name.localeCompare(b.p.name)
      );

    const league = standing.reduce(
      (acc, s) => ({ w: acc.w + s.t.w, l: acc.l + s.t.l, t: acc.t + s.t.t }),
      { w: 0, l: 0, t: 0 }
    );
    const totalPicks = league.w + league.l + league.t;
    const meId = S.me && S.me.playerId;

    const koth = S.seasonKoth || d.koth || {};
    const fmtWins = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));

    const seasonTable = `
      <div class="panel"><div class="table-wrap"><table>
        <thead><tr><th class="rank"></th><th>Player</th><th class="num">Record</th>
          <th class="num">Pct</th><th class="num">Wins</th><th class="num">Locks</th><th>KOTH</th></tr></thead>
        <tbody>${standing
          .map((s, i) => {
            const k = koth[s.p.id];
            const out = k && k.eliminatedWeek;
            return `<tr class="${s.p.id === meId ? "me" : ""}">
            <td class="rank">${i + 1}</td>
            <td class="name"><span class="name-cell">${avatarHtml(s.p, "sm")}<span>${esc(
              s.p.name
            )}</span></span></td>
            <td class="num">${s.t.w}-${s.t.l}${s.t.t ? `-${s.t.t}` : ""}</td>
            <td class="num">${pct(s.t.w, s.t.l, s.t.t)}</td>
            <td class="num">${fmtWins(s.t.weeks)}</td>
            <td class="num">${s.t.lockW}-${s.t.lockL}</td>
            <td>${
              k && k.excluded
                ? `<span class="pill">not in</span>`
                : out
                ? `<span class="pill out">Out W${k.eliminatedWeek}${
                    k.entriesUsed > 1 ? " · 2nd" : ""
                  }</span>`
                : `<span class="pill alive">Alive${
                    k && k.entry > 1 ? " · 2nd" : ""
                  }</span>`
            }</td></tr>`;
          })
          .join("")}</tbody></table></div></div>
        <p class="note"><strong>Wins</strong> is weeks won. Tie the week and match on Lock of the Week and the week is split evenly — two share it and it's half a win each, four share it and it's a quarter.</p>`;

    const winnersList = weekRows.length
      ? `<div class="panel"><div class="table-wrap"><table>
          <thead><tr><th>Week</th><th>Winner</th><th class="num">Record</th><th>Lock</th></tr></thead>
          <tbody>${weekRows
            .slice()
            .reverse()
            .map((w) => {
              const win = w.winners[0];
              const lockGame =
                win && w.rows.length
                  ? (S.season.find((x) => x.week === w.week).games || []).find(
                      (g) => g.id === win.entry.lock
                    )
                  : null;
              return `<tr>
                <td class="name">Week ${w.week}${w.done ? "" : ' <span class="pill live">in progress</span>'}</td>
                <td>${
                  !w.winners.length
                    ? "—"
                    : w.winners.length <= 2
                    ? w.winners.map((x) => esc(x.player.name)).join(" & ")
                    : `${esc(w.winners[0].player.name)} +${w.winners.length - 1}`
                }</td>
                <td class="num">${win ? fmtRec(win.rec) : "—"}</td>
                <td>${
                  lockGame && win.entry.picks[lockGame.id]
                    ? `<span class="pill ${win.rec.lockResult === "pending" ? "" : win.rec.lockResult}">${esc(
                        win.entry.picks[lockGame.id]
                      )}</span>`
                    : "—"
                }</td></tr>`;
            })
            .join("")}</tbody></table></div></div>`
      : `<div class="banner info">No completed weeks yet — this fills in as the season goes.</div>`;

    view.innerHTML = `
      <section class="section">
        <div class="section-head"><div><p class="eyebrow">Season ${d.season}</p><h2>Season standings</h2></div></div>
        ${seasonTable}
      </section>
      <section class="section">
        <div class="section-head"><h2>Weekly winners</h2></div>
        ${winnersList}
      </section>
      <section class="section">
        <div class="section-head"><h2>The league vs. the spread</h2></div>
        <dl class="stat-row" style="margin:0">
          <div class="stat"><dt>Record</dt><dd class="num" style="font-size:19px">${league.w}-${league.l}${
      league.t ? `-${league.t}` : ""
    }</dd></div>
          <div class="stat"><dt>Win %</dt><dd class="num">${pct(league.w, league.l, league.t)}</dd></div>
          <div class="stat"><dt>Picks</dt><dd class="num">${totalPicks}</dd></div>
        </dl>
        <p class="note">Every pick anyone has made this season, against the closing line. Beating .500 as a group is harder than it looks.</p>
      </section>
      ${earnedStatus(standing, koth)}`;
  }

  /* --------------------------- earned status ------------------------ */
  /* Money in, money back. Everyone is down the pool buy-in; KOTH players are
     down a second one, and a buyback is a third. A week won pays 280, and a
     week split pays that share of it. */

  const POOL_BUYIN = 410;
  const KOTH_BUYIN = 50;
  const WEEK_WIN = 280;

  function earnedStatus(standing, koth) {
    const rows = standing
      .map((s) => {
        const k = koth[s.p.id];
        const inKoth = !(k && k.excluded);
        const buybacks = Math.max(0, (k && k.entriesUsed ? k.entriesUsed : 1) - 1);
        const base = -POOL_BUYIN - (inKoth ? KOTH_BUYIN : 0) - buybacks * KOTH_BUYIN;
        const won = Math.round(s.t.weeks * WEEK_WIN);
        return { p: s.p, base, won, weeks: s.t.weeks, buybacks, inKoth, total: base + won };
      })
      .sort((a, b) => b.total - a.total || a.p.name.localeCompare(b.p.name));

    if (!rows.length) return "";

    // Pad the domain so the longest bar doesn't run to the very edge.
    const lo = Math.min(0, ...rows.map((r) => r.total)) * 1.08;
    const hi = Math.max(0, ...rows.map((r) => r.total)) * 1.08;
    const span = hi - lo || 1;
    const pos = (v) => ((v - lo) / span) * 100;
    // Keep the zero rule inside the track so it stays visible when every
    // total is on one side of it.
    const zero = Math.min(99.5, Math.max(0.5, pos(0)));

    const bar = (r) => {
      const v = pos(r.total);
      const neg = r.total < 0;
      const left = neg ? v : zero;
      const width = Math.max(0.6, neg ? zero - v : v - zero);
      return `<span class="bar ${neg ? "neg" : "pos"}" style="left:${left}%;width:${width}%"></span>`;
    };

    return `<section class="section">
      <div class="section-head"><div><p class="eyebrow">Money</p><h2>Earned status</h2></div>
        <span class="eyebrow">buy-in to date</span></div>
      <div class="panel">
        <div class="chart" role="img" aria-label="Earned status by player">
          ${rows
            .map(
              (r) => `<div class="chart-row">
                <span class="chart-name">${avatarHtml(r.p, "sm")}<span>${esc(r.p.name)}</span></span>
                <span class="track"><span class="zero" style="left:${zero}%"></span>${bar(r)}</span>
                <span class="chart-val num ${r.total < 0 ? "neg" : "pos"}">${
                r.total > 0 ? "+" : ""
              }${r.total}</span>
              </div>`
            )
            .join("")}
        </div>
        <div class="table-wrap"><table class="mini">
          <thead><tr><th>Player</th><th class="num">Buy-in</th>
            <th class="num">Won</th><th class="num">Net</th></tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr><td class="name">${esc(r.p.name)}${
                r.buybacks ? ' <span class="pill">buyback</span>' : ""
              }${r.inKoth ? "" : ' <span class="pill">no KOTH</span>'}</td>
              <td class="num">${r.base}</td>
              <td class="num">${r.won ? `+${r.won}` : "0"}</td>
              <td class="num ${r.total < 0 ? "neg" : "pos"}">${r.total > 0 ? "+" : ""}${r.total}</td></tr>`
            )
            .join("")}</tbody>
        </table></div>
      </div>
      <p class="note">Everyone is out ${POOL_BUYIN} for the pool, plus ${KOTH_BUYIN} for a KOTH entry and another ${KOTH_BUYIN} for a buyback. A week won pays ${WEEK_WIN}; a split week pays that share.</p>
      <p class="note"><strong>Not counted yet:</strong> +700 to whoever wins the season-long win-loss, and at least +650 to the King of the Hill winner. Both land once there's a winner to give them to.</p>
    </section>`;
  }

  /* ------------------------------ admin ----------------------------- */

  function renderAdmin() {
    const d = S.data;
    if (!S.adminPin) {
      view.innerHTML = `
        <section class="section">
          <div class="section-head"><div><p class="eyebrow">Commissioner</p><h2>Enter your PIN</h2></div></div>
          <div class="panel panel-pad" style="display:flex;flex-direction:column;gap:12px">
            <div class="field"><label for="apin">Commissioner PIN</label>
              <input id="apin" type="tel" inputmode="numeric" maxlength="8" placeholder="••••"></div>
            <button class="btn" id="agO">Unlock</button>
          </div>
        </section>`;
      $("#agO").onclick = async () => {
        const pin = $("#apin").value.trim();
        try {
          await api("/api/admin", { adminPin: pin, action: "verify" });
          S.adminPin = pin;
          render();
        } catch (err) {
          toast(err.message, "bad");
        }
      };
      return;
    }

    const selected = new Set(d.slate.gameIds);
    const byDay = {};
    for (const g of d.games) (byDay[dayLabel(g.kickoff)] ||= []).push(g);

    const slateRows = Object.entries(byDay)
      .map(
        ([day, games]) => `
        <p class="eyebrow" style="padding:10px 12px 2px">${esc(day)}</p>
        ${games
          .map(
            (g) => `<label class="slate-row">
              <input type="checkbox" data-slate="${g.id}" ${selected.has(g.id) ? "checked" : ""}>
              <span class="grow"><span class="who-plays">${g.away} @ ${g.home}</span>
                <br><span class="when">${esc(kickoffLabel(g.kickoff))}${
              g.channel ? ` · ${esc(g.channel)}` : ""
            } · ${esc(favoriteLabel(g))}</span></span>
            </label>`
          )
          .join("")}`
      )
      .join("");

    const playersRows = d.players
      .map(
        (p) => `<div class="player-row">
          ${avatarHtml(p)}
          <input type="text" class="grow" data-pname="${p.id}" value="${esc(p.name)}" maxlength="32">
          <span class="pill">${p.hasPin ? "PIN set" : "no PIN yet"}</span>
          <button class="btn ghost" data-photo="${p.id}" style="padding:6px 10px">${
          p.avatar ? "Photo ✓" : "Photo"
        }</button>
          <button class="btn ghost" data-kothin="${p.id}" data-on="${p.koth !== false}"
            style="padding:6px 10px">KOTH ${p.koth === false ? "off" : "on"}</button>
          <button class="btn ghost" data-resetpin="${p.id}" style="padding:6px 10px">Reset PIN</button>
          <button class="btn danger" data-drop="${p.id}" style="padding:6px 10px">Remove</button>
        </div>`
      )
      .join("");

    view.innerHTML = `
      <section class="section">
        <div class="section-head"><div><p class="eyebrow">Commissioner</p><h2>Week ${d.week} slate</h2></div>
          <span class="eyebrow">${selected.size} selected</span></div>
        <div class="banner info">Tick the games everyone picks. Thursday nighters are usually left off — the whole week locks at the earliest kickoff you include. ${esc(
          linesNote(d)
        )}</div>
        <div class="panel">${slateRows || '<p class="panel-pad note">No games found for this week yet.</p>'}</div>
        <div class="row">
          <button class="btn" id="pubSlate">${d.slate.published ? "Update slate" : "Post this week"}</button>
          <button class="btn ghost" id="selSunday">Select Sat / Sun / Mon only</button>
          <button class="btn ghost" id="selNone">Clear</button>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Week controls</h2></div>
        <div class="panel panel-pad" style="display:flex;flex-direction:column;gap:12px">
          <div class="row">
            <span class="grow note">Everyone's current week when they open the app.</span>
            <button class="btn ghost" id="setCur">Make Week ${d.week} the current week</button>
          </div>
          <hr class="rule">
          <div class="row">
            <span class="grow note">${
              d.slate.reopened
                ? "Picks are force-opened right now — anyone can still edit."
                : d.locked
                ? "Picks are locked (kickoff has passed)."
                : "Picks are open until first kickoff."
            }</span>
            <button class="btn ghost" id="toggleOpen">${
              d.slate.reopened ? "Re-lock the week" : "Reopen picks"
            }</button>
          </div>
          <hr class="rule">
          <div class="row">
            <span class="grow note">${
              d.slate.linesFrozen
                ? "Lines are locked for this week."
                : `Lines track the book until ${esc(
                    d.linesLockAt ? kickoffLabel(d.linesLockAt) : "the deadline"
                  )}, then lock themselves.`
            }${
      (d.slate.missingLines || []).length
        ? ` <strong style="color:var(--push)">${d.slate.missingLines.length} game${
            d.slate.missingLines.length > 1 ? "s have" : " has"
          } no line from the book yet.</strong>`
        : ""
    }</span>
            ${
              d.slate.linesFrozen
                ? ""
                : `<button class="btn ghost" id="freezeLines">Lock lines now</button>`
            }
          </div>
          <hr class="rule">
          <div class="row">
            <span class="grow note">Enter or fix someone's picks for Week ${d.week}.</span>
            <button class="btn ghost" id="pickFor">Pick for a player</button>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Players</h2><span class="eyebrow">${
          d.players.length
        } in the pool</span></div>
        <div class="panel">${playersRows}
          <div class="player-row"><input type="text" id="newPlayer" class="grow" placeholder="Add a player…" maxlength="32">
            <button class="btn" id="addPlayer">Add</button></div>
        </div>
        <button class="btn ghost" id="savePlayers">Save player list</button>
        <p class="note">Removing a player keeps their past picks out of the standings. Reset a PIN if someone forgets theirs — they'll set a new one next time they sign in.</p>
      </section>`;

    wireAdmin();
  }

  function wireAdmin() {
    const d = S.data;
    const checked = () =>
      Array.from(view.querySelectorAll("[data-slate]:checked")).map((c) => c.dataset.slate);

    $("#selSunday").onclick = () => {
      view.querySelectorAll("[data-slate]").forEach((c) => {
        const g = d.games.find((x) => x.id === c.dataset.slate);
        const day = new Date(g.kickoff).getDay(); // 0 Sun … 6 Sat
        c.checked = day === 0 || day === 1 || day === 6;
      });
    };
    $("#selNone").onclick = () =>
      view.querySelectorAll("[data-slate]").forEach((c) => (c.checked = false));

    $("#pubSlate").onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api("/api/admin", {
          adminPin: S.adminPin,
          action: "publishSlate",
          week: d.week,
          gameIds: checked(),
        });
        toast("Slate posted.", "info");
        S.season = null;
        await load(S.week);
      } catch (err) {
        toast(err.message, "bad");
        e.target.disabled = false;
      }
    };

    $("#setCur").onclick = async () => {
      try {
        await api("/api/admin", { adminPin: S.adminPin, action: "setCurrentWeek", week: d.week });
        toast(`Week ${d.week} is now the default.`, "info");
        await load(S.week);
      } catch (err) {
        toast(err.message, "bad");
      }
    };

    $("#toggleOpen").onclick = async () => {
      try {
        await api("/api/admin", {
          adminPin: S.adminPin,
          action: "setReopened",
          week: d.week,
          reopened: !d.slate.reopened,
        });
        await load(S.week);
      } catch (err) {
        toast(err.message, "bad");
      }
    };

    const freeze = $("#freezeLines");
    if (freeze)
      freeze.onclick = async () => {
        freeze.disabled = true;
        try {
          const r = await api("/api/admin", {
            adminPin: S.adminPin,
            action: "freezeLines",
            week: d.week,
          });
          toast(`Lines locked — ${r.frozen} of ${r.of} games.`, "info");
          await load(S.week);
        } catch (err) {
          toast(err.message, "bad");
          freeze.disabled = false;
        }
      };

    $("#pickFor").onclick = () => openPickForModal();

    $("#addPlayer").onclick = () => {
      const name = $("#newPlayer").value.trim();
      if (!name) return;
      const rows = collectPlayers();
      rows.push({ id: "", name, active: true });
      savePlayers(rows);
    };

    view.querySelectorAll("[data-photo]").forEach((b) => {
      b.onclick = () => changePhoto(b.dataset.photo, { adminPin: S.adminPin });
    });

    view.querySelectorAll("[data-kothin]").forEach((b) => {
      b.onclick = async () => {
        try {
          await api("/api/admin", {
            adminPin: S.adminPin,
            action: "setKothIn",
            playerId: b.dataset.kothin,
            inKoth: b.dataset.on !== "true",
          });
          S.season = null;
          await load(S.week);
        } catch (err) {
          toast(err.message, "bad");
        }
      };
    });

    view.querySelectorAll("[data-drop]").forEach((b) => {
      b.onclick = () => savePlayers(collectPlayers().filter((p) => p.id !== b.dataset.drop));
    });

    view.querySelectorAll("[data-resetpin]").forEach((b) => {
      b.onclick = async () => {
        try {
          await api("/api/admin", {
            adminPin: S.adminPin,
            action: "resetPin",
            playerId: b.dataset.resetpin,
          });
          toast("PIN cleared — they'll set a new one at sign-in.", "info");
          await load(S.week);
        } catch (err) {
          toast(err.message, "bad");
        }
      };
    });

    $("#savePlayers").onclick = () => savePlayers(collectPlayers());
  }

  const collectPlayers = () =>
    Array.from(view.querySelectorAll("[data-pname]")).map((i) => ({
      id: i.dataset.pname,
      name: i.value,
      active: true,
    }));

  async function savePlayers(players) {
    try {
      await api("/api/admin", { adminPin: S.adminPin, action: "savePlayers", players });
      toast("Players saved.", "info");
      await load(S.week);
    } catch (err) {
      toast(err.message, "bad");
    }
  }

  /* ------------------------------ modals ---------------------------- */

  function closeModal() {
    $("#modalHost").innerHTML = "";
  }

  function modal(html) {
    $("#modalHost").innerHTML = `<div class="modal-back" id="mback"><div class="modal">${html}</div></div>`;
    $("#mback").onclick = (e) => {
      if (e.target.id === "mback") closeModal();
    };
  }

  function openSignIn() {
    const d = S.data;
    if (!d || !d.league.configured) return;
    const me = S.me && d.players.find((p) => p.id === S.me.playerId);

    const photoBlock = me
      ? `<div class="photo-row">
           ${avatarHtml(me, "lg")}
           <div class="grow">
             <strong class="display" style="font-size:22px">${esc(me.name)}</strong>
             <div class="row" style="margin-top:6px">
               <button class="btn ghost" id="photoPick" style="padding:7px 12px">${
                 me.avatar ? "Change photo" : "Add a photo"
               }</button>
               ${
                 me.avatar
                   ? `<button class="btn danger" id="photoDrop" style="padding:7px 12px">Remove</button>`
                   : ""
               }
             </div>
           </div>
         </div>
         <p class="note">Your photo shows up next to your name on the board. It's resized on your phone before it uploads, so a full-size camera roll picture is fine.</p>
         <hr class="rule">`
      : "";

    modal(`
      ${photoBlock}
      <h2>${me ? "Switch player" : "Who are you?"}</h2>
      <div class="chooser">${d.players
        .filter((p) => p.active)
        .map(
          (p) =>
            `<button data-pick-player="${p.id}">${avatarHtml(p, "sm")}${esc(p.name)} ${
              p.hasPin ? "" : '<span class="pill">first time</span>'
            }</button>`
        )
        .join("")}</div>
      ${
        S.me
          ? `<button class="btn ghost" id="signOut">Sign out</button>`
          : `<p class="note">Your PIN just keeps other people from changing your picks.</p>`
      }`);

    $("#modalHost")
      .querySelectorAll("[data-pick-player]")
      .forEach((b) => (b.onclick = () => askPin(b.dataset.pickPlayer)));

    const pick = $("#photoPick");
    if (pick) pick.onclick = () => changePhoto(me.id);
    const drop = $("#photoDrop");
    if (drop) drop.onclick = () => removePhoto(me.id);

    const out = $("#signOut");
    if (out)
      out.onclick = () => {
        S.me = null;
        localStorage.removeItem("pickem.me");
        closeModal();
        resetDraft();
        render();
      };
  }

  function askPin(playerId) {
    const p = S.data.players.find((x) => x.id === playerId);
    modal(`
      <h2>${esc(p.name)}</h2>
      <p class="note">${
        p.hasPin ? "Enter your PIN." : "Pick a 4-digit PIN. You'll use it every week."
      }</p>
      <div class="field"><label for="ppin">PIN</label>
        <input id="ppin" type="tel" inputmode="numeric" maxlength="8" placeholder="••••" autofocus></div>
      <button class="btn wide" id="pgo">${p.hasPin ? "Sign in" : "Set my PIN"}</button>`);

    const go = async () => {
      const pin = $("#ppin").value.trim();
      try {
        await api("/api/login", { playerId, pin });
        S.me = { playerId, pin };
        localStorage.setItem("pickem.me", JSON.stringify(S.me));
        closeModal();
        await load(S.week);
      } catch (err) {
        toast(err.message, "bad");
      }
    };
    $("#pgo").onclick = go;
    $("#ppin").onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  }

  function openPickForModal() {
    const d = S.data;
    modal(`
      <h2>Pick for a player</h2>
      <p class="note">Week ${d.week}. This overrides whatever they have in, and works even after lock.</p>
      <div class="chooser">${d.players
        .filter((p) => p.active)
        .map(
          (p) =>
            `<button data-admin-pick="${p.id}">${esc(p.name)} <span class="pill">${
              d.picks[p.id] ? "entry in" : "no entry"
            }</span></button>`
        )
        .join("")}</div>`);

    $("#modalHost")
      .querySelectorAll("[data-admin-pick]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            closeModal();
            adminPickSheet(b.dataset.adminPick);
          })
      );
  }

  function adminPickSheet(playerId) {
    const d = S.data;
    const p = d.players.find((x) => x.id === playerId);
    const slate = slateOf(d);
    const existing = d.picks[playerId];
    const draft = {
      picks: existing ? { ...existing.picks } : {},
      lock: existing ? existing.lock : "",
      koth: existing ? existing.koth || "" : "",
    };
    const info = (d.koth && d.koth[playerId]) || { used: [], alive: true, eliminatedWeek: 0 };
    const buyback = Boolean(info.buybackWeek === d.week && !info.alive);
    const requireKoth = !info.excluded && kothAliveFor(info, d.week);
    const needsKoth = requireKoth || buyback;
    const spent = new Set(
      info.used.filter((u) => u.week !== d.week && u.team).map((u) => u.team)
    );

    const paint = () => {
      const done = slate.filter((g) => draft.picks[g.id]).length;
      const kothPicker = needsKoth
        ? `<div class="field"><label for="akoth">King of the Hill${
            buyback ? " — buyback (2nd entry)" : ""
          }</label>
             <select id="akoth">
               <option value="">— pick a team —</option>
               ${teamsPlaying(d.games)
                 .filter((t) => !spent.has(t.team))
                 .map(
                   (t) =>
                     `<option value="${t.team}" ${draft.koth === t.team ? "selected" : ""}>${
                       t.team
                     } ${esc(t.note)}</option>`
                 )
                 .join("")}
             </select></div>`
        : `<p class="note">Out of KOTH since Week ${info.eliminatedWeek} — no KOTH pick needed.</p>`;
      modal(`
        <h2>${esc(p.name)} · Week ${d.week}</h2>
        <div class="chooser" style="max-height:52vh">
          ${slate
            .map(
              (g) => `<div style="display:flex;gap:6px;align-items:center">
                <button data-ap="${g.id}" data-team="${g.away}" style="flex:1;${
                draft.picks[g.id] === g.away ? "border-color:var(--accent);background:var(--accent-soft)" : ""
              }">${g.away} ${esc(lineFor(g, g.away))}</button>
                <button data-ap="${g.id}" data-team="${g.home}" style="flex:1;${
                draft.picks[g.id] === g.home ? "border-color:var(--accent);background:var(--accent-soft)" : ""
              }">${g.home} ${esc(lineFor(g, g.home))}</button>
                <button data-al="${g.id}" title="Lock of the week" style="flex:none;padding:10px 12px;${
                draft.lock === g.id ? "border-color:var(--accent);background:var(--accent-soft)" : ""
              }">🔒</button>
              </div>`
            )
            .join("")}
        </div>
        ${kothPicker}
        <div class="row"><span class="grow note">${done}/${slate.length} picked${
        draft.lock ? " · lock set" : ""
      }</span>
          <button class="btn" id="apSave" ${
            done === slate.length && draft.lock && (!requireKoth || draft.koth) ? "" : "disabled"
          }>Save</button></div>
        ${existing ? `<button class="btn danger" id="apClear">Delete this entry</button>` : ""}`);

      $("#modalHost")
        .querySelectorAll("[data-ap]")
        .forEach(
          (b) =>
            (b.onclick = () => {
              draft.picks[b.dataset.ap] = b.dataset.team;
              paint();
            })
        );
      $("#modalHost")
        .querySelectorAll("[data-al]")
        .forEach(
          (b) =>
            (b.onclick = () => {
              draft.lock = draft.lock === b.dataset.al ? "" : b.dataset.al;
              paint();
            })
        );
      const kothSel = $("#akoth");
      if (kothSel)
        kothSel.onchange = (e) => {
          draft.koth = e.target.value;
          paint();
        };
      $("#apSave").onclick = async () => {
        try {
          await api("/api/admin", {
            adminPin: S.adminPin,
            action: "setPicksFor",
            week: d.week,
            playerId,
            picks: draft.picks,
            lock: draft.lock,
            koth: draft.koth,
          });
          closeModal();
          toast(`${p.name}'s picks saved.`, "info");
          S.season = null;
          await load(S.week);
        } catch (err) {
          toast(err.message, "bad");
        }
      };
      const clear = $("#apClear");
      if (clear)
        clear.onclick = async () => {
          try {
            await api("/api/admin", {
              adminPin: S.adminPin,
              action: "clearPicksFor",
              week: d.week,
              playerId,
            });
            closeModal();
            S.season = null;
            await load(S.week);
          } catch (err) {
            toast(err.message, "bad");
          }
        };
    };
    paint();
  }

  /* ------------------------------- boot ----------------------------- */

  function syncTabs() {
    document.querySelectorAll(".tab").forEach((t) => {
      t.setAttribute("aria-selected", String(t.dataset.tab === S.tab));
    });
  }

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      if (S.dirty && S.tab === "picks" && !confirm("You have unsaved picks. Leave this tab?")) return;
      S.tab = t.dataset.tab;
      syncTabs();
      render();
    };
  });

  $("#whoBtn").onclick = openSignIn;
  $("#refreshBtn").onclick = () => {
    S.season = null;
    load(S.week);
  };
  $("#themeBtn").onclick = () => {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    if (light) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "light");
    try {
      localStorage.setItem("pickem.theme", light ? "" : "light");
    } catch {}
  };

  try {
    const saved = localStorage.getItem("pickem.theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    const me = localStorage.getItem("pickem.me");
    if (me) S.me = JSON.parse(me);
  } catch {}

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) load(S.week, { quiet: true });
  });

  syncTabs();
  load();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
})();
