/* Trade history (history.js): every completed trade in the league, this season and the seasons before it, plus the
   trades saved from the trade screen, each scored by what happened next.
   Sleeper keeps each season as its own league, linked by previous_league_id, so the history walks that chain (up to
   five seasons). For each trade it records what every side got and gave (players, picks, FAAB), then works out:
     - the points each side's pieces have scored since the trade (nflverse weekly stats, in this league's PPR; a
       redraft league stops counting at the end of that season),
     - what the pieces are worth today (the app's values; a pick that has been used counts as the player it became),
     - what they were worth at the time, when the app was already keeping daily values (history.json).
   Finished seasons are downloaded once and kept; the current season is refreshed every six hours or on demand. */
"use strict";

const Hist = (() => {
const FILE = "thist.json", DFILE = "drafts.json", V = 2, MAX_SEASONS = 5, WEEKS = 18, FRESH_HOURS = 6, SNAP_DAYS = 4;   // a value "at the time" needs a snapshot within 4 days of the trade
const SL = E.SLEEPER_URL;
const DAY = 86400000;
const get = (url, fallback) => Net.json(url).then(x => (x === null || x === undefined ? fallback : x), () => fallback);

const cached = () => { const c = Store.get(E.f(FILE)); return c && c.v === V ? c : null; };

/* A season's teams by roster id: {rid: {name, owner, owner_id}}. */
function team_map(users, rosters) {
  const user = Object.fromEntries(users.map(u => [u.user_id, u])), teams = {};
  for (const r of rosters) {
    const u = user[r.owner_id] || {};
    teams[r.roster_id] = { name: (u.metadata || {}).team_name || u.display_name || `Roster ${r.roster_id}`, owner: u.display_name || "", owner_id: r.owner_id || null };
  }
  return teams;
}
/* A league's completed drafts: for every pick made, who held it to begin with (the slot's roster), so a traded pick can be
   followed to the player and a player to his draft day. Returns {drafts: [{draft_id, season, rounds, type, picks: {"round|original": pick}}],
   drafted: {season: picks}} where drafted keeps one draft a season for the traded picks: the rookie draft when the startup
   draft shares the season (the one with fewer rounds). */
async function parse_drafts(lg, rosters, drafts) {
  const out = [], drafted = {};
  for (const d of drafts) {
    if (d.status !== "complete") continue;
    const picks = await get(`${SL}/draft/${d.draft_id}/picks`, []);
    let slotToRoster = d.slot_to_roster_id || null;
    if (!slotToRoster && d.draft_order) {
      slotToRoster = {};
      const byOwner = Object.fromEntries(rosters.map(r => [r.owner_id, r.roster_id]));
      for (const [uid, slot] of Object.entries(d.draft_order)) if (byOwner[uid] !== undefined) slotToRoster[slot] = byOwner[uid];
    }
    const season = parseInt(d.season) || parseInt(lg.season), map = {};
    for (const p of picks) {
      if (!p.player_id) continue;
      const orig = slotToRoster && slotToRoster[p.draft_slot] !== undefined ? slotToRoster[p.draft_slot] : p.roster_id;   // no slot map: the picker held it
      map[`${p.round}|${orig}`] = { pid: String(p.player_id), no: p.pick_no, slot: p.draft_slot, round: p.round, by: p.roster_id };
    }
    const rounds = parseInt((d.settings || {}).rounds) || Math.max(0, ...picks.map(p => p.round || 0));
    out.push({ draft_id: String(d.draft_id), season, rounds, type: d.type || "", picks: map });
  }
  out.sort((a, b) => (a.season - b.season) || (b.rounds - a.rounds));
  for (const d of out) drafted[d.season] = d.picks;                 // the last draft of a season wins: the one with the fewest rounds
  return { drafts: out, drafted };
}
/* One season of one league: its teams, its completed trades, and its draft(s) with who went where. */
async function fetch_season(lid) {
  const lg = await get(`${SL}/league/${lid}`, null);
  if (!lg) throw new Error("league not found");
  const [users, rosters, drafts, ...txw] = await Promise.all([get(`${SL}/league/${lid}/users`, []), get(`${SL}/league/${lid}/rosters`, []),
    get(`${SL}/league/${lid}/drafts`, []), ...Array.from({ length: WEEKS }, (_, i) => get(`${SL}/league/${lid}/transactions/${i + 1}`, []))]);
  const teams = team_map(users, rosters);
  const trades = [];
  for (let w = 1; w <= WEEKS; w++) for (const t of txw[w - 1]) {
    if (t.type !== "trade" || t.status !== "complete") continue;
    const sides = {};
    const side = rid => (sides[String(rid)] = sides[String(rid)] || { got: { players: [], picks: [], faab: 0 }, gave: { players: [], picks: [], faab: 0 } });
    for (const rid of t.roster_ids || []) side(rid);
    for (const [pid, rid] of Object.entries(t.adds || {})) side(rid).got.players.push(String(pid));
    for (const [pid, rid] of Object.entries(t.drops || {})) side(rid).gave.players.push(String(pid));
    for (const pk of t.draft_picks || []) {
      const p = { season: parseInt(pk.season), round: parseInt(pk.round), original: parseInt(pk.roster_id) };
      side(pk.owner_id).got.picks.push(p); side(pk.previous_owner_id).gave.picks.push(p);
    }
    for (const b of t.waiver_budget || []) { side(b.receiver).got.faab += parseInt(b.amount) || 0; side(b.sender).gave.faab += parseInt(b.amount) || 0; }
    trades.push({ id: String(t.transaction_id), week: parseInt(t.leg || w), created: t.created || null, sides });
  }
  trades.sort((a, b) => (a.created || 0) - (b.created || 0));
  const D = await parse_drafts(lg, rosters, drafts);
  return { league_id: String(lid), season: parseInt(lg.season), name: lg.name, previous: lg.previous_league_id || null, status: lg.status || "",
    teams, trades, drafts: D.drafts, drafted: D.drafted, fetched: E.now_iso() };
}

/* The league's drafts alone (no trades), for the player card: the trade history's tables when they are on the phone,
   else a light download of each season's draft(s), kept in L.<id>.drafts.json. */
async function draft_tables(cfg, league) {
  const lid = String(league.league_id), c = cached();
  if (c && c.chain[0] === lid) return c.chain.map(id => { const s = c.seasons[id]; return { lid: id, season: s.season, previous: s.previous, teams: s.teams, drafts: s.drafts || [] }; });
  const d = Store.get(E.f(DFILE)), fresh = d && d.v === V && d.chain[0] === lid && Date.now() - new Date(d.fetched).getTime() < FRESH_HOURS * 3600000;
  if (fresh) return d.seasons;
  const old = d && d.v === V ? Object.fromEntries(d.seasons.map(s => [s.lid, s])) : {}, out = [];
  let id = lid;
  for (let i = 0; i < MAX_SEASONS && id; i++) {
    if (old[id] && i > 0) { out.push(old[id]); id = old[id].previous; continue; }
    const lg = await get(`${SL}/league/${id}`, null);
    if (!lg) break;
    const [users, rosters, drafts] = await Promise.all([get(`${SL}/league/${id}/users`, []), get(`${SL}/league/${id}/rosters`, []), get(`${SL}/league/${id}/drafts`, [])]);
    const D = await parse_drafts(lg, rosters, drafts);
    out.push({ lid: id, season: parseInt(lg.season), previous: lg.previous_league_id || null, teams: team_map(users, rosters), drafts: D.drafts });
    id = lg.previous_league_id || null;
  }
  Store.set(E.f(DFILE), { v: V, fetched: E.now_iso(), chain: out.map(s => s.lid), seasons: out });
  return out;
}
/* Where a player was taken in this league: {season, round, slot, no, by, rounds, kind} or {none, earliest}. */
async function draft_of(cfg, league, sid) {
  const tables = await draft_tables(cfg, league), earliest = tables.length ? Math.min(...tables.map(t => t.season)) : null;
  for (const s of tables) for (const d of s.drafts || []) for (const p of Object.values(d.picks || {})) {
    if (p.pid !== String(sid)) continue;
    const kind = E.is_redraft(cfg) ? "draft" : d.rounds > 10 ? "startup draft" : "rookie draft";
    return { season: d.season, round: p.round, slot: p.slot, no: p.no, by: (s.teams[p.by] || {}).name || `Roster ${p.by}`, rounds: d.rounds, kind, earliest };
  }
  return { none: true, earliest };
}

/* Download or refresh the history: the current league, then its previous seasons (a finished season is kept as is). */
async function ensure(cfg, league, opts = {}) {
  const lid = String(league.league_id), c = cached();
  if (c && !opts.force && c.chain[0] === lid && Date.now() - new Date(c.fetched).getTime() < FRESH_HOURS * 3600000) return c;
  const seasons = c ? Object.assign({}, c.seasons) : {}, chain = [];
  let id = lid;
  for (let i = 0; i < MAX_SEASONS && id; i++) {
    const old = seasons[id];
    if (old && i > 0) { chain.push(id); id = old.previous; continue; }
    try { const s = await fetch_season(id); seasons[id] = s; chain.push(id); id = s.previous; }
    catch (e) { if (old) { chain.push(id); id = old.previous; continue; } if (i === 0) throw e; break; }
    if (opts.progress) opts.progress(chain.length);
  }
  const out = { v: V, fetched: E.now_iso(), chain, seasons: Object.fromEntries(chain.map(k => [k, seasons[k]])) };
  Store.set(E.f(FILE), out);
  return out;
}

// ---------------------------------------------------------------------------
// What happened next
// ---------------------------------------------------------------------------
const kickoff = season => { const d = new Date(season, 8, 1), labor = 1 + ((8 - d.getDay()) % 7); return new Date(season, 8, labor + 3); };   // the Thursday after Labor Day
const week_start = season => kickoff(season).getTime() - 2 * DAY;                                                                            // fantasy weeks turn over on Tuesday
function week_of(ms, season) { const s = week_start(season); return ms < s ? 1 : Math.min(WEEKS, 1 + Math.floor((ms - s) / (7 * DAY))); }
const season_of = ms => { const d = new Date(ms); return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1; };                      // January and February belong to the season before

/* The names behind the Sleeper ids in the trades and drafts (the slim player list, then this league's own list). */
function name_map(hist) {
  const sl = (Store.get("sleeper_players.json") || {}).players || {}, lg = Store.get(E.f("league.json")) || {}, out = {};
  const put = pid => {
    if (out[pid]) return;
    const p = sl[pid], q = (lg.players || {})[pid];
    out[pid] = p ? { name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || `Player #${pid}`, pos: p.position || "?", team: p.team || "FA" }
      : q && !/^\d+$/.test(q.name || "") ? { name: q.name, pos: q.pos || "?", team: q.team || "FA" } : { name: "Unknown player", pos: "?", team: "" };
  };
  for (const s of Object.values(hist.seasons)) {
    for (const t of s.trades) for (const side of Object.values(t.sides)) for (const k of ["got", "gave"]) for (const pid of side[k].players) put(pid);
    for (const d of Object.values(s.drafted || {})) for (const p of Object.values(d)) put(p.pid);
  }
  return out;
}
/* Every draft in the chain, by the draft's season: {season: {"round|original roster": pick}}. */
function draft_index(hist) {
  const idx = {};
  for (const s of Object.values(hist.seasons)) for (const [y, d] of Object.entries(s.drafted || {})) Object.assign(idx[y] = idx[y] || {}, d);
  return idx;
}
/* The app's daily value snapshots for this league and its previous seasons (the ones kept on this phone). */
function snapshots(hist) {
  const seen = new Map();
  for (const name of [E.f("history.json")].concat(hist.chain.map(lid => `L.${lid}.history.json`))) {
    const h = Store.get(name);
    for (const s of (h && h.snapshots) || []) if (!seen.has(s.date)) seen.set(s.date, s);
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}
function snapshot_at(snaps, ms) {
  if (!snaps.length || !ms) return null;
  let best = null, gap = SNAP_DAYS + 1;
  for (const s of snaps) { const g = Math.abs(new Date(s.date + "T12:00:00").getTime() - ms) / DAY; if (g < gap) { gap = g; best = s; } }
  return best;
}
/* Stats tables for the seasons the trades span: weekly for each trade's season (from the trade week on), season totals
   for the full seasons after it, weekly for this season. Downloads what isn't cached; a season that fails is left out. */
async function stat_tables(years, season) {
  const wk = {}, reg = {}, ys = [...new Set(years.concat(season))].filter(y => y <= season && y >= 1999);
  await Promise.all(ys.map(async y => { try { wk[y] = await E.nflv_stats(y, true, y === season ? 12 : 24 * 365); } catch (e) { wk[y] = null; } }));
  const mid = new Set();
  for (const y of ys) for (let z = y + 1; z < season; z++) mid.add(z);
  await Promise.all([...mid].map(async z => { try { reg[z] = await E.nflv_stats(z, false, 24 * 365); } catch (e) { reg[z] = null; } }));
  return { wk, reg };
}
/* Points a player has scored since week `from` of season y0, in this league's PPR: the rest of that season, every
   full season after it, and this season so far. Redraft leagues stop at the end of the trade's season. */
function points_since(T, key, y0, from, season, ppr, redraft) {
  let pts = 0, g = 0;
  const add = (std, pp) => { pts += std + ppr * (pp - std); g++; };
  const w0 = T.wk[y0] && T.wk[y0][key];
  if (w0 && w0[3]) for (const [w, v] of Object.entries(w0[3])) if (+w >= from) add(v[0], v[1]);
  if (!redraft) {
    for (let z = y0 + 1; z < season; z++) { const r = T.reg[z] && T.reg[z][key]; if (r) { pts += r[1] + ppr * (r[2] - r[1]); g += r[0]; } }
    if (y0 < season) { const c = T.wk[season] && T.wk[season][key]; if (c && c[3]) for (const v of Object.values(c[3])) add(v[0], v[1]); }
  }
  return { pts: Math.round(pts * 10) / 10, g, known: !!T.wk[y0] };
}
/* The asset behind a Sleeper id: today's value list, else the same name and position on it, else a plain unranked player. */
function player_asset(values, pid, nm) {
  const a = values.by_sleeper[String(pid)];
  if (a) return a;
  const n = nm[pid] || {}, key = E.player_key(n.name || "", n.pos || "?");
  return values.players.find(p => E.player_key(p.name, p.pos) === key)
    || E.make_player("sl" + pid, n.name || `Player #${pid}`, n.pos || "?", n.team || "FA", null, 0, 0, null, null, null, String(pid), true);
}
const pick_slot = (round, slot) => (slot ? `${round}.${String(slot).padStart(2, "0")}` : null);
/* One side's pieces as they stand today. part = {players: [pid], picks: [{season, round, original}], faab}. */
function pieces(values, cfg, idx, nm, part, y0, week, season, ppr, redraft, T, snap) {
  const out = [], thenOf = (id, now, raw) => {           // the snapshots hold raw market values: scale "then" the way today's value is scaled
    if (!snap || snap.values[id] === undefined) return null;
    const k = raw > 0 && now > 0 ? now / raw : 1;
    return Math.round(snap.values[id] * k);
  };
  for (const pid of part.players) {
    const a = player_asset(values, pid, nm), P = points_since(T, E.player_key(a.name, a.pos), y0, week, season, ppr, redraft);
    out.push({ kind: "player", asset: a, name: a.name, value: a.value, then: thenOf(a.id, a.value, a.base_value || a.value), pts: P.pts, g: P.g, pts_known: P.known });
  }
  for (const pk of part.picks) {
    const d = pk.original !== null && pk.original !== undefined ? (idx[pk.season] || {})[`${pk.round}|${pk.original}`] || null : null;
    const label = `${pk.season} ${E.ordinal(pk.round)}`, gen = E.resolve_pick(values, cfg, pk.season, pk.round, null);
    if (d) {                                                   // the pick has been used: it is that player now
      const a = player_asset(values, d.pid, nm), P = points_since(T, E.player_key(a.name, a.pos), y0, week, season, ppr, redraft);
      out.push({ kind: "pick", label, pick: pk, slot: pick_slot(pk.round, d.slot), became: a, asset: a, name: a.name, value: a.value, then: thenOf(gen.id, 1, 1), pts: P.pts, g: P.g, pts_known: P.known });
    } else {
      let pp = null;
      try { pp = pk.season >= season && pk.original !== null && pk.original !== undefined ? E.projected_pick(values, cfg, pk.season, pk.round, pk.original) : null; } catch (e) { pp = null; }
      const value = pp ? Math.round(pp.value) : gen.value;
      out.push({ kind: "pick", label, pick: pk, asset: gen, name: label, value, then: thenOf(gen.id, value, gen.value), pts: 0, g: 0, pts_known: true, proj: pp ? pp.label : null, future: true });
    }
  }
  if (part.faab) out.push({ kind: "faab", name: `$${part.faab} FAAB`, faab: part.faab, value: 0, then: null, pts: 0, g: 0, pts_known: true });
  return out;
}
function summarize(ps) {
  const s = { now: 0, then: 0, then_n: 0, pts: 0, g: 0, pts_known: true, n: ps.length };
  for (const p of ps) {
    s.now += p.value || 0;
    if (p.then !== null && p.kind !== "faab") { s.then += p.then; s.then_n++; }
    s.pts += p.pts || 0; s.g += p.g || 0;
    if (!p.pts_known) s.pts_known = false;
  }
  s.pts = Math.round(s.pts * 10) / 10;
  s.then_full = s.then_n > 0 && s.then_n === ps.filter(p => p.kind !== "faab").length;
  return s;
}
/* The points of a side's best n players (a pick that became a player counts as him). */
const players_of = s => s.got.filter(p => p.kind === "player" || (p.kind === "pick" && p.became));
const best_pts = (s, n) => Math.round(players_of(s).map(p => p.pts || 0).sort((x, y) => y - x).slice(0, n).reduce((x, y) => x + y, 0) * 10) / 10;
/* Who is ahead, today: by what the pieces are worth now (dynasty) or by the points they scored (redraft). A redraft
   trade with more players on one side is judged on each side's best n, n being the smaller side's count: the extra
   bodies are depth, not a reason to call it a win. pct is on the trade screen's scale (the difference over the bigger
   side) with its thresholds. */
function verdict(cfg, sides, redraft, over) {
  const T = cfg.adjustments.verdict_pct;
  let n = null;
  if (redraft && sides.length === 2) {
    const counts = sides.map(s => players_of(s).length);
    if (counts[0] !== counts[1] && Math.min(...counts) > 0) { n = Math.min(...counts); for (const s of sides) { s.sum.best_n = n; s.sum.best = best_pts(s, n); } }
  }
  const score = s => (redraft ? (n ? s.sum.best : s.sum.pts) : s.sum.now);
  const ranked = sides.slice().sort((a, b) => score(b) - score(a)), top = ranked[0], next = ranked[1];
  if (!next) return { tone: "fair", winner: null, pct: 0, over, best_n: n };
  const a = score(top), b = score(next);
  if (redraft && ((!top.sum.pts_known && !next.sum.pts_known) || (a === 0 && b === 0))) return { tone: "none", winner: null, pct: 0, over, best_n: n };
  const pct = (a - b) / Math.max(a, b, 1) * 100;
  const tone = pct < T.even ? "fair" : pct < T.slight ? "edge" : pct < T.lopsided ? "win" : "big";
  return { tone, winner: tone === "fair" ? null : top.rid, pct, over, best_n: n };
}
/* The roster that is "you" in each season of the chain: the same Sleeper user, else the same roster number this season. */
function my_rosters(cfg, hist) {
  const out = {}, me = cfg.my_roster_id, cur = hist.seasons[hist.chain[0]];
  if (me === null || me === undefined || !cur) return out;
  const owner = (cur.teams[me] || {}).owner_id;
  for (const lid of hist.chain) {
    const s = hist.seasons[lid], hit = owner ? Object.keys(s.teams).find(rid => s.teams[rid].owner_id === owner) : null;
    out[lid] = hit !== undefined && hit !== null ? +hit : (lid === hist.chain[0] ? +me : null);
  }
  return out;
}
/* A saved check from the trade screen (E.read_log) as a pseudo-trade: two sides, dated when it was saved. */
function saved_sides(values, cfg, t) {
  const side = (ids, names) => {
    const part = { players: [], picks: [], faab: 0 }, loose = [];
    (ids && ids.length ? ids : []).forEach((id, i) => {
      const m = /^pick-(\d{4})-(\d{1,2})(?:-\w+)?(?:@(\d+))?$/.exec(String(id));
      if (m) { part.picks.push({ season: +m[1], round: +m[2], original: m[3] ? +m[3] : null }); return; }
      let a = null;
      const f = E.find_asset(id, values, cfg);
      if (!f.error) a = f.asset;
      else if (names && names[i]) { const g = E.find_asset(names[i], values, cfg); if (!g.error) a = g.asset; }
      if (a && a.is_pick) part.picks.push({ season: a.pick.season, round: a.pick.round, original: null });
      else if (a && a.sleeper_id) part.players.push(String(a.sleeper_id));
      else loose.push(a || { id: String(id), name: names && names[i] ? names[i] : String(id), pos: "?", value: 0, is_pick: false });
    });
    return { part, loose };
  };
  return [side(t.a_ids, t.a_gives), side(t.b_ids, t.b_gives)];
}

/* Every trade with what happened next. Returns {trades, saved}: Sleeper's trades (newest first) and the saved checks. */
async function outcomes(cfg, values, hist) {
  const season = parseInt(cfg.season, 10), redraft = E.is_redraft(cfg), ppr = parseFloat(cfg.league.ppr || 0);
  const nm = name_map(hist), idx = draft_index(hist), snaps = snapshots(hist), mine = my_rosters(cfg, hist), log = E.read_log();
  const years = [];
  for (const s of Object.values(hist.seasons)) if (s.trades.length) years.push(s.season);
  for (const t of log) { const ms = Date.parse(String(t.date || "").replace(" ", "T")); if (ms) years.push(season_of(ms)); }
  const T = await stat_tables(years, season);
  const trades = [];
  for (const lid of hist.chain) {
    const s = hist.seasons[lid];
    for (const t of s.trades) {
      const ms = t.created || null, snap = snapshot_at(snaps, ms), over = redraft && s.season < season;
      const sides = Object.entries(t.sides).map(([rid, sd]) => {
        const got = pieces(values, cfg, idx, nm, sd.got, s.season, t.week, season, ppr, redraft, T, snap);
        const gave = pieces(values, cfg, idx, nm, sd.gave, s.season, t.week, season, ppr, redraft, T, snap);
        return { rid: +rid, name: (s.teams[rid] || {}).name || `Roster ${rid}`, mine: mine[lid] === +rid, got, gave, sum: summarize(got), sum_gave: summarize(gave) };
      }).sort((a, b) => (b.mine - a.mine) || (a.rid - b.rid));
      trades.push({ kind: "sleeper", id: t.id, lid, season: s.season, league: s.name, week: t.week, created: ms, offseason: ms ? ms < week_start(s.season) : false,
        sides, verdict: verdict(cfg, sides, redraft, over), snap: snap ? snap.date : null, over });
    }
  }
  trades.sort((a, b) => (b.created || 0) - (a.created || 0));
  const saved = [];
  log.forEach((t, i) => {
    const ms = Date.parse(String(t.date || "").replace(" ", "T")) || Date.now(), y0 = season_of(ms), snap = snapshot_at(snaps, ms), over = redraft && y0 < season;
    const [A, B] = saved_sides(values, cfg, t);
    const mk = (S, name, k) => {
      const got = pieces(values, cfg, idx, nm, S.part, y0, week_of(ms, y0), season, ppr, redraft, T, snap)
        .concat(S.loose.map(a => ({ kind: "player", asset: a, name: a.name, value: a.value || 0, then: null, pts: 0, g: 0, pts_known: false })));
      return { rid: k, name, mine: k === "A", got, gave: [], sum: summarize(got) };
    };
    const sides = [mk(B, t.team_a || "You", "A"), mk(A, t.team_b || "They", "B")];   // side A gets what side B gives
    saved.push({ kind: "saved", id: `saved-${i}`, index: i, season: y0, week: week_of(ms, y0), created: ms, offseason: ms < week_start(y0), sides,
      verdict: verdict(cfg, sides, redraft, over), then_verdict: t.verdict || "", then_pct: t.pct, note: t.note || "", snap: snap ? snap.date : null, over });
  });
  return { trades, saved, fetched: hist.fetched, seasons: hist.chain.map(lid => hist.seasons[lid].season) };
}

return { cached, ensure, outcomes, draft_of, week_of, season_of, FILE };
})();
