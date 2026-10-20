/* Phone UI: six tabs (Home, Trade, GM, Rankings, My team, League) plus a bottom sheet for pickers, the player card and the trade history.
   Kept plain on purpose: one main action per screen, short labels, and the detail folded under "More". */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const { fmt, fmt_signed } = E;

const S = {
  tab: "home", home: { kind: "adds" }, values: null, cfg: null,
  sides: { A: { team: null, mode: "neutral", items: [] }, B: { team: null, mode: "neutral", items: [] } },
  result: null, busy: false,
  team: { id: null, seg: "lineup" },
  rank: { pos: "ALL", q: "", who: "all", limit: 100, order: "ours" },
  W: null, Wkey: null, Wat: 0, Wloading: null,
  sheetStack: [],
};
/* Hosted privacy policy (Play requires a public URL). Set these before publishing; see android\store\RELEASE.md. */
const PRIVACY_URL = "https://milliguns58.github.io/dynasty-mover-legal/privacy.html";
const CONTACT_EMAIL = "dynastymover.app@gmail.com";
const MODE_LABEL = { neutral: "Balanced", contend: "Win now", rebuild: "Rebuilding" };
const SLOT_LABEL = s => ({ SUPER_FLEX: "SF", SUPERFLEX: "SF", WRRB_FLEX: "FLEX", REC_FLEX: "FLEX" }[s] || s);
const app = () => Store.get("app.json") || {};
const saveApp = patch => Store.set("app.json", Object.assign(app(), patch));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return plural(h, "hour") + " ago";
  return plural(Math.round(h / 24), "day") + " ago";
}

// ---------------------------------------------------------------------------
// Basics: toast, sheet, theme, back button
// ---------------------------------------------------------------------------
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = "none"; }, ms);
}
function openSheet(html, opts = {}) {
  const sh = $("#sheet");
  $("#sheetBody").innerHTML = html;
  S.sheetReturn = null;
  sh.classList.toggle("full", !!opts.full);
  sh.classList.remove("hidden");
  $("#scrim").classList.remove("hidden");
  $("#sheetBody").scrollTop = 0;
  S.sheetStack.push(opts.onClose || null);
  if (opts.focus) setTimeout(() => { const i = $(opts.focus, sh); if (i) i.focus(); }, 60);
  return $("#sheetBody");
}
function closeSheet() {
  $("#sheet").classList.add("hidden");
  $("#scrim").classList.add("hidden");
  const cb = S.sheetStack.pop();
  S.sheetStack = []; S.sheetReturn = null;
  if (cb) cb();
}
const sheetOpen = () => !$("#sheet").classList.contains("hidden");
$("#scrim").addEventListener("click", () => { if (!S.busy) closeSheet(); });
window.onNativeBack = () => {
  if (sheetOpen()) { if (!S.busy) closeSheet(); return true; }
  if (Pro.ON && Pro.gated()) return false;                  // sign-in or paywall screen: back leaves the app
  if (S.tab !== "home") { go("home"); return true; }
  return false;
};
/* Look: "classic" (the default) or "retro" (8-bit, css/retro.css). Theme (light/dark) applies to Classic only. */
const retro = () => (app().look || "classic") === "retro" && !locked();
/* Pro edition on the free Basic plan: Pro features show a PRO tag and open the upgrade sheet (pro.js). */
function locked() { return typeof Pro !== "undefined" && Pro.ON && Pro.locked(); }
const proTag = () => (locked() ? Pro.tag() : "");
/* Basic plan: a trade can hold up to BASIC_TRADE_MAX players and picks in all (both sides together). */
const BASIC_TRADE_MAX = 4;
const tradeCount = () => S.sides.A.items.length + S.sides.B.items.length;
const tradeFull = () => locked() && tradeCount() >= BASIC_TRADE_MAX;
function applyTheme() {
  const pref = app().theme || "system";
  document.documentElement.setAttribute("data-look", retro() ? "retro" : "classic");
  if (pref === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", pref);
  const dark = retro() || pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (Store.native && Native.setBars) Native.setBars(retro() ? "#000000" : dark ? "#16181b" : "#ffffff", !dark);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// ---------------------------------------------------------------------------
// Profile / values
// ---------------------------------------------------------------------------
function loadActive() {
  const p = E.load_profiles();
  if (!p.active || !p.profiles[p.active]) { S.cfg = null; S.values = null; return; }
  S.cfg = E.set_profile(p.active);
  S.values = E.load_values(S.cfg);
  const ui = Store.get(E.f("ui.json")) || {};
  S.team.id = S.cfg.my_roster_id ?? ui.team ?? null;
  restoreSides(ui.sides);
  S.result = null;
  S.W = null; S.Wkey = null;
}
function restoreSides(saved) {
  let dropped = 0;
  for (const k of ["A", "B"]) {
    const s = (saved || {})[k] || {};
    const planMode = k === "A" && S.cfg && S.cfg.plan ? S.cfg.plan : null;     // the manager's plan (set with the GM) is the default lens on your side
    S.sides[k] = { team: s.team ?? (k === "A" ? S.cfg && S.cfg.my_roster_id : null) ?? null, mode: s.mode || planMode || "neutral", items: [] };
    if (S.values) for (const id of s.items || []) { const a = sideAsset(k, id); if (a) S.sides[k].items.push(a); else dropped++; }
  }
  if (dropped) { S.sidesDropped = (S.sidesDropped || 0) + dropped; saveUi(); }
}
/* A saved piece of a trade, as the side's team holds it today (Sleeper's rosters and picks). When the side has a team and
   the piece is no longer on it (traded away, dropped, a pick that moved), it comes out of the trade (2026-10-07). */
function sideAsset(k, id) {
  const team = teamById(S.sides[k].team);
  if (team) return E.team_assets(S.values, S.cfg, team).find(z => z.id === id) || null;
  const m = E.find_asset(id, S.values, S.cfg);
  return m.error ? null : itemFor(m.asset, id);
}
function itemFor(a, id) {
  if (id && id.includes("@") && S.values && S.values.league) {       // an acquired pick keeps its "via" label
    for (const t of S.values.league.teams) { const x = E.team_assets(S.values, S.cfg, t).find(z => z.id === id); if (x) return x; }
  }
  return a;
}
function saveUi() {
  if (!E.P.id) return;
  Store.set(E.f("ui.json"), { team: S.team.id, sides: Object.fromEntries(["A", "B"].map(k => [k, { team: S.sides[k].team, mode: S.sides[k].mode, items: S.sides[k].items.map(a => a.id) }])) });
}
const teams = () => (S.values && S.values.league) ? S.values.league.teams : [];
const teamById = id => teams().find(t => String(t.roster_id) === String(id)) || null;
const sideName = k => { const t = teamById(S.sides[k].team); return t ? t.team_name : (k === "A" ? "You" : "They"); };
const isPronoun = n => n === "You" || n === "They";
const verb = (name, v) => isPronoun(name) ? v : v + "s";                    // "You win" / "Rootz wins"
const lower = n => isPronoun(n) ? n.toLowerCase() : n;                    // "Slight edge: you"

function formatText(cfg) {
  const lg = cfg.league, ppr = parseFloat(lg.ppr);
  const bits = [E.title(E.league_kind_label(cfg)), `${lg.teams} teams`];
  if (parseInt(lg.num_qbs) >= 2) bits.push("Superflex");
  bits.push(ppr === 0.5 ? "½ PPR" : (ppr >= 0.75 ? "PPR" : "Standard"));
  if (parseFloat(lg.te_premium_bonus_pct) > 0) bits.push("TE premium");
  return bits.join(" · ");
}
function header() {
  const p = E.load_profiles();
  $("#lgName").textContent = S.cfg ? (p.profiles[E.P.id] || {}).name || S.cfg.league.name : "Dynasty Mover";
  $("#lgSub").textContent = S.cfg ? formatText(S.cfg) : "";
  const b = $("#banner");
  const stale = S.cfg && S.values && E.stale_warning(S.values, S.cfg);
  if (stale) {
    b.innerHTML = `<span>Player values are over a week old.</span><button class="btn sm primary" id="bannerUpd">Update</button>`;
    b.classList.remove("hidden");
    $("#bannerUpd").onclick = () => runUpdate();
  } else b.classList.add("hidden");
}
$("#leagueBtn").onclick = () => { if (S.tab !== "league") leaguesSheet(); };   // on the League tab the list is already on the page, so the header is just the name there

// ---------------------------------------------------------------------------
// Shared bits of markup
// ---------------------------------------------------------------------------
/* Player picture. Personal edition: Sleeper's headshot. Play edition: initials on the team's colour, because
   player photos are licensed images and Sleeper does not offer them to other apps (see store/SOURCES.md). */
const TEAM_COLORS = { ARI: "#97233F", ATL: "#A71930", BAL: "#241773", BUF: "#00338D", CAR: "#0085CA", CHI: "#0B162A", CIN: "#FB4F14", CLE: "#311D00",
  DAL: "#003594", DEN: "#FB4F14", DET: "#0076B6", GB: "#203731", HOU: "#03202F", IND: "#002C5F", JAX: "#006778", KC: "#E31837", LV: "#1f1f1f",
  LAC: "#0080C6", LAR: "#003594", MIA: "#008E97", MIN: "#4F2683", NE: "#002244", NO: "#9f8958", NYG: "#0B2265", NYJ: "#125740", PHI: "#004C54",
  PIT: "#1f1f1f", SF: "#AA0000", SEA: "#002244", TB: "#D50A0A", TEN: "#4B92DB", WAS: "#5A1414" };
const initials = n => { const w = String(n || "?").replace(/\b(Jr|Sr|II|III|IV)\b\.?/g, "").split(/\s+/).filter(Boolean); return ((w[0] || "?")[0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase(); };
function avatar(p, cls = "") {
  if (p.is_pick) { const m = /(\d+)(st|nd|rd|th)/.exec(p.name) || ["", "", ""]; return `<span class="av pick ${cls}"><b>${esc(m[1] + m[2])}</b></span>`; }
  const sid = p.sleeper_id || p.sid || "";
  if (retro()) return `<span class="av px ${cls}"><img class="px" src="${Pixel.player(p.team, sid)}" alt=""><i class="av-pos ${esc(p.pos)}">${esc(p.pos)}</i></span>`;
  const img = !E.PLAY && /^\d+$/.test(sid) ? `<img src="https://sleepercdn.com/content/nfl/players/thumb/${sid}.jpg" loading="lazy" alt="" onerror="this.remove()">` : "";
  return `<span class="av pos-${esc(p.pos)} ${cls}" style="--tc:${TEAM_COLORS[p.team] || "#5b6270"}"><b>${esc(initials(p.name))}</b>${img}<i class="av-pos ${esc(p.pos)}">${esc(p.pos)}</i></span>`;
}
const badge = pos => `<span class="badge ${esc(pos)}">${esc(pos === "PICK" ? "PICK" : pos)}</span>`;
function sub(a) {
  if (a.is_pick) { const via = /\(via ([^)]*)\)\s*$/.exec(a.name); return (a.estimated ? "Draft pick · estimated" : "Draft pick") + (via ? ` · from ${via[1].trim()}` : ""); }   // a traded pick says whose it was, under the name where it fits
  const b = [a.team || "FA"];
  if (a.age != null) b.push(`age ${Math.floor(a.age)}`);
  return b.join(" · ");
}
/* Grades turn a value into something readable. They go by where the value ranks among all players, counted in
   "players per team" so they mean the same in any league size: in 12 teams A+ is the top 12 (about one per team),
   A the next 12, and F is past roughly 22 per team. Picks are graded by where their value would rank. */
const GRADES = [[1, "A+", "Elite"], [2, "A", "Star"], [3, "A-", "Great"], [4.5, "B+", "Very good"], [6, "B", "Good"],
  [8, "B-", "Starter"], [10, "C+", "Solid"], [13, "C", "Depth"], [16, "C-", "Bench"], [22, "D", "Long shot"], [Infinity, "F", "Waiver"]];
const GRADE_LABEL = Object.fromEntries(GRADES.map(([, g, l]) => [g, l]));
function rankedValues() {
  const v = S.values;
  if (!v) return [];
  if (!v._ranked) v._ranked = v.players.filter(p => !p.unranked).map(p => p.value).sort((x, y) => y - x);
  return v._ranked;
}
/* The grade is our dynasty view (a.ours: the research age curves and breakout bump, on the market's scale); the value and
   rank are the market's. market = true grades by the market value instead (for the buy/sell hint). */
// Our rank's order (a.orank), high to low, for the dynasty grade
function orankedValues() {
  const v = S.values;
  if (!v) return [];
  if (!v._oranked) v._oranked = v.players.filter(p => !p.unranked && p.orank != null).map(p => p.orank).sort((x, y) => y - x);
  return v._oranked;
}
function gradeOf(a, market) {
  if (isKdef(a)) { const k = kdefGrade(a); return k ? { g: k.letter, label: `${a.pos}${k.posRank} by points`, cls: k.cls } : { g: "–", label: "No points yet", cls: "gx" }; }
  if (!a || a.unranked || !(a.value > 0)) return { g: "–", label: "Not ranked", cls: "gx" };
  // dynasty (2026-10-16, the user's ask): the grade follows Our rank, A+ down to F on the per-team scale (GRADES), so
  // the letters run in the list's order. The report card (a.oscore) still guards the F: a player it grades D or better,
  // or a starting QB, gets at least a D (F is for nothing going).
  if (!market && !locked() && !E.is_redraft(S.cfg) && a.orank != null) {
    const vals = orankedValues(), x = a.orank;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] > x) lo = mid + 1; else hi = mid; }
    const perTeam = (lo + 1) / Math.max(4, parseInt((S.cfg && S.cfg.league.teams) || 12));
    let [, g, label] = GRADES.find(([cut]) => perTeam <= cut);
    const card = a.oscore != null ? E.GRADE_CUTS.find(([c]) => a.oscore >= c)[1] : null;
    if (g === "F" && ((card && card !== "F") || startingQbFloor(a))) { g = "D"; label = GRADE_LABEL.D; }
    return { g, label, cls: "g" + g[0].toLowerCase() };
  }
  if (!market && !locked() && a.oscore != null) {                       // Pro: our report-card grade (engine.js grade_scores)
    const g = E.GRADE_CUTS.find(([c]) => a.oscore >= c)[1];
    const M = gradeOf(a, true);
    // a thin sample (under 8 games, or a TE in his first 2 seasons) is no reason to grade a young player under the market (RBs from 25 excepted: their sell window)
    if (!E.is_redraft(S.cfg) && gIdx(g) > gIdx(M.g) && a.age != null && a.age < 26 && !(a.pos === "RB" && a.age >= 25) && a.opatient !== false) return M;
    return { g, label: GRADE_LABEL[g] || "", cls: "g" + g[0].toLowerCase() };
  }
  const vals = rankedValues(), x = a.value;
  let lo = 0, hi = vals.length;                          // rank = 1 + players worth more (binary search, values sorted high to low)
  while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] > x) lo = mid + 1; else hi = mid; }
  const perTeam = (lo + 1) / Math.max(4, parseInt((S.cfg && S.cfg.league.teams) || 12));
  const [, g, label] = GRADES.find(([cut]) => perTeam <= cut);
  if (g === "F" && startingQbFloor(a)) return { g: "D", label: "Starting QB", cls: "gd" };
  return { g, label, cls: "g" + g[0].toLowerCase() };
}
/* A QB who starts for his NFL team (1st on Sleeper's depth chart) and scores at least as much per game as the average
   starting QB, within 5% (the top 32 QBs by points, from nflverse stats: this season once he has 2 games, else last season) is
   worth at least a D, however low his dynasty value (older starters like Cousins or Flacco). */
let qbPace = null;
function qbPpgTable() {
  if (qbPace && qbPace.at > Date.now() - 600000) return qbPace;
  const season = parseInt((S.cfg && S.cfg.season) || new Date().getFullYear(), 10), ppr = parseFloat((S.cfg && S.cfg.league.ppr) || 0);
  const read = (name) => (Store.get(name) || {}).players || {};
  const table = (rows, minG) => {
    const q = Object.entries(rows).filter(([k, o]) => k.endsWith("|QB") && o[0] >= minG).map(([k, o]) => [k, (o[1] + ppr * (o[2] - o[1])) / o[0], o[1] + ppr * (o[2] - o[1])]);
    const top = q.slice().sort((x, y) => y[2] - x[2]).slice(0, 32), avg = top.length ? top.reduce((s, x) => s + x[1], 0) / top.length : null;
    return { avg, ppg: Object.fromEntries(q.map(([k, p]) => [k, p])) };
  };
  qbPace = { at: Date.now(), now: table(read(`nflv_wk_${season}.json`), 2), last: table(read(`nflv_reg_${season - 1}.json`), 6) };
  return qbPace;
}
function startingQbFloor(a) {
  if (a.pos !== "QB") return false;
  const st = E.load_player_status()[String(a.sleeper_id || "")] || {};
  if (st.depth !== 1 || (st.inj && Week.INJURY_OUT.has(st.inj))) return false;
  const T = qbPpgTable(), k = E.player_key(a.name, "QB");
  if (T.now.avg != null && T.now.ppg[k] != null) return T.now.ppg[k] >= 0.95 * T.now.avg;        // within 5% counts as average
  if (T.last.avg != null && T.last.ppg[k] != null) return T.last.ppg[k] >= 0.95 * T.last.avg;
  return false;
}
/* Direction over the last 30 days: this phone's price history when it has it, else FantasyCalc's 30-day trend.
   Moves under 3% of the value count as steady. */
function moveOf(a) {
  let amt = null;
  const ch = E.price_changes(E.price_series(a.id));
  if (ch["30d"]) amt = ch["30d"][0];
  else if (a.trend) amt = a.trend;
  if (amt === null || !a.value) return { dir: "flat", amt: 0 };
  const pct = amt / a.value;
  return { dir: pct >= 0.03 ? "up" : (pct <= -0.03 ? "down" : "flat"), amt };
}
const ARROW = { up: "▲", down: "▼", flat: "–" };
const logTabs = yr => `<div class="seg log-yr">${[parseInt(S.cfg.season, 10), "career"].map(y =>          // this season, then the career table (the user's ask, 2026-10-14)
  `<button data-logyr="${y}" class="${String(y) === String(yr) ? "on" : ""}">${y === "career" ? "Career" : y}</button>`).join("")}</div>`;
/* The player card's career table: one row a season, newest first, filled in as seasons arrive (st from E.career_stats). */
function careerHtml(st, a) {
  const season = parseInt(S.cfg.season, 10), tabs = logTabs("career");
  const rows = st.rows.slice().sort((x, y) => y.year - x.year);
  const i = v => String(Math.round(v || 0));
  const cols = a.pos === "QB" ? [["YDS", g => i(g.pyd)], ["TD", g => i(g.ptd)], ["INT", g => i(g.int)], ["RUSH", g => i(g.ryd)], ["RTD", g => i(g.rtd)]]
    : a.pos === "RB" ? [["CAR", g => i(g.car)], ["YDS", g => i(g.ryd)], ["TD", g => i(g.rtd + g.rectd)], ["REC", g => i(g.rec)], ["REC YDS", g => i(g.recyd)]]
    : [["REC", g => i(g.rec)], ["TGT", g => i(g.tgt)], ["YDS", g => i(g.recyd)], ["TD", g => i(g.rectd + g.rtd)]];
  const full = rows.filter(r => r.g >= 8), best = full.length ? full.reduce((b, r) => (r.pts / r.g > b.pts / b.g ? r : b)) : null;
  const body = rows.map(r => `<tr><td>${r.year}${r.year === season ? "*" : ""}</td><td>${esc(r.team || "")}</td><td>${r.g}</td>${cols.map(([, f]) => `<td>${f(r)}</td>`).join("")}
      <td class="pts ${r === best ? "hi" : ""}">${r.pts.toFixed(1)}</td><td class="${r === best ? "hi" : ""}">${r.g ? (r.pts / r.g).toFixed(1) : "–"}</td></tr>`).join("");
  const G = rows.reduce((s, r) => s + r.g, 0), P = rows.reduce((s, r) => s + r.pts, 0);
  let foot = "";
  if (st.loading) foot = `<p class="note muted" style="margin-top:6px">Loading ${st.loading}…</p>`;
  else if (st.error) foot = `<p class="note muted" style="margin-top:6px">Couldn't load every season. Check your connection and open the card again.</p>`;
  else if (st.done) foot = `<p class="note muted" style="margin-top:6px">${rows.length} season${rows.length === 1 ? "" : "s"} · ${G} games · ${P.toFixed(0)} points · ${G ? (P / G).toFixed(1) : "–"} a game in your league's scoring${best ? " · best season in green" : ""}${rows.some(r => r.year === season) ? " · *this season so far" : ""}</p>`;
  const table = rows.length ? `<div class="glog"><table><thead><tr><th>YEAR</th><th>TEAM</th><th>G</th>${cols.map(([h]) => `<th>${h}</th>`).join("")}<th>PTS</th><th>PPG</th></tr></thead><tbody>${body}</tbody></table></div>`
    : (st.done && !st.error ? `<p class="note muted">No NFL seasons on record.</p>` : "");
  return tabs + table + foot + (rows.length ? `<p class="credit" style="text-align:left;padding-top:2px">Stats from nflverse</p>` : "");
}
/* The player card's game log table. r: { rows, last } from E.game_log, null while loading, or { error }. */
function gameLogHtml(r, a, yr) {
  const season = parseInt(S.cfg.season, 10);
  const tabs = logTabs(yr);
  if (!r) return tabs + `<p class="note muted">Loading…</p>`;
  if (r.error) return tabs + `<p class="note muted">Couldn't load the ${yr} stats. Check your connection.</p>`;
  if (!r.rows.length) return tabs + `<p class="note muted">${yr === season ? "No games yet this season." : `No games in ${yr}.`}</p>`;
  const i = v => (v ? String(Math.round(v)) : "0");
  const cols = a.pos === "QB" ? [["C/ATT", g => `${i(g.cmp)}/${i(g.att)}`], ["YDS", g => i(g.pyd)], ["TD", g => i(g.ptd)], ["INT", g => i(g.int)], ["RUSH", g => i(g.ryd)]]
    : a.pos === "RB" ? [["CAR", g => i(g.car)], ["YDS", g => i(g.ryd)], ["TD", g => i(g.rtd + g.rectd)], ["REC", g => i(g.rec)], ["REC YDS", g => i(g.recyd)]]
    : [["REC/TGT", g => `${i(g.rec)}/${i(g.tgt)}`], ["YDS", g => i(g.recyd)], ["TD", g => i(g.rectd + g.rtd)]];
  const games = r.rows.filter(x => x.game), avg = games.reduce((s, x) => s + x.game.pts, 0) / games.length;
  const cls = p => (p >= avg * 1.3 ? "hi" : p <= avg * 0.6 ? "lo" : "");
  const body = r.rows.map(x => x.game
    ? `<tr><td>${x.week}</td><td>${esc(x.game.opp)}</td>${cols.map(([, f]) => `<td>${f(x.game)}</td>`).join("")}<td class="pts ${cls(x.game.pts)}">${x.game.pts.toFixed(1)}</td></tr>`
    : `<tr class="nog"><td>${x.week}</td><td colspan="${cols.length + 2}">No game</td></tr>`).join("");
  return tabs + `<div class="glog"><table><thead><tr><th>WK</th><th>OPP</th>${cols.map(([h]) => `<th>${h}</th>`).join("")}<th>PTS</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="note muted" style="margin-top:6px">${games.length} game${games.length === 1 ? "" : "s"} · ${avg.toFixed(1)} points a game in your league's scoring</p>
    <p class="credit" style="text-align:left;padding-top:2px">Points by week from Sleeper; stats from nflverse</p>`;
}
/* Why our grade differs from the market, in his own numbers (the grade's parts and his status), not a canned line. */
function gradeWhy(a, up) {
  const [p, r, o, h, s] = a.oparts || [], st = E.load_player_status()[String(a.sleeper_id || "")] || {};
  const rd = E.is_redraft(S.cfg), pos = a.pos, age = a.age != null ? a.age : 27, out = Week.INJURY_OUT.has(st.inj);
  const R = [], gap = epGap(a);
  if (up && gap >= 1.5) R.push("his usage says more points are coming");
  if (!up && gap <= -1.5) R.push("he's scoring more than his usage says, and that fades");
  if (up) {
    if (p >= 60) R.push("he's producing like a starter"); else if (o >= 60) R.push("he's getting a starter's share of the ball");
    if (!rd && r >= 75) R.push(age <= 25.5 ? "his prime is still ahead of him" : pos === "QB" ? "quarterbacks hold their value into their late 30s" : "his age curve still has good years in it");
    if (s != null && s >= 65) R.push("his situation is built for a tight end");
    if (!R.length) R.push(!rd && age <= 26 && p < 35 ? "he's young enough to still be a lottery ticket" : rd ? "his points say more than his price does" : "his numbers say more than his price does");
  } else {
    const stage = E.age_stage(pos, age);                                             // the user's cliffs: RB 29, WR 31, QB 40, TE 37, the slide two years before
    if (!rd && r < 45 && stage) R.push(stage === "cliff" ? `he's past the ${pos} cliff (${E.AGE_CLIFF[pos]})` : stage === "near" ? "his age curve says the cliff is close" : "his age curve is past its peak");
    if (o < 30) R.push(st.depth > 3 ? `he's buried on the depth chart (${pos}${st.depth})` : "he isn't getting the ball");
    else if (p < 35) R.push(age >= 25 || a.ogames >= 20 ? (o >= 60 ? "his points don't match the ball he's getting" : "his points are down") : "he hasn't produced yet");
    else if (p < 60) R.push("his production doesn't match his price");
    if (h < 50) R.push(out ? (st.inj === "IR" ? "he's on IR" : "he's out") : "he's missed games");
    if (s != null && s < 40) R.push("his situation isn't built for a tight end");
    if (!R.length) R.push("his price is ahead of his numbers");
  }
  const parts = R.slice(0, 3), text = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}
function gradeParts(a) {
  if (!a.oparts) return "";
  const [p, r, o, h, s] = a.oparts, bar = (l, v) => (v == null ? "" : `<div class="gp"><span>${l}</span><i><b style="width:${v}%"></b></i></div>`);
  return `<div class="gparts">${bar("Production", p)}${bar("Runway", r)}${bar("Role", o)}${bar("Health", h)}${bar("Situation", s)}</div>`;
}
/* Expected points (Pro): what his usage was worth against what he scored this season (ffopportunity, CC BY-SA 4.0).
   A gap of 1.5 a game or more usually closes, so it is a buy-low or sell-high sign. */
function epGap(a) { const e = a && a.ep; return e && e.g >= 3 && !a.is_pick ? (e.exp - e.pts) / e.g : 0; }
function epLine(a) {
  const e = a.ep, gap = epGap(a);
  if (!e || Math.abs(gap) < 1.5 || locked()) return "";
  const up = gap > 0, elite = !up && ["A+", "A"].includes(gradeOf(a).g);       // the best beat their usage year after year: no sell call on them
  // the usage check informs; it gives no second verdict (the grade already counts it, and a card arguing with itself
  // was the user's complaint, 2026-10-14)
  const head = up ? "Due for more" : elite ? "Hot, as the best usually are" : "Running hot";
  const call = up ? "The points usually catch up with the usage; that is counted in our grade." : elite ? "Expect a touch less, not a collapse." : "Some of that comes back down; that is counted in our grade.";
  return `<div class="edge ${up ? "buy" : elite ? "lean" : "sell"} ep"><b>${head}</b> His usage was worth ${(e.exp / e.g).toFixed(1)} a game${e.tdx != null ? ` and ${e.tdx.toFixed(1)} touchdowns` : ""}; he scored ${(e.pts / e.g).toFixed(1)}${e.td != null ? ` with ${Math.round(e.td)}` : ""}. ${call} <span class="muted">Expected points, ${e.g} games.</span></div>`;
}
/* Where our grade and the market disagree: the edge. 2+ grade steps = buy or sell; 1 step = we lean that way. */
function edgeLine(a, G) {
  if (a.is_pick || !(a.ours > 0)) return "";
  if (locked()) return `<button class="edge lockd" data-lock="ourgrade"><b>Our grade</b> See how we grade him against the market ${Pro.tag()}</button>`;
  const M = gradeOf(a, true), d = gIdx(M.g) - gIdx(G.g);
  if (!d) return gradeParts(a);
  const up = d > 0, strong = Math.abs(d) >= 2;
  return `${gradeParts(a)}<div class="edge ${up ? "buy" : "sell"}"><b>${strong ? (up ? "Buy" : "Sell") : (up ? "We like him" : "We're cooler on him")}</b>
    Our grade ${esc(G.g)}, the market ${esc(M.g)}. ${esc(gradeWhy(a, up))}</div>`;
}
function gradeChip(a, withArrow = true) {
  const G = gradeOf(a), M = withArrow ? moveOf(a) : null;
  return `<span class="grade ${G.cls}">${esc(G.g)}</span>${M ? `<span class="mv ${M.dir}" title="${M.dir === "up" ? "rising" : (M.dir === "down" ? "falling" : "steady")}">${ARROW[M.dir]}</span>` : ""}`;
}
/* The right side of a player row: labelled cells, "Week" (this week's matchup grade), in dynasty "Season" (this season
   only, 2026-10-16) and then "Dynasty" (the big grade, with the value under it; "Season" in redraft), a thin divider
   after the week so they read as different things. */
// o.wk / o.val: a number under the week grade / in place of the value (the Rankings tab's Points and Projected orders)
const gradeRight = (a, o = {}) => { const sc = seasonCell(a); if (isKdef(a) && o.val == null) { const k = kdefGrade(a); o = Object.assign({}, o, { val: k ? `${k.ppg.toFixed(1)}/g` : "–" }); } return `<div class="gcells${sc ? " g3" : ""}">${weekCell(a, o.wk)}${sc}<div class="gcell"><small>${a.is_pick ? "Pick" : E.is_redraft(S.cfg) ? "Season" : "Dynasty"}</small><div class="gv">${gradeChip(a, !sc)}</div><div class="d muted${o.val != null ? " rk-num" : ""}">${o.val != null ? o.val : fmt(a.value)}</div></div></div>`; };
/* A status flag by the name, from Sleeper's injury status: IR, PUP, OUT (this week), DOUB (doubtful), SUS, Q. */
function statusFlag(a) {
  if (!a || a.is_pick || !a.sleeper_id) return "";
  const inj = (E.load_player_status()[String(a.sleeper_id)] || {}).inj;
  const f = inj === "IR" ? "IR" : inj === "PUP" ? "PUP" : inj === "Out" ? "OUT" : inj === "Doubtful" ? "DOUB" : (inj === "Sus" || inj === "Suspended") ? "SUS" : inj === "Questionable" ? "Q" : "";
  return f ? `<span class="flag ${f}" title="${esc(inj)}">${f}</span>` : "";
}
// kickers and defenses (2026-10-19): graded on their points a game at the position, one a team (no dynasty value)
const isKdef = a => !!a && !a.is_pick && (a.pos === "K" || a.pos === "DEF");
const kdefGrade = a => (S.W ? Week.kdef_season_grades(S.values, S.cfg, S.W)[String(a.sleeper_id || "")] : null) || null;
/* The card's matchup lines (2026-10-20): what this week's opponent gives up to his position, his offense's pace and
   pass rate, and a short week or extra rest. From nflverse stats and the schedule (Week.team_context). */
const nth = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
function matchupLines(a, w) {
  const c = w && w.ctx; if (!c) return "";
  const rows = [];
  if (c.def && w.opp) { const r = c.def; rows.push(`${esc(String(w.opp).replace(/^@/, ""))} give up ${r.ppg.toFixed(1)} pts a game to ${esc(a.pos)}s: ${r.rank <= r.of / 2 ? `${nth(r.rank)} most` : `${nth(r.of + 1 - r.rank)} fewest`}`); }
  if (c.off) rows.push(`${esc(a.team)} offense: ${c.off.plays.toFixed(0)} plays a game (${nth(c.off.playsRank)} most), passes ${Math.round(100 * c.off.pass)}% (${nth(c.off.passRank)})`);
  if (c.rest && c.rest.days != null && (c.rest.days <= 5 || c.rest.days >= 10)) rows.push(c.rest.days <= 5 ? `Short week: ${c.rest.days} days of rest` : `Extra rest: ${c.rest.days} days`);
  return rows.length ? `<div class="mu">${rows.map(r => `<div class="mu-l">${r}</div>`).join("")}</div>` : "";
}
function seasonCell(a) {
  if (a.is_pick || !a.sleeper_id || !S.values || E.is_redraft(S.cfg)) return "";
  const g = isKdef(a) ? kdefGrade(a) : Week.season_grades(S.values, S.cfg)[a.sleeper_id];
  return `<div class="gcell snc" title="${g ? `This season: ${esc(a.pos)}${g.posRank}` : "No projection this season"}"><small>Season</small><span class="grade sm ${g ? g.cls : "gx"}">${g ? esc(g.letter) : "–"}</span></div>`;
}
function weekCell(a, note) {
  if (a.is_pick || !S.W || S.W.valuesOnly || !a.sleeper_id) return "";
  const w = Week.week_grades(S.values, S.cfg, S.W)[a.sleeper_id];
  return `<div class="gcell wkc" title="${w ? `This week: ${esc(w.label)}, ${esc(a.pos)}${w.posRank}` : "No game this week"}"><small>Week</small><span class="grade sm ${w ? w.cls : "gx"}">${w ? esc(w.letter) : "–"}</span>${note != null ? `<div class="d muted rk-num">${note}</div>` : ""}</div>`;
}
/* This week's grade, small and labelled, next to the outlook grade: the matchup-adjusted projection ranked at his
   position (A+ must start, F sit). Shows once the week's data is loaded; no game this week shows a dash. */
function weekChip(a) {
  if (a.is_pick || !S.W || S.W.valuesOnly || !a.sleeper_id) return "";
  const w = Week.week_grades(S.values, S.cfg, S.W)[a.sleeper_id];
  return `<span class="wk" title="${w ? `This week: ${esc(w.label)}, ${esc(a.pos)}${w.posRank}` : "No game this week"}"><i>wk</i><span class="grade sm ${w ? w.cls : "gx"}">${w ? esc(w.letter) : "–"}</span></span>`;
}
/* Rows show two grades, so the week's data loads for any tab that lists players; the tab redraws once it's here. */
function ensureWeek(tab) {
  if (S.W || !S.cfg || !S.values || S.Wloading) return;
  weekData().then(() => { if (S.tab === tab) go(tab); }).catch(() => {});
}
function assetRow(a, opts = {}) {
  const right = opts.right ?? gradeRight(a);
  return `<div class="item" data-id="${esc(a.id)}" data-act="${opts.act || "card"}">
    ${opts.rank !== undefined ? `<span class="rk${opts.rank <= 3 ? " medal m" + opts.rank : ""}">${opts.rank}</span>` : ""}${avatar(a)}
    <div class="nm"><div class="n"><span class="nt">${opts.nameLink && !a.is_pick ? `<a class="plink" data-pcard="${esc(a.id)}">${esc(a.name)}</a>` : esc(a.is_pick ? a.name.replace(/\s*\(via [^)]*\)\s*$/, "") : a.name)}</span>${opts.flag ? `<span class="flag ${esc(opts.flag)}">${esc(opts.flag)}</span>` : statusFlag(a)}${opts.tag || ""}</div><div class="s">${opts.sub ?? sub(a)}</div>${opts.extra || ""}</div>
    <div class="v">${right}</div>${opts.x ? `<button class="x" data-x="${esc(a.id)}" aria-label="Remove">×</button>` : ""}</div>`;
}
/* Every screen that shows values credits its sources, with a link to FantasyCalc.com (its terms require it). */
function credits(extra = "") {
  // the lists "Our rank" starts from (values.json anchor) are credited too
  const used = [...new Set([].concat((S.values && S.values.meta.sources_used) || [], (S.values && S.values.meta.anchor) || []))];
  const fc = used.includes("fantasycalc"), dmv = used.includes("dmv") || !used.length;
  const names = used.filter(n => n !== "fantasycalc" && n !== "dmv").map(n => (E.SOURCES[n] || {}).label || n);
  const parts = (fc ? [`<a data-link="https://fantasycalc.com">FantasyCalc.com</a>`] : []).concat(dmv ? ["Dynasty Mover"] : []).concat(names.map(esc));
  const ep = dmv && S.values && S.values.players.some(a => a.ep);
  const stats = dmv ? ` Stats from <a data-link="https://github.com/nflverse/nflverse-data">nflverse</a> (CC BY 4.0).${ep ? ` Expected points from <a data-link="https://github.com/ffverse/ffopportunity">ffopportunity</a> (CC BY-SA 4.0).` : ""}` : "";
  return `<p class="credit">Values from ${parts.join(", ")}.${stats}${extra ? " " + esc(extra) + "." : ""}</p>`;
}
/* Player links: any name marked data-pcard opens that player's card, wherever it appears (even inside a row that does
   something else when tapped). The key can be a value-list id, a Sleeper id or a name; players on no value list get a
   plain card from Sleeper's player list. */
const plinkSeen = new Map();
function plink(a, label) {
  if (!a || a.is_pick) return esc(label ?? (a ? a.name : ""));
  plinkSeen.set(a.id, a);
  return `<a class="plink" data-pcard="${esc(a.id)}">${esc(label ?? a.name)}</a>`;
}
const plinkName = name => `<a class="plink" data-pcard="${esc(name)}">${esc(name)}</a>`;
/* Escape text and link the named players in it (longest names first, so "Mike Williams" beats "Mike"). */
function linkify(text, assets) {
  // Longest names first; each name is swapped for a placeholder so a shorter name can't match inside a link already made,
  // and a player listed twice (both sides, both rosters) is linked once.
  let h = esc(text); const links = [], seen = new Set();
  for (const a of (assets || []).filter(x => x && !x.is_pick && x.name).sort((x, y) => y.name.length - x.name.length)) {
    const n = esc(a.name);
    if (seen.has(n) || !h.includes(n)) continue;
    seen.add(n); plinkSeen.set(a.id, a);
    h = h.split(n).join(`\u0001${links.length}\u0001`); links.push(`<a class="plink" data-pcard="${esc(a.id)}">${n}</a>`);
  }
  return h.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]);
}
function resolvePlayer(key) {
  if (!key || !S.values) return null;
  if (plinkSeen.has(key)) return plinkSeen.get(key);
  const v = S.values;
  if (v.by_id[key]) return v.by_id[key];
  if (v.by_sleeper && v.by_sleeper[key]) return v.by_sleeper[key];
  const named = v.players.find(p => p.name === key);
  if (named) return named;
  const sl = (Store.get("sleeper_players.json") || {}).players || {};
  const sid = /^\d+$/.test(key) ? key : (/^sl\d+$/.test(key) ? key.slice(2) : Object.keys(sl).find(k => sl[k].full_name === key));
  const p = sid && sl[sid];
  if (!p) return null;
  return { id: "sl" + sid, name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), pos: p.position, team: p.team || "FA",
    age: p.age ?? null, value: 0, redraft: 0, unranked: true, sleeper_id: sid, is_pick: false, sources: {} };
}
document.addEventListener("click", e => {
  const pl = e.target.closest("[data-pcard]");
  if (!pl) return;
  e.preventDefault(); e.stopPropagation();
  const a = resolvePlayer(pl.dataset.pcard), back = sheetOpen() ? S.sheetReturn : null;   // a picker's "bring me back" hook
  if (a) card(a, back ? { onClose: back } : {}); else toast("No card for this player yet");
}, true);
document.addEventListener("click", e => { const l = e.target.closest("[data-lock]"); if (l) { e.preventDefault(); e.stopPropagation(); Pro.lock(l.dataset.lock); } }, true);
document.addEventListener("click", e => { const k = e.target.closest("[data-kit]"); if (k) { e.preventDefault(); e.stopPropagation(); Pro.kitSheet(parseInt(k.dataset.kit, 10)); } }, true);
/* The season's draft kit (Pro edition, a one-time purchase): the whole class and the draft helper. The first round of
   the class stays open as a taste. Everywhere else, and in the personal build, everything is open. */
const kitLocked = year => typeof Pro !== "undefined" && Pro.ON && Pro.kitLocked(year);
const KIT_TASTE = 12;
document.addEventListener("click", e => { const a = e.target.closest("[data-link]"); if (a) { e.preventDefault(); e.stopPropagation(); Net.open(a.dataset.link); } }, true);
const more = (label, inner, open = false) => `<details class="more"${open ? " open" : ""}><summary>${esc(label)}</summary><div class="more-body">${inner}</div></details>`;
function emptyState(title, text, btn, id) {
  return `<div class="hero"><div class="hero-icon"><svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <h2>${esc(title)}</h2><p>${esc(text)}</p>${btn ? `<button class="btn primary big" id="${id}">${esc(btn)}</button>` : ""}</div>`;
}
function needLeague(el) {
  el.innerHTML = emptyState("Welcome", "Add your league to value trades, set lineups and find pickups.", "Add a league", "goLeague");
  $("#goLeague").onclick = () => go("league");
}
function needValues(el) {
  el.innerHTML = emptyState("One more step", "Download today's player values. It takes about 15 seconds.", "Download values", "goUpd");
  $("#goUpd").onclick = () => runUpdate();
}

// ---------------------------------------------------------------------------
// Home: who everyone is adding (or dropping) on Sleeper right now
// ---------------------------------------------------------------------------
/* Home's news wire (2026-10-20): status changes for players on this league's rosters over the last week, yours first,
   worded by us from Sleeper's player list and the NFL's reports (E.load_wire). */
function wireCard() {
  if (!S.values || !teams().length) return "";
  const owner = {}, me = S.cfg ? S.cfg.my_roster_id : null;
  for (const t of teams()) for (const pid of t.players) owner[pid] = t;
  const week = Date.now() - 7 * 86400000, seen = new Set();
  const ev = E.load_wire().filter(e => owner[e.sid] && new Date(e.t).getTime() >= week && !seen.has(e.sid + e.kind) && seen.add(e.sid + e.kind));
  if (!ev.length) return "";
  ev.sort((x, y) => ((owner[y.sid].roster_id === me) - (owner[x.sid].roster_id === me)) || (new Date(y.t) - new Date(x.t)));
  return `<section class="card"><h2>League wire</h2><div class="hint">What changed for players on this league's rosters this week</div><div class="list">${ev.slice(0, 10).map(e => {
    const t = owner[e.sid], mineTag = t.roster_id === me ? ` <span class="tag-start">Yours</span>` : `<span class="muted"> · ${esc(t.team_name)}</span>`;
    return `<div class="wire-row"><div class="n"><a class="plink" data-pcard="${esc(e.sid)}">${esc(e.name)}</a> <span class="muted">${esc(e.pos)} · ${esc(e.team)}</span>${mineTag}</div><div class="s">${esc(e.text)} · ${esc(ago(e.t))}</div></div>`;
  }).join("")}</div><p class="credit" style="text-align:left;padding:6px 0 0">From Sleeper's player list and the NFL's reports via nflverse.</p></section>`;
}
function renderHome(el) {
  const H = S.home, adds = H.kind === "adds";
  el.innerHTML = `<section class="hero-home ${adds ? "" : "drops"}">
      <div class="hh-top"><div><div class="hh-kicker">Trending now</div><h1>${adds ? "Most added" : "Most dropped"}</h1>
        <div class="hh-sub">Across all Sleeper leagues, last 2 days</div></div>
        <div class="hh-flame">${adds ? "🔥" : "🧊"}</div></div>
      <div class="hh-toggle"><button data-k="adds" class="${adds ? "on" : ""}">Adds</button><button data-k="drops" class="${adds ? "" : "on"}">Drops</button></div>
      <div class="podium" id="podium">${[1, 2, 3].map(() => `<div class="pod skel"></div>`).join("")}</div>
    </section>
    ${S.cfg ? "" : `<section class="card cta"><div><b>Add your league</b><div class="hint">See who's still available and value trades.</div></div><button class="btn primary sm" id="homeAdd">Add</button></section>`}
    ${typeof GM !== "undefined" ? GM.homeCard() : ""}
    <section class="card flush"><div class="list" id="trend">${loading("Loading trending players…")}</div></section>
    ${wireCard()}
    <p class="credit">Trending data from <a data-link="https://sleeper.com">Sleeper</a>.${S.values ? " " + credits().replace(/^<p class="credit">|<\/p>$/g, "") : ""}</p>`;
  $$(".hh-toggle button", el).forEach(b => b.onclick = () => { H.kind = b.dataset.k; renderHome(el); });
  if (typeof GM !== "undefined") GM.bindHome(el);
  ensureWeek("home");
  const ha = $("#homeAdd");
  if (ha) ha.onclick = () => go("league");
  const owner = {};
  for (const t of teams()) for (const pid of t.players) owner[pid] = t;
  const me = S.cfg ? S.cfg.my_roster_id : null;
  const tag = r => {
    if (!teams().length) return "";
    const t = owner[r.sid];
    if (t && t.roster_id === me) return `<span class="tag-start">Yours</span>`;
    return t ? "" : `<span class="tag-free">Available</span>`;
  };
  const who = r => r.asset || { name: r.name, pos: r.pos, team: r.team, sleeper_id: r.sid };
  E.trending_list(H.kind, 30, S.values, S.cfg ? E.hide_positions(S.cfg, S.values && S.values.league) : true).then(({ rows }) => {
    if (!el.isConnected || S.tab !== "home") return;
    if (!rows.length) { $("#trend").innerHTML = `<div class="empty">No trending data right now.</div>`; $("#podium").innerHTML = ""; return; }
    const top = rows[0].count || 1, sign = adds ? "+" : "−";
    $("#podium").innerHTML = rows.slice(0, 3).map((r, i) => `<button class="pod p${i + 1}" data-sid="${esc(r.sid)}" style="animation-delay:${i * 80}ms">
        <span class="pod-rank">${i + 1}</span>${avatar(who(r), "lg")}<span class="pod-name">${esc(r.name)}</span>
        <span class="pod-count">${sign}${E.compact(r.count)}</span></button>`).join("");
    $("#trend").innerHTML = rows.slice(3).map((r, i) => `<div class="item trend-row" data-sid="${esc(r.sid)}" style="animation-delay:${Math.min(i, 12) * 35}ms">
        <span class="rk">${i + 4}</span>${avatar(who(r))}
        <div class="nm"><div class="n"><span class="nt">${esc(r.name)}</span>${statusFlag(r.asset || { sleeper_id: r.sid })}${tag(r)}</div><div class="s">${r.asset ? [`<span class="grade sm ${gradeOf(r.asset).cls}">${esc(gradeOf(r.asset).g)}</span>`, weekChip(r.asset), `${esc(r.pos)} · ${esc(r.team)}`].filter(Boolean).join(" · ") : `${esc(r.pos)} · ${esc(r.team)}`}</div>
          <div class="tbar ${adds ? "" : "down"}"><i style="width:${Math.max(3, r.count / top * 100).toFixed(1)}%"></i></div></div>
        <div class="v"><b class="${adds ? "good" : "bad"}">${sign}${E.compact(r.count)}</b></div></div>`).join("");
    const open = sid => { const r = rows.find(x => x.sid === sid); if (r && r.asset) card(r.asset); else if (r) toast(`${r.name} has no trade value yet`); };
    $$("[data-sid]", el).forEach(n => n.onclick = () => open(n.dataset.sid));
  }, () => { if (el.isConnected) { $("#trend").innerHTML = `<div class="empty">Couldn't load trending players. Check your connection.</div>`; $("#podium").innerHTML = ""; } });
}

// ---------------------------------------------------------------------------
// Trade tab
// ---------------------------------------------------------------------------
/* The trade screen: "You give", then the verdict bar, then "You get". The bar updates as soon as both sides have
   something (there is no "check" button). Each side is a compact card: team and strategy as pills, then the players,
   then a slim "Add" row. The bar's card also holds the swap and start-over buttons. */
function renderTrade(el) {
  if (S.sidesDropped) { const n = S.sidesDropped; S.sidesDropped = 0; toast(n === 1 ? "One piece left the trade: it's no longer on that roster (per Sleeper)." : `${n} pieces left the trade: they're no longer on those rosters (per Sleeper).`, 3600); }
  if (!S.cfg) return needLeague(el);
  if (!S.values) return needValues(el);
  const redraft = E.is_redraft(S.cfg);
  if (S.sides.A.team != null && String(S.sides.A.team) === String(S.sides.B.team)) S.sides.B.team = null;   // a team can't trade with itself
  if (locked()) { S.sides.A.mode = "neutral"; S.sides.B.mode = "neutral"; }
  const modeSel = (k, s) => locked()
    ? `<button class="pill lock-btn" data-lock="modes" aria-label="Strategy (Pro)">${MODE_LABEL.neutral} ${Pro.tag()}</button>`
    : `<select class="pill" data-mode="${k}" aria-label="Strategy">${E.MODES.map(m => `<option value="${m}" ${s.mode === m ? "selected" : ""}>${MODE_LABEL[m]}</option>`).join("")}</select>`;
  const lens = !redraft && !locked() && S.sides.A.mode !== "neutral" ? S.sides.A.mode : null;   // your strategy prices both sides
  const priced = a => E.adjusted_value(a, lens || "neutral", S.cfg);
  const lensRight = a => { const v = priced(a), d = v - a.value;
    return `<div class="gv">${gradeChip(a)}</div><div class="d ${d > 0 ? "good" : d < 0 ? "bad" : "muted"}">${fmt(v)}${Math.abs(d) >= 1 ? ` <s class="was">${fmt(a.value)}</s>` : ""}</div>`; };
  const qbBump = parseFloat(S.cfg.league.qb_trade_bump_pct ?? 15), hasQB = k => S.sides[k].items.some(a => a.pos === "QB" && E.qb_trade_mult(a, S.cfg) > 1);
  const side = k => {
    const s = S.sides[k], tot = s.items.reduce((x, a) => x + priced(a), 0);
    const other = S.sides[k === "A" ? "B" : "A"].team;
    const opts = [`<option value="">${k === "A" ? "Any team" : "Pick a team"}</option>`].concat(teams().filter(t => String(t.roster_id) !== String(other)).map(t =>
      `<option value="${t.roster_id}" ${String(s.team) === String(t.roster_id) ? "selected" : ""}>${esc(t.team_name)}${t.roster_id === S.cfg.my_roster_id ? " (you)" : ""}</option>`)).join("");
    const pills = (teams().length ? `<select class="pill" data-team="${k}" aria-label="Team">${opts}</select>` : "") + (redraft ? "" : modeSel(k, s));
    return `<section class="card tside">
      <div class="tside-head"><span class="tside-title">${k === "A" ? "You give" : "You get"}</span>${s.items.length ? `<span class="tside-tot">${fmt(tot)}</span>` : ""}</div>
      ${pills ? `<div class="tside-pills">${pills}</div>` : ""}
      ${lens && s.items.length ? `<div class="lens-note">${k === "A" ? (lens === "contend" ? "Valued to win now: production up, picks and youth down." : "Valued for a rebuild: picks and youth up, older players down.")
        : `Priced through your ${MODE_LABEL[lens].toLowerCase()} lens${s.mode !== "neutral" ? `; ${MODE_LABEL[s.mode]} is how they see it` : ""}.`}</div>` : ""}
      ${!redraft && qbBump > 0 && hasQB(k) ? `<div class="lens-note">Starting QBs cost +${qbBump}% in trades: you overpay for a QB.</div>` : ""}
      ${!redraft && k === "A" && s.items.length && S.cfg.league.use_market !== false && Hist.market_cached() && Hist.market_cached().mults ? `<div class="lens-note">${esc(marketText())}</div>` : ""}
      <div class="list">${s.items.map(a => assetRow(a, { x: true, trend: false, right: lensRight(a) })).join("")}</div>
      <button class="add-row" data-add="${k}" ${tradeFull() ? 'data-lock="tradesize"' : ""}><span class="plus">+</span>${s.items.length ? "Add another" : (redraft ? "Add a player" : "Add a player or pick")}${tradeFull() ? " " + Pro.tag() : ""}</button></section>`;
  };
  const cap = locked() ? `<p class="foot trade-cap">Basic plan: ${tradeCount()} of ${BASIC_TRADE_MAX} players and picks. <a class="lnk" data-lock="tradesize">Go Pro for bigger trades</a></p>` : "";
  const ideas = tradeIdeas(priced);
  el.innerHTML = side("A") + (ideas.side === "A" ? ideas.html : "") + `<section class="card tmid" id="tscore"></section>` + side("B") + (ideas.side === "B" ? ideas.html : "") + cap + `<div id="result"></div><div id="tlog"></div>${credits()}`;
  $$("[data-idea]", el).forEach(it => it.onclick = e => {
    if (e.target.closest(".plink")) return;                  // the name opens the card; the row adds him
    const m = E.find_asset(it.dataset.idea, S.values, S.cfg);
    if (m.error) return;
    if (tradeFull()) { Pro.lock("tradesize"); return; }
    S.sides[it.dataset.side].items.push(itemFor(m.asset, it.dataset.idea));
    S.lastAdd = { side: it.dataset.side, id: it.dataset.idea };
    S.result = null; saveUi(); renderTrade(el); toast(`Added ${m.asset.name}`, 1400);
  });
  const redo = () => { S.result = null; saveUi(); renderTrade(el); };
  $$("[data-team]", el).forEach(sel => sel.onchange = () => { S.sides[sel.dataset.team].team = sel.value || null; redo(); });
  $$("[data-mode]", el).forEach(sel => sel.onchange = () => { S.sides[sel.dataset.mode].mode = sel.value; redo(); });
  $$("[data-add]", el).forEach(b => b.onclick = () => picker(b.dataset.add));
  $$("[data-x]", el).forEach(b => b.onclick = e => { e.stopPropagation(); for (const k of ["A", "B"]) S.sides[k].items = S.sides[k].items.filter(a => a.id !== b.dataset.x); if (S.lastAdd && S.lastAdd.id === b.dataset.x) S.lastAdd = null; redo(); });
  bindCards(el);
  if (S.sides.A.items.length && S.sides.B.items.length && S.result) analyze(false);   // checked already: keep showing it
  else scoreboard(null);
  renderLog();
}

/* Trade ideas: after a player or pick goes on one side, the assets of the same caliber (within about 20% of his value,
   through the same strategy lens) he could be traded for. Added to You give: what you could ask for, from the other
   team's roster if one is picked, else from every other team in the league (or the whole list without a league).
   Added to You get: what you could give, from your own roster. Tap a row to add it to the other side. */
function tradeIdeas(priced) {
  const L = S.lastAdd;
  if (!L || S.result) return { side: null, html: "" };
  const k = L.side, other = k === "A" ? "B" : "A", anchor = S.sides[k].items.find(a => a.id === L.id);
  if (!anchor) return { side: null, html: "" };
  const target = priced(anchor);
  if (!(target > 0)) return { side: null, html: "" };
  const inTrade = new Set(S.sides.A.items.concat(S.sides.B.items).map(a => a.id));
  const otherTeam = teamById(S.sides[other].team), mine = S.cfg.my_roster_id != null ? teamById(S.cfg.my_roster_id) : null;
  const owner = {};
  if (teams().length) for (const t of teams()) for (const pid of t.players) owner[pid] = t;
  let pool, from;
  if (otherTeam) { pool = E.team_assets(S.values, S.cfg, otherTeam); from = `on ${otherTeam.team_name}'s roster`; }
  else if (k === "A" && teams().length) { pool = S.values.players.filter(a => owner[a.sleeper_id] && (!mine || owner[a.sleeper_id].roster_id !== mine.roster_id)); from = "on other teams"; }
  else if (k === "B" && mine) { pool = E.team_assets(S.values, S.cfg, mine); from = "on your roster"; }
  else { pool = S.values.players; from = "in the rankings"; }
  const ok = a => !inTrade.has(a.id) && (a.is_pick || suggestable(a)) && priced(a) > 0;
  const band = otherTeam || k === "B" ? 0.3 : 0.2;             // one roster is a small pool: look a little wider
  const cands = pool.filter(ok).map(a => ({ a, v: priced(a), d: Math.abs(priced(a) - target) / target })).filter(x => x.d <= band).sort((x, y) => x.d - y.d);
  const seen = {}, picked = [];
  for (const c of cands) {                                    // a mix: at most two per position
    const p = c.a.is_pick ? "PICK" : c.a.pos;
    if ((seen[p] || 0) >= 2) continue;
    seen[p] = (seen[p] || 0) + 1; picked.push(c);
    if (picked.length >= 6) break;
  }
  if (!picked.length) return { side: k, html: "" };
  const title = k === "A" ? "Same caliber: what you could ask for" : "Same caliber: what you could give";
  const rows = picked.map(c => { const o = !c.a.is_pick && owner[c.a.sleeper_id];
    return `<div class="item idea" data-idea="${esc(c.a.id)}" data-side="${other}"><span class="plus">+</span>${avatar(c.a)}
      <div class="nm"><div class="n">${c.a.is_pick ? esc(c.a.name) : `<a class="plink" data-pcard="${esc(c.a.id)}">${esc(c.a.name)}</a>`}</div>
      <div class="s">${esc(sub(c.a))}${o && !otherTeam ? ` · ${esc(o.team_name)}` : ""}</div></div>
      <div class="v"><div class="gv">${gradeChip(c.a, false)}</div><div class="d muted">${fmt(c.v)}</div></div></div>`; }).join("");
  return { side: k, html: `<section class="card ideas"><h2>${title}</h2><div class="hint">Within about ${Math.round(band * 100)}% of ${esc(anchor.name)}'s value, ${from}. Tap a row to add it${k === "A" ? " to what you get" : " to what you give"}; tap a name for his card.</div>
    <div class="list">${rows}</div></section>` };
}

/* The verdict bar between the two sides. Each team's half carries its name and is coloured by how that team does:
   green = wins or fair, yellow = slight edge to the other side, orange = the other side wins, red = the other side
   wins big. The width of each half is its share of the value. */
const TONE_COLOR = { edge: "yellow", win: "orange", big: "red" };
function scoreboard(r, v, m, animate) {
  const sb = $("#tscore");
  if (!sb) return;
  const A = sideName("A"), B = sideName("B"), any = S.sides.A.items.length || S.sides.B.items.length;
  const swap = `<button class="tm-btn" id="swapSides" aria-label="Swap the two sides"><svg viewBox="0 0 24 24"><path d="M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const clear = any ? `<button class="tm-btn text" id="clr">Start over</button>` : "";
  const ready = S.sides.A.items.length && S.sides.B.items.length;
  const check = ready ? `<button class="btn primary block tm-go" id="tmGo">${r ? "Check again" : "Check this trade"}</button>` : "";
  if (!r) {
    sb.className = "card tmid empty-state";
    const hint = !any ? "Add a player to each side to see who wins." : !S.sides.A.items.length ? "Now add what you give."
      : !S.sides.B.items.length ? "Now add what you get." : "Ready. Tap Check this trade.";
    sb.innerHTML = `<div class="tm-top"><div class="tm-title muted">${hint}</div>${swap}${clear}</div>
      <div class="tm-bar"><span class="tm-seg c-none" style="flex-basis:50%"></span><span class="tm-seg b c-none" style="flex-basis:50%"></span></div>${check}`;
  } else {
    const aWins = v.you !== undefined ? v.you : (r.verdict && r.verdict.winner === "A");
    const loser = TONE_COLOR[v.tone] || "green";                      // "fair" leaves both halves green
    const cA = v.tone === "fair" || aWins ? "green" : loser, cB = v.tone === "fair" || !aWins ? "green" : loser;
    const share = x => Math.max(28, Math.min(72, x)).toFixed(1);       // keep both names readable
    sb.className = `card tmid tone-${cA}`;
    sb.innerHTML = `<div class="tm-top"><div class="tm-title c-${cA}-text">${esc(v.title)}</div>${swap}${clear}</div>
      <div class="tm-bar" role="img" aria-label="${esc(A)} ${fmt(m.aGets)}, ${esc(B)} ${fmt(m.bGets)}">
        <span class="tm-seg c-${cA}" data-w="${share(+m.aPct)}" style="flex-basis:${animate ? 0 : share(+m.aPct)}%">${fmt(m.aGets)}</span><span class="tm-seg b c-${cB}" data-w="${share(+m.bPct)}" style="flex-basis:${animate ? 0 : share(+m.bPct)}%">${fmt(m.bGets)}</span></div>${check}`;
    if (animate) {                                             // fill the bar from empty
      sb.classList.add("filling");
      void sb.offsetWidth;                                     // lay out the empty bar first, so the change below animates
      setTimeout(() => { $$(".tm-seg", sb).forEach(x => { x.style.flexBasis = x.dataset.w + "%"; }); setTimeout(() => sb.classList.remove("filling"), 850); }, 30);
    }
  }
  const go = $("#tmGo", sb);
  if (go) go.onclick = () => analyze(false, true);
  $("#swapSides", sb).onclick = () => { [S.sides.A, S.sides.B] = [S.sides.B, S.sides.A]; if (S.lastAdd) S.lastAdd.side = S.lastAdd.side === "A" ? "B" : "A"; S.result = null; saveUi(); renderTrade($("#view")); };
  const c = $("#clr", sb);
  if (c) c.onclick = () => { S.sides.A.items = []; S.sides.B.items = []; S.lastAdd = null; S.result = null; saveUi(); renderTrade($("#view")); };
}

function analyze(scroll, animate) {
  const mk = a => ({ asset: a, alts: [], error: null, query: a.name });
  const r = E.analyze_trade(S.sides.A.items.map(mk), S.sides.B.items.map(mk), S.sides.A.mode, S.sides.B.mode, S.cfg, S.values,
    teamById(S.sides.A.team), teamById(S.sides.B.team));
  S.result = r;
  showResult(r, animate);
  if (scroll) $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* The verdict in plain words: who comes out ahead and by roughly how much. */
/* A trade with a piece the lists don't value yet gets no verdict: no advice beats bad advice (the user's rule, 2026-10-13). */
function thinPieces() {
  return ["A", "B"].flatMap(k => S.sides[k].items.filter(a => a && !a.is_pick && !isKdef(a) && (a.unranked || !(a.value > 0))).map(a => a.name))   // a kicker or defense counts as no value, not as unknown
    .concat(["A", "B"].flatMap(k => S.sides[k].items.filter(a => a && a.is_pick && a.estimated).map(a => a.name.replace(/\s*\(via [^)]*\)\s*$/, ""))));
}
function plainVerdict(r) {
  const V = r.view || r.market, T = S.cfg.adjustments.verdict_pct, pct = V.pct, a = Math.abs(pct);
  const A = sideName("A"), B = sideName("B");
  const thin = thinPieces();
  if (thin.length) return { tone: "fair", thin: true, title: "Not enough to judge", line: `${thin.slice(0, 3).join(", ")} ${thin.length === 1 ? "has" : "have"} no value in the lists yet, so this app gives no verdict on this trade rather than a guess.` };
  if (r.redraft && r.lineup) {
    const w = r.verdict.winner;
    return { tone: w ? "edge" : "fair", title: r.verdict.text.replace("Team A", A).replace("Team B", B), line: "Judged on each team's starting lineup this season." };
  }
  const lensTxt = V.lens ? (V.lens === "contend" ? " Valued to win now." : " Valued for a rebuild.") : "";
  if (a < T.even) return { tone: "fair", title: "Fair trade", line: "Both sides get about the same value." + lensTxt };
  const you = pct > 0, winner = you ? A : B;
  const obj = winner === "They" ? "them" : lower(winner);                  // "Slight edge: them" / "You win" / "Rootz wins big"
  const title = a < T.slight ? `Slight edge: ${obj}` : (a < T.lopsided ? `${winner} ${verb(winner, "win")}` : `${winner} ${verb(winner, "win")} big`);
  const m = /^about a (\d{4}) (\d+\w\w)/.exec(r.gap_pick || "");
  const pick = m ? ` That's about the value of a ${m[1]} ${m[2]}-round pick.` : "";
  return { tone: a < T.slight ? "edge" : (a < T.lopsided ? "win" : "big"), you, title, line: `${winner} ${verb(winner, "get")} ${fmt(Math.abs(V.diff))} more in value.${pick}${lensTxt}` };
}

function showResult(r, animate) {
  const box = $("#result");
  if (!box) return;
  const A = sideName("A"), B = sideName("B"), v = plainVerdict(r);
  // The bar uses the same adjusted totals as the verdict: the side taking back more players gives up roster spots,
  // and the side getting the best player gets a small bonus. Raw totals alone could point the other way.
  const spots = r.a_spots * r.spot_cost, bonus = r.consolidation ? r.consolidation.bonus : 0;
  const V = r.view || r.market;
  const TR = r.te_risk || { A: 0, B: 0 };                    // trading for a TE is risky: the receiving side counts him lower
  const aGets = Math.max(0, V.b_gives + Math.max(0, spots) + (r.consolidation && r.consolidation.side === "A" ? bonus : 0) - TR.A);
  const bGets = Math.max(0, V.a_gives + Math.max(0, -spots) + (r.consolidation && r.consolidation.side === "B" ? bonus : 0) - TR.B);
  const tot = Math.max(1, aGets + bGets), adjusted = spots !== 0 || bonus > 0 || !!r.te_risk;
  scoreboard(r, v, { aGets, bGets, aPct: (aGets / tot * 100).toFixed(1), bPct: (bGets / tot * 100).toFixed(1) }, animate);
  const TBm = r.teams.B.mode, bn = r.teams.B.net;
  const theirs = !r.redraft && TBm !== "neutral" ? `<div class="meter-note theirs">${esc(B)} (${MODE_LABEL[TBm].toLowerCase()}) ${verb(B, "see")} it as ${bn >= 0 ? "getting" : "giving up"} ${fmt(Math.abs(bn))} more${bn < 0 ? ": expect a no unless you add something" : ""}.</div>` : "";
  let h = `<section class="card ts-why"><div class="verdict-line">${esc(v.line)}</div>${theirs}
    ${adjusted ? `<div class="meter-note">The bar counts roster spots, who gets the best player${r.te_risk ? " and the risk in trading for a tight end" : ""}.</div>` : ""}</section>`;

  if (r.balance && r.balance.length && locked()) {
    h += `<section class="card"><h2>Make it fair ${Pro.tag()}</h2><div class="hint">See which player or pick would even this trade out.</div>
      <button class="btn soft block" data-lock="fair" style="margin-top:12px">Show me with Pro</button></section>`;
  } else if (r.balance && r.balance.length && !thinPieces().length) {
    const who = r.balance[0].side === "A" ? A : B;
    h += `<section class="card"><h2>Make it fair</h2><div class="hint">${esc(who)} ${verb(who, "add")} one of these to even it out. Tap to add.</div>
      <div class="list">${r.balance.map(b => `<div class="item" data-bal="${esc(b.id)}" data-side="${b.side}"><span class="plus">+</span><div class="nm"><div class="n">${b.id && !String(b.id).startsWith("pick") ? `<a class="plink" data-pcard="${esc(b.id)}">${esc(b.name)}</a>` : esc(b.name)}</div>
        ${b.even ? "" : `<div class="s">gets closer</div>`}</div><div class="v"><b>${fmt(b.value)}</b></div></div>`).join("")}</div></section>`;
  }

  h += ourTake(r, aGets - bGets);
  h += impactCard(r);
  h += negotiatorCard(r);

  let d = "";
  const TA = r.teams.A, TB = r.teams.B;
  if (!r.redraft && (TA.mode !== "neutral" || TB.mode !== "neutral")) {
    d += `<div class="kv"><span>${esc(A)} (${MODE_LABEL[TA.mode].toLowerCase()})</span><b class="${TA.net >= 0 ? "good" : "bad"}">${fmt_signed(TA.net)}</b></div>
          <div class="kv"><span>${esc(B)} (${MODE_LABEL[TB.mode].toLowerCase()})</span><b class="${TB.net >= 0 ? "good" : "bad"}">${fmt_signed(TB.net)}</b></div>`;
  }
  if (r.a_spots) d += `<p class="note">${esc(r.a_spots > 0 ? A : B)} ${verb(r.a_spots > 0 ? A : B, "free")} ${plural(Math.abs(r.a_spots), "roster spot")} (worth ${fmt(r.spot_cost)} each).</p>`;
  if (r.consolidation) d += `<p class="note">${esc(r.consolidation.side === "A" ? A : B)} ${verb(r.consolidation.side === "A" ? A : B, "get")} the best player (${plinkName(r.consolidation.asset)}), worth a bonus of ${fmt(r.consolidation.bonus)}.</p>`;
  if (r.te_risk) for (const k of ["A", "B"]) if (r.te_risk[k] > 0) { const who = k === "A" ? A : B;
    d += `<p class="note">Trading for a tight end is risky: ${esc(r.te_risk.names[k].join(" and "))} ${r.te_risk.names[k].length > 1 ? "count" : "counts"} ${fmt(r.te_risk[k])} less for ${esc(who)}. Many tight ends break out late or never do.</p>`; }
  if (r.lineup) {
    for (const k of ["A", "B"]) {
      const L = r.lineup[k];
      if (!L) continue;
      const dd = L.after - L.before;
      d += `<div class="kv"><span>${esc(L.team)} starting lineup</span><b class="${dd > 0 ? "good" : (dd < 0 ? "bad" : "")}">${dd > 0 ? "better" : (dd < 0 ? "worse" : "same")} (${fmt_signed(dd)})</b></div>`;
    }
  }
  if (r.warnings.length) d += `<p class="note warn">${r.warnings.map(esc).join("<br>")}</p>`;
  if (typeof GM !== "undefined" && GM.available()) h += `<section class="card gm-cta"><button class="btn primary block" id="askGMTrade">${GM.icon()} Ask the GM about this trade</button>
    <p class="note muted" style="text-align:center;padding-bottom:0">Should you do it, what would make it work, what to say to them.</p></section>`;
  h += `<section class="card">${d ? more("More details", d) : ""}<button class="btn ghost block" id="saveLog" ${locked() ? 'data-lock="history"' : ""} style="margin-top:${d ? "12px" : "0"}">Save to history ${proTag()}</button></section>`;
  box.innerHTML = h;
  bindNegotiator(box);
  const ag = $("#askGMTrade", box);
  if (ag) ag.onclick = () => GM.open({ question: GM.tradeQuestion(r) });
  if (!locked()) $("#saveLog").onclick = () => { E.log_trade(r); toast("Saved"); renderLog(); };
  $$("[data-bal]", box).forEach(it => it.onclick = () => {
    const m = E.find_asset(it.dataset.bal, S.values, S.cfg);
    if (m.error) return;
    S.sides[it.dataset.side].items.push(itemFor(m.asset, it.dataset.bal));
    saveUi();
    renderTrade($("#view"));
    toast(`Added ${m.asset.name}`, 1400);
  });
}

/* The Negotiator (Pro): how the other manager likely sees the trade, the odds they say yes, the smallest change that
   gets to yes, and a message ready to send. Needs the other team picked on the "You get" side. */
function negotiatorCard(r) {
  const TA = teamById(S.sides.A.team), TB = teamById(S.sides.B.team);
  if (!S.values.league || !TB || !S.sides.A.items.length || !S.sides.B.items.length) return "";
  if (TA && TA.roster_id === TB.roster_id) return "";
  if (locked()) return `<section class="card"><h2>Will they say yes? ${Pro.tag()}</h2><div class="hint">The Negotiator reads the other manager: their situation, their needs, their trade habits. The odds they accept, the smallest sweetener, and the message to send.</div>
      <button class="btn soft block" data-lock="negotiator" style="margin-top:12px">Show me with Pro</button></section>`;
  const mk = a => ({ asset: a, alts: [], error: null, query: a.name });
  let N;
  try { N = Week.negotiate(S.values, S.cfg, TA, TB, S.sides.A.items.map(mk), S.sides.B.items.map(mk), S.sides.B.mode, S.W && S.W.week); } catch (e) { console.error(e); return ""; }
  if (!N) return "";
  S.nego = N;
  const pool = S.sides.A.items.concat(S.sides.B.items, TA ? E.team_assets(S.values, S.cfg, TA) : [], E.team_assets(S.values, S.cfg, TB));
  const mark = x => `<li class="${x.good ? "good" : "bad"}"><span class="nego-mark">${x.good ? "+" : "\u2212"}</span>${linkify(x.text, pool)}</li>`;
  const sweet = N.sweeteners.length ? `<div class="sub-h">Make it a yes</div><div class="list">${N.sweeteners.map(s => `<div class="item" data-sweet="${esc(s.asset.id)}" data-kind="${s.kind}"><span class="plus">${s.kind === "add" ? "+" : "\u2212"}</span><div class="nm"><div class="n">${s.kind === "add" ? "Add " : "Leave out "}${s.asset.is_pick ? esc(s.asset.name) : `<a class="plink" data-pcard="${esc(s.asset.id)}">${esc(s.asset.name)}</a>`}</div><div class="s">${esc(s.text)}</div></div><div class="v"><b>${fmt(s.asset.value)}</b><div class="d muted">${esc(NEGO_LABEL(s.score))}</div></div></div>`).join("")}</div>` : "";
  const gap = !N.sweeteners.length && N.need > 0 ? `<p class="note">${N.need >= 1500 ? `You're about ${fmt(N.need)} in value short of a deal they'd consider: no single piece gets you there, so rethink the ask.` : `About ${fmt(N.need)} more in value would get them to a good chance; nothing spare on your side fits without tipping it against you.`}</p>` : "";
  const gm = typeof GM !== "undefined" && GM.available() ? `<button class="btn ghost" id="negoGM">Write it with the GM</button>` : "";
  return `<section class="card nego"><div class="nego-top"><h2>Will ${esc(TB.team_name)} say yes?</h2><span class="nego-band ${N.tone}">${esc(N.band)}</span></div>
    <div class="hint">${esc(N.summary)}</div>
    <ul class="nego-why">${N.reasons.map(mark).join("")}</ul>${sweet}${gap}
    <div class="sub-h">The message</div><div class="nego-msg" id="negoMsg">${esc(N.message)}</div>
    <div class="btns"><button class="btn soft" id="negoCopy">Copy message</button>${gm}</div></section>`;
}
const NEGO_LABEL = score => (score >= 10 ? "Very likely" : score >= 3 ? "Good chance" : score >= -5 ? "Coin flip" : "Long shot");
function bindNegotiator(box) {
  $$("[data-sweet]", box).forEach(it => it.onclick = () => {
    if (it.dataset.kind === "drop") { S.sides.B.items = S.sides.B.items.filter(a => a.id !== it.dataset.sweet); toast("Left out of the ask", 1400); }
    else { const m = E.find_asset(it.dataset.sweet, S.values, S.cfg); if (m.error) return; if (tradeFull()) { Pro.lock("tradesize"); return; } S.sides.A.items.push(itemFor(m.asset, it.dataset.sweet)); toast(`Added ${m.asset.name}`, 1400); }
    S.result = null; saveUi(); renderTrade($("#view")); analyze(false, false);
  });
  const cp = $("#negoCopy", box);
  if (cp) cp.onclick = async () => {
    const text = S.nego ? S.nego.message : "";
    try { await navigator.clipboard.writeText(text); toast("Copied. Paste it in your league chat."); }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied. Paste it in your league chat."); } catch (e2) { toast("Couldn't copy; long-press the message instead."); } ta.remove(); }
  };
  const g = $("#negoGM", box);
  if (g) g.onclick = () => { const N = S.nego, B = teamById(S.sides.B.team); GM.open({ question: `Write a short, friendly message to ${N.owner} proposing this trade: I give ${S.sides.A.items.map(a => a.name).join(", ")} for ${S.sides.B.items.map(a => a.name).join(", ")}. The Negotiator reads them as ${N.band.toLowerCase()}: ${N.reasons.map(x => x.text).join("; ")}. Two to four sentences, one clear ask, no number dump, and lead with what's in it for ${B ? B.team_name : "them"}.` }); };
}

/* Trade impact (Pro): what the trade does to each team's season (playoff and title odds and projected wins, simulated
   with the players moved) and, in dynasty, to the roster's value two seasons out and the team's own next first-round pick. */
function impactCard(r) {
  const TA = teamById(S.sides.A.team), TB = teamById(S.sides.B.team);
  if (!S.values.league || !(TA || TB)) return "";
  if (locked()) return `<section class="card"><h2>Trade impact ${Pro.tag()}</h2><div class="hint">Playoff and title odds before and after, and what the trade does to each roster two seasons out.</div>
      <button class="btn soft block" data-lock="impact" style="margin-top:12px">Show me with Pro</button></section>`;
  const mk = a => ({ asset: a, alts: [], error: null, query: a.name });
  let I;
  try { I = E.trade_impact(S.values, S.cfg, TA, TB, S.sides.A.items.map(mk), S.sides.B.items.map(mk)); } catch (e) { console.error(e); return ""; }
  if (!I) return "";
  const pct = x => `${Math.round(x * 100)}%`;
  const delta = (b, a, unit = "", scale = 100, min = 0.5) => { const d = (a - b) * scale; return Math.abs(d) >= min ? `<i class="${d > 0 ? "good" : "bad"}">${d > 0 ? "+" : "−"}${Math.abs(d) >= 10 || unit === "%" ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1)}${unit}</i>` : `<i class="muted">same</i>`; };
  const row = (label, before, after, d) => `<div class="imp-row"><span>${label}</span><b>${before} <em>→</em> ${after}</b>${d}</div>`;
  let h = "";
  for (const k of ["A", "B"]) {
    const sd = I.sides[k]; if (!sd) continue;
    const team = k === "A" ? TA : TB, mine = team && team.roster_id === S.cfg.my_roster_id;
    let rows = "";
    if (I.weeks_left > 0) {
      rows += row("Playoff odds", pct(sd.playoff[0]), pct(sd.playoff[1]), delta(sd.playoff[0], sd.playoff[1]));
      rows += row("Title odds", pct(sd.title[0]), pct(sd.title[1]), delta(sd.title[0], sd.title[1]));
      rows += row("Projected wins", sd.wins[0].toFixed(1), sd.wins[1].toFixed(1), delta(sd.wins[0], sd.wins[1], "", 1, 0.05));
    }
    if (sd.future) rows += row("Roster value in two seasons", fmt(Math.round(sd.future[0])), fmt(Math.round(sd.future[1])), delta(sd.future[0] ? sd.future[0] : 1, sd.future[1], "%", 100 / Math.max(1, sd.future[0]), 1));
    if (sd.pick && !sd.pick.traded) {
      const lb = sd.pick.before.label.replace(/^proj\. /, ""), la = sd.pick.after.label.replace(/^proj\. /, "");
      if (lb !== la) rows += row(`${mine ? "Your" : "Their"} ${esc(sd.pick.name)}`, esc(lb), esc(la), `<i class="${sd.pick.after.value > sd.pick.before.value ? "good" : "bad"}">${sd.pick.after.value > sd.pick.before.value ? "earlier" : "later"}</i>`);
    }
    if (rows) h += `<div class="imp-team">${esc(sd.team)}${mine ? ' <span class="muted">(you)</span>' : ""}</div>${rows}`;
  }
  if (!h) return "";
  return `<section class="card impact"><h2>Trade impact</h2><div class="hint">Each team's season and future with the players moved.</div>${h}
    <p class="note muted">${I.weeks_left > 0 ? "Odds from 2,000 simulated seasons of the remaining schedule" : "The season's games are played, so the odds don't move"}${E.is_redraft(S.cfg) ? "" : "; two-season value follows the age curves"}.</p></section>`;
}

/* Our take on a trade (Pro): a second verdict. The bar prices every player at the market; we price each one at the
   market value of the player at OUR rank for him (a.ours: the grade turned into a value), picks at the market.
   Side A is what you give, side B what you get. */
function ourTake(r, barNet) {
  const items = k => S.sides[k].items.map(it => S.values.by_id[it.id] || it).filter(Boolean);
  const IA = items("A"), IB = items("B"), all = IA.concat(IB), players = all.filter(a => !a.is_pick);
  const any = S.values.players.some(a => a.oscore != null);
  if (locked()) return any && players.length ? `<section class="card"><h2>Our take ${Pro.tag()}</h2><div class="hint">The bar is the market. See whether our grades, which look at where each player is going, agree with it.</div>
      <button class="btn soft block" data-lock="ourgrade" style="margin-top:12px">Show me with Pro</button></section>` : "";
  if (!players.some(a => a.oscore != null)) return "";
  const val = a => (!a.is_pick && a.oscore != null && a.ours > 0 ? a.ours : a.value);
  const sum = (l, f) => l.reduce((t, a) => t + f(a), 0);
  // + = side A gets more than it gives. The bar's net (roster spots and the best player counted), then our prices swapped in
  const mkt = barNet, ours = barNet + (sum(IB, val) - sum(IB, a => a.value)) - (sum(IA, val) - sum(IA, a => a.value));
  const half = Math.max(1, (sum(IA, a => a.value) + sum(IB, a => a.value)) / 2);
  const call = x => (Math.abs(x) < 0.08 * half ? 0 : Math.sign(x));
  const cm = call(mkt), co = call(ours);
  const A = sideName("A"), B = sideName("B"), win = x => (x > 0 ? A : B);
  const step = a => (a.is_pick || a.oscore == null ? 0 : gIdx(gradeOf(a, true).g) - gIdx(gradeOf(a).g));
  const notable = players.filter(a => Math.abs(step(a)) >= 1).sort((x, y) => Math.abs(step(y)) - Math.abs(step(x)) || y.value - x.value).slice(0, 2)
    .map(a => `${plinkName(a.name)} <span class="muted">(ours ${esc(gradeOf(a).g)}, market ${esc(gradeOf(a, true).g)})</span>`);
  const why = notable.length ? ` The difference: ${notable.join(" and ")}.` : "";
  const rd = E.is_redraft(S.cfg), lens = rd ? "this season's points" : "where each player is going";
  let head, text;
  if (co === cm) {
    head = "Our grades agree with the bar";
    text = co === 0 ? `Even by the market, and even by ${lens}.${why}` : `${esc(win(co))} ${verb(win(co), "come")} out ahead both ways.${why}`;
  } else if (co === 0) {
    head = "Our grades call this even";
    text = `The bar says ${esc(win(cm))} ${verb(win(cm), "get")} more, but by ${lens} it's close.${why}`;
  } else if (cm === 0) {
    head = `Our grades favor ${esc(win(co))}`;
    text = `The bar says even. By ${lens}, ${esc(win(co))} ${verb(win(co), "get")} about ${fmt(Math.abs(ours))} more.${why}`;
  } else {
    head = "Our grades flip this";
    text = `The bar favors ${esc(win(cm))}, but by ${lens} ${esc(win(co))} ${verb(win(co), "get")} about ${fmt(Math.abs(ours))} more.${why}`;
  }
  const tone = co > 0 ? "good" : co < 0 ? "bad" : "";
  return `<section class="card our-take ${tone}"><h2>Our take</h2><p class="note"><b>${head}.</b> ${text}${all.length > players.length ? " Picks are priced at the market." : ""}</p></section>`;
}

// ---------------------------------------------------------------------------
// Trade history: the league's real trades (Sleeper, this season and the seasons before it) and the checks saved here,
// each with what happened next (history.js). An entry row sits under the trade screen; the list and each trade open
// as sheets, so a player's name still opens his card and the list comes back when the card closes.
// ---------------------------------------------------------------------------
const HIST_ICON = `<svg viewBox="0 0 24 24"><path d="M12 8v4l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 3v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const HIST_SEGS = [["mine", "Yours"], ["all", "League"], ["saved", "Saved checks"]];
function renderLog() {
  const box = $("#tlog");
  if (!box) return;
  const lg = S.values && S.values.league, saved = E.read_log().length, c = typeof Hist !== "undefined" ? Hist.cached() : null;
  if (!(lg && lg.league_id) && !saved) { box.innerHTML = ""; return; }
  const n = c && lg && c.chain[0] === String(lg.league_id) ? c.chain.reduce((a, lid) => a + ((c.seasons[lid] || {}).trades || []).length, 0) : null;
  const parts = [];
  if (lg && lg.league_id) parts.push(n === null ? "every trade in the league" : `${plural(n, "trade")}${c.chain.length > 1 ? ` over ${c.chain.length} seasons` : " this season"}`);
  if (saved) parts.push(plural(saved, "saved check"));
  box.innerHTML = `<section class="card flush"><div class="item th-entry" ${locked() ? 'data-lock="history"' : 'data-hist="1"'}><span class="th-ic">${HIST_ICON}</span>
    <div class="nm"><div class="n"><span class="nt">Trade history</span>${proTag()}</div><div class="s">${esc(parts.join(" · "))} · how they panned out</div></div><span class="chev">›</span></div></section>`;
  const it = $("[data-hist]", box);
  if (it) it.onclick = () => historySheet();
}
function historySheet(seg) {
  if (locked()) return Pro.lock("history");
  if (!S.cfg || !S.values) return;
  const lg = S.values.league, H = S.hist = S.hist || { seg: null, data: null, at: 0, key: null, token: null };
  if (H.key !== E.P.id) { H.key = E.P.id; H.data = null; H.seg = null; }                 // another league: its own history
  if (seg) H.seg = seg;
  const sleeper = !!(lg && lg.league_id);
  if (!H.seg || (!sleeper && H.seg !== "saved")) H.seg = sleeper ? (S.cfg.my_roster_id !== null && S.cfg.my_roster_id !== undefined ? "mine" : "all") : "saved";
  const body = openSheet(`<div class="sheet-head"><h2>Trade history</h2>${sleeper ? `<button class="btn ghost sm" id="thRefresh">Refresh</button>` : ""}<button class="close" aria-label="Close">×</button></div>
    ${sleeper ? `<div class="seg th-seg" id="thSeg">${HIST_SEGS.map(([k, l]) => `<button data-v="${k}" class="${H.seg === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
    <div id="thBody">${loading("Loading the league's trades…")}</div>`, { full: true });
  $(".close", body).onclick = closeSheet;
  $$("#thSeg button", body).forEach(b => b.onclick = () => { H.seg = b.dataset.v; drawHistory(body); });
  const rf = $("#thRefresh", body);
  if (rf) rf.onclick = () => loadHistory(body, true);
  S.sheetReturn = () => setTimeout(() => { if (!sheetOpen()) historySheet(); }, 0);        // a player card opened from the list brings the list back
  loadHistory(body, false);
}
async function loadHistory(body, force) {
  const H = S.hist, lg = S.values.league, tok = H.token = {}, box = () => (H.token === tok ? $("#thBody", body) : null);
  if (H.data && !force && Date.now() - H.at < 10 * 60000) return drawHistory(body);
  if (force && box()) box().innerHTML = loading("Checking Sleeper for new trades…");
  try {
    const hist = lg && lg.league_id ? await Hist.ensure(S.cfg, lg, { force }) : { chain: [], seasons: {}, fetched: E.now_iso() };
    if (box()) box().innerHTML = loading("Adding up what happened since…");
    const data = await Hist.outcomes(S.cfg, S.values, hist);
    H.data = data; H.at = Date.now();
    try { Hist.market_save(Hist.market_fit(data.trades, parseInt(S.cfg.season, 10))); S.result = null; } catch (e) { /* the market fit never blocks the sheet */ }
    if (box()) drawHistory(body);
  } catch (e) {
    console.error(e);
    if (box()) box().innerHTML = `<div class="empty">Couldn't load the trade history. Check your connection and try again.</div>`;
  }
}
function drawHistory(body) {
  const H = S.hist, D = H.data, box = $("#thBody", body);
  if (!box || !D) return;
  $$("#thSeg button", body).forEach(b => b.classList.toggle("on", b.dataset.v === H.seg));
  let rows = H.seg === "saved" ? D.saved : D.trades;
  if (H.seg === "mine") rows = rows.filter(t => t.sides.some(s => s.mine));
  const span = D.seasons.length > 1 ? `${Math.min(...D.seasons)}–${Math.max(...D.seasons)}` : String(D.seasons[0] || "");
  const foot = `<p class="credit">${D.seasons.length ? `Trades from <a data-link="https://sleeper.com">Sleeper</a> (${esc(span)}), checked ${esc(ago(D.fetched))}. ` : ""}Points from <a data-link="https://github.com/nflverse/nflverse-data">nflverse</a> (CC BY 4.0). Tap a trade for the details.</p>`;
  if (!rows.length) {
    const msg = H.seg === "saved" ? "No saved checks yet. After checking a trade on the Trade tab, tap Save to history."
      : H.seg === "mine" ? (S.cfg.my_roster_id === null || S.cfg.my_roster_id === undefined ? "Pick your team on the My team tab to see your trades." : "You haven't made a trade in this league yet.") : "No trades in this league yet.";
    box.innerHTML = `<div class="empty">${esc(msg)}</div>${foot}`;
    return;
  }
  let h = "", last = null;
  rows.forEach((t, i) => { if (t.season !== last) { last = t.season; h += `<div class="grp">${t.season} season</div>`; } h += histRow(t, i); });
  box.innerHTML = h + foot;
  $$("[data-th]", box).forEach(r => r.onclick = e => { if (e.target.closest(".plink")) return; tradeSheet(rows[+r.dataset.th]); });
}
const histWhen = t => (t.offseason ? "Offseason" : `Week ${t.week}`) + (t.created ? ` · ${new Date(t.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : "");
const sideWho = s => (s.mine ? "You" : s.name);
const ptsTxt = n => `${fmt(n)} ${Math.round(n) === 1 ? "pt" : "pts"}`;
/* The headline: who is ahead so far, in plain words, and its colour (green: you, red: the other side, amber: a slight edge). */
function histVerdict(t) {
  const v = t.verdict, inTrade = t.sides.some(s => s.mine), w = v.winner !== null && v.winner !== undefined ? t.sides.find(s => s.rid === v.winner) : null;
  if (v.tone === "none") return { title: t.over ? "No points either way" : "No games yet", cls: "t-fair" };
  if (!w) return { title: t.over ? "Came out even" : "Even so far", cls: "t-fair" };
  const who = sideWho(w), you = w.mine, is = you ? "are" : "is";
  const title = v.tone === "edge" ? `Slight edge: ${you ? "you" : who}` : v.tone === "win" ? (t.over ? `${who} won this one` : `${who} ${is} ahead so far`) : (t.over ? `${who} won big` : `${who} ${is} well ahead`);
  return { title, cls: v.tone === "edge" ? "t-edge" : you ? "t-good" : inTrade ? "t-bad" : "t-other", mine: you };   // t- prefix: .edge/.good/.bad are taken
}
function piecesText(ps) {
  if (!ps.length) return `<span class="muted">nothing</span>`;
  return ps.map(p => {
    if (p.kind === "faab") return esc(p.name);
    if (p.kind === "pick" && p.became) return `${p.asset && p.asset.id && !p.asset.is_pick ? plink(p.asset) : esc(p.name)} <small>(${esc(p.label)}${p.slot ? ", " + esc(p.slot) : ""})</small>`;
    if (p.kind === "pick") return esc(p.label);
    return p.asset && p.asset.id ? plink(p.asset) : esc(p.name);
  }).join(", ");
}
function sideNums(s) {
  const pts = s.sum.pts_known ? `${ptsTxt(s.sum.pts)} since` : "";
  if (E.is_redraft(S.cfg)) return (pts || "no games yet") + (s.sum.best_n && s.sum.best !== s.sum.pts ? ` · best ${s.sum.best_n}: ${fmt(s.sum.best)}` : "");
  return `worth ${fmt(s.sum.now)} now${pts ? ` · ${pts}` : ""}`;
}
function histRow(t, i) {
  const V = histVerdict(t), sides = t.sides, redraft = E.is_redraft(S.cfg), num = s => Math.max(0, redraft ? s.sum.pts : s.sum.now);
  const tot = Math.max(1, sides.reduce((x, s) => x + num(s), 0)), share = s => Math.max(6, Math.min(94, num(s) / tot * 100)).toFixed(1);
  const lead = s => (t.verdict.winner === s.rid ? ` lead ${V.cls}` : "");
  return `<div class="th-row" data-th="${i}">
    <div class="th-top"><span class="th-when">${esc(histWhen(t))}</span><span class="th-tag ${V.cls}">${esc(V.title)}</span></div>
    <div class="th-sides">${sides.map(s => `<div class="th-side"><div class="th-who">${esc(sideWho(s))} ${t.kind === "saved" ? "would get" : "got"}</div><div class="th-pieces">${piecesText(s.got)}</div><div class="th-num">${sideNums(s)}</div></div>`).join("")}</div>
    ${sides.length === 2 ? `<div class="th-bar"><span class="${lead(sides[0])}" style="flex-basis:${share(sides[0])}%"></span><span class="b${lead(sides[1])}" style="flex-basis:${share(sides[1])}%"></span></div>` : ""}</div>`;
}
/* One sentence under the headline: the two sides' worth today and the points they have put up since. */
function histLine(t) {
  const [A, B] = t.sides, redraft = E.is_redraft(S.cfg), saved = t.kind === "saved";
  const what = s => (s.mine ? (saved ? "What you'd get" : "What you got") : `What ${s.name} ${saved ? "would get" : "got"}`), who = s => (s.mine ? "you" : s.name), lc = x => x.replace(/^What/, "what");
  if (t.sides.length > 2) return `${t.sides.length} teams were in this one. Each side's totals are below.`;
  if (!B) return "";
  if (redraft) {
    if (!(A.sum.pts_known || B.sum.pts_known)) return "No games have been played since.";
    const n = t.verdict.best_n, tail = t.over ? ", over the rest of that season." : " so far.";
    if (n) return `Judged on each side's best ${n}: ${lc(what(A))} scored ${fmt(A.sum.best)} points (${fmt(A.sum.pts)} in all); ${lc(what(B))} scored ${fmt(B.sum.best)} (${fmt(B.sum.pts)} in all)${tail}`;
    return `${what(A)} scored ${fmt(A.sum.pts)} points; ${lc(what(B))} scored ${fmt(B.sum.pts)}${tail}`;
  }
  const pts = A.sum.pts_known && B.sum.pts_known && (A.sum.pts || B.sum.pts) ? `, and has scored ${fmt(A.sum.pts)} points to ${fmt(B.sum.pts)} since` : "";
  return `${what(A)} is worth ${fmt(A.sum.now)} today against ${fmt(B.sum.now)} for ${who(B)}${pts}.`;
}
function pieceRow(p) {
  if (p.kind === "faab") return `<div class="item th-piece"><span class="av pick"><b>$</b></span><div class="nm"><div class="n"><span class="nt">${esc(p.name)}</span></div><div class="s">Waiver budget</div></div></div>`;
  const a = p.asset || {}, stub = { name: p.name, pos: a.pos || "?", team: a.team || "", sleeper_id: a.sleeper_id || null, is_pick: !!a.is_pick };
  const shown = a.id ? a : stub, name = a.id && !a.is_pick ? plink(a) : esc(p.name);
  const what = p.kind === "pick" ? (p.became ? `Was the ${esc(p.label)}${p.slot ? ` (pick ${esc(p.slot)})` : ""}` : `Draft pick${p.proj ? " · " + esc(p.proj) : ""}`) : sub(shown);
  const since = p.future ? "" : p.pts_known ? `${ptsTxt(p.pts)} since${p.g ? ` (${plural(p.g, "game")})` : ""}` : "";
  const then = p.then !== null && p.then !== undefined && Math.abs(p.then - p.value) >= 1 ? ` <s class="was">${fmt(p.then)}</s>` : "";
  return `<div class="item th-piece">${avatar(shown)}<div class="nm"><div class="n"><span class="nt">${name}</span>${a.id && !a.is_pick ? statusFlag(a) : ""}</div><div class="s">${what}${since ? ` · ${since}` : ""}</div></div>
    <div class="v"><div class="gv">${a.id ? gradeChip(a, false) : ""}</div><div class="d muted">${fmt(p.value)}${then}</div></div></div>`;
}
function tradeSheet(t) {
  const V = histVerdict(t), redraft = E.is_redraft(S.cfg), saved = t.kind === "saved", thenKnown = t.sides.some(s => s.sum.then_full);
  const totals = s => `<div class="th-tot">${redraft ? "" : `<div class="kv"><span>Worth today</span><b>${fmt(s.sum.now)}${s.sum.then_full ? ` <small class="muted">was ${fmt(s.sum.then)}</small>` : ""}</b></div>`}
    <div class="kv"><span>${t.over ? "Points after the trade" : "Points since"}</span><b>${s.sum.pts_known ? ptsTxt(s.sum.pts) : "—"}</b></div>
    ${s.sum.best_n && s.sum.best !== s.sum.pts ? `<div class="kv"><span>Best ${s.sum.best_n} of them</span><b>${ptsTxt(s.sum.best)}</b></div>` : ""}</div>`;
  const then = saved ? `<section class="card"><h2>At the time</h2><div class="hint">The app said: ${esc(t.then_verdict || "—")}.${t.snap ? " Values from that day are struck through where they have moved." : ""}</div></section>`
    : thenKnown ? `<section class="card"><h2>At the time</h2><div class="hint">The app's values on ${esc(t.snap)}, against today's.</div>
      ${t.sides.map(s => `<div class="kv"><span>${esc(sideWho(s))} got</span><b>${s.sum.then_full ? fmt(s.sum.then) : "—"} → ${fmt(s.sum.now)}</b></div>`).join("")}</section>` : "";
  const body = openSheet(`<div class="sheet-head"><h2>${saved ? "Saved check" : "Trade"} · ${esc(histWhen(t))}</h2><button class="close" aria-label="Close">×</button></div>
    <section class="card th-verdict ${V.cls}"><div class="th-vtitle">${esc(V.title)}</div><div class="hint">${esc(histLine(t))}</div></section>
    ${t.sides.map(s => `<section class="card"><h2>${esc(sideWho(s))} ${saved ? "would get" : "got"}</h2><div class="list">${s.got.map(pieceRow).join("") || `<div class="empty">Nothing</div>`}</div>${totals(s)}</section>`).join("")}
    ${then}${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}
    <button class="btn soft block" id="thRecheck">Check it with today's values</button>
    <p class="note muted">${redraft ? "Points: each player's fantasy points in this league's scoring, from the trade week to the end of that season." : "Points: each player's fantasy points in this league's scoring since the trade. Values are today's; a pick that has been used counts as the player it became."}</p>`,
    { full: true, onClose: () => historySheet() });
  $(".close", body).onclick = closeSheet;
  S.sheetReturn = () => setTimeout(() => { if (!sheetOpen()) tradeSheet(t); }, 0);
  $("#thRecheck", body).onclick = () => recheckTrade(t);
}
/* The trade on the trade screen, priced today: You give = what your side gave (the other side's pieces when you
   weren't in it), You get = what your side got. The teams are left open so nothing is dropped for having moved since. */
function recheckTrade(t) {
  let left = 0;
  const assets = ps => ps.filter(p => p.kind !== "faab").map(p => (p.asset && p.asset.id && S.values.by_id[p.asset.id] ? p.asset : (left++, null))).filter(Boolean);
  const me = t.sides.find(s => s.mine) || t.sides[0], other = t.sides.find(s => s !== me);
  const give = me.gave && me.gave.length ? assets(me.gave) : other ? assets(other.got) : [];
  S.sides.A = { team: null, mode: "neutral", items: give };
  S.sides.B = { team: null, mode: "neutral", items: assets(me.got) };
  S.result = null; S.lastAdd = null; saveUi();
  S.sheetStack = []; closeSheet();
  go("trade");
  if (left) toast(left === 1 ? "One piece has no value today and was left out." : `${left} pieces have no value today and were left out.`, 3200);
  if (S.sides.A.items.length && S.sides.B.items.length) setTimeout(() => analyze(false, true), 80);
}

function picker(k) {
  const s = S.sides[k], team = teamById(s.team);
  const inSide = new Set(S.sides.A.items.concat(S.sides.B.items).map(a => a.id));
  const body = openSheet(`<div class="sheet-head"><h2>${k === "A" ? "You give" : "You get"}</h2><button class="close" aria-label="Close">×</button></div>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <input type="search" id="pq" placeholder="Search players${E.is_redraft(S.cfg) ? "" : ' or type "2027 1st"'}" autocomplete="off"></div>
    <div id="pres" class="list"></div>`, { full: true, focus: team ? null : "#pq" });
  $(".close", body).onclick = closeSheet;
  const add = id => {
    const pool = team ? E.team_assets(S.values, S.cfg, team) : [];
    const a = pool.find(x => x.id === id) || E.find_asset(id, S.values, S.cfg).asset;
    if (!a) return;
    if (inSide.has(a.id)) {                                   // tapped again: take him back out (from whichever side he's on)
      for (const k2 of ["A", "B"]) S.sides[k2].items = S.sides[k2].items.filter(x => x.id !== a.id);
      inSide.delete(a.id);
      S.result = null; saveUi(); renderTrade($("#view")); toast(`Removed ${a.name}`, 1400); draw();
      return;
    }
    if (tradeFull()) { closeSheet(); Pro.lock("tradesize"); return; }
    s.items.push(a);
    S.lastAdd = { side: s === S.sides.A ? "A" : "B", id: a.id };
    inSide.add(a.id);
    S.result = null;
    saveUi();
    renderTrade($("#view"));
    toast(`Added ${a.name}`, 1400);
    draw();
  };
  const row = a => assetRow(a, { act: "pick", right: inSide.has(a.id) ? `<b class="good">✓</b>` : gradeRight(a) });
  function draw() {
    const q = $("#pq", body).value.trim(), res = $("#pres", body);
    let h = "";
    if (q) {
      const pk = E.is_redraft(S.cfg) ? null : E.parse_pick_query(q, S.values.default_pick_season, parseInt(S.cfg.league.teams));
      if (pk) h += row(E.resolve_pick(S.values, S.cfg, ...pk));
      const pool = team ? E.team_assets(S.values, S.cfg, team).filter(a => !a.is_pick) : null;
      const inTeam = pool ? E.search_players(q, S.values, 12, pool) : [];
      if (inTeam.length) h += `<div class="grp">${esc(team.team_name)}</div>` + inTeam.map(row).join("");
      const all = E.search_players(q, S.values, 15).filter(a => !inTeam.some(x => x.id === a.id));
      if (all.length) h += `<div class="grp">${team ? "Other players" : "Players"}</div>` + all.map(row).join("");
      if (!h) h = `<div class="empty">No match. Check the spelling.</div>`;
    } else if (team) {
      const roster = E.team_assets(S.values, S.cfg, team);
      for (const [pos, label] of [["QB", "Quarterbacks"], ["RB", "Running backs"], ["WR", "Wide receivers"], ["TE", "Tight ends"], ["K", "Kickers"], ["DEF", "Defenses"], ["PICK", "Draft picks"]]) {
        const g = roster.filter(a => a.pos === pos);
        if (pos !== "PICK") g.sort((a, b) => b.value - a.value);                    // picks keep Sleeper's order: season, then round
        if (g.length) h += `<div class="grp">${label}</div>` + g.map(row).join("");
      }
    } else {
      if (!E.is_redraft(S.cfg)) {
        const seasons = S.values.pick_seasons.slice(0, 2);
        h += `<div class="grp">Draft picks</div>` + seasons.flatMap(y => [1, 2].map(r => row(E.resolve_pick(S.values, S.cfg, y, r, null)))).join("");
      }
      h += `<div class="grp">Top players</div>` + S.values.players.filter(a => !a.unranked).slice(0, 30).map(row).join("");
    }
    res.innerHTML = h + credits();
    $$(".item", res).forEach(it => it.onclick = () => add(it.dataset.id));
  }
  $("#pq", body).oninput = draw;
  draw();
}

// ---------------------------------------------------------------------------
// Rankings tab
// ---------------------------------------------------------------------------
/* Market vs ours in dynasty (2026-10-16, the user's ask: the old buy/sell lists were saturated and the sells didn't
   follow the dynasty rankings). Three lists, a player in one at most:
     Sell       at or past his position's decline age (AGE_DECLINE: RB 27, WR 29, TE 35, QB 38), or 25+ with a C+ or
                lower dynasty grade and our model 25% or more under the market; market value 1,500+
     Sell high  his value is likely to drop: a year from the decline with a 3,000+ price, or 25+ and not an A/A+ and
                scoring well over what his usage earns (touchdowns running hot) while our model sees no more in him
     Buy        our model 30% or more over the outside market, a B- or better, market value 1,500+, two years or more
                short of the decline (QBs 30 and under), on a team and not on a long injury list
   The market is FantasyCalc x DynastyProcess (a.omkt) and our view our own model on that scale (a.oview, attach_orank). */
const EDGE_KINDS = [["buy", "Buy"], ["sellhigh", "Sell high"], ["sell", "Sell"]];
const EDGE_OUT = ["IR", "PUP", "Out", "Sus", "Suspended", "DNR", "NA"];
function dynastyEdge(a) {
  if (!a || a.is_pick || a.unranked || !a.omkt || a.age == null || !E.AGE_DECLINE[a.pos]) return null;
  const st = E.load_player_status()[a.sleeper_id] || {}, dec = E.AGE_DECLINE[a.pos], age = a.age, yrs = Math.floor(age);
  const ratio = a.oview ? a.oview / a.omkt : 1, ep = a.ep;
  const g = gradeOf(a).g, top = g === "A+" || g === "A", cliff = E.AGE_CLIFF[a.pos];
  if (a.omkt >= 1500 && age >= dec) return { kind: "sell", score: a.omkt, why: age >= cliff ? `${a.pos} at ${yrs}: past the cliff` : `${a.pos} at ${yrs}: decline years` };
  if (a.omkt >= 1500 && age >= 25 && ratio <= 0.75 && ["C+", "C", "C-", "D", "F"].includes(g)) return { kind: "sell", score: a.omkt * (1 - ratio), why: "Short on dynasty value" };
  if (a.omkt >= 3000 && age >= dec - 1) return { kind: "sellhigh", score: a.omkt, why: `${a.pos} at ${yrs}: a year from the decline` };
  // touchdowns running hot: not for a young star (2026-10-16: Jaxon Smith-Njigba, 24 and A+, is no sell)
  if (a.omkt >= 1500 && age >= 25 && !top && ep && ep.g >= 4 && ep.exp > 0 && ep.pts / ep.exp >= 1.2 && ep.td - ep.tdx >= 2.5 && ratio <= 1.05)
    return { kind: "sellhigh", score: a.omkt * ep.pts / ep.exp, why: `${ep.td} TDs on ${ep.tdx.toFixed(1)} expected` };
  if (a.omkt >= 1500 && ratio >= 1.3 && age <= dec - 2 && !(a.pos === "QB" && age > 30) && gIdx(g) <= gIdx("B-") && !EDGE_OUT.includes(st.inj) && a.team && a.team !== "FA")
    return { kind: "buy", score: a.omkt * ratio, why: `Ours ${Math.round((ratio - 1) * 100)}% over the market` };
  return null;
}
function renderRank(el) {
  if (!S.cfg) return needLeague(el);
  if (!S.values) return needValues(el);
  const R = S.rank, hasLg = teams().length > 0;
  ensureWeek("rank");
  const owner = {};
  if (hasLg) for (const t of teams()) for (const pid of t.players) owner[pid] = t;
  const tabs = [["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]].concat(E.is_redraft(S.cfg) ? [] : [["PICK", "Picks"], ["ROOK", `${draftYear()} class`], ["DRAFT", "Draft helper"]]);
  R.rpos = R.rpos || "ALL";
  const hasOurs = S.values.players.some(a => a.ours > 0);
  if (hasOurs) tabs.push(["EDGE", "Market vs ours"]);
  if (R.pos === "EDGE" && (locked() || !hasOurs)) R.pos = "ALL";
  R.edge = R.edge || "buy";
  const dynEdge = !E.is_redraft(S.cfg) && S.values.players.some(a => a.omkt);   // the dynasty lists need the outside market (values from 2026-10-16 on)
  if (!dynEdge && R.edge === "sellhigh") R.edge = "sell";
  // the order (2026-10-16): our own ranking first, then this season's points, then this week's projection
  R.order = R.order || "ours";
  const listPos = ["ALL", "QB", "RB", "WR", "TE"].includes(R.pos), oursOn = hasOurs && !locked();
  const ORDERS = [["ours", oursOn ? "Our rank" : "Rank"], ["points", "Points"], ["proj", "Projected"]];
  el.innerHTML = `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input type="search" id="rq" placeholder="Search players" value="${esc(R.q)}"></div>
    <div class="chips-row">${tabs.map(([p, l]) => `<button class="fchip ${R.pos === p ? "on" : ""}${p === "EDGE" ? " edge-chip" : ""}" data-pos="${p}" ${p === "EDGE" && locked() ? 'data-lock="ourgrade"' : ""}>${l}${p === "EDGE" ? " " + proTag() : ""}</button>`).join("")}
      ${hasLg ? `<span class="chip-gap"></span><button class="fchip ${R.who === "free" ? "on" : ""}" data-who="free">Available</button><button class="fchip ${R.who === "mine" ? "on" : ""}" data-who="mine">Mine</button>` : ""}</div>
    ${R.pos === "EDGE" && dynEdge ? `<div class="seg" id="eseg">${EDGE_KINDS.map(([k, l]) => `<button data-e="${k}" class="${R.edge === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="note muted" style="margin:8px 2px 10px">${R.edge === "buy" ? `Our model rates these players at least 30% above the outside market (${esc([].concat(S.values.meta.anchor || []).map(n => (E.SOURCES[n] || {}).label || n).join(" and "))}), and they're young enough to keep the value. Good ones to trade for.`
        : R.edge === "sellhigh" ? "Their value is likely to drop: a year from their position's decline age, or scoring well above what their usage earns (touchdowns running hot). Sell while the price is high."
        : "Past their position's decline age (running backs 27, receivers 29, tight ends 35, quarterbacks 38), or short on dynasty value. Worth more to a contender this season than to your future: sell for younger players or picks."}</p>` : ""}
    ${R.pos === "EDGE" && !dynEdge ? `<div class="seg" id="eseg"><button data-e="buy" class="${R.edge === "buy" ? "on" : ""}">Buys</button><button data-e="sell" class="${R.edge === "sell" ? "on" : ""}">Sells</button></div>
      <p class="note muted" style="margin:8px 2px 10px">${E.is_redraft(S.cfg)
        ? (R.edge === "buy" ? "We grade these players higher than the market does. Their production, role and health say they'll score more than they cost this season."
          : "The market grades these players higher than we do. Their price is ahead of what they'll likely score this season. In redraft most players can be replaced, so sell the name, keep the points.")
        : (R.edge === "buy" ? "We grade these players higher than the market does. Their age curve and production say they're worth more than they trade for: good ones to trade for."
          : "The market grades these players higher than we do. Their age curve says their value is near its top: good ones to trade away while they still bring a lot.")}</p>` : ""}
    ${listPos ? `<div class="seg rk-seg" id="oseg">${ORDERS.map(([k, l]) => `<button data-o="${k}" class="${R.order === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="note muted" style="margin:6px 2px 8px">${R.order === "points" ? `Fantasy points scored this season${S.W ? "" : " (loading this week's data…)"}.`
        : R.order === "proj" ? `This week's projected points, with the matchup${S.W ? "" : " (loading this week's data…)"}. No game this week sorts last.`
        : oursOn ? `Our ranking: ${E.is_redraft(S.cfg) ? "the points we expect the rest of this season (production, role and health)" : "what each player's future holds (production, the prime years left, role and health)"}. The number is his Our rank score, high to low; his trade value is on his card.`
        : "Ranked by the market's value."}</p>` : ""}
    ${R.pos === "ROOK" ? `<div class="seg" id="rseg">${[["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]].map(([p, l]) => `<button data-rp="${p}" class="${R.rpos === p ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="note muted" style="margin:8px 2px 10px">College players for the ${draftYear()} NFL draft and your ${draftYear()} rookie draft, graded the way we grade NFL players: a forecast from the profile that predicts hits (production for his team this season and last, the age it came at, receptions for backs, size, recruiting pedigree, efficiency), weighted by what has worked for past classes in the NFL. Until the NFL draft, "Projected draft" is where players with profiles like his have been drafted; it counts a fifth of a running back's or receiver's grade and a tenth of a tight end's. Once the draft happens, the pick's round takes its place.</p>` : ""}
    ${more("What do the grades mean?", `<p class="note">${E.is_redraft(S.cfg) ? "Two grades on every player. The big letter is the <b>season</b> grade: the rest of this season." : "Three grades on every player. The big letter is the <b>dynasty</b> grade: his next seasons, in Our rank's order (A+ is about the best player on each team, A the next one, on down to F). The small <b>season</b> letter is this season only: the points we expect him to score the rest of this year, ranked at his position."} <span class="grade ga">A</span> star · <span class="grade gb">B</span> starter · <span class="grade gc">C</span> depth · <span class="grade gd">D</span> long shot · <span class="grade gf">F</span> nothing going: no team, buried on the depth chart, or old and unproductive.
      The small <b>wk</b> letter is <b>this week</b>: his matchup-adjusted projection ranked at his position, A+ must start, F sit, a dash for no game. ${locked() ? "On the Basic plan the grade is the market's."
        : E.is_redraft(S.cfg) ? "The grade is ours: the points he'll score this season (production, role and health). Age doesn't count in redraft. The value and rank are the market's."
        : "The grade is ours: what his future holds (production, the prime years he has left, role and health). The value and rank are the market's."}
      ${E.is_redraft(S.cfg) ? `<span class="mv up">▲</span> value rising, <span class="mv down">▼</span> falling, <span class="mv flat">–</span> steady (last 30 days).` : ""}</p>`)}
    <section class="card flush"><div class="list${R.pos === "EDGE" ? " edge-list" : ""}" id="rlist"></div></section>${credits(R.pos === "ROOK" ? "College data provided by CollegeFootballData.com" : "")}`;
  const drawClass = () => {
    const list = $("#rlist"), Y = draftYear();
    list.innerHTML = loading(`Loading the ${Y} class…`);
    E.prospects(Y).then(d => {
      if (!list.isConnected || R.pos !== "ROOK") return;
      if (!d || !d.players.length) { list.innerHTML = `<div class="empty">The ${Y} class isn't published yet. It appears here as the college season goes on (tools\draft\README.md).</div>`; return; }
      let pool = d.players.filter(p => R.rpos === "ALL" || p.pos === R.rpos);
      if (R.q) { const q = E.norm(R.q); pool = pool.filter(p => E.norm(p.name).includes(q) || E.norm(p.school || "").includes(q)); }
      const kl = kitLocked(Y), shown = pool.slice(0, kl ? KIT_TASTE : R.limit);
      list.innerHTML = shown.map((p, i) => prospectRow(p, R.rpos === "ALL" && !R.q ? p.rank : i + 1)).join("")
        + (kl ? Pro.kitCard(Y, `That's the first round. The whole ${Y} class, ${d.players.length} players graded, and the draft helper are in the ${Y} draft kit.`) : "")
        + (!kl && pool.length > shown.length ? `<button class="add-btn" id="more">Show more</button>` : "") + (!pool.length ? `<div class="empty">Nobody matches.</div>` : "")
        + (d.sample ? `<p class="note muted" style="padding:10px 16px">Placeholder data: run tools\draft\build_prospects.py with a CollegeFootballData key for the real class.</p>` : "");
      $$("[data-prospect]", list).forEach(it => it.onclick = () => { const p = d.players.find(x => x.id === it.dataset.prospect); if (p) prospectCard(p, d); });
      const m = $("#more"); if (m) m.onclick = () => { R.limit += 150; drawClass(); };
    });
  };
  const draw = () => {
    if (R.pos === "DRAFT") return drawDraft();
    if (R.pos === "ROOK") return drawClass();
    let pool;
    const edge = a => gIdx(gradeOf(a, true).g) - gIdx(gradeOf(a).g);      // + = we grade him higher than the market
    if (R.pos === "PICK") pool = [...S.values.picks.values()].sort((a, b) => b.value - a.value);
    else if (R.pos === "EDGE" && dynEdge) pool = S.values.players.filter(a => { const x = dynastyEdge(a); return x && x.kind === R.edge; })
      .sort((a, b) => dynastyEdge(b).score - dynastyEdge(a).score);
    else if (R.pos === "EDGE") pool = S.values.players.filter(a => !a.unranked && a.ours > 0 && (R.edge === "buy" ? edge(a) > 0 : edge(a) < 0))
      .sort((a, b) => Math.abs(edge(b)) - Math.abs(edge(a)) || b.value - a.value);
    else pool = S.values.players.filter(a => !a.unranked && (R.pos === "ALL" || a.pos === R.pos));
    const SP = listPos && R.order === "points" ? Week.season_points(S.values, S.cfg, S.W) : null;
    const WG = listPos && R.order === "proj" ? Week.week_grades(S.values, S.cfg, S.W) : null;
    const spOf = a => (SP && SP[a.sleeper_id]) || null, wgOf = a => (WG && WG[a.sleeper_id]) || null;
    if (listPos) {
      const key = R.order === "points" ? a => (spOf(a) ? spOf(a).pts : -1) : R.order === "proj" ? a => (wgOf(a) ? wgOf(a).pts : -1) : oursOn ? a => (a.orank ?? a.value) : a => a.value;
      pool = pool.slice().sort((x, y) => key(y) - key(x) || y.value - x.value);
    }
    if (R.q) pool = E.search_players(R.q, S.values, 60, pool);
    if (hasLg && R.pos !== "PICK" && R.who !== "all") {
      const me = teamById(S.cfg.my_roster_id);
      pool = pool.filter(a => R.who === "free" ? !owner[a.sleeper_id] : (me && me.players.includes(a.sleeper_id)));
    }
    const shown = pool.slice(0, R.limit);
    $("#rlist").innerHTML = shown.map((a, i) => {
      const free = hasLg && !a.is_pick && !owner[a.sleeper_id];
      if (R.pos === "EDGE" && dynEdge) {
        const x = dynastyEdge(a), k = (n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        return assetRow(a, { rank: i + 1, tag: free ? `<span class="tag-free">Available</span>` : "", sub: `${esc(a.team || "FA")} · ${esc(x.why)}`,
          right: `<div class="gv vs"><span class="vs-l">mkt</span><b>${k(a.omkt)}</b><span class="vs-a">›</span><span class="vs-l">ours</span><b>${k(a.oview || a.omkt)}</b></div>
            <div class="d edge-tag ${x.kind}">${EDGE_KINDS.find(([kk]) => kk === x.kind)[1]}</div>` });
      }
      if (R.pos === "EDGE") {
        const M = gradeOf(a, true), O = gradeOf(a), n = Math.abs(edge(a));
        return assetRow(a, { rank: i + 1, tag: free ? `<span class="tag-free">Available</span>` : "",
          right: `<div class="gv vs"><span class="vs-l">market</span><span class="grade sm ${M.cls}">${esc(M.g)}</span><span class="vs-a">›</span><span class="vs-l">ours</span><span class="grade ${O.cls}">${esc(O.g)}</span></div>
            <div class="d edge-tag ${R.edge}">${n >= 2 ? (R.edge === "buy" ? "Buy" : "Sell") : (R.edge === "buy" ? "Lean buy" : "Lean sell")}</div>` });
      }
      // the number the list is ordered by, where it fits on a phone: season points in place of the value, this week's projection under the week grade
      // Our rank shows its own number, so the numbers run high to low down the list (2026-10-16: McMillan's trade value
      // 6,751 sat under Jonathan Taylor's 5,612)
      const right = SP ? gradeRight(a, { val: spOf(a) ? `${spOf(a).pts.toFixed(1)} pts` : "0 pts" }) : WG ? gradeRight(a, { wk: wgOf(a) ? wgOf(a).pts.toFixed(1) : "bye" })
        : listPos && oursOn && a.orank != null ? gradeRight(a, { val: fmt(a.orank) }) : undefined;
      const extra = SP && spOf(a) && spOf(a).gp ? ` · ${spOf(a).ppg.toFixed(1)} ppg` : "";
      const rk = listPos && (R.order !== "ours" || oursOn) ? i + 1 : R.q || R.who !== "all" ? i + 1 : (R.pos === "ALL" || R.pos === "PICK" ? a.rank || i + 1 : a.pos_rank || i + 1);
      return assetRow(a, { rank: rk, tag: free ? `<span class="tag-free">Available</span>` : "", sub: extra ? `${esc(a.team || "FA")}${extra}` : undefined, right });
    }).join("") + (pool.length > shown.length ? `<button class="add-btn" id="more">Show more</button>` : "") + (!pool.length ? `<div class="empty">${R.pos === "EDGE" ? "No players here: we agree with the market on everyone who matches." : "Nobody matches."}</div>` : "");
    bindCards($("#rlist"));
    const m = $("#more");
    if (m) m.onclick = () => { R.limit += 150; draw(); };
  };
  $$("[data-pos]", el).forEach(b => b.onclick = () => { R.pos = b.dataset.pos; R.limit = 100; renderRank(el); });
  $$("[data-e]", el).forEach(b => b.onclick = () => { R.edge = b.dataset.e; R.limit = 100; renderRank(el); });
  $$("[data-o]", el).forEach(b => b.onclick = () => { R.order = b.dataset.o; R.limit = 100; renderRank(el); });
  $$("[data-rp]", el).forEach(b => b.onclick = () => { R.rpos = b.dataset.rp; R.limit = 100; renderRank(el); });
  $$("[data-who]", el).forEach(b => b.onclick = () => { R.who = R.who === b.dataset.who ? "all" : b.dataset.who; R.limit = 100; renderRank(el); });
  $("#rq").oninput = e => { R.q = e.target.value; R.limit = 100; draw(); };
  draw();
}

// ---------------------------------------------------------------------------
// The rookie class: college prospects for the next draft (tools/draft/build_prospects.py)
// ---------------------------------------------------------------------------
const draftYear = () => parseInt(S.cfg.season, 10) + 1;
const prospectGrade = p => { const g = E.GRADE_CUTS.find(([c]) => p.grade >= c)[1]; return { g, cls: "g" + g[0].toLowerCase() }; };
/* The line under a prospect's name: what he did this college season, by position. */
function prospectStat(p) {
  const s = (p.seasons || [])[0] || {};
  if (p.pos === "QB") return `${fmt(s.passYds || 0)} yds · ${s.passTD || 0} TD · ${s.passInt || 0} INT${s.rushYds >= 150 ? ` · ${fmt(s.rushYds)} rush` : ""}`;
  if (p.pos === "RB") return `${fmt((s.rushYds || 0) + (s.recYds || 0))} scrimmage · ${s.rushTD + s.recTD || 0} TD · ${s.rec || 0} rec`;
  return `${fmt(s.recYds || 0)} yds · ${s.rec || 0} rec · ${s.recTD || 0} TD${p.dom ? ` · ${Math.round(p.dom * 100)}% of team` : ""}`;
}
function prospectRow(p, rank) {
  const G = prospectGrade(p);
  return `<div class="item prow" data-prospect="${esc(p.id)}"><span class="rk">${rank}</span>${badge(p.pos)}
    <div class="nm"><div class="n"><span class="nt">${esc(p.name)}</span>${p.drafted ? `<span class="tag-start">${esc(p.drafted.team)} ${p.drafted.round}.${String(p.drafted.overall).padStart(2, "0")}</span>` : ""}</div>
      <div class="s">${esc(p.school || "")} · ${esc(p.cls || "")}${p.stars ? ` · ${p.stars}★` : ""} · ${prospectStat(p)}</div></div>
    <div class="v"><span class="grade ${G.cls}">${esc(G.g)}</span><div class="d muted">${esc(p.tier)}</div></div></div>`;
}
/* A prospect's card: the grade and its parts, the college seasons, where he'd go in this league's rookie draft. */
function prospectCard(p, d) {
  const G = prospectGrade(p), N = parseInt(S.cfg.league.teams, 10) || 12, rnd = Math.ceil(p.rank / N), slot = ((p.rank - 1) % N) + 1;
  const bar = (l, v) => `<div class="gp"><span>${esc(l)}</span><i><b style="width:${v}%"></b></i></div>`;
  const ht = p.ht ? `${Math.floor(p.ht / 12)}'${Math.round(p.ht % 12)}"` : "";
  const cols = p.pos === "QB" ? [["passYds", "Pass yds"], ["passTD", "TD"], ["passInt", "INT"], ["rushYds", "Rush yds"]] : p.pos === "RB" ? [["car", "Carries"], ["rushYds", "Rush yds"], ["rushTD", "TD"], ["rec", "Rec"], ["recYds", "Rec yds"]] : [["rec", "Rec"], ["recYds", "Yds"], ["recTD", "TD"], ["dom", "Team share"]];
  const seasons = (p.seasons || []).filter(s => cols.some(([k]) => s[k])).map(s => `<tr><td>${s.season}</td>${cols.map(([k]) => `<td class="r">${k === "dom" ? Math.round((s.dom || 0) * 100) + "%" : fmt(s[k] || 0)}</td>`).join("")}</tr>`).join("");
  const mine = !E.is_redraft(S.cfg) && S.cfg.my_roster_id != null ? E.team_assets(S.values, S.cfg, teamById(S.cfg.my_roster_id)).filter(a => a.is_pick && a.pick.season === d.draftYear && a.pick.round === rnd) : [];
  const body = openSheet(`<div class="sheet-head"><span></span><button class="close" aria-label="Close">×</button></div>
    <div class="band ${esc(p.pos)}"><div class="band-top">${avatar({ name: p.name, pos: p.pos, team: "" }, "xl")}<div><div class="band-name">${esc(p.name)}</div><div class="band-bio">${esc(p.school || "")} · ${esc(p.cls || "")}${ht ? ` · ${ht}` : ""}${p.wt ? ` · ${p.wt} lbs` : ""}${p.stars ? ` · ${p.stars}-star recruit` : ""}</div></div></div>
      <div class="band-grade"><span class="big-grade ${G.cls}">${esc(G.g)}</span><div><div class="bg-label">${esc(p.tier)}</div><div class="bg-value">#${p.rank} in the ${d.draftYear} class · ${esc(p.pos)}${p.posRank}</div>
        <div class="bg-scope">${p.drafted ? `Drafted round ${p.drafted.round}, pick ${p.drafted.overall} by ${esc(p.drafted.team)}` : "Grade: dynasty prospect outlook"}</div></div></div>
      <div class="gparts">${Object.entries(p.parts || {}).map(([k, v]) => bar(k, v)).join("")}</div></div>
    ${p.note ? `<p class="note" style="margin-top:12px">${esc(p.note)}</p>` : ""}
    <div class="sec"><h3>Your rookie draft</h3><p class="note">By our grades he goes around the <b>${rnd}.${String(slot).padStart(2, "0")}</b> in a ${N}-team draft${mine.length ? `. You hold ${mine.map(a => esc(a.name.split(" · ")[0] + (a.name.includes("proj.") ? " (" + a.name.split(" · ")[1].split(" (")[0] + ")" : ""))).join(" and ")}` : ""}. Other managers will see it differently; that's where the value is.</p></div>
    ${seasons ? `<div class="sec"><h3>College seasons</h3><div class="tscroll"><table class="t"><tr><th>Season</th>${cols.map(([, l]) => `<th class="r">${l}</th>`).join("")}</tr>${seasons}</table></div></div>` : ""}
    <p class="credit">${esc(d.attribution || "Data provided by CollegeFootballData.com")}.</p>`);
  void body;
}
/* On a pick's card: the prospects our grades put around that slot. */
function pickProspectsHtml(a, d) {
  if (!d || !d.players || !d.players.length) return `<p class="note muted">The ${a.pick.season} class isn't published yet.</p>`;
  if (kitLocked(a.pick.season)) return Pro.kitCard(a.pick.season, `See who our board puts around this pick, with the whole ${a.pick.season} class and the draft helper.`);
  const N = parseInt(S.cfg.league.teams, 10) || 12, rnd = a.pick.round;
  const slot = a.proj_slot ? Math.round(a.proj_slot) : { early: Math.round(N * 0.17), mid: Math.round(N * 0.5), late: Math.round(N * 0.83) }[a.pick.tier] || Math.round(N * 0.5);
  const overall = (rnd - 1) * N + Math.max(1, Math.min(N, slot));
  const near = d.players.filter(p => Math.abs(p.rank - overall) <= 2).sort((x, y) => x.rank - y.rank);
  if (!near.length) return `<p class="note muted">Our board runs out before this pick.</p>`;
  return `<p class="note">Around the ${rnd}.${String(Math.max(1, Math.min(N, slot))).padStart(2, "0")} on our board:</p><div class="list">${near.map(p => prospectRow(p, p.rank)).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Week data (projections, context, stats) shared by My team and the player card
// ---------------------------------------------------------------------------
async function weekData(refresh = false) {
  const key = E.P.id + "|" + S.cfg.season;
  if (!refresh && S.W && S.Wkey === key && Date.now() - S.Wat < 15 * 60000) return S.W;
  if (S.Wloading && !refresh) return S.Wloading;
  S.Wloading = Week.prepare(S.cfg, { refresh }).then(W => { S.W = W; S.Wkey = key; S.Wat = Date.now(); S.Wloading = null; try { Score.snapshot(S.cfg, S.values, W); } catch (e) { /* the scorecard never blocks the screen */ } return W; },
    e => { S.Wloading = null; throw e; });
  return S.Wloading;
}
const loading = txt => `<div class="center"><span class="spin"></span><div>${esc(txt)}</div></div>`;

// ---------------------------------------------------------------------------
// My team tab
// ---------------------------------------------------------------------------
function renderTeam(el) {
  if (!S.cfg) return needLeague(el);
  if (!S.values) return needValues(el);
  if (!teams().length) {
    const lg = S.values.league;
    if (lg && lg.platform === "manual") {
      el.innerHTML = emptyState("Build your team", "Add the players you own and your draft picks. Lineups, pickups, trades and the draft helper work from them.", "Build my team", "buildTeam");
      $("#buildTeam").onclick = () => { const rid = E.manual_add_team(lg, "My team"); S.cfg.my_roster_id = rid; E.save_config(S.cfg); E.manual_save(lg, S.values); S.team.id = rid; rosterBuilder(rid); };
      return;
    }
    el.innerHTML = emptyState("No rosters yet", "Lineup help and pickups need a league from Sleeper, or one you build yourself on the League tab.", null);
    return;
  }
  if (!teamById(S.team.id)) S.team.id = S.cfg.my_roster_id ?? teams()[0].roster_id;
  const bestball = E.is_bestball(S.cfg);                     // best ball sets its own lineup, so no Lineup tab
  if (bestball && S.team.seg === "lineup") S.team.seg = "waivers";
  if (locked()) S.team.seg = "roster";
  const manual = !!(S.values.league && S.values.league.platform === "manual");
  const t = teamById(S.team.id), segs = [["lineup", "Lineup"], ["waivers", "Pickups"], ["trades", "Trades"], ["roster", "Roster"]].filter(([k]) => !(bestball && k === "lineup"));
  el.innerHTML = `<div class="team-bar"><select id="tsel" aria-label="Team">${teams().map(x => `<option value="${x.roster_id}" ${x.roster_id === t.roster_id ? "selected" : ""}>${esc(x.team_name)}${x.roster_id === S.cfg.my_roster_id ? " (you)" : ""}</option>`).join("")}</select>
      <span class="record">${esc(t.record)}</span>${manual ? `<button class="btn ghost sm" id="editRoster">Edit</button>` : ""}</div>
    ${S.cfg.my_roster_id == null ? `<button class="btn soft block" id="setMine">This is my team</button>` : ""}
    <div class="seg" id="tseg">${segs.map(([k, l]) => `<button data-v="${k}" class="${S.team.seg === k ? "on" : ""}" ${locked() && k !== "roster" ? 'data-lock="team"' : ""}>${l}${k !== "roster" ? " " + proTag() : ""}</button>`).join("")}</div>
    <div id="tbody"></div>${credits(E.PLAY ? "Rosters, injuries and trending pickups from Sleeper · Schedule and lines from nflverse (CC BY 4.0) · Weather from the National Weather Service and MET Norway" : "Rosters and trending pickups from Sleeper")}`;
  $("#tsel").onchange = e => { S.team.id = +e.target.value; saveUi(); renderTeam(el); };
  const er = $("#editRoster");
  if (er) er.onclick = () => rosterBuilder(t.roster_id);
  const sm = $("#setMine");
  if (sm) sm.onclick = () => { S.cfg.my_roster_id = t.roster_id; E.save_config(S.cfg); if (!S.sides.A.team) S.sides.A.team = t.roster_id; saveUi(); toast("Saved as your team"); renderTeam(el); };
  $$("#tseg button").forEach(b => b.onclick = () => { S.team.seg = b.dataset.v; renderTeam(el); });
  const body = $("#tbody");
  if (S.team.seg === "roster") return drawRoster(body, t);
  body.innerHTML = loading(E.PLAY ? "Loading…" : "Getting this week's projections…");
  freshRosters().then(() => weekData()).then(W => {
    if (!body.isConnected) return;
    const t2 = teamById(t.roster_id) || t;                                        // the team as just refreshed
    if (S.team.seg === "lineup") drawLineup(body, t2, W); else if (S.team.seg === "trades") drawTrades(body, t2, W); else drawWaivers(body, t2, W);
  }, e => { body.innerHTML = `<div class="empty">Couldn't load this week's data. Check your connection and try again.</div>`; });
}
/* The rosters as Sleeper has them right now: a quiet re-import when the last one is more than a few minutes old, so
   the lineup the manager just set in Sleeper is the lineup the app judges (the user's complaint, 2026-10-13). */
const ROSTERS_FRESH = 3 * 60000;
async function freshRosters(force = false) {
  const lg = S.values && S.values.league;
  if (!lg || !lg.league_id || !navigator.onLine || S.busy) return false;
  const age = lg.imported ? Date.now() - new Date(lg.imported).getTime() : Infinity;
  if (!force && age < ROSTERS_FRESH) return false;
  if (S.rostersLoading) return S.rostersLoading;
  const pid = E.P.id;
  S.rostersLoading = E.sleeper_import(S.cfg, lg.league_id, () => {}, (app().sleeper || {}).user_id)
    .then(() => { if (E.P.id === pid) { S.values = E.load_values(S.cfg); S.W = null; header(); } return true; }, () => false)
    .finally(() => { S.rostersLoading = null; });
  return S.rostersLoading;
}

function drawRoster(body, t) {
  ensureWeek("team");                                                // the past weeks on each row come with the week's data
  const roster = E.team_assets(S.values, S.cfg, t);
  const starters = S.values.league.roster_positions_starters || S.cfg.league.starters;
  const lu = E.best_lineup(roster, starters), st = new Set(lu.starters.filter(([, p]) => p).map(([, p]) => p.id));
  const tot = roster.reduce((s, a) => s + a.value, 0);
  const rank = 1 + teams().filter(x => E.team_assets(S.values, S.cfg, x).reduce((s, a) => s + a.value, 0) > tot).length;
  let h = `<section class="card stat-card tone-orange"><div><div class="big-num">${fmt(tot)}</div><div class="hint">team value</div></div>
    <div><div class="big-num">${E.ordinal(rank)}</div><div class="hint">of ${teams().length} teams</div></div></section>${teamRead(roster, st, rank)}<section class="card flush">`;
  for (const [pos, label] of [["QB", "Quarterbacks"], ["RB", "Running backs"], ["WR", "Wide receivers"], ["TE", "Tight ends"], ["K", "Kickers"], ["DEF", "Defenses"], ["PICK", "Draft picks"]]) {
    const g = roster.filter(a => a.pos === pos);
    if (pos !== "PICK") g.sort((a, b) => b.value - a.value);                        // picks keep Sleeper's order: season, then round
    if (!g.length) continue;
    h += `<div class="grp pos-${pos}">${label}${pos === "PICK" ? `<a class="grp-note lnk" id="toDraft">Draft helper</a>` : S.W && S.W.acc && pos !== "K" && pos !== "DEF" ? PW_LEGEND : ""}</div>` + g.map(a => assetRow(a, { tag: st.has(a.id) ? `<span class="tag-start">Starter</span>` : "", extra: pastWeeks(a) })).join("");
  }
  body.innerHTML = h + `</section>`;
  bindCards(body);
  const td = $("#toDraft", body);
  if (td) td.onclick = () => { S.rank.pos = "DRAFT"; go("rank"); };
}

/* Our read of a team (Pro): built to win now, or for later? From our grades and the ages of the starters, plus the
   players on the roster the market has wrong. */
function teamRead(roster, st, rank) {
  const n = teams().length || 12, rd = E.is_redraft(S.cfg);
  if (locked()) return `<section class="card"><h2>Team read ${Pro.tag()}</h2><div class="hint">Contender or rebuilding? Which players to sell before the cliff, and which ones the market undervalues.</div>
      <button class="btn soft block" data-lock="ourgrade" style="margin-top:12px">Show me with Pro</button></section>`;
  const pl = roster.filter(a => !a.is_pick && a.oscore != null);
  if (pl.length < 5) return "";
  const stars = pl.filter(a => st.has(a.id)), core = stars.length >= 4 ? stars : pl.slice().sort((a, b) => b.value - a.value).slice(0, 8);
  const mean = (l, f) => l.reduce((s, a) => s + f(a), 0) / Math.max(1, l.length);
  const score = mean(core, a => a.oscore), aged = core.filter(a => a.age != null), age = mean(aged, a => a.age);
  const g = E.GRADE_CUTS.find(([c]) => score >= c)[1], ageTxt = age.toFixed(1);
  const step = a => gIdx(gradeOf(a, true).g) - gIdx(gradeOf(a).g);
  const sells = pl.filter(a => step(a) <= -2 && gIdx(gradeOf(a, true).g) <= gIdx("C+")).sort((a, b) => b.value - a.value);   // the market has him at C+ or better
  const holds = pl.filter(a => step(a) >= 2 && gIdx(gradeOf(a).g) <= gIdx("B-")).sort((a, b) => b.value - a.value);          // we have him at B- or better
  const toCliff = mean(aged, a => (E.AGE_CLIFF[a.pos] || 99) - a.age);            // years the core has left before its cliffs, on average (the user's age model)
  const top = rank <= Math.ceil(n / 3), bottom = rank > n - Math.ceil(n / 3), strong = score >= 72, young = age < 26.5, old = aged.length > 0 && toCliff <= 2.5;
  let title, text;
  if (rd) { title = top ? "Contender" : bottom ? "Long shot" : "In the hunt"; text = `The starters grade ${g} on average for this season. In redraft, most points wins: play the hot hand and use the waiver wire.`; }
  else if (top && strong && !old) { title = "Contender"; text = `The starters grade ${g} on average and are ${ageTxt} years old on average. Built to win now and later. Don't pay for picks; use them to buy players who help this year.`; }
  else if (top && old) { title = "Win now"; text = `Built to win this year, but the core is ${ageTxt} years old on average. Cash in the older names before the cliff, while they still bring a lot.`; }
  else if (top) { title = "Win now"; text = `Near the top by value, but our grades (${g} on average) say the starters won't hold it long. Sell high where you can.`; }
  else if (bottom && young) { title = "Rising"; text = `The starters are young (${ageTxt} on average) and grade ${g}. A year or two away: keep the young talent, buy more of it, and don't chase this season.`; }
  else if (bottom) { title = "Rebuilding"; text = `Low on value, with starters ${ageTxt} years old on average. Trade the veterans for picks and players under 25.`; }
  else if (strong) { title = "Rising"; text = `Middle of the pack by value, but our grades (${g} on average) like where the starters are going.`; }
  else { title = "In between"; text = `Middle of the pack, and our grades (${g} on average) say the starters are about what they look like. Pick a direction: consolidate for a run, or sell the older names and get younger.`; }
  const row = a => `<div class="kv"><span>${plinkName(a.name)} <span class="muted">${esc(a.pos)} · ${a.age != null ? Math.floor(a.age) : ""}</span></span><b>ours ${esc(gradeOf(a).g)} · market ${esc(gradeOf(a, true).g)}</b></div>`;
  let extra = "";
  if (sells.length) extra += `<div class="sub-h">The market has these higher than we do${rd ? "" : ": sell candidates"}</div>` + sells.slice(0, 4).map(row).join("");
  if (holds.length) extra += `<div class="sub-h">The market has these lower than we do${rd ? "" : ": hold, or buy more"}</div>` + holds.slice(0, 4).map(row).join("");
  return `<section class="card tone-orange"><h2>Team read: ${esc(title)}</h2><p class="note">${text}</p>${extra}</section>`;
}

function drawLineup(body, t, W) {
  const L = W.valuesOnly ? Week.lineup_by_value(S.values, S.cfg, t, W) : Week.lineup_helper(S.values, S.cfg, t, W);
  if (!W.valuesOnly && t.roster_id === S.cfg.my_roster_id) { try { Score.saveLineup(S.cfg, W, t.roster_id, L); } catch (e) { /* never blocks */ } }   // the scorecard keeps the call
  const num = x => W.valuesOnly ? fmt(x) : x.toFixed(1);
  const starts = L.changes.filter(c => c.action === "start"), benches = L.changes.filter(c => c.action === "bench");
  const better = L.gain > (W.valuesOnly ? 1 : 0.05);
  let h = `<div id="liveCard"></div><section class="card stat-card tone-blue"><div><div class="big-num">${num(L.rec_total)}</div><div class="hint">${W.valuesOnly ? "best lineup value" : `projected points, week ${L.week}`}</div></div>
    ${L.has_current ? `<div><div class="big-num ${better ? "good" : ""}">${better ? "+" + num(L.gain) : "✓"}</div><div class="hint">${better ? "if you make the changes" : "lineup is set"}</div></div>` : ""}</section>`;
  if (W.valuesOnly) {                                            // no projections this week: the lineup is shown by value, but no changes are called (no advice beats bad advice)
    h += `<section class="card tone-green set-card"><b>No projections for this week yet.</b> The lineup below is by value; no changes are suggested until the week's numbers are in.</section>`;
  } else if (L.has_current && L.changes.length) {                // one line a swap: who comes in, who sits, the points of each
    const lone = benches.filter(c => !starts.some(s => s.instead && s.instead.name === c.name) && (starts.some(s => s.instead !== undefined) || benches.indexOf(c) >= starts.length));
    h += `<section class="card tone-green"><h2>Changes to make</h2><div class="list">
      ${starts.map((c, i) => { const b = c.instead !== undefined ? c.instead : benches[i]; return `<div class="swap"><span class="swap-tag in">Start</span><div class="swap-who"><b>${plinkName(c.name)}</b>${c.flag ? `<span class="flag ${esc(c.flag)}">${esc(c.flag)}</span>` : ""}${b ? `<div class="s">over ${plinkName(b.name)}${b.flag ? ` <span class="muted">${esc(b.flag.toLowerCase())}</span>` : ""}</div>` : ""}</div>
        ${W.valuesOnly ? "" : `<div class="swap-pts"><b>${num(c.pts)}</b>${b ? `<small>${num(b.pts)}</small>` : ""}</div>`}</div>`; }).join("")}
      ${lone.map(c => `<div class="swap"><span class="swap-tag out">Bench</span><div class="swap-who"><b>${plinkName(c.name)}</b>${c.flag ? ` <span class="muted">${esc(c.flag.toLowerCase())}</span>` : ""}</div></div>`).join("")}</div>
      <p class="hint" style="margin-top:8px">Your top players stay in unless the other man is clearly better this week.</p></section>`;
  } else if (L.has_current) {
    h += `<section class="card tone-green set-card"><b>Lineup is set.</b> Your top players are in and nobody on the bench is clearly better this week.</section>`;
  }
  const warn = L.flags.filter(f => / is empty$/.test(f));            // OUT / BYE / Q already show as tags on the players
  if (warn.length) h += `<p class="note warn">${warn.map(esc).join("<br>")}</p>`;
  const WG = W.valuesOnly ? {} : Week.week_grades(S.values, S.cfg, W), wgOf = x => { const a = x.id && S.values.by_id[x.id]; return a ? WG[a.sleeper_id] : x.pid ? WG[String(x.pid)] : null; };   // kickers and defenses carry their id as pid
  h += `<section class="card flush tone-blue"><div class="grp">Best lineup${Object.keys(WG).length ? `<span class="grp-note">this week's grade</span>` : ""}</div>${W.acc && W.week >= 2 ? `<div class="pw-legend">Right: this week's grade and projection. Under each player: last week's grade, what we said he'd score and what he got (green: he beat it).</div>` : ""}${L.recommended.map(x => { const g = wgOf(x); return `<div class="item" data-card-name="${esc(x.id || "")}">
      <span class="slot ${esc(slotClass(x.slot))}">${esc(SLOT_LABEL(x.slot))}</span><div class="nm"><div class="n">${x.name === "(empty)" || x.pos === "DEF" ? esc(x.name) : `<a class="plink" data-pcard="${esc(x.id || x.pid || x.name)}">${esc(x.name)}</a>`}${x.flag ? `<span class="flag ${esc(x.flag)}">${esc(x.flag)}</span>` : ""}</div>
      <div class="s">${esc(x.opp ? (x.opp.startsWith("@") ? "at " + x.opp.slice(1) : "vs " + x.opp) : "")}</div>${lastWeekLine(x.id && S.values.by_id[x.id], W)}</div><div class="v lw-now"><small>This wk</small><div>${g ? `<span class="grade sm ${g.cls}">${esc(g.letter)}</span> ` : ""}<b>${num(x.pts)}</b></div></div></div>`; }).join("")}</section>`;
  const extra = L.notes.map(n => `<p class="note">${esc(n)}</p>`).join("") +
    (L.def_options && L.def_options.length ? `<div class="sub-h">Defenses you could pick up</div>` + L.def_options.map(d => `<div class="kv"><span>${esc(d.team)} ${d.home === false ? "at" : "vs"} ${esc(d.opp || "?")}</span><b>${d.adj.toFixed(1)}</b></div>`).join("") : "") +
    (W.valuesOnly ? `<p class="note muted">Starters are picked by each player's value for this season, and players listed as out are skipped. After changing your lineup in Sleeper, tap Refresh rosters on the League tab.</p>`
      : W.ours ? `<p class="note muted">Points are Dynasty Mover's own projections: each player's scoring this season and last, adjusted for home or away, the Vegas line, the weather at kickoff and his team's recent form. Schedule and lines from nflverse (CC BY 4.0); weather from the National Weather Service, and from MET Norway for games abroad.${W.kdef ? " Kicker and defense points from nflverse stats on Sleeper's default scoring; a defense is also rated on its opponent's offense and the Vegas line." : ""}</p>`
      : `<p class="note muted">Points are Sleeper's projections, adjusted for the matchup, weather, betting lines and recent form.</p>`);
  const lgi = S.values.league && S.values.league.imported ? ago(S.values.league.imported) : null;
  h += `<section class="card">${more("How this works", extra)}${W.valuesOnly ? "" : `<button class="btn ghost block" id="wref" style="margin-top:12px">Refresh rosters and projections</button>${lgi ? `<div class="hint" style="text-align:center;margin-top:6px">Rosters from Sleeper ${esc(lgi)}</div>` : ""}`}</section>`;
  body.innerHTML = h;
  liveCard(body, t, W);
  $$("[data-card-name]", body).forEach(it => it.onclick = () => { const a = S.values.by_id[it.dataset.cardName]; if (a) card(a); });
  if ($("#wref")) $("#wref").onclick = () => { body.innerHTML = loading("Refreshing rosters and projections…"); freshRosters(true).then(() => weekData(true)).then(W2 => drawLineup(body, teamById(t.roster_id) || t, W2), e => toast("Couldn't refresh. Check your connection.")); };
}

/* The colour of a lineup slot: the position's own, flex slots their own. */
const slotClass = s => { const u = String(s || "").toUpperCase(); return ["QB", "RB", "WR", "TE", "K", "DEF"].includes(u) ? u : /SUPER|^SF$/.test(u) ? "SF" : "FLEX"; };
/* A pickup's case in plain words, from the same numbers the score uses. */
function whyPlain(parts, a, fallback = "better long-term value") {
  const q = parts(a), bits = [], pts = n => { const r = Math.round(n); return `${r} pt${r === 1 ? "" : "s"}`; };
  if (q.last2 !== null && q.last2 >= 0.5) bits.push(`${pts(q.last2)} a game lately`);
  else if (q.ppg !== null && q.ppg >= 0.5) bits.push(`${pts(q.ppg)} a game`);
  if (q.proj && q.proj >= 0.5) bits.push(`${pts(q.proj)} projected this week`);
  else if (q.bye) bits.push("on bye this week");
  if ((q.gp || 0) === 0 && S.W && S.W.week >= 2) bits.unshift("no games yet");          // say so when a suggestion rests on a projection alone
  if (q.inj === "Questionable") bits.push("questionable");
  const tr = a.trend48 || {};
  if ((tr.adds || 0) > 1000 && (tr.adds || 0) > (tr.drops || 0)) bits.push("popular pickup");
  if (!E.is_redraft(S.cfg) && a.age != null && a.age <= 24) bits.push(`young (age ${Math.floor(a.age)})`);
  if (a.trend && a.trend >= 100) bits.push("value rising");
  if (epGap(a) >= 2) bits.push("usage says more points are coming");
  if (q.inj === "Questionable") { bits.splice(bits.indexOf("questionable"), 1); bits.push("questionable"); }   // a note, never the headline
  if (bits.length === 1 && bits[0] === "questionable") bits.unshift(fallback);
  return bits.join(" · ") || fallback;
}

/* Weak spots: the team's D and F players, each with the best free agent at the same position who grades better
   (and a bid in FAAB leagues), or "hold" when nobody better is out there. */
const gIdx = g => { const i = GRADES.findIndex(G => G[1] === g); return i < 0 ? GRADES.length : i; };   // 0 = A+
/* Players the app may suggest adding: not on the user's "don't suggest" list, not out / on IR / suspended / not
   reported (Sleeper's injury status), active, and not buried on the depth chart. Value alone isn't enough: a player
   can keep dynasty value while he isn't playing at all. */
const DEPTH_MAX = E.DMV_DEPTH_MAX;                       // the engine's table
const avoidList = () => app().avoid || [];
function suggestable(a) {
  if (avoidList().includes(a.id)) return false;
  if (!a.sleeper_id) return false;                              // Sleeper can't confirm who he is (or whether he's rostered)
  const st = E.load_player_status()[String(a.sleeper_id || "")] || {};
  if (st.inj && st.inj !== "Doubtful" && Week.INJURY_OUT.has(st.inj)) return false;
  if (st.status && st.status !== "Active") return false;
  if (st.depth != null && st.depth > (DEPTH_MAX[a.pos] || 3)) return false;
  return true;
}
function weakSpots(t, fas, W, M) {
  const roster = E.team_assets(S.values, S.cfg, t);
  const [wmetric, , parts] = M || Week.waiver_metric(S.values, S.cfg, W);
  const lu = E.best_lineup(roster, S.values.league.roster_positions_starters || S.cfg.league.starters);
  const st = new Set(lu.starters.filter(([, p]) => p).map(([, p]) => p.id));
  const weak = roster.filter(a => !a.is_pick && ["QB", "RB", "WR", "TE"].includes(a.pos) && /^[DF]/.test(gradeOf(a).g)).sort((a, b) => a.value - b.value).slice(0, 6);
  if (!weak.length) return "";
  const pool = fas.filter(a => ["QB", "RB", "WR", "TE"].includes(a.pos)).sort((a, b) => b.value - a.value), used = new Set();
  const lg = S.values.league, faab = parseInt(lg.waiver_type || 0) === 2 && parseInt(lg.waiver_budget || 0) > 0;
  const rows = weak.map(a => {
    const r = pool.find(x => x.pos === a.pos && !used.has(x.id) && x.value > a.value * 1.15 && gIdx(gradeOf(x).g) < gIdx(gradeOf(a).g) && !Week.pickup_guard(x, a, parts(x), parts(a), wmetric, S.cfg));
    if (r) used.add(r.id);
    const bid = r && faab ? Week.faab_bid({ gain: r.value - a.value, add_m: r.value, lineup_gain: st.has(a.id) ? 1 : 0, add: r, group: r.pos },
      parseInt(lg.waiver_budget), lg.waiver_bid_min != null ? parseInt(lg.waiver_bid_min) : 0, S.cfg, W && W.week, parts(r)).faab : null;
    const subTxt = r ? `Swap for <b>${plink(r)}</b> ${gradeChip(r, false)}` : `No better free agent at ${esc(a.pos)}. Hold for now.`;
    return assetRow(a, { tag: `${gradeChip(a, false)}${st.has(a.id) ? `<span class="tag-start">Starter</span>` : ""}`, sub: subTxt,
      right: bid != null ? `<span class="bid-chip">$${bid}<small>bid</small></span>` : (r ? `<span class="tag-free">Upgrade</span>` : `<span class="muted s">Hold</span>`), extra: pastWeeks(a) });
  }).join("");
  return `<section class="card"><h2>Weak spots</h2><div class="hint">Your D and F players, and the best free agent to replace each one.</div><div class="list">${rows}</div></section>`;
}

/* Trade ideas for the team, from Week.trade_targets: the team's situation, then buy / sell / fit ideas with a package
   of about even value. "Open in trade" fills in the Trade tab so the verdict bar can grade it. */
function drawTrades(body, t, W) {
  const T = Week.trade_targets(S.values, S.cfg, t, W && W.week);
  if (!T.me) { body.innerHTML = `<div class="empty">No roster found for this team.</div>`; return; }
  const me = T.me, tm = T.timing;
  const rdNeed = (me.deep || []).length && (me.thin || []).length ? `Offer your depth at ${me.deep.join("/")} for help at ${me.thin.join("/")}.` : "Trade need for need with a team whose roster is the mirror of yours.";
  const DIR = E.is_redraft(S.cfg)                            // redraft: this season's points, nothing to rebuild toward
    ? [me.standing >= 0.58 ? "Contending" : me.standing <= 0.4 ? "Long shot" : "In the hunt", `Redraft is about this season's points. ${rdNeed}`]
    : { contend: ["Contending", "You're near the top. Buy proven players from teams at the bottom."],
    rebuild: ["Rebuilding", "You're near the bottom. Sell older starters to contenders for young players and picks."],
    either: ["In the middle", "Look for swaps that fix a thin spot, or buy low from teams that are struggling."] }[me.direction];
  let when;
  if (tm.left != null) when = tm.left <= 2 ? `<b>${tm.left} ${tm.left === 1 ? "week" : "weeks"} to the trade deadline</b> (week ${tm.deadline}). Sellers are most motivated now.`
    : `<b>${tm.left} weeks to the trade deadline</b> (week ${tm.deadline}).`;
  else if (tm.playoffs) when = `Playoffs start week ${tm.playoffs}.`;
  if (tm.week && tm.week <= 3) when = (when ? when + " " : "") + "Records are still early, so struggling teams may not be selling yet.";
  else if (tm.week && tm.week <= 9) when = (when ? when + " " : "") + "Teams that start slow usually start listening around now.";
  const chip = (txt, cls) => `<span class="ti-chip ${cls}">${esc(txt)}</span>`;
  let h = `<section class="card ti-head tone-purple"><div class="kicker">Your situation</div>
      <div class="ti-rec"><b>${esc(me.record)}</b><span>${E.ordinal(me.place)} of ${me.teams}</span>${chip(DIR[0], "dir-" + me.direction)}</div>
      ${(() => { const P = E.project_standings(S.values, S.cfg), my = P && P.by[t.roster_id]; if (!my || !P.weeks_left) return "";
        const own = E.team_assets(S.values, S.cfg, t).find(a => a.is_pick && a.pick.round === 1 && a.original === t.roster_id && a.proj_slot);
        return `<p class="note ti-proj">Projected: <b>${my.wins.toFixed(1)} wins</b> · <b>${Math.round(my.playoff * 100)}%</b> playoff odds${own ? ` · your ${esc(own.name.split(" · ")[0])} projects to <b>${esc((own.name.split(" · ")[1] || "").replace(/^proj\. /, ""))}</b>` : ""}</p>`; })()}
      <div class="ti-chips">${me.thin.map(p => chip("Thin at " + p, "thin")).join("")}${me.deep.map(p => chip("Deep at " + p, "deep")).join("")}</div>
      <p class="note">${DIR[1]}</p>${when ? `<p class="note muted">${when}</p>` : ""}</section>`;
  if (!T.ideas.length) h += `<section class="card"><div class="empty">No clear trade ideas right now. Check back after the next games.</div></section>`;
  const KIND = { buy: "Buy", sell: "Sell", fit: "Good fit", buylow: "Buy low", sellhigh: "Sell high", injury: "Injury buy", consolidate: "2-for-1", market: "League market" };
  const mini = a => `<div class="mini" data-card="${esc(a.id)}">${avatar(a)}<div class="mini-t"><b>${esc(a.name)}</b><span>${gradeChip(a, false)} ${fmt(a.value)}</span></div></div>`;
  T.ideas.forEach((x, i) => {
    h += `<section class="card idea tone-purple">
      <div class="idea-top"><span class="idea-kind k-${x.kind}">${KIND[x.kind]}</span><b class="idea-team">${esc(x.team.team_name)}</b><span class="muted">${esc(x.team.record || "")}</span></div>
      <div class="idea-cols"><div><div class="sub-h">You get</div>${x.get.map(mini).join("")}</div><div><div class="sub-h">You give</div>${x.give.map(mini).join("")}</div></div>
      <ul class="idea-why">${x.why.map(w => `<li>${linkify(w, x.get.concat(x.give))}</li>`).join("")}</ul>
      <button class="btn soft block" data-idea="${i}">Open in trade</button></section>`;
  });
  body.innerHTML = h;                                        // the My team screen adds the credits below
  $$("[data-idea]", body).forEach(b => b.onclick = () => {
    const x = T.ideas[+b.dataset.idea];
    S.sides.A = { team: t.roster_id, mode: S.sides.A.mode || "neutral", items: x.give.map(a => itemFor(a, a.id)) };
    S.sides.B = { team: x.team.roster_id, mode: "neutral", items: x.get.map(a => itemFor(a, a.id)) };
    S.result = null; saveUi(); go("trade");
  });
  $$("[data-card]", body).forEach(m => m.onclick = () => { const a = x_asset(m.dataset.card); if (a) card(a); });
}
const x_asset = id => { const m = E.find_asset(id, S.values, S.cfg); return m.error ? null : m.asset; };

/* "Should I make this move?": pick a drop from the roster and an add from the free agents; Week.waiver_check judges it.
   The choice is kept per team in S.wc, so the card survives redraws (and player cards can fill it in). */
function waiverCheckCard(t, fas, W, M) {
  const wc = S.wc && S.wc.team === t.roster_id ? S.wc : (S.wc = { team: t.roster_id, drop: null, add: null });
  const roster = E.team_assets(S.values, S.cfg, t).filter(a => !a.is_pick);
  const drop = wc.drop && roster.find(a => a.id === wc.drop), add = wc.add && (wcFreePool(fas).find(a => a.id === wc.add) || null);
  const slot = (kind, a) => `<button class="wc-slot" data-wc="${kind}"><span class="wc-lbl">${kind === "drop" ? "Drop" : "Add"}</span>${a
    ? `<span class="wc-who">${avatar(a)}<span class="wc-name"><b class="plink" data-pcard="${esc(a.id)}">${esc(a.name)}</b><span>${gradeChip(a, false)} ${fmt(a.value)}</span></span></span>` : `<span class="wc-empty">Choose a player</span>`}</button>`;
  let res = "";
  if (drop && add) {
    const unavailable = !suggestable(add) && !avoidList().includes(add.id) ? `${add.name} isn't playing much right now (injury, suspension or deep on the depth chart).` : null;
    const r = Week.waiver_check(S.values, S.cfg, t, drop, add, W, { metric: M, unavailable });
    res = `<div class="wc-res tone-${r.tone}"><div class="wc-verdict">${esc(r.verdict)}${r.faab != null ? `<span class="bid-chip">$${r.faab}<small>bid</small></span>` : ""}</div>
      <ul class="wc-why">${r.reasons.map(x => `<li>${linkify(x, [add, drop])}</li>`).join("")}</ul></div>`;
  } else if (wc.add && !add) res = `<p class="note warn">That player isn't a free agent in this league anymore.</p>`;
  return `<section class="card wc" id="wcCard"><h2>Should I make this move?</h2><div class="hint">Pick a player to drop and one to add.</div>
    <div class="wc-pair">${slot("drop", drop)}<span class="wc-arrow" aria-hidden="true">→</span>${slot("add", add)}</div>${res}
    ${drop || add ? `<button class="link-btn" id="wcClear" style="display:block;margin:8px auto 0">Clear</button>` : ""}</section>`;
}
/* Every unrostered player, including ones no value list ranks (a hot hand can have no dynasty value at all). */
function wcFreePool(fas) {
  const rostered = new Set(S.values.league.teams.flatMap(t => t.players.map(String)));
  const seen = new Set(fas.map(a => a.id));
  return fas.concat(S.values.players.filter(a => a.sleeper_id && !rostered.has(String(a.sleeper_id)) && !seen.has(a.id) && ["QB", "RB", "WR", "TE"].includes(a.pos)));
}
function bindWaiverCheck(body, t, fas, W, M) {
  const redraw = () => drawWaivers(body, t, W);
  $$("[data-wc]", body).forEach(b => b.onclick = () => b.dataset.wc === "drop" ? wcPickDrop(t, redraw, M, W) : wcPickAdd(fas, redraw, M, W));
  const c = $("#wcClear", body);
  if (c) c.onclick = () => { S.wc = { team: t.roster_id, drop: null, add: null }; redraw(); };
}
/* The pickers sort by the same measure the pickup board uses (this season's points and this week's projection in
   redraft; value plus production in dynasty): the best available first, the least useful of yours first. */
function wcPickDrop(t, done, M, W) {
  const [metric, , parts] = M || Week.waiver_metric(S.values, S.cfg, W);
  const roster = E.team_assets(S.values, S.cfg, t).filter(a => !a.is_pick).sort((a, b) => metric(a) - metric(b));
  const body = openSheet(`<div class="sheet-head"><h2>Who would you drop?</h2><button class="close" aria-label="Close">×</button></div>
    <div class="hint">Least useful to you first. Tap a row to choose him, tap the name to see his card.</div><div class="list">${roster.map(a => assetRow(a, { act: "pick", nameLink: true, sub: `${esc(a.team || "FA")} · ${esc(whyPlain(parts, a, "little production"))}` })).join("")}</div>`, { full: true });
  wcReturn(() => wcPickDrop(t, done, M, W));
  $(".close", body).onclick = closeSheet;
  $$(".item", body).forEach(it => it.onclick = () => { S.wc.drop = it.dataset.id; closeSheet(); done(); });
}
/* After a card opened from a picker closes, bring the picker back, unless the card's buttons moved the user on
   (added to a trade, started a waiver check, asked the GM). Checked a tick later so those handlers have run. */
function wcReturn(reopen) {
  const add = S.wc && S.wc.add, drop = S.wc && S.wc.drop, seg = S.team.seg;
  S.sheetReturn = () => setTimeout(() => { if (S.tab === "team" && S.team.seg === seg && !sheetOpen() && S.wc && S.wc.add === add && S.wc.drop === drop) reopen(); }, 0);
}
function wcPickAdd(fas, done, M, W) {
  const [metric, , parts] = M || Week.waiver_metric(S.values, S.cfg, W);
  let wpos = "ALL";
  const body = openSheet(`<div class="sheet-head"><h2>Who would you add?</h2><button class="close" aria-label="Close">×</button></div>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <input type="search" id="wq" placeholder="Search free agents" autocomplete="off"></div>
    <div class="seg" id="wseg">${["ALL", "QB", "RB", "WR", "TE"].map(p => `<button data-wp="${p}" class="${p === "ALL" ? "on" : ""}">${p === "ALL" ? "All" : p}</button>`).join("")}</div>
    <div class="hint" style="margin:8px 2px 4px">Best available first: ${esc(E.is_redraft(S.cfg) ? "this season's points and this week's projection" : "value and this season's production")}. Players who aren't playing are at the bottom. Tap a row to choose him, tap the name to see his card.</div>
    <div id="wres" class="list"></div>`, { full: true, focus: "#wq" });
  wcReturn(() => wcPickAdd(fas, done, M, W));
  $(".close", body).onclick = closeSheet;
  // the pickup board's measure, the playing players first; anyone not playing (hurt, suspended, buried) sinks to the bottom
  const pool = wcFreePool(fas).filter(a => ["QB", "RB", "WR", "TE"].includes(a.pos))
    .map(a => ({ a, m: metric(a), ok: suggestable(a) })).sort((x, y) => (y.ok - x.ok) || (y.m - x.m) || (y.a.value - x.a.value));
  const draw = () => {
    const q = E.norm ? E.norm($("#wq", body).value) : $("#wq", body).value.toLowerCase().replace(/[^a-z]/g, "");
    let rows = pool.filter(x => wpos === "ALL" || x.a.pos === wpos);
    if (q) rows = rows.filter(x => (E.norm ? E.norm(x.a.name) : x.a.name.toLowerCase().replace(/[^a-z]/g, "")).includes(q));
    rows = rows.slice(0, 50);
    $("#wres", body).innerHTML = rows.length ? rows.map(x => assetRow(x.a, { act: "pick", nameLink: true, sub: `${esc(x.a.team || "FA")} · ${esc(whyPlain(parts, x.a, "not playing much yet"))}${x.ok ? "" : " · not playing"}` })).join("") : `<div class="empty">No free agent by that name.</div>`;
    $$(".item", body).forEach(it => it.onclick = () => { S.wc.add = it.dataset.id; closeSheet(); done(); });
  };
  $$("[data-wp]", body).forEach(b => b.onclick = () => { wpos = b.dataset.wp; $$("[data-wp]", body).forEach(x => x.classList.toggle("on", x === b)); draw(); });
  $("#wq", body).oninput = draw;
  draw();
}

function drawWaivers(body, t, W) {
  const fas = Week.free_agents(S.values, S.cfg, W).filter(suggestable);
  const M = Week.waiver_metric(S.values, S.cfg, W);
  const [metric, , parts] = M;
  const hasDef = Week.kdef_ready(W) && (S.values.league.roster_positions || []).includes("DEF");
  const defenses = hasDef ? Week.defense_streamers(S.values, S.cfg, W) : [];
  const moves = Week.roster_moves(S.values, S.cfg, t, W, { n: 6, per_group: 2, fas, metric: M, defenses });
  let h = waiverCheckCard(t, fas, W, M) + weakSpots(t, fas, W, M);
  h += `<section class="card tone-green"><h2>Suggested pickups</h2>`;
  h += moves.length ? `<div class="list">${moves.map(m => `<div class="move" data-card="${esc(m.add.id)}">
      <div class="move-main">${badge(m.add.pos)}<div class="nm"><div class="n">Add ${esc(m.add.name)}</div>
        <div class="s">${m.drop ? "Drop " + plink(m.drop) : "Open roster spot"}</div></div>
        ${m.faab != null ? `<span class="bid-chip">$${m.faab}<small>bid</small></span>` : `<span class="tag-free">Upgrade</span>`}</div>
      <div class="s why">${esc(m.plain || (m.group === "DEF" ? "better matchup this week" : whyPlain(parts, m.add)))}</div>${pastWeeks(m.add)}</div>`).join("")}</div>`
    : `<div class="empty">No clear upgrades right now. Check back after the next games.</div>`;
  h += `</section>`;
  let board = "";
  for (const [grp, rows] of Week.free_agent_board(S.values, S.cfg, fas, metric, parts, 5)) {
    if (!rows.length) continue;
    board += `<div class="grp">${esc(grp)}${W.acc ? PW_LEGEND : ""}</div>` + rows.map(a => assetRow(a, { sub: esc(whyPlain(parts, a, "not playing much yet")), extra: pastWeeks(a) })).join("");
  }
  if (board) h += `<section class="card">${more("Best available players", `<div class="list">${board}</div>`)}</section>`;
  if (defenses.length) h += `<section class="card">${more(`Best defenses for week ${defenses[0].week}`, defenses.slice(0, 8).map(d => `<div class="kv"><span><b>${esc(d.team)}</b> ${d.home === false ? "at" : "vs"} ${esc(d.opp || "?")}${d.owner ? "" : ' <span class="tag-free">Available</span>'}</span><b>${d.adj.toFixed(1)}</b></div>`).join(""))}</section>`;
  body.innerHTML = h;
  bindCards(body);
  $$("[data-card]", body).forEach(b => b.onclick = () => { const a = S.values.by_id[b.dataset.card] || fas.find(x => x.id === b.dataset.card); if (a) card(a); });
  bindWaiverCheck(body, t, fas, W, M);
}

// ---------------------------------------------------------------------------
// Player card
// ---------------------------------------------------------------------------
function bindCards(root) {
  $$(".item[data-act='card']", root).forEach(it => it.onclick = e => {
    if (e.target.closest("[data-x]")) return;
    const a = S.values.by_id[it.dataset.id] || E.find_asset(it.dataset.id, S.values, S.cfg).asset;
    if (a && a.pos === "DEF") return;                                                 // a defense has no player card
    if (a) card(a);
  });
}

function sparkline(series) {
  if (series.length < 2) return `<p class="note muted">The chart fills in as you update values over the coming weeks.</p>`;
  const W = 320, H = 90, pad = 4, vals = series.map(([, v]) => v), lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(1, hi - lo);
  const x = i => pad + i / (series.length - 1) * (W - 2 * pad), y = v => H - pad - (v - lo) / span * (H - 2 * pad);
  const pts = series.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
    <div class="spark-x"><span>${esc(series[0][0].slice(5))}</span><span>${esc(series[series.length - 1][0].slice(5))}</span></div>`;
}

/* News & status for the player card: Sleeper's documented player record (injury, practice, depth chart, bio), plus
   recent headlines in the personal edition. */
const inchesToFt = h => { const n = parseInt(h); return n > 0 ? `${Math.floor(n / 12)}'${n % 12}"` : ""; };
/* Header bits from Sleeper's player record: depth chart for the position chip, a health chip, and a one-line bio. */
function headerInfo(a, p) {
  if (!p) return null;
  const st = E.load_player_status()[String(a.sleeper_id || "")] || {};
  const inj = st.report || "sl_inj" in st ? st.inj : p.injury_status;      // the NFL's injury report when it's newer or more serious
  const body = (st.report && st.report.injury) || p.injury_body_part;
  const health = inj ? `<span class="chip alert">${esc(inj)}${body ? " · " + esc(body) : ""}</span>`
    : (p.status && p.status !== "Active" ? `<span class="chip amber">${esc(p.status)}</span>` : `<span class="chip ok">Healthy</span>`);
  const slot = ["LWR", "RWR", "SWR"].includes(p.depth_chart_position) ? "WR" : (p.depth_chart_position || a.pos);   // Sleeper numbers receivers as one list
  const depth = p.depth_chart_order ? slot + p.depth_chart_order : a.pos;
  const bio = [p.number ? "#" + p.number : "", inchesToFt(p.height), p.weight ? p.weight + " lb" : "", p.college || "",
    p.years_exp === 0 ? "Rookie" : (p.years_exp ? plural(p.years_exp, "year") + " in NFL" : "")].filter(Boolean).join(" · ");
  return { pos: `${esc(depth)} · ${esc(a.team || "FA")}`, health, bio: esc(bio), team: a.team && a.team !== "FA" ? a.team : null };
}
/* Only what's worth reading below the header: injury notes, since when, and the practice report. */
function injuryDetails(p, a) {
  if (!p) return "";
  const rows = [];
  // the NFL's official injury report for this week (nflverse), checked every few hours
  const R = a ? (E.load_player_status()[String(a.sleeper_id || "")] || {}).report : null;
  if (R && (R.status || R.practice)) rows.push(`<div class="kv"><span>Official report, week ${R.week}</span><b>${esc([R.status || "No game status", R.injury].filter(Boolean).join(" · "))}</b></div>`
    + (R.practice ? `<div class="kv"><span>Practice</span><b>${esc(R.practice)}</b></div>` : ""));
  if (p.injury_notes) rows.push(`<p class="note">${esc(p.injury_notes)}</p>`);
  if (p.injury_start_date) rows.push(`<div class="kv"><span>Injured since</span><b>${esc(new Date(p.injury_start_date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</b></div>`);
  if (!(R && R.practice) && (p.practice_participation || p.practice_description)) rows.push(`<div class="kv"><span>Practice</span><b>${esc(p.practice_description || p.practice_participation)}</b></div>`);
  return rows.length ? `<div class="sub-h">Injury</div>` + rows.join("") : "";
}
async function loadNews(a) {
  const newsP = E.player_news(a.name).catch(() => null);
  const p = await E.sleeper_player(a.sleeper_id).catch(() => null);
  const [news, blurbs] = await Promise.all([newsP, E.player_blurbs(p && p.espn_id, 3, a.name).catch(() => [])]);
  let h = "";
  if (blurbs && blurbs.length) {
    h += `<div class="sub-h">Latest news</div>` + blurbs.map((b, i) => `<div class="blurb${i === 0 ? " first" : ""}">
        <div class="bl-when">${esc(ago(b.date.toISOString()))}</div>
        <b>${esc(b.headline)}</b>${b.story && b.story !== b.headline ? `<p>${esc(b.story)}</p>` : ""}</div>`).join("") +
      `<p class="credit" style="text-align:left;padding:2px 0 10px">Player updates from RotoWire via ESPN.</p>`;
  }
  h += injuryDetails(p, a);
  // our news wire: his status changes over the last three weeks (2026-10-20)
  const mine = E.load_wire().filter(e => e.sid === String(a.sleeper_id || "")).slice(0, 4);
  if (mine.length) h += `<div class="sub-h">Recent moves</div>` + mine.map(e => `<div class="kv"><span>${esc(e.text)}</span><b class="muted">${esc(ago(e.t))}</b></div>`).join("");
  // reporters and fantasy outlets on Bluesky
  const posts = await E.bsky_posts(a.name).catch(() => []);
  if (posts.length) h += `<div class="sub-h">From reporters</div>` + posts.map(b => `<a class="news" data-link="${esc(b.url)}"><b>${esc(b.text.length > 280 ? b.text.slice(0, 277) + "…" : b.text)}</b>
      <span>${esc(b.author)} · @${esc(b.handle)} · ${esc(ago(b.at))}</span></a>`).join("") + `<p class="credit" style="text-align:left;padding:4px 0 0">Posts from <a data-link="https://bsky.app">Bluesky</a>. Tap one to read it there.</p>`;
  if (!E.PLAY) {
    if (news && news.length) {
      h += `<div class="sub-h">Latest headlines</div>` + news.map(n => `<a class="news" data-link="${esc(n.link)}"><b>${esc(n.title)}</b>
        <span>${esc(n.source)}${n.source ? " · " : ""}${esc(ago(n.date.toISOString()))}</span></a>`).join("") +
        `<p class="credit" style="text-align:left;padding:4px 0 0">Headlines from Google News. Tap one to read it.</p>`;
    } else if (news) h += `<p class="note muted">No headlines in the last two weeks.</p>`;
    else h += `<p class="note muted">Couldn't load headlines. Check your connection.</p>`;
  }
  if (!h && E.PLAY) return { html: "", hdr: headerInfo(a, p) };      // nothing to say: the card hides the section
  if (!h) h = `<p class="note muted">No news right now.</p>`;
  return { html: h + `<p class="credit" style="text-align:left;padding:4px 0 0">Player status from <a data-link="https://sleeper.com">Sleeper</a> and the NFL's injury report via <a data-link="https://github.com/nflverse/nflverse-data">nflverse</a> (CC BY 4.0).</p>`, hdr: headerInfo(a, p) };
}

/* A team's depth chart (Sleeper). The player you came from is highlighted; tap anyone to open their card. */
async function depthChart(team, from) {
  const body = openSheet(`<div class="sheet-head"><button class="back" aria-label="Back">‹</button><h2>${esc(team)} depth chart</h2><button class="close" aria-label="Close">×</button></div>
    <div id="depthBody">${loading("Loading…")}</div>`, { full: true });
  $(".close", body).onclick = closeSheet;
  $(".back", body).onclick = () => { if (from) card(from); else closeSheet(); };
  const owner = {};
  for (const t of teams()) for (const pid of t.players) owner[pid] = t;
  const me = S.cfg ? S.cfg.my_roster_id : null;
  try {
    const D = await E.team_depth(team);
    const groups = [["QB", "Quarterbacks", 3], ["RB", "Running backs", 4], ["WR", "Wide receivers", 6], ["TE", "Tight ends", 3]]
      .concat(S.cfg && S.cfg.league.hide_k_def === false ? [["K", "Kicker", 1]] : []);
    let h = "";
    for (const [g, label, show] of groups) {
      const rows = D[g] || [];
      if (!rows.length) continue;
      const hereAt = rows.findIndex(r => from && r.sid === from.sleeper_id);
      const keep = Math.max(show, hereAt + 1);                 // always show the player you came from
      h += `<div class="grp">${label}</div>` + rows.map((r, i) => {
        const asset = S.values && S.values.by_sleeper[r.sid];
        const who = asset || { name: r.name, pos: r.pos, team, sleeper_id: r.sid };
        const t = owner[r.sid], mine = t && t.roster_id === me;
        const tag = !teams().length ? "" : (mine ? `<span class="tag-start">Yours</span>` : (t ? "" : `<span class="tag-free">Available</span>`));
        const flag = r.injury ? `<span class="flag ${r.injury === "Questionable" ? "Q" : ""}">${esc(r.injury === "Questionable" ? "Q" : r.injury.toUpperCase())}</span>` : "";
        return `<div class="item depth-row${from && from.sleeper_id === r.sid ? " here" : ""}${i >= keep ? " extra hidden" : ""}" data-sid="${esc(r.sid)}">
          <span class="rk">${g}${i + 1}</span>${avatar(who)}
          <div class="nm"><div class="n">${esc(r.name)}${flag}${tag}</div><div class="s">${r.slot ? "slot receiver" : (i === 0 ? "starter" : "backup")}</div></div>
          <div class="v">${asset ? `<div class="gv">${gradeChip(asset, false)}</div>` : ""}</div></div>`;
      }).join("") + (rows.length > keep ? `<button class="link-btn more-depth" data-g="${g}">Show ${rows.length - keep} more</button>` : "");
    }
    $("#depthBody", body).innerHTML = (h || `<div class="empty">Sleeper has no depth chart for ${esc(team)} right now.</div>`) +
      credits("Depth charts from Sleeper");                // grades come from the value lists, so they get credited too
    $$("[data-sid]", body).forEach(n => n.onclick = () => { const x = resolvePlayer(n.dataset.sid); if (x) card(x); else toast("No card for this player yet"); });
    $$(".more-depth", body).forEach(b => b.onclick = () => {
      let n = b.previousElementSibling;
      while (n && n.classList.contains("depth-row")) { n.classList.remove("hidden"); n = n.previousElementSibling; }
      b.remove();
    });
    const here = $(".depth-row.here", body);
    if (here) here.scrollIntoView({ block: "center" });
  } catch (e) {
    $("#depthBody", body).innerHTML = `<div class="empty">Couldn't load the depth chart. Check your connection.</div>`;
  }
}

/* Where he was drafted: the NFL (nflverse draft picks, matched by name and position, then by last name and the draft
   year his years in the league point to) and this league (Sleeper's drafts, through the trade history's tables). */
async function loadDraft(a) {
  const out = { nfl: null, lg: null };
  try {
    const picks = await E.nflv_draft();
    let d = picks[E.player_key(a.name, a.pos)] || null;
    if (!d) {
      const sp = ((Store.get("sleeper_players.json") || {}).players || {})[String(a.sleeper_id || "")], ln = E.norm(a.name).split(" ").pop();
      const exp = sp && sp.years_exp !== null && sp.years_exp !== undefined && sp.years_exp !== "" ? parseInt(sp.years_exp, 10) : null;
      if (exp !== null && !isNaN(exp) && ln) {
        const yr = parseInt(S.cfg.season, 10) - exp;
        const hits = Object.entries(picks).filter(([k, v]) => k.endsWith("|" + a.pos) && k.split("|")[0].split(" ").pop() === ln && Math.abs(v[0] - yr) <= 1);
        if (hits.length === 1) d = hits[0][1];
      }
    }
    out.nfl = d ? { season: d[0], round: d[1], pick: d[2], team: E.nfl_team(d[3] || "") } : { none: true };   // caches from before the mapping
  } catch (e) { out.nfl = null; }
  if (S.values && S.values.league && a.sleeper_id && typeof Hist !== "undefined") {
    try { out.lg = await Hist.draft_of(S.cfg, S.values.league, a.sleeper_id); } catch (e) { out.lg = null; }
  }
  return out;
}
function draftHtml(d) {
  const lgOn = !!(S.values && S.values.league);
  if (!d) return `<div class="sec"><h3>Drafted</h3><p class="note muted">Loading…</p></div>`;
  const nfl = d.nfl === null ? "—" : d.nfl.none ? "Undrafted" : `${d.nfl.season} · round ${d.nfl.round}, pick ${d.nfl.pick}${d.nfl.team ? ` · ${esc(d.nfl.team)}` : ""}`;
  const slot = x => `${x.round}.${String(x.slot || 0).padStart(2, "0")}`;
  const lg = !lgOn ? "" : d.lg === null ? "—" : d.lg.none ? `Not drafted here${d.lg.earliest ? ` (drafts back to ${d.lg.earliest})` : ""}`
    : `${d.lg.season} ${esc(d.lg.kind)} · ${slot(d.lg)}${d.lg.no ? ` (${E.ordinal(d.lg.no)} overall)` : ""} by ${esc(d.lg.by)}`;
  return `<div class="sec"><h3>Drafted</h3><div class="kv"><span>NFL</span><b class="wrap">${nfl}</b></div>${lgOn ? `<div class="kv"><span>This league</span><b class="wrap">${lg}</b></div>` : ""}</div>`;
}
function card(a, opts = {}) {
  const draw = W => {
    const C = Week.player_card(S.values, S.cfg, a, W);
    const ch = C.changes || {}, d30 = ch["30d"];
    const move = d30 ? d30[0] : (a.trend || 0), G = gradeOf(a), M = moveOf(a);
    const status = C.status ? `<span class="chip ${Week.INJURY_OUT.has(C.status) ? "alert" : "amber"}">${esc(C.status)}</span>` : "";
    let h = `<div class="sheet-head"><span></span><button class="close" aria-label="Close">×</button></div>
      <div class="band ${esc(a.pos)}">${C.owner && C.owner !== "free agent" ? `<span class="band-owner${C.owner_id != null && C.owner_id === S.cfg.my_roster_id ? " mine" : ""}">${C.owner_id != null && C.owner_id === S.cfg.my_roster_id ? "Your team" : esc(C.owner)}</span>` : ""}<div class="band-top">${avatar(a, "xl")}<div><div class="band-name">${esc(a.name)}</div>${hdr && hdr.bio ? `<div class="band-bio">${hdr.bio}</div>` : ""}</div></div>
        <div class="chips">${hdr && hdr.team ? `<button class="chip link" data-depth="${esc(hdr.team)}" aria-label="${esc(hdr.team)} depth chart">${hdr.pos} ›</button>`
          : `<span class="chip">${hdr ? hdr.pos : esc(a.pos) + (a.is_pick ? "" : " · " + esc(a.team || "FA"))}</span>`}${a.age != null ? `<span class="chip">age ${Math.floor(a.age)}</span>` : ""}${hdr ? hdr.health : status}</div>
        <div class="band-grade"><span class="big-grade ${G.cls}">${esc(G.g)}</span>
          <div><div class="bg-label">${esc(G.label)}</div>
            <div class="bg-move ${M.dir}">${M.dir === "up" ? "▲ Rising" : (M.dir === "down" ? "▼ Falling" : "– Steady")}${M.amt ? ` <span>${M.amt > 0 ? "+" : "−"}${fmt(Math.abs(M.amt))} in 30 days</span>` : ""}</div>
            <div class="bg-value">Value ${fmt(a.value)}</div>
            ${!a.is_pick && a.pred ? `<div class="bg-scope">Forecast: ${E.is_redraft(S.cfg) ? `${a.pred.ros.toFixed(1)} pts a game the rest of this season` : `${a.pred.next.toFixed(1)} pts a game next season · ${Math.round(a.pred.play * 100)}% to play 4+ games`}</div>` : ""}
            ${a.is_pick ? "" : `<div class="bg-scope">${E.is_redraft(S.cfg) ? "Grade: rest of this season" : "Grade: dynasty outlook"}${C.week && !C.week.none && C.week.grade ? ` · This week <span class="grade sm ${C.week.grade.cls}">${esc(C.week.grade.letter)}</span> ${esc(C.week.grade.label.toLowerCase())}` : C.week && C.week.bye ? " · Bye this week" : ""}</div>`}</div></div>${edgeLine(a, G)}${epLine(a)}${lastCallHtml(a)}</div>
      <div class="tiles">
        <div class="tile"><div class="v">${a.rank ? "#" + a.rank : "—"}</div><div class="l">overall</div></div>
        <div class="tile"><div class="v">${a.pos_rank ? a.pos + a.pos_rank : "—"}</div><div class="l">${a.is_pick ? "draft pick" : "at position"}</div></div>
        <div class="tile"><div class="v">${a.tier ? "Tier " + a.tier : "—"}</div><div class="l">${a.tier ? "at position" : ""}</div></div>
      </div>
      ${a.is_pick && !E.is_redraft(S.cfg) && a.pick && a.pick.season === draftYear() ? `<div class="sec"><h3>Who goes around here</h3><div id="pkPros"><p class="note muted">Loading the class…</p></div></div>` : ""}
      ${a.is_pick ? "" : draftHtml(draftInfo)}
      <div class="btns"><button class="btn soft" data-to="A">Add to "You give"</button><button class="btn soft" data-to="B">Add to "You get"</button></div>
      ${!a.is_pick && S.values.league && S.cfg.my_roster_id != null ? (C.owner === "free agent" ? `<button class="btn ghost block" id="wcFromCard" style="margin-top:10px">Check adding him</button>`
        : C.owner_id === S.cfg.my_roster_id ? `<button class="btn ghost block" id="wcFromCard" style="margin-top:10px">Check dropping him</button>` : "") : ""}
      ${!a.is_pick && typeof GM !== "undefined" && GM.available() ? `<button class="btn ghost block" id="gmFromCard" style="margin-top:10px">Ask the GM about him</button>` : ""}
      ${a.is_pick ? "" : `<button class="link-btn" id="avoidBtn" style="display:block;margin:10px auto 0">${avoidList().includes(a.id) ? "Suggest this player again" : "Don't suggest this player"}</button>`}
      ${a.is_pick ? "" : `<div class="sec"><h3>Game log</h3><div id="wkBody">${weeklyHtml || `<p class="note muted">Loading…</p>`}</div></div>`}
      ${a.is_pick || newsHtml === "none" ? "" : `<div class="sec" id="newsSec"><h3>News</h3><div id="newsBody">${newsHtml || `<p class="note muted">Loading…</p>`}</div></div>`}`;
    if (!a.is_pick && !(W && W.valuesOnly)) {
      if (C.week && !C.week.none) {
        const w = C.week;
        h += `<div class="sec"><h3>Week ${w.week}${w.grade ? ` <span class="grade sm ${w.grade.cls}">${esc(w.grade.letter)}</span> <span class="muted" style="font-weight:400;font-size:13px">${esc(w.grade.label)} · ${esc(a.pos)}${w.grade.posRank} this week</span>` : ""}</h3><div class="kv"><span>${w.opp ? (w.home === false ? "at " : "vs ") + esc(w.opp) : ""}${w.weather && w.weather !== "dome" ? " · " + esc(w.weather) : ""}</span><b>${w.adj.toFixed(1)} pts</b></div>
          ${w.reasons && w.reasons.length ? `<p class="note muted">${esc(w.reasons.join(", "))}</p>` : ""}${matchupLines(a, w)}
          ${C.ppg != null ? `<div class="kv"><span>This season</span><b>${C.ppg.toFixed(1)} per game</b></div>` : ""}</div>`;
      } else if (C.week) h += `<div class="sec"><h3>Week ${C.week.week}</h3><p class="note muted">${C.week.bye ? "Bye week" : "Not expected to play"}</p></div>`;
      else if (!W) h += `<div class="sec"><h3>This week</h3><p class="note muted">Loading…</p></div>`;
    }
    h += locked() ? `<div class="sec"><h3>Value over time ${Pro.tag()}</h3><button class="btn soft block" data-lock="chart">See how this value has moved</button></div>`
      : `<div class="sec"><h3>Value over time</h3>${sparkline(C.series)}</div>`;
    let extra = `<div class="sub-h">What the grade means</div><p class="note">${GRADES.map(([, g, l]) => `<b>${g}</b> ${l.toLowerCase()}`).join(" · ")}.
      Grades compare a player's value with the best player in your league's format. ▲ rising, ▼ falling, – steady over 30 days.</p>`;
    if (C.lists.length) extra += `<div class="sub-h">Rank on each list</div>` + C.lists.map(l => `<div class="kv"><span>${esc(l.label)}</span><b>#${l.overall}${l.at_pos ? ` <span class="muted">(${esc(l.at_pos)})</span>` : ""}</b></div>`).join("");
    // something to compare to (2026-10-20): where real drafts take him, from MyFantasyLeague's ADP
    if (a.mfl || a.mflr) extra += `<div class="sub-h">Draft market</div>` + [a.mfl, a.mflr].filter(Boolean).map(m => `<div class="kv"><span>${esc(m.label[0].toUpperCase() + m.label.slice(1))}</span><b>${m.adp.toFixed(1)} <span class="muted">(${esc(m.pos)})</span></b></div>`).join("")
      + `<p class="note muted">Average pick in ${fmt((a.mfl || a.mflr).drafts)}+ drafts this year, from MyFantasyLeague.</p>`;
    if (C.seasons && C.seasons.length) {
      const ss = C.seasons, lines = ss[0].lines.map(([l]) => l);
      extra += `<div class="sub-h">Stats</div><div class="tscroll"><table class="t"><tr><th></th>${ss.map(s => `<th class="r">${s.season}</th>`).join("")}</tr>
        ${lines.map((l, i) => `<tr><td>${esc(l)}</td>${ss.map(s => `<td class="r">${esc(s.lines[i][1])}</td>`).join("")}</tr>`).join("")}</table></div>`;
    }
    if (extra) h += `<div class="sec">${more(E.PLAY ? "Rank on each list" : "Rankings, stats and trades", extra)}</div>`;
    if (C.like.length) h += `<div class="sec"><h3>Similar value</h3><div class="list">${C.like.slice(0, 5).map(p => assetRow(p, { trend: false })).join("")}</div></div>`;
    return h + credits();
  };
  let newsHtml = "", hdr = null, weeklyHtml = "", draftInfo = null;
  const body = openSheet(draw(S.W), { full: true, onClose: opts.onClose });
  const showing = () => sheetOpen() && $(".band-name", body) && $(".band-name", body).textContent === a.name;
  const redraw = () => { if (!showing()) return; const y = body.scrollTop; body.innerHTML = draw(S.W); bind(); body.scrollTop = y; };
  // the game log: this season, or last season on a tap (its stats download once, then are kept 30 days)
  let logYr = parseInt(S.cfg.season, 10);
  const logBox = () => sheetOpen() && $(".band-name", body) && $(".band-name", body).textContent === a.name && $("#wkBody", body);
  const bindLog = () => $$("[data-logyr]", body).forEach(b => b.onclick = () => loadLog(b.dataset.logyr === "career" ? "career" : +b.dataset.logyr));
  const putLog = () => { const box = logBox(); if (box) { box.innerHTML = weeklyHtml; bindLog(); } };
  let careerSt = null;                                              // the career rows, filled in as each season arrives
  const loadLog = yr => {
    logYr = yr;
    if (yr === "career") {
      careerSt = careerSt || { rows: [], done: false, loading: null, started: false };
      weeklyHtml = careerHtml(careerSt, a); putLog();
      if (careerSt.started) return;
      careerSt.started = true;
      const show = () => { if (logYr === "career") { weeklyHtml = careerHtml(careerSt, a); putLog(); } };
      E.career_stats(S.cfg, a, (row, year) => { careerSt.loading = year; if (row) careerSt.rows.push(row); show(); })
        .then(() => { careerSt.done = true; careerSt.loading = null; show(); }, () => { careerSt.done = true; careerSt.error = true; careerSt.loading = null; show(); });
      return;
    }
    weeklyHtml = gameLogHtml(null, a, yr); putLog();
    E.game_log(S.cfg, a.name, a.pos, yr).then(r => { if (logYr === yr) { weeklyHtml = gameLogHtml(r, a, yr); putLog(); } },
      () => { if (logYr === yr) { weeklyHtml = gameLogHtml({ error: true }, a, yr); putLog(); } });
  };
  const bind = () => {
    bindLog();
    $(".close", body).onclick = closeSheet;
    $$("[data-to]", body).forEach(b => b.onclick = () => {
      const s = S.sides[b.dataset.to];
      if (!s.items.some(x => x.id === a.id) && tradeFull()) { closeSheet(); Pro.lock("tradesize"); return; }
      if (!s.items.some(x => x.id === a.id)) { s.items.push(a); S.lastAdd = { side: b.dataset.to, id: a.id }; }
      S.result = null; saveUi(); closeSheet(); go("trade"); toast(`Added ${a.name}`);
    });
    $$(".item[data-act='card']", body).forEach(it => it.onclick = () => { const p = S.values.by_id[it.dataset.id]; if (p) card(p); });
    $$("[data-depth]", body).forEach(b => b.onclick = () => depthChart(b.dataset.depth, a));
    const pk = $("#pkPros", body);
    if (pk) E.prospects(a.pick.season).then(d => { if (pk.isConnected) { pk.innerHTML = pickProspectsHtml(a, d); $$("[data-prospect]", pk).forEach(it => it.onclick = () => { const p = d.players.find(x => x.id === it.dataset.prospect); if (p) prospectCard(p, d); }); } });
    const gmb = $("#gmFromCard", body);
    if (gmb) gmb.onclick = () => { closeSheet(); GM.open({ question: GM.playerQuestion(a) }); };
    const wcb = $("#wcFromCard", body);
    if (wcb) wcb.onclick = () => {
      const me = S.cfg.my_roster_id, keep = S.wc && S.wc.team === me ? S.wc : { team: me, drop: null, add: null };
      if (/adding/.test(wcb.textContent)) keep.add = a.id; else keep.drop = a.id;
      S.wc = keep; S.team.id = me; S.team.seg = "waivers"; closeSheet(); go("team");
      setTimeout(() => { const c = $("#wcCard"); if (c) c.scrollIntoView({ behavior: "smooth", block: "start" }); }, 400);
    };
    const av = $("#avoidBtn", body);
    if (av) av.onclick = () => {
      const on = !avoidList().includes(a.id);
      saveApp({ avoid: on ? avoidList().concat(a.id) : avoidList().filter(x => x !== a.id) });
      av.textContent = on ? "Suggest this player again" : "Don't suggest this player";
      toast(on ? `${a.name} won't be suggested as a pickup` : `${a.name} can be suggested again`);
    };
  };
  bind();
  if (!a.is_pick) loadLog(logYr);
  if (!a.is_pick) loadDraft(a).then(d => { draftInfo = d; redraw(); }, () => { draftInfo = { nfl: null, lg: null }; redraw(); });
  if (!a.is_pick) loadNews(a).then(r => {
    newsHtml = r.html || "none"; hdr = r.hdr;
    if (!sheetOpen() || !$(".band-name", body) || $(".band-name", body).textContent !== a.name) return;
    const y = body.scrollTop; body.innerHTML = draw(S.W); bind(); body.scrollTop = y;
  });
  if (!S.W && !a.is_pick) weekData().then(W => { if (sheetOpen() && $(".band-name", body) && $(".band-name", body).textContent === a.name) { const y = body.scrollTop; body.innerHTML = draw(W); bind(); body.scrollTop = y; } }, () => {});
}

// ---------------------------------------------------------------------------
// League tab
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Leagues without Sleeper: build the rosters by hand. The league file keeps the shape of a Sleeper import, so the
// trade screen, My team, the pickups, the draft helper and the GM all work from it (engine.js manual_*).
// ---------------------------------------------------------------------------
const isRostered = (a, t) => teams().some(o => o !== t && (o.players || []).some(p => String(p) === String(a.sleeper_id || a.id)));
function rosterBuilder(rid, seg) {
  const lg = S.values && S.values.league;
  if (!lg || lg.platform !== "manual") return;
  const t = teamById(rid) || teams()[0];
  if (!t) return;
  const B = S.rb = S.rb || { seg: "players", q: "" };
  if (seg) B.seg = seg;
  const mine = t.roster_id === S.cfg.my_roster_id;
  const body = openSheet(`<div class="sheet-head"><h2>${mine ? "Your team" : esc(t.team_name)}</h2><button class="close" aria-label="Close">×</button></div>
    <div class="row"><input type="text" id="rbName" value="${esc(t.team_name)}" placeholder="Team name" autocomplete="off"><input type="text" id="rbRec" value="${esc(t.record || "0-0")}" placeholder="W-L" style="max-width:88px" autocomplete="off"></div>
    <div class="seg rb-seg" id="rbSeg">${[["players", "Players"], ["picks", "Picks"], ["teams", "Teams"]].map(([k, l]) => `<button data-v="${k}" class="${B.seg === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div id="rbBody"></div>`, { full: true, onClose: () => { if (["team", "trade", "league", "rank"].includes(S.tab)) go(S.tab); } });
  $(".close", body).onclick = closeSheet;
  $("#rbName", body).onchange = e => { t.team_name = e.target.value.trim() || t.team_name; e.target.value = t.team_name; E.manual_save(lg, S.values); $("h2", body).textContent = mine ? "Your team" : t.team_name; };
  $("#rbRec", body).onchange = e => {
    const m = /^(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?$/.exec(e.target.value.trim());
    if (m) { t.record = `${m[1]}-${m[2]}${m[3] ? "-" + m[3] : ""}`; E.manual_save(lg, S.values); } else e.target.value = t.record || "0-0";
  };
  $$("#rbSeg button", body).forEach(b => b.onclick = () => { B.seg = b.dataset.v; $$("#rbSeg button", body).forEach(x => x.classList.toggle("on", x === b)); drawBuilder(body, t, B); });
  drawBuilder(body, t, B);
}
function drawBuilder(body, t, B) {
  const lg = S.values.league, box = $("#rbBody", body), save = () => E.manual_save(lg, S.values), redraw = () => drawBuilder(body, t, B);
  if (B.seg === "players") {
    // The lineup board (the user's ask, 2026-10-12): one row per slot of the league's lineup, the bench below. Tap an
    // empty slot to pick a player for it (a list by position, with search); tap × on a player to clear his slot.
    const roster = E.team_assets(S.values, S.cfg, t).filter(a => !a.is_pick), on = new Set(roster.map(a => a.id));
    const slots = lg.roster_positions || [], poolPos = E.POSITIONS.concat(slots.includes("K") ? ["K"] : [], slots.includes("DEF") ? ["DEF"] : []);
    const LABEL = { QB: "Quarterbacks", RB: "Running backs", WR: "Wide receivers", TE: "Tight ends", K: "Kickers", DEF: "Defenses" };
    const eligible = sl => { const u = String(sl).toUpperCase(); return ["QB", "RB", "WR", "TE", "K", "DEF"].includes(u) ? [u] : E.FLEX_ELIGIBLE[u] || poolPos; };
    const free = a => !on.has(a.id) && !isRostered(a, t);
    if (B.review) {                                                 // the screenshot import's review list
      const RV = B.review;
      box.innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn ghost sm" id="rvBack">‹ Lineup</button><span class="hint">${RV.items.length ? "Players read from the screenshot. Untick any that are wrong." : "No players could be read from that picture."}</span></div>
        <div class="list">${RV.items.map((it, i) => it.match ? `<label class="rv-row"><input type="checkbox" data-rv="${i}" ${it.on ? "checked" : ""}>${assetRow(it.match, { trend: false, right: `<span class="hint">${esc(it.name)}${it.pos ? " · " + esc(it.pos) : ""}</span>` })}</label>`
          : `<div class="rv-row miss"><div class="nm"><div class="n">${esc(it.name)}${it.pos ? ` <span class="muted">${esc(it.pos)}</span>` : ""}</div><div class="s">Not found. Add him from the lineup board.</div></div></div>`).join("")}</div>
        ${RV.raw ? `<p class="note muted">What the model saw: ${esc(RV.raw)}</p>` : ""}
        <button class="btn primary block big" id="rvAdd" style="margin-top:14px" ${RV.items.some(it => it.match && it.on) ? "" : "disabled"}>Add the ticked players</button>`;
      $("#rvBack", box).onclick = () => { B.review = null; redraw(); };
      $$("[data-rv]", box).forEach(cb => cb.onchange = () => { RV.items[+cb.dataset.rv].on = cb.checked; $("#rvAdd", box).disabled = !RV.items.some(it => it.match && it.on); });
      $$(".rv-row .item", box).forEach(it => { it.onclick = e => { e.preventDefault(); const cb = it.closest("label").querySelector("input"); cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }; });
      $("#rvAdd", box).onclick = () => { let n = 0; for (const it of RV.items) if (it.match && it.on && free(it.match)) { E.manual_add_player(lg, t, it.match); n++; } save(); toast(`${n} added`, 1500); B.review = null; redraw(); };
      return;
    }
    if (B.pick) {                                                   // the picker for one slot
      const P = B.pick, posList = P.positions, many = posList.length > 1;
      let h = `<div class="row" style="margin-bottom:10px"><button class="btn ghost sm" id="rbBack">‹ Lineup</button><span class="hint">Pick a player for <b>${esc(SLOT_LABEL(P.slot))}</b></span></div>
        ${many ? `<div class="rb-pos">${[["", "All"]].concat(posList.map(x => [x, x])).map(([v, l]) => `<button data-pos="${v}" class="pos-chip ${v} ${(B.pos || "") === v ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
        <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <input type="search" id="rbq" placeholder="Search by name${posList.includes("DEF") ? " or team" : ""}" value="${esc(B.q)}" autocomplete="off"></div><div class="list" id="rbRes"></div>`;
      box.innerHTML = h;
      $("#rbBack", box).onclick = () => { B.pick = null; B.q = ""; redraw(); };
      $$("[data-pos]", box).forEach(b => b.onclick = () => { B.pos = b.dataset.pos || null; redraw(); });
      const res = $("#rbRes", box), q = $("#rbq", box), want = B.pos && posList.includes(B.pos) ? [B.pos] : posList;
      const row = a => assetRow(a, { act: "add", trend: false, right: `<span class="plus">+</span>` });
      let gen = 0;
      const search = async () => {
        B.q = q.value.trim();
        const typed = B.q, my = ++gen, k = E.norm(typed);
        const ranked = S.values.players.filter(a => want.includes(a.pos) && !a.unranked && free(a)).sort((x, y) => y.value - x.value);   // by value first
        const more = (await E.pool_players(S.values, want).catch(() => [])).filter(free)                                   // then Sleeper's list: kickers, defenses, deep benches
          .sort((x, y) => (x.pos === "DEF" || x.pos === "K" ? x.team.localeCompare(y.team) || x.name.localeCompare(y.name) : x.name.localeCompare(y.name)));
        if (my !== gen) return;
        const all = ranked.concat(more).filter(a => !k || E.norm(a.name).includes(k) || (a.pos === "DEF" && a.team.toLowerCase() === k)), shown = all.slice(0, typed ? 40 : 60);
        res.innerHTML = shown.map(row).join("") + (all.length > shown.length ? `<div class="empty">${all.length - shown.length} more: type a name to narrow the list.</div>` : "") || `<div class="empty">No free player matches.</div>`;
        $$(".item[data-act='add']", res).forEach(it => it.onclick = () => {
          const a = S.values.by_id[it.dataset.id] || shown.find(x => x.id === it.dataset.id);
          if (!a) return;
          E.manual_add_player(lg, t, a); save(); toast(`${a.name} in at ${SLOT_LABEL(P.slot)}`, 1400); B.pick = null; B.q = ""; B.pos = null; redraw();
        });
      };
      q.oninput = search; search();
      if (!B.q) q.focus();
      return;
    }
    // the board: starters by value into their slots (fixed positions first, then the flex slots), the rest on the bench
    const pool = roster.slice().sort((x, y) => y.value - x.value), used = new Set(), rows = slots.map(sl => ({ slot: sl, a: null }));
    const fill = pred => { for (const r of rows) { if (r.a || !pred(r.slot)) continue; const el = eligible(r.slot); const a = pool.find(x => !used.has(x.id) && el.includes(x.pos)); if (a) { used.add(a.id); r.a = a; } } };
    fill(sl => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(String(sl).toUpperCase()));
    fill(sl => !!E.FLEX_ELIGIBLE[String(sl).toUpperCase()]);
    fill(sl => ["BN", "IR", "TAXI"].includes(String(sl).toUpperCase()));
    const extra = pool.filter(a => !used.has(a.id));                   // more players than slots: still on the team, listed below
    const what = sl => { const el = eligible(sl); return el.length === 1 ? (el[0] === "DEF" ? "a defense" : el[0] === "K" ? "a kicker" : "a " + el[0]) : /SUPER|^SF$/.test(String(sl).toUpperCase()) ? "a QB, RB, WR or TE" : /FLEX|WRRB|REC/.test(String(sl).toUpperCase()) ? "an " + el.join("/") : "a player"; };
    const line = (r, i) => `<div class="slot-row ${r.a ? "" : "open"}" data-i="${i}"><span class="slot ${esc(slotClass(r.slot))}">${esc(SLOT_LABEL(r.slot))}</span>
      ${r.a ? `${avatar(r.a)}<div class="nm"><div class="n"><a class="plink" data-pcard="${esc(r.a.id)}">${esc(r.a.name)}</a>${statusFlag(r.a)}</div><div class="s">${esc(sub(r.a))}</div></div><div class="v">${gradeRight(r.a)}</div><button class="x" data-x="${esc(r.a.id)}" aria-label="Remove">×</button>`
           : `<span class="slot-empty">Tap to add ${esc(what(r.slot))}</span><span class="plus">+</span>`}</div>`;
    const starters = rows.filter(r => !["BN", "IR", "TAXI"].includes(String(r.slot).toUpperCase())), bench = rows.filter(r => ["BN", "IR", "TAXI"].includes(String(r.slot).toUpperCase()));
    let h = `<div class="grp">Starters <span class="grp-note">${starters.filter(r => r.a).length} of ${starters.length}</span></div><div class="list">${starters.map((r, i) => line(r, rows.indexOf(r))).join("")}</div>`;
    if (bench.length) h += `<div class="grp">Bench <span class="grp-note">${bench.filter(r => r.a).length} of ${bench.length}</span></div><div class="list">${bench.map(r => line(r, rows.indexOf(r))).join("")}</div>`;
    if (extra.length) h += `<div class="grp">Also on the team</div><div class="list">${extra.map(a => assetRow(a, { x: true, trend: false })).join("")}</div>`;
    const shot = typeof GM !== "undefined" && GM.available && GM.available();
    h += `${shot ? `<div class="btns" style="margin-top:12px"><button class="btn soft block" id="rbShot">Import from a screenshot</button></div><input type="file" id="rbShotFile" accept="image/*" style="display:none">` : ""}
      <p class="note muted" style="margin-top:10px">Players sit in the slots by value; the lineup help on My team picks the week's starters. Tap a name for his card, × to take him off the team.${shot ? " Import from a screenshot reads a roster picture from Sleeper, ESPN, Yahoo or any league site and adds the players it finds; long rosters take two pictures." : ""}</p>`;
    box.innerHTML = h;
    if (shot) { $("#rbShot", box).onclick = () => $("#rbShotFile", box).click(); $("#rbShotFile", box).onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importScreenshot(f, lg, t, B, poolPos, free, redraw); }; }
    $$(".slot-row.open", box).forEach(r => r.onclick = () => { const sl = rows[+r.dataset.i].slot; B.pick = { slot: sl, positions: eligible(sl) }; B.pos = null; B.q = ""; redraw(); });
    $$("[data-x]", box).forEach(b => b.onclick = e => {
      e.stopPropagation();
      const a = S.values.by_id[b.dataset.x], key = String((a && a.sleeper_id) || b.dataset.x);
      t.players = t.players.filter(p => String(p) !== key && String(p) !== b.dataset.x); save(); redraw();
    });
    bindCards(box);
  } else if (B.seg === "picks") {
    const picks = E.team_assets(S.values, S.cfg, t).filter(a => a.is_pick), seasons = lg.pick_seasons || [], rounds = lg.draft_rounds || 4, others = teams().filter(o => o.roster_id !== t.roster_id);
    box.innerHTML = E.is_redraft(S.cfg) ? `<div class="empty">A redraft league has no draft picks to trade.</div>` : `<div class="row num-row"><span class="spacer">Rounds in the rookie draft</span><input type="number" id="rbRounds" min="1" max="20" value="${rounds}"></div>
      <div class="grp">Picks held <span class="grp-note">${picks.length}</span></div><div class="list">${picks.map(a => assetRow(a, { x: true, trend: false })).join("") || `<div class="empty">No picks.</div>`}</div>
      <div class="grp">Add a pick</div><div class="row"><select id="rbPS">${seasons.map(x => `<option value="${x}">${x}</option>`).join("")}</select><select id="rbPR">${Array.from({ length: rounds }, (_, i) => `<option value="${i + 1}">${E.ordinal(i + 1)}</option>`).join("")}</select>
        <select id="rbPO"><option value="${t.roster_id}">own pick</option>${others.map(o => `<option value="${o.roster_id}">from ${esc(o.team_name)}</option>`).join("")}<option value="-1">from another team</option></select><button class="btn ghost" id="rbPAdd">Add</button></div>
      <p class="note muted">Every team starts with its own picks. Traded one away? Tap × on it. Got one in a trade? Add it with the team it came from.</p>`;
    const rr = $("#rbRounds", body);
    if (rr) rr.onchange = e => { E.manual_set_rounds(lg, e.target.value); save(); redraw(); };
    const add = $("#rbPAdd", body);
    if (add) add.onclick = () => {
      const pk = { season: +$("#rbPS", body).value, round: +$("#rbPR", body).value, original: +$("#rbPO", body).value };
      if (t.picks.some(p => p.season === pk.season && p.round === pk.round && p.original === pk.original)) { toast("Already on the list", 1500); return; }
      for (const o of others) o.picks = o.picks.filter(p => !(p.season === pk.season && p.round === pk.round && p.original === pk.original));   // it moves here
      t.picks.push(pk); save(); redraw();
    };
    $$("[data-x]", box).forEach(b => b.onclick = e => {
      e.stopPropagation();
      const m = /^pick-(\d+)-(\d+)(?:-\w+)?@(-?\d+)$/.exec(b.dataset.x);
      if (!m) return;
      t.picks = t.picks.filter(p => !(p.season === +m[1] && p.round === +m[2] && p.original === +m[3])); save(); redraw();
    });
    bindCards(box);
  } else {
    box.innerHTML = `<div class="list">${teams().map(o => `<div class="item" data-rb-team="${o.roster_id}"><div class="nm"><div class="n"><span class="nt">${esc(o.team_name)}</span>${o.roster_id === S.cfg.my_roster_id ? `<span class="tag-start">You</span>` : ""}</div>
        <div class="s">${plural((o.players || []).length, "player")} · ${plural((o.picks || []).length, "pick")}</div></div>${o.roster_id !== S.cfg.my_roster_id ? `<button class="x" data-rb-del="${o.roster_id}" aria-label="Remove">×</button>` : ""}</div>`).join("")}</div>
      <div class="row" style="margin-top:12px"><input type="text" id="rbNew" placeholder="Another team's name" autocomplete="off"><button class="btn ghost" id="rbAddTeam">Add</button></div>
      <p class="note muted">Add the other teams when you want the trade screen to show their rosters and the pickups to skip their players. Tap a team to build it.</p>`;
    $$("[data-rb-team]", box).forEach(it => it.onclick = e => { if (e.target.closest("[data-rb-del]")) return; S.sheetStack = []; closeSheet(); rosterBuilder(+it.dataset.rbTeam, "players"); });
    $$("[data-rb-del]", box).forEach(b => b.onclick = e => {
      e.stopPropagation();
      const o = teamById(+b.dataset.rbDel);
      if (!o) return;
      confirmSheet(`Remove ${o.team_name}?`, "Its players and picks go with it.", "Remove", () => { lg.teams = lg.teams.filter(x => x.roster_id !== o.roster_id); save(); rosterBuilder(t.roster_id, "teams"); });
    });
    $("#rbAddTeam", body).onclick = () => { const name = $("#rbNew", body).value.trim(); if (!name) return; const rid = E.manual_add_team(lg, name); save(); S.sheetStack = []; closeSheet(); rosterBuilder(rid, "players"); };
  }
}

// ---------------------------------------------------------------------------
// The rookie draft helper (draft.js): your picks, the class board for this league's format, who is gone, who is
// likely to be there when you pick, and what to take. A Sleeper draft in progress is followed live.
// ---------------------------------------------------------------------------
const DRAFT_POS = [["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]];
const pickNo = x => `${x.round}.${String(x.slot).padStart(2, "0")}`;
function drawDraft() {
  const list = $("#rlist"), Y = draftYear(), lg = S.values.league, me = teamById(S.cfg.my_roster_id);
  const D = S.draftUi = S.draftUi || { pos: "ALL", avail: true, sync: null, busy: false, limit: 60 };
  list.innerHTML = loading(`Loading the ${Y} class…`);
  E.prospects(Y).then(d => {
    if (!list.isConnected || S.rank.pos !== "DRAFT") return;
    if (!d || !d.players || !d.players.length) { list.innerHTML = `<div class="empty">The ${Y} class isn't published yet. It appears here as the college season goes on.</div>`; return; }
    if (kitLocked(Y)) {
      const picks = me ? Draft.my_picks(S.values, S.cfg, me, Y) : [], pickTxt = a => a.name.replace(/\s*\(via [^)]*\)\s*$/, "").replace(" · ", " ");
      list.innerHTML = `<div class="dr-head"><div class="dr-title">${Y} rookie draft</div><div class="hint">${teams().length || parseInt(S.cfg.league.teams, 10) || 12} teams · ${(lg && lg.draft_rounds) || 4} rounds</div></div>
        ${picks.length ? `<div class="dr-sec"><div class="sub-h">Your picks</div><div class="chips">${picks.map(a => `<span class="chip dr-pick">${esc(pickTxt(a))} <small>${fmt(a.value)}</small></span>`).join("")}</div></div>` : ""}
        ${Pro.kitCard(Y, `The draft helper puts the ${Y} class on a board scored for this league, tells you where you're thin, who to take next and why, who is likely to be there when you pick, and follows a Sleeper draft live.`)}`;
      return;
    }
    const draw = () => {
      const st = Draft.load(Y), rows = Draft.board(d, S.cfg), N = teams().length || parseInt(S.cfg.league.teams, 10) || 12;
      const sy = D.sync && D.sync.found ? D.sync : null, rounds = (sy && sy.rounds) || (lg && lg.draft_rounds) || 4;
      const needs = me ? Draft.needs(S.values, S.cfg, me) : [], picks = me ? Draft.my_picks(S.values, S.cfg, me, Y) : [];
      const takenN = Object.keys(st.taken).length, mineN = Object.values(st.taken).filter(x => x.mine).length;
      let before = sy && sy.untilMine !== null && sy.untilMine !== undefined ? sy.untilMine : null;   // picks before my next one
      if (before === null && picks.length) {
        const a = picks.slice().sort((x, y) => x.pick.round - y.pick.round)[0], slot = a.proj_slot ? Math.round(a.proj_slot) : Math.round(N / 2);
        before = Math.max(0, (a.pick.round - 1) * N + slot - 1 - takenN);
      }
      const rec = Draft.recommend(rows, st, needs, 5), lk = before !== null ? Draft.likely(rows, st, before, 8) : null;
      const pickTxt = a => a.name.replace(/\s*\(via [^)]*\)\s*$/, "").replace(" · ", " ");
      const thin = needs.filter(x => x.need >= 1).map(x => x.pos), help = needs.filter(x => x.need >= 0.5 && x.need < 1).map(x => x.pos), old = needs.filter(x => x.vets).map(x => x.pos);
      const clock = sy && sy.onClock !== null && sy.onClock !== undefined ? (teamById(sy.onClock) || {}).team_name || "someone" : null;
      const status = sy ? (sy.status === "complete" ? "Sleeper says this draft is done."
          : sy.status === "drafting" ? `Live on Sleeper: pick ${sy.next ? pickNo(sy.next) : "?"} is up${clock ? ` (${esc(clock)})` : ""}${sy.untilMine === 0 ? ". <b>You're on the clock.</b>" : sy.untilMine !== null && sy.untilMine !== undefined ? `. You pick in ${sy.untilMine}.` : "."}`
          : `Sleeper has the draft set up (${sy.type}, ${sy.rounds} rounds); it hasn't started.`)
        : (lg && lg.league_id ? "Tap Sync to follow the draft on Sleeper." : "Mark players as they go; the board keeps up.");
      let h = `<div class="dr-head"><div class="dr-title">${Y} rookie draft</div><div class="hint">${N} teams · ${rounds} rounds${sy ? ` · ${esc(sy.type)}` : ""} · ${takenN} taken${mineN ? `, ${mineN} yours` : ""}</div><p class="note">${status}</p>
        <div class="btns">${lg && lg.league_id ? `<button class="btn soft sm" id="drSync" ${D.busy ? "disabled" : ""}>${D.busy ? "Syncing…" : "Sync with Sleeper"}</button>` : ""}<button class="btn ghost sm" id="drReset">Clear my marks</button></div></div>`;
      if (picks.length) h += `<div class="dr-sec"><div class="sub-h">Your picks</div><div class="chips">${picks.map(a => `<span class="chip dr-pick">${esc(pickTxt(a))} <small>${fmt(a.value)}</small></span>`).join("")}</div></div>`;
      else if (me) h += `<div class="dr-sec"><p class="note muted">You hold no ${Y} picks${lg && lg.platform === "manual" ? ". Add them on My team > Edit > Picks" : ""}.</p></div>`;
      if (needs.length) h += `<div class="dr-sec"><div class="sub-h">Your roster</div><p class="note">${thin.length ? `Thin at <b>${thin.join(", ")}</b>` : "No position is thin"}${help.length ? `; could use help at ${help.join(", ")}` : ""}.${old.length ? ` Your ${old.length > 1 ? old.slice(0, -1).join(", ") + " and " + old[old.length - 1] : old[0]} starters are getting old.` : ""}</p></div>`;
      if (rec.length) h += `<div class="dr-sec"><div class="sub-h">${before !== null ? (sy && sy.untilMine === 0 ? "Take now" : `For your next pick${sy && sy.myNext ? ` (${pickNo(sy.myNext)})` : ""}`) : "Best available"}</div><div class="list">${rec.map(x => draftRow(x.r, st, x.why)).join("")}</div></div>`;
      const byPos = rs => ["QB", "RB", "WR", "TE"].map(pos => { const g = rs.filter(r => r.p.pos === pos).slice(0, 2); return g.length ? `<b>${pos}</b> ${g.map(r => esc(r.p.name)).join(", ")}` : ""; }).filter(Boolean).join(" · ");
      if (lk && before > 0) h += `<div class="dr-sec"><div class="sub-h">Likely there in ${before} ${before === 1 ? "pick" : "picks"}</div><p class="note">${lk.there.length ? byPos(lk.there) : "nobody of note"}.</p>${lk.gone.length ? `<p class="note muted">Likely gone by then: ${lk.gone.slice(0, 8).map(r => esc(r.p.name)).join(", ")}${lk.gone.length > 8 ? "…" : ""}.</p>` : ""}</div>`;
      const shown = rows.filter(r => (D.pos === "ALL" || r.p.pos === D.pos) && (!D.avail || !st.taken[r.p.id]));
      h += `<div class="dr-sec"><div class="sub-h">The board</div><div class="seg" id="drPos">${DRAFT_POS.map(([p, l]) => `<button data-dp="${p}" class="${D.pos === p ? "on" : ""}">${l}</button>`).join("")}</div>
        <label class="switch" style="margin-top:8px"><span class="txt">Hide taken players</span><input type="checkbox" id="drAvail" ${D.avail ? "checked" : ""}><span class="track"></span></label>
        <div class="list">${shown.slice(0, D.limit).map(r => draftRow(r, st)).join("") || `<div class="empty">Nobody left here.</div>`}</div>${shown.length > D.limit ? `<button class="add-btn" id="drMore">Show more</button>` : ""}
        <p class="note muted">Scores are the class grades adjusted to this league: ${parseInt(S.cfg.league.num_qbs, 10) >= 2 ? "superflex lifts quarterbacks" : "a 1-QB league drops rookie quarterbacks"}${parseFloat(S.cfg.league.te_premium_bonus_pct || 0) > 0 ? ", TE premium lifts tight ends" : ""}. Tap a name for the full profile.</p></div>`;
      list.innerHTML = h;
      const again = () => { const y = window.scrollY; draw(); window.scrollTo(0, y); };
      const mark = (id, v) => { if (v) st.taken[id] = v; else delete st.taken[id]; Draft.save(st); again(); };
      $$("[data-prospect]", list).forEach(it => it.onclick = e => { if (e.target.closest(".dr-btn")) return; const p = d.players.find(x => x.id === it.dataset.prospect); if (p) prospectCard(p, d); });
      $$("[data-taken]", list).forEach(b => b.onclick = () => mark(b.dataset.taken, { by: null, mine: false, src: "manual", pick: "" }));
      $$("[data-mine]", list).forEach(b => b.onclick = () => mark(b.dataset.mine, { by: me ? me.roster_id : null, mine: true, src: "manual", pick: "" }));
      $$("[data-undo]", list).forEach(b => b.onclick = () => mark(b.dataset.undo, null));
      $$("#drPos button", list).forEach(b => b.onclick = () => { D.pos = b.dataset.dp; again(); });
      $("#drAvail", list).onchange = e => { D.avail = e.target.checked; again(); };
      const more = $("#drMore", list); if (more) more.onclick = () => { D.limit += 60; again(); };
      $("#drReset", list).onclick = () => confirmSheet("Clear your marks?", "The players you marked as taken or yours go back on the board. Picks that came from Sleeper stay.", "Clear", () => {
        for (const k of Object.keys(st.taken)) if (st.taken[k].src !== "sleeper") delete st.taken[k];
        Draft.save(st); S.rank.pos = "DRAFT"; go("rank");
      });
      const sync = $("#drSync", list);
      if (sync) sync.onclick = () => {
        D.busy = true; again();
        Draft.sleeper_sync(S.cfg, lg, d, st, S.cfg.my_roster_id).then(r => { D.sync = r; D.busy = false; Draft.save(st); if (!r.found) toast(`Sleeper has no ${Y} draft set up yet.`, 3000); again(); },
          () => { D.busy = false; toast("Couldn't reach Sleeper.", 3000); again(); });
      };
    };
    draw();
  });
}
function draftRow(r, st, why) {
  const p = r.p, G = prospectGrade(p), tk = st.taken[p.id], byTeam = tk && tk.by !== null && tk.by !== undefined ? teamById(tk.by) : null;
  const tag = !tk ? "" : tk.mine ? `<span class="tag-start">Yours${tk.pick ? " · " + esc(tk.pick) : ""}</span>` : `<span class="dr-gone-tag">Taken${tk.pick ? " " + esc(tk.pick) : ""}${byTeam ? " by " + esc(byTeam.team_name) : ""}</span>`;
  const btns = tk ? (tk.src === "sleeper" ? "" : `<button class="dr-btn" data-undo="${esc(p.id)}">Undo</button>`) : `<button class="dr-btn" data-taken="${esc(p.id)}">Taken</button><button class="dr-btn mine" data-mine="${esc(p.id)}">Mine</button>`;
  const sub = [esc(p.school || ""), p.drafted ? `NFL round ${p.drafted.round}` : "", why ? esc(why) : (r.adp !== r.rank ? `neutral board ${r.adp}` : "")].filter(Boolean).join(" · ");
  return `<div class="item prow dr-row${tk ? " gone" : ""}" data-prospect="${esc(p.id)}"><span class="rk">${r.rank}</span>${badge(p.pos)}
    <div class="nm"><div class="n"><span class="nt">${esc(p.name)}</span>${tag}</div><div class="s">${sub}</div></div>
    <div class="v"><span class="grade sm ${G.cls}">${esc(G.g)}</span><div class="d muted">${r.score}</div></div><div class="dr-btns">${btns}</div></div>`;
}

function renderLeague(el) {
  const p = E.load_profiles(), a = app();
  // Your leagues first, then the ways to add one, then the open league and its settings (the user's order, 2026-10-12)
  let h = "";
  const have = Object.entries(p.profiles);
  if (have.length) {                                       // every league with its remove button, even when there is just one (2026-10-07)
    h += `<section class="card flush"><div class="grp">Your leagues</div>${have.map(([id, pr]) => `<div class="item" data-prof="${esc(id)}"><div class="nm"><div class="n">${esc(pr.name)}</div></div>
      ${id === p.active ? '<span class="tag-start">Open</span>' : ""}<button class="x" data-del="${esc(id)}" aria-label="Remove ${esc(pr.name)}">×</button></div>`).join("")}</section>`;
  }
  if (locked() && have.length) h += `<section class="card"><h2>Add another league ${Pro.tag()}</h2><div class="hint">Basic includes one league. Pro keeps all your leagues in one app.</div>
      <button class="btn soft block" data-lock="leagues" style="margin-top:12px">Add more leagues with Pro</button></section>`;
  else h += `<section class="card"><h2>${S.cfg ? "Add another league" : "Add your league"}</h2><div class="hint">Enter your Sleeper username to see your leagues.</div>
    <div class="row" style="margin-top:10px"><input type="text" id="sUser" autocapitalize="off" autocomplete="off" value="${esc((a.sleeper || {}).username || "")}" placeholder="Sleeper username"><button class="btn primary" id="findL">Find</button></div>
    <div id="lres" class="list"></div>
    ${more("Other ways to add a league", `<label class="lbl">Sleeper league ID</label><div class="row"><input type="text" id="lid" inputmode="numeric" placeholder="Long number from Sleeper"><button class="btn ghost" id="addId">Add</button></div>
      <label class="lbl" style="margin-top:12px">League not on Sleeper (build the rosters yourself)</label><div class="row"><input type="text" id="mName" placeholder="League name"><button class="btn ghost" id="addManual">Create</button></div>`)}</section>`;
  h += Pro.ON ? Pro.accountCard() : "";
  if (S.cfg) {
    const v = S.values, lg = v && v.league;
    const others = Object.entries(p.profiles);                   // the title is a drop-down of your leagues (the user's ask, 2026-10-12)
    h += `<section class="card"><div class="kicker">Current league</div>${others.length > 1
      ? `<select class="league-pick" id="lgPick" aria-label="Switch league">${others.map(([id, pr]) => `<option value="${esc(id)}" ${id === E.P.id ? "selected" : ""}>${esc(pr.name)}</option>`).join("")}</select>`
      : `<h2 class="league-title">${esc((p.profiles[E.P.id] || {}).name || S.cfg.league.name)}</h2>`}
      <div class="hint">${esc(formatText(S.cfg))}</div>
      <div class="kv" style="margin-top:10px"><span>Player values</span><b>${v ? esc(ago(v.meta.fetched)) : "not downloaded"}</b></div>
      ${lg ? `<div class="kv"><span>Rosters</span><b>${esc(ago(lg.imported))}</b></div>` : ""}
      ${lg && lg.league_id && !E.is_redraft(S.cfg) && marketText() ? `<div class="hint" style="margin-top:8px">${esc(marketText())}</div>` : ""}
      <div class="btns" style="margin-top:12px"><button class="btn primary" id="upd">Update values</button>${lg ? (lg.league_id ? `<button class="btn ghost" id="reimp">Refresh rosters</button>` : `<button class="btn ghost" id="editTeam">Edit rosters</button>`) : ""}</div>
      ${lg ? `<button class="btn ghost block" id="power" style="margin-top:8px">Power rankings</button>` : ""}
      ${lg ? `<button class="btn ghost block" id="thist" style="margin-top:8px">Trade history${proTag() ? " " + proTag() : ""}</button>` : ""}
      ${lg && !E.is_redraft(S.cfg) ? `<button class="btn ghost block" id="toDraftL" style="margin-top:8px">Rookie draft helper</button>` : ""}
      ${more("Having trouble?", `<p class="note">If this league looks wrong (players missing, odd values, something that won't load), start it over: everything saved for it on this phone is removed and it is downloaded again from Sleeper. Your other leagues aren't touched.</p>
        ${lg && lg.league_id ? `<button class="btn ghost block" id="redoLeague">Start this league over</button>` : ""}
        <button class="link-btn danger" id="rmLeague" style="display:block;margin:12px auto 0">Remove this league from this phone</button>`)}</section>`;
  }
  if (S.cfg && S.values) h += scoreCard();
  if (S.cfg) {
    const L = S.cfg.league, sf = parseInt(L.num_qbs) >= 2, lg = S.values && S.values.league;
    const settings = `<label class="lbl">League type</label><select id="sType"><option value="dynasty">Dynasty</option><option value="dynasty_bestball">Dynasty best ball</option><option value="redraft">Redraft (one season)</option></select>
      <div class="divide" style="margin-top:6px">
        <label class="switch"><span class="txt">Half-point PPR</span><input type="checkbox" id="sHalf" ${parseFloat(L.ppr) === 0.5 ? "checked" : ""}><span class="track"></span></label>
        <label class="switch"><span class="txt">Superflex (2 QBs)</span><input type="checkbox" id="sSF" ${sf ? "checked" : ""}><span class="track"></span></label>
        ${lg && lg.platform === "manual" ? "" : `<label class="switch"><span class="txt">Hide kickers and defenses your lineup doesn't start</span><input type="checkbox" id="sHide" ${L.hide_k_def !== false ? "checked" : ""}><span class="track"></span></label>`}
        ${lg && lg.league_id && !E.is_redraft(S.cfg) ? `<label class="switch"><span class="txt">Price trades to this league's market</span><input type="checkbox" id="sMarket" ${L.use_market !== false ? "checked" : ""}><span class="track"></span></label>` : ""}
        ${Store.native && Native.reminder ? `<label class="switch"><span class="txt">Tuesday morning: tell me the GM report is ready</span><input type="checkbox" id="sRemind" ${Native.reminderOn && Native.reminderOn() ? "checked" : ""}><span class="track"></span></label>` : ""}
        <div class="row num-row"><span class="spacer">Tight end bonus %</span><input type="number" id="sTE" min="0" max="100" value="${esc(L.te_premium_bonus_pct || 0)}"></div>
        <div class="row num-row"><span class="spacer">Extra value for starting QBs %</span><input type="number" id="sQB" min="0" max="100" value="${esc(sf ? L.sf_qb_bonus_pct : (L.qb_bonus_pct ?? 8))}"></div>
        ${sf ? `<div class="row num-row"><span class="spacer">Extra for QBs 25 and under %</span><input type="number" id="sYQB" min="0" max="100" value="${esc(L.sf_young_qb_bonus_pct)}"></div>` : ""}
        ${E.is_redraft(S.cfg) ? "" : `<div class="row num-row"><span class="spacer">Extra for QBs in trades %</span><input type="number" id="sQBT" min="0" max="100" value="${esc(L.qb_trade_bump_pct ?? 15)}"></div>`}
        ${lg && lg.league_id ? "" : `<div class="row num-row"><span class="spacer">Teams</span><input type="number" id="sTeams" min="4" max="32" value="${esc(L.teams)}"></div>`}
      </div>${lg && lg.platform === "manual" ? lineupRows(lg) : ""}`;
    const lists = `<p class="note muted">Values are a blend of these ranking sites. Turn one off to leave it out.</p><div class="divide">${E.SOURCE_ORDER.filter(n => (!E.PLAY || E.SOURCES[n].play) && (!window.OWN_VALUES_ONLY || n === "dmv")).map(n => {
      const s = E.SOURCES[n], [on] = E.source_settings(S.cfg, n), ap = E.source_applies(S.cfg, n);
      return `<label class="switch"><span class="txt">${esc(s.label)}${ap ? "" : " <small>(dynasty only)</small>"}</span><input type="checkbox" data-src="${n}" ${on ? "checked" : ""} ${ap ? "" : "disabled"}><span class="track"></span></label>`; }).join("")}</div>`;
    const season = lg && lg.league_id ? `<p class="note">When your league renews on Sleeper for next season, tap below. Your history is kept.</p><button class="btn ghost block" id="nextSeason">Start the ${lg.season + 1} season</button>`
      : `<button class="btn ghost block" id="bumpSeason">Start the ${parseInt(S.cfg.season) + 1} season</button>`;
    const lockNote = (what, reason) => `<p class="note">${what}</p><button class="btn soft block" data-lock="${reason}" style="margin-top:8px">Unlock with Pro</button>`;
    const settingsBox = locked() ? lockNote(`Your league's scoring ${lg ? "comes from Sleeper automatically" : "uses standard settings"}: ${esc(formatText(S.cfg))}. Changing it (league type, PPR, superflex, TE premium, QB bonuses) is part of Pro.`, "settings") : settings;
    const listsBox = locked() ? lockNote("Values blend every ranking site. Choosing which sites count is part of Pro.", "sources") : lists;
    h += `<section class="card">${more(locked() ? "League settings · PRO" : "League settings", settingsBox)}${more(locked() ? "Ranking sites · PRO" : "Ranking sites", listsBox)}${more("New season", season)}
      ${more("Appearance", `<label class="lbl">Look</label><div class="seg" id="look">${[["classic", "Classic"], ["retro", "8-bit"]].map(([k, l]) => `<button data-v="${k}" class="${(a.look || "classic") === k && (k !== "retro" || !locked()) ? "on" : ""}" ${k === "retro" && locked() ? 'data-lock="retro"' : ""}>${l}${k === "retro" ? " " + proTag() : ""}</button>`).join("")}</div>
        <label class="lbl" style="margin-top:12px">Colors (Classic look)</label><div class="seg" id="theme">${[["system", "Automatic"], ["light", "Light"], ["dark", "Dark"]].map(([k, l]) => `<button data-v="${k}" class="${(a.theme || "system") === k ? "on" : ""}">${l}</button>`).join("")}</div>`)}</section>`;
  }
  const srcs = E.SOURCE_ORDER.filter(n => (!E.PLAY || E.SOURCES[n].play) && E.SOURCES[n].url && (!window.OWN_VALUES_ONLY || n === "dmv"));
  h += `<section class="card">${more("About", `<p class="note">Dynasty Mover helps you judge fantasy football trades with a blend of public player values. ${Pro.ON
      ? "Your leagues and trades stay on this phone; your account only holds your email and your plan." : "It's free, has no ads, and keeps everything on this phone."}</p>
      <div class="sub-h">Data from</div>${srcs.map(n => `<div class="kv"><span>${esc(E.SOURCES[n].label)}</span><a data-link="${esc(E.SOURCES[n].url)}" class="lnk">${esc(E.SOURCES[n].url.replace("https://", ""))}</a></div>`).join("")}
      <div class="kv"><span>Sleeper (leagues, rosters, injuries, trending)</span><a data-link="https://sleeper.com" class="lnk">sleeper.com</a></div>
      <div class="kv"><span>MyFantasyLeague (draft ADP)</span><a data-link="https://www.myfantasyleague.com" class="lnk">myfantasyleague.com</a></div>
      <div class="kv"><span>Bluesky (reporters' posts)</span><a data-link="https://bsky.app" class="lnk">bsky.app</a></div>
      <div class="kv"><span>Weather: National Weather Service, MET Norway</span><a data-link="https://api.met.no" class="lnk">api.met.no</a></div>
      <p class="note muted">${window.OWN_VALUES_ONLY ? "Player values are Dynasty Mover's own, calculated from public NFL stats (nflverse, CC BY 4.0), age and draft slot. Not affiliated with, endorsed by, or sponsored by the NFL, the NFLPA, Sleeper or nflverse." : "Not affiliated with, endorsed by, or sponsored by the NFL, Sleeper, FantasyCalc, DynastyProcess or Fantasy Football Calculator."} Player values are opinions for entertainment, not advice.</p>
      <div class="kv"><span>Privacy policy</span><a data-link="${esc(PRIVACY_URL)}" class="lnk">Read</a></div>
      <div class="kv"><span>Contact</span><span>${esc(CONTACT_EMAIL)}</span></div>`)}</section>
    <p class="foot">Version ${esc(Store.native && Native.version ? Native.version() : (window.APP_VERSION ? window.APP_VERSION + " web" : "dev"))} · Your leagues stay on this ${Store.web ? "device" : "phone"}.</p>`;
  el.innerHTML = h;
  if (Pro.ON) Pro.bindAccount();

  const on = (id, fn) => { const x = $("#" + id); if (x) x.onclick = fn; };
  on("upd", () => runUpdate());
  const lp = $("#lgPick");
  if (lp) lp.onchange = e => switchTo(e.target.value, "league");
  on("reimp", () => runImport(S.values.league.league_id, { refreshOnly: true }));
  on("editTeam", () => rosterBuilder(S.cfg.my_roster_id ?? (teams()[0] || {}).roster_id));
  on("toDraftL", () => { S.rank.pos = "DRAFT"; go("rank"); });
  on("thist", () => historySheet());
  on("power", () => powerSheet());
  on("redoLeague", () => redoLeague());
  on("rmLeague", () => removeLeague(E.P.id, el));
  on("nextSeason", () => nextSeason());
  on("bumpSeason", () => {
    S.cfg.season = parseInt(S.cfg.season) + 1; E.save_config(S.cfg);
    const lgm = Store.get(E.f("league.json"));
    if (lgm && lgm.platform === "manual") { E.manual_roll_season(lgm, parseInt(S.cfg.season, 10)); E.manual_save(lgm, S.values); }   // the draft that happened drops off the pick list
    runUpdate();
  });
  if (S.cfg && !locked()) {
    $("#sType").value = E.league_kind(S.cfg) === "bestball" ? "dynasty_bestball" : S.cfg.league.type === "redraft" ? "redraft" : "dynasty";
    const change = s => {
      const r = E.apply_settings(S.cfg, s), lgm = S.values && S.values.league;
      if (lgm && lgm.platform === "manual" && (s.superflex !== undefined || s.league_type)) {   // the lineup of a hand-built league follows the switches
        const c = E.manual_lineup_counts(lgm);
        if (s.superflex !== undefined) c.SUPER_FLEX = s.superflex ? Math.max(1, c.SUPER_FLEX) : 0;
        if (s.league_type === "redraft" && !c.K && !c.DEF) { c.K = 1; c.DEF = 1; toast("Kicker and defense slots added (League settings > Starting lineup)", 2600); }
        E.manual_set_lineup(lgm, S.cfg, c); E.manual_save(lgm, S.values);
      }
      S.values = S.values ? E.load_values(S.cfg) : null; S.result = null; header(); if (r.feed_changed) runUpdate(); else { toast("Saved"); renderLeague(el); }
    };
    $("#sType").onchange = e => change({ league_type: e.target.value });
    $("#sHalf").onchange = e => change({ half_ppr: e.target.checked });
    $("#sSF").onchange = e => change({ superflex: e.target.checked });
    if ($("#sHide")) $("#sHide").onchange = e => change({ hide_k_def: e.target.checked });
    if ($("#sMarket")) $("#sMarket").onchange = e => change({ use_market: e.target.checked });
    if ($("#sRemind")) $("#sRemind").onchange = e => { Native.reminder(e.target.checked); toast(e.target.checked ? "Every Tuesday at 9, on this phone" : "Reminder off", 1800); };
    $$("[data-slot]", el).forEach(i => i.onchange = () => {                           // the lineup of a league built by hand
      const counts = {}; $$("[data-slot]", el).forEach(x => { counts[x.dataset.slot] = x.value; });
      const lgm = S.values.league; E.manual_set_lineup(lgm, S.cfg, counts); E.manual_save(lgm, S.values);
      S.values = E.load_values(S.cfg); S.result = null; header(); toast("Lineup saved"); renderLeague(el);
    });
    $("#sTE").onchange = e => change({ te_premium_pct: e.target.value });
    if ($("#sQB")) $("#sQB").onchange = e => change({ qb_premium_pct: e.target.value });
    if ($("#sYQB")) $("#sYQB").onchange = e => change({ young_qb_premium_pct: e.target.value });
    if ($("#sQBT")) $("#sQBT").onchange = e => change({ qb_trade_pct: e.target.value });
    if ($("#sTeams")) $("#sTeams").onchange = e => change({ teams: e.target.value });
    $$("[data-src]", el).forEach(c => c.onchange = () => { S.cfg.sources[c.dataset.src] = Object.assign({}, S.cfg.sources[c.dataset.src], { on: c.checked }); E.save_config(S.cfg); toast("Tap Update values to apply"); });
  }
  on("findL", findLeagues);
  const u = $("#sUser");
  if (u) u.onkeydown = e => { if (e.key === "Enter") findLeagues(); };
  on("addId", () => { const id = $("#lid").value.trim(); if (/^\d{6,}$/.test(id)) addSleeper(id); else toast("That doesn't look like a Sleeper league ID."); });
  on("addManual", () => manualSetup($("#mName").value.trim() || "My league", el));
  $$("[data-prof]", el).forEach(it => it.onclick = e => { if (e.target.closest("[data-del]")) return; switchTo(it.dataset.prof); });
  $$("[data-del]", el).forEach(b => b.onclick = () => removeLeague(b.dataset.del, el));
  $$("#theme button").forEach(b => b.onclick = () => { saveApp({ theme: b.dataset.v }); applyTheme(); renderLeague(el); });
  $$("#look button").forEach(b => b.onclick = () => { saveApp({ look: b.dataset.v }); applyTheme(); renderLeague(el); });
}

/* Wait for a background refresh or update to finish before switching or creating a league: the engine writes to the
   league that is active at the time, so a switch in the middle would put one league's data under another's name. */
async function idle(maxMs = 90000) {
  if (!S.auto && !S.busy) return;
  const t0 = Date.now(); toast("Finishing an update…", 1500);
  while ((S.auto || S.busy) && Date.now() - t0 < maxMs) await new Promise(r => setTimeout(r, 200));
}
/* A league built by hand starts with its format (the user's ask, 2026-10-12): dynasty or redraft, the scoring,
   superflex, the number of teams and the starting lineup are chosen here, before any player is added. */
function manualSetup(name, el) {
  const d = E.DEFAULT_CONFIG.league, st = { type: "dynasty", ppr: 1, sf: false, te: 0, teams: d.teams, counts: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, SUPER_FLEX: 0, K: 0, DEF: 0, BN: 16 } };
  const body = openSheet(`<div class="sheet-head"><h2>Set up ${esc(name)}</h2><button class="close" aria-label="Close">×</button></div>
    <p class="note muted" style="margin-top:0">Your league's format first: it shapes the values, the grades, the lineup help and the draft helper. You can change any of it later under League settings.</p>
    <label class="lbl">League type</label><select id="muType"><option value="dynasty">Dynasty</option><option value="dynasty_bestball">Dynasty best ball</option><option value="redraft">Redraft (one season)</option></select>
    <label class="lbl" style="margin-top:12px">Scoring</label><div class="seg" id="muPpr">${[["1", "Full PPR"], ["0.5", "Half PPR"], ["0", "Standard"]].map(([v, l]) => `<button data-v="${v}" class="${v === "1" ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="divide" style="margin-top:10px">
      <label class="switch"><span class="txt">Superflex (2 QBs)</span><input type="checkbox" id="muSF"><span class="track"></span></label>
      <div class="row num-row"><span class="spacer">Tight end bonus %</span><input type="number" id="muTE" min="0" max="100" value="0"></div>
      <div class="row num-row"><span class="spacer">Teams</span><input type="number" id="muTeams" min="4" max="32" value="${esc(d.teams)}"></div>
    </div>
    <label class="lbl" style="margin-top:12px">Starting lineup</label><p class="note muted" style="margin-top:0">How many of each slot your league starts, and the bench.</p>
    <div class="divide" id="muSlots">${LINEUP_SLOTS.map(([k, l]) => `<div class="row num-row"><span class="spacer">${l}</span><input type="number" data-slot="${k}" min="0" max="${k === "BN" ? 40 : 6}" value="${st.counts[k]}"></div>`).join("")}</div>
    <button class="btn primary block big" id="muGo" style="margin-top:16px">Create the league</button>`, { full: true });
  $(".close", body).onclick = closeSheet;
  const slot = k => $(`[data-slot="${k}"]`, body);
  $("#muType", body).onchange = e => {
    st.type = e.target.value;
    if (st.type === "redraft" && !+slot("K").value && !+slot("DEF").value) { slot("K").value = 1; slot("DEF").value = 1; toast("Kicker and defense slots added", 1600); }   // most redraft lineups start both
  };
  $$("#muPpr button", body).forEach(b => b.onclick = () => { st.ppr = parseFloat(b.dataset.v); $$("#muPpr button", body).forEach(x => x.classList.toggle("on", x === b)); });
  $("#muSF", body).onchange = e => { st.sf = e.target.checked; slot("SUPER_FLEX").value = st.sf ? Math.max(1, +slot("SUPER_FLEX").value) : 0; };
  slot("SUPER_FLEX").onchange = e => { st.sf = +e.target.value > 0; $("#muSF", body).checked = st.sf; };
  $("#muGo", body).onclick = async () => {
    const counts = {}; $$("[data-slot]", body).forEach(x => { counts[x.dataset.slot] = x.value; });
    await idle();                                            // a background refresh of the open league must finish first: its files are written to whichever league is active
    const te = $("#muTE", body).value, teams = $("#muTeams", body).value;
    const pid = E.profile_new(name);
    E.set_profile(pid);
    S.cfg = E.P.cfg; S.cfg.league.name = name; S.cfg.my_roster_id = 1;
    E.apply_settings(S.cfg, { league_type: st.type, ppr: st.ppr, superflex: st.sf, te_premium_pct: te, teams });
    E.save_config(S.cfg);
    const lgm = E.manual_league(S.cfg, name); E.manual_set_lineup(lgm, S.cfg, counts); E.manual_add_team(lgm, "My team"); E.manual_save(lgm, null);   // one team to start: yours
    closeSheet(); loadActive(); header(); renderLeague(el);
    await runUpdate();
    if (E.P.id === pid && S.values) { S.team.id = 1; go("team"); rosterBuilder(1); }
  };
}
/* Live win probability on game days: Sleeper's live points plus our projection for what is left (week.js live_matchup).
   Drawn into #liveCard on the lineup, refreshed every two minutes while that screen is open. */
const LIVE_EVERY = 2 * 60000;
async function liveCard(body, t, W) {
  const box = $("#liveCard", body); if (!box || t.roster_id !== S.cfg.my_roster_id) return;
  if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = null; }
  const draw = async () => {
    if (!box.isConnected) { clearInterval(S.liveTimer); S.liveTimer = null; return; }
    let L = null; try { L = await Week.live_matchup(S.values, S.cfg, W, t); } catch (e) { L = null; }
    if (!L || !L.started) { box.innerHTML = ""; return; }
    const pct = Math.round(L.p * 100), tone = pct >= 60 ? "good" : pct <= 40 ? "bad" : "";
    const line = s => `${s.actual.toFixed(1)}${L.final ? "" : ` → ${s.mean.toFixed(1)}`}`;
    box.innerHTML = `<section class="card tone-green live-card"><div class="kicker">${L.final ? `Week ${L.week}: final` : `Live, week ${L.week}`}</div>
      <div class="live-row"><div><div class="big-num ${tone}">${L.final ? (L.p >= 0.5 ? "Won" : "Lost") : pct + "%"}</div><div class="hint">${L.final ? "" : "chance to win"}</div></div>
        <div class="live-sides"><div class="kv"><span>You</span><b>${line(L.me)}</b></div><div class="kv"><span>${esc(L.opponent)}</span><b>${line(L.them)}</b></div></div></div>
      ${L.final ? "" : `<div class="hint">${L.me.playing ? `${L.me.playing} of yours playing now` : ""}${L.me.playing && L.me.left ? ", " : ""}${L.me.left ? `${L.me.left} still to play` : ""}${!L.me.playing && !L.me.left ? "Your starters are done" : ""}. Points so far from Sleeper; the rest from our projections. Updates every two minutes.</div>`}</section>`;
  };
  await draw();
  if (box.innerHTML) S.liveTimer = setInterval(draw, LIVE_EVERY);
}
/* League power rankings: every team's rank by overall value, starters, each position and picks, coloured by thirds.
   Tap a column head to sort by it, a row to open that team on My team. */
const PR_COLS = [["overall", "OVR"], ["starters", "STR"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["picks", "PK"]];
// the three views (2026-10-16): our power rating first, then points scored, then the projected finish
const PR_MODES = [["power", "Our rank", "PWR"], ["points", "Points", "PTS"], ["proj", "Projected", "PROJ"]];
function powerSheet() {
  if (!S.values || !teams().length) return;
  S.pr = S.pr && S.pr.mode ? S.pr : { mode: "power", sort: "power" };
  const body = openSheet(`<div class="sheet-head"><h2>Power rankings</h2><button class="close" aria-label="Close">×</button></div><div id="prBody"></div>`, { full: true });
  $(".close", body).onclick = closeSheet;
  const draw = () => {
    const P = Week.power_rankings(S.values, S.cfg), cols = PR_COLS.filter(([k]) => P.cols.includes(k)), third = Math.max(1, Math.ceil(P.n / 3));
    const modes = PR_MODES.filter(([k]) => (k !== "points" || P.games > 0) && (k !== "proj" || P.hasProj));
    if (!modes.some(([k]) => k === S.pr.mode)) S.pr = { mode: "power", sort: "power" };
    const mode = S.pr.mode, head = PR_MODES.find(([k]) => k === mode)[2];
    const rows = P.rows.slice().sort((a, b) => (a.rank[S.pr.sort] || 99) - (b.rank[S.pr.sort] || 99));
    const pctx = x => (x >= 0.995 ? ">99%" : x > 0 && x < 0.005 ? "<1%" : `${Math.round(x * 100)}%`);
    const lead = r => mode === "points" ? `<div class="pr-val">${Math.round(r.pf)}</div><div class="pr-sub">${r.ppg.toFixed(1)} a wk</div>`
      : mode === "proj" ? (r.proj ? `<div class="pr-val">${esc(r.proj.record)}</div><div class="pr-sub">${pctx(r.proj.playoff)} playoffs</div>` : "")
      : `<div class="pr-val">${r.power}</div>${P.games ? `<div class="pr-sub">${Math.round(r.allplay * 100)}% all-play</div>` : ""}`;
    const why = mode === "points" ? "Points scored this season, and per week."
      : mode === "proj" ? `The projected final record and the chance of making the playoffs, from 3,000 run-throughs of the ${P.weeksLeft ? `${P.weeksLeft} weeks left on the real schedule` : "season"}.`
      : `Our rank, 0 to 100: points per week, the all-play record (each week's score against every team, so schedule luck doesn't count), the record and the best lineup now${P.redraft ? "" : ", plus the whole roster with picks"}. ${P.games > 4 ? "Results now count more than the lineup." : "Early on, the lineup counts most."}`;
    const chip = r => `<span class="pr-chip ${r <= third ? "pr-hi" : r > P.n - third ? "pr-lo" : "pr-mid"}">${r}</span>`;   // not "top": the header's class
    const tierCls = m => (m === "contending" ? "pr-hi" : m === "rebuilding" || m === "long shot" ? "pr-lo" : "pr-mid");
    // fits a phone with no sideways scroll (a pinned column broke in the app's web view, 2026-10-15): record and tier
    // sit under the team name, the columns are short heads with small chips
    $("#prBody", body).innerHTML = `${modes.length > 1 ? `<div class="seg pr-seg" id="prSeg">${modes.map(([k, l]) => `<button data-m="${k}" class="${mode === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
      <div class="hint" style="margin-bottom:8px">${esc(why)} The colored chips rank roster value: OVR the whole roster${P.redraft ? "" : " with picks"}, STR the best lineup, then each position${P.redraft ? "" : ", PK the picks"}. Tap a column to sort, a team to open it.</div>
      <table class="pr"><thead><tr><th class="pr-team">Team</th><th data-sort="${mode}" class="pr-lead ${S.pr.sort === mode ? "on" : ""}">${head}</th>${cols.map(([k, l]) => `<th data-sort="${k}" class="${S.pr.sort === k ? "on" : ""}">${l}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-rid="${r.rid}"><td class="pr-team"><div class="n"><span class="pr-no">${i + 1}</span> ${esc(r.team)}${r.rid === S.cfg.my_roster_id ? ' <span class="tag-start">You</span>' : ""}</div>
        <div class="s">${esc(r.record)} · <span class="pr-tier ${tierCls(r.mode)}">${esc(r.tier)}</span></div></td><td class="pr-lead">${lead(r)}</td>${cols.map(([k]) => `<td>${chip(r.rank[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>
      ${credits()}`;
    $$("th[data-sort]", body).forEach(th => th.onclick = () => { S.pr.sort = th.dataset.sort; draw(); });
    $$("#prSeg button", body).forEach(b => b.onclick = () => { S.pr = { mode: b.dataset.m, sort: b.dataset.m }; draw(); });
    $$("tr[data-rid]", body).forEach(tr => tr.onclick = () => { S.team.id = +tr.dataset.rid; S.team.seg = "roster"; saveUi(); closeSheet(); go("team"); });
  };
  draw();
}
/* The scorecard: how right the app has been, from score.js. Shown once a played week is on record. */
function scoreCard() {
  // plain words first (the user's ask, 2026-10-15): one headline sentence, a short table, two short lines
  let R = null;
  try { R = Score.report(S.cfg, S.values, S.W); } catch (e) { R = null; }
  const tc = tradeCalls(), A = S.W && S.W.acc;
  if (!S.W && !S.accAsked && S.cfg) { S.accAsked = true; weekData().then(() => { if (S.tab === "league" && !sheetOpen()) renderLeague($("#view")); }).catch(() => {}); }   // the projection record needs the week's data once
  const hasA = !!(A && A.weeks.length && A.all);
  if (!R && !tc && !hasA) return "";
  R = R || { lastLineup: null, seasonLineup: null, grades: [], weeks: [], last: null };
  const pct = x => `${Math.round(x * 100)}%`, pts = x => `${x.toFixed(1)} pts`;
  let h = "";
  if (hasA) {
    const right = A.all.close, miss = A.all.mae;
    h += `<div class="sc-big"><b>${pct(right)}</b><span>of our weekly point estimates landed within 5 points of what the player scored. On average we missed by ${pts(miss)}.</span></div>
      <table class="acc"><thead><tr><th>Week</th><th>Close</th><th>Missed by</th><th>Our estimates were</th></tr></thead><tbody>
      ${A.weeks.map(r => `<tr><td>${r.w}</td><td>${pct(r.close)}</td><td>${pts(r.mae)}</td><td class="${Math.abs(r.bias) < 0.5 ? "" : r.bias > 0 ? "warn" : "warn"}">${Math.abs(r.bias) < 0.5 ? "about right" : r.bias > 0 ? `too low by ${r.bias.toFixed(1)}` : `too high by ${(-r.bias).toFixed(1)}`}</td></tr>`).join("")}
      </tbody></table>`;
    const up = [], down = [], NAME = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };
    if (A.use) for (const [pos, c] of Object.entries(A.calib)) { if (c.n < 25) continue; const d = c.a + c.b * 10 - 10; if (d >= 0.5) up.push(NAME[pos]); else if (d <= -0.5) down.push(NAME[pos]); }
    const adj = !A.gain ? "Not enough weeks yet to fine-tune this week's estimates."
      : !A.use ? "This week's estimates are left as they are: fine-tuning from past weeks wasn't making them better."
      : up.length || down.length ? `This week's estimates are fine-tuned from that record: ${[up.length ? `${up.join(" and ")} nudged up` : "", down.length ? `${down.join(" and ")} nudged down` : ""].filter(Boolean).join(", ")}, because that is how they've run.`
      : "This week's estimates match how past weeks ran, so no fine-tuning was needed.";
    h += `<p class="note" style="margin-top:8px">"Close" means within 5 points either way. Each week is checked against what we would have said before kickoff.</p><p class="note">${esc(adj)}</p>`;
  }
  const rows = [];
  const l1 = R.lastLineup, ls = R.seasonLineup;
  if (l1) rows.push(`<div class="kv"><span>Our lineup, week ${R.last}</span><b>${pts(l1.got)} of a possible ${pts(l1.best)}</b></div>`);
  if (ls && ls.n > 1) rows.push(`<div class="kv"><span>Our lineups, season</span><b>${pct(ls.eff)} of the best possible</b></div>`);
  if (R.grades.length >= 2) rows.push(`<div class="kv"><span>Points a game by our grade</span><b>${R.grades.map(g => `${g.g} ${g.ppg.toFixed(1)}`).join(" · ")}</b></div>`);
  if (tc) rows.push(`<div class="kv"><span>Trade calls</span><b>right ${pct(tc.agree / tc.n)} of the time (${tc.agree} of ${tc.n})</b></div>`);
  if (rows.length) h += `<div class="sub-h" style="margin-top:14px">Lineups, grades and trades</div>${rows.join("")}<p class="note muted" style="margin-top:6px">A trade call is right when the side we favoured went on to score more.</p>`;
  if (!h) return "";
  return `<section class="card tone-green"><h2>How right we've been</h2><div class="hint">Our numbers against what really happened.</div><div style="margin-top:10px">${h}</div></section>`;
}
/* Trade calls right: in the league's trades with a 5%+ edge by our values and games played since, how often the side
   we favoured went on to score more (needs the trade history loaded once: the History sheet, or the daily market fit). */
function tradeCalls() {
  const D = S.hist && S.hist.data; if (!D || !D.trades) return null;
  let agree = 0, n = 0;
  for (const t of D.trades) {
    if (!t.sides || t.sides.length !== 2) continue;
    const [A, B] = t.sides, va = A.sum.now, vb = B.sum.now, pa = A.sum.pts, pb = B.sum.pts;
    if ((A.sum.g || 0) + (B.sum.g || 0) < 6 || Math.max(va, vb) === 0 || Math.abs(va - vb) / Math.max(va, vb) < 0.05) continue;
    n++; if ((va > vb) === (pa > pb)) agree++;
  }
  return n >= 5 ? { agree, n } : null;
}
/* A player's last weeks on a row (2026-10-19): our estimate, then what he scored, green when he beat it and red
   when he fell short. From the projection record; nothing for a player we had no estimate for. */
const PW_LEGEND = `<span class="grp-note pw-key">last 3 wks: our estimate, what he scored</span>`;
/* Lineup rows (2026-10-19): last week's grade, what we predicted and what he scored. */
function lastWeekLine(a, W) {
  if (!a || !W || !W.acc || !W.week || W.week < 2) return "";
  const g = Week.past_week_grades(S.values, S.cfg, W, W.week - 1)[String(a.sleeper_id || "")];
  if (!g) return `<div class="lw"><span class="lw-l">Last wk</span><span class="muted">no game</span></div>`;
  return `<div class="lw" title="Week ${W.week - 1}: graded ${g.letter} (${esc(a.pos)}${g.posRank}), we said ${g.said.toFixed(1)}, he scored ${g.got.toFixed(1)}"><span class="lw-l">Last wk</span><span class="grade sm ${g.cls}">${esc(g.letter)}</span><span>said ${g.said.toFixed(1)}</span><span>got <b class="${g.got >= g.said ? "up" : "dn"}">${g.got.toFixed(1)}</b></span></div>`;
}
function pastWeeks(a, n = 3) {
  try {
    const per = a && S.W && S.W.acc && S.W.acc.per && S.W.acc.per[String(a.sleeper_id || "")];
    if (!per) return "";
    const ws = Object.keys(per).map(Number).sort((x, y) => y - x).slice(0, n);
    if (!ws.length) return "";
    return `<div class="pw">${ws.map(w => { const [e, got] = per[w]; return `<span class="pw-c ${got >= e ? "up" : "dn"}" title="Week ${w}: we said ${e.toFixed(1)}, he scored ${got.toFixed(1)}"><i>W${w}</i>${e.toFixed(1)} <b>${got.toFixed(1)}</b></span>`; }).join("")}</div>`;
  } catch (e) { return ""; }
}
/* Our estimate against what he scored, his last weeks (the projection record), else the live snapshot. */
const lastCallHtml = a => {
  try {
    const per = S.W && S.W.acc && S.W.acc.per && S.W.acc.per[String(a.sleeper_id || "")];
    if (per) { const ws = Object.keys(per).map(Number).sort((x, y) => y - x).slice(0, 3); if (ws.length) return `<div class="bg-scope">What we said vs what he scored: ${ws.map(w => `wk ${w}: ${per[w][0].toFixed(1)} vs ${per[w][1].toFixed(1)}`).join(" · ")}</div>`; }   // newest first, plain words
    const c = Score.lastCall(S.cfg, S.values, a, S.W); return c ? `<div class="bg-scope">Week ${c.week}: we said ${c.said.toFixed(1)}, he scored ${c.got.toFixed(1)}</div>` : "";
  } catch (e) { return ""; }
};
/* The screenshot import: shrink the picture, send it to the Worker's vision route, match the names it returns to
   Sleeper's list (the value lists first, then the pool for kickers, defenses and deep benches), and show the review list. */
async function importScreenshot(file, lg, t, B, poolPos, free, redraw) {
  const box = $("#rbBody"), say = m => { if (box) box.innerHTML = loading(m); };   // inline: the builder is itself a sheet
  const P = { log: say, done: (ok, m) => { if (!ok) { toast(m, 3000); redraw(); } } };
  try {
    P.log("Shrinking the picture…");
    const image = await shrinkImage(file, 1400, 0.82);
    P.log("Asking the model who is in it…");
    const token = await GM.authToken();
    const r = await Net.request("POST", GM.endpoint() + "/roster", { image, mime: "image/jpeg" }, { Authorization: "Bearer " + token });
    let body = null; try { body = JSON.parse(r.body); } catch (e) { body = null; }
    if (r.status !== 200 || !body) throw new Error((body && body.error) || `The server answered ${r.status || "nothing"}.`);
    P.log(`${(body.players || []).length} players read. Matching…`);
    const items = [];
    for (const p of body.players || []) {
      const want = p.pos && ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos) ? [p.pos] : poolPos;
      let hits = E.search_players(p.name, S.values, 4).filter(a => want.includes(a.pos));
      if (!hits.length) hits = (await E.pool_search(p.name, S.values, 4, want).catch(() => []));
      if (!hits.length && p.pos === "DEF" && p.team) hits = (await E.pool_search(p.team, S.values, 2, ["DEF"]).catch(() => []));
      const exact = hits.find(a => E.norm(a.name) === E.norm(p.name)), match = exact || hits.find(a => !p.team || !a.team || a.team === p.team) || hits[0] || null;
      items.push({ name: p.name, pos: p.pos, team: p.team, match: match && free(match) ? match : null, on: !!(match && free(match)) });
    }
    toast(`${items.filter(x => x.match).length} of ${items.length} matched`, 1800);
    B.review = { items, raw: body.raw || "" }; redraw();
  } catch (e) { P.done(false, e.message || "Couldn't read the screenshot."); }
}
function shrinkImage(file, maxSide, quality) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That file isn't a picture the phone can open.")); };
    img.src = url;
  });
}
/* The lineup editor of a league built by hand: how many of each slot it starts, and the bench. */
const LINEUP_SLOTS = [["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"], ["FLEX", "Flex (RB/WR/TE)"], ["SUPER_FLEX", "Superflex (any)"], ["K", "Kicker"], ["DEF", "Defense"], ["BN", "Bench"]];
function lineupRows(lg) {
  const c = E.manual_lineup_counts(lg);
  return `<label class="lbl" style="margin-top:12px">Starting lineup</label><p class="note muted">How many of each slot your league starts. Kickers and defenses show in the app once the lineup has a slot for them.</p><div class="divide">` +
    LINEUP_SLOTS.map(([k, l]) => `<div class="row num-row"><span class="spacer">${l}</span><input type="number" data-slot="${k}" min="0" max="${k === "BN" ? 40 : 6}" value="${c[k]}"></div>`).join("") + `</div>`;
}
async function findLeagues() {
  const user = $("#sUser").value.trim(), box = $("#lres");
  if (!user) return toast("Type your Sleeper username first");
  box.innerHTML = loading("Looking up your leagues…");
  try {
    const st = await Net.json("https://api.sleeper.app/v1/state/nfl").catch(() => ({}));
    const season = parseInt(st.league_season || st.season || new Date().getFullYear());
    const r = await E.sleeper_user_leagues(user, season);
    saveApp({ sleeper: { username: r.user.username || user, user_id: r.user.user_id } });
    const have = E.load_profiles().profiles;
    box.innerHTML = r.leagues.length ? r.leagues.map(l => `<div class="item" data-lg="${esc(l.id)}"><div class="nm"><div class="n">${esc(l.name)}</div><div class="s">${esc(E.title(l.type))} · ${l.teams} teams</div></div>
      ${have[l.id] ? `<span class="tag-start">Added</span>` : `<button class="btn primary sm">Add</button>`}</div>`).join("") : `<div class="empty">No ${season} leagues found for ${esc(user)}.</div>`;
    $$("[data-lg]", box).forEach(it => it.onclick = () => { if (!have[it.dataset.lg]) addSleeper(it.dataset.lg); else switchTo(it.dataset.lg); });
  } catch (e) { box.innerHTML = `<div class="empty">Couldn't find "${esc(user)}" on Sleeper. Check the spelling.</div>`; }
}

async function switchTo(pid, tab = "home") {
  await idle();
  if (locked() && pid !== E.load_profiles().active) return Pro.lock("leagues"); E.set_profile(pid); loadActive(); header(); go(tab); toast(`Opened ${(E.load_profiles().profiles[pid] || {}).name}`); setTimeout(autoRefresh, 300); }   // the opened league's values may be stale or from an older formula

/* A simple progress sheet: one line of status, a spinner, and the full log folded away. */
function progressSheet(titleTxt) {
  const body = openSheet(`<div class="progress"><span class="spin big" id="pspin"></span><h2>${esc(titleTxt)}</h2><div class="hint" id="pnow">Starting…</div>
    ${more("Show details", `<div class="log" id="plog"></div>`)}<button class="btn primary block hidden" id="pdone">Done</button></div>`);
  const log = m => {
    const l = $("#plog", body);
    if (l) { l.textContent += m + "\n"; l.scrollTop = l.scrollHeight; }
    const n = $("#pnow", body);
    if (n && m.trim()) n.textContent = m.replace(/ \.\.\.$/, "…");
  };
  const done = (ok, msg) => {
    const sp = $("#pspin", body);
    if (sp) sp.outerHTML = `<span class="done-mark ${ok ? "ok" : "fail"}">${ok ? "✓" : "!"}</span>`;
    const n = $("#pnow", body);
    if (n) n.textContent = msg;
    const b = $("#pdone", body);
    if (b) { b.classList.remove("hidden"); b.textContent = ok ? "Done" : "Close"; b.onclick = closeSheet; }
  };
  return { log, done };
}

async function runUpdate() {
  if (S.busy || !S.cfg) return;
  const wait = E.update_wait_minutes(S.cfg);
  if (wait > 0) { toast(`Values are fresh. You can update again in ${plural(wait, "minute")}.`, 3500); return; }
  S.busy = true;
  const P = progressSheet("Updating player values");
  try {
    const r = await E.update_values(S.cfg, P.log);
    S.values = E.load_values(S.cfg);
    S.W = null;
    P.done(true, `Values for ${fmt(r.players)} players and ${r.picks} picks are up to date.`);
  } catch (e) { P.done(false, "Couldn't update. Check your internet connection and try again."); P.log(e.message); }
  S.busy = false;
  header(); go(S.tab);
}

async function addSleeper(leagueId) {
  leagueId = String(leagueId || "").trim();
  await idle();
  if (!/^\d{6,}$/.test(leagueId)) { toast("Pick a league first."); return; }       // never create a "Sleeper league undefined" profile
  if (locked() && Object.keys(E.load_profiles().profiles).length) return Pro.lock("leagues");
  const have = E.load_profiles().profiles[leagueId];
  if (!have) E.profile_new("Sleeper league " + leagueId, leagueId);
  E.set_profile(leagueId);
  S.cfg = E.P.cfg;
  await runImport(leagueId, { fresh: !have });
}

async function runImport(leagueId, opts = {}) {
  if (S.busy) return;
  S.busy = true;
  const P = progressSheet(opts.refreshOnly ? "Refreshing rosters" : "Adding your league");
  try {
    const uid = (app().sleeper || {}).user_id;
    const r = await E.sleeper_import(S.cfg, leagueId, P.log, uid);
    loadActive();
    if (!S.values || r.feed_changed || (opts.fresh && !E.update_wait_minutes(S.cfg))) {
      P.log("Downloading player values ...");
      await E.update_values(S.cfg, P.log);
      loadActive();
    }
    const me = teamById(S.cfg.my_roster_id);
    P.done(true, opts.refreshOnly ? "Rosters are up to date." : `${r.league.name} is ready.${me ? ` Your team: ${me.team_name}.` : " Pick your team on the My team tab."}`);
  } catch (e) { P.done(false, "Couldn't reach Sleeper. Check the connection and try again."); P.log(e.message); }
  S.busy = false;
  header(); go(opts.refreshOnly ? S.tab : "home");
}

async function nextSeason() {
  const lg = S.values.league, user = app().sleeper;
  if (!user) { toast("Find your leagues with your Sleeper username first."); return; }
  try {
    const r = await E.sleeper_user_leagues(user.username, lg.season + 1);
    const next = r.leagues.find(l => String(l.previous) === String(lg.league_id));
    if (!next) { toast(`Your league hasn't renewed for ${lg.season + 1} on Sleeper yet.`, 4500); return; }
    confirmSheet(`Switch to the ${lg.season + 1} season?`, `"${next.name}" has renewed on Sleeper. Your history is kept.`, "Switch",
      () => runImport(next.id, { fresh: true }), false);   // new season: pick years roll, so always re-download values
  } catch (e) { toast("Couldn't reach Sleeper. Try again.", 4000); }
}

/* A small yes/no sheet in the app's own style (the WebView's confirm box looks foreign). */
function confirmSheet(title, text, okLabel, onOk, danger = true) {
  const body = openSheet(`<div class="sheet-head"><h2>${esc(title)}</h2><button class="close" aria-label="Close">×</button></div>
    <p class="note">${esc(text)}</p>
    <div class="btns" style="margin-top:14px"><button class="btn ghost" id="cfNo">${danger ? "Keep it" : "Not now"}</button><button class="btn ${danger ? "danger" : "primary"}" id="cfOk">${esc(okLabel)}</button></div>`);
  $(".close", body).onclick = closeSheet;
  $("#cfNo", body).onclick = closeSheet;
  $("#cfOk", body).onclick = () => { S.sheetStack = []; closeSheet(); onOk(); };
}
/* Remove a league and everything saved for it on this phone: settings, values, rosters, value history, saved trades,
   trade history and GM chats (every "L.<id>." file). The next league, if any, opens. */
function removeLeague(pid, el) {
  if (!pid) return;
  const name = (E.load_profiles().profiles[pid] || {}).name || "this league";
  confirmSheet(`Remove ${name}?`, "Its values, rosters, value history, saved trades and trade history on this phone go with it. You can add it again any time from the League tab.", "Remove", () => {
    E.profile_delete(pid);
    S.hist = null;
    loadActive(); header();
    if (S.tab === "league" && el && el.isConnected) renderLeague(el); else go("league");
    toast(`Removed ${name}`);
  });
}
/* Start the open league over: remove everything saved for it, then download it again from Sleeper (for glitches). */
function redoLeague() {
  const lg = S.values && S.values.league;
  if (!lg || !lg.league_id) return;
  const pid = E.P.id, lid = String(lg.league_id), name = lg.name;
  confirmSheet(`Start ${name} over?`, "Everything saved for it on this phone is removed (settings, values, value history, saved trades, trade history, GM chats), then the league is downloaded again from Sleeper.", "Start over", () => {
    E.profile_delete(pid);
    S.hist = null;
    loadActive(); header();
    addSleeper(lid);
  }, false);
}

/* The League tab with its settings fold open and in view (from the header's league menu, the user's ask 2026-10-12). */
function openLeagueSettings() {
  go("league");
  const d = $$("#view details.more").find(x => /League settings/.test((x.querySelector("summary") || {}).textContent || ""));
  if (!d) return;
  d.open = true;
  setTimeout(() => d.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}
function leaguesSheet() {
  const p = E.load_profiles();
  if (!Object.keys(p.profiles).length) { go("league"); return; }
  const body = openSheet(`<div class="sheet-head"><h2>Your leagues</h2><button class="close" aria-label="Close">×</button></div><div class="list">${Object.entries(p.profiles).map(([id, pr]) =>
    `<div class="item" data-sw="${esc(id)}"><div class="nm"><div class="n">${esc(pr.name)}</div></div>${id === p.active ? '<b class="good">✓</b>' : ""}</div>`).join("")}</div>
    <div class="btns" style="margin-top:12px"><button class="btn ghost" id="swSettings">League settings</button><button class="btn ghost" id="swAdd">+ Add a league</button></div>`);
  $(".close", body).onclick = closeSheet;
  $$("[data-sw]", body).forEach(it => it.onclick = () => { closeSheet(); switchTo(it.dataset.sw); });
  $("#swAdd").onclick = () => { closeSheet(); go("league"); };
  $("#swSettings").onclick = () => { closeSheet(); openLeagueSettings(); };
}

// ---------------------------------------------------------------------------
// Automatic refresh: whenever the app opens or comes back to the screen, quietly refresh rosters
// (if older than 15 minutes) and player values (if older than 6 hours; FantasyCalc allows once an hour).
// ---------------------------------------------------------------------------
const ROSTERS_EVERY = 3 * 60000, VALUES_EVERY = 60 * 60000;    // on open: rosters after 3 min (a lineup set in Sleeper shows at once), values after an hour (FantasyCalc's rule)
async function autoRefresh() {
  if (S.busy || S.auto || !S.cfg || !navigator.onLine) return;
  const pid = E.P.id, lg = S.values && S.values.league;
  const age = iso => iso ? Date.now() - new Date(iso).getTime() : Infinity;
  const rosters = !!lg && !!lg.league_id && age(lg.imported) > ROSTERS_EVERY;   // leagues built by hand have nothing to fetch
  const modelNew = E.model_changed(S.values);                    // a new value formula: rebuild now, whatever the age
  const values = (!S.values || modelNew || age(S.values.meta.fetched) > VALUES_EVERY) && (modelNew || !E.update_wait_minutes(S.cfg));
  const injuries = E.injuries_due();                             // the NFL's injury report: every 2 hours on game days, 6 otherwise
  if (!rosters && !values && !injuries) return;
  S.auto = true;
  $("#sync").classList.remove("hidden");
  let changed = false, updated = false;
  try {
    if (rosters) {
      const r = await E.sleeper_import(S.cfg, lg.league_id, () => {}, (app().sleeper || {}).user_id);
      changed = true;
      if (r.feed_changed && !E.update_wait_minutes(S.cfg)) { await E.update_values(S.cfg, () => {}); }
    }
    if (values && E.P.id === pid && (modelNew || !E.update_wait_minutes(S.cfg))) { await E.update_values(S.cfg, () => {}); changed = true; updated = true; }
    if (injuries) { const n = await E.refresh_injuries(parseInt(S.cfg.season, 10)); if (n) { changed = true; S.injNews = n; } }
  } catch (e) { /* offline or a source hiccup: try again next time the app opens */ }
  S.auto = false;
  $("#sync").classList.add("hidden");
  if (changed && E.P.id === pid) refreshInPlace();
  if (updated && E.P.id === pid) toast("Values updated", 1800);
  else if (S.injNews && E.P.id === pid) toast(`Injury report: ${plural(S.injNews, "player")} updated`, 1800);
  S.injNews = 0;
  refreshMarket().catch(() => {});
}
/* This league's market, refitted from its trades once a day (Sleeper leagues only). */
async function refreshMarket() {
  const lg = S.values && S.values.league, pid = E.P.id;
  if (!lg || !lg.league_id || E.is_redraft(S.cfg) || !navigator.onLine) return;
  const m = Hist.market_cached();
  if (m && Date.now() - new Date(m.at).getTime() < 24 * 3600000) return;
  const hist = await Hist.ensure(S.cfg, lg, {}), data = await Hist.outcomes(S.cfg, S.values, hist);
  if (E.P.id !== pid) return;
  Hist.market_save(Hist.market_fit(data.trades, parseInt(S.cfg.season, 10))); S.result = null;
  S.hist = S.hist || { seg: null, data: null, at: 0, key: null, token: null };    // the scorecard's trade-call rate reads it
  S.hist.data = data; S.hist.at = Date.now();
}
/* The market line: "QB +12%, picks -6% (from 23 trades)". Empty until the league has enough trades. */
function marketText() {
  const m = typeof Hist !== "undefined" && Hist.market_cached();
  if (!m) return "";
  if (!m.mults) return `This league's market: not enough trades yet (${m.n} of ${Hist.MARKET_MIN} needed).`;
  const parts = Object.entries(m.mults).filter(([, x]) => Math.abs(x - 1) >= 0.02).map(([p, x]) => `${p === "PICK" ? "picks" : p} ${x >= 1 ? "+" : ""}${Math.round((x - 1) * 100)}%`);
  return `This league's market, from ${m.n} trades${m.seasons && m.seasons.length > 1 ? ` since ${m.seasons[0]}` : ""}: ${parts.length ? parts.join(", ") : "pays about what our values say"}.`;
}
/* Reload values and league without losing the trade being built, the tab, or the scroll position. */
function refreshInPlace() {
  const keep = Object.fromEntries(["A", "B"].map(k => [k, S.sides[k].items.map(a => a.id)]));
  const hadResult = !!S.result;
  S.values = E.load_values(S.cfg);
  S.W = null;
  for (const k of ["A", "B"]) { const items = keep[k].map(id => sideAsset(k, id)).filter(Boolean); if (items.length < keep[k].length) S.sidesDropped = (S.sidesDropped || 0) + keep[k].length - items.length; S.sides[k].items = items; }
  header();
  if (sheetOpen()) return;                                  // don't redraw under an open card or picker
  const y = window.scrollY;
  go(S.tab);
  if (hadResult && S.tab === "trade" && S.sides.A.items.length && S.sides.B.items.length) analyze(false);
  window.scrollTo(0, y);
}
/* A notification tap: the GM tab with this week's report. */
window.onOpenReport = () => { if (!S.cfg || !S.values) return; go("gm"); setTimeout(() => { try { GM.openReport(); } catch (e) { /* not signed in, or no league */ } }, 500); };
window.onAppResume = () => {
  if (Pro.ON) Pro.resume();
  if (!(Pro.ON && Pro.gated())) setTimeout(autoRefresh, 400);
  if (typeof Update !== "undefined") Update.check().then(() => Update.banner()).catch(() => {});   // a newer beta build on the site?
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") window.onAppResume(); });
window.addEventListener("online", () => window.onAppResume());

// ---------------------------------------------------------------------------
// Navigation and start-up
// ---------------------------------------------------------------------------
function go(tab) {
  S.tab = tab;
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const el = $("#view");
  document.body.classList.toggle("gm-on", tab === "gm");
  document.body.classList.toggle("on-league", tab === "league");
  ({ home: renderHome, trade: renderTrade, rank: renderRank, team: renderTeam, league: renderLeague, gm: el => GM.render(el) })[tab](el);
  window.scrollTo(0, 0);
}
$$("#tabs button").forEach(b => b.onclick = () => go(b.dataset.tab));

applyTheme();
loadActive();
header();
if (Pro.ON) Pro.start();                                   // Pro edition: sign-in, trial or paywall first (pro.js)
else { go("home"); setTimeout(autoRefresh, 800); }
if (typeof Update !== "undefined") setTimeout(() => Update.check().then(() => Update.banner()).catch(() => {}), 2500);   // the beta updater (store/BETA.md)
setTimeout(() => {                                          // the stats behind points-by-week and the starting-QB grade floor
  if (!S.cfg || !navigator.onLine) return;
  const season = parseInt(S.cfg.season, 10), had = !!Store.get(`nflv_wk_${season}.json`);
  Promise.all([E.nflv_stats(season, true, 12), E.nflv_stats(season - 1, false, 24 * 30)])
    .then(() => { qbPace = null; if (!had && !sheetOpen() && !(Pro.ON && Pro.gated())) go(S.tab || "home"); }, () => {});
}, 2500);
