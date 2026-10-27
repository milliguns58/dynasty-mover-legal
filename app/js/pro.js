/* Pro edition screens: sign-in, free trial banner, paywall, "update required", announcements, and the account card on
   the League tab. The rules for who gets in are in account.js. Loaded before ui.js; ui.js calls Pro.start() at the end
   instead of opening Home straight away, and uses ui.js helpers ($, esc, toast, openSheet, go) only after that. */
"use strict";

const Pro = (() => {
  const ON = window.EDITION === "pro";
  const P = window.PRO || {};
  let entered = false, busy = false, wasPro = null, screen = "", pickPlan = (P.plans && P.plans[0] && P.plans[0].id) || "yearly";

  const gated = () => document.body.classList.contains("gated");
  function gate(html, name) {
    screen = name;
    document.body.classList.add("gated");
    if (sheetOpen()) closeSheet();
    $("#view").innerHTML = html;
    window.scrollTo(0, 0);
  }
  const hero = (title, text) => `<div class="gate-hero"><img src="icon.png" alt="" class="gate-logo"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  const legal = () => `<p class="foot">By continuing you agree to the <a class="lnk" data-link="${esc(P.termsUrl || "")}">Terms</a>
    and the <a class="lnk" data-link="${esc(typeof PRIVACY_URL !== "undefined" ? PRIVACY_URL : "")}">Privacy Policy</a>.</p>`;
  const PERKS = ["Grades for any trade, in plain words", "Your Sleeper leagues, rosters and picks", "Trending players and who's still free", "Your best lineup and pickups"];

  // ---------------------------------------------------------------------------
  // Deciding what to show
  // ---------------------------------------------------------------------------
  function start() {
    Account.onChange(onChange);
    decide();
    Account.refresh(true);
    return true;
  }
  function decide() {
    const s = Account.status();
    if (s.kind === "setup") return screen === "setup" || setupScreen();
    if (Account.needsUpdate()) return screen === "update" || updateScreen();
    if (s.kind === "signedout") return screen.startsWith("sign") || signInScreen("signup");
    if (!entered || gated()) {
      document.body.classList.remove("gated");
      screen = "";
      wasPro = s.pro;
      applyTheme();
      go(entered ? (S.tab || "rank") : "rank");
      if (!entered) setTimeout(autoRefresh, 800);
      entered = true;
    } else if (s.pro !== wasPro) {                        // trial ended, or just subscribed: redraw with features locked or unlocked
      wasPro = s.pro;
      applyTheme();
      if (!sheetOpen()) go(S.tab || "rank");
    }
    bar(s);
    if (s.kind === "basic" && !app().basicNotice) { saveApp({ basicNotice: true }); setTimeout(() => paywallSheet("ended"), 600); }
  }
  function onChange(extra) {
    if (extra.error) toast(extra.error, 4200);
    if (extra.justBought) { toast("Thanks! You're on Dynasty Mover Pro.", 3600); if (sheetOpen()) closeSheet(); }
    if (extra.justBoughtAddon) { toast("Thanks! The draft kit is yours.", 3600); if (sheetOpen()) closeSheet(); if (!gated() && !busy) go(S.tab || "rank"); }
    if (busy) return;                                     // a form is running; it decides when it finishes
    decide();
    if (!gated() && $("#acct")) { $("#acct").outerHTML = accountCard(); bindAccount(); }
  }
  function resume() { if (ON) Account.refresh().then(() => Account.refreshConfig()).then(() => { if (!busy) decide(); }); }

  // ---------------------------------------------------------------------------
  // Sign in / sign up
  // ---------------------------------------------------------------------------
  function signInScreen(mode) {
    const up = mode === "signup";
    gate(`${hero("Dynasty Mover", "Know the trade before you hit accept.")}
      <section class="card">
        <h2>${up ? `Start your free ${Account.trialDays}-day trial` : "Welcome back"}</h2>
        <div class="hint">${up ? "No card needed. Just an email and a password." : "Sign in to your account."}</div>
        ${up ? `<ul class="perks">${PERKS.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        <label class="lbl">Email</label>
        <input type="email" id="gEmail" autocomplete="email" autocapitalize="off" inputmode="email" value="${esc(Account.email || "")}">
        <label class="lbl">Password</label>
        <input type="password" id="gPw" autocomplete="${up ? "new-password" : "current-password"}" placeholder="${up ? "At least 6 characters" : ""}">
        <div class="gate-err hidden" id="gErr"></div>
        <button class="btn primary block big" id="gGo" style="margin-top:14px">${up ? "Start free trial" : "Sign in"}</button>
        <div class="gate-links">
          <button class="link-btn" id="gSwap">${up ? "Already have an account? <b>Sign in</b>" : "New here? <b>Start a free trial</b>"}</button>
          ${up ? "" : `<button class="link-btn" id="gForgot">Forgot password?</button>`}
        </div>
      </section>${legal()}`, up ? "signup" : "signin");
    const err = m => { const e = $("#gErr"); e.textContent = m; e.classList.toggle("hidden", !m); };
    const submit = async () => {
      const email = $("#gEmail").value.trim(), pw = $("#gPw").value;
      if (!/^\S+@\S+\.\S+$/.test(email)) return err("Enter your email address.");
      if (pw.length < 6) return err("Use a password of at least 6 characters.");
      err(""); busy = true;
      const b = $("#gGo"); b.disabled = true; b.innerHTML = `<span class="spin"></span>`;
      try { await (up ? Account.signUp(email, pw) : Account.signIn(email, pw)); busy = false; screen = ""; decide(); if (up) toast(`Your ${Account.trialDays}-day free trial has started.`, 3600); }
      catch (e) { busy = false; err(e.message); b.disabled = false; b.textContent = up ? "Start free trial" : "Sign in"; }
    };
    $("#gGo").onclick = submit;
    $("#gPw").onkeydown = e => { if (e.key === "Enter") submit(); };
    $("#gSwap").onclick = () => signInScreen(up ? "signin" : "signup");
    if ($("#gForgot")) $("#gForgot").onclick = async () => {
      const email = $("#gEmail").value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return err("Type your email above first.");
      try { await Account.resetPassword(email); err(""); toast("Check your email for a link to set a new password.", 4200); }
      catch (e) { err(e.message); }
    };
  }

  // ---------------------------------------------------------------------------
  // Paywall
  // ---------------------------------------------------------------------------
  function planList() {
    const live = (Account.billing.plans || []);
    return (P.plans || []).map(p => {
      const g = live.find(x => x.id === p.id);
      const per = g ? ({ P1M: "a month", P1Y: "a year", P3M: "every 3 months", P6M: "every 6 months", P1W: "a week" }[g.period] || "") : "";
      return `<button class="plan${p.id === pickPlan ? " on" : ""}" data-plan="${esc(p.id)}"><span class="plan-dot"></span>
        <span class="plan-main"><b>${esc(p.label)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ""}</span>
        <span class="plan-price">${esc(g ? `${g.price} ${per}`.trim() : p.fallback)}</span></button>`;
    }).join("");
  }
  /* Other ways to pay (the web version only; the Play app must use Play Billing): the owner's Cash App, PayPal and
     Venmo from the edition file. The buyer sends the amount with the sign-in email in the note; the owner switches
     the account on from the admin page. Hidden when nothing is filled in. */
  function otherWays(amount, what) {
    const pay = (window.PRO && window.PRO.pay) || {}, rows = [];
    if (pay.cashapp) rows.push(`<div class="kv"><span>Cash App</span><b>${esc(pay.cashapp)}</b></div>`);
    if (pay.paypal) rows.push(`<div class="kv"><span>PayPal</span><b><a data-link="${esc(pay.paypal)}" class="lnk">${esc(pay.paypal.replace(/^https?:\/\//, ""))}</a></b></div>`);
    if (pay.venmo) rows.push(`<div class="kv"><span>Venmo</span><b>${esc(pay.venmo)}</b></div>`);
    if (!rows.length) return "";
    const email = (() => { try { return (Account.status ? Account.status() : {}).email || null; } catch (e) { return null; } })();
    return `<div class="sub-h" style="margin-top:16px">Other ways to pay</div>${rows.join("")}
      <p class="note">Send <b>${esc(amount)}</b> for ${esc(what)} and put <b>${email ? esc(email) : "your sign-in email"}</b> in the note. Your account is switched on within a day, usually sooner. No subscription: it runs out when the time is up and you can pay again.</p>`;
  }
  function paywallBody(s) {
    const pending = Account.billing.pending;
    if (Store.web) {                                                 // no store on the web: a Play subscription carries over, or pay another way
      const plan = P.plans.find(x => x.id === pickPlan) || P.plans[0];
      return `<section class="card">
        <div class="plans">${planList()}</div>
        <p class="note" style="margin-top:12px">Pro bought in the Android app on Google Play carries over to this account here: sign in with the same email.</p>
        ${otherWays(plan.fallback.replace(/ a (month|year)$/, "") + (plan.id === "yearly" ? " for a year" : " for a month"), "Dynasty Mover Pro")}
        <button class="link-btn" id="pwRestore" style="display:block;margin:10px auto 0">I've paid: check my account</button>
      </section>`;
    }
    return `<section class="card">
        <div class="plans">${planList()}</div>
        <button class="btn primary block big" id="pwBuy" style="margin-top:14px">Subscribe</button>
        <div class="hint" style="margin-top:10px;text-align:center">${pending ? "Your payment is being processed by Google Play." : "Renews automatically. Cancel anytime in Google Play."}</div>
        <button class="link-btn" id="pwRestore" style="display:block;margin:10px auto 0">Restore purchase</button>
      </section>`;
  }
  function bindPaywall(root) {
    $$("[data-plan]", root).forEach(b => b.onclick = () => {
      pickPlan = b.dataset.plan;
      $$("[data-plan]", root).forEach(x => x.classList.toggle("on", x === b));
    });
    if ($("#pwBuy", root)) $("#pwBuy", root).onclick = () => Account.buy(pickPlan);
    $("#pwRestore", root).onclick = () => { toast("Checking Google Play…"); if (Store.native && Native.billingStart) Native.billingStart(); Account.refresh(true); };
  }
  /* What each locked feature is called on the upgrade sheet. */
  const REASONS = {
    modes: "Win now and Rebuilding views", fair: "\"Make it fair\" suggestions", settings: "Custom league settings",
    sources: "Choosing ranking sites", leagues: "More than one league", team: "Lineup help and pickups",
    history: "Trade history", chart: "Value history charts", retro: "The 8-bit look",
    tradesize: "Trades with more than 4 players or picks", ourgrade: "Our grades, our take on trades and the team read",
    impact: "Trade impact: playoff odds and your roster's future", gm: "Your GM, the chat that knows your league",
    negotiator: "The Negotiator: how the other manager sees your trade",
    stats: "Advanced stats: charts, snap shares, matchup details and the full next-week prediction",
  };
  const PRO_PERKS = ["Our own dynasty grades: a second verdict on every trade, Buy and Sell calls, and a read on your team", "Win now and Rebuilding views of every trade", "\"Make it fair\" suggestions", "Your own scoring: TE premium, QB bonuses and more",
    "Bigger trades: no limit on players and picks", "All your leagues in one app", "Best lineup and pickups for your team", "Value history charts and trade history", "Player values and Our score on every player",
    "Advanced stats: usage and snap charts, matchup details and the full next-week prediction", "The 8-bit retro look"];

  /** The upgrade sheet. reason: a REASONS key (a locked feature was tapped), "ended" (trial just ended), or nothing. */
  function paywallSheet(reason) {
    const s = Account.status();
    const intro = reason === "ended"
      ? `<p class="note">Your free trial is over, and you're now on <b>Basic</b>: trade checks, rankings, player cards and one league stay free. Subscribe to keep everything else.</p>`
      : REASONS[reason] ? `<p class="note"><b>${esc(REASONS[reason])}</b> ${/s$/.test(REASONS[reason]) ? "are" : "is"} part of Dynasty Mover Pro.</p>`
      : s.kind === "trial" ? `<p class="hint">Your free trial has ${esc(s.daysLeft)} ${s.daysLeft === 1 ? "day" : "days"} left. Subscribe now and nothing changes when it ends.</p>` : "";
    const body = openSheet(`<div class="sheet-head"><h2>Dynasty Mover Pro</h2><button class="close" onclick="closeSheet()" aria-label="Close">×</button></div>
      ${intro}<ul class="perks">${PRO_PERKS.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      ${paywallBody(s)}${reason === "ended" ? `<button class="btn ghost block" onclick="closeSheet()" style="margin-top:10px">Keep using Basic</button>` : ""}`);
    bindPaywall(body);
  }
  /** Pro edition, not subscribed: a feature is locked. Everywhere else everything is open. */
  const locked = () => ON && Account.ON && !Account.status().pro;

  // ---------------------------------------------------------------------------
  // The draft kit: a one-time purchase, apart from the subscription. The season's class and the draft helper.
  // ---------------------------------------------------------------------------
  const kitOf = year => (P.addons || []).find(a => a.year === year) || { id: `draft_kit_${year}`, year, label: `${year} draft kit`, fallback: "$10" };
  const kitLocked = year => ON && Account.ON && !Account.hasAddon(kitOf(year).id);
  function kitSheet(year) {
    const a = kitOf(year), price = Account.addonPrice(a.id) || a.fallback, pending = Account.addonPending(a.id);
    const body = openSheet(`<div class="sheet-head"><h2>${esc(a.label)}</h2><button class="close" onclick="closeSheet()" aria-label="Close">×</button></div>
      <p class="note">Everything for your ${year} rookie draft, in one purchase that is yours until the next class.</p>
      <ul class="perks"><li>The whole ${year} class, graded the way we grade NFL players, with the profile behind every grade</li>
        <li>The draft helper: the board adjusted to your league's format, your picks, where you're thin, who to take next and why, and who is likely to be there when you pick</li>
        <li>Marks for who is gone as the draft goes, and a Sleeper draft followed live</li>
        <li>Who goes around each of your picks, on the pick's card</li></ul>
      <section class="card">${Store.web ? `<p class="note">Bought in the Android app on Google Play, the kit carries over to this account here.</p>${otherWays(price, `the ${a.label}`)}<button class="link-btn" id="kitBuy" style="display:block;margin:10px auto 0">I've paid: check my account</button>` : `<button class="btn primary block big" id="kitBuy" ${pending ? "disabled" : ""}>${pending ? "Payment pending…" : `Unlock for ${esc(price)}`}</button>`}
        <div class="hint" style="margin-top:10px;text-align:center">One payment through Google Play. Not a subscription.</div>
        <button class="link-btn" id="kitRestore" style="display:block;margin:10px auto 0">Restore purchase</button></section>${legal()}`);
    $("#kitBuy", body).onclick = () => { if (Store.web) { toast("Checking your account…"); Account.refresh(true); } else Account.buy(a.id); };
    $("#kitRestore", body).onclick = () => { toast("Checking Google Play…"); Account.startBilling(); Account.refresh(true); };
  }
  /** The lock card a locked view shows in place of the goods. */
  const kitCard = (year, text) => { const a = kitOf(year); return `<section class="card kit-card"><div class="kicker">One-time purchase</div><h2>${esc(a.label)}</h2><p class="note">${text}</p>
    <button class="btn primary block" data-kit="${year}">Unlock for ${esc(Account.addonPrice(a.id) || a.fallback)}</button></section>`; };
  /** Call from a locked feature's tap: opens the upgrade sheet. */
  const lock = reason => paywallSheet(reason);
  const tag = () => `<span class="pro-tag">PRO</span>`;

  // ---------------------------------------------------------------------------
  // Other full screens
  // ---------------------------------------------------------------------------
  function updateScreen() {
    const beta = typeof Update !== "undefined" ? Update.link() : null;       // the beta's APK on the site, if version.json offers one; else Google Play
    gate(`${hero("Time to update", "A newer version of Dynasty Mover is ready. Update to keep using the app.")}
      <section class="card"><button class="btn primary block big" id="upGo">${beta ? "Get the update" : "Update in Google Play"}</button></section>`, "update");
    $("#upGo").onclick = () => Net.open(beta || ("https://play.google.com/store/apps/details?id=" + (Store.native && Native.packageName ? Native.packageName() : "com.dynastymover.app")));
    if (!beta && typeof Update !== "undefined") Update.check(true).then(() => { if (Update.link() && screen === "update") updateScreen(); }).catch(() => {});
  }
  function setupScreen() {
    gate(`${hero("Almost ready", "This Pro build isn't connected to Firebase yet.")}
      <section class="card"><p class="note">Paste your Firebase <b>apiKey</b> and <b>projectId</b> into
      <code>editions\\pro\\www\\js\\edition.js</code>, then build again. Step 2 of <code>store\\PRO-SETUP.md</code> shows where to find them.</p></section>`, "setup");
  }

  // ---------------------------------------------------------------------------
  // Trial banner, announcements, account card
  // ---------------------------------------------------------------------------
  function bar(s) {
    const el = $("#probar");
    if (!el) return;
    const c = Account.config, seen = (app().announceSeen || "");
    let h = "";
    if (c.announceText && c.announceId && c.announceId !== seen)
      h += `<div class="banner news"><span><b>${esc(c.announceTitle || "News")}</b> ${esc(c.announceText)}</span><button class="x" id="anX" aria-label="Dismiss">×</button></div>`;
    if (s.kind === "trial")
      h += `<div class="banner trial"><span>Free trial: <b>${esc(s.daysLeft)} ${s.daysLeft === 1 ? "day" : "days"} left</b></span><button class="btn sm primary" id="trialBuy">Subscribe</button></div>`;
    if (s.kind === "basic" && Date.now() > (app().basicSnooze || 0))
      h += `<div class="banner trial"><span>You're on <b>Basic</b>. Pro unlocks strategy views, your scoring and more.</span><button class="btn sm primary" id="trialBuy">Go Pro</button><button class="x" id="basicX" aria-label="Hide for now">×</button></div>`;
    el.innerHTML = h;
    el.classList.toggle("hidden", !h);
    if ($("#anX")) $("#anX").onclick = () => { saveApp({ announceSeen: c.announceId }); bar(s); };
    if ($("#trialBuy")) $("#trialBuy").onclick = () => paywallSheet();
    if ($("#basicX")) $("#basicX").onclick = () => { saveApp({ basicSnooze: Date.now() + 3 * 86400000 }); bar(s); };
  }

  function planText(s) {
    const b = Account.billing;
    if (s.kind === "paid") return b.autoRenew === false ? "Pro (ends at the end of this period)" : "Pro";
    if (s.kind === "owner") return "Owner (everything on)";
    if (s.kind === "comp") return s.until ? `Free access until ${new Date(s.until).toLocaleDateString()}` : "Free access";
    if (s.kind === "trial") return `Free trial, ${s.daysLeft} ${s.daysLeft === 1 ? "day" : "days"} left`;
    if (s.preview) return "Basic (preview)";
    if (s.kind === "offline") return "Pro (offline)";
    return "Basic (free)";
  }
  function accountCard() {
    if (!ON) return "";
    const s = Account.status();
    if (!s.email) return "";
    return `<section class="card" id="acct"><div class="kicker">Your account</div><h2 class="league-title acct-email">${esc(s.email)}</h2>
      <div class="kv" style="margin-top:8px"><span>Plan</span><b>${esc(planText(s))}</b></div>
      ${(P.addons || []).map(a => `<div class="kv"><span>${esc(a.label)}</span><b>${Account.hasAddon(a.id) ? "Yours" : Account.addonPending(a.id) ? "Payment pending" : `<a class="lnk" data-kit="${a.year}">Get it, ${esc(Account.addonPrice(a.id) || a.fallback)}</a>`}</b></div>`).join("")}
      <div class="btns">${s.kind === "paid" ? `<button class="btn ghost" id="acManage">Manage subscription</button>` : s.kind === "owner" ? "" : `<button class="btn primary" id="acBuy">Subscribe</button>`}
        <button class="btn ghost" id="acOut">Sign out</button></div>
      ${Account.isAdmin() ? `<label class="switch" style="margin-top:6px"><span class="txt">Preview Basic plan<small><br>Owner only. Shows the app the way free users see it, on this phone.</small></span>
        <input type="checkbox" id="acPreview" ${app().previewBasic ? "checked" : ""}><span class="track"></span></label>` : ""}
      <button class="link-btn danger" id="acDel" style="display:block;margin:12px auto 0">Delete my account</button></section>`;
  }
  function bindAccount() {
    const on = (id, fn) => { const x = $("#" + id); if (x) x.onclick = fn; };
    on("acBuy", () => paywallSheet());
    on("acManage", () => Account.manage());
    on("acOut", () => { Account.signOut(); toast("Signed out"); });
    on("acDel", deleteSheet);
    const pv = $("#acPreview");
    if (pv) pv.onchange = () => { saveApp({ previewBasic: pv.checked, basicNotice: true }); toast(pv.checked ? "Previewing the Basic plan" : "Back to your full plan"); decide(); };
  }
  function deleteSheet() {
    const body = openSheet(`<div class="sheet-head"><h2>Delete your account?</h2><button class="close" onclick="closeSheet()" aria-label="Close">×</button></div>
      <p class="note">This removes your account and your trial or subscription record. Your leagues stay on this phone.
      ${Account.billing.active ? "<b>Also cancel your subscription in Google Play</b>, or it keeps renewing." : ""}</p>
      <label class="lbl">Enter your password to confirm</label><input type="password" id="dPw" autocomplete="current-password">
      <div class="gate-err hidden" id="dErr"></div>
      <div class="btns">${Account.billing.active ? `<button class="btn ghost" id="dSub">Open Google Play</button>` : ""}<button class="btn danger" id="dGo">Delete account</button></div>`, { focus: "#dPw" });
    if ($("#dSub", body)) $("#dSub", body).onclick = () => Account.manage();
    $("#dGo", body).onclick = async () => {
      const b = $("#dGo", body), e = $("#dErr", body);
      b.disabled = true; busy = true;
      try { await Account.deleteAccount($("#dPw", body).value); busy = false; closeSheet(); toast("Your account was deleted."); decide(); }
      catch (x) { busy = false; b.disabled = false; e.textContent = x.message; e.classList.remove("hidden"); }
    };
  }

  return { ON: ON && typeof Account !== "undefined" && Account.ON, start, resume, accountCard, bindAccount, paywallSheet, gated, locked, lock, tag, kitLocked, kitSheet, kitCard };
})();
