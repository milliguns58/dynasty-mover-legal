/* The rookie draft helper (draft.js): the class board adjusted to this league's format, your picks in the draft, who
   is gone, who is likely to be there when you pick, and what to take. It works from the prospects file (tools/draft)
   for Sleeper leagues and for leagues built by hand; a Sleeper draft in progress is followed live from the API. */
"use strict";

const Draft = (() => {
const FILE = "draft.json";                  // per league: {season, taken: {prospectId: {by, mine, pick, src, name}}}
const POS = ["QB", "RB", "WR", "TE"];
const VET = E.AGE_DECLINE;                     // starters whose slide has begun (the user's age cliffs, two years before each)

/* What this league's format does to a prospect's grade: superflex lifts QBs, a 1-QB league drops them (a rookie QB
   rarely starts for you there), TE premium lifts TEs a little. */
function format_mult(cfg) {
  const sf = parseInt(cfg.league.num_qbs, 10) >= 2, tep = parseFloat(cfg.league.te_premium_bonus_pct || 0);
  return { QB: sf ? 1.1 : 0.8, RB: 1, WR: 1, TE: 1 + Math.min(25, tep) / 200 };
}
/* The board: every prospect with a score for this league, best first. adp is the class rank (a neutral board, which
   is how most managers pick); rank is his place on this league's board. */
function board(d, cfg) {
  const m = format_mult(cfg);
  const rows = (d.players || []).map(p => ({ p, score: Math.round(p.grade * (m[p.pos] || 1) * 10) / 10, adp: p.rank }));
  rows.sort((a, b) => (b.score - a.score) || (a.adp - b.adp));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
function load(season) {
  const c = Store.get(E.f(FILE));
  return c && c.season === season && c.taken ? c : { season, taken: {} };
}
function save(st) { Store.set(E.f(FILE), st); }

/* Where a team is thin: the starting slots at each position (a flex counts in part) against the players it has who
   are startable in this league (worth at least about what the league's last starter at the position is worth), with
   half a need added for each starter near the end of his prime. */
function needs(values, cfg, team) {
  const lg = values.league, starters = (lg && lg.roster_positions_starters) || cfg.league.starters, N = parseInt(cfg.league.teams, 10) || 12;
  const slots = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const s of starters || []) {
    if (slots[s] !== undefined) slots[s] += 1;
    else if (/SUPER|^SF$/.test(s)) { slots.QB += 0.5; slots.RB += 0.2; slots.WR += 0.2; slots.TE += 0.1; }
    else if (/FLEX|WRRB|REC/.test(s)) { slots.RB += 0.4; slots.WR += 0.45; slots.TE += 0.15; }
  }
  const mine = team ? E.team_assets(values, cfg, team).filter(a => !a.is_pick) : [];
  const out = [];
  for (const pos of POS) {
    const pool = values.players.filter(a => a.pos === pos && !a.unranked).sort((x, y) => y.value - x.value);
    const k = Math.max(1, Math.round(N * slots[pos])), floor = (pool[k - 1] || pool[pool.length - 1] || { value: 0 }).value;
    const have = mine.filter(a => a.pos === pos && a.value >= floor * 0.85);
    const vets = have.filter(a => a.age !== null && a.age !== undefined && a.age >= E.decline_of(a)).length;   // his own slide: a running QB starts sooner
    const need = Math.max(0, slots[pos] - have.length) + vets * 0.5;
    out.push({ pos, slots: Math.round(slots[pos] * 10) / 10, have: have.length, vets, need: Math.round(need * 10) / 10 });
  }
  return out.sort((a, b) => b.need - a.need);
}
/* The team's picks in this draft, as the trade screen labels and values them. */
function my_picks(values, cfg, team, season) {
  if (!team) return [];
  return E.team_assets(values, cfg, team).filter(a => a.is_pick && a.pick && a.pick.season === season);
}
/* What to take next: the best available on this league's board, lifted where a need is real, each with its reason. */
function recommend(rows, st, needsList, n = 5) {
  const need = Object.fromEntries(needsList.map(x => [x.pos, x.need]));
  const avail = rows.filter(r => !st.taken[r.p.id]);
  const scored = avail.map(r => ({ r, pick: r.score * (1 + 0.12 * Math.min(2, need[r.p.pos] || 0)) })).sort((a, b) => b.pick - a.pick);
  const best = avail[0] || null;
  return scored.slice(0, n).map(({ r }) => {
    const why = [];
    if (r === best) why.push("Best on the board");
    else if (best && r.rank <= best.rank + 2) why.push("Top of the board");
    if ((need[r.p.pos] || 0) >= 1) why.push(`Fills a need at ${r.p.pos}`);
    else if ((need[r.p.pos] || 0) >= 0.5) why.push(`Help at ${r.p.pos}`);
    if (r.adp - r.rank >= 3) why.push(`Neutral boards have him ${E.ordinal(r.adp)}, ours ${E.ordinal(r.rank)}`);
    if (r.p.tier) why.push(r.p.tier);
    return { r, why: why.join(" · ") };
  });
}
/* Who is likely gone before a pick that is `before` picks away, and who is likely still there: by the neutral board. */
function likely(rows, st, before, n = 8) {
  const avail = rows.filter(r => !st.taken[r.p.id]).slice().sort((a, b) => a.adp - b.adp), k = Math.max(0, before || 0);
  return { gone: avail.slice(0, k), there: avail.slice(k).sort((a, b) => a.rank - b.rank).slice(0, Math.max(n, 24)) };   // enough for a few at each position
}
/* A Sleeper pick's name and position (its metadata) matched to a prospect. */
function match(d, name, pos) {
  const k = E.norm(name), ps = d.players || [];
  return ps.find(p => E.norm(p.name) === k && (!pos || p.pos === pos)) || ps.find(p => E.norm(p.name) === k) || null;
}
/* The picks of a draft in order: slot s of round r is pick (r-1)*N+s in a linear draft; a snake turns every round. */
function pick_order(N, rounds, type) {
  const out = [];
  for (let r = 1; r <= rounds; r++) for (let i = 1; i <= N; i++) { const slot = type === "snake" && r % 2 === 0 ? N + 1 - i : i; out.push({ no: (r - 1) * N + i, round: r, slot }); }
  return out;
}
/* A Sleeper league's draft for the class: who has taken whom so far (marked in st), whose turn it is, and how many
   picks away the team's next one is. */
async function sleeper_sync(cfg, league, d, st, me) {
  const lid = String(league.league_id), season = st.season;
  const drafts = (await Net.json(`${E.SLEEPER_URL}/league/${lid}/drafts`).catch(() => null)) || [];
  const dr = drafts.find(x => String(x.season) === String(season)) || null;
  if (!dr) return { found: false };
  const rosters = league.teams, N = rosters.length || parseInt(cfg.league.teams, 10) || 12;
  let slotToRoster = dr.slot_to_roster_id || null;
  if (!slotToRoster && dr.draft_order) {
    slotToRoster = {};
    for (const [uid, slot] of Object.entries(dr.draft_order)) { const t = rosters.find(x => x.owner_id === uid); if (t) slotToRoster[slot] = t.roster_id; }
  }
  const rounds = parseInt((dr.settings || {}).rounds, 10) || league.draft_rounds || 4, type = dr.type === "snake" ? "snake" : "linear";
  const [picks, traded] = await Promise.all([
    Net.json(`${E.SLEEPER_URL}/draft/${dr.draft_id}/picks`).catch(() => null).then(x => x || []),
    Net.json(`${E.SLEEPER_URL}/draft/${dr.draft_id}/traded_picks`).catch(() => null).then(x => x || [])]);
  const owner = (round, slot) => {                      // who holds the pick in that slot and round (traded picks move)
    const orig = slotToRoster ? slotToRoster[slot] : null;
    if (orig === null || orig === undefined) return null;
    const t = traded.find(x => parseInt(x.round, 10) === round && parseInt(x.roster_id, 10) === parseInt(orig, 10));
    return t ? parseInt(t.owner_id, 10) : parseInt(orig, 10);
  };
  for (const k of Object.keys(st.taken)) if (st.taken[k].src === "sleeper") delete st.taken[k];   // Sleeper's list is the truth for its picks
  for (const pk of picks) {
    const md = pk.metadata || {}, name = `${md.first_name || ""} ${md.last_name || ""}`.trim(), p = match(d, name, md.position);
    if (!p) continue;
    st.taken[p.id] = { by: pk.roster_id, mine: me !== null && me !== undefined && pk.roster_id === me, pick: `${pk.round}.${String(pk.draft_slot).padStart(2, "0")}`, src: "sleeper", name };
  }
  const order = pick_order(N, rounds, type), made = picks.length, next = order[made] || null;
  let untilMine = null, myNext = null;
  if (next && me !== null && me !== undefined) for (let i = made; i < order.length; i++) { if (owner(order[i].round, order[i].slot) === me) { untilMine = i - made; myNext = order[i]; break; } }
  return { found: true, status: dr.status, type, rounds, N, made, next, onClock: next ? owner(next.round, next.slot) : null, untilMine, myNext, draft_id: dr.draft_id, start: dr.start_time || null };
}
return { FILE, format_mult, board, load, save, needs, my_picks, recommend, likely, match, pick_order, sleeper_sync };
})();
