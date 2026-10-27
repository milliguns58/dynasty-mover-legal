/* The scorecard (score.js): how right the app has been, measured against what happened. Each week the app keeps what
   it said (every rostered player's projection and grade, and the lineup it recommended for the manager's team); once
   the games are played it compares them with the points by week (Sleeper's, in the nflverse cache). The League tab
   shows the numbers, the player card shows last week's call, and the GM reads a summary. One file per league. */
"use strict";

const Score = (() => {
const FILE = "score.json";                              // {v, weeks: {week: {at, proj: {sid: pts}, grade: {sid: letter}, lineup: {rid: {sids, proj}}}}}
const load = () => { const c = Store.get(E.f(FILE)); return c && c.v === 1 && c.weeks ? c : { v: 1, weeks: {} }; };
const save = c => Store.set(E.f(FILE), c);
const letter = a => (a && a.oscore != null ? (E.GRADE_CUTS.find(([c]) => a.oscore >= c) || [, ""])[1] : "");

/* What the app says this week, kept once per week (the first look; later looks don't rewrite it). */
function snapshot(cfg, values, W) {
  if (!W || !W.week || W.valuesOnly || !values || !values.league) return;
  const c = load(), w = String(W.week);
  if (c.weeks[w] && c.weeks[w].proj) return;
  const proj = {}, grade = {};
  const rostered = new Set(values.league.teams.flatMap(t => (t.players || []).map(String)));
  for (const a of values.players) {
    const sid = String(a.sleeper_id || "");
    if (!sid || !rostered.has(sid)) continue;
    const p = W.proj[sid], m = typeof Week !== "undefined" && Week.model_week_pts ? Week.model_week_pts(a, cfg, W) : null;   // the number the screens show (2026-10-27)
    if (m != null && m > 0) proj[sid] = Math.round(m * 10) / 10;
    else if (p && p.pts > 0) proj[sid] = Math.round(p.pts * 10) / 10;
    const g = letter(a); if (g) grade[sid] = g;
  }
  c.weeks[w] = Object.assign(c.weeks[w] || {}, { at: new Date().toISOString(), proj, grade, lineup: (c.weeks[w] || {}).lineup || {} });
  save(c);
}
/* The lineup the app recommended for a team this week, kept once. */
function saveLineup(cfg, W, rid, L) {
  if (!W || !W.week || !L || !L.recommended) return;
  const c = load(), w = String(W.week), wk = c.weeks[w] || (c.weeks[w] = { at: new Date().toISOString(), proj: {}, grade: {}, lineup: {} });
  wk.lineup = wk.lineup || {};
  if (wk.lineup[rid]) return;
  const sids = L.recommended.map(r => { const a = r.id && S.values.by_id[r.id]; return a ? String(a.sleeper_id || "") : (r.pid ? String(r.pid) : ""); }).filter(Boolean);
  wk.lineup[rid] = { sids, slots: L.recommended.map(r => r.slot), proj: Math.round((L.rec_total || 0) * 10) / 10 };
  save(c);
}

/* Actual points by week in this league's scoring, by Sleeper id, from the stats cache. */
function actuals(cfg, values) {
  const season = parseInt(cfg.season, 10), wk = (Store.get(`nflv_wk_${season}.json`) || {}).players || {}, ppr = parseFloat(cfg.league.ppr || 0);
  const out = {};                                        // sid -> {week: pts}
  for (const a of values.players) {
    const sid = String(a.sleeper_id || ""); if (!sid) continue;
    const o = wk[E.player_key(a.name, a.pos)]; if (!o || !o[3]) continue;
    out[sid] = Object.fromEntries(Object.entries(o[3]).map(([w, g]) => [w, Math.round((g[0] + ppr * (g[1] - g[0])) * 10) / 10]));
  }
  return out;
}
const weeksDone = (c, act, current) => Object.keys(c.weeks).map(Number).filter(w => w < (current || 99) && Object.values(act).some(m => m[w] !== undefined)).sort((a, b) => a - b);

/* The numbers: projection error, lineup efficiency and grade calibration, for the last played week and the season. */
function report(cfg, values, W) {
  const c = load(), act = actuals(cfg, values), cur = W && W.week ? W.week : null, weeks = weeksDone(c, act, cur);
  if (!weeks.length) return null;
  const me = cfg.my_roster_id;
  const projStats = ws => {
    let n = 0, abs = 0, bias = 0, close = 0;
    for (const w of ws) for (const [sid, p] of Object.entries(c.weeks[w].proj || {})) { const a = act[sid] && act[sid][w]; if (a === undefined) continue; n++; abs += Math.abs(a - p); bias += a - p; if (Math.abs(a - p) <= 5) close++; }
    return n ? { n, mae: abs / n, bias: bias / n, close: close / n } : null;
  };
  const lineupStats = ws => {
    let n = 0, got = 0, best = 0, proj = 0;
    for (const w of ws) {
      const L = me != null && c.weeks[w].lineup && c.weeks[w].lineup[me]; if (!L) continue;
      const team = values.league.teams.find(t => t.roster_id === me); if (!team) continue;
      const pts = sid => (act[sid] && act[sid][w]) || 0;
      const mine = L.sids.reduce((s, sid) => s + pts(sid), 0);
      // the best the roster could have scored that week in the same slots, by actual points
      const roster = (team.players || []).map(String).map(sid => ({ sid, pos: (values.by_sleeper[sid] || {}).pos, pts: pts(sid) })).filter(x => x.pos);
      const slots = L.slots.map(s => String(s).toUpperCase()), used = new Set(); let ideal = 0;
      const take = elig => { const x = roster.filter(r => !used.has(r.sid) && elig.includes(r.pos)).sort((a, b) => b.pts - a.pts)[0]; if (x) { used.add(x.sid); ideal += x.pts; } };
      for (const s of slots) if (["QB", "RB", "WR", "TE", "K", "DEF"].includes(s)) take([s]);
      for (const s of slots) if (E.FLEX_ELIGIBLE[s]) take(E.FLEX_ELIGIBLE[s]);
      n++; got += mine; best += ideal; proj += L.proj || 0;
    }
    return n ? { n, got, best, proj, eff: best ? got / best : 0 } : null;
  };
  const gradeStats = () => {                                // the first grade on record vs points a game since, by bucket
    const first = {}; for (const w of weeks) for (const [sid, g] of Object.entries(c.weeks[w].grade || {})) if (!first[sid]) first[sid] = { g, w };
    const buckets = {};
    for (const [sid, f] of Object.entries(first)) {
      const ws = weeks.filter(w => w >= f.w && act[sid] && act[sid][w] !== undefined); if (!ws.length) continue;
      const b = f.g[0], B = buckets[b] || (buckets[b] = { n: 0, pts: 0 });
      B.n++; B.pts += ws.reduce((s, w) => s + act[sid][w], 0) / ws.length;
    }
    return ["A", "B", "C", "D", "F"].map(b => buckets[b] ? { g: b, n: buckets[b].n, ppg: buckets[b].pts / buckets[b].n } : null).filter(Boolean);
  };
  const last = weeks[weeks.length - 1];
  return { last, weeks, lastProj: projStats([last]), seasonProj: projStats(weeks), lastLineup: lineupStats([last]), seasonLineup: lineupStats(weeks), grades: gradeStats() };
}
/* Last week's call on one player, for his card: what we said, what he scored. */
function lastCall(cfg, values, a, W) {
  const c = load(), sid = String(a.sleeper_id || ""), act = actuals(cfg, values)[sid]; if (!sid || !act) return null;
  const cur = W && W.week ? W.week : 99;
  const ws = Object.keys(c.weeks).map(Number).filter(w => w < cur && c.weeks[w].proj && c.weeks[w].proj[sid] !== undefined && act[w] !== undefined).sort((x, y) => y - x);
  if (!ws.length) return null;
  const w = ws[0]; return { week: w, said: c.weeks[w].proj[sid], got: act[w] };
}
/* One line for the GM brief. */
function briefLine(cfg, values, W) {
  const r = report(cfg, values, W); if (!r || !r.seasonProj) return "";
  const lp = r.lastProj, sl = r.seasonLineup;
  return `Our accuracy so far: projections off by ${r.seasonProj.mae.toFixed(1)} points a player a week on average (${Math.round(r.seasonProj.close * 100)}% within 5)${lp ? `, last week ${lp.mae.toFixed(1)}` : ""}${sl ? `; the lineups we recommended scored ${Math.round(sl.eff * 100)}% of the best possible` : ""}.`;
}
return { FILE, snapshot, saveLineup, report, lastCall, briefLine };
})();
