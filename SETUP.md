# Getting the Pick'em app live

Roughly 15 minutes, one time. You need a free GitHub account and your existing
Netlify account. Nothing to install, no credit card, no API keys.

---

## Step 1 — Put the code on GitHub (5 min)

1. Go to **github.com** and sign in (or create a free account).
2. Click the **+** in the top right, then **New repository**.
3. Name it `nfl-pickem`. Leave it **Private** if you like — Netlify can still
   read it. Do **not** tick "Add a README file".
4. Click **Create repository**.
5. On the next page, click the link **uploading an existing file**.
6. Unzip `nfl-pickem.zip` on your computer. Open the folder, select
   **everything inside it** (not the folder itself) and drag it onto the
   GitHub upload box.
   - Make sure you see `netlify.toml`, `package.json`, the `public` folder and
     the `netlify` folder in the list.
7. Click **Commit changes**.

---

## Step 2 — Point Netlify at it (4 min)

1. Go to **app.netlify.com** and sign in.
2. Click **Add new site** → **Import an existing project**.
3. Choose **GitHub**, authorise it if asked, and pick your `nfl-pickem` repo.
4. Netlify will read the settings from the repo. You should see:
   - Build command: `echo 'no build step'`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`

   Leave all of it alone.
5. Click **Deploy**. Wait for "Published" — usually under a minute.

### Give it a nicer address

**Site configuration** → **Change site name** → type something like
`sunday-money-pickem`. Your app now lives at
`https://sunday-money-pickem.netlify.app`. This is the link you send your
friends, and it's separate from your SMFF site.

---

## Step 3 — Create the league (2 min)

1. Open your new link. You'll get a **Start the league** screen — this appears
   only once.
2. Fill in:
   - **Commissioner PIN** — 4 to 8 digits, only you know it. Write it down.
     There's no reset.
   - **Players** — one name per line, all 10-12 of you including yourself.
3. Click **Create the league**.

---

## Step 4 — Post Week 1 (2 min)

1. You land on the **Commish** tab. Every game that week is listed with its
   kickoff time, network and current line.
2. Click **Select Sat / Sun / Mon only** — that drops the Thursday nighter in
   one click. Then tick or untick anything else (holiday games, a Friday game,
   whatever you want in).
3. Click **Post this week**.
4. Click **Make Week 1 the current week** so everyone lands there by default.

That's it — the pool is open.

---

## Step 5 — Send it to your friends

Text them the link with something like:

> Pickem is up: https://sunday-money-pickem.netlify.app
> Open it, tap **Sign in**, pick your name, and make up a 4-digit PIN.
> Then add it to your home screen so it works like an app.
>
> Every week: pick every game against the spread, flag one **Lock of the
> Week**, and take one **KOTH** team that just has to win straight up.
> One KOTH loss and you're out for the season, and you can't reuse a team.

**iPhone:** open the link in Safari → Share button → **Add to Home Screen**.
**Android:** open in Chrome → three-dot menu → **Add to Home screen**.

It gets a football icon and opens full-screen with no browser bars.

---

## Your weekly routine

| When | What you do |
| --- | --- |
| Tuesday, or Wednesday before 5pm | Commish tab → change the week at the bottom of the screen → tick the games → **Post this week** → **Make Week N the current week** |
| Wednesday 5:00 PM ET | Nothing. The week's lines lock themselves |
| Sunday ~1pm | Nothing. Picks lock automatically at the first kickoff on your slate |
| During games | Nothing. Scores refresh on their own every 30 seconds while games are live |

Everything else runs itself. Weekly winners and season standings build up as
the weeks finish.

---

## The rules the app enforces

**Against the spread.** A pick wins if that team covers the line. Exactly on
the number is a push — a tie, worth half a game.

**The line is frozen Wednesday at 5:00 PM Eastern.** Until then the slate's
lines track the sportsbook. At 5pm Wednesday whatever number is showing
becomes that week's official line, and nothing after it — a key injury, a
Sunday-morning move — can change what anyone is graded against.

Post your slate before Wednesday afternoon so the group has the real numbers
to work with. If you post it after 5pm Wednesday, the app takes the line as
it stands at that moment and locks it immediately.

**Lock of the Week** breaks weekly ties. Won lock beats a push, a push beats
a lock still playing, and any of those beats a lock that lost. Still tied
after that and the players split the week — two share it and it's half a win
each in the season standings.

**King of the Hill** is survivor. One team a week, straight up, no spread.
One loss and your KOTH season is over. You can't use the same team twice, and
the app won't let you — used teams show greyed out. Miss a week entirely and
you're out too. An outright tie keeps you alive but burns the team.

## Things you might need

**Someone missed the deadline / picked wrong.**
Commish tab → **Pick for a player**. Works even after lock.

**Someone needs a do-over before kickoff.**
Commish tab → **Reopen picks** unlocks the whole week. Click it again to re-lock.

**Someone forgot their PIN.**
Commish tab → **Reset PIN** next to their name. They set a new one next time
they sign in.

**A new guy joins / someone drops.**
Commish tab → Players → add or remove → **Save player list**.

**The lines look off.**
Lines come from Sleeper and are captured live. Whatever line is showing when
a game kicks off is the line the pick is graded against.

---

## What things cost

Nothing. Netlify's free tier covers a 12-person pool many times over: the
free allowance is 125,000 function calls a month, and a busy NFL Sunday with
everyone refreshing runs a few thousand.
