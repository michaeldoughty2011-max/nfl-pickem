# Pickem

A phone-first pool for a group of friends: pick every game on the
commissioner's slate against the spread, flag one Lock of the Week, take one
King of the Hill team that has to win straight up, and watch the board turn
green, yellow and red while the games are on.

## How it works

- **Static front end** in `public/` — no framework, no build step.
- **One serverless function** in `netlify/functions/api.mjs` handles every
  request under `/api/*`.
- **Netlify Blobs** stores the league: players, each week's slate, and one
  document per player per week for their picks.
- **Live lines and scores** come from Sleeper's public NFL feed, fetched
  server-side and cached for 20 seconds while games are in progress
  (5 minutes when nothing is playing).

## Scoring

A pick wins if that team covers the spread posted when the slate was set:

```
adjusted = homeScore + homeSpread - awayScore
adjusted > 0  -> home covered
adjusted < 0  -> away covered
adjusted == 0 -> push (counts as a tie, worth half)
```

The line used is the one that stood at **Wednesday 5:00 PM Eastern** before
that week's first kickoff (`linesLockAt` / `syncLines`), never the live line.
Before the deadline the slate's lines track the feed on every request; at the
deadline the held snapshot is frozen and later feed movement is ignored. A
game whose line hasn't been posted yet keeps syncing until it appears, so the
week never freezes with a missing number. Eastern is computed through
`Intl.DateTimeFormat`, so DST is handled without a date library.

Weekly points are `wins + 0.5 x pushes`. If two players tie for the week, the
Lock of the Week breaks it: a won lock beats a push, a push beats a lock still
on the board, and any of those beats a lock that lost. Still tied after that
and they split the week — each co-winner gets `1 / n` of it in the season
standings.

**King of the Hill** is a survivor side game: one team a week, straight up, no
spread, never the same team twice. A loss ends that player's KOTH season; an
outright tie survives but burns the team; missing a completed week ends it.
`computeKoth` derives all of it from the stored picks and final scores, so it
self-corrects if a result changes.

## Endpoints

| Route | Method | What it does |
| --- | --- | --- |
| `/api/state?week=N` | GET | Everything the app renders for one week |
| `/api/season` | GET | Compact per-week results for the standings |
| `/api/setup` | POST | One-time league creation |
| `/api/login` | POST | Player PIN check (sets the PIN on first use) |
| `/api/picks` | POST | Submit or update a player's picks |
| `/api/admin` | POST | Commissioner actions, all PIN-gated |

## Local development

`devtest/` runs the whole thing without Netlify: it swaps in an in-memory
blob store and a fixture week, so scoring can be checked against known inputs.

```
node devtest/server.mjs     # http://localhost:8787
node devtest/drive.mjs      # end-to-end API exercise + scoring audit
```
