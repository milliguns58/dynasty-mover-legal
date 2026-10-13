/* Your GM (Pro): a chat that knows your league. The phone assembles a "league brief" (every roster with our values and
   grades, standings and odds, this week's lineup and pickups, trade ideas, recent trades) and sends it with your
   question to your own Cloudflare Worker (gm/worker.js), which holds the Anthropic API key, checks the sign-in and the
   daily cap, and streams Claude's answer back. The brief is built once per data refresh, so repeat questions reuse
   the server's prompt cache. Editions without window.GM_CFG (the personal build) hide the tab.
   Desktop testing: the dev server answers /gm/chat with a stand-in; add ?gm=1 to the URL to try the screen in an
   edition without GM_CFG. Loaded after ui.js and uses its helpers (S, E, Week, Account, Pro, gradeOf, card, go...). */
"use strict";

const GM = (() => {
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const DEV = LOCAL && /[?&]gm=1/.test(location.search);
  const cfg = () => window.GM_CFG || (DEV ? { url: "", dailyCap: 40 } : null);
  const endpoint = () => { const c = cfg(); return c ? (c.url || (LOCAL ? location.origin + "/gm" : "")).replace(/\/$/, "") : ""; };
  const proOn = () => typeof Pro !== "undefined" && Pro.ON;
  const keyed = () => !!(cfg() && cfg().key);               // the personal build signs in with a key shared with the Worker
  const available = () => !!(cfg() && endpoint() && (proOn() || keyed() || DEV) && S.cfg && S.values);
  const CAP = () => parseInt((cfg() && cfg().dailyCap) || 40, 10);
  const ICON = `<svg class="gm-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM5 16l.9 2.1L8 19l-2.1.9L5 22l-.9-2.1L2 19l2.1-.9zM19 14l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="currentColor"/></svg>`;
  const POS = E.POSITIONS;
  let chat = null, chatKey = null, briefCache = { key: null, text: "" }, pending = false, names = null;

  // ---- state, kept per league ----
  function load() {
    const key = E.P && E.P.id;
    if (chat && chatKey === key) return chat;
    chat = (key && Store.get(E.f("gm.json"))) || { messages: [], usage: { date: "", n: 0 } };
    if (!Array.isArray(chat.messages)) chat.messages = [];
    chat.messages.forEach(m => { m.streaming = false; if (m.role === "assistant" && !m.content) m.content = "I didn't get an answer back. Try asking again."; });   // an answer cut off by a closed app
    chatKey = key;
    return chat;
  }
  const save = () => { if (E.P && E.P.id) Store.set(E.f("gm.json"), { messages: chat.messages.slice(-40).map(m => ({ role: m.role, content: m.content, kind: m.kind, week: m.week })), usage: chat.usage }); };
  const today = () => new Date().toISOString().slice(0, 10);
  const usedToday = () => { const c = load(); return c.usage && c.usage.date === today() ? c.usage.n : 0; };
  const bump = () => { const c = load(); c.usage = c.usage && c.usage.date === today() ? { date: c.usage.date, n: c.usage.n + 1 } : { date: today(), n: 1 }; save(); };

  // ---- the league brief ----
  const tagOf = a => { if (a.is_pick || !(a.ours > 0)) return ""; const d = gIdx(gradeOf(a, true).g) - gIdx(gradeOf(a).g); return d >= 2 ? " Buy" : d <= -2 ? " Sell" : ""; };
  const epTag = a => { const e = a.ep; if (!e || e.g < 3) return ""; const gap = (e.exp - e.pts) / e.g; return gap >= 2 ? ` EP+${gap.toFixed(1)}` : gap <= -2 ? ` EP${gap.toFixed(1)}` : ""; };
  const fcTag = a => (a.pred ? (E.is_redraft(S.cfg) ? ` ROS${a.pred.ros.toFixed(1)}` : ` NX${a.pred.next.toFixed(1)}`) : "");   // our forecast: rest of this season / next season, points a game
  // the app's own judgments on a player, so the GM reads him the way the app does: star (never benched healthy), his
  // age stage on the house cliffs, and for a QB whether he is scoring like a usable starter this season
  const ppgNow = a => { const wk = Store.get(`nflv_wk_${parseInt(S.cfg.season, 10)}.json`), o = wk && wk.players && wk.players[E.player_key(a.name, a.pos)]; return o && o[0] >= 3 ? o[2] / o[0] : null; };
  const appTags = a => {
    if (a.is_pick) return "";
    const t = [];
    if (Week.is_star(a)) t.push("STAR");
    const st = E.is_redraft(S.cfg) ? "" : E.age_stage(a.pos, a.age);
    if (st === "cliff") t.push(`past the ${a.pos} cliff`); else if (st === "near") t.push("cliff next year"); else if (st === "decline") t.push("declining");
    if (a.pos === "QB" && !E.is_redraft(S.cfg)) { const p = ppgNow(a), u = parseInt(S.cfg.league.num_qbs, 10) >= 2 ? E.QB_USABLE.sf : E.QB_USABLE.one; if (p != null) t.push(p >= u ? `usable QB ${p.toFixed(1)}/g` : p < u - 3 ? `not scoring ${p.toFixed(1)}/g` : `${p.toFixed(1)}/g`); }
    return t.length ? ` [${t.join(", ")}]` : "";
  };
  const line = a => a.is_pick ? a.name.replace(" · ", ", ") : `${a.name} (${a.pos} ${a.age != null ? Math.floor(a.age) : "?"} ${a.team || "FA"}) ${Math.round(a.value)} ${gradeOf(a).g}${tagOf(a)}${epTag(a)}${fcTag(a)}${appTags(a)}`;
  // ---- the manager's plan: win now, balanced or rebuild, asked first and kept with the league ----
  const PLANS = [["contend", "Win now"], ["neutral", "Balanced"], ["rebuild", "Rebuild"]];
  const plan = () => (S.cfg && S.cfg.plan) || null;
  const planLabel = p => (PLANS.find(x => x[0] === p) || [])[1] || "";
  function setPlan(p) {
    S.cfg.plan = p; E.save_config(S.cfg);
    if (S.sides && S.sides.A && (S.sides.A.team == null || S.sides.A.team === S.cfg.my_roster_id)) { S.sides.A.mode = p; saveUi(); }   // the trade screen's lens on your side follows
    briefCache = { key: null, text: "" };
  }
  /* The app's house rules, written from the engine's own constants so the GM and the app can never disagree. */
  function houseRules(rd, sf) {
    const out = ["# House rules (how this app judges players; follow them)"];
    if (rd) { out.push("- Redraft: points only. Age, runway, youth and draft slot count for nothing; the best roster scores the most this season. Most players can be replaced: sell the name, keep the points."); }
    else {
      const C = E.AGE_CLIFF;
      out.push(`- Age cliffs: RB ${C.RB}, WR ${C.WR}, TE ${C.TE}, QB ${C.QB}; the slide starts two years before each. Sell a year early rather than a year late. Player lines carry "declining", "cliff next year" or "past the cliff".`);
      out.push("- Young talent is the currency: never trade away or drop a young player with long-term value for a short-term fill-in.");
      out.push(`- Usable quarterbacks: a QB scoring ${sf ? E.QB_USABLE.sf : E.QB_USABLE.one}+ points a game this season is a usable starter and worth more than his reputation says; one well under it is worth less. Player lines show his points a game.${sf ? " Superflex: a young starting QB is the hardest asset to acquire; never give one away." : ""}`);
    }
    out.push(`- Stars start: a player tagged STAR who is healthy and has a game is never benched for a lesser player, whatever one week's projection says; only out, IR, bye or no team changes that. Only another star with the higher number takes his slot.`);
    out.push("- Never recommend starting a player projected for nothing; when two are close, the one starting now stays.");
    out.push("- Pickups: never drop a producing starter for a player who has not played unless he has a real role or is the hottest add in the league. Bids follow impact and demand, not value; a kicker or defense is a minimum bid.");
    out.push("- Grades: F is for a player with nothing going (no team, no role, or old and unproductive); anyone with a role, a starting job, youth or a rising trend is at least a D.");
    out.push("- Trades: within 5% of value is fair, 5 to 12% a slight edge, over 25% lopsided. The smallest sweetener that gets to yes is the right one.");
    return out;
  }
  const profiles = () => Week.team_profiles(S.values, S.cfg).teams;       // record, place, mode, thin/deep, trade habits (week.js)
  const habits = I => { const T = I.trades || {}; if (!T.n) return "no trades this season"; return `${T.n} ${T.n === 1 ? "trade" : "trades"} this season${T.picksGot || T.picksGave ? `, picks taken ${T.picksGot} / given ${T.picksGave}` : ""}${T.multi ? `, took the extra pieces ${T.multi}x` : ""}`; };

  function briefText(W, TR = null) {
    const v = S.values, lg = v.league;
    const PRc = E.prospects_cached(parseInt(S.cfg.season, 10) + 1);
    const key = [E.P && E.P.id, v.meta && v.meta.fetched, W && W.week, S.cfg.my_roster_id, PRc && PRc.built, TR && TR.at, (lg.teams || []).map(t => `${t.record}:${(t.players || []).length}:${(t.picks || []).length}`).join(",")].join("|");
    if (briefCache.key === key) return briefCache.text;
    const text = buildBrief(W, TR);
    briefCache = { key, text };
    return text;
  }

  function buildBrief(W, TR) {
    const v = S.values, c = S.cfg, lg = v.league, L = c.league, rd = E.is_redraft(c), sf = parseInt(L.num_qbs, 10) >= 2;
    const me = teamById(c.my_roster_id), week = W && W.week, P = E.project_standings(v, c), prof = profiles();
    const ppr = parseFloat(L.ppr || 0), pprTxt = ppr >= 1 ? "full PPR" : ppr > 0 ? "half PPR" : "standard scoring", tep = parseFloat(L.te_premium_bonus_pct || 0);
    const kind = (E.league_kind_label ? E.league_kind_label(c) : (rd ? "redraft" : "dynasty")).toLowerCase();
    const pct = x => `${Math.round((x || 0) * 100)}%`, mine = t => t.roster_id === c.my_roster_id;
    const out = [];
    out.push("# League");
    out.push(`${L.name || "League"}: ${lg.teams.length} teams, ${sf ? "superflex" : "1-QB"} ${kind}, ${pprTxt}${tep > 0 ? `, TE premium +${tep}%` : ""}. Season ${c.season}${week ? `, NFL week ${week}` : ""}.`);
    out.push(`Starting lineup: ${(lg.roster_positions_starters || L.starters).map(SLOT_LABEL).join(", ")}.`);
    const bits = [];
    if (lg.trade_deadline) bits.push(`trade deadline after week ${lg.trade_deadline}`);
    if (lg.playoff_week_start) bits.push(`playoffs start week ${lg.playoff_week_start} with ${lg.playoff_teams || 6} teams`);
    if (parseInt(lg.waiver_type, 10) === 2 && lg.waiver_budget) bits.push(`FAAB budget $${lg.waiver_budget} a season`);
    if (bits.length) out.push(bits.join("; ") + ".");
    out.push(me ? `The manager you work for runs ${me.team_name}.` : "The manager hasn't marked which team is theirs; ask if it matters.");
    out.push(`Values as of ${String((v.meta && v.meta.fetched) || "").slice(0, 16).replace("T", " ")}.`);
    out.push("");
    out.push("# The manager's plan");
    out.push(plan() ? `${planLabel(plan()).toUpperCase()}${plan() === "contend" ? ": buy this season's points with picks and prospects; sell nothing young unless it wins now." : plan() === "rebuild" ? ": sell players near the age cliff for youth and picks; this season's wins don't matter." : ": keep the window open and the future healthy; take the better side of value either way."} Advise for this plan in every answer. If the app's read of the team (Direction, below) disagrees with it, say so once, then advise for the plan.`
      : "NOT SET. Before anything else, ask the manager which plan this season is: rebuild, balanced, or win now (one short question, then give a provisional answer for the most likely one). The app's Plan buttons above the chat save it.");
    out.push("");
    out.push(...houseRules(rd, sf));
    try { const sc = Score.briefLine(c, v, W); if (sc) out.push(sc); } catch (e) { /* no record yet */ }
    try { const mt = marketText(); if (mt && c.league.use_market !== false) out.push(mt + " The app's trade verdicts are priced with it."); } catch (e) { /* none */ }
    out.push("");
    out.push("# How to read the numbers");
    out.push(`Player lines read: Name (position age team) value grade, then Buy or Sell when our grade and the price disagree. Value is the Dynasty Mover trade value (10,000 is the top asset in this format; QBs carry a premium because they cost more in trades${sf ? ", more so in superflex" : ""}). Grade is our outlook for ${rd ? "the rest of this season" : "the next few seasons"}, A+ down to F; the market grade is simply where the value ranks. Buy means our grade is two steps above what his price says; Sell means two below. Picks show the slot they project to from the original owner's projected finish.`);
    out.push(rd ? "ROS12.4 on a player line is our forecast of his points a game for the rest of this season, from a model fitted to thirteen seasons of NFL data (usage, expected points, snap share, team, history)."
      : "NX14.2 on a player line is our forecast of his points a game next season, from a model fitted to thirteen seasons of NFL data (usage, expected points, snap share, age by position, draft slot, team, history). The grade builds on it.");
    out.push("EP+2.1 on a player line means his usage this season (expected points from every play he was involved in) was worth 2.1 points a game more than he scored: due for more, a buy-low. EP-1.8 means he scored 1.8 a game above his usage: running hot, likely to cool.");
    out.push(`Odds come from simulating the remaining schedule thousands of times. A trade within 5% of total value is fair, 5 to 12% a slight edge, over 25% lopsided.${!rd && parseFloat(L.qb_trade_bump_pct ?? 15) > 0 ? ` In this app's trade verdicts a starting QB is priced ${parseFloat(L.qb_trade_bump_pct ?? 15)}% above his ranking value, because managers overpay for QBs.` : ""}`);
    out.push("");
    out.push("# Standings and projections");
    for (const I of [...prof].sort((a, b) => a.place - b.place)) {
      const p = P && P.by[I.t.roster_id];
      out.push(`${I.place}. ${I.t.team_name}${I.t.owner && I.t.owner !== I.t.team_name ? ` (manager ${I.t.owner})` : ""} (${I.t.record || "0-0"}${I.t.points_for ? `, ${Math.round(I.t.points_for)} pts` : ""}): ${I.mode}${p && P.weeks_left ? `; projected ${p.wins.toFixed(1)} wins, ${pct(p.playoff)} playoffs, ${pct(p.title)} title` : ""}${I.thin.length ? `; thin at ${I.thin.join("/")}` : ""}${I.deep.length ? `; deep at ${I.deep.join("/")}` : ""}; ${habits(I)}${mine(I.t) ? " (the manager's team)" : ""}`);
    }
    out.push("");
    out.push("# Rosters");
    const byPos = players => POS.map(pos => { const l = players.filter(a => a.pos === pos).sort((a, b) => b.value - a.value); return l.length ? `${pos}: ${l.map(line).join("; ")}` : null; }).filter(Boolean);
    for (const I of [...prof].sort((a, b) => (mine(a.t) ? -1 : mine(b.t) ? 1 : a.place - b.place))) {
      out.push(`## ${I.t.team_name} (${I.t.record || "0-0"}): ${I.mode}${mine(I.t) ? ". THE MANAGER'S TEAM" : ""}`);
      out.push(...byPos(I.players));
      const others = I.players.filter(a => !POS.includes(a.pos));
      if (others.length) out.push(`Other: ${others.map(a => `${a.name} (${a.pos})`).join("; ")}`);
      const picks = I.assets.filter(a => a.is_pick);
      if (picks.length) out.push(`Picks: ${picks.map(a => a.name.replace(" · ", ", ")).join("; ")}`);
      out.push("");
    }
    const PR = rd ? null : E.prospects_cached(parseInt(c.season, 10) + 1);
    if (PR && PR.players && PR.players.length) {
      out.push(`# Rookie class (${PR.draftYear} NFL draft; our prospect grades 0-100 like the player grades; college data from CollegeFootballData.com${PR.sample ? "; PLACEHOLDER DATA" : ""})`);
      out.push(PR.players.slice(0, 36).map(p => `${p.rank}. ${p.name} (${p.pos}, ${p.school}, ${p.cls}) grade ${p.grade} ${p.tier}; ${typeof prospectStat === "function" ? prospectStat(p) : ""}${p.drafted ? `; drafted ${p.drafted.round}.${p.drafted.overall} by ${p.drafted.team}` : ""}${p.note ? `. ${p.note}` : ""}`).join("\n"));
      if (me) {
        const picks = E.team_assets(v, c, me).filter(a => a.is_pick && parseInt(a.pick.season, 10) === PR.draftYear);
        if (picks.length) out.push(`The manager's picks in this draft: ${picks.map(a => a.name.replace(" · ", ", ")).join("; ")}. A pick's slot maps to the board rank: round 1 slot 7 is rank 7 in this ${lg.teams.length}-team league, round 2 slot 3 is rank ${lg.teams.length + 3}.`);
      }
      out.push("");
    } else if (!rd) E.prospects(parseInt(c.season, 10) + 1).catch(() => null);
    const owned = new Map(); for (const I of prof) for (const a of I.players) owned.set(a.id, I.t.team_name);
    const reg = v.players.filter(a => !a.is_pick && a.ep && a.ep.g >= 3 && a.value >= 800 && owned.has(a.id)).map(a => [a, (a.ep.exp - a.ep.pts) / a.ep.g]).filter(x => Math.abs(x[1]) >= 2);
    if (reg.length) {
      out.push("# Regression watch (usage versus points this season)");
      const fmtR = l => l.map(([a, g]) => `${a.name} (${a.pos}, ${owned.get(a.id)}) ${g > 0 ? "+" : ""}${g.toFixed(1)} a game`).join("; ");
      const under = reg.filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 6), over = reg.filter(x => x[1] < 0).sort((x, y) => x[1] - y[1]).slice(0, 6);
      if (under.length) out.push(`Scoring under their usage, due for more (buy low): ${fmtR(under)}.`);
      if (over.length) out.push(`Scoring over their usage, likely to cool (sell high): ${fmtR(over)}.`);
      out.push("");
    }
    if (TR && ((TR.adds || []).length || (TR.drops || []).length)) {
      const ownerSid = new Map(); for (const t of lg.teams) for (const pid of t.players || []) ownerSid.set(String(pid), t.team_name);
      const tl = l => l.map(r => `${r.name} (${r.pos} ${r.team || "FA"})${ownerSid.has(String(r.sid)) ? ` (on ${ownerSid.get(String(r.sid))})` : " (available here)"} ${E.compact(r.count)}`).join("; ");
      out.push("# Trending on Sleeper (adds and drops across all leagues, last 2 days: what the waiver wire is talking about)");
      if ((TR.adds || []).length) out.push(`Most added: ${tl(TR.adds)}.`);
      if ((TR.drops || []).length) out.push(`Most dropped: ${tl(TR.drops)}.`);
      out.push("");
    }
    if (me) {
      const I = prof.find(x => x.t.roster_id === me.roster_id);
      out.push("# The manager's team in detail");
      const inj = I.players.map(a => { const sid = a.sleeper_id, st = (lg.players && lg.players[sid] && lg.players[sid].injury) || (W && W.status && W.status[sid] && W.status[sid].inj); return st ? `${a.name} (${st})` : null; }).filter(Boolean);
      if (inj.length) out.push(`Injury status: ${inj.join("; ")}.`);
      if (W && !W.valuesOnly) {
        try {
          const LH = Week.lineup_helper(v, c, me, W);
          const rowTxt = r => `${r.slot ? r.slot + " " : ""}${r.name}${r.pts != null ? ` ${(+r.pts).toFixed(1)}` : ""}${r.opp ? ` vs ${r.opp}` : ""}${r.flag ? ` [${r.flag}]` : ""}${r.bold ? " (a bold call)" : ""}`;
          out.push(`This week's recommended lineup (week ${LH.week}, ${(+LH.rec_total).toFixed(1)} projected): ${LH.recommended.map(rowTxt).join("; ")}.`);
          if (LH.has_current && LH.gain > 0.05) out.push(`Their current lineup projects ${(+LH.cur_total).toFixed(1)}; the recommended one adds ${(+LH.gain).toFixed(1)}.`);
          if (LH.changes && LH.changes.length) out.push(`Changes from their current lineup: ${LH.changes.map(x => (typeof x === "string" ? x : `${x.action} ${x.name}${x.slot ? " at " + SLOT_LABEL(x.slot) : ""} (${(+x.pts || 0).toFixed(1)})${x.flag ? " [" + x.flag + "]" : ""}`)).join("; ")}.`);
          if (LH.notes && LH.notes.length) out.push(`Notes: ${LH.notes.join(" ")}`);
          const WG = Week.week_grades(v, c, W);
          const wk = I.players.map(a => (WG[a.sleeper_id] ? `${a.name} ${WG[a.sleeper_id].letter} (${WG[a.sleeper_id].pts.toFixed(1)})` : null)).filter(Boolean);
          if (wk.length) out.push(`This week's grades (projection ranked at the position): ${wk.join("; ")}.`);
        } catch (e) { console.error(e); }
        try {
          const fas = Week.free_agents(v, c, W).filter(suggestable), M = Week.waiver_metric(v, c, W);
          const moves = Week.roster_moves(v, c, me, W, { n: 6, per_group: 2, fas, metric: M });
          if (moves.length) out.push(`Suggested pickups: ${moves.map(m => `add ${m.add.name} (${m.add.pos} ${m.add.team || "FA"})${m.drop ? `, drop ${m.drop.name}` : ", open roster spot"}${m.faab != null ? `, bid $${m.faab}` : ""}: ${whyPlain(M[2], m.add)}`).join("; ")}.`);
          const best = [];
          for (const [grp, rows] of Week.free_agent_board(v, c, fas, M[0], M[2], 4)) if (rows.length) best.push(`${grp}: ${rows.map(a => `${a.name} ${Math.round(a.value)}`).join(", ")}`);
          if (best.length) out.push(`Best available free agents: ${best.join("; ")}.`);
        } catch (e) { console.error(e); }
      }
      try {
        const T = Week.trade_targets(v, c, me, week, 6);
        if (T.me) out.push(`Direction: ${T.me.direction === "contend" ? "contending" : T.me.direction === "rebuild" ? "rebuilding" : "in between"}${T.me.thin.length ? `; thin at ${T.me.thin.join("/")}` : ""}${T.me.deep.length ? `; deep at ${T.me.deep.join("/")}` : ""}.${T.timing && T.timing.left != null ? ` ${T.timing.left} weeks to the trade deadline.` : ""}`);
        if (T.ideas && T.ideas.length) out.push(`Trade ideas the app found: ${T.ideas.map(x => `${x.kind === "buy" ? "buy" : x.kind === "sell" ? "sell" : "fit"} with ${x.team.team_name}, get ${x.get.map(a => a.name).join(" + ")} for ${x.give.map(a => a.name).join(" + ")} (${x.why.join("; ")})`).join(". ")}.`);
      } catch (e) { console.error(e); }
      out.push("");
    }
    const lw = lastWeek(W, me);
    if (lw.length) { out.push("# Last week"); out.push(...lw); out.push(""); }
    const trades = (lg.trades || []).slice(-15).reverse();
    if (trades.length) {
      out.push("# Recent league trades (what each side received)");
      const nm = ids => (ids || []).map(id => (v.by_sleeper[String(id)] || {}).name || `player ${id}`);
      const pk = p => (typeof p === "string" ? p : p && p.season ? `${p.season} ${E.ordinal(p.round)}${p.original != null ? " (via " + ((teamById(p.original) || {}).team_name || "another team") + ")" : ""}` : "a pick");
      const tn = rid => { const t = teamById(rid); return t ? t.team_name : `roster ${rid}`; };
      for (const tr of trades) {
        const sides = Object.entries(tr.sides || {}).map(([rid, s]) => `${tn(rid)} got ${nm(s.players).concat((s.picks || []).map(pk)).join(", ") || "nothing"}`);
        out.push(`Week ${tr.week}: ${sides.join("; ")}.`);
      }
      out.push("");
    }
    out.push("# Top 40 players by value, the market scale");
    out.push(v.players.filter(a => !a.unranked && !a.is_pick).slice(0, 40).map((a, i) => `${i + 1}. ${line(a)}`).join("\n"));
    return out.join("\n");
  }

  /* Last week: the manager's matchup from the league schedule, their players' points, the league's high score, and the
     week's value movers from our own price history. */
  function lastWeek(W, me) {
    const v = S.values, lg = v.league, out = [], week = W && W.week;
    if (!week || week < 2) return out;
    const prev = week - 1, rows = (lg.schedule || {})[String(prev)] || [];
    if (rows.length) {
      const byId = Object.fromEntries(rows.map(r => [String(r[0]), r]));
      if (me && byId[String(me.roster_id)]) {
        const mine = byId[String(me.roster_id)], opp = rows.find(r => r[1] === mine[1] && String(r[0]) !== String(me.roster_id));
        const oppT = opp && teamById(opp[0]);
        out.push(`Week ${prev}: ${me.team_name} scored ${mine[2].toFixed(1)}${opp ? ` ${mine[2] > opp[2] ? "and beat" : mine[2] < opp[2] ? "and lost to" : "and tied"} ${oppT ? oppT.team_name : "the opponent"} (${opp[2].toFixed(1)})` : ""}.`);
      }
      const hi = rows.slice().sort((a, b) => b[2] - a[2])[0], lo = rows.slice().sort((a, b) => a[2] - b[2])[0];
      if (hi && hi[2] > 0) out.push(`League high score: ${(teamById(hi[0]) || {}).team_name || "?"} ${hi[2].toFixed(1)}; low: ${(teamById(lo[0]) || {}).team_name || "?"} ${lo[2].toFixed(1)}.`);
    }
    const wk = W && W.weekly && W.weekly[prev], pk = Week.pts_key ? Week.pts_key(S.cfg) : null;
    if (me && wk && pk) {
      const pts = E.team_assets(v, S.cfg, me).filter(a => !a.is_pick && a.sleeper_id && wk[a.sleeper_id]).map(a => [a.name, parseFloat(wk[a.sleeper_id][pk] || 0)]).sort((x, y) => y[1] - x[1]);
      if (pts.length) out.push(`The manager's players last week: ${pts.map(([n, p]) => `${n} ${p.toFixed(1)}`).join("; ")}.`);
    }
    try {
      const H = E.load_history();
      if (H && H.snapshots && H.snapshots.length >= 2) {
        // players who matter (worth 800+ now and 400+ a week ago), ranked by the size of the move in value, not the percentage
        const moves = v.players.filter(a => !a.is_pick && !a.unranked && a.value >= 800).map(a => { const c = E.price_changes(E.price_series(a.id, H))["7d"]; return c && a.value - c[0] >= 400 && Math.abs(c[1]) >= 8 ? [a, c[0], c[1]] : null; }).filter(Boolean);
        const up = moves.filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 5), down = moves.filter(x => x[1] < 0).sort((x, y) => x[1] - y[1]).slice(0, 5);
        const txt = l => l.map(([a, d, p]) => `${a.name} ${p > 0 ? "+" : ""}${Math.round(p)}%`).join(", ");
        if (up.length) out.push(`Value risers this week: ${txt(up)}.`);
        if (down.length) out.push(`Value fallers this week: ${txt(down)}.`);
      }
    } catch (e) { /* no history yet */ }
    return out;
  }

  // ---- the weekly report ----
  const REPORT_ASK = week => `Write my GM report for week ${week}${week > 1 ? ` (week ${week - 1}'s games are done)` : ""}. Use the Last week section and the rest of the brief. About 400 words, in this order, each part a one-line lead and then a few dashed bullets or a short paragraph: 1) Last week in one breath: my result and what carried or sank me. 2) Where I stand: place, playoff odds, what the next two weeks ask of me. 3) Movers: who on my team rose or fell in value, and whether to act on it. 4) Windows: two players around the league to go after now and one of mine to sell, each with the team to call and why they'd listen. 5) This week: the lineup call that matters most, and the one pickup worth a bid, with the bid. 6) One trade offer to send this week, with the message to the other manager. Plain text, no headers, no emoji.`;
  const reportFor = week => load().messages.find(m => m.kind === "report" && m.week === week && m.role === "assistant" && !m.streaming);
  function homeCard() {
    if (!cfg() || !S.cfg || !S.values || !teams().length) return "";
    if (!available()) return "";
    const week = S.W && S.W.week;
    if (locked()) return `<section class="card gm-home"><div class="gm-title">${ICON} Your GM report ${Pro.tag()}</div><div class="hint">Every week: what happened, where you stand, who to buy and sell, your lineup call, the pickup worth a bid, and one trade to send.</div><button class="btn soft block" data-lock="gm" style="margin-top:10px">Show me with Pro</button></section>`;
    const r = week ? reportFor(week) : null;
    if (r) return `<section class="card gm-home" id="gmHome" data-week="${week}"><div class="gm-title">${ICON} Week ${week} GM report</div><div class="hint gm-preview">${esc(r.content.split("\n").find(l => l.trim()) || "").slice(0, 160)}</div><button class="btn soft block" id="gmHomeRead" style="margin-top:10px">Read it</button></section>`;
    return `<section class="card gm-home" id="gmHome"><div class="gm-title">${ICON} Your GM report${week ? ` for week ${week}` : ""}</div><div class="hint">What happened, where you stand, who to buy and sell, your lineup call, the pickup worth a bid, and one trade to send.</div><button class="btn primary block" id="gmHomeGet" style="margin-top:10px">${week ? "Get this week's report" : "Get my report"}</button></section>`;
  }
  function bindHome(root) {
    const get = $("#gmHomeGet", root); if (get) get.onclick = () => openReport();
    const read = $("#gmHomeRead", root); if (read) read.onclick = () => { go("gm"); };
  }
  async function openReport() {
    go("gm");
    if (!available() || locked() || pending) return;
    const W = S.W || await weekData().catch(() => null);
    const week = (W && W.week) || 0;
    if (reportFor(week)) return;
    await send(REPORT_ASK(week), { kind: "report", week });
  }

  function tradeQuestion(r) {
    const nm = k => S.sides[k].items.map(a => `${a.name}${a.is_pick ? "" : ` (${a.pos}${a.age != null ? " " + Math.floor(a.age) : ""})`}`).join(", ");
    const A = teamById(S.sides.A.team), B = teamById(S.sides.B.team), v = plainVerdict(r);
    const meA = A && A.roster_id === S.cfg.my_roster_id;
    const N = S.nego && B ? ` The Negotiator reads ${B.team_name} as "${S.nego.band}": ${S.nego.reasons.map(x => x.text).join("; ")}.` : "";
    return `Look at this trade for me. ${meA ? "I" : A ? A.team_name : "Side A"} give${meA ? "" : "s"}: ${nm("A") || "nothing"}. ${B ? B.team_name : "The other side"} gives: ${nm("B") || "nothing"}. The app's verdict: ${v.title}. ${v.line}${N} Should I do it, and what would make it work for both sides?`;
  }
  const playerQuestion = a => `What's your read on ${a.name}${a.is_pick ? "" : ` (${a.pos}, ${a.team || "FA"})`} for my team: buy, sell or hold, and at what price?`;

  // ---- the screen ----
  const SUGGEST = {
    dynasty: ["What should I do before the trade deadline?", "Who on my team should I sell high?", "Find me a trade that helps me now", "Who should I start this week?", "What's my best pickup this week?", "Which rebuilding team should I call?"],
    redraft: ["Who should I start this week?", "What's my best pickup this week?", "Which trade helps me most this season?", "How do my playoff odds look?"],
  };
  function bubble(m, partial) {
    if (m.role === "user") return m.kind === "report" ? `<div class="msg user">Week ${esc(m.week)} GM report, please.</div>` : `<div class="msg user">${esc(m.content)}</div>`;
    if (m.role === "error") return `<div class="msg err">${esc(m.content)}</div>`;
    if (m.streaming && !m.content) return `<div class="msg gm"><span class="status">${esc(m.status || "Thinking…")}</span><span class="cursor"></span></div>`;
    const head = m.kind === "report" ? `<div class="gm-report-head">${ICON} Week ${esc(m.week)} GM report</div>` : "";
    return `<div class="msg gm${m.kind === "report" ? " report" : ""}">${head}${fmtAnswer(m.content, !partial)}${m.streaming ? `<span class="cursor"></span>` : ""}</div>`;
  }
  /* The answer as HTML: paragraphs, dashed or numbered lists, **bold**; player names link to their cards once the
     answer is complete. */
  function fmtAnswer(text, link) {
    const lines = esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").split("\n");
    let h = "", list = null, m;
    const close = () => { if (list) { h += `</${list}>`; list = null; } };
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) { close(); continue; }
      if ((m = /^(?:[-*•]\s+)(.*)$/.exec(t))) { if (list !== "ul") { close(); h += "<ul>"; list = "ul"; } h += `<li>${m[1]}</li>`; }
      else if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { if (list !== "ol") { close(); h += "<ol>"; list = "ol"; } h += `<li>${m[1]}</li>`; }
      else { close(); h += `<p>${t.replace(/^#+\s*/, "")}</p>`; }
    }
    close();
    return link ? linkNames(h) : h;
  }
  function linkNames(h) {
    if (!names || names.key !== (S.values.meta && S.values.meta.fetched)) {
      const seen = new Set(), list = [];
      for (const a of S.values.players) {
        if (a.is_pick || a.unranked || a.value < 150 || a.name.length < 6 || seen.has(a.name)) continue;
        seen.add(a.name); list.push([esc(a.name), a.id]);
      }
      names = { key: S.values.meta && S.values.meta.fetched, list: list.sort((x, y) => y[0].length - x[0].length) };
    }
    const links = [];
    for (const [n, id] of names.list) if (h.includes(n)) { h = h.split(n).join(`\u0001${links.length}\u0001`); links.push(`<a class="plink" data-pcard="${esc(id)}">${n}</a>`); }
    return h.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]);
  }
  function render(root) {
    if (!S.cfg) return needLeague(root);
    if (!S.values) return needValues(root);
    if (!available()) {
      const personal = window.EDITION === "personal";
      root.innerHTML = `<section class="card gm-head"><div class="gm-title">${ICON} Your GM</div>
        <div class="hint">A general manager who knows your league: every roster, our values and grades, your odds, this week's lineup and pickups. Ask it anything, from "who should I sell high?" to "write Dave a message for this trade".</div>
        <p class="note" style="margin-top:8px"><b>Not connected yet.</b> The GM talks to a small server of your own that holds the Anthropic key. Set it up with <b>gm\\README.md</b>: an Anthropic API key, a free Cloudflare Worker running gm\\worker.js, then its URL${personal ? " and your personal key" : ""} in <b>editions\\${personal ? "personal" : "pro"}\\www\\js\\edition.js</b> under GM_CFG, and rebuild.</p>
        <div class="gm-chips" style="margin-top:12px">${SUGGEST[E.is_redraft(S.cfg) ? "redraft" : "dynasty"].map(q => `<button disabled>${esc(q)}</button>`).join("")}</div></section>`;
      return;
    }
    if (locked()) {
      root.innerHTML = `<section class="card gm-head"><div class="gm-title">${ICON} Your GM ${Pro.tag()}</div>
        <div class="hint">A general manager who knows your league: every roster, our values and grades, your odds, this week's lineup and pickups. Ask it anything, from "who should I sell high?" to "write Dave a message for this trade".</div>
        <button class="btn primary block" data-lock="gm" style="margin-top:12px">Go Pro</button></section>`;
      return;
    }
    if (!teams().length) { root.innerHTML = emptyState("Sleeper leagues only", "Your GM needs a league imported from Sleeper so it knows the rosters.", null); return; }
    const c = load(), used = usedToday(), cap = CAP();
    const left = Math.max(0, cap - used);
    root.innerHTML = `<section class="card gm-head"><div class="gm-title">${ICON} Your GM${c.messages.length ? `<button class="btn sm ghost gm-new" id="gmClear" title="Start a new chat">New chat</button>` : ""}</div>
        <div class="hint">Knows your league: rosters, values, grades, odds, this week. Ask anything.</div>
        <div class="gm-meta">${used ? `${used} ${used === 1 ? "question" : "questions"} today · ${left} left` : `${cap} questions a day`}${c.messages.length ? ` · ${c.messages.filter(m => m.role === "user").length} in this chat` : ""}</div>
        <div class="gm-plan"><span class="gm-plan-l">${plan() ? "This season's plan" : "First, what's the plan this season?"}</span><div class="seg gm-plan-seg" id="gmPlan">${PLANS.map(([k, l]) => `<button data-plan="${k}" class="${plan() === k ? "on" : ""}">${l}</button>`).join("")}</div>
          ${plan() ? "" : `<div class="hint">The GM, the trade screen and the team read all advise for it. You can change it any time.</div>`}</div></section>
      <div class="gm-chat" id="gmChat">${c.messages.map(m => bubble(m)).join("")}</div>
      ${(() => { const w = S.W && S.W.week; return w && !reportFor(w) ? `<div class="gm-chips"><button id="gmReportChip" class="accent">${ICON} Get my week ${w} GM report</button></div>` : ""; })()}
      ${c.messages.length ? "" : `<div class="gm-chips">${SUGGEST[E.is_redraft(S.cfg) ? "redraft" : "dynasty"].map(q => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`}
      <div class="gm-input">${c.messages.length ? `<button class="btn ghost gm-newbtn" id="gmClear2" title="New chat" aria-label="New chat">New</button>` : ""}<textarea id="gmQ" rows="1" placeholder="Ask your GM…" aria-label="Your question" ${pending ? "disabled" : ""}></textarea><button class="btn primary" id="gmSend" aria-label="Send" ${pending ? "disabled" : ""}>Send</button></div>`;
    $$("#gmPlan button", root).forEach(b => b.onclick = () => { setPlan(b.dataset.plan); toast(`Plan: ${planLabel(b.dataset.plan)}`, 1400); render(root); });
    const ta = $("#gmQ", root);
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; };
    ta.oninput = grow;
    ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !/Mobi|Android/i.test(navigator.userAgent)) { e.preventDefault(); send(ta.value); } };
    $("#gmSend", root).onclick = () => send(ta.value);
    $$("[data-q]", root).forEach(b => b.onclick = () => send(b.dataset.q));
    const rc = $("#gmReportChip", root); if (rc) rc.onclick = () => openReport();
    const newChat = () => { if (pending) return; load().messages = []; save(); render(root); window.scrollTo(0, 0); toast("New chat. The GM still knows your league.", 1800); };
    for (const id of ["#gmClear", "#gmClear2"]) { const b = $(id, root); if (b) b.onclick = newChat; }
    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
  }
  function drawChat(partialLast) {
    const box = $("#gmChat"); if (!box) return;
    const c = load();
    if (partialLast && box.lastElementChild && c.messages.length) box.lastElementChild.outerHTML = bubble(c.messages[c.messages.length - 1], true);
    else box.innerHTML = c.messages.map(m => bubble(m)).join("");
    const chips = $(".gm-chips"); if (chips && c.messages.length) chips.remove();
    window.scrollTo(0, document.body.scrollHeight);
  }
  function setBusy(on) { const ta = $("#gmQ"), b = $("#gmSend"); if (ta) { ta.disabled = on; if (!on) { ta.value = ""; ta.style.height = "auto"; } } if (b) b.disabled = on; }

  // ---- sending ----
  // ---- the GM's tools: the app's own numbers for the players a question names, and its verdict on a trade ----
  function namedPlayers(q) {
    const text = " " + E.norm(String(q).replace(/[^\w\s'.-]/g, " ")) + " ", out = [], seen = new Set();   // punctuation off, so "Goff?" is Goff
    const rostered = new Map(); for (const t of teams()) for (const pid of t.players || []) rostered.set(String(pid), t);
    for (const a of S.values.players) {
      if (a.is_pick || seen.has(a.id)) continue;
      const full = E.norm(a.name), last = full.split(" ").slice(-1)[0];
      let hit = text.includes(" " + full + " ");
      if (!hit && last.length >= 4 && text.includes(" " + last + " ")) {         // a last name alone, when only one player carries it
        const same = S.values.players.filter(x => !x.is_pick && E.norm(x.name).split(" ").slice(-1)[0] === last);
        hit = same.length === 1 || (same.length > 1 && rostered.has(String(a.sleeper_id)) && same.filter(x => rostered.has(String(x.sleeper_id))).length === 1);
      }
      if (hit) { seen.add(a.id); out.push(a); }
      if (out.length >= 8) break;
    }
    return out.map(a => ({ a, team: rostered.get(String(a.sleeper_id)) || null }));
  }
  function playerFacts(a, team, W) {
    const bits = [], sid = String(a.sleeper_id || ""), rd = E.is_redraft(S.cfg);
    bits.push(`${a.name} (${a.pos} ${a.age != null ? Math.floor(a.age) : "?"} ${a.team || "FA"}): ${team ? `on ${team.team_name}${team.roster_id === S.cfg.my_roster_id ? " (the manager's team)" : ""}` : "free agent"}. Value ${Math.round(a.value)}, market grade ${gradeOf(a).g}${a.ours > 0 ? `, our grade ${gradeOf(a, true).g}` : ""}${appTags(a)}.`);
    const st = E.load_player_status()[sid] || {};
    if (st.inj) bits.push(`Injury: ${st.inj}.`); if (st.depth != null) bits.push(`Depth chart: ${a.pos}${st.depth}.`);
    if (W && W.proj && W.proj[sid]) { const p = W.proj[sid], c = W.ctx && W.ctx[a.team]; bits.push(`This week: ${(+p.pts).toFixed(1)} projected${c ? ` ${c.home ? "vs" : "at"} ${c.opp}` : ""}${(() => { const g = Week.week_grades(S.values, S.cfg, W)[sid]; return g ? `, weekly grade ${g.letter} (${g.label})` : ""; })()}.`); }
    else if (W && W.ctx && a.team && !W.ctx[a.team]) bits.push("This week: no game (bye).");
    const wk = (Store.get(`nflv_wk_${parseInt(S.cfg.season, 10)}.json`) || {}).players || {}, o = wk[E.player_key(a.name, a.pos)], ppr = parseFloat(S.cfg.league.ppr || 0);
    if (o && o[3]) { const ws = Object.keys(o[3]).map(Number).sort((x, y) => x - y), pts = w => { const g = o[3][w]; return g[0] + ppr * (g[1] - g[0]); }; bits.push(`Season: ${(ws.reduce((s, w) => s + pts(w), 0) / ws.length).toFixed(1)} a game over ${ws.length} games; last three: ${ws.slice(-3).map(w => `wk${w} ${pts(w).toFixed(1)}`).join(", ")}; opportunities a game ${(ws.reduce((s, w) => s + (o[3][w][2] || 0), 0) / ws.length).toFixed(1)}.`); }
    if (a.ep && a.ep.g >= 3) { const gap = (a.ep.exp - a.ep.pts) / a.ep.g; if (Math.abs(gap) >= 1) bits.push(`Usage says ${gap > 0 ? "more points are coming" : "he is running hot"} (${gap > 0 ? "+" : ""}${gap.toFixed(1)} a game vs his expected points).`); }
    if (a.pred) bits.push(rd ? `Our forecast: ${a.pred.ros.toFixed(1)} a game the rest of this season.` : `Our forecast: ${a.pred.next.toFixed(1)} a game next season, ${Math.round(a.pred.play * 100)}% to play 4+ games.`);
    return bits.join(" ");
  }
  function tradeFacts(named, W) {
    const me = teamById(S.cfg.my_roster_id); if (!me) return null;
    const mine = named.filter(x => x.team && x.team.roster_id === me.roster_id).map(x => x.a), theirs = named.filter(x => x.team && x.team.roster_id !== me.roster_id);
    if (!mine.length || !theirs.length) return null;
    const other = theirs[0].team, get = theirs.filter(x => x.team.roster_id === other.roster_id).map(x => x.a);
    const mode = (S.cfg.plan && S.cfg.plan !== "neutral") ? S.cfg.plan : "neutral";
    const side = l => E.evaluate_side ? E.evaluate_side(l.map(a => ({ asset: a, alts: [] })), mode, S.cfg) : null;
    const A = side(mine), B = side(get); if (!A || !B) return null;
    const give = A.adj || A.raw || 0, gets = B.adj || B.raw || 0, pct = Math.round(((gets - give) / Math.max(give, gets, 1)) * 100);
    const out = [`The manager gives ${mine.map(a => a.name).join(" + ")} (${Math.round(give)}) to ${other.team_name} for ${get.map(a => a.name).join(" + ")} (${Math.round(gets)}): ${pct >= 0 ? "+" : ""}${pct}% for the manager by this app's values${mode !== "neutral" ? `, priced for the ${mode === "contend" ? "win-now" : "rebuild"} plan` : ""}.`];
    try {
      const I = E.trade_impact(S.values, S.cfg, me, other, mine.map(x => ({ asset: x })), get.map(x => ({ asset: x }))), sd = I && I.sides && I.sides.A;
      if (sd) out.push(`The simulator (${I.weeks_left} weeks left): the manager's playoff odds ${Math.round(sd.playoff[0] * 100)}% -> ${Math.round(sd.playoff[1] * 100)}%, title odds ${Math.round(sd.title[0] * 100)}% -> ${Math.round(sd.title[1] * 100)}%, projected wins ${(+sd.wins[0]).toFixed(1)} -> ${(+sd.wins[1]).toFixed(1)}${sd.future ? `, roster value in two seasons ${Math.round(sd.future[0])} -> ${Math.round(sd.future[1])}` : ""}${sd.pick ? `; their own ${sd.pick.name} projects ${sd.pick.before.label} -> ${sd.pick.after.label}` : ""}.`);
    } catch (e) { /* no schedule (a league built by hand) */ }
    return out.join(" ");
  }
  function toolsFor(q, W) {
    try {
      const named = namedPlayers(q); if (!named.length) return "";
      const out = ["", "# About the players you asked about (the app's numbers, computed for this question)"];
      for (const x of named) out.push("- " + playerFacts(x.a, x.team, W));
      const tr = /\b(for|trade|swap|deal|give|get)\b/i.test(q) ? tradeFacts(named, W) : null;
      if (tr) { out.push(""); out.push("# The trade you asked about (the trade screen's verdict and the simulator)"); out.push(tr); }
      return out.join("\n");
    } catch (e) { console.error(e); return ""; }
  }
  async function send(q, tag = null) {
    q = String(q || "").trim();
    if (!q || pending || !available()) return;
    const c = load();
    if (usedToday() >= CAP()) { c.messages.push({ role: "error", content: `You've used today's ${CAP()} questions. The GM is back tomorrow.` }); drawChat(); return; }
    const a = Object.assign({ role: "assistant", content: "", streaming: true, status: "Reading your league…" }, tag || {});
    c.messages.push(Object.assign({ role: "user", content: q }, tag || {}), a); save();
    pending = true; setBusy(true); drawChat();
    try {
      const W = S.W || await weekData().catch(() => null);
      let TR = null;
      try { const [ad, dr] = await Promise.all([E.trending_list("adds", 10, S.values, true), E.trending_list("drops", 10, S.values, true)]); TR = { adds: ad.rows || [], drops: dr.rows || [], at: ad.fetched }; } catch (e) { TR = null; }
      const text = briefText(W, TR) + toolsFor(q, W);                          // the GM's tools: the app's numbers for what was asked
      a.status = "Thinking…"; drawChat(true);
      let token = "";
      if (keyed()) token = "key:" + cfg().key;
      else if (typeof Account !== "undefined" && Account.ON) token = await Account.token();
      else if (!DEV) throw new Error("Sign in to use the GM.");
      const hist = c.messages.filter(m => m !== a && m.role !== "error").slice(-16).map(m => ({ role: m.role, content: m.content }));
      await stream(endpoint() + "/chat", { brief: text, messages: hist, league: E.P && E.P.id }, token, d => { a.content += d; drawChat(true); });
      if (!a.content.trim()) a.content = "I didn't get an answer back. Try asking again.";
      bump();
    } catch (e) { a.role = "error"; a.content = e.message || "Something went wrong."; }
    a.streaming = false; pending = false; save(); drawChat(); setBusy(false);
  }
  async function stream(url, body, token, onDelta) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let res;
    try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }); }
    catch (e) { return viaNative(url, body, headers, onDelta); }       // the WebView refused the request: let the Android side make it
    if (!res.ok) throw new Error(await errorText(res));
    if (!res.body || !res.body.getReader) { for (const p of (await res.text()).split("\n\n")) handle(p, onDelta); return; }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) handle(p, onDelta);
    }
    if (buf.trim()) handle(buf, onDelta);
  }
  function handle(block, onDelta) {
    for (const ln of block.split("\n")) {
      if (!ln.startsWith("data:")) continue;
      let ev; try { ev = JSON.parse(ln.slice(5).trim()); } catch (e) { continue; }
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") onDelta(ev.delta.text || "");
      else if (ev.type === "error") throw new Error((ev.error && ev.error.message) || "The GM hit an error.");
      else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "refusal") onDelta("\n\nI can't help with that one.");
    }
  }
  async function errorText(res) {
    let t = "";
    try { const j = await res.json(); t = (j.error && (j.error.message || j.error)) || ""; } catch (e) { /* not json */ }
    return String(t || `The GM is unavailable right now (${res.status}).`);
  }
  async function viaNative(url, body, headers, onDelta) {
    if (typeof Net === "undefined" || !Net.request) throw new Error("Couldn't reach the GM. Check your connection.");
    const r = await Net.request("POST", url, JSON.stringify(body), headers);
    if (r.status >= 400) { let t = ""; try { const j = JSON.parse(r.body); t = j.error && (j.error.message || j.error); } catch (e) { /* not json */ } throw new Error(String(t || `The GM is unavailable right now (${r.status}).`)); }
    for (const p of String(r.body || "").split("\n\n")) handle(p, onDelta);
  }
  function open(opts = {}) {
    go("gm");
    if (opts.question && available() && !locked()) send(opts.question);
  }

  // the tab exists in the page for every edition; editions without GM_CFG (and the desktop without ?gm=1) drop it
  const tb = document.getElementById("tabGM");
  if (tb && !cfg()) tb.remove();

  /* The sign-in the Worker checks, for other screens that call it (the screenshot import). */
  async function authToken() {
    if (keyed()) return "key:" + cfg().key;
    if (typeof Account !== "undefined" && Account.ON) return await Account.token();
    if (DEV) return "dev";
    throw new Error("Sign in first.");
  }
  return { render, open, send, available, endpoint, authToken, tradeQuestion, playerQuestion, briefText, homeCard, bindHome, openReport, icon: () => ICON };
})();
