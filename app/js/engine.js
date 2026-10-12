/* Dynasty Trade Analyzer engine for the phone: a JavaScript port of trade_analyzer.py.
   Function names match the Python (snake_case on purpose) so a change on one side is easy to carry to
   the other. Values files have the same shape as the Python tool's data\values.json. */
"use strict";

const E = (() => {

// ---------------------------------------------------------------------------
// Constants (trade_analyzer.py top of file)
// ---------------------------------------------------------------------------
const FC_URL = "https://api.fantasycalc.com/values/current";
const SLEEPER_URL = "https://api.sleeper.app/v1";
const POSITIONS = ["QB", "RB", "WR", "TE"];
const HIDDEN_POSITIONS = ["K", "DEF", "DST", "P"];
const MODES = ["neutral", "contend", "rebuild"];
const FLEX_ELIGIBLE = {
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"], SF: ["QB", "RB", "WR", "TE"],
};

const DEFAULT_CONFIG = {
  season: new Date().getMonth() >= 2 ? new Date().getFullYear() : new Date().getFullYear() - 1,
  league: {
    name: "My Dynasty League", type: "dynasty", teams: 12, num_qbs: 1, ppr: 1, te_premium_bonus_pct: 0,
    sf_qb_bonus_pct: 15, sf_young_qb_bonus_pct: 10, qb_bonus_pct: 8, qb_trade_bump_pct: 15, hide_k_def: true, roster_size: 25,
    starters: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX"],
  },
  sources: {
    fantasycalc: { on: true, weight: 1.0 }, keeptradecut: { on: true, weight: 1.0 }, dynastydaddy: { on: true, weight: 0.5 },
    dynastyprocess: { on: true, weight: 1.0 }, fantasypros: { on: true, weight: 0.5 }, draftsharks: { on: true, weight: 0.5 },
    ffcalculator: { on: true, weight: 0.5 }, sleeper_proj: { on: true, weight: 0.5 },
  },
  stale_days: 7,
  my_roster_id: null,
  adjustments: {
    roster_spot_cost: "auto", future_pick_discount: 0.85,
    age_thresholds: { QB: [27, 33], RB: [24, 27], WR: [25, 29], TE: [26, 30] },
    modes: {
      neutral: { pick: 1.0, young: 1.0, prime: 1.0, aging: 1.0 },
      contend: { pick: 0.70, young: 0.90, prime: 1.05, aging: 1.20 },   // win now: pay up for production, picks are for later
      rebuild: { pick: 1.30, young: 1.20, prime: 1.0, aging: 0.75 },    // rebuilding: picks and youth are the currency
    },
    verdict_pct: { even: 5, slight: 12, lopsided: 25 },
    age_curve: {
      QB: [[24, 1.05], [28, 1.02], [31, 0.95], [34, 0.8], [37, 0.6]],
      RB: [[22, 1.08], [24, 1.05], [26, 0.95], [27, 0.85], [28, 0.7], [30, 0.5]],
      WR: [[22, 1.06], [25, 1.03], [28, 0.95], [30, 0.82], [32, 0.65]],
      TE: [[23, 1.05], [26, 1.02], [29, 0.92], [31, 0.78], [33, 0.6]],
    },
    consolidation_bonus_pct: 8, depth_weight: 0.25,
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function pyround(x) {                         // Python's round(): halves go to the even neighbour
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
const clone = o => JSON.parse(JSON.stringify(o));
function deep_merge(base, upd) {
  for (const [k, v] of Object.entries(upd || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) deep_merge(base[k], v);
    else base[k] = v;
  }
  return base;
}
function now_iso() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const today_iso = () => now_iso().slice(0, 10);
function ordinal(n) {
  n = parseInt(n, 10);
  const s = (n % 100 >= 10 && n % 100 <= 20) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return n + s;
}
const fmt = n => Math.round(n).toLocaleString("en-US");
const fmt_signed = n => { n = Math.round(n); return (n >= 0 ? "+" : "") + n.toLocaleString("en-US"); };
const fmt_pct = p => (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
function compact(n) {
  n = +n;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return n.toFixed(0);
}
const title = s => s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
const teams_bucket = n => [8, 10, 12, 14].reduce((best, t) => Math.abs(t - n) < Math.abs(best - n) ? t : best, 8);
const ppr_bucket = ppr => ppr >= 0.75 ? 1 : (ppr >= 0.25 ? 0.5 : 0);

const NAME_ALIASES = {
  cameron: "cam", chigoziem: "chig", joshua: "josh", michael: "mike", matthew: "matt", zachary: "zach", kenneth: "ken",
  nathaniel: "nate", christopher: "chris", jonathan: "jon", william: "will", benjamin: "ben", alexander: "alex", nicholas: "nick",
  joseph: "joe", jeffery: "jeff", jeffrey: "jeff", timothy: "tim", samuel: "sam", gregory: "greg", patrick: "pat",
  anthony: "anthony", kenny: "ken", mitch: "mitchell",
};
function norm(s) {
  s = String(s || "").toLowerCase().replace(/&/g, " and ");
  s = s.replace(/[.'`\-]/g, "");
  s = s.replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "");
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length) parts[0] = NAME_ALIASES[parts[0]] || parts[0];
  return parts.join(" ");
}

function is_bestball(cfg) { return ["dynasty_bestball", "bestball", "best_ball"].includes(String(cfg.league.type || "dynasty").toLowerCase()); }
function is_redraft(cfg) { return String(cfg.league.type || "dynasty").toLowerCase() === "redraft"; }
function league_kind(cfg) { return is_redraft(cfg) ? "redraft" : (is_bestball(cfg) ? "bestball" : "dynasty"); }
function league_kind_label(cfg) { return { redraft: "redraft", bestball: "dynasty best ball", dynasty: "dynasty" }[league_kind(cfg)]; }

// ---------------------------------------------------------------------------
// League profiles: every league has its own config / values / league files, all
// prefixed "L.<id>." in the app's storage; profiles.json lists them.
// ---------------------------------------------------------------------------
const P = { id: null, cfg: null, values: null };
/* The Play edition only uses sources whose terms allow a free public app (see android\store\SOURCES.md). */
const PLAY = typeof window === "undefined" || window.EDITION !== "personal" || !!window.FREE_SOURCES_ONLY;   // the public app's data rules (also on when an edition says FREE_SOURCES_ONLY)
const f = name => `L.${P.id}.${name}`;
function load_profiles() {
  const p = Store.get("profiles.json", null) || { active: null, profiles: {} };
  // a profile created from an empty league id (an old import bug) is junk: drop it once
  const junk = Object.keys(p.profiles).filter(id => /undefined|null/.test(id) || /undefined|null/.test((p.profiles[id] || {}).name || ""));
  if (junk.length) { for (const id of junk) delete p.profiles[id]; if (junk.includes(p.active)) p.active = Object.keys(p.profiles)[0] || null; Store.set("profiles.json", p); }
  return p;
}
function save_profiles(p) { Store.set("profiles.json", p); }
function slugify(name) { return (norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "league").slice(0, 40); }

function set_profile(pid) {
  const p = load_profiles();
  if (!p.profiles[pid]) throw new Error("no such league");
  p.active = pid;
  save_profiles(p);
  P.id = pid;
  P.cfg = load_config();
  P.values = null;
  return P.cfg;
}
function profile_new(name, id) {
  const p = load_profiles();
  let pid = id || slugify(name), n = 2;
  if (!id) while (p.profiles[pid]) pid = slugify(name) + "-" + (n++);
  p.profiles[pid] = { name, created: now_iso() };
  save_profiles(p);
  return pid;
}
function profile_rename(pid, name) {
  const p = load_profiles();
  if (p.profiles[pid]) { p.profiles[pid].name = name; save_profiles(p); }
}
function profile_delete(pid) {
  const p = load_profiles();
  delete p.profiles[pid];
  for (const n of Store.list()) if (n.startsWith(`L.${pid}.`)) Store.remove(n);
  if (p.active === pid) p.active = Object.keys(p.profiles)[0] || null;
  save_profiles(p);
  if (p.active) set_profile(p.active); else { P.id = null; P.cfg = null; P.values = null; }
}
function load_config() {
  const cfg = clone(DEFAULT_CONFIG);
  const user = Store.get(f("config.json"));
  if (user) deep_merge(cfg, user); else Store.set(f("config.json"), cfg);
  // 2026-09-30: superflex QBs are worth a bit more than we first had (the default went 10% -> 15%); leagues still on
  // the old default move once. A league set to something else keeps its number.
  if (cfg.league && cfg.league.sf_qb_bonus_pct === 10 && !cfg.league.sf_qb_v2) { cfg.league.sf_qb_bonus_pct = 15; cfg.league.sf_qb_v2 = true; Store.set(f("config.json"), cfg); }
  // 2026-10-06: QBs cost more in TRADES, not in the rankings (the user's call): a trade-only premium, default 15%, and
  // the ranking premiums stay at 15 / 8. A league that briefly got 22 / 12 the same day goes back.
  if (cfg.league && cfg.league.sf_qb_v3) {
    if (cfg.league.sf_qb_bonus_pct === 22) cfg.league.sf_qb_bonus_pct = 15;
    if (cfg.league.qb_bonus_pct === 12) cfg.league.qb_bonus_pct = 8;
    delete cfg.league.sf_qb_v3; Store.set(f("config.json"), cfg);
  }
  if (cfg.league && cfg.league.qb_trade_bump_pct == null) { cfg.league.qb_trade_bump_pct = 15; Store.set(f("config.json"), cfg); }
  // 2026-09-30: Win now / Rebuilding got real teeth (the old numbers barely moved a trade). Leagues still on the old
  // defaults move once; a league with its own numbers keeps them.
  const M = cfg.adjustments && cfg.adjustments.modes, same = (x, y) => x && y && ["pick", "young", "prime", "aging"].every(k => +x[k] === +y[k]);
  if (M && !cfg.adjustments.modes_v2 && same(M.contend, { pick: 0.85, young: 0.95, prime: 1.0, aging: 1.10 }) && same(M.rebuild, { pick: 1.15, young: 1.08, prime: 1.0, aging: 0.80 })) {
    M.contend = clone(DEFAULT_CONFIG.adjustments.modes.contend); M.rebuild = clone(DEFAULT_CONFIG.adjustments.modes.rebuild);
    cfg.adjustments.modes_v2 = true; Store.set(f("config.json"), cfg);
  }
  return cfg;
}
function save_config(cfg) { Store.set(f("config.json"), cfg); }

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
function make_player(pid, name, pos, team, age, value, redraft = null, rank = null, pos_rank = null, trend = null, sleeper_id = null, unranked = false) {
  return {
    id: pid, name, pos, team: team || "FA",
    age: (age === null || age === undefined || age === "") ? null : Math.round(parseFloat(age) * 10) / 10,
    value: pyround(parseFloat(value || 0)),
    redraft: (redraft === null || redraft === undefined || redraft === "") ? null : pyround(parseFloat(redraft)),
    rank, pos_rank, trend, sleeper_id: sleeper_id ? String(sleeper_id) : null, is_pick: false, unranked,
  };
}
const pick_id = (season, rnd, tier) => `pick-${season}-${rnd}` + (tier ? `-${tier}` : "");
const pick_label = (season, rnd, tier) => `${season} ${ordinal(rnd)}` + (tier ? ` (${title(tier)})` : "");
function make_pick(season, rnd, tier, value, estimated = false) {
  return {
    id: pick_id(season, rnd, tier), name: pick_label(season, rnd, tier), pos: "PICK", team: "", age: null, value: pyround(value),
    redraft: 0, rank: null, pos_rank: null, trend: null, sleeper_id: null, is_pick: true, pick: { season, round: rnd, tier: tier || null }, estimated,
  };
}
const FC_PICK_RE = /^(\d{4})\s+(\d{1,2})(?:st|nd|rd|th)(?:\s*\((Early|Mid|Late)\))?$/i;
function parse_pick_label(name) {
  const m = FC_PICK_RE.exec(String(name).trim());
  return m ? [+m[1], +m[2], (m[3] || "").toLowerCase() || null] : null;
}
const pkey = (s, r, t) => `${s}|${r}|${t || ""}`;

class Values {
  constructor(store, exclude = []) {
    this.meta = Object.fromEntries(Object.entries(store).filter(([k]) => k !== "assets"));
    this.exclude = new Set(exclude);
    this.assets = (store.assets || []).filter(a => !this.exclude.has(a.pos)).map(a => Object.assign({}, a));
    this.by_id = {};
    for (const a of this.assets) this.by_id[a.id] = a;
    this.players = this.assets.filter(a => !a.is_pick);
    this.picks = new Map();
    for (const a of this.assets) if (a.is_pick) this.picks.set(pkey(a.pick.season, a.pick.round, a.pick.tier), a);
    this.by_sleeper = {};
    for (const a of this.players) if (a.sleeper_id) this.by_sleeper[a.sleeper_id] = a;
    this.league = null;
  }
  get pick_seasons() { return [...new Set([...this.picks.values()].map(a => a.pick.season))].sort((a, b) => a - b); }
  get default_pick_season() { const s = this.pick_seasons; return s.length ? s[0] : new Date().getFullYear() + 1; }
  fetched_date() { return this.meta.fetched ? new Date(this.meta.fetched) : null; }
  attach_league(league) {
    this.league = league;
    if (!league) return;
    for (const [pid, p] of Object.entries(league.players || {})) {
      if (this.by_sleeper[pid] || this.exclude.has(p.pos || "?")) continue;
      const a = make_player("sl" + pid, p.name, p.pos || "?", p.team, p.age, 0, 0, null, null, null, pid, true);
      this.assets.push(a); this.players.push(a); this.by_id[a.id] = a; this.by_sleeper[pid] = a;
    }
  }
}

/* Kickers and defenses stay out of the lists unless the league shows them: the setting, or a league built by hand
   whose lineup has a K or DEF slot (there is nowhere else for them to come from). */
function hide_positions(cfg, league) {
  if (cfg.league.hide_k_def === false) return [];
  if (league && league.platform === "manual" && (league.roster_positions || []).some(s => s === "K" || s === "DEF")) return [];
  return HIDDEN_POSITIONS;
}
function load_values(cfg) {
  cfg = cfg || P.cfg;
  const store = Store.get(f("values.json"));
  if (!store) return null;
  const league = Store.get(f("league.json"));
  const v = new Values(store, hide_positions(cfg, league));
  v.attach_league(league);
  apply_format_premiums(v, cfg);
  assign_tiers(v);
  apply_trending(v);
  P.values = v;
  return v;
}

const TIER_BANDS = [0.85, 0.70, 0.55, 0.42, 0.30, 0.20, 0.12, 0.06];
function assign_tiers(values) {
  const ranked = values.players.filter(p => !p.unranked).sort((a, b) => b.value - a.value);
  ranked.forEach((p, i) => { p.rank = i + 1; });
  for (const pos of POSITIONS) {
    const group = ranked.filter(p => p.pos === pos);
    const top = group.length ? group[0].value : 0;
    group.forEach((p, i) => {
      const share = top ? p.value / top : 0;
      p.pos_rank = i + 1;
      const t = TIER_BANDS.findIndex(b => share >= b);
      p.tier = t >= 0 ? t + 1 : TIER_BANDS.length + 1;
    });
  }
}

/* QBs cost more in a trade than the calculators say, in every format: you overpay for a starting QB. The premium is
   15% in superflex and 8% in 1QB (both league settings), for the QBs a league starts: full for the top teams x QB-slots
   QBs by value, tapering to nothing by twice that. A struggling QB who hasn't broken out ranks below the starters and
   keeps the calculator price. Superflex dynasty adds a little more for QBs 25 and under (the long runway; the value
   model already pays for youth, so this stays small and stops short of the 26-27-year-olds). */
const SF_YOUNG_QB_AGE = 25.5;                                 // the superflex young-QB bonus: QBs 25 and under
function apply_format_premiums(values, cfg) {
  const lg = cfg.league, sf = parseInt(lg.num_qbs || 1) >= 2;
  const qb = parseFloat((sf ? lg.sf_qb_bonus_pct : lg.qb_bonus_pct) || 0);
  const young = sf && !is_redraft(cfg) ? parseFloat(lg.sf_young_qb_bonus_pct || 0) : 0;
  if (qb <= 0 && young <= 0) return;
  const thr = SF_YOUNG_QB_AGE;
  const starters = (parseInt(lg.teams, 10) || 12) * (sf ? 2 : 1);
  const order = values.players.filter(a => a.pos === "QB" && !a.unranked).sort((x, y) => y.value - x.value);
  const share = new Map(order.map((a, i) => [a.id, i < starters ? 1 : Math.max(0, 1 - (i + 1 - starters) / starters)]));
  for (const a of values.players) {
    if (a.pos !== "QB" || a.unranked) continue;
    const w = share.get(a.id) ?? 0, pct = Math.round(qb * w * 10) / 10;
    let mult = 1 + pct / 100, note = pct > 0 ? `${sf ? "superflex" : "1QB"} starting QB +${pct}%` : "";
    if (young > 0 && a.age !== null && a.age <= thr) { mult *= 1 + young / 100; note += `${note ? ", " : ""}young QB +${young}%${pct > 0 ? " more" : ""}`; }
    if (mult !== 1) { a.base_value = a.value; a.value = pyround(a.value * mult); a.premium = note; if (a.ours) a.ours = pyround(a.ours * mult); }
  }
  values.players.sort((x, y) => y.value - x.value);
  values.players.filter(x => !x.unranked).forEach((a, i) => { a.rank = i + 1; });
}

function stale_warning(values, cfg) {
  const d = values.fetched_date();
  if (!d) return null;
  const age = Math.floor((Date.now() - d.getTime()) / 86400000);
  return age > (cfg.stale_days || 7) ? `Values are ${age} days old. Tap Update values to refresh.` : null;
}

// ---------------------------------------------------------------------------
// Value sources -> one consensus (every list scaled so its top player is 10,000)
// ---------------------------------------------------------------------------
const SOURCES = {
  dmv: { label: "Dynasty Mover", about: "our own values from stats, age and draft slot", dynasty: true, redraft: true, market: false, play: true, url: "https://github.com/nflverse/nflverse-data" },
  fantasycalc: { label: "FantasyCalc", about: "real trade-market values", dynasty: true, redraft: true, market: true, play: true, url: "https://fantasycalc.com" },
  keeptradecut: { label: "KeepTradeCut", about: "crowd-sourced dynasty trade values", dynasty: true, redraft: false, market: true },
  dynastydaddy: { label: "Dynasty Daddy", about: "blended trade values across the big calculators", dynasty: true, redraft: false },
  dynastyprocess: { label: "DynastyProcess", about: "expert consensus values", dynasty: true, redraft: false, play: true, url: "https://dynastyprocess.com" },
  fantasypros: { label: "FantasyPros", about: "expert consensus rankings", dynasty: true, redraft: true },
  draftsharks: { label: "DraftSharks", about: "trade value chart in your scoring", dynasty: true, redraft: true },
  ffcalculator: { label: "FF Calculator", about: "ADP from real drafts", dynasty: true, redraft: true, play: true, url: "https://fantasyfootballcalculator.com" },
  sleeper_proj: { label: "Sleeper projections", about: "season points above replacement", dynasty: true, redraft: true },
  custom: { label: "Custom list", about: "your own CSV", dynasty: true, redraft: true },
};
const SOURCE_ORDER = ["dmv", "fantasycalc", "keeptradecut", "dynastydaddy", "dynastyprocess", "fantasypros", "draftsharks", "sleeper_proj", "ffcalculator"];
const KTC_URL = "https://keeptradecut.com/dynasty-rankings";
const DD_URL = "https://dynasty-daddy.com/api/v1/player/all/today";
const FP_URLS = {
  dyn_1qb: "https://www.fantasypros.com/nfl/rankings/dynasty-overall.php", dyn_sf: "https://www.fantasypros.com/nfl/rankings/dynasty-superflex.php",
  ros_ppr: "https://www.fantasypros.com/nfl/rankings/ros-ppr-overall.php", ros_half: "https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-overall.php",
  ros_std: "https://www.fantasypros.com/nfl/rankings/ros-overall.php",
};
const DS_URL = "https://www.draftsharks.com/trade-value-chart/dynasty/ppr";
const KTC_TEAMS = { SFO: "SF", KCC: "KC", GBP: "GB", NEP: "NE", NOS: "NO", TBB: "TB", LVR: "LV", JAC: "JAX" };
const DP_PLAYERS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv";
const DP_PICKS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-picks.csv";
const FFC_URL = "https://fantasyfootballcalculator.com/api/v1/adp/";
const SLEEPER_PROJ_URL = "https://api.sleeper.com/projections/nfl/{season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE";
const TOP_SCALE = 10000.0;
const BROWSER = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36" };

function source_settings(cfg, name) {
  const e = (cfg.sources || {})[name.split(":")[0]] || {};
  // our own values: always on where the edition uses nothing else (Pro), otherwise off until switched on
  if (name.split(":")[0] === "dmv" && (e.on === undefined || (typeof window !== "undefined" && window.OWN_VALUES_ONLY)))
    return [typeof window !== "undefined" && !!window.OWN_VALUES_ONLY, parseFloat(e.weight === undefined ? 1.0 : e.weight)];
  return [e.on !== false, parseFloat(e.weight === undefined ? 1.0 : e.weight)];
}
function source_applies(cfg, name) {
  const m = SOURCES[name.split(":")[0]] || { dynasty: true, redraft: true };
  if (PLAY && !m.play) return false;
  if (typeof window !== "undefined" && window.OWN_VALUES_ONLY && name.split(":")[0] !== "dmv") return false;
  return is_redraft(cfg) ? m.redraft : m.dynasty;
}
function effective_weight(cfg, name) {
  let [, w] = source_settings(cfg, name);
  if (is_redraft(cfg) && name === "sleeper_proj") w *= 3;
  return w;
}
const player_key = (name, pos) => norm(name) + "|" + pos;

function scale_group(groups) {
  let m = 0;
  for (const g of groups) for (const it of g) m = Math.max(m, it.value);
  if (m > 0) {
    const k = TOP_SCALE / m;
    for (const g of groups) for (const it of g) { it.value *= k; if (it.redraft !== null && it.redraft !== undefined) it.redraft *= k; }
  }
  return groups;
}
const rank_curve = players => players.map(p => p.value).sort((a, b) => b - a);
function curve_value(curve, rank) {
  if (!curve || !curve.length) return TOP_SCALE * Math.exp(-0.0155 * (Math.max(1.0, rank) - 1));
  const i = Math.max(0, pyround(rank) - 1);
  if (i < curve.length) return curve[i];
  return curve[curve.length - 1] * Math.pow(0.9, i - curve.length + 1);
}
function on_market_curve(players, curve) {
  players.sort((a, b) => b.value - a.value);
  players.forEach((x, i) => { x.value = curve_value(curve, i + 1); });
  return players;
}
function _rank_mixed(players, picks, curve) {
  const items = players.concat(picks).sort((a, b) => b.value - a.value);
  items.forEach((it, i) => { it.value = curve_value(curve, i + 1); });
  scale_group([players, picks]);
}

function parse_csv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, ""));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function slice_json(text, start) {
  const op = text[start], cl = op === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === op) depth++;
    else if (ch === cl) { depth--; if (depth === 0) return text.slice(start, k + 1); }
  }
  throw new Error("unterminated JSON");
}

function fc_params(cfg) {
  const lg = cfg.league;
  return { isDynasty: is_redraft(cfg) ? "false" : "true", numQbs: parseInt(lg.num_qbs) >= 2 ? 2 : 1, numTeams: teams_bucket(parseInt(lg.teams)), ppr: ppr_bucket(parseFloat(lg.ppr)) };
}
const qs = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

async function src_fantasycalc(cfg) {
  const params = fc_params(cfg), url = FC_URL + "?" + qs(params);
  const raw = await Net.json(url);
  const players = [], picks = [];
  for (const row of raw) {
    const p = row.player, pos = p.position;
    if (pos === "PICK") {
      if (is_redraft(cfg)) continue;
      const pk = parse_pick_label(p.name);
      if (pk) picks.push({ season: pk[0], round: pk[1], tier: pk[2], value: +row.value });
      continue;
    }
    if (!POSITIONS.includes(pos)) continue;
    const a = make_player(`fc${p.id}`, p.name, pos, p.maybeTeam, p.maybeAge, row.value, row.redraftValue, row.overallRank, row.positionRank, row.trend30Day, p.sleeperId);
    players.push({ key: player_key(a.name, a.pos), name: a.name, pos: a.pos, team: a.team, age: a.age, sleeper_id: a.sleeper_id, fc_id: a.id,
      value: +a.value, redraft: a.redraft !== null ? +a.redraft : null, trend: a.trend, raw: fmt(a.value) });
  }
  scale_group([players, picks]);
  return { name: "fantasycalc", players, picks, meta: { url, params } };
}

async function src_dynastyprocess(cfg, curve) {
  const sf = parseInt(cfg.league.num_qbs) >= 2;
  const [col, ecrCol] = sf ? ["value_2qb", "ecr_2qb"] : ["value_1qb", "ecr_1qb"];
  const players = [];
  for (const r of parse_csv(await Net.text(DP_PLAYERS_URL))) {
    const pos = (r.pos || "").toUpperCase();
    if (!POSITIONS.includes(pos)) continue;
    const v = parseFloat(r[col] || 0);
    if (!(v > 0)) continue;
    let age = parseFloat(r.age);
    if (isNaN(age)) age = null;
    players.push({ key: player_key(r.player, pos), name: r.player, pos, team: r.team || "FA", age, sleeper_id: null, value: v, raw: `ECR ${r[ecrCol]}` });
  }
  on_market_curve(players, curve);
  const grouped = new Map();
  for (const r of parse_csv(await Net.text(DP_PICKS_URL))) {
    const pk = parse_pick_query(r.player || "", 0, parseInt(cfg.league.teams));
    if (!pk || !pk[0]) continue;
    const ecr = parseFloat(r[ecrCol] || 0);
    if (!(ecr > 0)) continue;
    const k = pkey(...pk);
    if (!grouped.has(k)) grouped.set(k, { pk, vals: [] });
    grouped.get(k).vals.push(curve_value(curve, ecr));
  }
  const picks = [...grouped.values()].map(g => ({ season: g.pk[0], round: g.pk[1], tier: g.pk[2], value: g.vals.reduce((s, x) => s + x, 0) / g.vals.length }));
  scale_group([players, picks]);
  return { name: "dynastyprocess", players, picks, meta: { column: col } };
}

async function src_keeptradecut(cfg, curve) {
  const lg = cfg.league;
  const html = await Net.text(KTC_URL, BROWSER);
  const m = /<script[^>]*id="ktc-players"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let rows;
  if (m) rows = JSON.parse(m[1].trim());
  else {
    const i = html.indexOf("var playersArray = ");
    if (i < 0) throw new Error("KeepTradeCut page layout changed (no ktc-players data)");
    rows = JSON.parse(slice_json(html, i + "var playersArray = ".length));
  }
  const sf = parseInt(lg.num_qbs) >= 2, tep = parseFloat(lg.te_premium_bonus_pct || 0) > 0;
  const players = [], picks = [];
  for (const r of rows) {
    const vals = r[sf ? "superflexValues" : "oneQBValues"] || {};
    const v = ((tep ? (vals.tep || {}).value : null) || vals.value || 0);
    if (v <= 0) continue;
    const pos = (r.position || "").toUpperCase(), name = r.playerName || "";
    if (pos === "RDP") {
      const pk = parse_pick_query(name, 0, parseInt(lg.teams));
      if (pk && pk[0]) picks.push({ season: pk[0], round: pk[1], tier: pk[2], value: +v });
      continue;
    }
    if (!POSITIONS.includes(pos)) continue;
    const team = r.team || "FA";
    players.push({ key: player_key(name, pos), name, pos, team: KTC_TEAMS[team] || team, age: r.age ?? null, sleeper_id: null, value: +v, raw: `KTC ${fmt(v)}` + (tep ? " TEP" : "") });
  }
  _rank_mixed(players, picks, curve);
  return { name: "keeptradecut", players, picks, meta: { format: (sf ? "superflex" : "1QB") + (tep ? " TE premium" : "") } };
}

async function src_dynastydaddy(cfg, curve) {
  const lg = cfg.league;
  const rows = JSON.parse(await Net.text(DD_URL, BROWSER));
  const col = parseInt(lg.num_qbs) >= 2 ? "sf_trade_value" : "trade_value";
  const players = [], picks = [];
  for (const r of rows) {
    const v = r[col] || 0;
    if (v <= 0) continue;
    const pos = (r.position || "").toUpperCase(), name = r.full_name || "";
    if (pos === "PI") {
      const pk = parse_pick_query(name, 0, parseInt(lg.teams));
      if (pk && pk[0]) picks.push({ season: pk[0], round: pk[1], tier: pk[2], value: +v });
      continue;
    }
    if (!POSITIONS.includes(pos)) continue;
    players.push({ key: player_key(name, pos), name, pos, team: r.team || "FA", age: r.age ?? null, sleeper_id: r.sleeper_id ? String(r.sleeper_id) : null, value: +v, raw: `DD ${fmt(v)}` });
  }
  _rank_mixed(players, picks, curve);
  return { name: "dynastydaddy", players, picks, meta: { column: col } };
}

async function src_fantasypros(cfg, curve) {
  const lg = cfg.league, ppr = parseFloat(lg.ppr);
  const key = is_redraft(cfg) ? (ppr >= 0.75 ? "ros_ppr" : (ppr >= 0.25 ? "ros_half" : "ros_std")) : (parseInt(lg.num_qbs) >= 2 ? "dyn_sf" : "dyn_1qb");
  const html = await Net.text(FP_URLS[key], BROWSER);
  const m = /var ecrData\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html);
  if (!m) throw new Error("FantasyPros page layout changed (no ecrData)");
  const data = JSON.parse(m[1]);
  const players = [];
  for (const r of data.players || []) {
    const pos = (r.player_position_id || "").toUpperCase();
    if (!POSITIONS.includes(pos)) continue;
    const rank = parseFloat(r.rank_ave || r.rank_ecr);
    if (isNaN(rank)) continue;
    const name = r.player_name || "";
    players.push({ key: player_key(name, pos), name, pos, team: r.player_team_id || "FA", age: null, sleeper_id: null, value: curve_value(curve, rank), raw: `ECR ${r.rank_ecr}` });
  }
  scale_group([players]);
  return { name: "fantasypros", players, picks: [], meta: { list: data.ranking_type_name || key, updated: data.last_updated, experts: data.total_experts } };
}

async function src_draftsharks(cfg, curve) {
  const lg = cfg.league, ppr = parseFloat(lg.ppr), sf = parseInt(lg.num_qbs) >= 2, tep = parseFloat(lg.te_premium_bonus_pct || 0) > 0;
  const kind = is_redraft(cfg) ? "redraft" : "dynasty";
  const html = await Net.text(DS_URL, BROWSER, 240000);
  const i = html.indexOf('"players":[');
  if (i < 0) throw new Error("DraftSharks page layout changed (no players data)");
  const rows = JSON.parse(slice_json(html, i + '"players":'.length));
  const field = "dsValue" + (kind === "dynasty" ? "Dynasty" : "Redraft") + (tep ? "TePremium" : (ppr >= 0.75 ? "OnePpr" : (ppr >= 0.25 ? "HalfPpr" : "NoPpr"))) + (sf ? "Superflex" : "");
  const players = [];
  for (const r of rows) {
    const v = r[field], pos = (r.fantasy_position || "").toUpperCase();
    if (v === null || v === undefined || v <= 0 || !POSITIONS.includes(pos)) continue;
    const name = ((r.first_name || "") + " " + (r.last_name || "")).trim();
    let age = null;
    if (r.birthday) { const b = new Date(r.birthday.slice(0, 10)); if (!isNaN(b)) age = Math.round((Date.now() - b) / (365.25 * 86400000) * 10) / 10; }
    players.push({ key: player_key(name, pos), name, pos, team: r.abbr || "FA", age, sleeper_id: null, value: +v, raw: `DS ${v}` });
  }
  on_market_curve(players, curve);
  scale_group([players]);
  return { name: "draftsharks", players, picks: [], meta: { field, kind } };
}

async function src_ffcalculator(cfg, curve) {
  const lg = cfg.league, ppr = parseFloat(lg.ppr);
  const kind = is_redraft(cfg) ? (parseInt(lg.num_qbs) >= 2 ? "2qb" : (ppr >= 0.75 ? "ppr" : (ppr >= 0.25 ? "half-ppr" : "standard"))) : "dynasty";
  const d = await Net.json(`${FFC_URL}${kind}?teams=${teams_bucket(parseInt(lg.teams))}&year=${parseInt(cfg.season)}`);
  const players = [];
  for (const p of (d.players || []).slice().sort((a, b) => parseFloat(a.adp || 999) - parseFloat(b.adp || 999))) {
    const pos = (p.position || "").toUpperCase();
    if (!POSITIONS.includes(pos)) continue;
    players.push({ key: player_key(p.name, pos), name: p.name, pos, team: p.team || "FA", age: null, sleeper_id: null,
      value: curve_value(curve, parseFloat(p.adp || 999)), raw: `ADP ${p.adp_formatted || p.adp}` });
  }
  scale_group([players]);
  return { name: "ffcalculator", players, picks: [], meta: { kind, drafts: (d.meta || {}).total_drafts } };
}

async function src_sleeper_proj(cfg, curve) {
  const lg = cfg.league, ppr = parseFloat(lg.ppr);
  const key = ppr >= 0.75 ? "pts_ppr" : (ppr >= 0.25 ? "pts_half_ppr" : "pts_std");
  const rows = await Net.json(SLEEPER_PROJ_URL.replace("{season}", parseInt(cfg.season)));
  const by_pos = { QB: [], RB: [], WR: [], TE: [] };
  for (const r of rows) {
    const pl = r.player || {}, pos = (pl.position || "").toUpperCase(), pts = (r.stats || {})[key];
    if (!POSITIONS.includes(pos) || !pts || pts <= 0) continue;
    const name = (String(pl.first_name || "") + " " + String(pl.last_name || "")).trim();
    if (!name) continue;
    by_pos[pos].push({ key: player_key(name, pos), name, pos, team: pl.team || "FA", age: pl.age ?? null, sleeper_id: String(r.player_id), pts: +pts });
  }
  const teams = parseInt(lg.teams);
  const repl_mult = { QB: parseInt(lg.num_qbs) >= 2 ? 1.8 : 1.1, RB: 2.6, WR: 3.2, TE: 1.2 };
  const players = [];
  for (const [pos, lst] of Object.entries(by_pos)) {
    lst.sort((a, b) => b.pts - a.pts);
    if (!lst.length) continue;
    const repl = lst[Math.min(lst.length - 1, pyround(teams * repl_mult[pos]))].pts;
    for (const x of lst) {
      let v = x.pts - repl;
      if (v <= 0) continue;
      if (!is_redraft(cfg)) v *= age_factor(pos, x.age, cfg);
      x.value = v;
      x.raw = `${x.pts.toFixed(0)} pts`;
      players.push(x);
    }
  }
  on_market_curve(players, curve);
  scale_group([players]);
  return { name: "sleeper_proj", players, picks: [], meta: { season: parseInt(cfg.season), scoring: key } };
}

const MIN_SOURCE_VALUE = 50;

function build_consensus(cfg, results) {
  const weights = {};
  for (const r of results) weights[r.name] = effective_weight(cfg, r.name);
  const w = src => weights[src] === undefined ? 1.0 : weights[src];
  const fcSeasons = results.filter(r => r.name === "fantasycalc").flatMap(r => r.picks.map(p => p.season));
  const now = new Date();
  const min_pick_season = fcSeasons.length ? Math.min(...fcSeasons) : (now.getMonth() >= 4 ? parseInt(cfg.season) + 1 : parseInt(cfg.season));
  const entries = new Map();
  for (const r of results) {
    for (const p of r.players) {
      if (p.value < MIN_SOURCE_VALUE) continue;
      let e = entries.get(p.key);
      if (!e) { e = { name: p.name, pos: p.pos, team: null, age: null, sleeper_id: null, fc_id: null, redraft: null, trend: null, vals: {}, raw: {} }; entries.set(p.key, e); }
      e.vals[r.name] = p.value;
      e.raw[r.name] = p.raw || "";
      if (r.name === "fantasycalc") Object.assign(e, { name: p.name, team: p.team, age: p.age, sleeper_id: p.sleeper_id, fc_id: p.fc_id, redraft: p.redraft, trend: p.trend });
      else {
        if ((!e.team || e.team === "FA") && p.team && p.team !== "FA") e.team = p.team;
        if (e.age === null && p.age !== null && p.age !== undefined) e.age = p.age;
        if (!e.sleeper_id && p.sleeper_id) e.sleeper_id = p.sleeper_id;
      }
    }
  }
  const names = load_name_index(), last = (Store.get("player_status.json") || {}).last || {};
  for (const [key, e] of entries) {
    if (e.sleeper_id) continue;
    e.sleeper_id = names[key] || null;
    if (!e.sleeper_id) {                                        // same last name, position and team, and only one such player
      const ln = norm(String(e.name).replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "").trim().split(" ").slice(-1)[0]);
      e.sleeper_id = (e.team && e.team !== "FA" && last[`${ln}|${e.pos}|${e.team}`]) || null;
    }
  }
  const by_sid = {};
  for (const key of [...entries.keys()]) {                     // two spellings of one Sleeper player -> one entry
    const e = entries.get(key);
    if (!e) continue;
    const sid = e.sleeper_id;
    if (!sid) continue;
    if (!(sid in by_sid)) { by_sid[sid] = key; continue; }
    let keep = entries.get(by_sid[sid]), other = e;
    if ("fantasycalc" in other.vals && !("fantasycalc" in keep.vals)) {
      [keep, other] = [other, keep];
      entries.delete(by_sid[sid]);
      by_sid[sid] = key;
    } else entries.delete(key);
    for (const [src, v] of Object.entries(other.vals)) {
      if (!(src in keep.vals)) { keep.vals[src] = v; keep.raw[src] = other.raw[src] || ""; }
    }
    for (const fld of ["team", "age", "fc_id", "redraft", "trend"]) {
      if ((keep[fld] === null || keep[fld] === undefined || keep[fld] === "FA") && !(other[fld] === null || other[fld] === undefined || other[fld] === "FA")) keep[fld] = other[fld];
    }
  }
  // Guards against one list going wrong (a glitching projection feed once made Case Keenum the #1 QB):
  //  - with three or more lists, any list more than 2.5x the median of the others is pulled down to 2.5x;
  //  - a player on a single non-market list is capped at the value of the last starter at his position among players
  //    that two or more lists agree on (teams x QB 1-2 / RB 2.5 / WR 3.5 / TE 1.2).
  const isMarket = src => !!(SOURCES[src.split(":")[0]] || {}).market;
  for (const e of entries.values()) {
    const srcs = Object.keys(e.vals).filter(src => w(src) > 0);
    if (srcs.length < 3) continue;
    for (const src of srcs) {
      const others = srcs.filter(s2 => s2 !== src).map(s2 => e.vals[s2]).sort((x, y) => x - y), med = others[Math.floor(others.length / 2)];
      if (med > 0 && e.vals[src] > 2.5 * med) e.vals[src] = 2.5 * med;
    }
  }
  const blend = e => { const ws = Object.entries(e.vals).filter(([src]) => w(src) > 0).map(([src, v]) => [w(src), v]); return ws.length ? ws.reduce((s, [a, v]) => s + a * v, 0) / ws.reduce((s, [a]) => s + a, 0) : 0; };
  const teamsN = parseInt(cfg.league.teams, 10) || 12, slots = { QB: parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 };
  const cap = {};
  for (const pos of Object.keys(slots)) {
    const agreed = [...entries.values()].filter(e => e.pos === pos && Object.keys(e.vals).filter(src => w(src) > 0).length >= 2).map(blend).sort((x, y) => y - x);
    cap[pos] = agreed.length ? agreed[Math.min(agreed.length - 1, Math.round(teamsN * slots[pos]))] : Infinity;
  }
  const assets = [];
  for (const [key, e] of entries) {
    const ws = Object.entries(e.vals).filter(([src]) => w(src) > 0).map(([src, v]) => [w(src), v]);
    if (!ws.length) continue;
    let value = ws.reduce((s, [a, v]) => s + a * v, 0) / ws.reduce((s, [a]) => s + a, 0);
    const only = ws.length === 1 ? Object.keys(e.vals).find(src => w(src) > 0) : null;
    if (only && !isMarket(only) && value > (cap[e.pos] ?? Infinity)) value = cap[e.pos];
    if (value < 1) continue;
    let redraft = e.redraft;
    if (redraft === null && "sleeper_proj" in e.vals) redraft = e.vals.sleeper_proj;
    const pid = e.fc_id || ("cs" + hash10(key));
    const a = make_player(pid, e.name, e.pos, e.team, e.age, value, redraft !== null ? redraft : value, null, null, e.trend, e.sleeper_id);
    const vals = Object.values(e.vals);
    a.sources = Object.fromEntries(Object.entries(e.vals).map(([s, v]) => [s, pyround(v)]));
    a.raw = e.raw;
    a.spread = vals.length > 1 ? pyround(Math.max(...vals) - Math.min(...vals)) : 0;
    a.n_sources = vals.length;
    assets.push(a);
  }
  assets.sort((a, b) => b.value - a.value);
  assets.forEach((a, i) => { a.rank = i + 1; });
  const grouped = new Map();
  for (const r of results) {
    for (const p of r.picks) {
      if (p.season < min_pick_season) continue;
      const k = pkey(p.season, p.round, p.tier);
      if (!grouped.has(k)) grouped.set(k, { p, srcs: {} });
      (grouped.get(k).srcs[r.name] = grouped.get(k).srcs[r.name] || []).push(p.value);
    }
  }
  const avg = v => v.reduce((s, x) => s + x, 0) / v.length;
  for (const { p, srcs } of grouped.values()) {
    const ws = Object.entries(srcs).filter(([s]) => w(s) > 0).map(([s, v]) => [w(s), avg(v)]);
    if (!ws.length) continue;
    const a = make_pick(p.season, p.round, p.tier, ws.reduce((s, [x, v]) => s + x * v, 0) / ws.reduce((s, [x]) => s + x, 0));
    const vals = Object.values(srcs).map(avg);
    a.sources = Object.fromEntries(Object.entries(srcs).map(([s, v]) => [s, pyround(avg(v))]));
    a.spread = vals.length > 1 ? pyround(Math.max(...vals) - Math.min(...vals)) : 0;
    a.n_sources = vals.length;
    assets.push(a);
  }
  return assets;
}
function hash10(s) {                          // stable short id for players no market list carries
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 10);
}

/* ---------------------------------------------------------------------------
   Dynasty Mover values (DMV): our own player and pick values, from facts only, so the app needs nobody's
   value list. Inputs: NFL stats from nflverse (CC BY 4.0: https://github.com/nflverse/nflverse-data), age, NFL draft
   slot, and Sleeper's team, depth chart and injury status. The numbers in DMV were fitted on PC
   (android/tools/values/dmv_model.py) so our rankings land close to the dynasty market; retune them there.
     production  games-weighted fantasy points per game over this season and the last two, blended with the best recent year
     value       S_pos * max(0, ppg - R_pos) ^ E_pos, mixed with a draft-slot value while there are few games to go on,
                 times an age curve (peak_pos, decline dec_pos, a bonus for being young), times availability,
                 softened at the very top (C)
     picks       the value of the rookie class at that draft slot (early rounds a bit higher, as the market pays for
                 them), 20% less for each year further out
--------------------------------------------------------------------------- */
const NFLV = "https://github.com/nflverse/nflverse-data/releases/download/";
const EP_URL = "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_{season}.csv";
/* The rookie class: college players for the next NFL draft with our prospect grades, built on the PC by
   tools/draft/build_prospects.py (CollegeFootballData.com) and published as a file on the app's GitHub Pages site.
   Cached a day at a time; a missing file (the class isn't published yet) leaves the last copy, or nothing. */
const PROSPECTS_URL = "https://milliguns58.github.io/dynasty-mover-legal/data/prospects_{year}.json";
const prospectsLoading = {};
function prospects_cached(year) { const c = Store.get(`prospects_${year}.json`); return c && c.data && c.data.players ? c.data : null; }
/* The copy of the class packed into the app (assets/www/data/prospects_<year>.js, written by tools/draft/build_prospects.py):
   for a phone that can't reach the site, or before the file is uploaded. The site's copy is newer when it is there. */
function prospects_bundled(year) {
  return new Promise(res => {
    const key = `PROSPECTS_${year}`;
    if (typeof window === "undefined" || typeof document === "undefined") return res(null);
    if (window[key]) return res(window[key]);
    const s = document.createElement("script");
    s.src = `data/prospects_${year}.js`; s.onload = () => res(window[key] || null); s.onerror = () => res(null);
    document.head.appendChild(s);
  });
}
async function prospects(year, maxHours = 24) {
  const name = `prospects_${year}.json`, c = Store.get(name);
  if (c && c.data && Date.now() - new Date(c.fetched).getTime() < maxHours * 3600000) return c.data;
  if (prospectsLoading[year]) return prospectsLoading[year];
  prospectsLoading[year] = Net.json(PROSPECTS_URL.replace("{year}", year), null, 60000)
    .then(d => { if (d && Array.isArray(d.players)) { Store.set(name, { fetched: now_iso(), data: d }); return d; } return c ? c.data : null; }, () => (c ? c.data : null))
    .then(d => d || prospects_bundled(year))
    .finally(() => { delete prospectsLoading[year]; });
  return prospectsLoading[year];
}
/* Expected fantasy points (ffverse/ffopportunity, data CC BY-SA 4.0): what each player's usage was worth, play by play,
   against what he scored. Summed by season and cached a day at a time as ep_{season}.json:
   {name|pos: [games, points, expected points, touchdowns, expected touchdowns]}. */
async function ep_stats(season, maxHours = 24) {
  const name = `ep_${season}.json`, c = Store.get(name);
  if (c && c.v === 2 && Date.now() - new Date(c.fetched).getTime() < maxHours * 3600000) return c.players;
  const players = {}, weeks = {};
  try {
    const txt = await Net.text(EP_URL.replace("{season}", season), null, 240000);
    for (const r of parse_csv(txt)) {
      if (!POSITIONS.includes(r.position)) continue;
      // games, points, expected points, TDs, expected TDs, {week: [points, expected]}
      const k = player_key(r.full_name || "", r.position), o = players[k] || (players[k] = [0, 0, 0, 0, 0, {}]), wk = weeks[k] || (weeks[k] = new Set());
      if (!wk.has(r.week)) { wk.add(r.week); o[0]++; }
      const pts = parseFloat(r.total_fantasy_points) || 0, exp = parseFloat(r.total_fantasy_points_exp) || 0;
      o[1] += pts; o[2] += exp;
      o[3] += parseFloat(r.total_touchdown) || 0; o[4] += parseFloat(r.total_touchdown_exp) || 0;
      const w = o[5][r.week] || (o[5][r.week] = [0, 0]); w[0] = Math.round((w[0] + pts) * 10) / 10; w[1] = Math.round((w[1] + exp) * 10) / 10;
    }
    for (const o of Object.values(players)) for (let i = 1; i < 5; i++) o[i] = Math.round(o[i] * 10) / 10;
    Store.set(name, { v: 2, fetched: now_iso(), players });
    return players;
  } catch (e) { return c ? c.players : {}; }
}
const DMV = {"w26":0.0858,"w25":0.0407,"w24":0.0163,"k":2.0755,"best":0.0513,"E_QB":3.6771,"E_RB":2.0028,"E_WR":1.8533,"E_TE":1.7588,"S_QB":0.1268,"S_RB":22.1703,"S_WR":42.585,"S_TE":62.7482,"R_QB":-1.0362,"R_RB":-1.0135,"R_WR":0.7476,"R_TE":1.1418,"disc":0.8523,"young":0.8001,"D_QB":1932.5573,"D_RB":1820.7103,"D_WR":1253.4421,"D_TE":1310.2314,"L":144.344,"kd":7.4979,"C":38771.4532};
/* Two sets of numbers. DMV_MKT: our values tuned to match the market as closely as we can (a plain age decline); these are
   the values and ranks the Pro app trades on. DMV: our own dynasty view (the research age curves and the breakout bump);
   this gives the grades. Where the two disagree, the user gets a buy or sell hint the market doesn't show. */
const DMV_MKT = {"w26":1.2308,"w25":0.3516,"w24":0.1384,"best_QB":0.2754,"best_RB":0.0042,"best_WR":0.0,"best_TE":0.0799,"E_QB":2.4573,"E_RB":2.0561,"E_WR":1.9325,"E_TE":1.6575,"S_QB":6.3241,"S_RB":19.8025,"S_WR":37.3424,"S_TE":64.0041,"R_QB":4.2772,"R_RB":-1.632,"R_WR":1.0846,"R_TE":1.3444,"peak_QB":28.7639,"peak_RB":23.0034,"peak_WR":25.0003,"peak_TE":27.4564,"dec_QB":0.1019,"dec_RB":0.142,"dec_WR":0.0921,"dec_TE":0.1034,"young":0.6011,"D_QB":2033.7033,"D_RB":2902.7461,"D_WR":2029.4478,"D_TE":1419.4604,"L":128.1501,"kd":7.4094,"C":82304.0844,"ped":0.2743};
const DMV_MODEL = 4;                                     // bump when the value formula changes: installed apps rebuild their values on the next open
const DMV_TYPICAL = { QB: 14, RB: 9, WR: 8, TE: 6 };          // a typical starter's points a game (half-PPR): the anchor for thin samples
const DMV_REPLACEMENT = { QB: 12, RB: 6.5, WR: 6, TE: 4 };   // a replacement-level player's points a game (half-PPR): the redraft anchor for thin samples
const DMV_PRIOR_ADJ = { QB: 0.55 };                      // 1QB leagues: QBs are worth about half of superflex
const DMV_DEPTH_MAX = { QB: 2, RB: 3, WR: 5, TE: 3 };
const DMV_PICK_BOOST = [1.45, 1.15, 1.0, 1.0, 1.0];      // the market pays extra for the hope in early rookie picks (the user prefers this basis, 2026-10-06)
/* Hand adjustments to our own values, for what stats can't see (holdouts, feuds, contract or coaching situations).
   Sleeper player ID -> [multiplier, reason]. The reason shows on the player card. */
const DMV_ADJUST = {
  "6803": [0.3, "Hasn't played in two years and is at odds with the 49ers"],     // Brandon Aiyuk
};
async function nflv_stats(year, weekly, maxHours) {
  const name = `nflv_${weekly ? "wk" : "reg"}_${year}.json`, c = Store.get(name);
  if (c && c.v === 5 && Date.now() - new Date(c.fetched).getTime() < maxHours * 3600000) return c.players;
  let players = {};
  const teams = {};                                                 // team context: pass attempts, carries and EPA, for the prediction models
  const log = {};                                                   // weekly file: each game's stat line, for the game log
  const car = {};                                                   // season file: each player's season totals, for the career view
  const n = v => Math.round((parseFloat(v) || 0) * 10) / 10;
  try {
    const txt = await Net.text(`${NFLV}stats_player/stats_player_${weekly ? "week" : "reg"}_${year}.csv`, null, 240000);
    for (const r of parse_csv(txt)) {
      if ((r.season_type || "REG") !== "REG" || !POSITIONS.includes(r.position)) continue;
      const k = player_key(r.player_display_name || r.player_name || "", r.position);
      // opponent, std points, PPR points, completions, attempts, pass yds, pass TD, INT, carries, rush yds, rush TD, rec, targets, rec yds, rec TD
      if (weekly) (log[k] = log[k] || {})[r.week] = [r.opponent_team || "", n(r.fantasy_points), n(r.fantasy_points_ppr), n(r.completions), n(r.attempts),
        n(r.passing_yards), n(r.passing_tds), n(r.passing_interceptions), n(r.carries), n(r.rushing_yards), n(r.rushing_tds),
        n(r.receptions), n(r.targets), n(r.receiving_yards), n(r.receiving_tds)];
      if (!weekly) {                                                // team, games, std pts, PPR pts, then the same stat line as the game log
        const cr = car[k] || (car[k] = ["", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        cr[0] = r.recent_team || r.team || cr[0]; cr[1] += parseInt(r.games, 10) || 0;
        [r.fantasy_points, r.fantasy_points_ppr, r.completions, r.attempts, r.passing_yards, r.passing_tds, r.passing_interceptions, r.carries,
          r.rushing_yards, r.rushing_tds, r.receptions, r.targets, r.receiving_yards, r.receiving_tds].forEach((v, i) => { cr[i + 2] = Math.round((cr[i + 2] + (parseFloat(v) || 0)) * 10) / 10; });
      }
      // games, standard points, PPR points, weekly: {week: [std, ppr, opportunities]} (else 0), rushing yards, rushing TDs, target share (season average)
      // (8) team, (9) pass attempts, (10) targets, (11) carries, (12) receiving yards, (13) all TDs, (14) air-yards share, (15) WOPR (season averages)
      const o = players[k] || (players[k] = [0, 0, 0, 0, 0, 0, 0, 0, "", 0, 0, 0, 0, 0, 0, 0, 0]);   // (16) receptions
      const std = parseFloat(r.fantasy_points) || 0, ppr = parseFloat(r.fantasy_points_ppr) || 0;
      const att = parseFloat(r.attempts) || 0, tgt = parseFloat(r.targets) || 0, carr = parseFloat(r.carries) || 0;
      o[0] += weekly ? 1 : (parseInt(r.games, 10) || 0);
      o[1] += std; o[2] += ppr;
      if (weekly) (o[3] = o[3] || {})[r.week] = [Math.round(std * 10) / 10, Math.round(ppr * 10) / 10, att + tgt + carr];
      o[4] += parseFloat(r.rushing_yards) || 0; o[5] += parseFloat(r.rushing_tds) || 0;
      o[7] += 1; o[6] += ((parseFloat(r.target_share) || 0) - o[6]) / o[7];   // running average over rows
      o[14] += ((parseFloat(r.air_yards_share) || 0) - o[14]) / o[7]; o[15] += ((parseFloat(r.wopr) || 0) - o[15]) / o[7];
      o[8] = r.team || r.recent_team || o[8]; o[9] += att; o[10] += tgt; o[11] += carr;
      o[16] += parseFloat(r.receptions) || 0;
      o[12] += parseFloat(r.receiving_yards) || 0; o[13] += (parseFloat(r.receiving_tds) || 0) + (parseFloat(r.rushing_tds) || 0) + (parseFloat(r.passing_tds) || 0);
      const tm = r.team || r.recent_team;
      if (tm) { const T = teams[tm] || (teams[tm] = [0, 0, 0, 0, {}]); T[0] += att; T[1] += parseFloat(r.passing_epa) || 0; T[2] += carr; T[3] += parseFloat(r.rushing_epa) || 0; if (weekly) T[4][r.week] = 1; else T[4].g = Math.max(T[4].g || 0, parseInt(r.games, 10) || 0); }
    }
  } catch (e) { if (c) return c.players; if (!weekly) throw e; }   // no weekly file yet before week 1
  for (const T of Object.values(teams)) T[4] = weekly ? Object.keys(T[4]).length : (T[4].g || 0);   // -> games
  Store.set(name, { v: 5, fetched: now_iso(), players, teams });
  if (weekly && Object.keys(log).length) Store.set(`nflv_log_${year}.json`, { v: 1, fetched: now_iso(), players: log });
  if (!weekly) Store.set(`nflv_car_${year}.json`, { v: 1, fetched: now_iso(), players: car });
  return players;
}
/* Team context from the stats cache (after nflv_stats): {team: {att_pg, pass_epa_pa, car_pg, rush_epa_pc, g}}. */
function nflv_team_ctx(year, weekly) {
  const c = Store.get(`nflv_${weekly ? "wk" : "reg"}_${year}.json`), out = {};
  for (const [tm, T] of Object.entries((c && c.teams) || {})) {
    const g = T[4] || 0;
    out[tm] = { g, att_pg: g ? T[0] / g : 0, pass_epa_pa: T[0] ? T[1] / T[0] : 0, car_pg: g ? T[2] / g : 0, rush_epa_pc: T[2] ? T[3] / T[2] : 0 };
  }
  return out;
}
/* Offensive snap shares by game (nflverse snap_counts, from Pro Football Reference): name|pos -> [[week, share], ...]. */
async function snap_stats(season, maxHours = 12) {
  const name = `snaps_${season}.json`, c = Store.get(name);
  if (c && c.v === 1 && Date.now() - new Date(c.fetched).getTime() < maxHours * 3600000) return c.players;
  const players = {};
  try {
    const txt = await Net.text(`${NFLV}snap_counts/snap_counts_${season}.csv`, null, 240000);
    for (const r of parse_csv(txt)) {
      if ((r.game_type || "REG") !== "REG" || !POSITIONS.includes(r.position)) continue;
      const snaps = parseFloat(r.offense_snaps) || 0;
      if (!(snaps > 0)) continue;
      const k = player_key(r.player || "", r.position);
      (players[k] = players[k] || []).push([parseInt(r.week, 10), Math.round((parseFloat(r.offense_pct) || 0) * 1000) / 1000]);
    }
  } catch (e) { return c ? c.players : {}; }
  for (const l of Object.values(players)) l.sort((a, b) => a[0] - b[0]);
  Store.set(name, { v: 1, fetched: now_iso(), players });
  return players;
}
/* NFL draft picks since 2000 (nflverse): name|pos -> [season, round, pick, team]. The values model reads the slot; the
   player card shows the line. Team codes come in Pro Football Reference's style (GNB, KAN); nfl_team() turns them into Sleeper's. */
const PFR_TEAMS = { GNB: "GB", KAN: "KC", NOR: "NO", NWE: "NE", SFO: "SF", TAM: "TB", LVR: "LV", SDG: "SD", LA: "LAR", RAM: "LAR", RAI: "OAK", CLT: "IND", CRD: "ARI", RAV: "BAL", HTX: "HOU", OTI: "TEN" };
const nfl_team = t => PFR_TEAMS[t] || t;
async function nflv_draft() {
  const c = Store.get("nflv_draft.json");
  if (c && c.v === 2 && Date.now() - new Date(c.fetched).getTime() < 20 * 86400000) return c.picks;
  const picks = {};
  try {
    for (const r of parse_csv(await Net.text(`${NFLV}draft_picks/draft_picks.csv`, null, 240000))) {
      if (!POSITIONS.includes(r.position) || parseInt(r.season, 10) < 2000) continue;
      picks[player_key(r.pfr_player_name || "", r.position)] = [parseInt(r.season, 10), parseInt(r.round, 10), parseInt(r.pick, 10), nfl_team(r.team || "")];
    }
  } catch (e) { if (c) return c.picks; throw e; }
  Store.set("nflv_draft.json", { v: 2, fetched: now_iso(), picks });
  return picks;
}
/* Age curves: the share of a player's peak production at each age (our research; tools/values/README.md "Age curves").
   QBs: points from running age like a runner's (peak 25-26, cliff 27-29), points from passing like a passer's (peak 30-31,
   ~90% at 36). RBs: prime 24-26, 8-16% dip at 27-28, a 25% cliff at 29. WRs: rise to 25, prime to 28, cliff at 30, except
   elite WRs (2+ top-12 seasons) who fade slowly into their mid-30s. */
const DMV_CURVES = {
  QB_mobile: { 21: .70, 22: .78, 23: .86, 24: .94, 25: 1, 26: 1, 27: .97, 28: .88, 29: .78, 30: .69, 31: .60, 32: .47, 33: .36, 34: .25, 36: .14, 38: .08, 40: .04, 42: .01 },
  QB_pocket: { 21: .36, 22: .42, 24: .58, 26: .75, 28: .90, 29: .96, 30: 1, 31: 1, 32: .98, 34: .94, 36: .90, 38: .82, 39: .70, 40: .50, 41: .30, 42: .15, 43: .07, 45: .02 },
  RB: { 20: .60, 21: .72, 22: .84, 23: .93, 24: .98, 25: 1, 26: .99, 27: .90, 28: .84, 29: .63, 30: .52, 31: .38, 32: .26, 33: .17, 34: .10, 35: .05, 37: .01 },
  WR: { 20: .55, 21: .65, 22: .77, 23: .88, 24: .95, 25: 1, 28: 1, 29: .96, 30: .90, 31: .80, 32: .65, 33: .50, 34: .37, 35: .25, 37: .10, 39: .02 },
  WR_elite: { 20: .55, 21: .65, 22: .77, 23: .88, 24: .95, 25: 1, 28: 1, 29: .98, 30: .95, 31: .90, 32: .84, 33: .76, 34: .62, 35: .45, 36: .30, 37: .18, 39: .04 },
  // TE: a steep learning curve 21-23 (blocking + routes), prime 24-27 (peak 27.4), a slight dip 28-29, a cliff from 30
  // (in-line wear). Elite TEs (2+ top-6 seasons: Kelce, Gonzalez, Gates, Witten) hold into their early 30s.
  TE: { 21: .45, 22: .55, 23: .68, 24: .85, 25: .94, 26: .98, 27: 1, 28: .98, 29: .94, 30: .82, 31: .68, 32: .54, 33: .42, 34: .32, 35: .22, 37: .08, 39: .02 },
  TE_elite: { 21: .45, 22: .55, 23: .68, 24: .85, 25: .94, 26: .98, 27: 1, 28: 1, 29: .97, 30: .92, 31: .86, 32: .78, 33: .68, 34: .56, 35: .42, 37: .20, 39: .05 },
};
const DMV_NOW_WEIGHT = 0.2;                                // the rest of this season counts 20%: dynasty is about the seasons ahead
const DMV_HORIZON = 7, DMV_MAX_GROWTH = 1.6, DMV_WR_YEAR2 = 1.25, DMV_ALPHA_TS = 0.25, DMV_ALPHA_BEST = 0.5;
function curve_at(name, age) {
  const c = DMV_CURVES[name], ks = Object.keys(c).map(Number).sort((a, b) => a - b);
  if (age <= ks[0]) return c[ks[0]];
  if (age >= ks[ks.length - 1]) return c[ks[ks.length - 1]];
  for (let i = 1; i < ks.length; i++) if (age <= ks[i]) { const a = ks[i - 1], b = ks[i]; return c[a] + (c[b] - c[a]) * (age - a) / (b - a); }
}
// QB: share of his points from running. WR: 1 = elite aging (2+ top-12 seasons), half for 1 season or a 27%+ target share.
function dmv_style(f) {
  if (f.pos === "QB") return Math.min(1, 1.3 * (f.rush || 0));
  if (f.pos === "WR") return f.top12 >= 2 ? 1 : (f.top12 === 1 || f.ts >= 0.27) ? 0.5 : 0;
  if (f.pos === "TE") return f.top6 >= 2 ? 1 : f.top6 === 1 ? 0.5 : 0;
  return 0;
}
function age_curve(f, age) {
  const m = dmv_style(f);
  if (f.pos === "QB") return m * curve_at("QB_mobile", age) + (1 - m) * curve_at("QB_pocket", age);
  if (f.pos === "WR") return m * curve_at("WR_elite", age) + (1 - m) * curve_at("WR", age);
  if (f.pos === "TE") return m * curve_at("TE_elite", age) + (1 - m) * curve_at("TE", age);
  return curve_at(f.pos, age);
}
// dynasty looks ahead: his production over the next 6 seasons along his curve, relative to today, later seasons counting less
function future_factor(f, disc) {
  const now = age_curve(f, f.age);
  let tot = 0, wsum = 0;
  for (let t = 0; t < DMV_HORIZON; t++) {
    let ratio = Math.min(DMV_MAX_GROWTH, age_curve(f, f.age + t) / now);
    if (t >= 1 && f.pos === "WR" && f.exp === 0) ratio = Math.min(DMV_MAX_GROWTH, ratio * DMV_WR_YEAR2);   // the year-2 jump
    const w = Math.pow(disc, t) * (t === 0 ? DMV_NOW_WEIGHT : 1); tot += w * ratio; wsum += w;
  }
  return tot / wsum;
}
/* Young breakouts (25.5 or younger, first 4 seasons): +10% for the rookie deal, up to +30% more for signs of the rise:
   a 22%+ target share (WR/TE), points per game up 30% on last year, or a rookie already at 11+ a game. */
const DMV_BREAKOUT_BASE = 0.10, DMV_BREAKOUT_MAX = 0.30;
function breakout(f) {
  if (f.exp > 3 || f.age > 25.5) return 1;
  const clip = v => Math.min(1, Math.max(0, v));
  let sig = f.pos === "WR" || f.pos === "TE" ? clip((f.ts - 0.12) / 0.10) : 0;
  if (f.g[0] >= 2 && f.g[1] >= 6 && f.ppg[1] > 0) sig = Math.max(sig, clip((f.ppg[0] / f.ppg[1] - 1) / 0.3));
  if (f.exp === 0 && f.g[0] >= 2) sig = Math.max(sig, clip((f.ppg[0] - 5) / 6));
  return 1 + DMV_BREAKOUT_BASE + DMV_BREAKOUT_MAX * sig;
}
function dmv_value(f, redraft, ours) {
  const p = ours ? DMV : DMV_MKT, pos = f.pos;
  // A few games don't rewrite a track record (three 27-point games made Brock Purdy the #2 asset overall). This season's
  // per-game number is believed in proportion to its games: for a player with a record it is shrunk toward his own
  // average over the last two seasons, with the record carrying the weight of 2 games per season of experience, up to
  // 6 (a rookie or second-year player is taken at face value: his first year says little about his second). A veteran
  // without eight recent games shrinks toward a typical starter's number instead.
  const pw = p.w25 * f.g[1] + p.w24 * f.g[2];
  const prior = pw > 0 && f.g[1] + f.g[2] >= 8 ? (p.w25 * f.g[1] * f.ppg[1] + p.w24 * f.g[2] * f.ppg[2]) / pw
    : DMV_TYPICAL[pos] + (pos === "QB" ? 0 : 2 * ((f.ppr ?? 0.5) - 0.5));
  const k0 = Math.min(6, 2 * Math.max(0, (f.exp || 0) - 1));
  const ppg0 = f.g[0] ? (f.g[0] * f.ppg[0] + k0 * prior) / (f.g[0] + k0) : 0;
  const wsum = p.w26 * f.g[0] + p.w25 * f.g[1] + p.w24 * f.g[2];
  const psum = p.w26 * f.g[0] * ppg0 + p.w25 * f.g[1] * f.ppg[1] + p.w24 * f.g[2] * f.ppg[2];
  const mean = wsum ? psum / wsum : 0;
  const full = [f.ppg[3], f.ppg[2], f.ppg[1], ppg0].filter((v, i) => [f.g[3], f.g[2], f.g[1], f.g[0]][i] >= 8);   // a best season needs eight games, this one too
  const bw0 = p["best_" + pos] ?? p.best;                     // how much the ceiling a player has shown counts (market: by position; QBs a lot)
  const bw = ours && f.pos === "WR" && f.ts >= DMV_ALPHA_TS ? Math.max(bw0, DMV_ALPHA_BEST) : bw0;   // alpha WRs: the target share says the talent is still there
  const gw = f.g[0] + f.g[1] + f.g[2] + f.g[3];
  const est = (gw * ((1 - bw) * mean + bw * (full.length ? Math.max(...full) : mean)) + (p.k || 0) * p["R_" + pos]) / Math.max(1e-9, gw + (p.k || 0));   // few games: pull toward replacement
  let estR = est;
  if (redraft) {
    // Redraft: the rest of this season. This season's games count at face value (last season is in the blend already, so
    // there is no second shrink toward his own past), last season and the one before at the market's weights, and a thin
    // sample shrinks toward a replacement-level player with the weight of four games: one big game as a fill-in can't
    // make anyone a QB2 (Case Keenum's 24.5-point start). No games this season or last: no value (a dozen idle backups
    // once sat at RB31-42 because a typical starter's number stood in for them, 2026-10-06).
    // This season's rate is over the games he could have played: a healthy scratch counts as a zero (Austin Ekeler's one
    // game in four made him RB38). Last season counts only as far as he still has the job: his opportunities a game now
    // against last season's (from week 3); under 60% of last year's volume, the old numbers fade with it (Jauan Jennings
    // at 0.6 a game was WR56 on last season's 9.7).
    const ge = f.g0r ?? f.g0e ?? f.g[0], pts0 = f.g[0] * f.ppg[0];
    const keep = f.week >= 3 && f.oppLast > 0 && f.oppNow != null ? Math.min(1, Math.max(0.15, f.oppNow / (0.6 * f.oppLast))) : 1;
    const wr = p.w26 * ge + keep * (p.w25 * f.g[1] + p.w24 * f.g[2]);
    const meanR = wr ? (p.w26 * pts0 + keep * (p.w25 * f.g[1] * f.ppg[1] + p.w24 * f.g[2] * f.ppg[2])) / wr : 0;
    const repl = DMV_REPLACEMENT[pos] + (pos === "QB" ? 0 : 2 * ((f.ppr ?? 0.5) - 0.5)), gr = ge + 0.5 * Math.min(17, f.g[1]);
    estR = gr > 0 ? (gr * meanR + 4 * repl) / (gr + 4) : 0;
  }
  // the market keeps paying for a high pick's pedigree for years (two QBs with the same numbers: the first-rounder costs more)
  const ped = redraft ? 1 : 1 + (p.ped || 0) * Math.exp(-(f.pick || 400) / Math.max(5, p.L));
  const prodv = p["S_" + pos] * Math.pow(Math.max(0, (redraft ? estR : est) - p["R_" + pos]), p["E_" + pos]) * ped;
  if (ours) f.est = est;
  let avail = 1;
  if (redraft) {                                                                 // redraft: the rest of this season is what he is worth
    if (["IR", "PUP", "DNR", "NA"].includes(f.inj)) avail *= 0.35;              // on a reserve list: most of the season is in doubt
    else if (["Out", "Sus"].includes(f.inj)) avail *= 0.75;
    else if (f.inj === "Doubtful") avail *= 0.9;
  } else if (["IR", "PUP", "Out", "Sus", "DNR", "NA"].includes(f.inj)) avail *= 0.8;
  if (!f.team) avail *= 0.55;
  if (f.depth && f.depth > DMV_DEPTH_MAX[pos] && !(redraft && f.inj)) avail *= 0.7;   // (redraft: an injured player's depth slot is the injury, not his role)
  const playing = f.week >= 2 && f.g[0] >= 0.6 * f.week;                      // has played most of this season's games
  if ((ours || redraft) && pos === "QB" && f.depth >= 2 && !playing) avail *= 0.45;        // our grade and redraft: a backup QB scores nothing until he starts
  if (f.team && !f.g[0] && !f.inj && f.week >= 3) {                                        // healthy but not playing this season
    if (redraft) avail *= 0.4;                                                             // redraft: not a rest-of-season asset until he plays
    else if (ours && f.exp >= 2) avail *= 0.7;
  }
  if (redraft) return prodv * avail;
  const draftv = p["D_" + pos] * Math.exp(-(f.pick || 400) / Math.max(5, p.L));
  const games = f.g[0] + f.g[1] + f.g[2] + f.g[3];
  const kd = p.kd * (f.exp <= 3 ? 1 : 0.25 + 0.75 * Math.exp(-(f.pick || 400) / Math.max(5, p.L)));   // a top pick's pedigree is remembered for years
  const wd = kd / (kd + games);
  const base = (1 - wd) * prodv + wd * draftv;
  if (ours) f.wd = wd;
  const agem = ours ? breakout(f) * future_factor(f, p.disc) * (1 + p.young * Math.min(4, Math.max(0, 26 - f.age)) / 4)   // youth: room to grow
    : Math.exp(-p["dec_" + pos] * Math.max(0, f.age - (pos === "QB" ? Math.max(p["peak_" + pos], 31) : p["peak_" + pos]))) * (1 + p.young * Math.min(Math.max(0, p["peak_" + pos] - f.age), 4) / 4);   // QBs hold their peak through 31 (passers peak ~30.7)
  const v = Math.max(0, base * agem * avail);
  return v * p.C / (v + p.C);
}
/* A player's game log for a season (nflverse weekly stats): one row per game, with the stat line and the fantasy points
   in this league's PPR. Weeks he has no game (a bye, injured, inactive) are rows with game = null. */
async function game_log(cfg, name, pos, year) {
  const season = parseInt(cfg.season, 10), nm = `nflv_log_${year}.json`;
  await nflv_stats(year, true, year === season ? 12 : 24 * 30);
  let c = Store.get(nm);
  if (!c || c.v !== 1) { await nflv_stats(year, true, 0); c = Store.get(nm); }             // a cache from before the game log
  if (!c) return { rows: [], last: 0 };
  let last = year === season ? 0 : 18;
  if (year === season) for (const g of Object.values(c.players)) for (const w of Object.keys(g)) last = Math.max(last, +w);
  const mine = c.players[player_key(name, pos)] || {}, ppr = parseFloat(cfg.league.ppr || 0);
  const played = Object.keys(mine).map(Number);
  if (!played.length) return { rows: [], last };
  if (year !== season) last = Math.max(...played, year >= 2021 ? 18 : 17);            // 18 weeks since 2021
  const rows = [];
  for (let w = 1; w <= last; w++) {
    const o = mine[w];
    if (!o) { rows.push({ week: w, game: null }); continue; }
    const [opp, std, pp, cmp, att, pyd, ptd, int, car, ryd, rtd, rec, tgt, recyd, rectd] = o;
    rows.push({ week: w, game: { opp: opp === "LA" ? "LAR" : opp, pts: std + ppr * (pp - std), cmp, att, pyd, ptd, int, car, ryd, rtd, rec, tgt, recyd, rectd } });
  }
  return { rows, last };
}
/* A player's career, one row a season, from nflverse season stats (back to 1999). Each past season's file is downloaded
   once and kept as a compact table (nflv_car_{year}.json); this season comes from the game log. progress(row, year) is
   called as rows arrive (row null while a year is loading), so the card can fill in as it goes. */
async function career_season(y) {
  const nm = `nflv_car_${y}.json`;
  let c = Store.get(nm);
  if (c && c.v === 1) return c.players;
  await nflv_stats(y, false, 0);                                    // downloads the season and writes the career table too
  c = Store.get(nm);
  if (!c) throw new Error(`no ${y} stats`);
  return c.players;
}
async function career_stats(cfg, a, progress = () => {}) {
  const season = parseInt(cfg.season, 10), k = player_key(a.name, a.pos), ppr = parseFloat(cfg.league.ppr || 0);
  let first = null;                                                 // his first NFL season, from Sleeper's years of experience
  try { const s = (await sleeper_players())[String(a.sleeper_id || "")]; if (s && s.years_exp != null && s.years_exp !== "") first = season - parseInt(s.years_exp, 10); } catch (e) {}
  const rows = [];
  const cur = await game_log(cfg, a.name, a.pos, season).catch(() => ({ rows: [] }));
  const games = cur.rows.filter(r => r.game).map(r => r.game);
  if (games.length) {
    const sum = f => games.reduce((s, g) => s + (g[f] || 0), 0);
    const row = { year: season, team: a.team && a.team !== "FA" ? a.team : "", g: games.length, pts: sum("pts"), cmp: sum("cmp"), att: sum("att"), pyd: sum("pyd"), ptd: sum("ptd"),
      int: sum("int"), car: sum("car"), ryd: sum("ryd"), rtd: sum("rtd"), rec: sum("rec"), tgt: sum("tgt"), recyd: sum("recyd"), rectd: sum("rectd") };
    rows.push(row); progress(row, null);
  }
  let misses = 0, failed = false;
  const stop = Math.max(1999, first != null ? first : season - 25);
  for (let y = season - 1; y >= stop; y--) {
    progress(null, y);
    let t;
    try { t = await career_season(y); } catch (e) { failed = true; continue; }
    const o = t[k];
    if (!o) { if (first == null && ++misses >= 2) break; continue; }   // first season unknown: stop after two empty years
    misses = 0;
    const [team, g, std, pp, cmp, att, pyd, ptd, int, car, ryd, rtd, rec, tgt, recyd, rectd] = o;
    const row = { year: y, team, g, pts: std + ppr * (pp - std), cmp, att, pyd, ptd, int, car, ryd, rtd, rec, tgt, recyd, rectd };
    rows.push(row); progress(row, null);
  }
  if (failed) throw Object.assign(new Error("Some seasons couldn't be loaded"), { rows });
  return rows;
}
/* A player's fantasy points in each game this season, in the league's PPR (nflverse weekly stats). */
async function weekly_points(cfg, name, pos) {
  const wk = await nflv_stats(parseInt(cfg.season, 10), true, 12), o = wk[player_key(name, pos)];
  const ppr = parseFloat(cfg.league.ppr || 0);
  if (!o || !o[3]) return [];
  return Object.entries(o[3]).map(([w, [std, pp]]) => ({ week: parseInt(w, 10), pts: std + ppr * (pp - std) })).sort((a, b) => a.week - b.week);
}
async function src_dmv(cfg, curve, ours) {
  const lg = cfg.league, season = parseInt(cfg.season, 10), ppr = parseFloat(lg.ppr || 0), sf = parseInt(lg.num_qbs, 10) >= 2;
  const redraft = is_redraft(cfg), teams = parseInt(lg.teams, 10) || 12;
  const [cur, y1, y2, y3, draft, sl] = await Promise.all([nflv_stats(season, true, 12), nflv_stats(season - 1, false, 24 * 30),
    nflv_stats(season - 2, false, 24 * 60), nflv_stats(season - 3, false, 24 * 90), nflv_draft(), sleeper_players()]);
  const ep = ours ? await ep_stats(season).catch(() => ({})) : {};               // expected points: for the grades, the card and the GM
  const snaps = ours ? await snap_stats(season).catch(() => ({})) : {};           // snap shares, for the prediction models
  const tctx = nflv_team_ctx(season, true);                                       // each team's pass volume and EPA
  const hot = new Set();                                                           // the players the whole platform is adding this week (a role opened)
  if (ours) { try { for (const r of (await trending_list("adds", 40, null, true)).rows || []) if (r.count >= 100000) hot.add(String(r.sid)); } catch (e) { /* no trending: no floor from it */ } }
  const now = Date.now(), players = [];
  const pg = o => o && o[0] ? (o[1] + ppr * (o[2] - o[1])) / o[0] : 0;           // points per game in this league's PPR
  const top12 = {};                                                               // WR1 seasons: top 12 WRs by total points
  for (const yr of [y1, y2, y3]) Object.entries(yr).filter(([k]) => k.endsWith("|WR")).map(([k, o]) => [k, o[1] + 0.5 * (o[2] - o[1])])
    .sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k]) => { top12[k] = (top12[k] || 0) + 1; });
  let week = 0;                                                                   // the latest week played this season
  for (const o of Object.values(cur)) if (o[3]) for (const w of Object.keys(o[3])) week = Math.max(week, +w);
  const top6 = {};                                                                // TE1 seasons: top 6 TEs by total points
  for (const yr of [y1, y2, y3]) Object.entries(yr).filter(([k]) => k.endsWith("|TE")).map(([k, o]) => [k, o[1] + 0.5 * (o[2] - o[1])])
    .sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k]) => { top6[k] = (top6[k] || 0) + 1; });
  // team pass volume: QB pass attempts per team game (last season, blended half and half with this one from week 3)
  const passVol = {}, NFLV_TEAM = { LA: "LAR" };
  const addVol = (yr, w) => {
    const t = {};
    for (const [k, o] of Object.entries(yr)) {
      if (!o[8]) continue;
      const T = t[NFLV_TEAM[o[8]] || o[8]] || (t[NFLV_TEAM[o[8]] || o[8]] = { att: 0, g: 0 });
      if (k.endsWith("|QB")) T.att += o[9] || 0;
      T.g = Math.max(T.g, o[0]);
    }
    for (const [tm, T] of Object.entries(t)) if (T.g) { const P = passVol[tm] || (passVol[tm] = { s: 0, w: 0 }); P.s += w * T.att / T.g; P.w += w; }
  };
  addVol(y1, week >= 3 ? 0.5 : 1);
  if (week >= 3) addVol(cur, 0.5);
  const owners = {};                                                              // the Sleeper players sharing a name|pos key (Frank Gore Sr. and Jr.)
  for (const s of Object.values(sl)) if (POSITIONS.includes(s.position)) { const k = player_key(s.full_name || `${s.first_name || ""} ${s.last_name || ""}`.trim(), s.position); (owners[k] = owners[k] || []).push(s); }
  for (const [sid, s] of Object.entries(sl)) {
    const pos = s.position;
    if (!POSITIONS.includes(pos)) continue;
    const name = s.full_name || `${s.first_name || ""} ${s.last_name || ""}`.trim(), k = player_key(name, pos);
    const st = [cur[k], y1[k], y2[k], y3[k]];
    if (s.active === false) continue;                                               // retired or out of the league, says Sleeper (Jacoby Jones was WR122)
    if (!s.team && owners[k].length > 1 && owners[k].some(o => o !== s && o.team)) continue;   // a retired namesake would inherit the active player's stats (Frank Gore Sr. sat at RB62)
    if (!s.team && !st[0] && !st[1]) continue;                                      // retired or long gone
    if (redraft && !s.team && week >= 2) continue;                                  // redraft: a free agent isn't scoring; he comes back when he signs (Kareem Hunt, Nick Chubb, Tyreek Hill sat at RB52-WR73)
    const exp = parseInt(s.years_exp || 0, 10);
    const d = draft[k] && Math.abs(draft[k][0] - (season - exp)) <= 1 ? draft[k] : null;
    if (!st.some(Boolean) && !d) continue;                                          // no NFL stats and never drafted
    const age = s.birth_date ? (now - new Date(s.birth_date).getTime()) / (365.25 * 86400000) : (s.age || 26);
    const f = { pos, age, exp, team: s.team || null, depth: s.depth_chart_order || null, inj: s.injury_status || null, pick: d ? d[2] : null,
      g: st.map(o => (o ? o[0] : 0)), ppg: st.map(pg), ppr };
    const rush = st.reduce((a, o) => a + (o ? (o[4] || 0) / 10 + 6 * (o[5] || 0) : 0), 0), all = st.reduce((a, o) => a + (o ? o[1] : 0), 0);
    f.rush = all > 0 ? Math.min(1, Math.max(0, rush / all)) : 0;
    f.top12 = top12[k] || 0;
    f.week = week;
    f.top6 = top6[k] || 0;
    f.tpg = st[0] && st[0][0] >= 2 ? (st[0][10] || 0) / st[0][0] : st[1] && st[1][0] ? (st[1][10] || 0) / st[1][0] : 0;   // targets per game
    // opportunities a game (pass attempts / carries + targets / targets): this season, with healthy weeks he sat out
    // counted as zero, plus last season at about a third of the weight
    const oppTot = o => (o ? (pos === "QB" ? o[9] || 0 : pos === "RB" ? (o[11] || 0) + (o[10] || 0) : o[10] || 0) : 0);
    const g0 = st[0] ? st[0][0] : 0, g1 = st[1] ? Math.min(17, st[1][0]) : 0;
    const g0e = week >= 2 && !s.injury_status ? Math.max(g0, Math.floor(0.75 * week)) : g0, w1 = 0.35 * g1;
    f.opg = g0e + w1 > 0 ? (oppTot(st[0]) + (g1 ? w1 * oppTot(st[1]) / st[1][0] : 0)) / (g0e + w1) : null;
    f.g0e = g0e;                                                                    // this season's games with a healthy player's missed games counted
    f.g0r = s.depth_chart_order === 1 ? g0 : g0e;                                   // the redraft rate: a starter who missed games was hurt, not scratched (Puka Nacua, 2 of 4)
    f.oppNow = g0e ? oppTot(st[0]) / g0e : null; f.oppLast = st[1] && st[1][0] ? oppTot(st[1]) / st[1][0] : null;
    const gamePts = st[0] && st[0][3] ? Object.values(st[0][3]).map(([sd, pp]) => sd + ppr * (pp - sd)).sort((x, y) => y - x) : [];
    f.best = gamePts[0] || 0; f.best2 = gamePts[1] || 0;                              // his best two games this season
    f.passVol = s.team && passVol[s.team] ? passVol[s.team].s / passVol[s.team].w : null;
    f.ts = Math.max((st[1] && st[1][6]) || 0, st[0] && st[0][0] >= 3 ? st[0][6] || 0 : 0);
    const e = ep[k]; f.ep = e && e[0] >= 3 ? { g: e[0], pts: e[1], exp: e[2], td: e[3], tdx: e[4] } : null;   // three games before usage says anything
    f.hot = hot.has(String(sid));
    if (ours && typeof Predict !== "undefined" && Predict.ready()) {             // the fitted forecasts: next season, the chance he plays, the rest of this season
      f.ageNext = age + (new Date(season + 1, 8, 1).getTime() - now) / (365.25 * 86400000);
      f.pred = Predict.season({ pos, age, ageNext: f.ageNext, exp, pick: d ? d[2] : null, depth: s.depth_chart_order || null, inj: s.injury_status || null,
        cur: st[0], y1: st[1], y2: st[2], ep: ep[k], snaps: snaps[k], teamCtx: s.team ? tctx[s.team] : null, week });
    }
    let v = dmv_value(f, redraft, ours);
    if (pos === "QB" && !sf) v *= DMV_PRIOR_ADJ.QB;
    const adj = DMV_ADJUST[sid];
    if (adj) v *= adj[0];
    if (!(v >= 30)) continue;                                                       // (also drops a NaN)
    players.push({ key: k, name, pos, team: s.team || "FA", age: Math.round(age * 10) / 10, sleeper_id: sid, value: v,
      raw: (adj ? adj[1] + ". " : "") + `DMV ${Math.round(v)} (${f.ppg[0] ? f.ppg[0].toFixed(1) + " ppg this year" : f.ppg[1] ? f.ppg[1].toFixed(1) + " ppg last year" : d ? "drafted #" + d[2] : "no games"})`,
      _rookie: d && d[0] === season, _f: ours ? f : undefined, ep: f.ep || null });
  }
  if (ours) { grade_scores(players, cfg, redraft); for (const x of players) delete x._f; return players; }
  // picks: the rookie class's values by draft slot (this year's class once it's drafted, else last year's)
  let cls = players.filter(x => x._rookie).map(x => x.value).sort((a, b) => b - a);
  if (cls.length < teams * 2) cls = players.filter(x => x.age < 24.5 && x.value > 0).map(x => x.value).sort((a, b) => b - a);
  const at = n => n < cls.length ? cls[n] : (cls[cls.length - 1] || 50) * Math.pow(0.8, (n - cls.length + 1) / teams);
  const picks = [];
  if (!redraft && cls.length) for (let y = season + 1; y <= season + 3; y++) for (let rnd = 1; rnd <= 5; rnd++) {
    const disc = Math.pow(0.8, y - (season + 1)), boost = DMV_PICK_BOOST[rnd - 1] || 1;
    for (const [tier, fr] of [[null, 0.5], ["early", 0.17], ["mid", 0.5], ["late", 0.83]])
      picks.push({ season: y, round: rnd, tier, value: at(Math.floor((rnd - 1 + fr) * teams)) * disc * boost });
  }
  for (const x of players) delete x._rookie;
  if (curve) on_market_curve(players, curve);                                       // blended with other lists: share their curve
  scale_group([players, picks]);
  return { name: "dmv", players, picks, meta: { season, stats: "nflverse (CC BY 4.0)" } };
}
async function fetch_all_sources(cfg, log) {
  const results = [], notes = [];
  let fc_curve = null;
  const fns = { keeptradecut: src_keeptradecut, dynastydaddy: src_dynastydaddy, fantasypros: src_fantasypros, draftsharks: src_draftsharks,
    dynastyprocess: src_dynastyprocess, sleeper_proj: src_sleeper_proj, ffcalculator: src_ffcalculator, dmv: src_dmv };
  const want = SOURCE_ORDER.filter(n => source_settings(cfg, n)[0] && source_applies(cfg, n));
  if (want.includes("fantasycalc")) {
    try {
      const r = await src_fantasycalc(cfg);
      fc_curve = rank_curve(r.players);
      results.push(r);
      log(`FantasyCalc: ${r.players.length} players, ${r.picks.length} picks`);
    } catch (e) { log(`FantasyCalc failed: ${e.message}`); notes.push(`fantasycalc: ${e.message}`); }
  }
  // the other lists only need FantasyCalc's value curve, so they download side by side
  const rest = await Promise.all(want.filter(n => n !== "fantasycalc").map(n => fns[n](cfg, fc_curve).then(
    r => { log(`${SOURCES[n].label}: ${r.players.length} players` + (r.picks.length ? `, ${r.picks.length} picks` : "")); return r; },
    e => { log(`${SOURCES[n].label} failed: ${e.message}`); notes.push(`${n}: ${e.message}`); return null; })));
  const order = Object.fromEntries(SOURCE_ORDER.map((n, i) => [n, i]));
  for (const r of rest) if (r) results.push(r);
  results.sort((a, b) => order[a.name] - order[b.name]);
  return [results, notes];
}

/* Our dynasty view, as a value on the market's scale: rank the players by our view, then give the player we rank Nth the
   market value of the market's Nth player. a.ours drives the grade; a.value (the market) still drives trades and ranks. */
/* Our dynasty grade: a report-card score out of 100 that predicts what his future holds, not a rank. A young, productive player can grade well even where
   the market ranks him lower, and an old one grades lower than his rank.
     production 35%: how he scores (per game, this season and last) against the starters at his position; until he has
                     8 games, his NFL draft slot fills in
     runway     40%: how much of his prime is left over the next 5 seasons (our age curves)
     role       15%: his place on the depth chart
     health     10%: games played this season and last, and his injury status today
     QB bonus: up to +12 points in superflex, +5 in 1QB (QBs are the scarcest starters)
     TEs (our TE research): situation 20% (role 5%, production 30%, runway 35%): his target share (a receiving weapon, not an
     in-line blocker), his team's pass volume, where he sits in the team's target order (best: #2 behind an alpha WR),
     and his QB (a good one; a pocket passer looks for the big frame in the red zone, a runner keeps those TDs) */
const GRADE_W = { prod: 0.35, runway: 0.40, role: 0.15, health: 0.10 };
const GRADE_W_TE = { prod: 0.30, runway: 0.35, role: 0.05, situation: 0.20, health: 0.10 };   // TE output lives on its situation
// Redraft: most points wins, this season only. No age, runway or draft slot; players are replaceable, so the scale is
// tighter (a fringe starter is a waiver pickup) and health means the rest of this season.
const GRADE_W_RD = { prod: 0.65, role: 0.20, health: 0.15 };
const GRADE_W_RD_TE = { prod: 0.50, role: 0.10, situation: 0.25, health: 0.15 };
// With the fitted forecast (predict.js) the forecast already carries role, health and age, so it gets most of the
// weight and the letters spread out: a starter runs from C+ to A+ by his forecast instead of B- to A+ (2026-10-07).
const GRADE_W_FC = { prod: 0.55, runway: 0.25, role: 0.10, health: 0.10 };
const GRADE_W_FC_TE = { prod: 0.50, runway: 0.20, role: 0.05, situation: 0.15, health: 0.10 };
const GRADE_W_FC_RD = { prod: 0.75, role: 0.10, health: 0.15 };
const GRADE_W_FC_RD_TE = { prod: 0.60, role: 0.05, situation: 0.20, health: 0.15 };
const GRADE_QB_SF = 12, GRADE_QB_1QB = 7;                   // QB scarcity bonus, in points (QBs cost more than calculators say, in every format)
const GRADE_QB_SF_FC = 8, GRADE_QB_1QB_FC = 4;              // with the fitted forecast the bonus is smaller and squared: it lifts the top QBs, not the top ten (eight A+ QBs said nothing)
const GRADE_TE_PREM = 8;                                    // TE premium leagues: up to +8 for a TE who produces
const GRADE_CUTS = [[92, "A+"], [87, "A"], [82, "A-"], [77, "B+"], [72, "B"], [67, "B-"], [62, "C+"], [57, "C"], [52, "C-"], [38, "D"], [-1, "F"]];   // F from 38 down (was 42): F is for nothing going
/* The forecast's view of a player over the next seasons, in points a game: next season's forecast, then the model's own
   age effect for the two after it (discounted 0.7 and 0.5), times the chance he plays. */
function forecast_age_at(pos, age) {
  const ae = typeof Predict !== "undefined" ? Predict.age_effect(pos) : null;
  if (!ae) return 1;
  // the learned curve, held non-increasing from 27 on: the few 32-year-olds still starting are the survivors, not the rule
  const i = Math.min(ae.ages.length - 1, Math.max(0, Math.round(age) - ae.ages[0]));
  let v = ae.ppg_next[i];
  for (let j = Math.max(0, 27 - ae.ages[0]); j <= i; j++) v = Math.min(v, ae.ppg_next[j]);
  return Math.max(0.5, v);
}
/* How much of today's level a player keeps t seasons out: half the learned age effect, half our research age curves. */
function forecast_age_ratio(f, a0, t) {
  const learned = forecast_age_at(f.pos, a0 + t) / forecast_age_at(f.pos, a0);
  const curve = age_curve(f, a0 + t) / Math.max(0.05, age_curve(f, a0));
  return clip01(0.5 * learned + 0.5 * curve, 0.1, 1.2);
}
function forecast_horizon(f) {
  const p = f.pred, a0 = f.ageNext || f.age || 27, base = Math.max(0.1, p.next);
  return base * (1 + 0.7 * forecast_age_ratio(f, a0, 1) + 0.5 * forecast_age_ratio(f, a0, 2)) / 2.2 * (0.6 + 0.4 * (p.play ?? 1));
}
function forecast_runway(f) {
  const a0 = f.ageNext || f.age || 27;
  let s = 0;
  for (let t = 1; t <= 5; t++) s += Math.min(1, forecast_age_ratio(f, a0, t)) / 5;
  return s;
}
const clip01 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function grade_scores(players, cfg, redraft) {
  const lg = cfg.league, teams = parseInt(lg.teams, 10) || 12, sf = parseInt(lg.num_qbs, 10) >= 2, ppr = parseFloat(lg.ppr || 0);
  const starters = { QB: sf ? 2 : 1, RB: 2.5, WR: 3.5, TE: 1.2 };
  const boomAt = { QB: 24, RB: 16 + 4 * ppr, WR: 16 + 4 * ppr, TE: 12 + 4 * ppr };   // a breakout game: about a top-12 week at his position
  const tep = Math.min(1, parseFloat(lg.te_premium_bonus_pct || 0) / 20);                // TE premium: the full bonus at +20% (a point a catch)
  const clip = v => Math.min(1, Math.max(0, v));
  const starting = f => (f.week >= 2 && f.g[0] >= 0.6 * f.week) || f.depth === 1;
  const byTeam = {};                                                              // each team's pass catchers, most targets first
  for (const x of players) if (x._f && x._f.team && x.pos !== "QB") (byTeam[x._f.team] = byTeam[x._f.team] || []).push(x);
  for (const l of Object.values(byTeam)) l.sort((a, b) => b._f.tpg - a._f.tpg);
  for (const pos of POSITIONS) {
    let group = players.filter(x => x.pos === pos && x._f).sort((a, b) => (b._f.est || 0) - (a._f.est || 0));
    const span = (redraft ? 1.5 : 2) * teams * (starters[pos] || 1);   // the top starter scores 1, a fringe starter about 0.5 (redraft: lower)
    // points a game for the grade: this season, last season and (dynasty) the one before, games-weighted, steadied by
    // 2 games of a typical starter at his position, not replacement level: 3 good games should count. No games at all: 0.
    const prior = (group[Math.min(group.length - 1, Math.round(teams * (starters[pos] || 1) / 2))] || {})._f?.est || 0;
    const WS = redraft ? [1, 0.35, 0] : [1, 0.6, 0.3];
    for (const x of group) {
      const f = x._f, w = WS.map((wi, i) => wi * Math.min(f.g[i], 17)), ws = w[0] + w[1] + w[2];
      const kp = ws < 4 ? 4 : 2;                                   // under four games: the prior carries four games of weight
      // this season's points, pulled 40% of the way toward what his usage was worth (expected points predict what comes
      // next better than the points themselves): a player scoring under his usage grades up, one running hot grades down
      const epr = f.ep && f.ep.pts > 0 ? Math.min(1.6, Math.max(0.6, f.ep.exp / f.ep.pts)) : 1, p0 = f.ppg[0] * (0.6 + 0.4 * epr);
      f.gest = ws > 0 ? (w[0] * p0 + w[1] * f.ppg[1] + w[2] * f.ppg[2] + kp * prior) / (ws + kp) : 0;
      if (!redraft && (pos === "WR" || pos === "TE") && f.ts >= DMV_ALPHA_TS && ws > 0) {   // an alpha's target share says the talent is still there
        const best = Math.max(0, ...[1, 2, 3].filter(i => f.g[i] >= 8).map(i => f.ppg[i]), f.g[0] >= 4 ? f.ppg[0] : 0);
        if (best > f.gest) f.gest = 0.5 * f.gest + 0.5 * best;
      }
    }
    group = group.sort((a, b) => b._f.gest - a._f.gest);
    // the fitted forecast, when the models are loaded: dynasty = the next three seasons, discounted and weighted by the
    // chance he plays (the model's own age effect does the aging: not every 26-year-old RB is the same); redraft = the
    // rest of this season. Ranked against the position's starters like the production rank it replaces.
    const fcOf = f => (f.pred && f.pred.next != null ? (redraft ? f.pred.ros : forecast_horizon(f)) : null);
    const fcs = group.map(x => fcOf(x._f)).filter(v => v != null).sort((a, b) => b - a);
    group.forEach((x, i) => {
      const f = x._f, fc = fcOf(f);
      const fi = fc != null ? Math.max(0, fcs.findIndex(v => v <= fc)) : i;
      const prodRank = Math.pow(clip(1 - fi / span), 1.25);                    // steeper: a low-end producer scores little
      // role = how much he is used: pass attempts (QB), carries + targets (RB), targets (WR/TE) a game. Full credit at
      // 28 / 18 / 7 / 6, nothing at 12 / 4 / 2 / 1.5. No games to go on: the depth chart, at most half.
      const [lo, hi] = { QB: [12, 28], RB: [4, 18], WR: [2, 7], TE: [1.5, 6] }[pos];
      const dd = f.depth;
      const depthRole = !f.team ? 0.1 : dd == null ? 0.3 : dd === 1 ? 0.5 : dd === 2 ? 0.3 : 0.15;
      const usage = f.opg == null ? depthRole : clip((f.opg - lo) / (hi - lo));
      const draft = f.pick ? (pos === "QB" ? 0.8 : 1) * clip(1 - (f.pick - 1) / 120) : 0;   // a top QB pick projects as a good starter, not a proven star
      const games = f.g[0] + f.g[1] + f.g[2] + f.g[3];
      // draft slot stands in only for games he hasn't played (at most half), and only as far as he is being used
      const wdraft = fc != null ? 0 : (redraft ? (f.g[0] ? 0 : 0.5) : 0.5) * clip((8 - games) / 8);   // (the forecast already weighs his draft slot)
      let prod = Math.min(1, (1 - wdraft) * prodRank + wdraft * draft * (f.opg == null ? 1 : usage));
      // young players (dynasty): the ball he is getting now predicts the points to come (our research: target share leads
      // production, and the year-2 jump). Up to half the gap to full production, for a 22-year-old who is a full-time target.
      const grow = fc == null && !redraft && f.age <= 25.5 && f.exp <= 3 && f.opg != null ? 0.5 * usage * clip((26 - f.age) / 4) : 0;
      prod += (1 - prod) * grow;
      // Points follow the ball: a starter's share of targets, carries or attempts predicts the points to come, so a WR1 or
      // RB1 having a quiet month is not a waiver player. Volume closes part of the gap to his usage: more early in the
      // season (a 3-game sample), less once 12+ games say the volume isn't turning into points. 2 targets a game move nothing,
      // and volume alone can only imply a solid starter (0.8), never an elite one: that takes points.
      if (fc == null && usage > prod && prod < 0.8) prod += (Math.min(usage, 0.8) - prod) * ((pos === "QB" ? 0.5 : 0.6) - 0.25 * clip(f.g[0] / 12));
      let runway = 0;
      if (fc != null && !redraft) runway = forecast_runway(f);  // the model's age effect: the share of today's level he keeps over the next five seasons
      else for (let t = 1; t <= 5; t++) runway += age_curve(f, f.age + t) / 5;
      runway *= 0.7 + 0.3 * prod;                              // a long future is only as bright as the talent in it
      if (redraft) runway = 1;
      const role = !f.team ? Math.min(usage, 0.1) : usage;
      const hs = [];
      if (f.week >= 1 && (f.depth === 1 || f.inj)) hs.push(clip(f.g[0] / Math.max(1, f.week * 0.85)));   // games missed as the starter or hurt, not on the bench
      if (f.exp >= 1 && !(redraft && hs.length)) hs.push(clip(f.g[1] / 15));   // redraft: this season is what counts
      let health = hs.length ? hs.reduce((s, v) => s + v, 0) / hs.length : 1;
      health *= { IR: 0.5, PUP: 0.5, Out: 0.6, Sus: 0.6, DNR: 0.4, NA: 0.6, Doubtful: 0.8, Questionable: 0.95 }[f.inj] || 1;
      health *= 0.4 + 0.6 * role;                                // a healthy backup gets little credit for being healthy
      if (fc != null && !redraft && f.pred.play != null) health = 0.5 * health + 0.5 * f.pred.play;   // and the model's chance he plays 4+ games next season
      // QBs are the scarcest starters, most of all in superflex (2 start): up to +12 points there, +5 in 1QB
      const qb = pos === "QB" ? (fc != null ? (sf ? GRADE_QB_SF_FC : GRADE_QB_1QB_FC) * prod * prod : (sf ? GRADE_QB_SF : GRADE_QB_1QB) * prod) : 0;
      x._prod = prod; x.games = games; x.patient = games < 8 || (pos === "TE" && f.exp <= 1);   // TEs: about half break out within 2 seasons
      if (f.pred) x.pred = { next: Math.round(f.pred.next * 10) / 10, play: Math.round(f.pred.play * 100) / 100, ros: Math.round(f.pred.ros * 10) / 10, horizon: redraft ? null : Math.round(forecast_horizon(f) * 10) / 10 };
      if (redraft) {                                            // most points wins: production, role, health (TEs: + situation)
        const W = pos === "TE" ? (fc != null ? GRADE_W_FC_RD_TE : GRADE_W_RD_TE) : (fc != null ? GRADE_W_FC_RD : GRADE_W_RD), sit = pos === "TE" ? te_situation(x, byTeam, players, starting, clip) : null;
        x.score = Math.min(100, Math.round(grade_floor(100 * (W.prod * prod + W.role * role + W.health * health + (sit != null ? W.situation * sit : 0)) + qb, f, pos, prod, role, true)));
        x.parts = [prod, null, role, health, sit].map(v => (v == null ? null : Math.round(v * 100)));
        return;
      }
      if (pos === "TE") {
        const sit = te_situation(x, byTeam, players, starting, clip), W = fc != null ? GRADE_W_FC_TE : GRADE_W_TE;
        let tscore = 100 * (W.prod * prod + W.runway * runway + W.role * role + W.situation * sit + W.health * health) + GRADE_TE_PREM * tep * prod;
        if (!redraft && role >= 0.6 && prod >= 0.35) tscore = Math.max(tscore, GRADE_FLOOR_D);
        tscore = prospect_lens(tscore, f, pos, usage, sit, group, span, redraft);
        x.score = Math.min(100, Math.round(grade_floor(crystal_ball(tscore, f, pos, usage, redraft, boomAt[pos]), f, pos, prod, role, redraft)));
        x.parts = [prod, runway, role, health, sit].map(v => Math.round(v * 100));
        return;
      }
      const WG = fc != null ? GRADE_W_FC : GRADE_W;
      let score = 100 * (WG.prod * prod + WG.runway * runway + WG.role * role + WG.health * health) + qb;
      if (!redraft && role >= 0.6 && prod >= 0.35) score = Math.max(score, GRADE_FLOOR_D);   // a producing starter is never a waiver player, whatever his age (Kamara at 31)
      score = prospect_lens(score, f, pos, usage, null, group, span, redraft);
      score = crystal_ball(score, f, pos, usage, redraft, boomAt[pos]);
      score = grade_floor(score, f, pos, prod, role, redraft);
      x.score = Math.min(100, Math.round(score));
      x.parts = [prod, runway, role, health].map(v => Math.round(v * 100));
    });
  }
}
/* The prospect lens (dynasty): a player still developing is judged the way a scout judges him, not by a slow month.
   Window, by NFL seasons played: TE 1, 1, .6, .3 (they develop late: our TE research), QB 1, .8, .5, .25,
   RB and WR 1, .7, .3; and 25 or younger, on a roster. Prospect score = draft pedigree, his best season relative to what
   a player his age usually produces (our age curves: 8.5 a game at 21 is elite for a TE), his share of the ball and,
   for a TE, his situation. It only lifts a grade; a bust corrects itself as the usage and production fade. */
const PROSPECT_WINDOW = { TE: [1, 1, 0.6, 0.3], QB: [1, 0.8, 0.5, 0.25], RB: [1, 0.7, 0.3], WR: [1, 0.7, 0.3] };
function prospect_lens(score, f, pos, usage, sit, group, span, redraft) {
  const w = !redraft && f.age <= 25.5 && f.team ? (PROSPECT_WINDOW[pos] || [])[f.exp] || 0 : 0;
  if (!w) return score;
  const clip = v => Math.min(1, Math.max(0, v));
  const pedigree = f.pick ? clip(1 - (f.pick - 1) / 120) : 0.05;
  // his best season: a full one (8+ games), or this one from 3 games; ranked among today's players at his position
  const seasons = [[0, 3], [1, 8], [2, 8], [3, 8]].filter(([i, min]) => f.g[i] >= min).map(([i]) => [f.ppg[i], i]);
  let shown = 0;
  if (seasons.length) {
    const [ppg, yearsAgo] = seasons.reduce((b, s) => (s[0] > b[0] ? s : b));
    const ahead = group.filter(x => x._f.gest > ppg).length, rank = Math.pow(clip(1 - ahead / span), 1.25);
    shown = clip(rank / Math.max(0.35, age_curve(f, f.age - yearsAgo)));   // against a player his age at the time
  }
  const prospect = 100 * (sit == null ? 0.45 * pedigree + 0.40 * shown + 0.15 * usage : 0.40 * pedigree + 0.35 * shown + 0.15 * usage + 0.10 * sit)
    * (["IR", "PUP", "Out", "Sus", "DNR", "NA"].includes(f.inj) ? 0.9 : 1);
  return prospect > score ? score + (prospect - score) * w : score;
}
/* The crystal ball (dynasty): a young player on a roster is a lottery ticket, not a waiver player. For players in
   their first 4 seasons, 26 or younger (fading out by 27.5), the grade can't fall below D, and the floor rises toward C
   with his potential: draft capital, a starter's share of the ball, and a breakout game this season. Injuries cut the
   potential, they don't erase it. Young starters who have popped also get a little more everywhere on the scale.
   F is left for the old, the buried and the unproductive. */
const GRADE_FLOOR_D = 42, GRADE_FLOOR_SPAN = 14, GRADE_SPARK = 6;
/* F is for a player with nothing going: no NFL team, a backup QB who isn't playing, buried on the depth chart with no
   production, or old and unproductive (the user's rule, 2026-10-06). Everyone else has a floor of D: a player with a
   starting role, one who plays most weeks and scores something, a young player on a roster (dynasty), or one the whole
   platform is adding this week. Potential is not an F. */
const GRADE_F_MAX = 36;
function grade_floor(score, f, pos, prod, role, redraft) {
  if (!f.team) return Math.min(score, GRADE_F_MAX);
  const dd = f.depth, out = ["IR", "PUP", "Out", "DNR", "Sus", "NA"].includes(f.inj);
  const starterDepth = dd === 1 || (pos === "WR" && dd != null && dd <= 3) || (pos === "RB" && dd === 2 && role >= 0.3);
  const playing = f.week >= 2 && f.g[0] >= 0.6 * f.week && prod > 0.05;
  const young = !redraft && f.age != null && f.age <= 25 && !["IR", "PUP", "DNR"].includes(f.inj);
  if ((starterDepth && !out) || playing || young || f.hot) return Math.max(score, GRADE_FLOOR_D);
  return score;
}
function crystal_ball(score, f, pos, usage, redraft, boomAt) {
  if (redraft || f.exp > 3 || !f.team) return score;
  const clip = v => Math.min(1, Math.max(0, v)), youth = clip((27.5 - f.age) / 1.5);   // full through 26, gone by 27.5
  if (!youth) return score;
  const draft = f.pick ? clip(1 - (f.pick - 1) / 120) : 0.1;
  // a breakout game counts once it's backed up: a second good game, or a starter's share of the ball (everyone can have one random big game)
  const starter = usage >= 0.5 ? 1 : usage >= 0.3 ? 0.5 : 0, boom = f.best >= boomAt && (f.best2 >= 0.6 * boomAt || usage >= 0.5) ? 1 : 0;
  let potential = clip(0.5 * draft + 0.3 * starter + 0.3 * boom);
  if (["IR", "PUP", "Out", "Sus", "DNR", "NA"].includes(f.inj)) potential *= 0.7;
  const floor = GRADE_FLOOR_D + GRADE_FLOOR_SPAN * potential;
  if (score < floor) score += (floor - score) * youth;
  return score + youth * GRADE_SPARK * (0.5 * starter + 0.5 * boom);
}
/* A TE's situation, 0-1 (our TE research). */
function te_situation(x, byTeam, players, starting, clip) {
  const f = x._f;
  const usage = clip((f.ts - 0.08) / 0.14);                                       // 8% = in-line blocker, 22%+ = a receiving weapon
  const volume = f.passVol == null ? 0.5 : clip((f.passVol - 28) / 10);           // 28 pass attempts a game = run-heavy, 38 = pass-heavy
  const mates = byTeam[f.team] || [], at = mates.indexOf(x) + 1;
  const alpha = mates.some(m => m !== x && m.pos === "WR" && m._f.ts >= 0.25);    // one dominant WR pulls the safety help
  const order = at === 1 ? 0.9 : at === 2 ? (alpha ? 1 : 0.85) : at === 3 ? 0.55 : 0.3;
  const qbs = players.filter(q => q.pos === "QB" && q._f && q._f.team === f.team && starting(q._f)).sort((a, b) => (b._prod || 0) - (a._prod || 0));
  const q = qbs[0] ? (qbs[0]._prod || 0) * (1 - 0.3 * Math.min(1, 1.3 * (qbs[0]._f.rush || 0))) : 0.35;   // a runner keeps the red-zone TDs
  return 0.35 * usage + 0.20 * volume + 0.25 * order + 0.20 * clip(q / 0.85);
}
function attach_ours(assets, ours, redraft) {
  const mine = Object.fromEntries(ours.map(x => [x.sleeper_id, x.value]));
  const card = Object.fromEntries(ours.map(x => [x.sleeper_id, x]));
  for (const a of assets) { const c = !a.is_pick && card[a.sleeper_id]; if (c && c.score != null) { a.oscore = c.score; a.oparts = c.parts; a.ogames = c.games; a.opatient = c.patient; a.ep = c.ep || null; a.pred = c.pred || null; if (!(a.age > 0) && c.age > 0) a.age = c.age; } }   // some lists carry no age
  const set = assets.filter(a => !a.is_pick && a.sleeper_id && mine[a.sleeper_id] != null);
  const market = set.map(a => a.value).sort((x, y) => y - x);
  const key = a => (a.oscore != null ? a.oscore * 1e6 : 0) + mine[a.sleeper_id];               // by the grade, then by our value
  set.sort((a, b) => key(b) - key(a)).forEach((a, i) => { a.ours = market[i]; });
  // Young players are rising (our age curves), so we never grade one under the market just because his sample is thin
  // (under 8 NFL games, or a TE in his first 2 seasons: about half of them break out that late).
  // Except RBs from 25: their sell window is 25-26.
  // (Dynasty only: in redraft age means nothing.)
  if (!redraft) for (const a of set) if (a.ours < a.value && a.age != null && a.age < 26 && !(a.pos === "RB" && a.age >= 25) && a.opatient !== false) a.ours = a.value;
}
/* The stored values came from an older value formula: rebuild them whatever their age. */
function model_changed(values) { return !!values && ((values.meta || {}).params || {}).model !== DMV_MODEL; }
/* FantasyCalc asks for its values to be fetched at most once an hour. */
function update_wait_minutes(cfg) {
  const v = Store.get(f("values.json"));
  if (!v || !v.fetched) return 0;
  const p = v.params || {}, lg = cfg.league;
  const same = p.league_type === (is_redraft(cfg) ? "redraft" : "dynasty") && p.num_qbs === parseInt(lg.num_qbs) && p.ppr === lg.ppr && p.teams === parseInt(lg.teams);
  const mins = (Date.now() - new Date(v.fetched).getTime()) / 60000;
  return same && mins < 60 ? Math.ceil(60 - mins) : 0;
}

async function update_values(cfg, log = () => {}) {
  try { const n = await refresh_player_status(await sleeper_players()); log(`Player status: ${fmt(n)} players`); } catch (e) { log(`Player status failed: ${e.message}`); }   // Sleeper asks for the player list at most once a day; it is cached 24 h
  log(`Downloading ${is_redraft(cfg) ? "redraft" : "dynasty"} values ...`);
  const [results, notes] = await fetch_all_sources(cfg, log);
  if (!results.length) throw new Error("No value list could be downloaded. Check the internet connection.");
  const assets = build_consensus(cfg, results);
  try { attach_ours(assets, await src_dmv(cfg, null, true), is_redraft(cfg)); } catch (e) { log(`Our grades: ${e.message}`); }
  const lg = cfg.league;
  Store.set(f("values.json"), {
    fetched: now_iso(), source: results.length > 1 ? "consensus" : results[0].name, sources_used: results.map(r => r.name),
    source_weights: Object.fromEntries(results.map(r => [r.name, effective_weight(cfg, r.name)])), notes,
    params: { league_type: is_redraft(cfg) ? "redraft" : "dynasty", num_qbs: parseInt(lg.num_qbs), ppr: lg.ppr, teams: parseInt(lg.teams), model: DMV_MODEL }, assets,
  });
  const snaps = record_history(assets);
  for (const n of Store.list()) if (n.startsWith("mtrades.")) Store.remove(n);   // caches of the real-trade comps, a feature the 3.0 builds still had
  try { await refresh_trending(); } catch (e) { log(`Trending adds/drops failed: ${e.message}`); }
  const n = assets.filter(a => !a.is_pick).length;
  log(`Consensus of ${results.length} lists: ${n} players and ${assets.length - n} picks. Price snapshot ${snaps}.`);
  load_values(cfg);
  return { lists: results.length, players: n, picks: assets.length - n, notes };
}

// ---------------------------------------------------------------------------
// Player status (injury, depth chart) and the name -> Sleeper id index
// ---------------------------------------------------------------------------
/* Sleeper's full player list is ~5 MB compressed; keep a slim copy (fantasy positions, the fields we use) for a day. */
const SLIM_FIELDS = ["full_name", "first_name", "last_name", "position", "team", "age", "birth_date", "injury_status", "depth_chart_order", "active", "status",
  // for the player card's News & status section (all in Sleeper's documented players list)
  "injury_body_part", "injury_notes", "injury_start_date", "practice_participation", "practice_description", "depth_chart_position",
  "news_updated", "number", "height", "weight", "college", "years_exp", "espn_id"];
const SLIM_VERSION = 3;
async function sleeper_players(refresh = false) {
  const c = Store.get("sleeper_players.json");
  if (c && !refresh && c.v === SLIM_VERSION && (Date.now() - new Date(c.fetched).getTime()) < 24 * 3600000) return c.players;
  const raw = await Net.json(`${SLEEPER_URL}/players/nfl`, null, 300000);
  const players = {};
  for (const [pid, p] of Object.entries(raw)) {
    if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.position)) continue;
    const o = {};
    for (const k of SLIM_FIELDS) if (p[k] !== null && p[k] !== undefined) o[k] = p[k];
    players[pid] = o;
  }
  Store.set("sleeper_players.json", { fetched: now_iso(), v: SLIM_VERSION, players });
  return players;
}
async function refresh_player_status(all_players) {
  all_players = all_players || await sleeper_players();
  const out = {}, names = {}, last = {};
  const addLast = (k, pid) => { last[k] = k in last && last[k] !== pid ? "" : pid; };     // "" = two players share it: don't guess
  for (const [pid, pl] of Object.entries(all_players)) {
    const pos = pl.position;
    if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
    const name = pl.full_name || (String(pl.first_name || "") + " " + String(pl.last_name || "")).trim();
    if (name && POSITIONS.includes(pos) && (pl.team || pl.active)) {
      const k = player_key(name, pos); if (!(k in names)) names[k] = String(pid);
      // backup match for lists that use another first name (Nathaniel / Tank Dell, Marquise / Hollywood Brown)
      const ln = norm(pl.last_name || name.split(" ").slice(-1)[0]);
      if (ln && pl.team) { addLast(`${ln}|${pos}|${pl.team}`, String(pid)); addLast(`${ln}|${pos}`, String(pid)); }
    }
    const inj = pl.injury_status, depth = pl.depth_chart_order;
    if (!inj && (depth === null || depth === undefined)) continue;
    out[String(pid)] = { inj, depth, team: pl.team, pos, name, status: pl.status };
  }
  Store.set("player_status.json", { fetched: now_iso(), players: out, names, last });
  return Object.keys(out).length;
}
const load_player_status = () => (Store.get("player_status.json") || {}).players || {};
const load_name_index = () => (Store.get("player_status.json") || {}).names || {};

const TRENDING_URL = "https://api.sleeper.app/v1/players/nfl/trending/{kind}?lookback_hours=48&limit=100";
async function refresh_trending() {
  const out = { fetched: now_iso(), adds: {}, drops: {} };
  for (const kind of ["add", "drop"]) {
    const rows = await Net.json(TRENDING_URL.replace("{kind}", kind)) || [];
    out[kind + "s"] = Object.fromEntries(rows.map(r => [String(r.player_id), parseInt(r.count || 0)]));
  }
  Store.set("trending.json", out);
  return out;
}
/* A team's depth chart from Sleeper's documented players list: {QB:[...], RB:[...], WR:[...], TE:[...], K:[...]},
   each ordered by Sleeper's depth order. Receivers (LWR/RWR/SWR) share one numbering, so they form one list. */
async function team_depth(team) {
  const players = await sleeper_players();
  const out = { QB: [], RB: [], WR: [], TE: [], K: [] };
  for (const [sid, p] of Object.entries(players)) {
    if (p.team !== team || !p.depth_chart_order) continue;
    const slot = p.depth_chart_position || p.position;
    const grp = ["LWR", "RWR", "SWR", "WR"].includes(slot) ? "WR" : slot;
    if (!out[grp]) continue;
    out[grp].push({ sid, name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), pos: p.position, order: p.depth_chart_order,
      injury: p.injury_status || null, slot: slot === "SWR" ? "slot" : null });
  }
  for (const g of Object.values(out)) g.sort((x, y) => x.order - y.order);
  return out;
}

/* One player's Sleeper record from the cached list; downloads the list only if it is missing or a day old. */
async function sleeper_player(sid) {
  if (!sid || !/^\d+$/.test(String(sid))) return null;
  const players = await sleeper_players().catch(() => ({}));
  return players[String(sid)] || null;
}

/* Recent headlines for one player from Google News (personal edition only: Google's feeds are for personal readers). */
const news_cache = new Map();
async function player_news(name, n = 6) {
  if (PLAY) return [];
  const hit = news_cache.get(name);
  if (hit && Date.now() - hit.at < 3600000) return hit.items;
  const q = encodeURIComponent(`"${name}" NFL when:14d`);
  const xml = await Net.text(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, BROWSER);
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const items = [...doc.querySelectorAll("item")].map(it => {
    const source = (it.querySelector("source") || {}).textContent || "";
    let title = (it.querySelector("title") || {}).textContent || "";
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: (it.querySelector("link") || {}).textContent || "", date: new Date((it.querySelector("pubDate") || {}).textContent || 0) };
  }).filter(x => x.title && x.link && !isNaN(x.date)).sort((a, b) => b.date - a.date).slice(0, n);
  news_cache.set(name, { at: Date.now(), items });
  return items;
}

/* Short written player updates (RotoWire, via ESPN's fantasy news feed) that read in place, newest first.
   Personal edition only: ESPN's terms do not allow automated access for a published app. */
const blurb_cache = new Map();
/* Sleeper has no ESPN id for many rookies; find it once by exact name through ESPN's player search and remember it. */
async function espn_id_for(name) {
  const known = Store.get("espn_ids.json") || {};
  if (name in known) return known[name];
  const q = new URLSearchParams({ query: name, type: "player", sport: "football", league: "nfl", limit: "5" });
  const j = await Net.json(`https://site.web.api.espn.com/apis/common/v3/search?${q}`);
  const hit = (j.items || []).find(i => norm(i.displayName || "") === norm(name));
  known[name] = hit ? String(hit.id) : null;
  Store.set("espn_ids.json", known);
  return known[name];
}

async function player_blurbs(espn_id, n = 3, name = "") {
  if (PLAY) return [];
  if (!espn_id && name) espn_id = await espn_id_for(name).catch(() => null);
  if (!espn_id) return [];
  const hit = blurb_cache.get(espn_id);
  if (hit && Date.now() - hit.at < 1800000) return hit.items;
  const j = await Net.json(`https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId=${encodeURIComponent(espn_id)}&limit=25`);   // app's own user agent: ESPN refuses a bare desktop-Chrome one
  const strip = t => String(t || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const items = (j.feed || []).filter(it => it.type === "Rotowire" && (it.headline || it.story))
    .map(it => ({ headline: strip(it.headline), story: strip(it.story), date: new Date(it.published || it.lastModified || 0) }))
    .filter(x => !isNaN(x.date)).sort((a, b) => b.date - a.date).slice(0, n);
  blurb_cache.set(espn_id, { at: Date.now(), items });
  return items;
}

/* Sleeper's trending adds or drops (last 2 days), refreshed when older than an hour.
   Returns [{sid, count, name, pos, team, age, asset}] for the home screen, most active first. */
async function trending_list(kind = "adds", n = 30, values = null, hide_k_def = true) {
  let t = Store.get("trending.json");
  if (!t || !t.fetched || (Date.now() - new Date(t.fetched).getTime()) > 3600000) {
    try { t = await refresh_trending(); } catch (e) { if (!t) throw e; }
  }
  const players = await sleeper_players().catch(() => ({}));   // names for players no value list carries (cached a day)
  const out = [];
  for (const [sid, count] of Object.entries(t[kind] || {}).sort((a, b) => b[1] - a[1])) {
    const asset = values ? values.by_sleeper[sid] || null : null, p = players[sid] || {};
    const pos = (asset && asset.pos) || p.position || "?";
    if (hide_k_def && HIDDEN_POSITIONS.includes(pos)) continue;
    if (!asset && !p.position) continue;
    const name = (asset && asset.name) || p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
    out.push({ sid, count, name, pos, team: (asset && asset.team) || p.team || "FA", age: (asset && asset.age) ?? p.age ?? null, asset });
    if (out.length >= n) break;
  }
  return { fetched: t.fetched, rows: out };
}

function apply_trending(values) {
  const t = Store.get("trending.json") || {}, adds = t.adds || {}, drops = t.drops || {};
  for (const a of values.players) {
    const sid = a.sleeper_id;
    if (sid && (sid in adds || sid in drops)) a.trend48 = { adds: adds[sid] || 0, drops: drops[sid] || 0 };
  }
  values.trending_fetched = t.fetched;
}

// ---------------------------------------------------------------------------
// Real market trades (FantasyCalc) kept locally for comps
// ---------------------------------------------------------------------------
/* Real-trade comps used FantasyCalc's trade feed, which is not one of its documented (permitted) endpoints,
   so the feature is off in every edition. Files saved by older versions are deleted on the next update. */

// ---------------------------------------------------------------------------
// Picks and search
// ---------------------------------------------------------------------------
function slot_tier(slot, teams) {
  const third = Math.max(1, pyround(teams / 3));
  return slot <= third ? "early" : (slot <= 2 * third ? "mid" : "late");
}
function parse_pick_query(text, default_season, teams) {
  let t = String(text).toLowerCase().trim();
  t = t.replace(/\b(pick|picks|rookie|draft|round|rd)\b/g, " ").split(/\s+/).filter(Boolean).join(" ");
  let m = /^(\d{4})\s+(\d{1,2})\.(\d{1,2})$/.exec(t);
  if (m) return [+m[1], +m[2], slot_tier(+m[3], teams)];
  m = /^(\d{1,2})(?:st|nd|rd|th)\s+(\d{4})$/.exec(t);
  if (m) return [+m[2], +m[1], null];
  m = /^(?:(\d{4})\s+)?(?:(early|mid|late)\s+)?(\d{1,2})(st|nd|rd|th)?(?:\s*\(?(early|mid|late)\)?)?$/.exec(t);
  if (m) {
    const [, season, tier1, rnd, suffix, tier2] = m;
    if (!(season || suffix || tier1 || tier2)) return null;
    return [season ? +season : default_season, +rnd, tier1 || tier2 || null];
  }
  return null;
}
function tier_ratio(values, rnd, tier) {
  for (const season of values.pick_seasons) {
    const base = values.picks.get(pkey(season, rnd, null)), tiered = values.picks.get(pkey(season, rnd, tier));
    if (base && tiered && base.value) return tiered.value / base.value;
  }
  return { early: 1.35, mid: 1.0, late: 0.8 }[tier] || 1.0;
}
function resolve_pick(values, cfg, season, rnd, tier) {
  tier = tier || null;
  const exact = values.picks.get(pkey(season, rnd, tier));
  if (exact) return exact;
  const disc = parseFloat(cfg.adjustments.future_pick_discount ?? 0.85);
  const generic = values.picks.get(pkey(season, rnd, null));
  if (generic) return make_pick(season, rnd, tier, generic.value * tier_ratio(values, rnd, tier), true);
  const same_round = [...values.picks.values()].filter(a => a.pick.round === rnd && !a.pick.tier).map(a => [a.pick.season, a]).sort((x, y) => x[0] - y[0]);
  if (same_round.length) {
    const [s0, a0] = season > same_round[same_round.length - 1][0] ? same_round[same_round.length - 1] : same_round[0];
    let v = season > s0 ? a0.value * Math.pow(disc, season - s0) : a0.value;
    if (tier) v *= tier_ratio(values, rnd, tier);
    return make_pick(season, rnd, tier, v, true);
  }
  const known = [...new Set([...values.picks.values()].filter(a => !a.pick.tier).map(a => a.pick.round))].sort((a, b) => a - b);
  if (known.length) {
    const r0 = rnd > known[known.length - 1] ? known[known.length - 1] : known[0];
    const base = resolve_pick(values, cfg, season, r0, null);
    return make_pick(season, rnd, tier, base.value * Math.pow(0.85, Math.max(0, rnd - r0)), true);
  }
  return make_pick(season, rnd, tier, 0, true);
}

function similarity(a, b) {                    // difflib.SequenceMatcher.ratio, simplified (longest common blocks)
  const match = (a, b) => {
    if (!a.length || !b.length) return 0;
    let best = 0, bi = 0, bj = 0;
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let diag = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
        if (prev[j] > best) { best = prev[j]; bi = i; bj = j; }
        diag = tmp;
      }
    }
    if (!best) return 0;
    return best + match(a.slice(0, bi - best), b.slice(0, bj - best)) + match(a.slice(bi), b.slice(bj));
  };
  return 2 * match(a, b) / (a.length + b.length || 1);
}

function search_players(query, values, limit = 10, pool = null) {
  const restricted = pool;
  let q = norm(query), pos = null;
  const parts = q.split(" ");
  if (parts.length > 1 && POSITIONS.includes(parts[parts.length - 1].toUpperCase())) { pos = parts.pop().toUpperCase(); q = parts.join(" "); }
  pool = (pool || values.players).filter(p => !pos || p.pos === pos);
  if (!q) return [];
  const exact = pool.filter(p => norm(p.name) === q);
  if (exact.length) return exact.sort((a, b) => b.value - a.value);
  const toks = q.split(" ");
  const prefix = name => {
    const nt = norm(name).split(" ");
    let i = 0;
    for (const qt of toks) {
      while (i < nt.length && !nt[i].startsWith(qt)) i++;
      if (i === nt.length) return false;
      i++;
    }
    return true;
  };
  let hits = pool.filter(p => prefix(p.name));
  if (!hits.length) hits = pool.filter(p => norm(p.name).includes(q));
  if (!hits.length && !restricted) {
    const names = new Map();
    for (const p of pool) if (!names.has(norm(p.name))) names.set(norm(p.name), p);
    hits = [...names.keys()].map(n => [similarity(q, n), n]).filter(x => x[0] >= 0.72).sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => names.get(x[1]));
  }
  hits.sort((a, b) => (b.value - a.value) || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

function find_asset(text, values, cfg, pool = null) {
  text = String(text).trim();
  if (!text) return { asset: null, alts: [], error: "empty" };
  if (values.by_id[text]) return { asset: values.by_id[text], alts: [], error: null };
  if (text.startsWith("pick-") && text.includes("@")) text = text.split("@")[0];
  if (text.startsWith("pick-")) {
    const parts = text.split("-");
    if (parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]))
      return { asset: resolve_pick(values, cfg, +parts[1], +parts[2], parts[3] || null), alts: [], error: null };
  }
  const pk = parse_pick_query(text, values.default_pick_season, parseInt(cfg.league.teams));
  if (pk) {
    if (is_redraft(cfg)) return { asset: null, alts: [], error: `'${text}' looks like a draft pick; picks are not traded in a redraft league` };
    return { asset: resolve_pick(values, cfg, ...pk), alts: [], error: null };
  }
  const hits = search_players(text, values, 6, pool);
  if (!hits.length) return { asset: null, alts: [], error: `No player or pick matched '${text}'` };
  return { asset: hits[0], alts: hits.slice(1), error: null };
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------
function category(asset, cfg) {
  if (asset.is_pick) return "pick";
  const thr = cfg.adjustments.age_thresholds[asset.pos] || [25, 29];
  const age = asset.age;
  if (age === null || age === undefined) return "prime";
  if (age <= thr[0]) return "young";
  if (age >= thr[1]) return "aging";
  return "prime";
}
function age_factor(pos, age, cfg) {
  if (age === null || age === undefined) return 1.0;
  let knots = (cfg.adjustments.age_curve || {})[pos] || DEFAULT_CONFIG.adjustments.age_curve[pos];
  if (!knots) return 1.0;
  knots = knots.map(([a, f]) => [+a, +f]).sort((x, y) => x[0] - y[0]);
  if (age <= knots[0][0]) return knots[0][1];
  if (age >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
  for (let i = 0; i < knots.length - 1; i++) {
    const [a0, f0] = knots[i], [a1, f1] = knots[i + 1];
    if (a0 <= age && age <= a1) return f0 + (f1 - f0) * (age - a0) / (a1 - a0);
  }
  return 1.0;
}
/* QBs cost more in a dynasty trade than their ranking value says (the user's rule: you overpay for a QB). A trade-only
   premium on the QBs a league starts: full for the top teams x QB-slots by position rank, tapering to nothing by twice
   that, so a backup or a struggling QB who hasn't broken out keeps his plain value. Rankings don't change. */
function qb_trade_mult(asset, cfg) {
  if (!asset || asset.pos !== "QB" || asset.is_pick || is_redraft(cfg)) return 1;
  const pct = parseFloat(cfg.league.qb_trade_bump_pct ?? 15);
  if (!(pct > 0)) return 1;
  const starters = (parseInt(cfg.league.teams, 10) || 12) * (parseInt(cfg.league.num_qbs, 10) >= 2 ? 2 : 1), r = asset.pos_rank || 99;
  const share = r <= starters ? 1 : Math.max(0, 1 - (r - starters) / starters);
  return 1 + pct / 100 * share;
}
function adjusted_value(asset, mode, cfg) {
  let v = +asset.value;
  if (asset.pos === "TE") v *= 1 + parseFloat(cfg.league.te_premium_bonus_pct || 0) / 100;
  v *= qb_trade_mult(asset, cfg);
  if (!is_redraft(cfg) && mode !== "neutral") {
    const M = cfg.adjustments.modes[mode] || {};
    if (asset.is_pick) v *= parseFloat(M.pick ?? 1.0);
    else {
      v *= parseFloat(M[category(asset, cfg)] ?? 1.0);                       // young / prime / aging
      const fct = Math.min(1, age_factor(asset.pos, asset.age, cfg));        // the age curve: 1 in his prime, lower as it falls
      if (mode === "rebuild") v *= Math.sqrt(fct);                            // rebuilding: an old player is worth what's left of his curve
      else if (mode === "contend") v *= 1 + (1 - fct) * 0.4;                  // win now: his decline is next year's problem
    }
  }
  return pyround(v);
}
function roster_spot_cost(cfg, values) {
  const setting = cfg.adjustments.roster_spot_cost ?? "auto";
  if (typeof setting === "number") return Math.trunc(setting);
  const ranked = values.players.filter(p => !p.unranked).map(p => p.value).sort((a, b) => b - a);
  if (!ranked.length) return 0;
  const idx = parseInt(cfg.league.teams) * parseInt(cfg.league.roster_size);
  return pyround(ranked[Math.min(idx, ranked.length - 1)] * (is_bestball(cfg) ? 1.5 : 1.0));
}
const lineup_value = a => a.is_pick ? 0 : (a.redraft !== null && a.redraft !== undefined ? a.redraft : a.value);
const best_lineup = (players, starters) => best_lineup_by(players, starters, lineup_value);
function lineup_total(lu, cfg) {
  if (!is_bestball(cfg)) return lu.total;
  const n = Math.max(1, lu.starters.length);
  const bench = lu.bench.map(lineup_value).sort((a, b) => b - a).slice(0, n);
  return pyround(lu.total + 0.5 * bench.reduce((s, x) => s + x, 0));
}
const depth_of = lu => lu.bench.map(lineup_value).sort((a, b) => b - a).slice(0, 6).reduce((s, x) => s + x, 0);
function best_lineup_by(players, starters, keyfn) {
  const remaining = players.filter(p => !p.is_pick).sort((a, b) => keyfn(b) - keyfn(a));
  const picked = [];
  const fixed = starters.filter(s => POSITIONS.includes(s.toUpperCase()));
  const flex = starters.filter(s => FLEX_ELIGIBLE[s.toUpperCase()]);
  for (const slot of fixed) {
    const i = remaining.findIndex(p => p.pos === slot.toUpperCase());
    if (i >= 0) picked.push([slot, remaining.splice(i, 1)[0]]); else picked.push([slot, null]);
  }
  for (const slot of flex) {
    const elig = FLEX_ELIGIBLE[slot.toUpperCase()];
    const i = remaining.findIndex(p => elig.includes(p.pos));
    if (i >= 0) picked.push([slot, remaining.splice(i, 1)[0]]); else picked.push([slot, null]);
  }
  const total = picked.reduce((s, [, p]) => s + (p ? keyfn(p) : 0), 0);
  return { starters: picked, total, bench: remaining };
}
function evaluate_side(matches, mode, cfg) {
  const rows = [];
  let raw = 0, adj = 0;
  for (const m of matches) {
    const a = m.asset;
    const cat = is_redraft(cfg) ? "" : category(a, cfg);
    const av = adjusted_value(a, mode, cfg);
    const qbm = qb_trade_mult(a, cfg);
    rows.push({ id: a.id, name: a.name, pos: a.pos, team: a.team, age: a.age, value: a.value, priced: a.value * qbm, adjusted: av, category: cat, tier: a.tier, pos_rank: a.pos_rank,
      trend: a.trend, estimated: !!a.estimated, unranked: !!a.unranked, alts: (m.alts || []).slice(0, 3).map(x => x.name) });
    raw += a.value * qbm;                                     // the market side of a trade carries the QB trade premium too
    adj += av;
  }
  return { rows, raw, adj };
}
function pick_equivalent(values, diff) {
  const picks = values.assets.filter(a => a.is_pick && a.value > 0 && !a.estimated).sort((a, b) => a.value - b.value);
  if (!picks.length || diff <= 0) return null;
  const best = picks.reduce((b, a) => Math.abs(a.value - diff) < Math.abs(b.value - diff) ? a : b, picks[0]);
  if (Math.abs(best.value - diff) <= 0.3 * diff) return `about a ${best.name}`;
  if (diff > picks[picks.length - 1].value) return `more than a ${picks[picks.length - 1].name}`;
  if (diff < picks[0].value) return `less than a ${picks[0].name}`;
  const lo = picks.filter(a => a.value <= diff).reduce((b, a) => a.value > b.value ? a : b);
  const hi = picks.filter(a => a.value >= diff).reduce((b, a) => a.value < b.value ? a : b);
  return `between a ${lo.name} and a ${hi.name}`;
}
function verdict_for(pct, cfg) {
  const t = cfg.adjustments.verdict_pct, a = Math.abs(pct);
  if (a < t.even) return ["Fair trade", null];
  const side = pct > 0 ? "A" : "B";
  if (a < t.slight) return [`Slightly favors Team ${side}`, side];
  if (a < t.lopsided) return [`Favors Team ${side}`, side];
  return [`Lopsided in favor of Team ${side}`, side];
}

function analyze_trade(a_gives, b_gives, mode_a, mode_b, cfg, values, team_a = null, team_b = null, balance = true) {
  if (is_redraft(cfg)) mode_a = mode_b = "neutral";
  const spot = roster_spot_cost(cfg, values);
  const n_a = a_gives.length, n_b = b_gives.length, a_spots = n_a - n_b;
  const a_out = evaluate_side(a_gives, mode_a, cfg), a_in = evaluate_side(b_gives, mode_a, cfg);
  const b_out = evaluate_side(b_gives, mode_b, cfg), b_in = evaluate_side(a_gives, mode_b, cfg);
  let a_net = a_in.adj - a_out.adj + a_spots * spot, b_net = b_in.adj - b_out.adj - a_spots * spot;
  const market_a = a_out.raw, market_b = b_out.raw;
  let market_diff = market_b - market_a + a_spots * spot;
  let consolidation = null;
  const bonus_pct = parseFloat(cfg.adjustments.consolidation_bonus_pct || 0);
  if (n_a !== n_b && bonus_pct > 0) {
    const top = Math.max(0, ...values.players.filter(p => !p.unranked).map(p => p.value)) || 1;
    const side = n_b < n_a ? "A" : "B";
    const received = side === "A" ? b_gives : a_gives;
    const best = received.reduce((b, m) => m.asset.value > b.asset.value ? m : b, received[0]).asset;
    const bonus = best.value * bonus_pct / 100 * Math.min(2, Math.abs(n_a - n_b)) * (best.value / top);
    market_diff += side === "A" ? bonus : -bonus;
    a_net += side === "A" ? bonus : -bonus;
    b_net += side === "A" ? -bonus : bonus;
    consolidation = { side, asset: best.name, bonus: pyround(bonus) };
  }
  // The verdict is judged from side A's chair: with a strategy set, every asset is priced the way that team sees it
  // (adjusted_value); Balanced is the plain market. Side B's strategy gives "how they see it" (teams.B.net).
  const lens = mode_a !== "neutral" && !is_redraft(cfg) ? mode_a : null;
  const view = lens ? { a_gives: a_out.adj, b_gives: a_in.adj, diff: a_net, pct: a_net / Math.max(a_out.adj, a_in.adj, 1) * 100, lens }
    : { a_gives: market_a, b_gives: market_b, diff: market_diff, pct: market_diff / Math.max(market_a, market_b, 1) * 100, lens: null };
  const pct = view.pct;
  const [text, winner] = verdict_for(pct, cfg);
  const warnings = [];
  for (const side of [a_gives, b_gives]) for (const m of side) {
    const a = m.asset;
    if (a.unranked) warnings.push(`${a.name} has no market value in the lists (deep bench).`);
    if (a.estimated) warnings.push(`${a.name} is not in the lists; its value was estimated.`);
    if (m.alts && m.alts.length) warnings.push(`'${m.query || a.name}' matched ${a.name}; other matches: ` + m.alts.slice(0, 3).map(x => x.name).join(", "));
  }
  const result = {
    fetched: values.meta.fetched, source: values.meta.source, spot_cost: spot, a_spots,
    market: { a_gives: market_a, b_gives: market_b, diff: market_diff, pct: market_diff / Math.max(market_a, market_b, 1) * 100 }, view,
    verdict: { text, winner },
    teams: {
      A: { name: (team_a || {}).team_name || "Team A", mode: mode_a, gives: a_out, gets: a_in, spot_adj: a_spots * spot, net: a_net, net_pct: a_net / Math.max(a_out.adj, a_in.adj, 1) * 100 },
      B: { name: (team_b || {}).team_name || "Team B", mode: mode_b, gives: b_out, gets: b_in, spot_adj: -a_spots * spot, net: b_net, net_pct: b_net / Math.max(b_out.adj, b_in.adj, 1) * 100 },
    },
    lineup: null, warnings, consolidation, balance: [], gap_pick: pick_equivalent(values, Math.abs(view.diff)),
  };
  if (values.league && (team_a || team_b)) result.lineup = lineup_impact(values, cfg, team_a, team_b, a_gives, b_gives, warnings);
  result.redraft = is_redraft(cfg);
  if (result.redraft && result.lineup) result.verdict = redraft_verdict(result.lineup);
  if (balance) result.balance = balance_suggestions(values, cfg, a_gives, b_gives, mode_a, mode_b, team_a, team_b, result);
  return result;
}
function league_view_text(pct) {
  if (Math.abs(pct) < 3) return "even";          // how a neutral calculator sees it; pct > 0 = you receive more
  return pct > 0 ? `you ahead by ${pct.toFixed(0)}%` : `them ahead by ${(-pct).toFixed(0)}%`;
}
function balance_suggestions(values, cfg, a_gives, b_gives, mode_a, mode_b, team_a, team_b, result) {
  const pct = (result.view || result.market).pct, even = parseFloat(cfg.adjustments.verdict_pct.even);
  if (Math.abs(pct) < even) return [];
  const winner = pct > 0 ? "A" : "B";
  const team = winner === "A" ? team_a : team_b;
  const in_trade = new Set(a_gives.concat(b_gives).map(m => m.asset.id));           // every team pick has its own id (…@original owner)
  let pool;
  if (team) pool = team_assets(values, cfg, team).filter(a => !in_trade.has(a.id));
  else if (!is_redraft(cfg)) pool = [...values.picks.values()].filter(a => !a.pick.tier);
  else pool = [];
  const out = [];
  for (const c of pool) {
    const m = { asset: c, alts: [], error: null, query: c.name };
    const [na, nb] = winner === "A" ? [a_gives.concat([m]), b_gives] : [a_gives, b_gives.concat([m])];
    const p2 = analyze_trade(na, nb, mode_a, mode_b, cfg, values, team_a, team_b, false).view.pct;
    if (Math.abs(p2) < Math.abs(pct)) out.push({ side: winner, id: c.id, name: c.name, value: c.value, new_pct: p2, text: league_view_text(p2), even: Math.abs(p2) < even });
  }
  out.sort((x, y) => (x.even === y.even ? 0 : (x.even ? -1 : 1)) || Math.abs(x.new_pct) - Math.abs(y.new_pct));
  return out.slice(0, 4);
}
function redraft_verdict(lineup) {
  const la = lineup.A, lb = lineup.B;
  const da = la ? la.after - la.before : null, db = lb ? lb.after - lb.before : null;
  if (da !== null && db !== null) {
    if (da > 0 && db > 0) return { text: "Both starting lineups improve", winner: null };
    if (da > 0 && db <= 0) return { text: "Favors Team A: only its lineup improves", winner: "A" };
    if (db > 0 && da <= 0) return { text: "Favors Team B: only its lineup improves", winner: "B" };
    return { text: "Neither lineup improves", winner: null };
  }
  const [d, label] = da !== null ? [da, "A"] : [db, "B"];
  if (d > 0) return { text: `Team ${label}'s lineup improves (${fmt_signed(d)})`, winner: label };
  if (d < 0) return { text: `Team ${label}'s lineup gets worse (${fmt_signed(d)})`, winner: label === "A" ? "B" : "A" };
  return { text: `No change to Team ${label}'s lineup`, winner: null };
}
function lineup_impact(values, cfg, team_a, team_b, a_gives, b_gives, warnings) {
  const starters = values.league.roster_positions_starters || cfg.league.starters;
  const out = {};
  const base = i => i.split("@")[0];
  for (const [label, team, gives, gets] of [["A", team_a, a_gives, b_gives], ["B", team_b, b_gives, a_gives]]) {
    if (!team) continue;
    const roster = team_assets(values, cfg, team);
    const after = roster.slice();
    for (const m of gives) {
      const aid = base(m.asset.id);
      const idx = after.findIndex(a => base(a.id) === aid);
      if (idx < 0) warnings.push(`${m.asset.name} is not on ${team.team_name}'s roster.`); else after.splice(idx, 1);
    }
    for (const m of gets) after.push(m.asset);
    const get_ids = new Set(gets.map(m => m.asset.id));
    const before_lu = best_lineup(roster, starters), after_lu = best_lineup(after, starters);
    const sum = l => l.reduce((s, a) => s + a.value, 0);
    out[label] = {
      team: team.team_name, before: lineup_total(before_lu, cfg), after: lineup_total(after_lu, cfg),
      dynasty_before: sum(roster), dynasty_after: sum(after), roster_before: roster.length, roster_after: after.length,
      depth_before: depth_of(before_lu), depth_after: depth_of(after_lu),
      starters_after: after_lu.starters.map(([s, p]) => ({ slot: s, name: p ? p.name : "(empty)", pos: p ? p.pos : "", value: p ? lineup_value(p) : 0, new: !!(p && get_ids.has(p.id)) })),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sleeper league import
// ---------------------------------------------------------------------------
async function sleeper_user_leagues(username, season) {
  const u = await Net.json(`${SLEEPER_URL}/user/${encodeURIComponent(username.trim())}`);
  if (!u || !u.user_id) throw new Error(`No Sleeper user named '${username}'`);
  const lgs = await Net.json(`${SLEEPER_URL}/user/${u.user_id}/leagues/nfl/${season}`) || [];
  return { user: u, leagues: lgs.map(l => ({ id: String(l.league_id), name: l.name, season: l.season, teams: l.total_rosters, type: ((l.settings || {}).type === 2 ? "dynasty" : ((l.settings || {}).type === 1 ? "keeper" : "redraft")), previous: l.previous_league_id })) };
}

async function sleeper_import(cfg, league_id, log = () => {}, my_user_id = null) {
  log(`Downloading Sleeper league ${league_id} ...`);
  const L = `${SLEEPER_URL}/league/${league_id}`;
  const lg = await Net.json(L);
  if (!lg) throw new Error("league not found");
  const [users, rosters, traded, drafts] = await Promise.all([
    Net.json(`${L}/users`).then(x => x || []), Net.json(`${L}/rosters`).then(x => x || []),
    Net.json(`${L}/traded_picks`).then(x => x || []), Net.json(`${L}/drafts`).then(x => x || [], () => [])]);
  const season = parseInt(lg.season || new Date().getFullYear());
  const settings = lg.settings || {};
  let league_type = parseInt(settings.type || 0) === 2 ? "dynasty" : "redraft";
  if (league_type === "dynasty" && parseInt(settings.best_ball || 0) === 1) league_type = "dynasty_bestball";
  const draft_rounds = parseInt(settings.draft_rounds || 4);
  const positions = lg.roster_positions || [];
  const starters = positions.filter(p => !["BN", "IR", "TAXI"].includes(p) && (POSITIONS.includes(p) || FLEX_ELIGIBLE[p]));
  let pick_seasons = [season + 1, season + 2, season + 3];
  if (drafts.some(d => String(d.season) === String(season) && d.status !== "complete")) pick_seasons.unshift(season);
  if (league_type === "redraft") pick_seasons = [];
  log("Downloading the Sleeper player list (large) ...");
  const all_players = await sleeper_players();
  try { await refresh_player_status(all_players); } catch (e) { /* optional */ }
  const user_by_id = Object.fromEntries(users.map(u => [u.user_id, u]));
  const reg_end = parseInt(settings.playoff_week_start || 15) - 1;
  log("Downloading schedule and trade history ...");
  const schedule = {}, trades = [];
  const weeks = await Promise.all(Array.from({ length: reg_end }, (_, i) => Net.json(`${L}/matchups/${i + 1}`).catch(() => null)));
  for (let w = 1; w <= reg_end; w++) {
    const mus = weeks[w - 1];
    if (!mus || !mus.length) break;
    schedule[String(w)] = mus.filter(m => m.matchup_id !== null && m.matchup_id !== undefined).map(m => [m.roster_id, m.matchup_id, parseFloat(m.points || 0)]);
  }
  const txw = await Promise.all(Array.from({ length: 18 }, (_, i) => Net.json(`${L}/transactions/${i + 1}`).catch(() => null)));
  for (let w = 1; w <= 18; w++) {
    for (const t of txw[w - 1] || []) {
      if (t.type !== "trade" || t.status !== "complete") continue;
      const sides = {};
      const side = rid => (sides[String(rid)] = sides[String(rid)] || { players: [], picks: [] });
      for (const rid of t.roster_ids || []) side(rid);
      for (const [pid, rid] of Object.entries(t.adds || {})) side(rid).players.push(String(pid));
      for (const pk of t.draft_picks || []) side(pk.owner_id).picks.push({ season: parseInt(pk.season), round: parseInt(pk.round), original: parseInt(pk.roster_id) });
      trades.push({ week: w, created: t.created, id: t.transaction_id, sides });
    }
  }
  const rostered = new Set();
  for (const r of rosters) for (const p of r.players || []) rostered.add(p);
  for (const tr of trades) for (const s of Object.values(tr.sides)) for (const p of s.players) rostered.add(p);
  const players = {};
  for (const pid of rostered) {
    const p = all_players[pid] || {};
    let age = p.age ?? null;
    if (age === null && p.birth_date) { const b = new Date(p.birth_date); if (!isNaN(b)) age = Math.round((Date.now() - b) / (365.25 * 86400000) * 10) / 10; }
    const name = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || String(pid);
    players[pid] = { name, pos: p.position || "?", team: p.team || "FA", age, injury: p.injury_status || null };
  }
  const owner = new Map();
  for (const r of rosters) for (const s of pick_seasons) for (let rnd = 1; rnd <= draft_rounds; rnd++) owner.set(`${s}|${rnd}|${r.roster_id}`, r.roster_id);
  for (const t of traded) { const k = `${t.season}|${parseInt(t.round)}|${parseInt(t.roster_id)}`; if (owner.has(k)) owner.set(k, parseInt(t.owner_id)); }
  const teams = rosters.slice().sort((a, b) => a.roster_id - b.roster_id).map(r => {
    const u = user_by_id[r.owner_id] || {};
    const st = r.settings || {};
    return {
      roster_id: r.roster_id, team_name: (u.metadata || {}).team_name || u.display_name || `Roster ${r.roster_id}`,
      owner: u.display_name || "", owner_id: r.owner_id || null, players: r.players || [],
      picks: [...owner.entries()].filter(([, own]) => own === r.roster_id).map(([k]) => { const [s, rnd, orig] = k.split("|"); return { season: +s, round: +rnd, original: +orig }; }),
      record: `${st.wins || 0}-${st.losses || 0}` + (st.ties ? `-${st.ties}` : ""), points_for: st.fpts || 0,
      starters: (r.starters || []).filter(Boolean).map(String),
    };
  });
  const league = {
    platform: "sleeper", league_id: String(league_id), name: lg.name, season, imported: now_iso(), roster_positions: positions,
    roster_positions_starters: starters, draft_rounds, pick_seasons, teams, players, schedule, trades,
    playoff_teams: parseInt(settings.playoff_teams || 6), playoff_week_start: parseInt(settings.playoff_week_start || 15),
    waiver_type: parseInt(settings.waiver_type || 0), waiver_budget: parseInt(settings.waiver_budget || 0), waiver_bid_min: settings.waiver_bid_min != null ? parseInt(settings.waiver_bid_min) : null,
    previous_league_id: lg.previous_league_id || null,
    trade_deadline: settings.trade_deadline != null ? parseInt(settings.trade_deadline) : null,
  };
  Store.set(f("league.json"), league);
  log(`Saved '${league.name}': ${teams.length} teams, ${Object.keys(players).length} rostered players, ${trades.length} trades`);
  if (P.id && league.name) profile_rename(P.id, league.name);
  const scoring = lg.scoring_settings || {};
  const newl = Object.assign({}, cfg.league);
  newl.name = lg.name || newl.name;
  newl.type = league_type;
  newl.teams = parseInt(lg.total_rosters || rosters.length);
  newl.num_qbs = positions.some(p => ["SUPER_FLEX", "SUPERFLEX", "SF"].includes(p)) ? 2 : 1;
  newl.ppr = parseFloat(scoring.rec ?? 1);
  const te_bonus = parseFloat(scoring.bonus_rec_te || 0);
  newl.te_premium_bonus_pct = te_bonus ? Math.min(25, pyround(te_bonus * 20)) : 0;
  newl.roster_size = positions.filter(p => p !== "IR").length + parseInt(settings.taxi_slots || 0);
  newl.starters = starters;
  const feed_changed = ["ppr", "num_qbs", "type", "teams"].some(k => cfg.league[k] !== newl[k]);
  cfg.league = newl;
  cfg.season = season;
  if (my_user_id) { const mine = teams.find(t => t.owner_id === my_user_id); if (mine) cfg.my_roster_id = mine.roster_id; }
  save_config(cfg);
  if (P.values) P.values.attach_league(league);
  return { league, feed_changed };
}

function find_team(values, id) {
  const lg = values && values.league;
  if (!lg || id === null || id === undefined) return null;
  return lg.teams.find(t => String(t.roster_id) === String(id)) || null;
}
/* ---------------------------------------------------------------------------
   Projected final standings and rookie-draft slots, so a pick is worth what its original owner's finish makes it.
   Each remaining game of the league's real schedule is simulated SIMS times. A team's strength mixes points scored
   per game (it counts more as games are played) with the value of its best starting lineup (it counts more early,
   when records are noisy); each simulated season also nudges every team's strength at random (more early on), and
   P(A beats B) = 1 / (1 + e^(-0.7 (sA - sB))). Final order: wins, then points scored.
   Draft order: worst record picks first (the usual rookie-draft rule; playoff results are not modelled).
   Cached on the values object. */
const PROJ_SIMS = 3000;
function project_standings(values, cfg) {
  const lg = values && values.league;
  if (!lg || !(lg.teams || []).length || lg.platform === "manual") return null;   // built by hand: no schedule, no standings to project
  if (values._proj) return values._proj;
  values._proj = simulate_standings(values, cfg, lg.teams, PROJ_SIMS);
  return values._proj;
}
/* The season simulation for any set of rosters (a trade's "after" is a copy of the teams with the players moved):
   the remaining schedule, each team's strength from its points so far and its starting lineup's value, then the
   playoff bracket for the title (single elimination, byes to the top seeds). */
function simulate_standings(values, cfg, teams, sims) {
  const lg = values.league, n = teams.length, starters = lg.roster_positions_starters || cfg.league.starters;
  const recs = teams.map(t => { const [w, l, ti] = String(t.record || "0-0").split("-").map(x => parseInt(x, 10) || 0); return { w, l, ti: ti || 0, g: w + l + (ti || 0) }; });
  const g = Math.max(0, ...recs.map(r => r.g));
  const z = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1; return xs.map(x => (x - m) / sd); };
  const ppg = teams.map((t, i) => recs[i].g ? (t.points_for || 0) / recs[i].g : 0);
  // players only: the picks would ask for this projection
  const lineup = teams.map(t => { const lu = best_lineup_by(t.players.map(pid => values.by_sleeper[String(pid)]).filter(Boolean), starters, lineup_value); return lu.starters.reduce((a, [, p]) => a + (p ? lineup_value(p) : 0), 0); });
  const wpf = g / (g + 4), zp = z(ppg), zl = z(lineup);
  const str = teams.map((t, i) => (g ? wpf * zp[i] : 0) + (1 - wpf * (g ? 1 : 0)) * zl[i]);
  const idx = Object.fromEntries(teams.map((t, i) => [t.roster_id, i]));
  // remaining games from the schedule (weeks after the games already played)
  const games = [], regEnd = (parseInt(lg.playoff_week_start, 10) || 15) - 1;
  for (const [wk, rows] of Object.entries(lg.schedule || {})) {
    if (parseInt(wk, 10) <= g || parseInt(wk, 10) > regEnd) continue;
    const byM = {};
    for (const [rid, mid] of rows) (byM[mid] = byM[mid] || []).push(idx[rid]);
    for (const pair of Object.values(byM)) if (pair.length === 2 && pair.every(x => x != null)) games.push(pair);
  }
  if (!games.length && g < regEnd) for (let wk = g + 1; wk <= regEnd; wk++) {            // no schedule: random pairings
    const o = [...Array(n).keys()].sort(() => Math.random() - 0.5);
    for (let i = 0; i + 1 < n; i += 2) games.push([o[i], o[i + 1]]);
  }
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const noise = 0.65 * Math.sqrt(4 / (g + 4));                     // how unsure we are of each team's true strength
  const slots = teams.map(() => new Array(n).fill(0)), winsSum = new Array(n).fill(0), playoff = new Array(n).fill(0);
  const titles = new Array(n).fill(0), beat = (a, b, sim) => Math.random() < 1 / (1 + Math.exp(-0.7 * (sim[a] - sim[b])));
  const pt = parseInt(lg.playoff_teams, 10) || Math.round(n / 2);
  const pfPace = teams.map((t, i) => (t.points_for || 0) + ppg[i] * Math.max(0, regEnd - recs[i].g));
  for (let s = 0; s < sims; s++) {
    const w = recs.map(r => r.w + r.ti / 2), sim = str.map(x => x + noise * gauss());      // this season's version of each team
    for (let k = 0; k < games.length; k++) { const [a, b] = games[k]; if (Math.random() < 1 / (1 + Math.exp(-0.7 * (sim[a] - sim[b])))) w[a]++; else w[b]++; }
    const order = [...Array(n).keys()].sort((a, b) => (w[b] - w[a]) || (pfPace[b] - pfPace[a]) || (Math.random() - 0.5));
    order.forEach((ti, place) => { slots[ti][n - 1 - place]++; winsSum[ti] += w[ti]; if (place < pt) playoff[ti]++; });
    let field = order.slice(0, Math.min(pt, n));                              // the playoff bracket: byes to the top seeds
    while (field.length > 1) {
      const P = 1 << Math.ceil(Math.log2(field.length)), byes = P - field.length, next = field.slice(0, byes), play = field.slice(byes);
      for (let i = 0; i < play.length / 2; i++) { const a = play[i], b = play[play.length - 1 - i]; next.push(beat(a, b, sim) ? a : b); }
      field = next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    if (field.length) titles[field[0]]++;
  }
  const out = {};
  teams.forEach((t, i) => {
    const pr = slots[i].map(c => c / sims);
    out[t.roster_id] = { slots: pr, exp_slot: pr.reduce((a, p, k) => a + p * (k + 1), 0), wins: winsSum[i] / sims, playoff: playoff[i] / sims, title: titles[i] / sims, strength: str[i] };
  });
  return { by: out, n, weeks_left: games.length ? Math.round(games.length / (n / 2)) : 0, games_played: g, sims };
}
/* A pick's value from its original owner's projected draft slot. Next year's pick uses the simulated slot odds; later
   years lean on team strength, pulled halfway (two years out) or three-quarters (three years) toward the middle. */
function projected_pick(values, cfg, season, rnd, original, P0 = null) {
  const P = P0 || project_standings(values, cfg);
  if (!P || !P.by[original]) return null;
  const n = P.n, cur = parseInt(cfg.season, 10), T = P.by[original];
  const tv = t => resolve_pick(values, cfg, season, rnd, t).value;
  const knots = [[n * 0.17, tv("early")], [n * 0.5, tv("mid")], [n * 0.83, tv("late")]];
  const at = slot => {                                       // value at a slot (1..n): straight lines through early/mid/late
    const [[x0, y0], [x1, y1], [x2, y2]] = knots;
    const lin = (xa, ya, xb, yb) => ya + (yb - ya) * (slot - xa) / (xb - xa);
    const v = slot <= x1 ? lin(x0, y0, x1, y1) : lin(x1, y1, x2, y2);
    return Math.max(Math.min(v, y0 * 1.2), y2 * 0.8);        // don't run off the ends
  };
  let probs;
  if (season <= cur + 1) probs = T.slots;
  else {
    const pull = season === cur + 2 ? 0.5 : 0.75, mid = (n + 1) / 2, e = T.exp_slot + (mid - T.exp_slot) * pull;
    probs = new Array(n).fill(0); const lo = Math.max(1, Math.floor(e)), hi = Math.min(n, lo + 1), f = e - lo;
    probs[lo - 1] += 1 - f; probs[hi - 1] += f;
  }
  const value = probs.reduce((a, p, k) => a + p * at(k + 1), 0), exp = probs.reduce((a, p, k) => a + p * (k + 1), 0);
  const label = season <= cur + 1 ? `proj. ${rnd}.${String(Math.max(1, Math.round(exp))).padStart(2, "0")}` : `proj. ${exp <= n / 3 ? "early" : exp <= 2 * n / 3 ? "mid" : "late"}`;
  return { value, exp_slot: exp, label, playoff: T.playoff };
}
/* What a trade does to each team's season and future: playoff and title odds and projected wins from the simulation
   with the players moved, and in dynasty the roster's value two seasons out along the age curves and where the team's
   own next first-round pick projects. a_gives / b_gives are the trade's rows ({asset}); a team may be null. */
function trade_impact(values, cfg, team_a, team_b, a_gives, b_gives) {
  const lg = values && values.league;
  if (!lg || !(lg.teams || []).length || !(team_a || team_b)) return null;
  const before = project_standings(values, cfg);
  if (!before) return null;
  const sid = m => (m.asset && m.asset.sleeper_id ? String(m.asset.sleeper_id) : null);
  const moved = (team, gives, gets) => {
    const out = new Set(gives.map(sid).filter(Boolean)), inn = gets.map(sid).filter(Boolean);
    return Object.assign({}, team, { players: team.players.filter(p => !out.has(String(p))).concat(inn) });
  };
  const teams = lg.teams.map(t => (team_a && t.roster_id === team_a.roster_id ? moved(t, a_gives, b_gives) : team_b && t.roster_id === team_b.roster_id ? moved(t, b_gives, a_gives) : t));
  const after = simulate_standings(values, cfg, teams, 2000);
  const redraft = is_redraft(cfg), season = parseInt(cfg.season, 10);
  const ratio = a => (a.is_pick || a.age == null ? 1 : age_factor(a.pos, a.age + 2, cfg) / Math.max(0.05, age_factor(a.pos, a.age, cfg)));
  const future = assets => assets.reduce((s, a) => s + a.value * ratio(a), 0);
  const base = i => String(i).split("@")[0];
  const out = { weeks_left: before.weeks_left, games_played: before.games_played, sides: {} };
  for (const [label, team, gives, gets] of [["A", team_a, a_gives, b_gives], ["B", team_b, b_gives, a_gives]]) {
    if (!team) continue;
    const b = before.by[team.roster_id], a = after.by[team.roster_id];
    if (!b || !a) continue;
    const side = { team: team.team_name, playoff: [b.playoff, a.playoff], title: [b.title || 0, a.title || 0], wins: [b.wins, a.wins] };
    if (!redraft) {
      const roster = team_assets(values, cfg, team);
      const afterRoster = roster.filter(x => !gives.some(m => base(m.asset.id) === base(x.id))).concat(gets.map(m => m.asset));
      side.future = [future(roster), future(afterRoster)];
      side.now = [roster.reduce((s, x) => s + x.value, 0), afterRoster.reduce((s, x) => s + x.value, 0)];
      const own = roster.find(x => x.is_pick && x.pick && x.pick.round === 1 && parseInt(x.pick.season, 10) === season + 1 && x.original === team.roster_id);
      if (own) {
        const pb = projected_pick(values, cfg, season + 1, 1, team.roster_id, before), pa = projected_pick(values, cfg, season + 1, 1, team.roster_id, after);
        if (pb && pa) side.pick = { name: `${season + 1} 1st`, before: pb, after: pa, traded: gives.some(m => m.asset.id === own.id) };
      }
    }
    out.sides[label] = side;
  }
  return out;
}
function team_assets(values, cfg, team) {
  const out = [];
  for (const pid of team.players) { const a = values.by_sleeper[String(pid)] || values.by_id[String(pid)]; if (a) out.push(a); }   // by_id: rosters built by hand
  const names = Object.fromEntries(((values.league || {}).teams || []).map(t => [t.roster_id, t.team_name]));
  // the picks in Sleeper's order: season, then round, the team's own pick before the ones it acquired (2026-10-07)
  const own = pk => (pk.original === null || pk.original === undefined || pk.original === team.roster_id ? 0 : 1);
  const picks = is_redraft(cfg) ? [] : (team.picks || []).slice().sort((x, y) => (x.season - y.season) || (x.round - y.round) || (own(x) - own(y)) || ((x.original || 0) - (y.original || 0)));
  for (const pk of picks) {
    let a = resolve_pick(values, cfg, pk.season, pk.round, null);
    const orig = pk.original !== null && pk.original !== undefined ? pk.original : team.roster_id;
    const pp = projected_pick(values, cfg, pk.season, pk.round, orig);         // worth what the original owner's finish makes it
    const via = orig !== team.roster_id ? ` (via ${names[orig] || "another team"})` : "";
    a = Object.assign({}, a, { id: `${a.id}@${orig}`, name: `${a.name}${pp ? " · " + pp.label : ""}${via}`, original: orig },
      pp ? { value: Math.round(pp.value), proj_slot: pp.exp_slot } : {});
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leagues without Sleeper: the rosters are built by hand in the app (ui.js rosterBuilder). The league file has the
// same shape as a Sleeper import, so the trade screen, My team, the pickups and the GM all work from it. There is no
// schedule, so standings and pick slots are not projected; picks keep their generic values.
// ---------------------------------------------------------------------------
const MANUAL_ROUNDS = 4;
function manual_league(cfg, name) {
  const season = parseInt(cfg.season, 10), starters = (cfg.league.starters || DEFAULT_CONFIG.league.starters).slice();
  if (is_redraft(cfg)) starters.push("K", "DEF");                                   // most redraft lineups start both
  const bench = Math.max(0, (parseInt(cfg.league.roster_size, 10) || 25) - starters.length);
  return { platform: "manual", league_id: null, name: name || cfg.league.name, season, imported: now_iso(), roster_positions: starters.concat(Array(bench).fill("BN")),
    roster_positions_starters: starters.filter(s => POSITIONS.includes(s) || FLEX_ELIGIBLE[s]), draft_rounds: MANUAL_ROUNDS, pick_seasons: is_redraft(cfg) ? [] : [season + 1, season + 2, season + 3],
    teams: [], players: {}, schedule: {}, trades: [], playoff_teams: 6, playoff_week_start: 15, waiver_type: 0, waiver_budget: 0, waiver_bid_min: null,
    previous_league_id: null, trade_deadline: null };
}
function manual_add_team(league, name) {
  const rid = league.teams.reduce((m, t) => Math.max(m, t.roster_id), 0) + 1, picks = [];
  for (const s of league.pick_seasons) for (let r = 1; r <= league.draft_rounds; r++) picks.push({ season: s, round: r, original: rid });
  league.teams.push({ roster_id: rid, team_name: name || `Team ${rid}`, owner: "", owner_id: null, players: [], picks, record: "0-0", points_for: 0, starters: [] });
  return rid;
}
/* The league's own player list (name, position, team, age) from the value list, for the players on its rosters. */
/* The lineup of a league built by hand: how many of each slot it starts, and the bench. K and DEF are kept on
   roster_positions (the lineup helper reads them there) and off roster_positions_starters, as a Sleeper import does. */
const MANUAL_SLOTS = ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"];
function manual_lineup_counts(league) {
  const c = Object.fromEntries(MANUAL_SLOTS.map(s => [s, 0])); c.BN = 0;
  for (const s of league.roster_positions || []) { const k = s === "SUPERFLEX" || s === "SF" ? "SUPER_FLEX" : s; if (k in c) c[k] += 1; else if (k === "BN") c.BN += 1; }
  return c;
}
function manual_set_lineup(league, cfg, counts) {
  const n = k => Math.max(0, Math.min(k === "BN" ? 40 : 6, parseInt(counts[k], 10) || 0));
  const slots = [];
  for (const s of MANUAL_SLOTS) for (let i = 0; i < n(s); i++) slots.push(s);
  if (!slots.some(s => POSITIONS.includes(s) || FLEX_ELIGIBLE[s])) slots.unshift("QB", "RB", "RB", "WR", "WR", "TE", "FLEX");   // a lineup needs players in it
  league.roster_positions = slots.concat(Array(n("BN")).fill("BN"));
  league.roster_positions_starters = slots.filter(s => POSITIONS.includes(s) || FLEX_ELIGIBLE[s]);
  cfg.league.starters = league.roster_positions_starters.slice();
  cfg.league.roster_size = league.roster_positions.length;
  cfg.league.num_qbs = slots.includes("SUPER_FLEX") ? 2 : 1;
  save_config(cfg);
  return league;
}
/* A player goes on a hand-built roster with his name, position and team, so a kicker or a defense (which no value
   list carries) is still there after the app reloads. */
function manual_add_player(league, team, a) {
  const sid = String(a.sleeper_id || a.id);
  if (!team.players.map(String).includes(sid)) team.players.push(sid);
  league.players[sid] = { name: a.name, pos: a.pos, team: a.team || "FA", age: a.age ?? null, injury: null };
}
/* Players the value lists don't carry (kickers, defenses, deep benches) from Sleeper's player list, for rosters
   built by hand. A defense is named by its team, and Sleeper's id for one is the team code (KC, NE). */
let pool_cache = null;
async function pool_search(query, values, limit = 8, positions = POSITIONS) {
  const players = await sleeper_players().catch(() => null);
  if (!players) return [];
  if (!pool_cache || pool_cache.src !== players) {
    const list = [];
    for (const [pid, p] of Object.entries(players)) {
      const pos = p.position;
      if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)) continue;
      if (pos !== "DEF" && !(p.team && p.active !== false)) continue;
      const name = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
      if (!name) continue;
      list.push(make_player("sl" + pid, name, pos, p.team || (pos === "DEF" ? pid : "FA"), p.age ?? null, 0, 0, null, null, null, String(pid), true));
    }
    pool_cache = { src: players, list };
  }
  const pool = pool_cache.list.filter(a => positions.includes(a.pos) && !(values && values.by_sleeper[a.sleeper_id]));
  const code = String(query).trim().toUpperCase();
  const def = positions.includes("DEF") && code.length <= 3 ? pool.filter(a => a.pos === "DEF" && a.team === code) : [];   // "KC" finds the Chiefs
  return def.concat(search_players(query, values, limit, pool).filter(a => !def.includes(a))).slice(0, limit);
}
function manual_sync_players(league, values) {
  const used = new Set(league.teams.flatMap(t => t.players.map(String)));
  for (const k of Object.keys(league.players)) if (!used.has(k)) delete league.players[k];
  for (const sid of used) { const a = values.by_sleeper[sid] || values.by_id[sid]; if (a) league.players[sid] = { name: a.name, pos: a.pos, team: a.team || "FA", age: a.age, injury: null }; }
}
function manual_save(league, values) {
  if (values) manual_sync_players(league, values);
  league.imported = now_iso();
  league.teams.sort((a, b) => a.roster_id - b.roster_id);
  Store.set(f("league.json"), league);
  if (values) values.attach_league(league);
  if (P.values && P.values !== values) P.values.attach_league(league);
}
/* How many rounds the league's rookie draft has: every team keeps its own picks for each round, acquired picks stay. */
function manual_set_rounds(league, rounds) {
  league.draft_rounds = Math.max(1, Math.min(20, parseInt(rounds, 10) || MANUAL_ROUNDS));
  for (const t of league.teams) {
    t.picks = t.picks.filter(p => p.round <= league.draft_rounds);
    for (const s of league.pick_seasons) for (let r = 1; r <= league.draft_rounds; r++)
      if (!league.teams.some(o => o.picks.some(p => p.season === s && p.round === r && p.original === t.roster_id))) t.picks.push({ season: s, round: r, original: t.roster_id });
  }
}
/* A new season: the draft that has happened drops off, a new far-off season of picks appears. */
function manual_roll_season(league, season) {
  league.season = season;
  if (!league.pick_seasons.length) return;
  league.pick_seasons = [season + 1, season + 2, season + 3];
  for (const t of league.teams) t.picks = t.picks.filter(p => p.season >= season + 1);
  manual_set_rounds(league, league.draft_rounds);
}

// ---------------------------------------------------------------------------
// Settings toggles
// ---------------------------------------------------------------------------
function apply_settings(cfg, s) {
  const lg = cfg.league, before = Object.assign({}, lg);
  if (["dynasty", "redraft", "dynasty_bestball"].includes(s.league_type)) lg.type = s.league_type;
  if (s.half_ppr === true) lg.ppr = 0.5;
  else if (s.half_ppr === false && parseFloat(lg.ppr ?? 1) === 0.5) lg.ppr = 1;
  if (s.superflex !== undefined && s.superflex !== null) {
    lg.num_qbs = s.superflex ? 2 : 1;
    let st = (lg.starters || []).slice();
    const has = st.some(x => ["SUPER_FLEX", "SUPERFLEX", "SF"].includes(x.toUpperCase()));
    if (s.superflex && !has) st.push("SUPER_FLEX");
    if (!s.superflex && has) st = st.filter(x => !["SUPER_FLEX", "SUPERFLEX", "SF"].includes(x.toUpperCase()));
    lg.starters = st;
  }
  if (s.te_premium_pct !== undefined && s.te_premium_pct !== null) lg.te_premium_bonus_pct = Math.max(0, Math.min(100, parseInt(s.te_premium_pct) || 0));
  if (s.hide_k_def !== undefined && s.hide_k_def !== null) lg.hide_k_def = !!s.hide_k_def;
  if (s.qb_premium_pct !== undefined && s.qb_premium_pct !== null) { const v = Math.max(0, Math.min(100, parseInt(s.qb_premium_pct) || 0)); if (parseInt(lg.num_qbs || 1) >= 2) lg.sf_qb_bonus_pct = v; else lg.qb_bonus_pct = v; }
  if (s.young_qb_premium_pct !== undefined && s.young_qb_premium_pct !== null) lg.sf_young_qb_bonus_pct = Math.max(0, Math.min(100, parseInt(s.young_qb_premium_pct) || 0));
  if (s.qb_trade_pct !== undefined && s.qb_trade_pct !== null) lg.qb_trade_bump_pct = Math.max(0, Math.min(100, parseInt(s.qb_trade_pct) || 0));
  if (s.teams) lg.teams = Math.max(4, Math.min(32, parseInt(s.teams)));
  const changes = Object.keys(lg).filter(k => JSON.stringify(before[k]) !== JSON.stringify(lg[k]));
  const feed_changed = changes.some(k => ["ppr", "num_qbs", "type", "teams"].includes(k));
  if (changes.length) save_config(cfg);
  return { changes, feed_changed };
}

// ---------------------------------------------------------------------------
// Price history (one snapshot per update day)
// ---------------------------------------------------------------------------
function load_history() { return Store.get(f("history.json")) || { snapshots: [] }; }
function record_history(assets) {
  const h = load_history(), today = today_iso();
  h.snapshots = h.snapshots.filter(x => x.date !== today);
  h.snapshots.push({ date: today, values: Object.fromEntries(assets.map(a => [a.id, a.value])) });
  h.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  Store.set(f("history.json"), h);
  return h.snapshots.length;
}
function price_series(asset_id, history) {
  const h = history || load_history();
  return h.snapshots.filter(s => s.values[asset_id] !== undefined).map(s => [s.date, s.values[asset_id]]);
}
function price_changes(series) {
  if (!series.length) return {};
  const [last_d, last_v] = series[series.length - 1];
  const last = new Date(last_d + "T12:00:00");
  const at = days => {
    const target = new Date(last.getTime() - days * 86400000).toISOString().slice(0, 10);
    const pts = series.filter(([d]) => d <= target).map(([, v]) => v);
    return pts.length ? pts[pts.length - 1] : null;
  };
  const delta = b => (b === null || b === 0) ? null : [last_v - b, (last_v - b) / b * 100];
  const vals = series.map(([, v]) => v);
  return { "7d": delta(at(7)), "30d": delta(at(30)), all: delta(series.length > 1 ? series[0][1] : null), high: Math.max(...vals), low: Math.min(...vals), points: series.length };
}

// ---------------------------------------------------------------------------
// Trade log
// ---------------------------------------------------------------------------
function log_trade(result, note = "") {
  const log = Store.get(f("trades.json")) || [];
  log.unshift({
    date: now_iso().replace("T", " ").slice(0, 16), team_a: result.teams.A.name, a_gives: result.teams.A.gives.rows.map(r => r.name),
    team_b: result.teams.B.name, b_gives: result.teams.B.gives.rows.map(r => r.name), verdict: result.verdict.text, pct: result.market.pct,
    a_ids: result.teams.A.gives.rows.map(r => r.id), b_ids: result.teams.B.gives.rows.map(r => r.id), note,
  });
  Store.set(f("trades.json"), log.slice(0, 200));
}
const read_log = () => Store.get(f("trades.json")) || [];

// ---------------------------------------------------------------------------
return {
  PLAY, update_wait_minutes, model_changed, src_dmv, nflv_team_ctx, snap_stats, ep_stats, GRADE_CUTS, game_log, career_stats, weekly_points, nflv_stats, nflv_draft, nfl_team, parse_csv, project_standings, projected_pick, simulate_standings, trade_impact, prospects, prospects_cached, POSITIONS, HIDDEN_POSITIONS, MODES, FLEX_ELIGIBLE, SOURCES, SOURCE_ORDER, DEFAULT_CONFIG, SLEEPER_URL, DMV_REPLACEMENT, DMV_TYPICAL, DMV_DEPTH_MAX, P, f,
  pyround, clone, now_iso, today_iso, ordinal, fmt, fmt_signed, fmt_pct, compact, norm, title, player_key, ppr_bucket,
  is_bestball, is_redraft, league_kind, league_kind_label,
  load_profiles, save_profiles, set_profile, profile_new, profile_rename, profile_delete, load_config, save_config,
  make_player, make_pick, Values, load_values, stale_warning, assign_tiers,
  update_values, build_consensus, fetch_all_sources, source_settings, source_applies, refresh_player_status, load_player_status, load_name_index,
  refresh_trending, trending_list, sleeper_player, team_depth, player_news, player_blurbs,
  parse_pick_query, resolve_pick, search_players, find_asset,
  category, age_factor, adjusted_value, qb_trade_mult, roster_spot_cost, lineup_value, best_lineup, best_lineup_by, lineup_total, depth_of,
  analyze_trade, verdict_for, pick_equivalent, league_view_text,
  sleeper_user_leagues, sleeper_import, find_team, team_assets, apply_settings, manual_league, manual_add_team, manual_save, manual_set_rounds, manual_roll_season, manual_lineup_counts, manual_set_lineup, manual_add_player, pool_search,
  load_history, record_history, price_series, price_changes, log_trade, read_log,
};
})();
