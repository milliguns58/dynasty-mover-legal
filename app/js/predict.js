/* Dynasty Mover: the prediction models. Three ridge regressions fitted by tools/predict/fit_models.py on nflverse and
   ffopportunity data (2013-2025) and shipped as coefficients in predict_params.js:
     next   next season's points a game, and the chance he plays 4+ games next season: the dynasty outlook
     ros    the rest of this season's points a game from the current week: the redraft outlook
     week   this week's points from what is known before kickoff: our half of the weekly grade (Sleeper's projection
            is the other half)
   Everything is half-PPR points a game; grades are by rank at the position, so the league's scoring only matters where
   we blend with Sleeper's projection (converted with the player's catches a game). A feature we can't compute counts
   as the training average (standardized zero), so a missing file degrades the forecast instead of breaking it.
   Inputs come from the engine's caches: the nflverse stats cache (v5: per-game points and opportunities, yards, TDs,
   shares, team context), snap counts, expected points, the game log (what each defense allows a position), Sleeper's
   depth chart and injury tags, and the week's lines (home, implied total). */
const Predict = (() => {
  const P = () => (typeof window !== "undefined" && window.PREDICT) || null;
  const POS = E.POSITIONS;
  const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hinge = (x, k) => Math.max(0, x - k);
  const mean = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const sdev = arr => { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1)); };
  const last = (arr, n) => arr.slice(-n);
  const half = o => (o && o[0] ? (o[1] + o[2]) / 2 / o[0] : 0);                     // half-PPR points a game from a stats-cache row
  const weeksOf = o => (o && o[3] ? Object.keys(o[3]).map(Number).sort((a, b) => a - b) : []);
  const gamePts = o => weeksOf(o).map(w => (o[3][w][0] + o[3][w][1]) / 2);
  const sigmoid = z => 1 / (1 + Math.exp(-z));

  function linear(block, F) {
    if (!block) return null;
    let y = block.intercept;
    for (let i = 0; i < block.features.length; i++) {
      const v = F[block.features[i]];
      if (v == null || Number.isNaN(v)) continue;                                        // unknown: the training mean
      y += block.coef[i] * ((v - block.mean[i]) / (block.sd[i] || 1));
    }
    return y;
  }
  const ready = () => { const p = P(); return !!(p && p.next && p.next.RB); };

  /* r: { pos, age (today), ageNext (at the start of next season), exp, pick, depth, inj, cur, y1, y2 (stats-cache rows),
         ep (expected-points row), snaps ([[week, share]...]), teamCtx ({g, att_pg, pass_epa_pa, rush_epa_pc}), week } */
  function seasonFeatures(r) {
    const o = r.cur, g = o ? o[0] : 0, F = {};
    F.ppg = half(o); F.games = g; F.pts = o ? (o[1] + o[2]) / 2 : 0;
    F.ppg_prev = half(r.y1); F.has_prev = r.y1 ? 1 : 0; F.games_prev = r.y1 ? r.y1[0] : 0; F.ppg_prev2 = half(r.y2);
    const att = o ? o[9] || 0 : 0, tgt = o ? o[10] || 0 : 0, car = o ? o[11] || 0 : 0, opps = att + tgt + car;
    F.opps_pg = g ? opps / g : 0; F.tgt_pg = g ? tgt / g : 0; F.car_pg = g ? car / g : 0; F.att_pg = g ? att / g : 0;
    F.tgt_share = o ? o[6] || 0 : 0; F.ay_share = o ? o[14] || 0 : 0; F.wopr = o ? o[15] || 0 : 0;
    const sn = (r.snaps || []).map(x => x[1]); F.snap_pct = sn.length ? mean(sn) : null; F.has_snap = sn.length ? 1 : 0;
    const e = r.ep; F.ep_pg = e && e[0] ? e[2] / e[0] : F.ppg; F.ep_diff_pg = e && e[0] ? (e[1] - e[2]) / e[0] : 0;
    F.td_rate = opps ? (o[13] || 0) / opps : 0; F.ypt = tgt ? (o[12] || 0) / tgt : 0; F.ypc = car ? (o[4] || 0) / car : 0;
    F.log_pick = Math.log(clip(r.pick || 260, 1, 300)); F.depth_rank = clip(r.depth || 3, 1, 4);
    const T = r.teamCtx || {}; F.team_att_pg = T.att_pg ?? null; F.team_pass_epa = T.pass_epa_pa ?? 0; F.team_rush_epa = T.rush_epa_pc ?? 0;
    F.games_missed = Math.max(0, (T.g || r.week || 0) - g);
    const gp = gamePts(o); F.best = gp.length ? Math.max(...gp) : 0; F.std_pts = sdev(gp);
    const a = r.ageNext ?? r.age ?? 27; F.age = a; F.age_h24 = hinge(a, 24); F.age_h27 = hinge(a, 27); F.age_h30 = hinge(a, 30); F.age_h33 = hinge(a, 33);
    F.exp = clip(r.exp || 0, 0, 20); F.rookie = F.exp <= 0 ? 1 : 0; F.year2 = F.exp === 1 ? 1 : 0;
    return F;
  }
  function rosFeatures(r, week) {
    const o = r.cur, g = o ? o[0] : 0, gp = gamePts(o), ws = weeksOf(o), F = {};
    F.pts_td = half(o); F.pts_l3 = mean(last(gp, 3)) ?? 0; F.games_td = g;
    const e = r.ep, ew = e && e[5] ? Object.keys(e[5]).map(Number).sort((a, b) => a - b) : [];
    F.ep_td = e && e[0] ? e[2] / e[0] : F.pts_td; F.ep_l3 = ew.length ? mean(last(ew, 3).map(w => e[5][w][1])) : F.pts_l3;
    const sn = r.snaps || []; F.snap_td = sn.length ? mean(sn.map(x => x[1])) : null; F.snap_l3 = sn.length ? mean(last(sn, 3).map(x => x[1])) : null; F.has_snap = sn.length ? 1 : 0;
    const opp = ws.map(w => o[3][w][2] || 0); F.opps_td = mean(opp) ?? 0; F.opps_l3 = mean(last(opp, 3)) ?? 0;
    F.tgt_share_td = o ? o[6] || 0 : 0; F.wopr_td = o ? o[15] || 0 : 0;
    F.ppg_prev = half(r.y1); F.has_prev = r.y1 ? 1 : 0; F.games_prev = r.y1 ? r.y1[0] : 0;
    F.log_pick = Math.log(clip(r.pick || 260, 1, 300)); F.depth_rank = clip(r.depth || 3, 1, 4);
    const a = r.age ?? 27; F.age = a; F.age_h27 = hinge(a, 27); F.age_h30 = hinge(a, 30); F.exp = clip(r.exp || 0, 0, 20); F.week = week;
    return F;
  }
  function weekFeatures(r, week, ctx, allowed) {
    const F = rosFeatures(r, week), gp = gamePts(r.cur), sn = r.snaps || [];
    F.pts_l1 = gp.length ? gp[gp.length - 1] : F.pts_td; F.snap_l1 = sn.length ? sn[sn.length - 1][1] : F.snap_l3;
    F.implied = ctx && ctx.implied != null ? ctx.implied : null; F.has_line = F.implied != null ? 1 : 0;
    F.home = ctx && ctx.home != null ? (ctx.home ? 1 : 0) : 0.5;
    F.allowed = allowed ?? null; F.rest = 7; F.questionable = r.inj === "Questionable" ? 1 : 0; F.week = week;
    return F;
  }

  /* The three forecasts for a player from the raw inputs (src_dmv builds r). */
  function season(r) {
    const p = P(); if (!ready() || !POS.includes(r.pos)) return null;
    const F = seasonFeatures(r), R = rosFeatures(r, r.week || 1);
    const next = linear(p.next[r.pos], F), play = sigmoid(linear(p.play[r.pos], F) ?? 0), ros = linear(p.ros[r.pos], R);
    return { next: Math.max(0, next ?? 0), play, ros: Math.max(0, ros ?? 0), F };
  }

  /* What each defense has allowed a position this season, a game, before this week (from the game-log cache). */
  const allowedCache = { key: null, table: null };
  function allowedTable(season, week) {
    const key = season + "|" + week;
    if (allowedCache.key === key) return allowedCache.table;
    const log = (Store.get(`nflv_log_${season}.json`) || {}).players || {}, sums = {};
    for (const [k, games] of Object.entries(log)) {
      const pos = k.split("|")[1]; if (!POS.includes(pos)) continue;
      for (const [w, line] of Object.entries(games)) {
        if (+w >= week || !line || !line[0]) continue;
        const o = sums[line[0]] || (sums[line[0]] = {}), t = o[pos] || (o[pos] = { pts: 0, weeks: new Set() });
        t.pts += ((+line[1] || 0) + (+line[2] || 0)) / 2; t.weeks.add(w);
      }
    }
    const table = {};
    for (const [opp, o] of Object.entries(sums)) { table[opp] = {}; for (const [pos, t] of Object.entries(o)) table[opp][pos] = t.weeks.size ? t.pts / t.weeks.size : null; }
    allowedCache.key = key; allowedCache.table = table;
    return table;
  }

  /* This week's points for an asset, in half-PPR, or null. Reads the caches by the player's name|pos key. */
  function week_points(a, W, cfg) {
    const p = P(); if (!ready() || !a || !POS.includes(a.pos) || !W || !W.week) return null;
    const season = parseInt(cfg.season, 10), k = E.player_key(a.name, a.pos);
    const cur = ((Store.get(`nflv_wk_${season}.json`) || {}).players || {})[k], y1 = ((Store.get(`nflv_reg_${season - 1}.json`) || {}).players || {})[k];
    if (!cur && !y1) return null;
    const ep = ((Store.get(`ep_${season}.json`) || {}).players || {})[k], snaps = ((Store.get(`snaps_${season}.json`) || {}).players || {})[k];
    const st = (W.status || E.load_player_status())[a.sleeper_id || ""] || {};
    const ctx = (W.ctx || {})[a.team || ""] || null, allowed = ctx && ctx.opp ? (allowedTable(season, W.week)[ctx.opp] || {})[a.pos] ?? null : null;
    const r = { pos: a.pos, age: a.age, exp: null, pick: a.pick ?? null, depth: st.depth ?? null, inj: st.inj || null, cur, y1, ep, snaps };
    const F = weekFeatures(r, W.week, ctx, allowed);
    if (r.exp == null) delete F.exp;                                                      // unknown experience: the training mean
    if (r.pick == null) delete F.log_pick;
    const y = linear(p.week[a.pos], F);
    return y == null ? null : Math.max(0, y);
  }
  /* Half-PPR to the league's scoring: catches a game times the PPR difference. */
  function to_league(pts_half, a, cfg) {
    const ppr = parseFloat((cfg.league || {}).ppr ?? 0.5), season = parseInt(cfg.season, 10);
    if (Math.abs(ppr - 0.5) < 0.01 || !a || a.pos === "QB") return pts_half;
    const o = ((Store.get(`nflv_wk_${season}.json`) || {}).players || {})[E.player_key(a.name, a.pos)];
    const rec_pg = o && o[0] ? (o[16] || 0) / o[0] : 0;
    return pts_half + (ppr - 0.5) * rec_pg;
  }
  const age_effect = pos => { const p = P(); return p && p.age_effect ? p.age_effect[pos] || null : null; };

  /* Next week's stat line (2026-10-26, the user's ask: a full line and points with learned weather and game-script
     effects, checked on seasons the fit never saw; tools/predict/line_model.py -> PREDICT.line). One ridge a stat per
     position, on the week model's inputs plus each stat's own numbers (a game this season, the last 3, recency-weighted
     0.75 a game back and blended with last season's as if it were 2 games), what the opponent has allowed the position
     a game per stat (shrunk to the league's average over 4 games), the team's pass attempts and carries a game, the
     Vegas spread and total, and the weather (sustained wind, cold; domes neutral). Every feature is built here as
     build_dataset.py and line_model.py build it, with the same fills for what is missing. Rain and snow are not in the
     history, so the hand rule stays on top of the model (passing x0.93, running x1.04, as in next_week_line).
     game: the ctx object of the game being predicted (W.ctx[team] or week.js schedule_ctx), with .week when it isn't
     W.week; left out, his next game (this week's if he hasn't played it, else the schedule's next, past a bye).
     Returns { week, opp, home, line: {att, cmp, pyd, ptd, int, car, ryd, rtd, tgt, rec, recyd, rectd}, other, pts_half,
     floor, ceiling, p20, effects: [{k, t, f}], thin }, all half-PPR (the caller scores the line its league's
     way; other = fumbles and two-point plays a game, which the line leaves out); floor and ceiling are the 20th and 80th
     percentile of what players with that projection scored in 2024-2025, p20 the share who scored 20+. Null when there
     is too little to go on (no game this season, or one and no last season): no bad advice.
     opts.asOf (2026-10-27, the projection record): predict game.week itself even when he has played it, from the games
     before it only, and without today's injury tag (the record has no week-by-week status). The season's target share,
     WOPR and team pace are still the season so far: the caches keep no week-by-week copy of those. */
  const LINE_ALL = ["att", "cmp", "pyd", "ptd", "int", "car", "ryd", "rtd", "tgt", "rec", "recyd", "rectd"];
  const LOG_IX = { cmp: 3, att: 4, pyd: 5, ptd: 6, int: 7, car: 8, ryd: 9, rtd: 10, rec: 11, tgt: 12, recyd: 13, rectd: 14 };   // the game log's order
  const Y1_IX = { att: 9, car: 11, tgt: 10, rec: 16, recyd: 12, ryd: 4, rtd: 5 };              // the season stats cache's row, when the career table is missing
  const WET = /rain|snow|shower|sleet|storm|drizzle/;
  const fixTeam = t => { const s = String(t || "").replace(/^@/, ""); return s === "LA" ? "LAR" : s; };   // nflverse's Rams code -> Sleeper's
  const numOr = v => (v == null || v === "" || !Number.isFinite(+v) ? null : +v);
  const linePts = L => 0.04 * (L.pyd || 0) + 4 * (L.ptd || 0) - 2 * (L.int || 0) + 0.1 * ((L.ryd || 0) + (L.recyd || 0)) + 6 * ((L.rtd || 0) + (L.rectd || 0)) + 0.5 * (L.rec || 0);
  function interp(xs, ys, x, scale) {          // numpy's interp: flat past the ends, or (scale) in proportion to x past the top
    if (!xs || !ys || !xs.length) return null;
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1);
    const n = xs.length - 1;
    return scale && xs[n] > 0 ? ys[n] * x / xs[n] : ys[n];
  }
  /* What each defense has allowed each position a game, per stat, before the week (from the game log), and the league's
     average a game (every defense's games so far): { opp: {team: {pos: {n, s: [12]}}}, lg: {pos: {n, s: [12]}} }. */
  const lineAllowedCache = { key: null, t: null };
  function lineAllowed(season, week) {
    const key = season + "|" + week;
    if (lineAllowedCache.key === key) return lineAllowedCache.t;
    const log = (Store.get(`nflv_log_${season}.json`) || {}).players || {}, sums = {};
    for (const [k, games] of Object.entries(log)) {
      const pos = k.split("|")[1]; if (!POS.includes(pos)) continue;
      for (const [w, line] of Object.entries(games)) {
        if (+w >= week || !line || !line[0]) continue;
        const o = sums[fixTeam(line[0])] || (sums[fixTeam(line[0])] = {}), byW = o[pos] || (o[pos] = {}), row = byW[w] || (byW[w] = LINE_ALL.map(() => 0));
        LINE_ALL.forEach((s, i) => { row[i] += parseFloat(line[LOG_IX[s]]) || 0; });
      }
    }
    const opp = {}, lg = {};
    for (const [team, o] of Object.entries(sums)) for (const [pos, byW] of Object.entries(o)) {
      const rows = Object.values(byW), L = lg[pos] || (lg[pos] = { n: 0, s: LINE_ALL.map(() => 0) });
      (opp[team] = opp[team] || {})[pos] = { n: rows.length, s: LINE_ALL.map((_, i) => rows.reduce((t, r) => t + r[i], 0) / rows.length) };
      L.n += rows.length; rows.forEach(r => r.forEach((v, i) => { L.s[i] += v; }));
    }
    for (const L of Object.values(lg)) L.s = L.s.map(v => (L.n ? v / L.n : null));
    lineAllowedCache.key = key; lineAllowedCache.t = { opp, lg };
    return lineAllowedCache.t;
  }
  /* The game's features (Vegas, home, weather) and each stat's interactions with them, on F (line_model.py set_game). */
  function lineGame(F, gm, stats, c) {
    const out = gm.indoor ? 0 : 1;
    F.implied = gm.implied ?? c.fill.implied; F.has_line = gm.implied != null ? 1 : 0;
    F.total = gm.total ?? c.fill.total; F.spread = gm.spread ?? c.fill.spread; F.home = gm.home == null ? 0.5 : (gm.home ? 1 : 0);
    F.outdoor = out; F.wind = out ? (gm.wind ?? c.fill.wind) : 0; F.wind15 = Math.max(0, F.wind - c.wind_knee);
    F.cold = out ? Math.max(0, c.cold_at - (gm.temp ?? c.fill.temp)) : 0;
    for (const s of stats) {
      const b = F[s + "_bl"];
      F["x_wind_" + s] = b * F.wind / 10; F["x_cold_" + s] = b * F.cold / 10; F["x_spread_" + s] = b * F.spread / 7;
      F["x_imp_" + s] = b * (F.implied - c.fill.implied) / 5; F["x_m_" + s] = b * F["m_" + s];
    }
    return F;
  }
  function week_line(a, W, cfg, game, opts) {
    const asOf = !!(opts && opts.asOf);
    const p = P(), c = p && p.line;
    if (!c || !a || !c[a.pos] || !W || !W.week || !a.team || a.team === "FA") return null;
    const season = parseInt(cfg.season, 10), k = E.player_key(a.name, a.pos), blk = c[a.pos], stats = blk.stats;
    const log = ((Store.get(`nflv_log_${season}.json`) || {}).players || {})[k] || {};
    if (!game) {                                                                             // no game given: his next one, as next_week_line finds it
      const sc = (w) => (typeof Week !== "undefined" && Week.schedule_ctx ? Week.schedule_ctx(a.team, w, season) : null), now = !!log[W.week];
      let wk = now ? W.week + 1 : W.week, g0 = now ? sc(wk) : ((W.ctx || {})[a.team] || (Object.keys(W.ctx || {}).length ? null : sc(wk)));
      if (!g0) { const nx = sc(wk + 1); if (nx) { wk += 1; g0 = nx; } }                        // a bye: the week after
      game = g0 ? Object.assign({}, g0, { week: wk }) : null;
    }
    if (!game) return null;                                                                  // no game on the schedule: nothing to predict
    const played = Object.keys(log).map(Number).filter(w => log[w]).sort((x, y) => x - y);
    let week = parseInt(game.week || W.week, 10);
    if (!asOf && played.length && played[played.length - 1] >= week) week = played[played.length - 1] + 1;   // he has played that week: this is his next game
    const games = played.filter(w => w < week).map(w => log[w]), g = games.length;
    const cur = ((Store.get(`nflv_wk_${season}.json`) || {}).players || {})[k], y1 = ((Store.get(`nflv_reg_${season - 1}.json`) || {}).players || {})[k];
    const prev = ((Store.get(`nflv_car_${season - 1}.json`) || {}).players || {})[k];        // [team, games, std, ppr, then the game log's line]
    const prevG = prev ? parseFloat(prev[1]) || 0 : (y1 && y1[0]) || 0, hasPrev = prevG > 0;
    if (!cur || g < 1 || (g < 2 && !hasPrev)) return null;
    const ep = ((Store.get(`ep_${season}.json`) || {}).players || {})[k];
    const snaps = ((((Store.get(`snaps_${season}.json`) || {}).players || {})[k]) || []).filter(x => x[0] < week);
    const st = (W.status || E.load_player_status())[a.sleeper_id || ""] || {};
    const r = { pos: a.pos, age: a.age, exp: null, pick: a.pick ?? null, depth: st.depth ?? null, inj: asOf ? null : st.inj || null, cur, y1, ep, snaps };
    const F = weekFeatures(r, week, game, null);
    if (r.pick == null) delete F.log_pick;                                                   // unknown draft slot: the training mean
    F.games_td = g; F.has_prev = hasPrev ? 1 : 0;
    // points, snap shares and expected points re-read over his game-log weeks, so they line up with the training rows:
    // a week of snaps or expected points without a stat line isn't a training game, and a game without a snap count
    // still counts in the last 3 (as pandas' rolling mean skips it)
    const gw = played.filter(w => w < week), sb = {}, eb = (ep && ep[5]) || {}, nn = arr => arr.filter(v => v != null);
    for (const x of snaps) sb[x[0]] = x[1];
    const ptsG = games.map(l => ((parseFloat(l[1]) || 0) + (parseFloat(l[2]) || 0)) / 2), sv = gw.map(w => sb[w] ?? null), ev = gw.map(w => (eb[w] ? eb[w][1] : null));
    F.pts_td = mean(ptsG); F.pts_l3 = mean(last(ptsG, 3));
    const s3 = mean(nn(last(sv, 3)));
    F.snap_td = mean(nn(sv)) ?? c.fill.snap; F.snap_l3 = s3 ?? c.fill.snap; F.snap_l1 = sv[sv.length - 1] ?? s3 ?? c.fill.snap; F.has_snap = nn(sv).length ? 1 : 0;
    F.ep_td = mean(nn(ev)) ?? F.pts_td; F.ep_l3 = mean(nn(last(ev, 3))) ?? F.pts_l3;
    const T = E.nflv_team_ctx(season, true), tm = T[a.team] || T[a.team === "LAR" ? "LA" : a.team] || null, has = tm && tm.g > 0;
    const ta = has ? tm.att_pg : c.fill.t_att, tc = has ? tm.car_pg : c.fill.t_car;
    F.t_plays = ta + tc; F.t_pass = ta + tc > 0 ? ta / (ta + tc) : null;
    const opp = fixTeam(game.opp), A = lineAllowed(season, week), oa = (A.opp[opp] || {})[a.pos] || null, la = A.lg[a.pos] || null;
    for (const s of stats) {
      const i = LINE_ALL.indexOf(s), v = games.map(l => parseFloat(l[LOG_IX[s]]) || 0);
      let wn = 0, wd = 0;
      v.forEach(x => { wn = wn * 0.75 + x; wd = wd * 0.75 + 1; });
      const wt = wd ? wn / wd : 0, td = mean(v) ?? 0;
      const pv = !hasPrev ? 0 : prev ? (parseFloat(prev[LOG_IX[s] + 1]) || 0) / prevG : Y1_IX[s] != null ? (parseFloat(y1[Y1_IX[s]]) || 0) / prevG : td;
      F[s + "_td"] = td; F[s + "_l3"] = mean(last(v, 3)) ?? 0; F[s + "_pv"] = pv;
      F[s + "_bl"] = hasPrev ? (g * wt + c.k_prev * pv) / (g + c.k_prev) : wt;
      const lgv = la ? la.s[i] : null, n = oa ? oa.n : 0, op = oa ? oa.s[i] : lgv;
      F["m_" + s] = lgv != null && lgv > 0.05 ? Math.log(clip(((n * op + c.k_opp * lgv) / (n + c.k_opp)) / lgv, 0.5, 2)) : 0;
    }
    // the game: Vegas (a schedule game carries the implied total and the total; the spread follows from them), weather
    const total = numOr(game.total), implied = numOr(game.implied);
    let spread = numOr(game.spread);
    if (spread == null && total != null && implied != null) spread = total - 2 * implied;
    const indoor = !!game.indoor, later = !!game.later || (game.gust == null && game.wind == null && game.temp == null);
    const gm = { implied, total, spread, home: game.home ?? null, indoor, temp: numOr(game.temp),
      wind: numOr(game.wind) ?? (numOr(game.gust) != null ? numOr(game.gust) / c.gust : null) };
    const wet = !indoor && !later && (WET.test(String(game.weather || "").toLowerCase()) || numOr(game.precip) >= 50);
    const run = (Fx, wetX) => {
      const L = {};
      for (const s of LINE_ALL) L[s] = 0;
      for (const s of stats) L[s] = Math.max(0, linear(blk[s], Fx) ?? 0);
      if (wetX) {                                                                            // the hand rule for rain and snow (not learned)
        for (const s of ["pyd", "ptd", "recyd", "rectd"]) L[s] *= 0.93;
        if (a.pos === "QB" || a.pos === "RB") for (const s of ["car", "ryd", "rtd"]) L[s] *= 1.04;
      }
      return L;
    };
    const other = blk.other || 0, ptsOf = L => Math.max(0, linePts(L) + other);
    const alt = (over, wetX, noMatchup) => {
      const Fx = Object.assign({}, F);
      if (noMatchup) for (const s of stats) Fx["m_" + s] = 0;
      return ptsOf(run(lineGame(Fx, Object.assign({}, gm, over), stats, c), wetX));
    };
    lineGame(F, gm, stats, c);
    const line = run(F, wet), pts = ptsOf(line), ratio = b => (b > 0 ? pts / b : 1);
    // what moved it: the matchup, the game script, the weather (each against a neutral version of the same game)
    const effects = [];
    effects.push({ k: "Matchup", t: `What ${opp || "the opponent"} allows ${a.pos}s, stat by stat`, f: ratio(alt({}, wet, true)) });
    if (implied != null || total != null) {
      const sp = Math.round(F.spread * 2) / 2, ln = sp < 0 ? `favored by ${-sp}` : sp > 0 ? `a ${sp}-point underdog` : "an even game";
      effects.push({ k: "Game script", t: `${ln}, total ${F.total}, ${a.team || "his team"} expected to score ${F.implied.toFixed(1)}`, f: ratio(alt({ implied: c.fill.implied, total: c.fill.total, spread: c.fill.spread }, wet, false)) });
    }
    if (indoor) effects.push({ k: "Weather", t: "Indoors: no weather effect", f: 1 });
    else if (later) effects.push({ k: "Weather", t: "Forecast not out yet: an average day outdoors", f: 1 });
    else {
      const why = [];
      if (F.wind) why.push(`wind ${Math.round(F.wind)} mph`);
      if (gm.temp != null) why.push(`${Math.round(gm.temp)}°F`);
      if (wet) why.push(String(game.weather || `${Math.round(numOr(game.precip))}% chance of rain`).toLowerCase() + " (rain/snow rule)");
      effects.push({ k: "Weather", t: why.join(", ") || "outdoors", f: ratio(alt({ wind: null, temp: null }, false, false)) });
    }
    const band = blk.band;
    return { week, opp, home: game.home ?? null, line, other, pts_half: pts,
      floor: band ? Math.max(0, interp(band.x, band.lo, pts, true)) : null, ceiling: band ? interp(band.x, band.hi, pts, true) : null, p20: band ? interp(band.x, band.p_big, pts) : null,
      effects, thin: g < 3 };
  }

  return { ready, season, week_points, week_line, to_league, seasonFeatures, rosFeatures, weekFeatures, allowedTable, age_effect, linear };
})();
if (typeof module !== "undefined") module.exports = Predict;
