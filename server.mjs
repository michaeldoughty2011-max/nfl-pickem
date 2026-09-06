/* Local dev server: serves public/ and routes /api/* into the Netlify
   function, with the Sleeper feed replaced by a fixture. Testing only. */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { weeks } from "./fixture.mjs";

/* Week 3 is driven by the test at runtime so the Wednesday 5pm deadline can
   be crossed mid-run. POST /__test/week3 replaces it. */
let week3 = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api.sleeper.app")) {
    const week = Number(u.split("/").pop());
    const body = week === 3 ? week3 : weeks[week] || [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, opts);
};

const testGame = (kickoff, spreadHome) => ({
  game_id: "20260300001",
  start_time: kickoff,
  week: 3,
  season: "2026",
  season_type: "regular",
  sport: "nfl",
  status: "pre_game",
  metadata: {
    away_team: "GB", home_team: "CHI",
    date_time: new Date(kickoff).toISOString(),
    channel: "FOX", stadium_details: { city: "Chicago" },
    pickem_spread: { CHI: spreadHome, GB: -spreadHome },
    spread: { CHI: spreadHome, GB: -spreadHome },
    has_started: false, is_in_progress: false, is_over: false, closed: false,
    status: "scheduled", quarter: "", quarter_num: "", time_remaining: "",
    is_overtime: false, canceled: false, possession: "", red_zone: false,
    home_score: 0, away_score: 0,
    home_score_quarter1: 0, home_score_quarter2: 0, home_score_quarter3: 0,
    home_score_quarter4: 0, home_score_overtime: 0,
    away_score_quarter1: 0, away_score_quarter2: 0, away_score_quarter3: 0,
    away_score_quarter4: 0, away_score_overtime: 0,
  },
});

const { default: handler } = await import("../netlify/functions/api.mjs");

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:8787");

  if (url.pathname === "/__test/week3" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const { kickoff, spread } = JSON.parse(Buffer.concat(chunks).toString());
    week3 = [testGame(kickoff, spread)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://localhost:8787${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const out = await handler(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", file));
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(8787, () => console.log("dev server on http://localhost:8787"));
