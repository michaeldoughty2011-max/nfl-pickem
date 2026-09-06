/* Synthetic Sleeper-shaped weeks, matching the real field names observed on
   api.sleeper.app/scores/nfl/regular/<season>/<week>. Local testing only. */

const SUNDAY = Date.parse("2026-08-30T17:00:00Z"); // a Sunday already in the past
const WEEK_MS = 7 * 24 * 3600_000;

const make = (week, rows) =>
  rows.map(([i, away, home, spreadHome, offsetH, phase, hs = 0, as = 0, ch = "FOX"]) => {
    const kick = SUNDAY + (week - 1) * WEEK_MS + offsetH * 3600_000;
    const over = phase === "final";
    const live = phase === "live";
    const started = over || live;
    const q = (side, total) => {
      const out = {};
      for (let k = 1; k <= 4; k++) out[`${side}_score_quarter${k}`] = k === 1 ? total : 0;
      out[`${side}_score_overtime`] = 0;
      return out;
    };
    return {
      game_id: `2026${String(week).padStart(2, "0")}${String(i).padStart(3, "0")}`,
      start_time: kick,
      week,
      season: "2026",
      season_type: "regular",
      sport: "nfl",
      status: over ? "complete" : live ? "in_game" : "pre_game",
      metadata: {
        away_team: away,
        home_team: home,
        date_time: new Date(kick).toISOString(),
        channel: ch,
        stadium_details: { city: "Somewhere" },
        pickem_spread: { [home]: spreadHome, [away]: -spreadHome, is_locked: over },
        spread: { [home]: spreadHome, [away]: -spreadHome },
        has_started: started,
        is_in_progress: live,
        is_over: over,
        closed: over,
        status: over ? "closed" : live ? "inprogress" : "scheduled",
        quarter: over ? "F" : live ? "3" : "",
        quarter_num: over ? 4 : live ? 3 : "",
        time_remaining: over ? "00:00" : live ? "07:41" : "",
        is_overtime: false,
        canceled: false,
        possession: live ? home : "",
        red_zone: false,
        home_score: started ? hs : 0,
        away_score: started ? as : 0,
        ...q("home", started ? hs : 0),
        ...q("away", started ? as : 0),
      },
    };
  });

/* Week 1 — mixed states, chosen to hit every scoring branch:
   home cover, away cover, an exact push, and live games leading both ways. */
export const week1 = make(1, [
  [1, "NE", "SEA", -3.5, -89, "final", 27, 13, "NBC"],
  [2, "SF", "LAR", -3.5, -64, "final", 20, 24, "Netflix"],
  [3, "TB", "CIN", -3.5, 0, "final", 24, 20, "FOX"],
  [4, "NO", "DET", -6.5, 0, "final", 31, 17, "FOX"],
  [5, "NYJ", "TEN", -2.5, 0, "final", 17, 20, "CBS"],
  [6, "BAL", "IND", 3.5, 0, "final", 21, 24, "CBS"],
  [7, "ATL", "PIT", -3, 0, "final", 24, 21, "FOX"],   // exact push
  [8, "CHI", "CAR", 2.5, 0, "live", 10, 14, "FOX"],
  [9, "CLE", "JAX", -7.5, 0, "live", 21, 7, "CBS"],
  [10, "BUF", "HOU", 1.5, 0, "live", 14, 13, "CBS"],
  [11, "GB", "MIN", -1.5, 3.4, "pre", 0, 0, "CBS"],
  [12, "MIA", "LV", -3.5, 3.4, "pre", 0, 0, "FOX"],
  [13, "WAS", "PHI", -5.5, 3.4, "pre", 0, 0, "FOX"],
  [14, "ARI", "LAC", -10.5, 3.4, "pre", 0, 0, "CBS"],
  [15, "DAL", "NYG", 2.5, 7.3, "pre", 0, 0, "NBC"],
  [16, "DEN", "KC", -2.5, 31, "pre", 0, 0, "ABC"],
]);

/* Week 2 — everything final, so KOTH elimination can be checked. */
export const week2 = make(2, [
  [1, "SEA", "NE", 2.5, -89, "final", 30, 10, "NBC"],
  [2, "LAR", "SF", -1.5, -64, "final", 17, 21, "AMZN"],
  [3, "CIN", "TB", 1.5, 0, "final", 13, 27, "FOX"],
  [4, "DET", "NO", 6.5, 0, "final", 14, 28, "FOX"],
  [5, "TEN", "NYJ", -1.5, 0, "final", 24, 20, "CBS"],
  [6, "IND", "BAL", -4.5, 0, "final", 33, 10, "CBS"],
  [7, "PIT", "ATL", 2.5, 0, "final", 20, 23, "FOX"],
  [8, "CAR", "CHI", -6.5, 0, "final", 31, 14, "FOX"],
  [9, "JAX", "CLE", 3.5, 0, "final", 17, 20, "CBS"],
  [10, "HOU", "BUF", -5.5, 0, "final", 27, 24, "CBS"],
  [11, "MIN", "GB", -2.5, 3.4, "final", 21, 17, "CBS"],
  [12, "LV", "MIA", -2.5, 3.4, "final", 24, 14, "FOX"],
  [13, "PHI", "WAS", 4.5, 3.4, "final", 20, 34, "FOX"],
  [14, "LAC", "ARI", 3.5, 3.4, "final", 13, 16, "CBS"],
  [15, "NYG", "DAL", -4.5, 7.3, "final", 28, 21, "NBC"],
  [16, "KC", "DEN", 1.5, 31, "final", 17, 20, "ABC"],
]);

export const weeks = { 1: week1, 2: week2 };
