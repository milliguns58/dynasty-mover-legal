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

  return { ready, season, week_points, to_league, seasonFeatures, rosFeatures, weekFeatures, allowedTable, age_effect, linear };
})();
if (typeof module !== "undefined") module.exports = Predict;
