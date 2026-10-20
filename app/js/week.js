/* This-week side of the engine (trade_analyzer.py: week_context, team_trends, adjust_projection,
   lineup_helper, waiver_metric, defense_streamers, roster_moves, stats, player card).
   Network work happens once in Week.prepare(); everything after it is synchronous and reads the
   prepared bundle W = {season, week, proj, ctx, seasons, weekly, trends, status}. */
"use strict";

const Week = (() => {
const { POSITIONS, norm, fmt, fmt_signed, compact, ordinal, pyround, now_iso, make_player, is_redraft, is_bestball,
  best_lineup_by, lineup_total, team_assets } = E;

const PROJ_WEEK_URL = "https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=DEF&position[]=K";
const NFL_TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WAS"];
const INJURY_OUT = new Set(["Out", "IR", "Doubtful", "PUP", "Sus", "Suspended", "NA", "COV", "DNR"]);
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week={week}&seasontype=2&dates={season}";
const ESPN_TO_SLEEPER = { WSH: "WAS" };
const LEAGUE_AVG_IMPLIED = 22.5;
const STAT_KEYS = ["gp", "pts_ppr", "pts_half_ppr", "pts_std", "pass_att", "pass_cmp", "pass_yd", "pass_td", "pass_int",
  "rush_att", "rush_yd", "rush_td", "rec", "rec_tgt", "rec_yd", "rec_td", "fum_lost"];
const SLEEPER_STATS_URL = "https://api.sleeper.com/stats/nfl/{season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=DEF";
const SLEEPER_WEEK_URL = "https://api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=DEF";
const WAIVER_GROUPS = [["QB", ["QB"]], ["RB/WR", ["RB", "WR"]], ["TE", ["TE"]]];
const WET = ["rain", "snow", "shower", "storm", "thunder", "sleet"];
const fill = (url, o) => url.replace(/\{(\w+)\}/g, (_, k) => o[k]);
const hoursOld = iso => iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : 1e9;
const isNum = x => typeof x === "number" && !isNaN(x);

function pts_key(cfg) {
  const ppr = parseFloat(cfg.league.ppr);
  return ppr >= 0.75 ? "pts_ppr" : (ppr >= 0.25 ? "pts_half_ppr" : "pts_std");
}

let nflState = null;
async function current_nfl_week(season) {
  try {
    if (!nflState || hoursOld(nflState.at) > 0.5) nflState = Object.assign(await Net.json("https://api.sleeper.app/v1/state/nfl"), { at: now_iso() });   // the week turns on Tuesday: re-read every half hour
    if (parseInt(nflState.season || season) === parseInt(season)) return Math.max(1, parseInt(nflState.week || 1));
  } catch (e) { /* offline: fall through */ }
  return 18;
}

async function week_projections(cfg, week, refresh = false) {
  const name = `proj.${cfg.season}.${week}.${pts_key(cfg)}.json`;
  const d = Store.get(name);
  if (d && d.v === 2 && !refresh && hoursOld(d.fetched) < 12) return d.players;
  const rows = await Net.json(fill(PROJ_WEEK_URL, { season: parseInt(cfg.season), week }));
  const pk = pts_key(cfg), players = {};
  for (const r of rows) {
    const st = r.stats || {}, pl = r.player || {};
    if (st.pts_ppr == null && st.pts_half_ppr == null && st.pts_std == null) continue;
    players[String(r.player_id)] = { pts: parseFloat(st[pk] || 0), opp: r.opponent, injury: pl.injury_status, pos: E.fantasy_pos(pl) || pl.position,
      team: r.team || pl.team, name: (String(pl.first_name || "") + " " + String(pl.last_name || "")).trim() || null };
  }
  Store.set(name, { v: 2, fetched: now_iso(), players });
  return players;
}

async function week_context(cfg, week, refresh = false) {
  const name = `ctx.${cfg.season}.${week}.json`;
  const d = Store.get(name);
  if (d && !refresh && hoursOld(d.fetched) < 6) return d.teams;
  const board = await Net.json(fill(ESPN_SCOREBOARD, { week, season: parseInt(cfg.season) }));
  const teams = {};
  for (const ev of board.events || []) {
    const comp = (ev.competitions || [{}])[0], comps = comp.competitors || [];
    if (comps.length !== 2) continue;
    const home = comps.find(c => c.homeAway === "home") || comps[0], away = comps.find(c => c.homeAway === "away") || comps[1];
    const venue = comp.venue || {}, w = comp.weather || ev.weather || {}, odds = (comp.odds || [{}])[0] || {};
    const spread = odds.spread, total = odds.overUnder;
    for (const [c, other, is_home] of [[home, away, true], [away, home, false]]) {
      const ab = ESPN_TO_SLEEPER[c.team.abbreviation] || c.team.abbreviation, opp = ESPN_TO_SLEEPER[other.team.abbreviation] || other.team.abbreviation;
      const own = spread == null ? null : (is_home ? +spread : -spread);
      teams[ab] = { opp, home: is_home, indoor: !!venue.indoor, venue: venue.fullName, weather: w.displayValue, temp: w.temperature, gust: w.gust, precip: w.precipitation,
        spread: own, total: total == null ? null : +total, implied: (total == null || own == null) ? null : +total / 2 - own / 2,
        kickoff: ev.date, status: ((ev.status || {}).type || {}).name };
    }
  }
  Store.set(name, { fetched: now_iso(), teams });
  return teams;
}

function _slim_stat_row(r) {
  const st = r.stats || {}, out = {};
  for (const k of STAT_KEYS) if (st[k] != null) out[k] = st[k];
  const pl = r.player || {};
  out.name = (String(pl.first_name || "") + " " + String(pl.last_name || "")).trim();
  out.pos = E.fantasy_pos(pl) || pl.position || "?";        // Travis Hunter is a DB to Sleeper, a WR to fantasy (2026-10-19)
  out.team = r.team || pl.team || "FA";
  if (r.opponent) out.opp = r.opponent;
  return out;
}

async function refresh_stats(cfg, log = () => {}, seasons_back = 2) {
  const season = parseInt(cfg.season);
  for (let y = season - seasons_back; y <= season; y++) {
    const name = `stats.season.${y}.json`, old = Store.get(name);
    if (old && old.v === 2 && y < season) continue;               // v2: fantasy positions (2026-10-19)
    if (old && old.v === 2 && y === season && hoursOld(old.fetched) < 6) continue;
    const rows = await Net.json(fill(SLEEPER_STATS_URL, { season: y }));
    const players = {};
    for (const r of rows) if (r.player_id && (r.stats || {}).gp) players[String(r.player_id)] = _slim_stat_row(r);
    Store.set(name, { v: 2, fetched: now_iso(), season: y, players });
    log(`Season ${y}: ${Object.keys(players).length} players`);
  }
  const wname = `stats.weekly.${season}.json`;
  const wold = Store.get(wname), weekly = wold && wold.v === 2 ? wold : { v: 2, fetched: null, season, weeks: {} };
  const week = await current_nfl_week(season);
  const need = [];
  for (let w = 1; w <= week; w++) if (!(String(w) in weekly.weeks) || w >= week) need.push(w);
  const got = await Promise.all(need.map(w => Net.json(fill(SLEEPER_WEEK_URL, { season, week: w })).catch(() => null)));
  need.forEach((w, i) => {
    const rows = got[i];
    if (!rows) return;
    const wk = {};
    for (const r of rows) if (r.player_id && (r.stats || {}).gp) wk[String(r.player_id)] = _slim_stat_row(r);
    if (Object.keys(wk).length) weekly.weeks[String(w)] = wk;
  });
  weekly.fetched = now_iso();
  Store.set(wname, weekly);
  log(`Weekly stats: ${Object.keys(weekly.weeks).length} weeks`);
}

function load_stats(cfg) {
  const season = parseInt(cfg.season), seasons = {};
  for (let y = season - 2; y <= season; y++) { const d = Store.get(`stats.season.${y}.json`); if (d && d.players) seasons[y] = d.players; }
  const wk = (Store.get(`stats.weekly.${season}.json`) || {}).weeks || {};
  const weekly = {};
  for (const k of Object.keys(wk).map(Number).sort((a, b) => a - b)) weekly[k] = wk[k];
  return [seasons, weekly];
}

function team_trends(cfg, weekly) {
  const pk = pts_key(cfg), off = {}, allowed = {}, league_week = {};
  for (const [w, players] of Object.entries(weekly)) {
    for (const r of Object.values(players)) {
      const pts = parseFloat(r[pk] || 0);
      if (!POSITIONS.includes(r.pos) || pts <= 0) continue;
      const team = r.team || "FA", opp = r.opp;
      (off[team] = off[team] || {})[w] = (off[team][w] || 0) + pts;
      league_week[w] = (league_week[w] || 0) + pts;
      if (opp) { const a = (allowed[opp] = allowed[opp] || {}); const p = (a[r.pos] = a[r.pos] || {}); p[w] = (p[w] || 0) + pts; }
    }
  }
  const weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b), n = weeks.length;
  const trend = {}, off_avg = {};
  for (const [team, byw] of Object.entries(off)) {
    const vals = weeks.filter(w => w in byw).map(w => byw[w]);
    if (vals.length) off_avg[team] = vals.reduce((s, x) => s + x, 0) / vals.length;
    if (vals.length < 2) { trend[team] = 1.0; continue; }
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    const recent = vals.slice(-2).reduce((s, x) => s + x, 0) / vals.slice(-2).length;
    const raw = avg ? recent / avg : 1.0, shrink = vals.length / (vals.length + 2);
    trend[team] = Math.max(0.9, Math.min(1.1, 1 + (raw - 1) * shrink));
  }
  const league_avg = {}, dvp = {};
  for (const pos of POSITIONS) {
    let tot = 0, games = 0;
    for (const d of Object.values(allowed)) for (const v of Object.values(d[pos] || {})) { tot += v; games++; }
    league_avg[pos] = games ? tot / games : 0;
  }
  for (const [dname, d] of Object.entries(allowed)) {
    dvp[dname] = {};
    for (const pos of POSITIONS) {
      const g = d[pos] || {}, gv = Object.values(g);
      if (!gv.length || !league_avg[pos]) { dvp[dname][pos] = 1.0; continue; }
      const raw = (gv.reduce((s, x) => s + x, 0) / gv.length) / league_avg[pos], shrink = gv.length / (gv.length + 3);
      dvp[dname][pos] = Math.max(0.85, Math.min(1.15, 1 + (raw - 1) * shrink));
    }
  }
  let pace = 1.0;
  if (n >= 3) {
    const lw = weeks.map(w => league_week[w] || 0), sum = lw.reduce((s, x) => s + x, 0);
    pace = sum ? (lw.slice(-2).reduce((s, x) => s + x, 0) / 2) / (sum / lw.length) : 1.0;
  }
  const oa = Object.values(off_avg);
  return { trend, dvp, pace, weeks: n, off_avg, league_off_avg: oa.length ? oa.reduce((s, x) => s + x, 0) / oa.length : 0 };
}

function adjust_projection(base, pos, team, ctx, trends, aggressiveness) {
  let mult = 1.0;
  const reasons = [];
  const apply = (fct, text) => { if (Math.abs(fct - 1) >= 0.015) reasons.push(`${text} ${fct >= 1 ? "+" : ""}${Math.round((fct - 1) * 100)}%`); mult *= fct; };
  const c = (ctx || {})[team] || null;
  if (c) {
    apply(c.home ? 1.02 : 0.98, c.home ? "home" : "away");
    if (!c.indoor) {
      const wx = (c.weather || "").toLowerCase(), precip = c.precip || 0;
      if (WET.some(k => wx.includes(k)) || (isNum(precip) && precip >= 50)) apply(pos === "RB" ? 1.03 : 0.93, (c.weather || "wet weather").toLowerCase());
      if (isNum(c.gust) && c.gust >= 20 && pos !== "RB") apply(0.94, `wind ${c.gust.toFixed(0)} mph`);
      if (isNum(c.temp) && c.temp <= 25 && (pos === "QB" || pos === "WR")) apply(0.97, `${c.temp.toFixed(0)}F cold`);
    }
    if (c.implied != null) apply(Math.max(0.85, Math.min(1.15, Math.pow(c.implied / LEAGUE_AVG_IMPLIED, 0.6))), `implied ${c.implied.toFixed(1)} pts`);
    const sp = c.spread;
    if (sp != null) {
      if (sp <= -7) apply({ RB: 1.04, WR: 0.98, TE: 0.98, QB: 0.99 }[pos] || 1.0, `favored by ${-sp}`);
      else if (sp >= 7) apply({ RB: 0.95, WR: 1.04, TE: 1.02, QB: 1.03 }[pos] || 1.0, `underdog by ${sp}`);
    }
    if (c.opp && trends) apply(((trends.dvp || {})[c.opp] || {})[pos] || 1.0, `vs ${c.opp} defense vs ${pos}`);
  }
  if (trends) apply((trends.trend || {})[team] || 1.0, "offense form");
  return [base * (1 + aggressiveness * (mult - 1)), reasons];
}

/* Everything the weekly screens need, downloaded once (cached files are reused). */

// ---------------------------------------------------------------------------
// The Pro app's own weekly data, from sources licensed for a public app:
//   schedule, roof and Vegas lines  -> nflverse games.csv (CC BY 4.0)
//   weather at kickoff              -> National Weather Service API (US government, public domain)
//   stats and our projections       -> nflverse player stats (already cached for the values)
// ---------------------------------------------------------------------------
const NFLV_GAMES_URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";
const NFLV_TEAM_FIX = { LA: "LAR" };                                   // nflverse -> Sleeper team codes
const RETRACTABLE = new Set(["ATL", "DAL", "HOU", "IND", "ARI"]);       // roof blank in the schedule = usually closed
const ABROAD = /^(LON|MUN|MAD|MEX|MEL|RIO|PAR|FRA|SAO|DUB|TOR)/;        // games outside the US: no NWS forecast
const STADIUM = {                                                     // home stadiums (lat, lon) for the forecast
  ARI: [33.5276, -112.2626], ATL: [33.7554, -84.4010], BAL: [39.2780, -76.6227], BUF: [42.7738, -78.7870], CAR: [35.2258, -80.8528],
  CHI: [41.8623, -87.6167], CIN: [39.0955, -84.5161], CLE: [41.5061, -81.6995], DAL: [32.7473, -97.0945], DEN: [39.7439, -105.0201],
  DET: [42.3400, -83.0456], GB: [44.5013, -88.0622], HOU: [29.6847, -95.4107], IND: [39.7601, -86.1639], JAX: [30.3240, -81.6373],
  KC: [39.0489, -94.4839], LV: [36.0909, -115.1833], LAC: [33.9535, -118.3392], LAR: [33.9535, -118.3392], MIA: [25.9580, -80.2389],
  MIN: [44.9736, -93.2575], NE: [42.0909, -71.2643], NO: [29.9511, -90.0812], NYG: [40.8135, -74.0745], NYJ: [40.8135, -74.0745],
  PHI: [39.9008, -75.1675], PIT: [40.4468, -80.0158], SEA: [47.5952, -122.3316], SF: [37.4033, -121.9694], TB: [27.9759, -82.5033],
  TEN: [36.1665, -86.7713], WAS: [38.9076, -76.8645],
};
const NWS_HEADERS = { "User-Agent": "DynastyMover/3.0 (dynastymover.app@gmail.com)", "Accept": "application/geo+json" };

/* This season's regular-season games from nflverse, kept for a day. */
async function nflv_games(season) {
  const name = `nflv_games_${season}.json`, c = Store.get(name);
  if (c && c.v === 3 && hoursOld(c.fetched) < 24) return c.games;   // v3: rest days and surface (2026-10-20)
  const txt = await Net.text(NFLV_GAMES_URL, null, 240000), games = [];
  const pa = { [season]: {}, [season - 1]: {} };                       // points allowed: "week|team" -> points (2026-10-19, for defenses)
  for (const r of E.parse_csv(txt)) {
    const y = parseInt(r.season, 10);
    if (r.game_type === "REG" && pa[y] && r.home_score !== "" && r.away_score !== "") {
      const h = NFLV_TEAM_FIX[r.home_team] || r.home_team, a = NFLV_TEAM_FIX[r.away_team] || r.away_team;
      pa[y][`${r.week}|${h}`] = parseInt(r.away_score, 10); pa[y][`${r.week}|${a}`] = parseInt(r.home_score, 10);
    }
    if (y !== season || r.game_type !== "REG") continue;
    games.push({ week: parseInt(r.week, 10), day: r.gameday, time: r.gametime || "13:00", away: NFLV_TEAM_FIX[r.away_team] || r.away_team, home: NFLV_TEAM_FIX[r.home_team] || r.home_team,
      spread: r.spread_line === "" ? null : parseFloat(r.spread_line), total: r.total_line === "" ? null : parseFloat(r.total_line), roof: r.roof || "", stadium: r.stadium || "", sid: r.stadium_id || "",
      rest_a: r.away_rest === "" ? null : parseInt(r.away_rest, 10), rest_h: r.home_rest === "" ? null : parseInt(r.home_rest, 10), surface: r.surface || "" });
  }
  Store.set(name, { v: 3, fetched: now_iso(), games });
  Store.set(`nflv_pa_${season}.json`, { v: 1, fetched: now_iso(), pa: pa[season] });
  if (Object.keys(pa[season - 1]).length) Store.set(`nflv_pa_${season - 1}.json`, { v: 1, fetched: now_iso(), pa: pa[season - 1] });
  return games;
}
const num = s => { const m = String(s || "").match(/\d+(\.\d+)?/g); return m ? Math.max(...m.map(Number)) : null; };
/* Games outside the US (2026-10-20): the forecast at kickoff from MET Norway's Locationforecast (api.met.no, free, CC BY
   4.0 / NLOD 2.0, "Data from MET Norway"), which covers the whole world; the NWS covers only the US. Same shape as
   nws_weather. Asked at most once an hour per stadium, with the app's name in the User-Agent as MET asks. */
const INTL_STADIUM = { LON00: [51.556, -0.2796], LON01: [51.4559, -0.3415], LON02: [51.6043, -0.0664], MUN01: [48.2188, 11.6247], FRA00: [50.0686, 8.6455],
  MAD01: [40.4531, -3.6883], PAR00: [48.9245, 2.3602], DUB00: [53.3607, -6.2512], MEX00: [19.3029, -99.1505], SAO00: [-23.5453, -46.4742], RIO00: [-22.9121, -43.2302], MEL00: [-37.82, 144.9834] };
const MET_HEADERS = { "User-Agent": "DynastyMover/3.2 dynastymover.app@gmail.com" };
const met_words = c => String(c || "").replace(/_(day|night|polartwilight)$/, "").replace("partlycloudy", "partly cloudy").replace("clearsky", "clear").replace("fair", "fair")
  .replace(/^(heavy|light)?(rain|snow|sleet)(showers)?(andthunder)?$/, (m, i, w, sh, th) => [i, w, sh && "showers", th && "and thunder"].filter(Boolean).join(" ")) || null;
async function met_weather(sid, kickoff) {
  const ll = INTL_STADIUM[String(sid || "").slice(0, 5)];
  if (!ll) return null;
  const name = `met_${sid}.json`;
  let c = Store.get(name);
  if (!c || hoursOld(c.fetched) > 1) {
    const j = JSON.parse(await Net.text(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${ll[0].toFixed(4)}&lon=${ll[1].toFixed(4)}`, MET_HEADERS, 30000));
    c = { fetched: now_iso(), series: ((j.properties || {}).timeseries || []).map(t => { const d = t.data || {}, i = (d.instant || {}).details || {}, n1 = d.next_1_hours || {};
      return [t.time, i.air_temperature, i.wind_speed_of_gust ?? i.wind_speed, (n1.details || {}).probability_of_precipitation, (n1.summary || (d.next_6_hours || {}).summary || {}).symbol_code]; }) };
    Store.set(name, c);
  }
  const t = new Date(kickoff).getTime();
  const p = c.series.find(([s], i) => { const a = new Date(s).getTime(), b = i + 1 < c.series.length ? new Date(c.series[i + 1][0]).getTime() : a + 3600000; return a <= t && t < b; });
  if (!p) return null;
  const [, tc, gust, pop, sym] = p;
  return { weather: met_words(sym), temp: tc == null ? null : Math.round(tc * 9 / 5 + 32), gust: gust == null ? null : Math.round(gust * 2.237), precip: pop ?? null, source: "met" };
}
/* The NWS hourly forecast for a stadium at kickoff: { weather, temp, gust, precip }, or null when it's too far out. */
async function nws_weather(team, kickoff) {
  const ll = STADIUM[team];
  if (!ll) return null;
  const pname = `nws_point_${team}.json`;
  let pt = Store.get(pname);
  if (!pt || hoursOld(pt.fetched) > 24 * 30) {
    const j = JSON.parse(await Net.text(`https://api.weather.gov/points/${ll[0].toFixed(4)},${ll[1].toFixed(4)}`, NWS_HEADERS, 30000));
    pt = { fetched: now_iso(), hourly: j.properties.forecastHourly }; Store.set(pname, pt);
  }
  const hname = `nws_hourly_${team}.json`;
  let h = Store.get(hname);
  if (!h || hoursOld(h.fetched) > 6) {
    const j = JSON.parse(await Net.text(pt.hourly, NWS_HEADERS, 30000));
    h = { fetched: now_iso(), periods: (j.properties.periods || []).map(p => [p.startTime, p.endTime, p.temperature, p.windSpeed, p.windGust, (p.probabilityOfPrecipitation || {}).value, p.shortForecast]) };
    Store.set(hname, h);
  }
  const t = new Date(kickoff).getTime();
  const p = h.periods.find(([s, e]) => new Date(s).getTime() <= t && t < new Date(e).getTime());
  if (!p) return null;
  return { weather: p[6] || "", temp: p[2], gust: num(p[4]) || num(p[3]), wind: num(p[3]), precip: p[5] };
}
/* Game context for a week in the shape the lineup helper and pickups use (see week_context): opp, home, indoor, venue,
   weather, temp, gust, precip, spread (own, negative = favored), total, implied, kickoff. Teams on a bye are absent. */
async function week_context_nflv(cfg, week, refresh = false) {
  const season = parseInt(cfg.season), name = `ctx.nflv.${season}.${week}.json`, d = Store.get(name);
  if (d && !refresh && hoursOld(d.fetched) < 6) return d.teams;
  const games = (await nflv_games(season)).filter(g => g.week === week), teams = {};
  const off = m => (m >= 11 || m <= 2 ? "-05:00" : "-04:00");             // kickoff times are Eastern
  await Promise.all(games.map(async g => {
    const kickoff = `${g.day}T${g.time.length === 5 ? g.time : "13:00"}:00${off(parseInt(g.day.slice(5, 7), 10))}`;
    const indoor = ["dome", "closed"].includes(g.roof) || (g.roof === "" && RETRACTABLE.has(g.home));
    let wx = null;
    if (!indoor) { try { wx = ABROAD.test(g.sid) ? await met_weather(g.sid, kickoff) : await nws_weather(g.home, kickoff); } catch (e) { wx = null; } }
    for (const [ab, opp, is_home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const own = g.spread == null ? null : (is_home ? -g.spread : g.spread);   // nflverse: positive = home favored
      teams[ab] = { opp, home: is_home, indoor, venue: g.stadium, weather: wx ? wx.weather : null, temp: wx ? wx.temp : null, gust: wx ? wx.gust : null, precip: wx ? wx.precip : null,
        spread: own, total: g.total, implied: (g.total == null || own == null) ? null : g.total / 2 - own / 2, kickoff, status: null, source: "nflverse" };
    }
  }));
  Store.set(name, { fetched: now_iso(), teams });
  return teams;
}
/* Season and weekly stats rows (the shape refresh_stats builds) from the nflverse caches, keyed by Sleeper id. */
async function nflv_league_stats(cfg, season) {
  const values = E.P.values;
  if (!values) return [{}, {}];
  const [cur, last, log] = await Promise.all([E.nflv_stats(season, true, 12), E.nflv_stats(season - 1, false, 24 * 30).catch(() => ({})),
    Promise.resolve((Store.get(`nflv_log_${season}.json`) || {}).players || {})]);
  const row = (o, g, std, ppr, team, opp) => ({ gp: g, pts_std: std, pts_ppr: ppr, pts_half_ppr: (std + ppr) / 2, name: o.name, pos: o.pos, team: team || o.team || "FA", opp });
  const seasons = { [season]: {}, [season - 1]: {} }, weekly = {};
  for (const a of values.players) {
    if (a.is_pick || !a.sleeper_id) continue;
    const k = E.player_key(a.name, a.pos), sid = String(a.sleeper_id), c = cur[k], l = last[k];
    if (c && c[0]) seasons[season][sid] = row(a, c[0], c[1], c[2], c[8] || a.team);
    if (l && l[0]) seasons[season - 1][sid] = row(a, l[0], l[1], l[2], l[8] || a.team);
    const games = log[k] || {};
    for (const [w, g] of Object.entries(c && c[3] ? c[3] : {})) (weekly[w] = weekly[w] || {})[sid] = row(a, 1, g[0], g[1], c[8] || a.team, (games[w] || [])[0] || undefined);
  }
  const out = {};
  for (const w of Object.keys(weekly).map(Number).sort((x, y) => x - y)) out[w] = weekly[w];
  return [seasons, out];
}
/* Our weekly projection: his scoring this season (every game counts once, so one big game can't carry him), last season
   at about a third of the weight, steadied by two games of a fringe starter at his position. The lineup helper then
   adjusts it for home or away, the Vegas line, the weather and his team's form, the same way it does the personal
   edition's projections. */
const ROTATION_DEPTH = { QB: 1, RB: 3, WR: 4, TE: 2 };    // deeper than this on the depth chart with no games this season: he isn't playing
/* Recency (2026-10-13): the last three games weigh more than the season average, and a change in opportunities over
   those games (a quarterback change, an injury ahead of him) moves the number the same week. */
const RECENT_GAMES = 3, RECENT_WEIGHT = 0.55, USAGE_PULL = 0.5;
function recent_rate(sid, pos, cur, weekly, season, cfg, upto = null) {
  const c = cur[sid]; if (!c || !c.gp) return null;
  const pk = pts_key(cfg), seasonRate = c[pk] / c.gp;
  const games = Object.keys(weekly || {}).map(Number).sort((a, b) => a - b).filter(w => weekly[w][sid]).map(w => weekly[w][sid][pk]);
  if (games.length < 4) return seasonRate;                                           // too few games for a trend to mean anything
  const last = games.slice(-RECENT_GAMES), recent = last.reduce((s, x) => s + x, 0) / last.length;
  let rate = RECENT_WEIGHT * recent + (1 - RECENT_WEIGHT) * seasonRate;
  // usage: opportunities a game over the last three against the season (the stats cache keeps opportunities by week)
  const wk = (Store.get(`nflv_wk_${season}.json`) || {}).players || {}, a = E.P.values && E.P.values.by_sleeper[sid], o = a && wk[E.player_key(a.name, a.pos)];
  if (o && o[3]) {
    const ws = Object.keys(o[3]).map(Number).filter(w => !upto || w < upto).sort((x, y) => x - y), opp = w => o[3][w][2] || 0;
    const seasonOpp = ws.reduce((s, w) => s + opp(w), 0) / ws.length, lastOpp = ws.slice(-RECENT_GAMES).reduce((s, w) => s + opp(w), 0) / Math.min(RECENT_GAMES, ws.length);
    if (seasonOpp > 0 && ws.length >= 4) { const ratio = Math.max(0.5, Math.min(1.6, lastOpp / seasonOpp)); rate *= 1 + USAGE_PULL * (ratio - 1); }   // half of a usage change carries into the number
  }
  return rate;
}
function our_projections(cfg, seasons, season, status = {}, week = 0, weekly = null, upto = null) {
  const pk = pts_key(cfg), cur = seasons[season] || {}, prev = seasons[season - 1] || {}, teams = parseInt(cfg.league.teams, 10) || 12;
  const starters = { QB: parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 }, prior = {};
  for (const pos of POSITIONS) {
    const l = Object.values(cur).filter(r => r.pos === pos && r.gp >= 2).map(r => r[pk] / r.gp).sort((a, b) => b - a);
    prior[pos] = l.length ? l[Math.min(l.length - 1, Math.round(teams * starters[pos]))] : 0;
  }
  const proj = {};
  for (const sid of new Set(Object.keys(cur).concat(Object.keys(prev)))) {
    const c = cur[sid], p = prev[sid], r = c || p;
    if (!POSITIONS.includes(r.pos)) continue;
    const st = status[sid] || {}, depth = st.depth ?? null, g0 = c ? c.gp : 0, g1 = p ? Math.min(17, p.gp) : 0, w1 = 0.35 * g1;
    // Role first (the user's rule, 2026-10-07: J.J. McCarthy, third on the Giants' depth chart with no 2026 games, was
    // projected 13 from his Vikings season). No games this season by week 2: a backup QB, or anyone below the rotation
    // depth, projects nothing; a backup in the rotation gets a share of a fringe starter's number, not his old rate.
    let pts;
    if (week >= 2 && g0 === 0 && depth != null && depth > (ROTATION_DEPTH[r.pos] || 1)) pts = 0;
    else if (week >= 2 && g0 === 0 && depth !== 1) pts = (prior[r.pos] || 0) * (depth === 2 ? 0.5 : 0.3);   // (unknown depth and no games: treated as deep)
    else {
      const rate = c ? (recent_rate(sid, r.pos, cur, weekly, season, cfg, upto) ?? c[pk] / c.gp) : 0;   // this season at the recent rate
      pts = (g0 * rate * 1 + w1 * (p ? p[pk] / p.gp : 0) + 2 * (prior[r.pos] || 0)) / (g0 + w1 + 2);
      // a healthy non-starter who has missed most of the season's games isn't about to play a full one
      if (week >= 3 && !st.inj && depth != null && depth > 1 && g0 < 0.6 * (week - 1)) pts *= Math.max(0.25, (g0 + 0.5) / (week - 1));
    }
    proj[sid] = { pts: Math.round(pts * 10) / 10, pos: r.pos, team: st.team || (c || p).team, injury: null, ours: true };
  }
  return proj;
}

// ---------------------------------------------------------------------------
// Kickers and defenses (2026-10-19, the user's ask: the leagues that start them), from nflverse (CC BY 4.0) like the
// rest of the Play editions' stats. Kickers: field goals by distance and extra points from the weekly player file
// (engine.js nflv_stats keeps them in nflv_k_<season>.json). Defenses: the team weekly file and the final scores from
// the schedule. Both on Sleeper's default scoring; checked against Sleeper's numbers for weeks 2-5 of 2026: kickers
// match, defenses match or are a point apart (how forced fumbles are counted).
// ---------------------------------------------------------------------------
const KDEF = ["K", "DEF"];
const KDEF_PRIOR = { K: 8, DEF: 6.5 };                       // a typical starter's points a game, for a thin record
const NFLV_TEAM_WEEK = "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{season}.csv";
const kdef_slots = league => KDEF.filter(p => ((league && league.roster_positions) || []).includes(p));
// a defense's points on Sleeper's default scoring: 1 a sack or forced fumble, 2 an interception, fumble recovery, safety
// or blocked kick, 6 a touchdown (defense or special teams), and 10 down to -4 for the points it allowed
const pa_pts = x => (x === 0 ? 10 : x <= 6 ? 7 : x <= 13 ? 4 : x <= 20 ? 1 : x <= 27 ? 0 : x <= 34 ? -1 : -4);
function def_pts(r, pa) {
  const n = k => parseFloat(r[k]) || 0;
  return n("def_sacks") + n("def_fumbles_forced") + 2 * (n("def_interceptions") + n("fumble_recovery_opp") + n("def_safeties") + n("def_punt_blocks") + n("def_fg_blocks") + n("def_pat_blocks"))
    + 6 * (n("def_tds") + n("fumble_recovery_tds") + n("special_teams_tds")) + pa_pts(pa);
}
const kdef_row = (gp, pts, name, pos, team, opp) => ({ gp, pts_std: pts, pts_ppr: pts, pts_half_ppr: pts, name, pos, team, opp });
/* Each defense's games for a season: {week: {team: row}}. A game counts once its final score is in the schedule. */
async function def_weeks(season, maxHours) {
  const name = `nflv_def_${season}.json`, c = Store.get(name);
  if (c && c.v === 1 && hoursOld(c.fetched) < maxHours) return c.weeks;
  try {
    const pa = (Store.get(`nflv_pa_${season}.json`) || {}).pa || {}, weeks = {};
    const txt = await Net.text(fill(NFLV_TEAM_WEEK, { season }), null, 120000);
    for (const r of E.parse_csv(txt)) {
      if ((r.season_type || "REG") !== "REG") continue;
      const team = NFLV_TEAM_FIX[r.team] || r.team, x = pa[`${r.week}|${team}`];
      if (x == null) continue;
      (weeks[r.week] = weeks[r.week] || {})[team] = kdef_row(1, def_pts(r, x), `${team} defense`, "DEF", team, NFLV_TEAM_FIX[r.opponent_team] || r.opponent_team);
    }
    Store.set(name, { v: 1, fetched: now_iso(), weeks });
    return weeks;
  } catch (e) { return c ? c.weeks : {}; }
}
/* This season's games and last season's totals for every kicker and defense: { weeks: {week: {sid: row}}, last: {sid: row} }.
   Kickers are matched to Sleeper by name (one with a team first). */
async function kdef_stats(season, week) {
  await nflv_games(season).catch(() => null);                          // the final scores (points allowed), this season and last
  const [cur, prev] = await Promise.all([def_weeks(season, 12), def_weeks(season - 1, 24 * 30)]);
  const sl = (Store.get("sleeper_players.json") || {}).players || {}, kid = {};
  for (const [sid, p] of Object.entries(sl)) if (p.position === "K") {
    const k = E.player_key(p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), "K");
    if (!kid[k] || (p.team && !(sl[kid[k]] || {}).team)) kid[k] = sid;
  }
  const weeks = {}, last = {};
  for (const [w, rows] of Object.entries(cur)) if (+w <= week) weeks[w] = Object.assign({}, rows);
  for (const [w, rows] of Object.entries(prev)) for (const [t, r] of Object.entries(rows)) {
    const L = last[t] || (last[t] = kdef_row(0, 0, r.name, "DEF", t)); L.gp += 1; L.pts_std += r.pts_std; L.pts_ppr += r.pts_ppr; L.pts_half_ppr += r.pts_half_ppr;
  }
  const kw = (Store.get(`nflv_k_${season}.json`) || {}).players || {}, kr = (Store.get(`nflv_kreg_${season - 1}.json`) || {}).players || {};
  for (const [k, K] of Object.entries(kw)) {
    const sid = kid[k]; if (!sid) continue;
    const nm = k.split("|")[0];
    for (const [w, [p, opp]] of Object.entries(K.w || {})) if (+w <= week) (weeks[w] = weeks[w] || {})[sid] = kdef_row(1, p, (sl[sid] || {}).full_name || nm, "K", K.team, opp);
  }
  for (const [k, K] of Object.entries(kr)) { const sid = kid[k]; if (sid && K.gp) last[sid] = kdef_row(K.gp, K.pts, (sl[sid] || {}).full_name || k.split("|")[0], "K", K.team); }
  return { weeks, last };
}
/* Their rows join the week's tables: each game in weekly, this season's totals and last season's in seasons. */
function merge_kdef(seasons, weekly, kd, season) {
  const cur = seasons[season] = seasons[season] || {}, prev = seasons[season - 1] = seasons[season - 1] || {};
  for (const [sid, r] of Object.entries(kd.last)) prev[sid] = r;
  for (const w of Object.keys(kd.weeks).map(Number).sort((a, b) => a - b)) {
    for (const [sid, r] of Object.entries(kd.weeks[w])) {
      (weekly[w] = weekly[w] || {})[sid] = r;
      const t = cur[sid] || (cur[sid] = { gp: 0, pts_std: 0, pts_ppr: 0, pts_half_ppr: 0, name: r.name, pos: r.pos, team: r.team });
      t.gp += r.gp; t.pts_std += r.pts_std; t.pts_ppr += r.pts_ppr; t.pts_half_ppr += r.pts_half_ppr; t.team = r.team;
    }
  }
}
/* Our projection for a kicker or defense: this season's points a game, steadied by last season's (or a typical
   starter's) as five games' worth, with a quarter of the say for the last three games. No team, no game this week or
   out injured: no projection. The lineup adds the matchup (a defense's opponent, a kicker's weather and venue). */
function kdef_projections(cfg, seasons, weekly, season, week, ctx, status = {}) {
  const pk = pts_key(cfg), cur = seasons[season] || {}, prev = seasons[season - 1] || {}, hasCtx = Object.keys(ctx || {}).length > 0, out = {};
  const sl = (Store.get("sleeper_players.json") || {}).players || {};
  for (const sid of new Set(Object.keys(cur).concat(Object.keys(prev)))) {
    const c = cur[sid], p = prev[sid], r = c || p;
    if (!KDEF.includes(r.pos)) continue;
    const st = status[sid] || {}, team = r.pos === "DEF" ? sid : (st.team || (sl[sid] || {}).team || null);
    if (!team || team === "FA" || (hasCtx && !ctx[team]) || INJURY_OUT.has(st.inj)) continue;
    const M = KDEF_PRIOR[r.pos], g0 = c ? c.gp : 0, last = p && p.gp >= 4 ? p[pk] / p.gp : M;
    let pts = (g0 * (g0 ? c[pk] / c.gp : 0) + 3 * last + 2 * M) / (g0 + 5);
    const recent = Object.keys(weekly || {}).map(Number).filter(w => w < week && weekly[w][sid]).sort((a, b) => a - b).slice(-3).map(w => +weekly[w][sid][pk] || 0);
    if (recent.length === 3) pts = 0.75 * pts + 0.25 * recent.reduce((s, x) => s + x, 0) / 3;
    const g = (ctx || {})[team], s = sl[sid];
    out[sid] = { pts: Math.round(pts * 10) / 10, pos: r.pos, team, opp: g ? (g.home === false ? "@" : "") + g.opp : undefined, injury: null, ours: true,
      name: (r.pos === "K" && s && (s.full_name || `${s.first_name || ""} ${s.last_name || ""}`.trim())) || r.name };
  }
  return out;
}
/* Their season grade: points a game this season (2+ games, else last season's) ranked at the position, one starter a
   team, on the week grade's scale. F only for one with nothing going (no team). Cached on W. */
function kdef_season_grades(values, cfg, W) {
  if (!W || !W.seasons) return {};
  if (W._ksg) return W._ksg;
  const pk = pts_key(cfg), season = parseInt(cfg.season, 10), cur = W.seasons[season] || {}, prev = W.seasons[season - 1] || {};
  const teams = (values.league && values.league.teams && values.league.teams.length) || parseInt(cfg.league.teams, 10) || 12;
  const sl = (Store.get("sleeper_players.json") || {}).players || {}, rows = {};
  for (const sid of new Set(Object.keys(cur).concat(Object.keys(prev)))) {
    const c = cur[sid], p = prev[sid], r = c || p;
    if (!KDEF.includes(r.pos)) continue;
    const ppg = c && c.gp >= 2 ? c[pk] / c.gp : p && p.gp >= 4 ? p[pk] / p.gp : null;
    if (ppg == null) continue;
    const team = r.pos === "DEF" ? sid : (sl[sid] || {}).team;
    (rows[r.pos] = rows[r.pos] || []).push([sid, ppg, !!team]);
  }
  const out = {};
  for (const [pos, l] of Object.entries(rows)) {
    l.sort((x, y) => y[1] - x[1]);
    l.forEach(([sid, ppg, team], i) => {
      let [, letter] = WEEK_CUTS.find(([c]) => (i + 1) / teams <= c);
      if (letter === "F" && team) letter = "D";
      out[sid] = { letter, cls: "g" + letter[0].toLowerCase(), ppg, posRank: i + 1 };
    });
  }
  return (W._ksg = out);
}
// the week's kicker and defense numbers are in (the Play editions: only once their stats loaded)
const kdef_ready = W => !!W && !W.valuesOnly && (!W.ours || !!W.kdef);

// ---------------------------------------------------------------------------
// Projection accuracy (2026-10-15): each past week re-projected with what was known before it, against what happened;
// a per-position correction fitted to that record is applied to this week's projections.
// ---------------------------------------------------------------------------
const ACC_MIN_PTS = 3, CALIB_SHRINK = 150, CALIB_MIN_N = 25;
function upto_week(weekly, w) {                              // this season's totals from the weeks before w
  const cur = {};
  for (const [v, rows] of Object.entries(weekly || {})) {
    if (+v >= w) continue;
    for (const [sid, r] of Object.entries(rows)) {
      const c = cur[sid] || (cur[sid] = { gp: 0, pts_std: 0, pts_ppr: 0, pts_half_ppr: 0, name: r.name, pos: r.pos, team: r.team });
      c.gp += 1; c.pts_std += +r.pts_std || 0; c.pts_ppr += +r.pts_ppr || 0; c.pts_half_ppr += +r.pts_half_ppr || 0; c.team = r.team || c.team;
    }
  }
  return cur;
}
async function past_projections(cfg, W, w) {
  if (W.ours) {
    const weeklyBefore = Object.fromEntries(Object.entries(W.weekly || {}).filter(([v]) => +v < w));
    return our_projections(cfg, { [W.season]: upto_week(W.weekly, w), [W.season - 1]: (W.seasons || {})[W.season - 1] || {} }, W.season, W.status || {}, w, weeklyBefore, w);
  }
  return await week_projections(cfg, w).catch(() => ({}));    // Sleeper keeps each past week's projection
}
function acc_stats(pairs) {
  if (!pairs.length) return null;
  let abs = 0, close = 0, bias = 0;
  for (const x of pairs) { const d = x.y - x.p; abs += Math.abs(d); bias += d; if (Math.abs(d) <= 5) close++; }
  return { n: pairs.length, mae: abs / pairs.length, close: close / pairs.length, bias: bias / pairs.length };
}
/* actual = a + b x projection by position, weighted least squares (recent weeks count more: a week's weight halves
   every 1.5 weeks back), shrunk toward no change (a 0, b 1) by sample size. Week 1 is left out: with no games yet
   the model runs on last season alone and misses in its own way (it ran 2.6 points low in 2026). Tested out of sample
   on 2026 weeks 3-5 against plain, bias-only and heavier-shrink versions: this one cut the miss 4.70 -> 4.66. */
const CALIB_HALF = 1.5;
function fit_calib(pairs, forWeek) {
  const out = {}, wt = x => Math.pow(0.5, Math.max(0, forWeek - 1 - x.w) / CALIB_HALF);
  for (const pos of POSITIONS) {
    const P = pairs.filter(x => x.pos === pos && x.w >= 2), n = P.length;
    if (n < CALIB_MIN_N) { out[pos] = { a: 0, b: 1, n }; continue; }
    const W = P.reduce((s, x) => s + wt(x), 0);
    const mx = P.reduce((s, x) => s + wt(x) * x.p, 0) / W, my = P.reduce((s, x) => s + wt(x) * x.y, 0) / W;
    let sxx = 0, sxy = 0; for (const x of P) { sxx += wt(x) * (x.p - mx) ** 2; sxy += wt(x) * (x.p - mx) * (x.y - my); }
    let b = sxx > 0 ? sxy / sxx : 1, a = my - b * mx;
    const k = n / (n + CALIB_SHRINK);
    b = Math.max(0.75, Math.min(1.25, 1 + (b - 1) * k)); a = Math.max(-3, Math.min(3, a * k));
    out[pos] = { a: Math.round(a * 100) / 100, b: Math.round(b * 1000) / 1000, n };
  }
  return out;
}
const apply_calib = (C, pos, pts) => (!C || !C[pos] || !(pts > 0) ? pts : Math.max(0, Math.round((C[pos].a + C[pos].b * pts) * 10) / 10));
async function accuracy(cfg, W) {
  const pk = pts_key(cfg), name = `acc.${W.season}.${W.week}.${pk}.${W.ours ? "ours" : "sl"}.json`, c = Store.get(name);
  if (c && c.v === 3) return c;
  const weeks = Object.keys(W.weekly || {}).map(Number).filter(w => w >= 1 && w < W.week).sort((a, b) => a - b);
  const pairs = [], per = {};
  for (const w of weeks) {
    const proj = await past_projections(cfg, W, w), act = W.weekly[w] || {};
    for (const [sid, r] of Object.entries(proj || {})) {
      if (!POSITIONS.includes(r.pos) || !(r.pts > 0)) continue;
      const a = act[sid]; if (!a) continue;                              // he didn't play: a bye or an injury, not a projection miss
      const y = +a[pk] || 0;
      if (r.pts >= ACC_MIN_PTS) pairs.push({ w, pos: r.pos, p: +r.pts, y });   // the error stats skip tiny projections; the player's record keeps them (2026-10-19)
      (per[sid] = per[sid] || {})[w] = [Math.round(r.pts * 10) / 10, Math.round(y * 10) / 10];
    }
  }
  const rows = weeks.map(w => {
    const P = pairs.filter(x => x.w === w), raw = acc_stats(P);
    const before = pairs.filter(x => x.w < w && x.w >= 2), C = w >= 3 && before.length >= 4 * CALIB_MIN_N ? fit_calib(before, w) : null;   // the correction as it stood that week
    const cal = C ? acc_stats(P.map(x => ({ p: apply_calib(C, x.pos, x.p), y: x.y }))) : null;
    return raw ? { w, n: raw.n, mae: raw.mae, close: raw.close, bias: raw.bias, maeCal: cal ? cal.mae : null } : null;
  }).filter(Boolean);
  const byPos = Object.fromEntries(POSITIONS.map(pos => [pos, acc_stats(pairs.filter(x => x.pos === pos))]).filter(([, v]) => v));
  const calRows = rows.filter(r => r.maeCal != null);
  const gain = calRows.length ? { raw: calRows.reduce((s, r) => s + r.mae * r.n, 0) / calRows.reduce((s, r) => s + r.n, 0), cal: calRows.reduce((s, r) => s + r.maeCal * r.n, 0) / calRows.reduce((s, r) => s + r.n, 0), from: calRows[0].w } : null;
  // the correction is used only while it beats the plain numbers on the past weeks it was tested on (no advice beats bad advice)
  const out = { v: 3, at: now_iso(), source: W.ours ? "ours" : "sleeper", weeks: rows, all: acc_stats(pairs), byPos, calib: fit_calib(pairs, W.week), per,
    gain, use: !!(gain && gain.cal < gain.raw - 0.01) };
  Store.set(name, out);
  return out;
}
/* The correction on this week's projections; the uncorrected number stays on r.raw. */
async function calibrate(cfg, W) {
  if (!W || W.valuesOnly || !W.proj || !Object.keys(W.proj).length) return W;
  try {
    const A = await accuracy(cfg, W); W.acc = A;
    if (A.use) for (const r of Object.values(W.proj)) { if (r.raw == null) r.raw = r.pts; r.pts = apply_calib(A.calib, r.pos, r.raw); }
  } catch (e) { /* no record yet: the projections stand as they are */ }
  return W;
}
async function prepare(cfg, opts = {}) {
  const W = await prepare_raw(cfg, opts);
  return calibrate(cfg, W);
}
async function prepare_raw(cfg, opts = {}) {
  const season = parseInt(cfg.season);
  if (E.PLAY) {
    // Public app: the weekly data comes only from sources licensed for it. Stats and our own projections from nflverse,
    // schedule and Vegas lines from nflverse, weather from the National Weather Service. If any of it fails, the screens
    // fall back to this-season values plus Sleeper's injury status.
    if (!Store.get("player_status.json")) await E.refresh_player_status().catch(() => null);
    const week = opts.week || await current_nfl_week(season);
    try {
      const [seasons, weekly] = await nflv_league_stats(cfg, season);
      if (!Object.keys(seasons[season] || {}).length && !Object.keys(seasons[season - 1] || {}).length) throw new Error("no stats");
      const ctx = await week_context_nflv(cfg, week, opts.refresh).catch(() => ({}));
      await nflv_games(season).catch(() => null);                      // the schedule's rest days, for the card (kept a day)
      const proj = our_projections(cfg, seasons, season, E.load_player_status(), week, weekly);
      let kdef = false;
      if (kdef_slots(E.P.values && E.P.values.league).length) {             // kickers and defenses, for a league that starts them (2026-10-19)
        try { merge_kdef(seasons, weekly, await kdef_stats(season, week), season); Object.assign(proj, kdef_projections(cfg, seasons, weekly, season, week, ctx, E.load_player_status())); kdef = true; }
        catch (e) { /* offline: they show without numbers */ }
      }
      return { season, week, proj, ctx, seasons, weekly, trends: Object.keys(weekly).length ? team_trends(cfg, weekly) : null,
        status: E.load_player_status(), ours: true, kdef };
    } catch (e) {
      return { season, week, proj: {}, ctx: {}, seasons: {}, weekly: {}, trends: null, status: E.load_player_status(), valuesOnly: true };
    }
  }
  const week = opts.week || await current_nfl_week(season);
  const [, , proj, ctx] = await Promise.all([
    refresh_stats(cfg).catch(() => null),
    Store.get("player_status.json") ? null : E.refresh_player_status().catch(() => null),
    week_projections(cfg, week, opts.refresh).catch(() => ({})),
    week_context(cfg, week, opts.refresh).catch(() => ({})),
  ]);
  const [seasons, weekly] = load_stats(cfg);
  return { season, week, proj: proj || {}, ctx: ctx || {}, seasons, weekly, trends: Object.keys(weekly).length ? team_trends(cfg, weekly) : null, status: E.load_player_status() };
}

// ---------------------------------------------------------------------------
// League power rankings (2026-10-15): every team ranked by overall value, starting lineup value, each position's total
// value and the picks it holds, with its record and the app's read of its direction.
// ---------------------------------------------------------------------------
const TIER_LABEL = { contending: "Contender", "in between": "In between", rebuilding: "Rebuilding", "in the hunt": "In the hunt", "long shot": "Long shot" };
/* "Our rank" (2026-10-16): one power score a team from what it has done and what it fields now. Results are points per
   game, the all-play record (each week's score against every other team's, so a lucky schedule counts for nothing) and
   the real record; now is the best lineup's value for this season. Results count more as games are played (g/(g+4),
   at most 70%), so week 1 leans on the lineup. Dynasty adds the whole roster with picks at 20%. Shown as 0-100: the
   team's place in the league's spread (50 is the middle). */
const PR_RESULTS = { ppg: 0.45, allplay: 0.35, record: 0.2 }, PR_RESULTS_MAX = 0.7, PR_FUTURE = 0.2;
function all_play(lg, g) {
  const out = {};
  for (const [wk, rows] of Object.entries(lg.schedule || {})) {
    if (parseInt(wk, 10) > g) continue;
    const pts = rows.map(r => [String(r[0]), parseFloat(r[2]) || 0]);
    if (!pts.some(([, p]) => p > 0)) continue;                       // a week not played yet
    for (const [rid, p] of pts) {
      const o = out[rid] = out[rid] || { w: 0, g: 0 };
      for (const [r2, p2] of pts) if (r2 !== rid) { o.g++; o.w += p > p2 ? 1 : p === p2 ? 0.5 : 0; }
    }
  }
  return out;
}
const zs = xs => { const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length)) || 1; return xs.map(x => (x - m) / sd); };
function power_rankings(values, cfg) {
  const prof = team_profiles(values, cfg).teams, rd = is_redraft(cfg);
  const rows = prof.map(I => {
    const by = Object.fromEntries(POSITIONS.map(p => [p, I.players.filter(a => a.pos === p).reduce((s, a) => s + a.value, 0)]));
    const picks = rd ? 0 : I.assets.filter(a => a.is_pick).reduce((s, a) => s + a.value, 0);
    return { rid: I.t.roster_id, team: I.t.team_name, owner: I.t.owner || "", record: I.t.record || "0-0", place: I.place, mode: I.mode, tier: TIER_LABEL[I.mode] || I.mode,
      vals: Object.assign({ overall: I.total + picks, starters: E.best_lineup(I.players, values.league.roster_positions_starters || cfg.league.starters).total }, by, rd ? {} : { picks }) };
  });
  const cols = ["overall", "starters"].concat(POSITIONS, rd ? [] : ["picks"]);
  // Our rank, points and the projection (2026-10-16)
  // weeks, not games: a league that also plays the median books two results a week
  const gg = Math.max(0, ...prof.map(I => I.r.g)), per = E.league_median(values.league, gg) ? 2 : 1, g = Math.floor(gg / per), AP = all_play(values.league, g);
  const ppg = prof.map(I => (I.r.g ? (I.t.points_for || 0) / (I.r.g / per) : 0));
  const ap = prof.map(I => { const a = AP[String(I.t.roster_id)]; return a && a.g ? a.w / a.g : 0.5; });
  const zp = zs(ppg), za = zs(ap), zw = zs(prof.map(I => I.r.pct)), zl = zs(rows.map(r => r.vals.starters)), zo = zs(rows.map(r => r.vals.overall));
  const wr = g ? Math.min(PR_RESULTS_MAX, g / (g + 4)) : 0;
  const raw = rows.map((r, i) => {
    const now = wr * (PR_RESULTS.ppg * zp[i] + PR_RESULTS.allplay * za[i] + PR_RESULTS.record * zw[i]) + (1 - wr) * zl[i];
    return rd ? now : (1 - PR_FUTURE) * now + PR_FUTURE * zo[i];
  });
  const zr = zs(raw);
  let PJ = null;
  try { PJ = E.project_standings(values, cfg); } catch (e) { PJ = null; }
  const regEnd = (parseInt(values.league.playoff_week_start, 10) || 15) - 1;
  rows.forEach((r, i) => {
    const I = prof[i];
    r.power = Math.round(100 * normal_cdf(zr[i]));
    r.pf = I.t.points_for || 0; r.ppg = ppg[i]; r.allplay = ap[i];
    r.vals.power = raw[i]; r.vals.points = r.pf;
    const p = PJ && PJ.by[I.t.roster_id];
    if (p) {
      const ties = Math.max(0, I.r.g - I.r.w - I.r.l), W = Math.round(p.wins), L = Math.max(0, regEnd * per - ties - W);
      r.proj = { wins: p.wins, record: `${W}-${L}${ties ? "-" + ties : ""}`, playoff: p.playoff, title: p.title || 0 };
      r.vals.proj = p.wins + p.playoff / 100 + (p.title || 0) / 1000;     // more wins first, then playoff and title odds
    }
  });
  const ranked = cols.concat(["power", "points"], PJ ? ["proj"] : []);
  for (const c of ranked) {
    const order = rows.slice().sort((a, b) => (b.vals[c] || 0) - (a.vals[c] || 0));
    order.forEach((r, i) => { r.rank = r.rank || {}; r.rank[c] = i + 1; });
  }
  rows.sort((a, b) => a.rank.power - b.rank.power);
  return { rows, cols, n: rows.length, redraft: rd, games: g, hasProj: !!PJ, weeksLeft: PJ ? PJ.weeks_left : 0 };
}
// ---------------------------------------------------------------------------
// Live win probability (2026-10-13): Sleeper's live matchup points plus our projection for what is left to play.
// ---------------------------------------------------------------------------
const GAME_HOURS = 3.25, LIVE_SD = 0.55;                   // a game's length on the clock; the spread of what is left, as a share of the projection
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
const normal_cdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
/* How much of a team's game is played, by the clock: 0 before kickoff, 1 after. */
function played_share(ctx, team, now) {
  const c = ctx && ctx[team]; if (!c || !c.kickoff) return null;
  const t = new Date(c.kickoff).getTime(); if (isNaN(t)) return null;
  return Math.max(0, Math.min(1, (now - t) / (GAME_HOURS * 3600000)));
}
async function live_matchup(values, cfg, W, team) {
  const lg = values.league; if (!lg || !lg.league_id || !W || !W.week || W.valuesOnly) return null;
  const mus = await Net.json(`${E.SLEEPER_URL}/league/${lg.league_id}/matchups/${W.week}`, null, 30000).catch(() => null);
  if (!Array.isArray(mus)) return null;
  const mine = mus.find(m => m.roster_id === team.roster_id); if (!mine || mine.matchup_id == null) return null;
  const opp = mus.find(m => m.matchup_id === mine.matchup_id && m.roster_id !== team.roster_id); if (!opp) return null;
  const now = Date.now(), ctx = W.ctx || {};
  const side = m => {
    const starters = (m.starters || []).filter(s => s && s !== "0"), pp = m.players_points || {}, sp = m.starters_points || [];
    let mean = 0, varc = 0, done = 0, left = 0, playing = 0;
    starters.forEach((sid, i) => {
      const actual = parseFloat(pp[sid] != null ? pp[sid] : (sp[i] != null ? sp[i] : 0)) || 0;
      const a = values.by_sleeper[sid], tm = a ? a.team : (lg.players[sid] || {}).team, f = played_share(ctx, tm, now);
      const proj = (W.proj[sid] && parseFloat(W.proj[sid].pts)) || (a && POSITIONS.includes(a.pos) ? 0 : 0);
      const share = f === null ? (actual > 0 ? 1 : 0) : f;                           // no game in the context: a bye, or a kicker/defense without a projection
      const rest = (1 - share) * proj;
      mean += actual + rest; varc += Math.pow(LIVE_SD * rest, 2);
      if (share >= 1) done++; else if (share > 0) playing++; else left++;
    });
    return { mean, sd: Math.sqrt(varc), actual: parseFloat(m.points || 0), done, playing, left, n: starters.length };
  };
  const A = side(mine), B = side(opp), sd = Math.sqrt(A.sd * A.sd + B.sd * B.sd);
  const p = sd > 0 ? normal_cdf((A.mean - B.mean) / sd) : (A.mean > B.mean ? 1 : A.mean < B.mean ? 0 : 0.5);
  const oppTeam = lg.teams.find(t => t.roster_id === opp.roster_id);
  return { week: W.week, p, me: A, them: B, opponent: oppTeam ? oppTeam.team_name : `Roster ${opp.roster_id}`, final: A.playing === 0 && A.left === 0 && B.playing === 0 && B.left === 0, started: A.done + A.playing + B.done + B.playing > 0 };
}
// ---------------------------------------------------------------------------
// Lineup helper
// ---------------------------------------------------------------------------
/* A star: a top name by value (the first three tiers, or the top of his position). The lineup help never sits one
   for a lesser player, and his weekly grade never reads Sit; only being out, on IR, on bye or without a team does that. */
const STAR_RANK = { QB: 12, RB: 12, WR: 15, TE: 6 }, STAR_LOCK = 1000;   // QB 8 -> 12 on the 13-season repeat rates (tools/values/fit_tiers.py, 2026-10-13)
const is_star = a => !!a && !a.unranked && !a.is_pick && ((a.tier || 9) <= 3 || (a.pos_rank || 99) <= (STAR_RANK[a.pos] || 0));
function lineup_helper(values, cfg, team, W, aggressiveness = 0.6) {
  const lg = values.league, proj = W.proj, ctx = W.ctx, trends = W.trends, pstatus = W.status;
  const all_slots = (lg.roster_positions || []).filter(p => !["BN", "IR", "TAXI"].includes(p));
  const ours = all_slots.filter(p => POSITIONS.includes(p) || E.FLEX_ELIGIBLE[p]);
  const rows = {};
  for (const a of team_assets(values, cfg, team)) {
    if (a.is_pick || !POSITIONS.includes(a.pos)) continue;                  // kickers and defenses get their own rows below
    const sid = a.sleeper_id || "", p = proj[sid] || {};
    const inj = p.injury || (lg.players[sid] || {}).injury || (pstatus[sid] || {}).inj || null;
    // Our projections carry no opponent, so the week's games say who plays: no NFL team (Tyreek Hill, 2026-10-05) or a
    // team without a game this week means no points, whatever his season average says.
    const hasCtx = Object.keys(ctx || {}).length > 0, noTeam = !a.team || a.team === "FA";
    const game = !noTeam && ctx ? ctx[a.team] : null, idle = noTeam || (hasCtx && p.ours && !game);
    const base = idle ? 0 : parseFloat(p.pts || 0), out = INJURY_OUT.has(inj), bye = idle ? !noTeam : (!p.opp && base === 0);
    const [adj, reasons] = base > 0 ? adjust_projection(base, a.pos, a.team || "FA", ctx, trends, aggressiveness) : [0.0, []];
    const ours0 = base > 0 && typeof Predict !== "undefined" ? Predict.week_points(a, W, cfg) : null, oursL = ours0 != null ? Predict.to_league(ours0, a, cfg) : null;
    if (oursL != null) reasons.push(`our model ${oursL.toFixed(1)}`);
    const blended = oursL != null ? 0.5 * adj + 0.5 * oursL : adj;
    rows[a.id] = { asset: a, base: out ? 0 : base, pts: out ? 0 : blended, opp: p.opp || (game ? game.opp : undefined), injury: inj, out, bye, noTeam, reasons };
  }
  const R = Object.values(rows);
  // keep whoever starts now unless the bench is clearly better (half a point): a 6.2-for-6.2 swap is noise, and a bench
  // player projected for nothing never replaces a starter projected for nothing (the user's rule, 2026-10-07)
  // The user's rule (2026-10-12): the top players start unless a change is clear-cut. Projections are noisy, so a
  // bench player needs a real margin over whoever starts now (a point, or a tenth of his number) and a much bigger one
  // over a star: a top name by value (the first two tiers, or the first few at his position) who is healthy and playing
  // stays in, and a star on the bench comes in, unless the other man beats him by three and a half points or a quarter.
  // Stars are locked in (the user's rule, 2026-10-12): a star who is healthy and has a game is never benched for a
  // lesser player, whatever the projections say this week; only another star with the higher number takes his slot.
  // Out, IR, bye and no team are the exceptions. A lesser current starter keeps a smaller edge against the bench.
  const starting = new Set((team.starters || []).map(String));
  const edge = a => {
    const r = rows[a.id] || {};
    if (!(a._pts > 0) || r.out || r.bye || r.noTeam) return 0;
    return (is_star(a) ? STAR_LOCK : 0) + (starting.has(String(a.sleeper_id || "")) ? Math.max(1, 0.1 * a._pts) : 0);
  };
  const keep = a => a._pts + edge(a);
  const rec = best_lineup_by(R.map(r => Object.assign({}, r.asset, { _pts: r.pts })), ours, keep);
  const base_rec = best_lineup_by(R.map(r => Object.assign({}, r.asset, { _pts: r.base })), ours, keep);
  const base_names = new Set(base_rec.starters.filter(([, p]) => p).map(([, p]) => p.name));
  const cur_pairs = all_slots.map((slot, i) => [slot, (team.starters || [])[i]]).filter(([slot, pid]) => pid !== undefined && ours.includes(slot));
  const by_sid = {};
  for (const r of R) if (r.asset.sleeper_id) by_sid[r.asset.sleeper_id] = r;
  const empty = () => ({ name: "(empty)", pos: "", pts: 0, base: 0, opp: null, injury: null, flag: "", reasons: [], bold: false });
  const describe = a => {
    if (!a) return empty();
    const r = rows[a.id] || by_sid[a.sleeper_id] || { pts: 0, base: 0, opp: null, injury: null, out: false, bye: false, reasons: [] };
    const flag = r.out ? "OUT" : (r.noTeam ? "NO TEAM" : (r.bye ? "BYE" : (r.injury === "Questionable" ? "Q" : "")));
    return { id: a.id, name: a.name, pos: a.pos, team: a.team, pts: r.pts, base: r.base, opp: r.opp, injury: r.injury, flag, reasons: r.reasons || [], bold: false };
  };
  const recommended = rec.starters.map(([slot, a]) => Object.assign(describe(a), { slot, bold: !!a && !base_names.has(a.name) }));
  const current = cur_pairs.map(([slot, pid]) => Object.assign(describe(values.by_sleeper[pid]), { slot }));
  let def_suggestion = null, def_options = [], k_suggestion = null;
  if (all_slots.includes("DEF") && kdef_ready(W)) {
    const defenses = defense_streamers(values, cfg, W);
    const by_team = Object.fromEntries(defenses.map(r => [r.team, r]));
    const mine_ids = team.players.filter(pid => NFL_TEAMS.includes(pid));
    const mine = mine_ids.filter(t => by_team[t]).map(t => by_team[t]).sort((a, b) => b.adj - a.adj);
    const def_row = (r, flag = "") => r ? { slot: "DEF", name: r.team + " defense", pos: "DEF", pts: r.adj, base: r.base, opp: (r.home === false ? "@" : "") + (r.opp || "?"),
      injury: null, flag, reasons: r.why.split(", ").filter(x => x && x !== "neutral matchup"), bold: false, pid: r.team } : Object.assign(empty(), { slot: "DEF", flag });
    const best = mine[0] || null;
    const rec_def = def_row(best, best || !mine_ids.length ? "" : "BYE");
    if (!best && mine_ids.length) { rec_def.name = mine_ids[0] + " defense"; rec_def.pos = "DEF"; }
    rec_def.bold = !!(best && mine.length > 1 && mine.reduce((m, r) => r.base > m.base ? r : m).team !== best.team);
    recommended.push(rec_def);
    if (cur_pairs.length) {
      const di = all_slots.indexOf("DEF"), cur_id = (team.starters || [])[di];
      const cur_r = NFL_TEAMS.includes(cur_id) ? by_team[cur_id] : null;
      const cd = def_row(cur_r, cur_r ? "" : (NFL_TEAMS.includes(cur_id) ? "BYE" : ""));
      if (!cur_r && NFL_TEAMS.includes(cur_id)) { cd.name = cur_id + " defense"; cd.pos = "DEF"; }
      current.push(cd);
    }
    const free = defenses.filter(r => !r.owner);
    def_options = free.slice(0, 4);
    const my_adj = best ? best.adj : 0;
    if (free.length && (!best || free[0].adj - my_adj >= 1.5)) {
      const f0 = free[0], weakest = mine.length ? mine.reduce((m, r) => r.adj < m.adj ? r : m) : null;
      const drop = weakest ? `; drop ${weakest.team} defense (${weakest.adj.toFixed(1)})` : (mine_ids.length ? `; drop ${mine_ids[0]} defense (bye)` : "");
      const why = !mine_ids.length ? "your DEF slot is empty" : (!best ? "your defense is on bye" : `+${(f0.adj - my_adj).toFixed(1)} pts over ${best.team}`);
      def_suggestion = { add: f0.team, adj: f0.adj, opp: f0.opp, why: f0.why, drop: weakest ? weakest.team : (mine_ids[0] || null),
        text: `Defense to add: ${f0.team} (${f0.adj.toFixed(1)} adj vs ${f0.opp}: ${f0.why}) - ${why}${drop}` };
    }
  } else if (all_slots.includes("DEF")) {
    // our own projections carry no defenses: the one held shows in its slot with its game, and no streamer is picked
    const mine_ids = team.players.filter(pid => NFL_TEAMS.includes(pid)), hasCtx = Object.keys(ctx || {}).length > 0;
    const row = tm => { const c = (ctx || {})[tm] || null; return { slot: "DEF", name: tm + " defense", pos: "DEF", pts: 0, base: 0, opp: c ? (c.home === false ? "@" : "") + (c.opp || "?") : null,
      injury: null, flag: hasCtx && !c ? "BYE" : "", reasons: [], bold: false, pid: tm }; };
    recommended.push(mine_ids.length ? row(mine_ids[0]) : Object.assign(empty(), { slot: "DEF" }));
    if (cur_pairs.length) { const di = all_slots.indexOf("DEF"), cur = (team.starters || [])[di]; current.push(NFL_TEAMS.includes(cur) ? row(cur) : Object.assign(empty(), { slot: "DEF" })); }
  }
  if (all_slots.includes("K")) {
    const lgp = lg.players || {}, rostered = new Set(lg.teams.flatMap(t => t.players));
    const k_row = pid => {
      const p = proj[pid] || {}, info = lgp[pid] || {}, name = info.name || p.name || `kicker ${pid}`, base = parseFloat(p.pts || 0);
      const c = (ctx || {})[info.team || p.team || ""] || null, hasCtx = Object.keys(ctx || {}).length > 0;
      if (base <= 0) {                                        // no projection: on bye when his team has no game, else just no number (our projections carry no kickers)
        const bye = hasCtx ? !c : !W.ours;
        return { slot: "K", name, pos: "K", pts: 0, base: 0, opp: c ? (c.home === false ? "@" : "") + (c.opp || "?") : null, injury: null, flag: bye ? "BYE" : "", reasons: [], bold: false, pid };
      }
      let mult = 1.0;
      const why = [];
      if (c && !c.indoor) {
        const wx = (c.weather || "").toLowerCase();
        if (WET.some(k => wx.includes(k)) || (isNum(c.gust) && c.gust >= 20)) { mult *= 0.92; why.push("weather -8%"); }
      }
      if (c) { mult *= c.home ? 1.02 : 0.98; why.push(c.home ? "home +2%" : "away -2%"); }
      return { slot: "K", name, pos: "K", pts: base * (1 + aggressiveness * (mult - 1)), base, opp: p.opp, injury: null, flag: "", reasons: why, bold: false, pid };
    };
    const mine_k = team.players.filter(pid => (lgp[pid] || {}).pos === "K" || (proj[pid] || {}).pos === "K").map(k_row);
    const playing = mine_k.filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts);
    recommended.push(playing[0] || mine_k[0] || Object.assign(empty(), { slot: "K" }));
    if (cur_pairs.length) {
      const ki = all_slots.indexOf("K"), cur = (team.starters || [])[ki];
      current.push(cur && cur !== "0" ? k_row(cur) : Object.assign(empty(), { slot: "K" }));
    }
    if (!playing.length) {
      const free_k = Object.entries(proj).filter(([pid, p]) => p.pos === "K" && !rostered.has(pid) && (p.pts || 0) > 0).sort((a, b) => b[1].pts - a[1].pts).slice(0, 3);
      if (free_k.length) k_suggestion = "Kicker to add: " + free_k.map(([pid, p]) => `${p.name || pid} (${p.pts.toFixed(1)} proj vs ${p.opp || "?"})`).join(", ") + (mine_k.length ? " - yours is on bye" : " - your K slot is empty");
    }
  }
  const sum = (l, k) => l.reduce((s, x) => s + x[k], 0);
  // a player projected for 0.0 is never a recommendation (the user's rule, 2026-10-07): if the best lineup put one in a
  // slot, the player starting there now stays, and no "start him" line is written for a zero
  for (let i = 0; i < recommended.length; i++) {
    const r = recommended[i];
    if (r.name === "(empty)" || r.pts > 0) continue;
    const cur = current.find(c => c.slot === r.slot && c.name !== "(empty)" && !recommended.some((o, j) => j !== i && o.name === c.name));
    if (cur) recommended[i] = Object.assign({}, cur, { slot: r.slot, bold: false });
  }
  const rec_names = new Set(recommended.map(x => x.name)), cur_names = new Set(current.map(x => x.name));
  const changes = [];
  for (const x of current) if (!rec_names.has(x.name) && x.name !== "(empty)") changes.push({ action: "bench", name: x.name, pts: x.pts, flag: x.flag });
  // each "start" names the player he replaces: whoever held that slot, else a benched player at his position, else one a flex could take
  const benched = current.filter(x => !rec_names.has(x.name) && x.name !== "(empty)"), used = new Set();
  const partner = x => { const ok = c => !used.has(c.name); const elig = E.FLEX_ELIGIBLE[String(x.slot).toUpperCase()] || [x.pos];
    return benched.find(c => ok(c) && c.slot === x.slot) || benched.find(c => ok(c) && c.pos === x.pos) || benched.find(c => ok(c) && elig.includes(c.pos)) || null; };
  for (const x of recommended) if (!cur_names.has(x.name) && x.name !== "(empty)" && x.pts > 0) {
    const b = partner(x); if (b) used.add(b.name);
    changes.push({ action: "start", name: x.name, pts: x.pts, slot: x.slot, flag: x.flag, bold: x.bold, instead: b ? { name: b.name, pts: b.pts, flag: b.flag } : null });
  }
  const flags = current.filter(x => x.flag === "OUT" || x.flag === "BYE").map(x => `${x.name} is ${x.flag} in your current lineup (${x.slot})`)
    .concat(recommended.filter(x => x.flag === "Q").map(x => `${x.name} is questionable (${x.slot})`))
    .concat(recommended.filter(x => x.name === "(empty)").map(x => `${x.slot} is empty`));
  const notes = [];
  if (is_bestball(cfg)) notes.push("Best ball league: the platform starts your best scorers automatically, so roster moves matter more than the slots.");
  if (trends && trends.weeks >= 3 && Math.abs(trends.pace - 1) >= 0.03) notes.push(`League scoring the last two weeks is ${trends.pace >= 1 ? "+" : ""}${Math.round((trends.pace - 1) * 100)}% vs the season average.`);
  if (!Object.keys(ctx || {}).length) notes.push("Game context (home/away, weather, lines) was not available; base projections only.");
  if (def_suggestion) notes.push(def_suggestion.text);
  if (k_suggestion) notes.push(k_suggestion);
  const rec_total = sum(recommended, "pts"), cur_total = sum(current, "pts");
  return { week: W.week, team: team.team_name, recommended, current, rec_total, rec_base: sum(recommended, "base"), cur_total, gain: rec_total - cur_total,
    changes, flags, notes, has_current: cur_pairs.length > 0, bold_count: recommended.filter(x => x.bold).length, def_suggestion, def_options, k_suggestion };
}

/* Play edition lineup: the best starters by this-season value, compared with the lineup set on Sleeper. */
function lineup_by_value(values, cfg, team, W) {
  const lg = values.league, status = W.status || {};
  const all_slots = (lg.roster_positions || []).filter(p => !["BN", "IR", "TAXI"].includes(p));
  const ours = all_slots.filter(p => POSITIONS.includes(p) || E.FLEX_ELIGIBLE[p]);
  const flagOf = a => { const inj = (status[a.sleeper_id || ""] || {}).inj || (lg.players[a.sleeper_id || ""] || {}).injury; return INJURY_OUT.has(inj) ? "OUT" : (inj === "Questionable" ? "Q" : ""); };
  const score = a => flagOf(a) === "OUT" ? 0 : E.lineup_value(a);
  const starting = new Set((team.starters || []).map(String));
  const rank = a => score(a) + (starting.has(a.sleeper_id || "") ? 0.5 : 0);   // on a tie, keep who already starts
  const roster = team_assets(values, cfg, team).filter(a => !a.is_pick);
  const rec = best_lineup_by(roster, ours, rank);
  const row = (slot, a) => a ? { id: a.id, slot, name: a.name, pos: a.pos, team: a.team, pts: score(a), base: score(a), opp: null, flag: flagOf(a), reasons: [], bold: false }
    : { slot, name: "(empty)", pos: "", pts: 0, base: 0, opp: null, flag: "", reasons: [], bold: false };
  const recommended = rec.starters.map(([slot, a]) => row(slot, a));
  const cur_pairs = all_slots.map((slot, i) => [slot, (team.starters || [])[i]]).filter(([slot, pid]) => pid !== undefined && ours.includes(slot));
  const current = cur_pairs.map(([slot, pid]) => row(slot, values.by_sleeper[pid]));
  const rn = new Set(recommended.map(x => x.name)), cn = new Set(current.map(x => x.name)), changes = [];
  for (const x of current) if (!rn.has(x.name) && x.name !== "(empty)") changes.push({ action: "bench", name: x.name, pts: x.pts, flag: x.flag });
  for (const x of recommended) if (!cn.has(x.name) && x.name !== "(empty)") changes.push({ action: "start", name: x.name, pts: x.pts, slot: x.slot, flag: x.flag });
  const sum = l => l.reduce((t, x) => t + x.pts, 0);
  return { week: W.week, team: team.team_name, recommended, current, rec_total: sum(recommended), cur_total: sum(current), gain: sum(recommended) - sum(current),
    changes, flags: recommended.filter(x => x.name === "(empty)").map(x => `${x.slot} is empty`), notes: [], has_current: cur_pairs.length > 0, valuesOnly: true, def_options: [] };
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------
function free_agents(values, cfg, W) {
  const lg = values.league;
  const rostered_ids = new Set(lg.teams.flatMap(t => t.players));
  const rostered_keys = new Set(Object.values(lg.players).map(p => norm(p.name) + "|" + (p.pos || "?")));
  const free = a => !rostered_ids.has(a.sleeper_id || "") && !rostered_keys.has(norm(a.name) + "|" + a.pos);
  const out = values.players.filter(a => !a.unranked && a.value > 0 && free(a));
  const seen = new Set(out.map(a => a.sleeper_id).concat(out.map(a => norm(a.name) + "|" + a.pos)));
  const cur = (W.seasons || {})[parseInt(cfg.season)] || {};
  for (const [sid, row] of Object.entries(cur)) {
    const pos = row.pos;
    if (!POSITIONS.includes(pos) || seen.has(sid) || rostered_ids.has(sid)) continue;
    const key = norm(row.name || "") + "|" + pos;
    if (rostered_keys.has(key) || seen.has(key)) continue;
    out.push(make_player("sl" + sid, row.name || sid, pos, row.team, null, 0, 0, null, null, null, sid, true));
    seen.add(sid);
  }
  return out;
}

function waiver_metric(values, cfg, W) {
  const season = parseInt(cfg.season), proj = W.proj, cur = W.seasons[season] || {}, weekly = W.weekly;
  const last_weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b).slice(-3);
  const all_weeks = Object.keys(weekly).map(Number);
  const status = W.status, ctx = W.ctx, hasCtx = Object.keys(ctx || {}).length > 0;
  const lg_players = (values.league || {}).players || {};
  const pk = pts_key(cfg), redraft = is_redraft(cfg), cache = new Map();
  const parts = a => {
    if (cache.has(a.id)) return cache.get(a.id);
    const sid = a.sleeper_id || "", r = cur[sid];
    const ppg = r && r.gp ? parseFloat(r[pk] || 0) / parseFloat(r.gp) : null;
    // recent form: the last three games with the best one left out (a one-off big game has to be done twice to count)
    const played = last_weeks.filter(w => sid in weekly[w]).map(w => parseFloat((weekly[w][sid] || {})[pk] || 0)).sort((x, y) => y - x);
    const trimmed = played.length >= 3 ? played.slice(1) : played;
    const last2 = trimmed.length ? trimmed.reduce((s, x) => s + x, 0) / trimmed.length : null;
    const games = all_weeks.filter(w => sid in weekly[w]).map(w => parseFloat((weekly[w][sid] || {})[pk] || 0)).sort((x, y) => y - x);
    const rest = games.slice(1), restAvg = rest.length ? rest.reduce((s, x) => s + x, 0) / rest.length : 0;
    const lastRow = (W.seasons[season - 1] || {})[sid], ppg_last = lastRow && lastRow.gp >= 8 ? parseFloat(lastRow[pk] || 0) / lastRow.gp : null;
    const spiky = (games.length === 1 && games[0] >= 5) || (games.length >= 2 && games.length <= 5 && games[0] >= 15 && games[0] >= 2.2 * Math.max(3, restAvg));   // one game carries his numbers
    const ppg_trim = rest.length ? restAvg : null;
    const p = proj[sid] || null;
    let pj = p ? parseFloat(p.pts || 0) : null;
    const bye = hasCtx && !((a.team || "FA") in ctx);
    if (pj === null && hasCtx && !bye) pj = 0.0;
    if (bye && pj !== null) pj = 0.0;                           // no game this week: the projection is zero, whatever his average says
    if (W.valuesOnly) pj = null;
    const st = status[sid] || {};
    const inj = st.inj || (p || {}).injury || (lg_players[sid] || {}).injury || null;
    const depth = st.depth ?? null;
    let prod = 0, wsum = 0;
    if (ppg !== null) { prod += 0.45 * ppg; wsum += 0.45; }
    if (last2 !== null) { prod += 0.35 * last2; wsum += 0.35; }
    if (pj !== null) { prod += 0.20 * pj; wsum += 0.20; }
    prod = wsum ? prod / wsum : 0;
    // one game is one game: a player with a single game and no prior season is capped at a typical starter's number;
    // a player whose numbers rest on one big game is regressed halfway to his other games
    const gp0 = Math.max(games.length, r && r.gp ? parseFloat(r.gp) : 0);   // games this season, from the weekly rows or the season total
    if (gp0 > 0 && gp0 <= 1 && ppg_last == null) prod = Math.min(prod, POS_TYPICAL[a.pos] || 8);
    else if (spiky && ppg_trim != null) prod = 0.5 * prod + 0.5 * ppg_trim;
    if (W.valuesOnly) prod = E.lineup_value(a) / 170;        // no stats: this-season value on the same scale (the dynasty mix is 0.45·prod·170)
    let avail = 1.0, flags = [];
    if (inj === "Doubtful") { avail = redraft ? 0.5 : 0.85; flags = ["DOUBTFUL"]; }
    else if (INJURY_OUT.has(inj)) { avail = redraft ? 0.15 : 0.6; flags = [String(inj).toUpperCase()]; }
    else if (inj === "Questionable") { avail = redraft ? 0.9 : 1.0; flags = ["Q"]; }
    if (!a.team || a.team === "FA") { avail *= 0.1; flags.push("NO TEAM"); }     // unsigned: nothing to pick up, the first to drop
    if (depth !== null && prod < 4 && ((a.pos === "QB" && depth >= 2) || (a.pos !== "QB" && depth >= 3))) { avail *= 0.6; flags.push(`${ordinal(depth)} on the depth chart`); }
    // dynasty: long-term value plus this season's points; best ball leans further on value (the lineup sets itself)
    const wv = is_bestball(cfg) ? 0.75 : 0.55;
    const score = redraft ? prod * avail : (wv * a.value + (1 - wv) * prod * 170) * avail;
    const out = { score, prod, ppg, last2, proj: p ? pj : null, inj, depth, flags, bye, no_proj: !p && !bye, spiky, best: games[0] || 0, ppg_trim, ppg_last, games_this: games.length, gp: gp0 };
    cache.set(a.id, out);
    return out;
  };
  const metric = a => parts(a).score;
  parts.text = a => {
    const q = parts(a), bits = [];
    if (q.ppg !== null) bits.push(`${q.ppg.toFixed(1)} ppg${q.gp > 0 && q.gp <= 3 ? ` (${q.gp} game${q.gp === 1 ? "" : "s"})` : ""}`);
    if (q.last2 !== null) bits.push(`${q.last2.toFixed(1)} recent`); else if (q.ppg !== null) bits.push("no game lately");
    if (q.spiky) bits.push(`one ${q.best.toFixed(0)}-point game`);
    if (q.proj) bits.push(`${q.proj.toFixed(1)} proj`); else if (q.bye) bits.push("bye"); else if (q.no_proj) bits.push("no projection this week");
    return bits.concat(q.flags).join(", ") || "no production yet";
  };
  return [metric, redraft ? "points (season ppg, recent form with the best game left out, this week)" : "value + production", parts];
}

const def_asset = ab => make_player("def" + ab, ab + " defense", "DEF", ab, null, 0, 0, null, null, null, ab, true);

function defense_streamers(values, cfg, W) {
  const lg = values.league, season = parseInt(cfg.season), proj = W.proj, ctx = W.ctx || {}, hasCtx = Object.keys(ctx).length > 0;
  const cur = W.seasons[season] || {}, trends = W.trends || {}, off_avg = trends.off_avg || {}, league_off = trends.league_off_avg || 0, pk = pts_key(cfg);
  const owner = {};
  for (const t of lg.teams) for (const pid of t.players) if (NFL_TEAMS.includes(pid)) owner[pid] = t.team_name;
  const rows = [];
  for (const ab of NFL_TEAMS) {
    const c = ctx[ab] || null;
    if (hasCtx && !c) continue;
    const p = proj[ab] || {};
    let base = parseFloat(p.pts || 0);
    const r = cur[ab], ppg = r && r.gp ? parseFloat(r[pk] || 0) / parseFloat(r.gp) : 0;
    if (base <= 0) base = ppg > 0 ? ppg : 6.5;
    let mult = 1.0;
    const why = [];
    const apply = (fct, text) => { if (Math.abs(fct - 1) >= 0.015) why.push(`${text} ${fct >= 1 ? "+" : ""}${Math.round((fct - 1) * 100)}%`); mult *= fct; };
    const cc = c || {}, opp = cc.opp || p.opp;
    if (opp && league_off && off_avg[opp]) apply(Math.max(0.85, Math.min(1.2, Math.pow(league_off / off_avg[opp], 0.5))), `${opp} offense` + (off_avg[opp] < league_off ? " weak" : " strong"));
    if (opp && (trends.trend || {})[opp]) { const t = trends.trend[opp]; apply(Math.max(0.9, Math.min(1.1, 1 / t)), `${opp} ` + (t < 1 ? "cooling off" : "hot lately")); }
    const sp = cc.spread;
    if (sp != null) apply(1 + Math.max(-14, Math.min(14, -sp)) * 0.014, sp < 0 ? `favored by ${-sp}` : `underdog by ${sp}`);
    if (cc.total != null && cc.implied != null) { const oi = cc.total - cc.implied; apply(Math.max(0.8, Math.min(1.25, Math.pow(LEAGUE_AVG_IMPLIED / Math.max(oi, 8), 0.8))), `${opp} implied ${oi.toFixed(1)} pts`); }
    if (c && !c.indoor) {
      const wx = (c.weather || "").toLowerCase(), precip = c.precip || 0;
      if (WET.some(k => wx.includes(k)) || (isNum(precip) && precip >= 50)) apply(1.06, c.weather || "wet weather");
      if (isNum(c.gust) && c.gust >= 20) apply(1.04, `wind ${c.gust.toFixed(0)} mph`);
      if (isNum(c.temp) && c.temp <= 25) apply(1.02, `${c.temp.toFixed(0)}F cold`);
    }
    if (c) apply(c.home ? 1.03 : 0.97, c.home ? "home" : "away");
    rows.push({ asset: def_asset(ab), team: ab, opp, home: c ? c.home : null, spread: sp ?? null, total: cc.total ?? null, weather: cc.indoor ? null : cc.weather,
      indoor: !!cc.indoor, base, ppg, adj: base * mult, why: why.join(", ") || "neutral matchup", owner: owner[ab] || null, week: W.week });
  }
  return rows.sort((a, b) => b.adj - a.adj);
}

/* A real role for a pickup: 2+ games this season with a starter's share of the work (opportunities a game: QB 20 pass
   attempts, RB 8 carries plus targets, WR 4 targets, TE 3 targets), or top three on his depth chart, or the platform
   chasing him (pickup_hype 0.3+). Kickers and defenses are judged elsewhere. */
const ROLE_OPPS = { QB: 20, RB: 8, WR: 4, TE: 3 };
function real_role(a, W) {
  if (!a || !POSITIONS.includes(a.pos)) return true;
  if (pickup_hype(a) >= 0.3) return true;
  const d = ((W.status || {})[String(a.sleeper_id || "")] || {}).depth;
  if (d != null && d <= 3) return true;
  const o = ((Store.get(`nflv_wk_${W.season}.json`) || {}).players || {})[E.player_key(a.name, a.pos)];
  if (!o || !o[3]) return false;
  const games = Object.values(o[3]);
  if (games.length < 2) return false;
  return games.reduce((s, g) => s + (g[2] || 0), 0) / games.length >= (ROLE_OPPS[a.pos] || 4);
}
function roster_moves(values, cfg, team, W, opts = {}) {
  const n = opts.n || 6, per_group = opts.per_group || 3;
  const lg = values.league, starters = lg.roster_positions_starters || cfg.league.starters;
  const fas = opts.fas || free_agents(values, cfg, W);
  const [metric, metric_name, parts] = opts.metric || waiver_metric(values, cfg, W);
  const roster = team_assets(values, cfg, team).filter(a => !a.is_pick);
  const lu = best_lineup_by(roster, starters, metric);
  const starter_ids = new Set(lu.starters.filter(([, p]) => p).map(([, p]) => p.id));
  const before = !is_redraft(cfg) ? lineup_total(lu, cfg) : lu.total;
  const actual = new Set((team.starters || []).map(String));                      // the players he is actually starting this week: never the drop
  const droppable = roster.filter(a => !starter_ids.has(a.id) && !actual.has(String(a.sleeper_id)) && POSITIONS.includes(a.pos)).sort((a, b) => metric(a) - metric(b));
  let picked = droppable.length ? _grouped_moves(values, cfg, roster, droppable, fas, metric, metric_name, parts, starters, before, per_group, n) : [];
  // no advice beats bad advice (the user's rule, 2026-10-13; raised 2026-10-15 after Reggie Virgil, WR5 with one game,
  // was suggested): a pickup is a move only with a real role. Two games with a real share of the work, or a top-three
  // spot on his depth chart, or the league chasing him. Deep stashes stay on the Best available board.
  if (W.week >= 2) picked = picked.filter(m => m.group === "DEF" || !m.add || real_role(m.add, W));
  if (kdef_ready(W) && (lg.roster_positions || []).includes("DEF")) picked = picked.concat(_defense_moves(team, opts.defenses || defense_streamers(values, cfg, W), per_group));
  if (kdef_ready(W) && (lg.roster_positions || []).includes("K")) picked = picked.concat(_kicker_moves(values, team, W));
  if (parseInt(lg.waiver_type || 0) === 2 && parseInt(lg.waiver_budget || 0) > 0) {
    const budget = parseInt(lg.waiver_budget);
    const minBid = lg.waiver_bid_min != null ? parseInt(lg.waiver_bid_min) : 0;
    for (const m of picked) Object.assign(m, faab_bid(m, budget, minBid, cfg, W.week, m.group === "DEF" || m.group === "K" ? null : parts(m.add)));
  }
  return picked;
}
/* Suggested FAAB bid, as a share of the season budget. Tuned on 2,298 winning claims in 15 real 12-team, $100 leagues
   (2021-2025): 60% of winning bids were $0 and 71% were $2 or less; players who became weekly starters usually went
   for $0-9 (one in ten above $27); only about a third of claims had a second bidder, and winners typically beat the
   next bid by $2-5; big bids ($20+) turned into regular starters only 13% of the time. So the bid follows what the
   player will score and how hard the league is chasing him, not his trade value: a bench add is $0-1; a player who
   would start is $1-7 by how far he sits above a replacement-level player (this week's projection and his recent
   games); the big money follows demand (Sleeper adds in the last 48 hours: 50k is a blip, 2M the week's top target,
   up to +25%). A player who hasn't played this season is $0-1 unless the league is chasing him. Superflex QBs who
   start get a third more; weeks 1-2 and the playoffs go cheap. (Trey Lance, no games, was $19 of $100, 2026-10-06.) */
const FAAB_REPL = E.DMV_REPLACEMENT;                   // a replacement-level player's points a game (half-PPR): the engine's table
function pickup_hype(a) {                                  // 0..1: how hard the whole platform is chasing him right now
  const tr = (a && a.trend48) || {}, adds = (tr.adds || 0) > (tr.drops || 0) ? tr.adds || 0 : 0;
  return adds >= 50000 ? Math.min(1, Math.log10(adds / 50000) / Math.log10(40)) : 0;
}
function faab_bid(m, budget, minBid, cfg, week, pa = null) {
  const pos = m.add.pos, sf = parseInt(cfg.league.num_qbs) >= 2, starts0 = (m.lineup_gain || 0) > 0;
  const bid = pct => ({ faab_pct: pct, faab: Math.max(minBid, Math.round(budget * pct)) });
  if (m.group === "DEF" || pos === "K" || pos === "DEF") return bid(starts0 ? 0.01 : 0);
  // what he'd score against a replacement-level player at his position: this week's projection and his recent games
  const repl = (FAAB_REPL[pos] || 6) * (pos === "QB" && sf ? 0.85 : 1);
  let exp = 0;
  if (pa) { const recent = pa.last2 ?? pa.ppg, pj = pa.proj != null && !pa.bye ? pa.proj : null; exp = pj != null && recent != null ? 0.5 * pj + 0.5 * recent : (pj ?? recent ?? 0); }
  const impact = Math.max(0, Math.min(1.5, (exp - repl) / repl)), hype = pickup_hype(m.add), played = !pa || (pa.gp || 0) > 0;
  const starts = starts0 && impact > 0;
  let pct = (starts ? 0.01 + 0.06 * impact : 0.005 + 0.02 * impact) + 0.25 * hype;
  if (!is_redraft(cfg) && m.add.age != null && m.add.age <= 24 && m.add.value >= 1000) pct += 0.02;   // dynasty: a young player with real value
  if (!played && hype < 0.3) pct = Math.min(pct, 0.01);                                      // nobody pays for a player who hasn't played, unless the league is chasing him
  let cap = 0.4;
  if (pos === "QB" && sf && starts) { pct *= 1.3; cap = 0.45; }                               // superflex QBs are where leagues spend
  if (week && (week <= 2 || week >= 14)) pct *= 0.6;                                          // early guesses and playoff weeks go cheap
  return bid(Math.min(cap, pct));
}
/* Why this add shouldn't replace this drop, or null. Shared by the suggested moves, the waiver check and the weak
   spots. A player who hasn't played this season replaces nobody of worth unless the league is chasing him (a return,
   a new starter) or the drop is dead weight; a player who is barely playing isn't worth a roster spot; a producing
   player isn't dropped for one producing less (dynasty: unless the add is a young player worth far more long-term).
   The user's rule, 2026-10-06. */
const SEASON_OUT = new Set(["IR", "PUP", "DNR", "NA", "Sus", "Suspended"]);
function pickup_guard(add, drop, pa, pd, metric, cfg) {
  const hype = pickup_hype(add) >= 0.19;                                                     // about 100k adds in 48 hours
  const sf = parseInt(cfg.league.num_qbs) >= 2, replOf = pos => (FAAB_REPL[pos] || 6) * (pos === "QB" && sf ? 0.85 : 1);
  const ra = replOf(add.pos), repl = replOf(drop.pos);
  const dead = !drop.team || (metric ? metric(drop) <= 0 : false) || (SEASON_OUT.has(pd.inj) && drop.value < 300);
  const role = !pa.bye && (pa.proj ?? 0) >= 1.25 * ra;                                      // this week's projection says he has a real job now (a backup made the starter)
  if ((pa.gp || 0) === 0 && !hype && !role && !dead) return `${add.name} hasn't played this season and nobody is chasing him on waivers. ${drop.name} is worth more than a player who hasn't shown anything.`;
  // a player who is barely playing isn't worth a roster spot yet (dynasty: unless he is a young stash worth half again the drop)
  const recent = Math.max(pa.ppg_trim ?? pa.ppg ?? 0, pa.last2 ?? 0);
  const stash = !is_redraft(cfg) && add.age != null && add.age <= 24 && add.value >= 1.5 * Math.max(drop.value || 0, 200);
  if ((pa.gp || 0) >= 1 && recent < 0.5 * ra && (pa.proj ?? 0) < ra && !hype && !stash && !dead) return `${add.name} is barely playing (${recent.toFixed(1)} a game, ${(pa.proj ?? 0).toFixed(1)} projected this week): not worth a roster spot yet.`;
  const producing = !SEASON_OUT.has(pd.inj) && (((pd.gp || 0) >= 2 && (pd.ppg ?? 0) >= 0.8 * repl) || (pd.ppg_last != null && pd.ppg_last >= (drop.pos === "QB" ? 14 : 8)));
  const ahead = (pa.ppg ?? 0) >= (pd.ppg ?? 0) * 0.9 || ((pd.proj ?? 0) > 0 && (pa.proj ?? 0) >= (pd.proj ?? 0) * 1.1);   // (a drop who is out or on bye projects 0: that is not the add being ahead)
  // dynasty may still swap a producing vet for a young player with much more long-term value: 25 or younger, and worth
  // twice as much, or half again as much while producing at least 60% of the vet's rate (Theo Johnson at 3.0 a game
  // and 1.8x the value was offered for Noah Fant at 9.5, 2026-10-06)
  const upgrade = !is_redraft(cfg) && add.age != null && add.age <= 25 && (add.value >= 2 * drop.value || (add.value >= 1.5 * drop.value && recent >= 0.6 * (pd.ppg ?? 0)));
  if (producing && !hype && !ahead && !upgrade) return `${drop.name} is producing (${(pd.ppg ?? 0).toFixed(1)} a game); ${add.name} isn't ahead of him.`;
  return null;
}
function _grouped_moves(values, cfg, roster, droppable, fas, metric, metric_name, parts, starters, before, per_group, n) {
  const pool = fas.slice().sort((a, b) => metric(b) - metric(a));
  const floor = is_redraft(cfg) ? 2.0 : 60.0;
  const moves = [];
  for (const [grp, poss] of WAIVER_GROUPS) {
    const g_drop = droppable.filter(a => poss.includes(a.pos)).slice(0, 10), g_pool = pool.filter(a => poss.includes(a.pos)).slice(0, 30);
    for (const add of g_pool) for (const drop of g_drop) {
      const m = _one_move(values, cfg, roster, add, drop, metric, metric_name, parts, starters, before, floor);
      if (m) { m.group = grp; moves.push(m); }
    }
  }
  moves.sort((a, b) => b.score - a.score);
  const out = [], used_add = new Set(), used_drop = new Set(), per = {};
  for (const m of moves) {
    if (used_add.has(m.add.id) || used_drop.has(m.drop.id) || (per[m.group] || 0) >= per_group) continue;
    used_add.add(m.add.id); used_drop.add(m.drop.id); per[m.group] = (per[m.group] || 0) + 1;
    out.push(m);
    if (out.length >= n) break;
  }
  const order = Object.fromEntries(WAIVER_GROUPS.map(([g], i) => [g, i]));
  return out.sort((a, b) => ((order[a.group] ?? 9) - (order[b.group] ?? 9)) || b.score - a.score);
}
function _defense_moves(team, defenses, per_group) {
  const mine = defenses.filter(r => team.players.includes(r.team)), free = defenses.filter(r => !r.owner), out = [];
  if (!free.length) return out;
  if (!mine.length) {
    const b = free[0];
    return [{ drop: null, add: b.asset, gain: b.adj, lineup_gain: 0, score: b.adj, group: "DEF", plain: "your defense slot is empty", why: `empty DEF slot; ${b.team} vs ${b.opp}: ${b.why}`, metric: `week ${b.week} adjusted pts`, drop_m: 0, add_m: b.adj }];
  }
  for (const cur of mine.slice().sort((a, b) => a.adj - b.adj)) {
    for (const b of free.slice(0, per_group)) {
      const gain = b.adj - cur.adj;
      if (gain < 1.5 || out.some(m => m.add.id === b.asset.id)) continue;
      out.push({ drop: cur.asset, add: b.asset, gain, lineup_gain: gain, score: gain * 3, group: "DEF", plain: `projects ${b.adj.toFixed(1)} ${b.home === false ? "at" : "vs"} ${b.opp}, yours ${cur.adj.toFixed(1)}`, why: `${b.team} vs ${b.opp}: ${b.why}`, metric: `week ${b.week} adjusted pts`, drop_m: cur.adj, add_m: b.adj });
      break;
    }
  }
  return out.slice(0, per_group);
}
/* A kicker to stream (2026-10-19): the best free kicker with a game, when yours has no game or he projects 2.5 points
   more (kickers swing a lot week to week: a smaller edge is noise); the weakest kicker you hold is the drop. */
function _kicker_moves(values, team, W) {
  const lg = values.league, lgp = lg.players || {}, rostered = new Set(lg.teams.flatMap(t => t.players.map(String)));
  const asset = (sid, p) => values.by_sleeper[sid] || make_player("sl" + sid, (p && p.name) || (lgp[sid] || {}).name || `kicker ${sid}`, "K", (p && p.team) || (lgp[sid] || {}).team || "FA", null, 0, 0, null, null, null, sid, true);
  const free = Object.entries(W.proj).filter(([sid, p]) => p.pos === "K" && p.pts > 0 && !rostered.has(sid)).sort((a, b) => b[1].pts - a[1].pts);
  if (!free.length) return [];
  const [fs, fp] = free[0];
  const mine = team.players.map(String).filter(pid => (lgp[pid] || {}).pos === "K" || (W.proj[pid] || {}).pos === "K").map(pid => [pid, (W.proj[pid] || {}).pts || 0]).sort((a, b) => b[1] - a[1]);
  const base = { add: asset(fs, fp), group: "K", metric: `week ${W.week} projected pts`, add_m: fp.pts };
  if (!mine.length) return [Object.assign(base, { drop: null, gain: fp.pts, lineup_gain: 0, score: fp.pts, plain: "your kicker slot is empty", why: `empty K slot; ${fp.name} ${fp.opp || ""}`.trim(), drop_m: 0 })];
  const best = mine[0][1], weakest = mine[mine.length - 1], gain = fp.pts - best;
  if (best > 0 && gain < 2.5) return [];
  return [Object.assign(base, { drop: asset(weakest[0], W.proj[weakest[0]]), gain, lineup_gain: gain, score: gain * 3,
    plain: best > 0 ? `projects ${fp.pts.toFixed(1)}, yours ${best.toFixed(1)}` : "your kicker has no game this week", why: `${fp.name} ${fp.opp || ""}: ${fp.pts.toFixed(1)} projected`, drop_m: weakest[1] })];
}
/* "Should I make this move?": one drop and one add, judged on the same rules as the pickup suggestions
   (_one_move): long-term value (dynasty), young talent, the lineup, and whether the add is playing.
   Returns { verdict, tone: good|close|meh|bad, reasons: [...], lineup_gain, faab } */
function waiver_check(values, cfg, team, drop, add, W, opts = {}) {
  const lg = values.league, starters = lg.roster_positions_starters || cfg.league.starters, redraft = is_redraft(cfg);
  const [metric, , parts] = opts.metric || waiver_metric(values, cfg, W);
  const roster = team_assets(values, cfg, team).filter(a => !a.is_pick);
  const lu = best_lineup_by(roster, starters, metric), before = !redraft ? lineup_total(lu, cfg) : lu.total;
  const la = best_lineup_by(roster.filter(a => a.id !== drop.id).concat([add]), starters, metric);
  const lu_gain = (!redraft ? lineup_total(la, cfg) : la.total) - before;
  const dropStarts = lu.starters.some(([, p]) => p && p.id === drop.id), addStarts = la.starters.some(([, p]) => p && p.id === add.id);
  const pa = parts(add), pd = parts(drop), stop = [], good = [], note = [];
  if (INJURY_OUT.has(pa.inj) && pa.inj !== "Doubtful") stop.push(`${add.name} can't play right now (${pa.inj}).`);
  if (opts.unavailable) stop.push(opts.unavailable);
  { const g = pickup_guard(add, drop, pa, pd, metric, cfg); if (g) stop.push(g); }
  if (drop.oscore != null && drop.oscore >= 57 && (add.oscore ?? 0) < drop.oscore)
    stop.push(`${drop.name} grades ${gradeLetter(drop.oscore)} and ${add.name} ${gradeLetter(add.oscore ?? 0)}. Don't drop a better player for a worse one, however he's starting the season.`);
  { const bar = drop.pos === "QB" ? 14 : 8;
    if (pd.ppg_last != null && pd.ppg_last >= bar && (pa.games_this || 0) < 4 && Math.max(pa.ppg_trim ?? 0, (pa.ppg ?? 0) * 0.8) < pd.ppg_last)
      stop.push(`${drop.name} averaged ${pd.ppg_last.toFixed(1)} a game last season. A slow start isn't a reason to drop him for ${add.name}, who has ${pa.games_this || 0} game${(pa.games_this || 0) === 1 ? "" : "s"} to his name this year.`); }
  if (pa.spiky) {
    const established = drop.value >= 1000 || (pd.ppg != null && pd.ppg >= (pa.ppg_trim ?? 0));
    const line = pa.ppg_trim == null ? `${add.name} has one game to his name (${pa.best.toFixed(0)} points). One game is one game: wait for him to do it twice.`
      : `${add.name}'s numbers lean on one ${pa.best.toFixed(0)}-point game; without it he's at ${pa.ppg_trim.toFixed(1)} a game. Wait for him to do it twice.`;
    if (established && (redraft ? (pa.ppg_trim ?? 0) <= (pd.ppg ?? 0) : add.value <= drop.value)) stop.push(line); else note.push(line);
  }
  if (!redraft) {
    const aging = drop.age != null && drop.age >= (DYN_VET_AGE[drop.pos] || 29), filler = drop.value < 300;
    const ratio = drop.value > 0 ? add.value / drop.value : 9;
    if (!filler && ratio < 0.9 && !(aging && drop.value < 1000))
      stop.push(`You'd give up long-term value: ${drop.name} is worth ${fmt(drop.value)}, ${add.name} ${fmt(add.value)}.`);
    else if (ratio >= 1.1) good.push(`More long-term value: ${fmt(add.value)} for ${fmt(drop.value)}.`);
    else note.push(`About the same long-term value (${fmt(add.value)} vs ${fmt(drop.value)}).`);
    if (drop.age != null && drop.age <= 25 && drop.value >= 400 && add.value < drop.value)
      stop.push(`${drop.name} is ${Math.floor(drop.age)} with real dynasty value. Keep young talent.`);
    if (aging && drop.value < 1000) note.push(`${drop.name} is ${Math.floor(drop.age)}: his value will keep falling.`);
    if (add.age != null && add.age <= 24) good.push(`${add.name} is ${Math.floor(add.age)}: room to grow.`);
  } else {
    const ra = add.redraft || 0, rd = drop.redraft || 0;
    if (rd >= 1000 && ra < 0.8 * rd) stop.push(`${drop.name} is still rated higher for the rest of the season.`);
    else if (ra > rd * 1.15) good.push(`${add.name} is rated higher for the rest of the season.`);
  }
  if (lu_gain > 0) good.push(`Your ${is_bestball(cfg) ? "best-ball" : "starting"} lineup gets better (${redraft ? "+" + lu_gain.toFixed(1) + " pts" : fmt_signed(lu_gain)}).`);
  else if (lu_gain < 0) note.push(`Your lineup gets a little worse (${redraft ? lu_gain.toFixed(1) + " pts" : fmt_signed(lu_gain)}).`);
  else note.push(addStarts || dropStarts ? "Your lineup stays about the same." : "Both are bench players, so your lineup doesn't change.");
  note.push(`${add.name}: ${parts.text(add)}. ${drop.name}: ${parts.text(drop)}.`);
  const valueUp = redraft ? (add.redraft || 0) > (drop.redraft || 0) * 1.1 : add.value >= drop.value * 1.1;
  let verdict, tone;
  if (stop.length) { verdict = "Don't make this move"; tone = "bad"; }
  else if (valueUp || lu_gain > 0) { verdict = "Good move"; tone = "good"; }
  else if (lu_gain < 0 || (redraft ? (add.redraft || 0) < (drop.redraft || 0) : add.value < drop.value)) { verdict = "Not worth it"; tone = "meh"; }
  else { verdict = "Close call"; tone = "close"; }
  let faab = null;
  if (tone !== "bad" && parseInt(lg.waiver_type || 0) === 2 && parseInt(lg.waiver_budget || 0) > 0)
    faab = faab_bid({ gain: metric(add) - metric(drop), add_m: metric(add), lineup_gain: lu_gain, add, group: add.pos }, parseInt(lg.waiver_budget),
      lg.waiver_bid_min != null ? parseInt(lg.waiver_bid_min) : 0, cfg, W && W.week, pa).faab;
  return { verdict, tone, reasons: stop.concat(good, note), lineup_gain: lu_gain, faab };
}

const DYN_VET_AGE = E.AGE_DECLINE;                           // the slide has started: dropping him costs little future (the user's age cliffs)
const POS_TYPICAL = E.DMV_TYPICAL;                          // a typical starter's points a game: the cap for one-game samples (the engine's table)
const gradeLetter = score => (E.GRADE_CUTS.find(([c]) => score >= c) || [0, "F"])[1];
function _one_move(values, cfg, roster, add, drop, metric, metric_name, parts, starters, before, floor) {
  const gain = metric(add) - metric(drop);
  if (gain <= Math.max(floor, 0.15 * metric(drop))) return null;
  if (is_redraft(cfg) && (drop.redraft || 0) >= 1000 && (add.redraft || 0) < 0.8 * drop.redraft) return null;
  if (!is_redraft(cfg) && drop.value >= 2000 && add.value < 0.5 * drop.value) return null;
  // dynasty: don't give up long-term value for a short-term fill-in. The add must be worth about as much long-term,
  // unless the drop is roster filler, or an aging vet whose spot a better player takes. Young talent is never cut for less.
  if (!is_redraft(cfg)) {
    const aging = drop.age != null && drop.age >= (DYN_VET_AGE[drop.pos] || 29), filler = drop.value < 300;
    if (!filler && add.value < 0.9 * drop.value && !(aging && drop.value < 1000)) return null;
    if (drop.age != null && drop.age <= 25 && drop.value >= 400 && add.value < drop.value) return null;
  }
  const pa = parts(add);
  if (INJURY_OUT.has(pa.inj) || !add.sleeper_id) return null;
  if (pickup_guard(add, drop, pa, parts(drop), metric, cfg)) return null;
  // never drop a player who grades C or better for someone who grades below him (our grade: production, prime years, role, health)
  if (drop.oscore != null && drop.oscore >= 57 && (add.oscore ?? 0) < drop.oscore) return null;
  // a known good player (a starter's season last year) isn't dropped on a slow start for an add with fewer than 4 games
  { const pd0 = parts(drop), bar = drop.pos === "QB" ? 14 : 8;
    if (pd0.ppg_last != null && pd0.ppg_last >= bar && (pa.games_this || 0) < 4 && Math.max(pa.ppg_trim ?? 0, (pa.ppg ?? 0) * 0.8) < pd0.ppg_last) return null; }
  // a player whose numbers rest on one big game doesn't replace an established player: he has to do it twice first
  if (pa.spiky) {
    const pd = parts(drop), established = drop.value >= 1000 || (pd.ppg != null && pd.ppg >= (pa.ppg_trim ?? 0));
    if (established && (is_redraft(cfg) ? (pa.ppg_trim ?? 0) <= (pd.ppg ?? 0) : add.value <= drop.value)) return null;
  }
  const after = roster.filter(a => a.id !== drop.id).concat([add]);
  const lu_after = best_lineup_by(after, starters, metric);
  const lu_gain = (!is_redraft(cfg) ? lineup_total(lu_after, cfg) : lu_after.total) - before;
  if (!is_redraft(cfg) && lu_gain <= 0 && add.value <= drop.value) return null;     // a move must help: more value or a better lineup
  const why = [];
  if (lu_gain > 0) why.push("lineup " + (!is_redraft(cfg) ? fmt_signed(lu_gain) : `+${lu_gain.toFixed(1)} pts`));
  const tr = add.trend48 || {};
  if ((tr.adds || 0) > (tr.drops || 0) && (tr.adds || 0) > 0) why.push(`hot on waivers (${compact(tr.adds)} adds)`);
  if ((pa.gp || 0) === 0 && pa.proj) why.push(`no games yet, but projected ${pa.proj.toFixed(1)} this week`);
  if (!is_redraft(cfg) && add.age != null && add.age <= 24) why.push(`age ${add.age.toFixed(0)} upside`);
  if (add.redraft && drop.redraft != null && add.redraft > drop.redraft * 1.3) why.push("more points this season");
  const fa = (add.sources || {}).fantasypros, fd = (drop.sources || {}).fantasypros;
  if (fa && fd && fa > fd) why.push("FantasyPros experts rank him higher");
  why.push("add: " + parts.text(add));
  const pd = parts(drop);
  if (pd.flags.length || (pd.ppg !== null && pd.ppg < 3)) why.push("drop: " + parts.text(drop));
  return { drop, add, gain, lineup_gain: lu_gain, score: gain + (is_redraft(cfg) ? 3 : 2) * Math.max(0, lu_gain), why: why.join(", "), metric: metric_name, drop_m: metric(drop), add_m: metric(add) };
}
function free_agent_board(values, cfg, fas, metric, parts, per_group = 6) {
  const pool = fas.slice().sort((a, b) => metric(b) - metric(a));
  return WAIVER_GROUPS.map(([grp, poss]) => [grp, pool.filter(a => poss.includes(a.pos) && a.sleeper_id && !INJURY_OUT.has(parts(a).inj) && metric(a) > 0).slice(0, per_group)]);
}

// ---------------------------------------------------------------------------
// Player card
// ---------------------------------------------------------------------------
function stats_for(asset, seasons, weekly) {
  const sid = asset.sleeper_id, key = norm(asset.name) + "|" + asset.pos;
  const find = players => (sid && players[sid]) || Object.values(players).find(r => norm(r.name || "") + "|" + r.pos === key) || null;
  const by_season = {}, by_week = {};
  for (const [y, players] of Object.entries(seasons)) { const r = find(players); if (r) by_season[y] = r; }
  for (const [w, players] of Object.entries(weekly)) { const r = find(players); if (r) by_week[w] = r; }
  return [by_season, by_week];
}
function stat_lines(pos) {
  const common = [["gp", "Games"], ["PTS", "Fantasy points"], ["PPG", "Points per game"]];
  if (pos === "QB") return common.concat([["pass_yd", "Pass yards"], ["pass_td", "Pass TD"], ["pass_int", "Interceptions"], ["rush_yd", "Rush yards"], ["rush_td", "Rush TD"]]);
  if (pos === "RB") return common.concat([["rush_att", "Carries"], ["rush_yd", "Rush yards"], ["rush_td", "Rush TD"], ["rec_tgt", "Targets"], ["rec", "Catches"], ["rec_yd", "Receiving yards"], ["rec_td", "Receiving TD"], ["fum_lost", "Fumbles lost"]]);
  return common.concat([["rec_tgt", "Targets"], ["rec", "Catches"], ["rec_yd", "Receiving yards"], ["rec_td", "Receiving TD"], ["rush_att", "Carries"], ["rush_yd", "Rush yards"], ["rush_td", "Rush TD"]]);
}
function stat_value(row, key, pk) {
  if (!row) return "";
  const gp = parseFloat(row.gp || 0);
  if (key === "PTS") return fmt(row[pk] || 0);
  if (key === "PPG") return gp ? ((row[pk] || 0) / gp).toFixed(1) : "";
  return row[key] == null ? "" : fmt(row[key]);
}

/* Rankings by list, 1 = best: the player's overall place and position place on every list he appears on. */
function rankings_by_list(values, a) {
  const ranked = values.players.filter(p => !p.unranked);
  const rows = Object.entries(a.sources || {}).sort((x, y) => y[1] - x[1]).map(([src, v]) => {
    const overall = 1 + ranked.filter(p => ((p.sources || {})[src] ?? -1) > v).length;
    const at_pos = a.is_pick ? "" : a.pos + (1 + ranked.filter(p => p.pos === a.pos && ((p.sources || {})[src] ?? -1) > v).length);
    const s = E.SOURCES[src.split(":")[0]];
    return { src, label: s ? s.label : src, overall, at_pos, value: v, raw: (a.raw || {})[src] || "" };
  });
  return rows;
}

/* This week's grade: his matchup-adjusted projection ranked against the other players at his position, scaled to the
   league's starting slots (QB 1 or 2, RB 2.5, WR 3.5, TE 1.2 a team). A+ = top of the starters, C+ = borderline
   starter, D or F = sit. Cached on W. Returns { sid: { letter, label, cls, pts, posRank } }. */
const WEEK_CUTS = [[0.15, "A+", "Must start"], [0.3, "A", "Start"], [0.45, "A-", "Start"], [0.6, "B+", "Start"], [0.75, "B", "Start"], [0.9, "B-", "Flex call"],
  [1.05, "C+", "Flex call"], [1.2, "C", "Sit if you can"], [1.4, "C-", "Sit"], [1.8, "D", "Sit"], [Infinity, "F", "Sit"]];
/* The Season grade in dynasty leagues (2026-10-16, the user's ask: a season grade beside the dynasty grade): this season
   only, from our rest-of-season points a game (the prediction model), cut for an injury that keeps him out, ranked at
   his position against the league's starters on the week grade's scale. F only for a player with nothing going this
   season (no team, or no projection left); anyone with a projection gets at least a D. */
const SEASON_AVAIL = { IR: 0.4, PUP: 0.4, NA: 0.4, Sus: 0.4, Suspended: 0.4, DNR: 0.4, Out: 0.85, Doubtful: 0.9 };
function season_grades(values, cfg) {
  if (values._sg) return values._sg;
  const teams = (values.league && values.league.teams && values.league.teams.length) || parseInt(cfg.league.teams, 10) || 12;
  const slots = { QB: parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 };
  const st = E.load_player_status(), rows = {};
  for (const a of values.players) {
    if (a.is_pick || a.unranked || !a.sleeper_id || !POSITIONS.includes(a.pos) || !a.pred) continue;
    const inj = (st[a.sleeper_id] || {}).inj, avail = !a.team || a.team === "FA" ? 0 : SEASON_AVAIL[inj] ?? 1;
    (rows[a.pos] = rows[a.pos] || []).push([a.sleeper_id, (a.pred.ros || 0) * avail]);
  }
  const out = {};
  for (const [pos, l] of Object.entries(rows)) {
    l.sort((x, y) => y[1] - x[1]);
    l.forEach(([sid, ros], i) => {
      let [, letter] = WEEK_CUTS.find(([c]) => (i + 1) / (teams * slots[pos]) <= c);
      if (letter === "F" && ros >= 1) letter = "D";
      out[sid] = { letter, cls: "g" + letter[0].toLowerCase(), ros, posRank: i + 1 };
    });
  }
  return (values._sg = out);
}
function week_grades(values, cfg, W) {
  if (!W || W.valuesOnly || !W.proj || !Object.keys(W.proj).length) return {};
  if (W._wg) return W._wg;
  const teams = (values.league && values.league.teams && values.league.teams.length) || parseInt(cfg.league.teams, 10) || 12;
  const slots = { QB: parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 };
  const rows = {}, hasCtx = Object.keys(W.ctx || {}).length > 0;
  for (const a of values.players) {
    if (a.is_pick || !a.sleeper_id || !POSITIONS.includes(a.pos)) continue;
    if (!a.team || a.team === "FA" || (hasCtx && !W.ctx[a.team])) continue;        // no team, or no game this week: no grade
    const p = W.proj[a.sleeper_id]; if (!p) continue;
    const base = parseFloat(p.pts || 0); if (!(base > 0)) continue;
    const [adj] = adjust_projection(base, a.pos, a.team || "FA", W.ctx, W.trends, 0.6);
    const ours = typeof Predict !== "undefined" ? Predict.week_points(a, W, cfg) : null;       // our model: half the say when it has data
    (rows[a.pos] = rows[a.pos] || []).push([a.sleeper_id, ours != null ? 0.5 * adj + 0.5 * Predict.to_league(ours, a, cfg) : adj]);
  }
  // kickers and defenses (2026-10-19): one a team, every one in the NFL ranked; kickers on our projection, defenses on
  // the streamer's matchup number
  const ks = kdef_ready(W) ? kdef_slots(values.league) : [];
  if (ks.includes("K")) rows.K = Object.entries(W.proj).filter(([, p]) => p.pos === "K" && p.pts > 0).map(([sid, p]) => [sid, p.pts]);
  if (ks.includes("DEF")) rows.DEF = defense_streamers(values, cfg, W).filter(r => r.adj > 0).map(r => [r.team, r.adj]);
  slots.K = 1; slots.DEF = 1;
  const out = {};
  for (const [pos, l] of Object.entries(rows)) {
    l.sort((x, y) => y[1] - x[1]);
    l.forEach(([sid, pts], i) => {
      let x = (i + 1) / (teams * slots[pos]);
      if (x > 0.75 && is_star(values.by_sleeper[sid])) x = 0.75;              // a star with a game is a Start at worst, never a Sit
      const [, letter, label] = WEEK_CUTS.find(([c]) => x <= c);
      out[sid] = { letter, label, cls: "g" + letter[0].toLowerCase(), pts, posRank: i + 1 };
    });
  }
  W._wg = out;
  return out;
}
/* A played week's grades (2026-10-19): the grade our projection gave each player that week, ranked the same way as the
   week grade (WEEK_CUTS at his position against the league's starters), with what we said and what he scored. From the
   projection record (accuracy: players who played that week). */
function past_week_grades(values, cfg, W, week) {
  const A = W && W.acc;
  if (!A || !A.per || !week) return {};
  W._pwg = W._pwg || {};
  if (W._pwg[week]) return W._pwg[week];
  const teams = (values.league && values.league.teams && values.league.teams.length) || parseInt(cfg.league.teams, 10) || 12;
  const slots = { QB: parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 };
  const rows = {};
  for (const [sid, wk] of Object.entries(A.per)) {
    const r = wk[week], a = r && values.by_sleeper[sid];
    if (!a || !POSITIONS.includes(a.pos)) continue;
    (rows[a.pos] = rows[a.pos] || []).push([sid, r[0], r[1]]);
  }
  const out = {};
  for (const [pos, l] of Object.entries(rows)) {
    l.sort((x, y) => y[1] - x[1]);
    l.forEach(([sid, said, got], i) => {
      let x = (i + 1) / (teams * slots[pos]);
      if (x > 0.75 && is_star(values.by_sleeper[sid])) x = 0.75;
      const [, letter, label] = WEEK_CUTS.find(([c]) => x <= c);
      out[sid] = { letter, label, cls: "g" + letter[0].toLowerCase(), said, got, posRank: i + 1 };
    });
  }
  return (W._pwg[week] = out);
}
/* This season's fantasy points per player (the league's PPR setting), for the Rankings tab's Points order. */
function season_points(values, cfg, W) {
  if (!W || W.valuesOnly || !W.seasons) return {};
  if (W._sp) return W._sp;
  const pk = pts_key(cfg), rows = W.seasons[parseInt(cfg.season, 10)] || {}, byName = {};
  for (const r of Object.values(rows)) if (r && r.name) byName[norm(r.name) + "|" + r.pos] = r;
  const out = {};
  for (const a of values.players) {
    if (a.is_pick || !a.sleeper_id) continue;
    const r = rows[a.sleeper_id] || byName[norm(a.name) + "|" + a.pos]; if (!r) continue;
    const gp = parseFloat(r.gp || 0), pts = parseFloat(r[pk] || 0);
    out[a.sleeper_id] = { pts, gp, ppg: gp ? pts / gp : 0 };
  }
  return (W._sp = out);
}
/* Team context (2026-10-20): what each defense gives up to each position this season (points a game, 1 = the most),
   how many plays each offense runs and how often it passes (nflverse team totals), and each team's rest before this
   week's game and the field (nflverse schedule). From data already downloaded; for the card's matchup lines. Cached on W. */
function team_context(cfg, W) {
  if (!W || W.valuesOnly || !W.weekly) return null;
  if (W._tc) return W._tc;
  const pk = pts_key(cfg), allowed = {}, played = {}, fix = t => NFLV_TEAM_FIX[t] || t;
  for (const [w, rows] of Object.entries(W.weekly)) for (const r of Object.values(rows)) {
    if (!POSITIONS.includes(r.pos) || !r.opp) continue;
    const o = fix(String(r.opp).replace(/^@/, "")), A = allowed[o] = allowed[o] || {};
    A[r.pos] = (A[r.pos] || 0) + (+r[pk] || 0); (played[o] = played[o] || new Set()).add(w);
  }
  const def = {}, off = {}, rest = {};
  for (const pos of POSITIONS) {
    const l = Object.keys(allowed).map(t => [t, (allowed[t][pos] || 0) / Math.max(1, played[t].size)]).sort((x, y) => y[1] - x[1]);
    l.forEach(([t, v], i) => { (def[t] = def[t] || {})[pos] = { ppg: v, rank: i + 1, of: l.length }; });
  }
  const tc = Object.entries(E.nflv_team_ctx(W.season, true)).filter(([, t]) => t.g > 0).map(([t, x]) => [fix(t), x.att_pg + x.car_pg, x.att_pg / Math.max(1, x.att_pg + x.car_pg)]);
  tc.slice().sort((x, y) => y[1] - x[1]).forEach(([t, plays], i) => { off[t] = { plays, playsRank: i + 1, of: tc.length }; });
  tc.slice().sort((x, y) => y[2] - x[2]).forEach(([t, , pass], i) => { if (off[t]) Object.assign(off[t], { pass, passRank: i + 1 }); });
  for (const g of ((Store.get(`nflv_games_${W.season}.json`) || {}).games || []).filter(g => g.week === W.week)) {
    rest[g.home] = { days: g.rest_h, surface: g.surface }; rest[g.away] = { days: g.rest_a, surface: g.surface };
  }
  return (W._tc = { def, off, rest });
}
function player_card(values, cfg, a, W) {
  const pk = pts_key(cfg);
  const st = (W && W.status || E.load_player_status())[a.sleeper_id || ""] || {};
  const out = { asset: a, status: st.inj || null, depth: st.depth ?? null, lists: rankings_by_list(values, a) };
  const series = E.price_series(a.id);
  out.series = series;
  out.changes = E.price_changes(series);
  if (!a.is_pick && W) {
    const p = W.proj[a.sleeper_id || ""];
    const cx = (W.ctx || {})[a.team || ""] || null;
    if (!p) out.week = { week: W.week, none: true, bye: Object.keys(W.ctx || {}).length > 0 && !cx };
    else {
      const base = parseFloat(p.pts || 0);
      const [adj, reasons] = base > 0 ? adjust_projection(base, a.pos, a.team || "FA", W.ctx, W.trends, 0.6) : [0, []];
      const ours0 = typeof Predict !== "undefined" ? Predict.week_points(a, W, cfg) : null, ours = ours0 != null ? Predict.to_league(ours0, a, cfg) : null;
      if (ours != null) reasons.push(`our model ${ours.toFixed(1)} pts`);
      out.week = { week: W.week, base, adj: ours != null && adj > 0 ? 0.5 * adj + 0.5 * ours : adj, model: ours, reasons, injury: p.injury, opp: cx ? cx.opp : p.opp, home: cx ? cx.home : null, spread: cx ? cx.spread : null,
        total: cx ? cx.total : null, weather: cx ? (cx.indoor ? "dome" : cx.weather) : null, grade: week_grades(values, cfg, W)[a.sleeper_id || ""] || null };
      const T = POSITIONS.includes(a.pos) ? team_context(cfg, W) : null, opp = out.week.opp ? String(out.week.opp).replace(/^@/, "") : null;
      if (T) out.week.ctx = { def: opp && T.def[opp] ? T.def[opp][a.pos] : null, off: T.off[a.team] || null, rest: T.rest[a.team] || null };
    }
    const [bs, bw] = stats_for(a, W.seasons, W.weekly);
    out.seasons = Object.keys(bs).map(Number).sort((x, y) => y - x).map(y => ({ season: y, lines: stat_lines(a.pos).map(([k, l]) => [l, stat_value(bs[y], k, pk)]) }));
    out.weekly = Object.keys(bw).map(Number).sort((x, y) => x - y).map(w => ({ week: w, pts: parseFloat(bw[w][pk] || 0), opp: bw[w].opp }));
    const cur = bs[parseInt(cfg.season)];
    out.ppg = cur && cur.gp ? (cur[pk] || 0) / cur.gp : null;
  }
  out.like = values.players.filter(p => p.id !== a.id && !p.unranked && Math.abs(p.value - a.value) <= Math.max(150, 0.06 * a.value))
    .sort((x, y) => ((x.pos === a.pos ? 0 : 1) - (y.pos === a.pos ? 0 : 1)) || Math.abs(x.value - a.value) - Math.abs(y.value - a.value)).slice(0, 6);
  if (values.league && !a.is_pick) {
    const t = values.league.teams.find(t => t.players.includes(a.sleeper_id || ""));
    out.owner = t ? t.team_name : "free agent";
    out.owner_id = t ? t.roster_id : null;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Trade ideas. Reads the standings (record, then points scored; team value before any games) to find teams likely
   to sell (bottom third) or buy (top third), compares every team's starters with the league average at each position,
   and pairs that with the user's own direction:
     contending  -> buy proven players at the user's thin spots from struggling teams
     rebuilding  -> sell the user's older starters to contenders thin at that spot, for young players and picks
     either way  -> "good fit" swaps with teams deep where the user is thin and thin where the user is deep
   Each idea comes with a package of about even value (within 15%) from the other side's spare parts. */
const TI_POS = E.POSITIONS;
const VET_AGE = E.AGE_DECLINE;                               // sell a year early rather than a year late (the user's age cliffs, engine AGE_CLIFF - 2)
function trade_targets(values, cfg, me, week, n = 8) {
  const lg = values.league, all = lg.teams, starters = lg.roster_positions_starters || cfg.league.starters;
  const rec = t => { const [w, l, ti] = String(t.record || "0-0").split("-").map(x => parseInt(x, 10) || 0); const g = w + l + (ti || 0); return { w, l, g, pct: g ? (w + 0.5 * (ti || 0)) / g : 0.5 }; };
  const info = new Map();
  for (const t of all) {
    const assets = team_assets(values, cfg, t);
    const players = assets.filter(a => !a.is_pick);
    const lu = best_lineup_by(players, starters, a => a.value);
    const startIds = new Set(lu.starters.filter(([, p]) => p).map(([, p]) => p.id));
    const byPos = {};
    for (const pos of TI_POS) byPos[pos] = lu.starters.filter(([, p]) => p && p.pos === pos).map(([, p]) => p.value);
    info.set(t.roster_id, { t, r: rec(t), assets, players, startIds, byPos, total: players.reduce((x, a) => x + a.value, 0) });
  }
  const rank = (key, t) => { const v = key(t); return all.filter(o => key(o) > v).length; };           // 0 = best
  const denom = Math.max(1, all.length - 1);
  for (const [id, I] of info) {
    const pf = 1 - rank(t => t.points_for || 0, I.t) / denom, val = 1 - rank(t => info.get(t.roster_id).total, I.t) / denom;
    I.standing = I.r.g ? 0.6 * I.r.pct + 0.4 * pf : val;                 // 0 worst .. 1 best
    I.place = 1 + all.filter(o => { const O = info.get(o.roster_id); return O.r.pct > I.r.pct || (O.r.pct === I.r.pct && (o.points_for || 0) > (I.t.points_for || 0)); }).length;
  }
  const avg = {};
  for (const pos of TI_POS) {
    const v = [...info.values()].map(I => I.byPos[pos].reduce((x, y) => x + y, 0));
    avg[pos] = v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
  }
  const needOf = I => Object.fromEntries(TI_POS.map(pos => [pos, avg[pos] - I.byPos[pos].reduce((x, y) => x + y, 0)]));   // > 0 = thin
  const M = info.get(me.roster_id);
  if (!M) return { ideas: [], me: null };
  const myNeed = needOf(M);
  const thin = TI_POS.filter(p => myNeed[p] > avg[p] * 0.12).sort((a, b) => myNeed[b] - myNeed[a]);
  const deep = TI_POS.filter(p => myNeed[p] < -avg[p] * 0.12).sort((a, b) => myNeed[a] - myNeed[b]);
  const third = Math.max(1, Math.round(all.length / 3));
  const order = [...info.values()].sort((a, b) => a.standing - b.standing);
  const sellers = new Set(order.slice(0, third).map(I => I.t.roster_id)), buyers = new Set(order.slice(-third).map(I => I.t.roster_id));
  const redraft = is_redraft(cfg);                                   // redraft: everyone is trying to win this season, and age means nothing
  const direction = redraft ? "contend" : (M.standing >= 0.58 || buyers.has(me.roster_id) ? "contend" : (M.standing <= 0.4 || sellers.has(me.roster_id) ? "rebuild" : "either"));

  // a package of about `target` value from `pool`: one asset, else two. What you offer is priced the way the market
  // pays: a QB or RB drafted high this year or last brings back more (draft hype, the user's rule 2026-10-16)
  const price = a => a.value * E.hype_mult(a, cfg);
  const cost = a => a.value * (1 - E.te_risk(a));                      // what to offer for him: a TE at a discount (his risk)
  const pack = (pool, target, avoid = new Set(), val = price) => {
    const c = pool.filter(a => !avoid.has(a.id) && a.value > 0).sort((a, b) => val(b) - val(a));
    const ok = v => v >= target * 0.85 && v <= target * 1.15;
    let best = null;
    for (const a of c) if (ok(val(a)) && (!best || Math.abs(val(a) - target) < Math.abs(best.v - target))) best = { items: [a], v: val(a) };
    if (best) return best;
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const v = val(c[i]) + val(c[j]);
      if (ok(v) && (!best || Math.abs(v - target) < Math.abs(best.v - target))) best = { items: [c[i], c[j]], v };
    }
    return best;
  };
  const spare = I => I.assets.filter(a => a.is_pick || !I.startIds.has(a.id));            // bench players and picks
  const young = I => I.assets.filter(a => a.is_pick || (a.age != null && a.age <= 24));
  const recTxt = I => `${I.t.record || "0-0"}, ${ordinal(I.place)} place`;
  const ideas = [];

  // 1. buy proven players at thin spots from struggling teams (dynasty: they sell veterans for the future)
  if (!redraft && direction !== "rebuild") for (const pos of thin) {
    const mine = M.byPos[pos].length ? Math.min(...M.byPos[pos]) : 0;
    for (const id of sellers) {
      if (id === me.roster_id) continue;
      const O = info.get(id);
      for (const a of O.players.filter(a => a.pos === pos && a.value > mine * 1.15 && a.value >= 1500 && (a.age == null || a.age >= VET_AGE[pos] - 2))) {
        const g = pack(spare(M), cost(a));
        if (!g) continue;
        ideas.push({ kind: "buy", team: O.t, get: [a], give: g.items, score: (a.value - mine) * (1.2 - O.standing),
          why: [`${O.t.team_name} is ${recTxt(O)}: struggling teams sell veterans`, `You're thin at ${pos}: he'd start over ${mine ? "your weakest " + pos : "an empty spot"}`] });
      }
    }
  }
  // 2. sell older starters to contenders who are thin at that spot (dynasty only: in redraft nobody's value "will drop")
  if (!redraft && direction !== "contend") for (const a of M.players.filter(a => M.startIds.has(a.id) && a.age != null && a.age >= VET_AGE[a.pos] && a.value >= 1500)) {
    for (const id of buyers) {
      if (id === me.roster_id) continue;
      const O = info.get(id), need = needOf(O)[a.pos];
      if (!(need > 0)) continue;
      const g = pack(young(O), a.value);
      if (!g) continue;
      ideas.push({ kind: "sell", team: O.t, give: [a], get: g.items, score: a.value * 0.6 + need * 0.5,
        why: [`${O.t.team_name} is ${recTxt(O)} and thin at ${a.pos}: contenders pay for starters`, `${a.name} is ${Math.floor(a.age)}: his value will drop, so sell while it's high`] });
    }
  }
  // 3. good fits: they are deep where you are thin, and thin where you are deep
  for (const O of info.values()) {
    if (O.t.roster_id === me.roster_id) continue;
    const theirNeed = needOf(O);
    for (const give of deep) for (const get of thin) {
      if (!(theirNeed[give] > 0) || !(theirNeed[get] < 0)) continue;
      const mine = M.byPos[get].length ? Math.min(...M.byPos[get]) : 0;
      const target = O.players.filter(a => a.pos === get && !O.startIds.has(a.id) && a.value > mine * 1.1).sort((a, b) => b.value - a.value)[0]
        || O.players.filter(a => a.pos === get && a.value > mine * 1.1).sort((a, b) => a.value - b.value)[0];
      if (!target) continue;
      const surplus = M.players.filter(a => a.pos === give && !M.startIds.has(a.id));
      const g = pack(surplus, cost(target)) || pack(surplus.concat(M.assets.filter(a => a.is_pick)), cost(target));
      if (!g) continue;
      ideas.push({ kind: "fit", team: O.t, get: [target], give: g.items, score: (target.value - mine) * 0.8 + theirNeed[give] * 0.3,
        why: [`${O.t.team_name} is deep at ${get} and thin at ${give}; you're the opposite`] });
    }
  }
  // ---- the creative ideas (2026-10-16, the user's ask). They follow the user's rules: never a TE to buy, never a young
  // superflex QB to give, never young talent for a short-term fix when rebuilding, and a hurt player is never offered.
  const st = E.load_player_status(), OUTS = ["IR", "PUP", "Out", "Sus", "Suspended", "DNR", "NA"];
  const hurt = a => !a.is_pick && OUTS.includes((st[String(a.sleeper_id)] || {}).inj);
  const sfLg = parseInt(cfg.league.num_qbs, 10) >= 2;
  const keep = a => !a.is_pick && ((sfLg && !redraft && a.pos === "QB" && a.age != null && a.age <= 25.5) || (!redraft && direction === "rebuild" && a.age != null && a.age <= 24));
  const offer = pool => pool.filter(a => !keep(a) && !hurt(a));
  const decline = pos => VET_AGE[pos] || 99;
  const epr = a => (a.ep && a.ep.g >= 4 && a.ep.exp > 0 ? a.ep.pts / a.ep.exp : null);
  const usageOk = a => a.ep && a.ep.exp / a.ep.g >= (a.pos === "QB" ? 15 : 9);   // a real role: expected points a game
  const others = [...info.values()].filter(O => O.t.roster_id !== me.roster_id);
  const POSNAME = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };
  // superflex QBs (2026-10-16, the user: "Kyler Murray for Ty Simpson is not a good enough trade for a QB"): what you get
  // is valued plainly (no draft hype), a starting QB goes only for 25% more, never for a QB who isn't starting, and only
  // while you keep two starting QBs
  const plain = a => a.value;
  const nflStarter = a => a.pos === "QB" && a.team && a.team !== "FA" && (st[String(a.sleeper_id)] || {}).depth === 1;
  const myStartingQbs = M.players.filter(nflStarter).length;
  const qbSale = a => sfLg && !redraft && nflStarter(a);
  const canSellQb = a => !qbSale(a) || myStartingQbs >= 3;
  const qbAsk = a => (qbSale(a) ? 1.25 : 1);
  const noBackupQbs = pool => pool.filter(x => x.is_pick || x.pos !== "QB" || nflStarter(x));
  // 4. buy low: scoring under what his usage earns; the points usually follow the usage
  for (const O of others) for (const a of O.players) {
    const r = epr(a);
    if (a.pos === "TE" || r == null || r > 0.85 || !usageOk(a) || a.value < 1500 || hurt(a) || (!redraft && a.age != null && a.age >= decline(a.pos))
      || (!redraft && direction === "rebuild" && !(a.age != null && a.age <= 25))) continue;   // a rebuilder buys low only on young players
    const g = pack(offer(spare(M)).filter(x => !qbSale(x) || (a.pos === "QB" && canSellQb(x))), a.value * 0.9);
    if (!g) continue;
    ideas.push({ kind: "buylow", team: O.t, get: [a], give: g.items, score: a.value * (1 - r) * 1.6,
      why: [`${a.name} has scored ${a.ep.pts.toFixed(0)} points on ${a.ep.exp.toFixed(0)} expected from his usage: the points usually follow the usage, so his price may never be lower`,
        "The offer is about 10% under his value: buy before the touchdowns catch up"] });
  }
  // 5. sell high: touchdowns running far ahead of his usage, to a team thin at his spot
  for (const a of M.players) {
    const r = epr(a);
    if (r == null || r < 1.2 || !(a.ep.td - a.ep.tdx >= 2.5) || a.value < 1500 || keep(a) || hurt(a) || (a.rank && a.rank <= 24) || (!redraft && a.age != null && a.age < 25) || !canSellQb(a)) continue;
    for (const O of others) {
      if (!(needOf(O)[a.pos] > 0)) continue;
      const g = pack(noBackupQbs(redraft ? spare(O) : young(O)), price(a) * qbAsk(a), new Set(), plain);
      if (!g) continue;
      ideas.push({ kind: "sellhigh", team: O.t, give: [a], get: g.items, score: a.value * (r - 1) * 1.4 + needOf(O)[a.pos] * 0.2,
        why: [`${a.name} has ${a.ep.td} touchdowns on ${a.ep.tdx.toFixed(1)} expected: a run like that rarely lasts, so sell while his numbers look their best`,
          `${O.t.team_name} is ${recTxt(O)} and thin at ${a.pos}, so they should pay full price`] });
    }
  }
  // 6. injury buy (dynasty): a good young player who is hurt, from a contender who needs points now
  if (!redraft && direction !== "contend") for (const O of others) {
    if (!(O.standing >= 0.5)) continue;
    for (const a of O.players.filter(a => hurt(a) && a.pos !== "TE" && a.value >= 2500 && a.age != null && a.age < decline(a.pos) - 1)) {
      const g = pack(offer(spare(M)).filter(x => !qbSale(x)), a.value * 0.8);
      if (!g) continue;
      const inj = (st[String(a.sleeper_id)] || {}).inj;
      ideas.push({ kind: "injury", team: O.t, get: [a], give: g.items, score: a.value * 0.35,
        why: [`${a.name} is ${inj === "IR" ? "on IR" : inj}; ${O.t.team_name} is ${recTxt(O)} and needs points now, so he can come cheaper`,
          `He's ${Math.floor(a.age)}: the injury costs this season, not his future. The offer is about 20% under his value`] });
    }
  }
  // 7. two-for-one: two bench pieces for one starter at your weakest spot (two-for-ones here cost about a fifth more)
  {
    const weakest = TI_POS.filter(p => p !== "TE").sort((x, y) => (myNeed[y] || 0) - (myNeed[x] || 0))[0];
    const mine = weakest && M.byPos[weakest].length ? Math.min(...M.byPos[weakest]) : 0;
    const bench = offer(M.players.filter(a => !M.startIds.has(a.id) && !qbSale(a))).sort((x, y) => price(y) - price(x));
    if (weakest) for (const O of others) {
      const a = O.players.filter(a => a.pos === weakest && a.value >= Math.max(1500, mine * 1.3) && !hurt(a)).sort((x, y) => x.value - y.value)[0];
      if (!a) continue;
      let best = null;
      for (let i = 0; i < bench.length; i++) for (let j = i + 1; j < bench.length; j++) {
        const v = price(bench[i]) + price(bench[j]);
        if (price(bench[i]) < a.value && v >= a.value * 1.15 && v <= a.value * 1.4 && (!best || v < best.v)) best = { items: [bench[i], bench[j]], v };
      }
      if (!best) continue;
      ideas.push({ kind: "consolidate", team: O.t, get: [a], give: best.items, score: (a.value - mine) * 0.9,
        why: [`Two of your bench pieces for a starter at ${weakest}, where your lineup is weakest: you upgrade and free a roster spot`,
          "In these leagues the side giving two pieces pays about a fifth more in total value, so the package is priced that way"] });
    }
  }
  // 8. league market (dynasty): sell where this league pays more than our values say (its own trade history)
  if (!redraft) for (const pos of TI_POS) {
    const mult = E.league_market_mult({ pos }, cfg);
    if (!(mult >= 1.1)) continue;
    const a = offer(M.players.filter(x => x.pos === pos && !M.startIds.has(x.id) && x.value >= 1500 && canSellQb(x))).sort((x, y) => y.value - x.value)[0];
    if (!a) continue;
    const O = others.filter(o => needOf(o)[pos] > 0).sort((x, y) => needOf(y)[pos] - needOf(x)[pos])[0];
    if (!O) continue;
    const g = pack(noBackupQbs([...new Set(young(O).concat(spare(O)))]), a.value * mult * qbAsk(a), new Set(), plain);
    if (!g) continue;
    ideas.push({ kind: "market", team: O.t, give: [a], get: g.items, score: a.value * (mult - 1) * 3,
      why: [`This league pays about ${Math.round((mult - 1) * 100)}% more for ${POSNAME[pos]} than our values say (from its own trades): sell where the market overpays`,
        `${a.name} sits on your bench; ${O.t.team_name} is the thinnest at ${pos}`] });
  }
  // trading for a TE is risky (the user's rule, 2026-10-16): ideas that bring one in rank lower and say why; a
  // high-drafted young QB or RB in what you'd give is named as the hype that pays for it
  for (const x of ideas) {
    const r = Math.max(0, ...x.get.map(a => E.te_risk(a)));
    if (r > 0) { x.score *= 1 - 2 * r; x.why.push(`Tight ends are a risky trade target: many break out late or never do, so this offer is ${Math.round(r * 100)}% under his value`); }
    const hyped = x.give.filter(a => E.hype_mult(a, cfg) >= 1.03);
    if (hyped.length) x.why.push(hyped.map(a => `${a.name} went #${a.dpick} in the NFL draft${a.exp === 0 ? " this year" : " last year"}`).join("; ") + ": the hype is worth more in a trade than his stats so far");
  }
  // best first, one idea per trade, at most two per team and two of each kind (so the mix stays varied)
  ideas.sort((a, b) => b.score - a.score);
  const out = [], usedGet = new Set(), perTeam = {}, perKind = {};
  for (const x of ideas) {
    const key = x.get.map(a => a.id).join("+") + ">" + x.give.map(a => a.id).join("+");
    if (usedGet.has(key) || (perTeam[x.team.roster_id] || 0) >= 2 || (perKind[x.kind] || 0) >= 2) continue;
    usedGet.add(key); perTeam[x.team.roster_id] = (perTeam[x.team.roster_id] || 0) + 1; perKind[x.kind] = (perKind[x.kind] || 0) + 1;
    out.push(x);
    if (out.length >= n) break;
  }
  const deadline = lg.trade_deadline || null;
  return { ideas: out, me: { record: me.record || "0-0", place: M.place, teams: all.length, direction, thin, deep, standing: M.standing },
    timing: { week: week || null, deadline, left: deadline && week ? Math.max(0, deadline - week) : null, playoffs: lg.playoff_week_start || null },
    sellers: [...sellers].filter(id => id !== me.roster_id).map(id => info.get(id).t.team_name) };
}

// ---------------------------------------------------------------------------
// Team profiles and the Negotiator
// ---------------------------------------------------------------------------
/* Every team read from the standings and the roster: record and place, a mode (top third contending, bottom third
   rebuilding; redraft: contending / in the hunt / long shot), the value of its starters at each position against the
   league average (thin / deep), and its trade habits this season from the league's completed trades. */
function team_profiles(values, cfg) {
  const lg = values.league, all = lg.teams, rd = is_redraft(cfg), starters = lg.roster_positions_starters || cfg.league.starters;
  const rec = t => { const [w, l, ti] = String(t.record || "0-0").split("-").map(x => parseInt(x, 10) || 0); const g = w + l + (ti || 0); return { w, l, g, pct: g ? (w + 0.5 * (ti || 0)) / g : 0.5 }; };
  const teams = all.map(t => {
    const assets = team_assets(values, cfg, t), players = assets.filter(a => !a.is_pick);
    const lu = best_lineup_by(players, starters, a => a.value), byPos = {}, startVals = {};
    for (const p of TI_POS) { startVals[p] = lu.starters.filter(([, x]) => x && x.pos === p).map(([, x]) => x.value); byPos[p] = startVals[p].reduce((s, v) => s + v, 0); }
    const startIds = new Set(lu.starters.filter(([, x]) => x).map(([, x]) => x.id));
    return { t, assets, players, r: rec(t), byPos, startVals, startIds, total: players.reduce((s, a) => s + a.value, 0),
      trades: { n: 0, got: 0, gave: 0, picksGot: 0, picksGave: 0, multi: 0 } };
  });
  const n = all.length, denom = Math.max(1, n - 1), rank = (key, I) => teams.filter(o => key(o) > key(I)).length;
  for (const I of teams) {
    const pf = 1 - rank(o => o.t.points_for || 0, I) / denom, val = 1 - rank(o => o.total, I) / denom;
    I.standing = I.r.g ? 0.6 * I.r.pct + 0.4 * pf : val;
    I.place = 1 + teams.filter(o => o.r.pct > I.r.pct || (o.r.pct === I.r.pct && (o.t.points_for || 0) > (I.t.points_for || 0))).length;
  }
  const avg = {};
  for (const p of TI_POS) avg[p] = teams.reduce((s, I) => s + I.byPos[p], 0) / Math.max(1, n);
  const third = Math.max(1, Math.round(n / 3)), order = [...teams].sort((a, b) => a.standing - b.standing);
  const low = new Set(order.slice(0, third).map(I => I.t.roster_id)), high = new Set(order.slice(-third).map(I => I.t.roster_id));
  for (const I of teams) {
    const id = I.t.roster_id;
    I.mode = rd ? (high.has(id) ? "contending" : low.has(id) ? "long shot" : "in the hunt") : (high.has(id) ? "contending" : low.has(id) ? "rebuilding" : "in between");
    I.lens = rd ? "neutral" : (high.has(id) ? "contend" : low.has(id) ? "rebuild" : "neutral");
    I.thin = TI_POS.filter(p => avg[p] - I.byPos[p] > avg[p] * 0.12);
    I.deep = TI_POS.filter(p => I.byPos[p] - avg[p] > avg[p] * 0.12);
  }
  const byId = new Map(teams.map(I => [String(I.t.roster_id), I]));
  for (const tr of lg.trades || []) {
    const sides = Object.entries(tr.sides || {});
    for (const [rid, s] of sides) {
      const I = byId.get(String(rid)); if (!I) continue;
      const got = (s.players || []).length + (s.picks || []).length;
      const others = sides.filter(([r2]) => r2 !== rid);
      const gave = others.reduce((a, [, s2]) => a + (s2.players || []).length + (s2.picks || []).length, 0);
      I.trades.n++; I.trades.got += got; I.trades.gave += gave; I.trades.picksGot += (s.picks || []).length;
      I.trades.picksGave += others.reduce((a, [, s2]) => a + (s2.picks || []).length, 0);
      if (got > gave) I.trades.multi++;
    }
  }
  return { teams, avg, byId: id => byId.get(String(id)) };
}

/* The Negotiator: how the other manager (team B) most likely sees a trade, the odds they say yes, the smallest change
   that gets to yes, and a message to send. a_gives = what you offer (they receive), b_gives = what you ask for. The
   trade is priced through their lens: the strategy set for them, else what their standing says. */
const NEGO_BANDS = [[10, "Very likely", "good"], [3, "Good chance", "good"], [-5, "Coin flip", "warn"], [-15, "Long shot", "bad"], [-Infinity, "No chance", "bad"]];
function negotiate(values, cfg, team_a, team_b, a_gives, b_gives, mode_b = "neutral", week = null) {
  const lg = values.league;
  if (!lg || !team_b || !a_gives.length || !b_gives.length) return null;
  const P = team_profiles(values, cfg), B = P.byId(team_b.roster_id), Ap = team_a ? P.byId(team_a.roster_id) : null;
  if (!B) return null;
  const rd = is_redraft(cfg), lens = rd ? "neutral" : (mode_b && mode_b !== "neutral" ? mode_b : B.lens);
  const val = a => E.adjusted_value(a, lens, cfg), spot = E.roster_spot_cost(cfg, values);
  const theyGet = a_gives.map(m => m.asset), theyGive = b_gives.map(m => m.asset);
  const sum = l => l.reduce((s, a) => s + val(a), 0), bodies = l => l.filter(a => !a.is_pick).length;
  const gets = sum(theyGet), gives = sum(theyGive), extra = bodies(theyGet) - bodies(theyGive);
  const scale = Math.max(1, gives, gets);
  const pctOf = (g, gv, ex) => (g - gv - Math.max(0, ex) * spot * 0.5) / scale * 100;
  const pct = pctOf(gets, gives, extra);
  const reasons = [];
  let score = pct;
  const lensTxt = lens === "contend" ? "pushing to win now" : lens === "rebuild" ? "rebuilding" : (rd ? (B.mode === "long shot" ? "a long shot this season" : B.mode) : "in between");
  reasons.push({ good: pct >= 0, text: pct >= 3 ? `Through their eyes (${lensTxt}) they come out ${Math.round(pct)}% ahead` : pct <= -3 ? `Through their eyes (${lensTxt}) they give up ${Math.round(-pct)}% more than they get` : `Through their eyes (${lensTxt}) it's about even` });
  const minStart = pos => (B.startVals[pos] && B.startVals[pos].length ? Math.min(...B.startVals[pos]) : 0);
  const incomingAt = pos => theyGet.filter(a => !a.is_pick && a.pos === pos);
  // need: a player they receive who would start, more so where they're thin
  for (const a of theyGet) {
    if (a.is_pick || !TI_POS.includes(a.pos)) continue;
    const m = minStart(a.pos);
    if (a.value > m) { const thin = B.thin.includes(a.pos); score += thin ? 6 : 3; reasons.push({ good: true, text: thin ? `${a.name} would start for them at ${a.pos}, where they're thin` : `${a.name} would start for them` }); }
  }
  // a hole: a starter they give up without a replacement
  for (const b of theyGive) {
    if (b.is_pick || !B.startIds.has(b.id)) continue;
    const repl = incomingAt(b.pos).some(a => a.value >= b.value * 0.8);
    if (repl) continue;
    const thin = B.thin.includes(b.pos);
    score -= thin ? 5 : 3; reasons.push({ good: false, text: thin ? `They'd open a hole at ${b.pos}, where they're already thin` : `They'd lose a starter at ${b.pos}` });
  }
  // their best player is rarely for sale
  const best = B.players.slice().sort((x, y) => y.value - x.value)[0];
  if (best && theyGive.some(b => b.id === best.id)) { score -= lens === "contend" ? 12 : 8; reasons.push({ good: false, text: `${best.name} is their best player; managers rarely move that piece${lens === "contend" ? ", and they're trying to win now" : ""}` }); }
  // what their mode wants
  if (!rd) {
    const picks = theyGet.filter(a => a.is_pick), young = theyGet.filter(a => !a.is_pick && a.age != null && a.age <= 24), old = theyGet.filter(a => !a.is_pick && a.age != null && a.age >= VET_AGE[a.pos]);
    if (lens === "contend" && picks.length && picks.reduce((s, a) => s + a.value, 0) > gets * 0.4) { score -= 4; reasons.push({ good: false, text: "They're trying to win now; picks don't help them this season" }); }
    if (lens === "rebuild" && (picks.length || young.length)) { score += 4; reasons.push({ good: true, text: "Picks and youth are exactly what a rebuilding team wants" }); }
    if (lens === "rebuild" && old.length && old.reduce((s, a) => s + a.value, 0) > gets * 0.5) { score -= 4; reasons.push({ good: false, text: `${old[0].name} is ${Math.floor(old[0].age)}; a rebuilding team isn't buying that` }); }
  }
  // roster room
  const maxRoster = (lg.roster_positions || []).filter(p => !["IR", "TAXI"].includes(p)).length || parseInt(cfg.league.roster_size, 10) || 25;
  const over = (team_b.players || []).length + extra - maxRoster;
  if (extra > 0 && over > 0) { score -= 3; reasons.push({ good: false, text: `They'd have to drop ${over} ${over === 1 ? "player" : "players"} to fit this` }); }
  // habits
  const T = B.trades;
  if (T.n >= 3) { score += 3; reasons.push({ good: true, text: `An active trader: ${T.n} trades this season` }); }
  else if (T.n === 0 && (week || 0) >= 4) { score -= 3; reasons.push({ good: false, text: "They haven't made a trade this season" }); }
  if (theyGet.length > theyGive.length && T.n >= 2 && T.multi === 0) { score -= 3; reasons.push({ good: false, text: "They've never taken the extra pieces in a two-for-one" }); }
  if (!rd && theyGet.some(a => a.is_pick) && T.picksGot >= 2) { score += 2; reasons.push({ good: true, text: "They've collected picks in trades before" }); }
  const band = NEGO_BANDS.find(([c]) => score >= c);
  // the smallest change that gets to "Good chance": add one of your spare pieces, or ask for less
  const sweeteners = [];
  if (score < 3) {
    const inTrade = new Set(theyGet.concat(theyGive).map(a => a.id));
    const pool = (Ap ? Ap.assets : []).filter(a => !inTrade.has(a.id) && a.value > 0 && !(Ap.startIds.has(a.id) && a.value > gives * 0.6)).sort((x, y) => x.value - y.value);
    const youGet = theyGive.reduce((s, a) => s + a.value, 0), youGive = theyGet.reduce((s, a) => s + a.value, 0);
    let add = null;
    for (const c of pool) {
      const bonus = !c.is_pick && TI_POS.includes(c.pos) && c.value > minStart(c.pos) ? (B.thin.includes(c.pos) ? 6 : 3) : 0;
      const s2 = score + (pctOf(gets + val(c), gives, extra + (c.is_pick ? 0 : 1)) - pct) + bonus;
      if (s2 < 3) continue;
      if ((youGet - youGive - c.value) / Math.max(1, youGet, youGive + c.value) * 100 < -15) break;   // you'd be giving away too much
      add = { kind: "add", asset: c, score: s2, text: `Your ${c.is_pick ? "pick" : c.pos} they'd take; the deal stays fair for you` }; break;
    }
    if (add) sweeteners.push(add);
    if (theyGive.length > 1) {
      const drop = theyGive.slice().sort((x, y) => x.value - y.value)[0];
      const s2 = score + (pctOf(gets, gives - val(drop), extra + (drop.is_pick ? 0 : 1)) - pct) + (B.startIds.has(drop.id) ? 3 : 0);
      if (s2 >= 3) sweeteners.push({ kind: "drop", asset: drop, score: s2, text: "Ask for less: leave him out of the deal" });
    }
  }
  // the message: short, friendly, one clear ask
  const owner = team_b.owner && team_b.owner !== team_b.team_name ? team_b.owner : team_b.team_name;
  const names = l => l.map(a => a.is_pick ? a.name.split(" · ")[0] : a.name).join(l.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, " and $1");
  const hook = theyGet.filter(a => !a.is_pick).find(a => a.value > minStart(a.pos) && B.thin.includes(a.pos)) || theyGet.filter(a => !a.is_pick).find(a => a.value > minStart(a.pos));
  const why = hook ? `${hook.name} would slide right into your lineup at ${hook.pos}` : lens === "rebuild" && theyGet.some(a => a.is_pick) ? "the picks give you more to work with for the rebuild" : lens === "contend" ? "it helps you this season" : "I think it works for both of us";
  const fair = pct >= 15 ? "The calculators have it clearly in your favor." : pct >= 3 ? "The calculators have it a little in your favor."
    : pct <= -15 ? "I know it's light on paper, so tell me what gets it there." : pct <= -3 ? "It's a little light on paper, so I'm open to tweaks." : "The calculators call it even.";
  const message = `Hey ${owner}, quick one. Would you do ${names(theyGive)} for ${names(theyGet)}? ${why.charAt(0).toUpperCase() + why.slice(1)}. ${fair} No pressure either way.`;
  const summary = band[1] === "Very likely" || band[1] === "Good chance" ? `A deal they should like: it fits what ${team_b.team_name} needs.`
    : band[1] === "Coin flip" ? `Close. One small sweetener probably gets it done.` : `As offered, ${team_b.team_name} has little reason to say yes.`;
  const need = score < 3 ? Math.round((3 - score) / 100 * scale / 50) * 50 : 0;        // value to add to reach "Good chance"
  return { band: band[1], tone: band[2], score, pct, lens, lensTxt, reasons, sweeteners, need, message, summary, owner, mode: B.mode, thin: B.thin, deep: B.deep, trades: T };
}

return { met_weather, team_context, kdef_season_grades, kdef_ready, NFL_TEAMS, INJURY_OUT, WAIVER_GROUPS, STAR_RANK, is_star, live_matchup, power_rankings, accuracy, pts_key, current_nfl_week, prepare, refresh_stats, load_stats, lineup_helper, free_agents, team_profiles, negotiate,
  waiver_metric, defense_streamers, lineup_by_value, roster_moves, free_agent_board, player_card, rankings_by_list, adjust_projection, team_trends, trade_targets, faab_bid, pickup_guard, pickup_hype, waiver_check, week_context_nflv, nflv_league_stats, our_projections, nws_weather, week_grades, season_grades, season_points, past_week_grades };
})();
