/* Accounts, free trial and subscription status for the Pro edition (window.EDITION === "pro").
   Talks to Firebase over its REST APIs (no SDK): Authentication for sign-in, Firestore for one document per user
   and one shared settings document. The rules in store/firestore.rules decide who may read and write what:
     users/{uid}   email, created (set by the server, so the trial can't be faked), lastSeen, appVersion, sub (what the
                   phone reports about its Google Play subscription), and fields only the admin sets: trialEnds, comp, note
     config/app    trialDays, minVersion, announceId/announceTitle/announceText; the admin page edits it
   Everyone signed in can use the app. Pro features need comp (free access from the admin), an active Google Play
   subscription, or the trial (created + trialDays, or the admin's trialEnds); everyone else is on Basic. Offline, the
   last Pro answer is trusted for up to 3 days. */
"use strict";

const Account = (() => {
  const ON = window.EDITION === "pro";
  const F = window.FIREBASE || {};
  const P = window.PRO || {};
  const configured = ON && !!F.apiKey && !/PASTE/.test(F.apiKey) && !!F.projectId && !/PASTE/.test(F.projectId);
  const AUTH = "https://identitytoolkit.googleapis.com/v1/accounts:";
  const DOCS = `https://firestore.googleapis.com/v1/projects/${F.projectId}/databases/(default)/documents`;
  const DAY = 86400000, OFFLINE_GRACE = 3 * DAY;

  let session = Store.get("account.json");                 // {uid, email, idToken, refreshToken, expires}
  let user = Store.get("account_user.json");               // the users/{uid} document, last read
  let config = Store.get("account_config.json") || {};     // config/app, last read
  let billing = Store.get("account_billing.json") || { ready: false, active: false };
  let lastOk = (Store.get("account_ok.json") || {}).at || 0;
  const listeners = [];

  // ---- Firestore values <-> plain objects ----
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "object") return { mapValue: { fields: encFields(v) } };
    return { stringValue: String(v) };
  }
  const encFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
  function dec(v) {
    if (!v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("integerValue" in v) return parseInt(v.integerValue, 10);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("stringValue" in v) return v.stringValue;
    if ("mapValue" in v) return decFields(v.mapValue.fields || {});
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
    return null;
  }
  const decFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

  // ---- HTTP ----
  const FRIENDLY = {
    EMAIL_EXISTS: "That email already has an account. Tap \"Sign in\" instead.",
    EMAIL_NOT_FOUND: "Wrong email or password.",
    INVALID_PASSWORD: "Wrong email or password.",
    INVALID_LOGIN_CREDENTIALS: "Wrong email or password.",
    INVALID_EMAIL: "That email address doesn't look right.",
    MISSING_PASSWORD: "Enter a password.",
    WEAK_PASSWORD: "Use a password of at least 6 characters.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many tries. Wait a few minutes and try again.",
    USER_DISABLED: "This account has been turned off. Contact support.",
    CREDENTIAL_TOO_OLD_LOGIN_AGAIN: "For your safety, enter your password again.",
    OPERATION_NOT_ALLOWED: "Email sign-in isn't turned on in Firebase yet (PRO-SETUP.md step 3).",
    CONFIGURATION_NOT_FOUND: "Sign-in isn't set up in Firebase yet (PRO-SETUP.md step 3).",
  };
  async function call(method, url, body, idToken) {
    const r = await Net.request(method, url, body, idToken ? { Authorization: "Bearer " + idToken } : null);
    let j = null;
    try { j = r.body ? JSON.parse(r.body) : {}; } catch (e) { j = null; }
    if (r.status >= 200 && r.status < 300) return j || {};
    const err = new Error(r.status === 0 ? "No internet connection." : "Something went wrong. Try again.");
    const code = j && j.error && (j.error.message || j.error.status);
    if (code) {
      const key = String(code).split(" ")[0].split(":")[0];
      err.code = key;
      if (FRIENDLY[key]) err.message = FRIENDLY[key];
      else if (/API key not valid|API_KEY_INVALID/i.test(code)) err.message = "The app's Firebase key is wrong (PRO-SETUP.md step 2).";
      else if (/Firestore API has not been used|SERVICE_DISABLED/i.test(code)) err.message = "The Firebase database isn't created yet (PRO-SETUP.md step 4).";
      else if (r.status === 403 || key === "PERMISSION_DENIED") err.message = "Not allowed. Check the Firestore rules (PRO-SETUP.md step 4).";
    }
    err.status = r.status;
    throw err;
  }

  function keep(r) {
    session = { uid: r.localId || r.user_id, email: r.email || (session && session.email), idToken: r.idToken || r.id_token,
      refreshToken: r.refreshToken || r.refresh_token, expires: Date.now() + (parseInt(r.expiresIn || r.expires_in || "3600", 10) - 120) * 1000 };
    Store.set("account.json", session);
  }

  /** A fresh sign-in token (Firebase tokens last an hour; the refresh token keeps you signed in). */
  async function token() {
    if (!session) throw new Error("Not signed in.");
    if (session.idToken && session.expires > Date.now()) return session.idToken;
    const r = await call("POST", "https://securetoken.googleapis.com/v1/token?key=" + F.apiKey,
      { grant_type: "refresh_token", refresh_token: session.refreshToken });
    keep(r);
    return session.idToken;
  }

  // ---- the user's document ----
  const docName = uid => `projects/${F.projectId}/databases/(default)/documents/users/${uid}`;
  const version = () => (Store.native && Native.version ? Native.version() : (window.APP_VERSION ? window.APP_VERSION + " web" : "dev"));   // the admin page's Version column

  async function createUser() {
    await call("POST", DOCS + ":commit", { writes: [{
      update: { name: docName(session.uid), fields: encFields({ email: session.email, appVersion: version() }) },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: "created", setToServerValue: "REQUEST_TIME" }, { fieldPath: "lastSeen", setToServerValue: "REQUEST_TIME" }],
    }] }, await token());
  }

  async function loadUser() {
    const t = await token();
    let d;
    try { d = await call("GET", `${DOCS}/users/${session.uid}`, null, t); }
    catch (e) {
      if (e.status !== 404) throw e;
      await createUser();
      d = await call("GET", `${DOCS}/users/${session.uid}`, null, t);
    }
    user = decFields(d.fields);
    Store.set("account_user.json", user);
  }

  async function loadConfig() {
    try {
      const d = await call("GET", `${DOCS}/config/app`, null, await token());
      config = decFields(d.fields);
    } catch (e) { if (e.status === 404) config = {}; else throw e; }
    Store.set("account_config.json", config);
  }

  /** Tell the server we were here (and what Google Play says about the subscription), at most every 6 hours. */
  async function touch(force) {
    const last = (Store.get("account_touch.json") || {}).at || 0;
    if (!force && Date.now() - last < 6 * 3600000) return;
    const sub = { active: !!billing.active, autoRenew: !!billing.autoRenew, orderId: billing.orderId || "", token: billing.token || "",
      addons: Object.keys(billing.addons || {}).filter(id => billing.addons[id] && billing.addons[id].owned), checked: new Date() };   // the one-time products owned
    await call("POST", DOCS + ":commit", { writes: [{
      update: { name: docName(session.uid), fields: encFields({ appVersion: version(), sub }) },
      updateMask: { fieldPaths: ["appVersion", "sub"] },
      currentDocument: { exists: true },
      updateTransforms: [{ fieldPath: "lastSeen", setToServerValue: "REQUEST_TIME" }],
    }] }, await token());
    Store.set("account_touch.json", { at: Date.now() });
  }

  // ---- sign-in ----
  async function afterSignIn() {
    await loadUser();
    await loadConfig().catch(() => {});
    await touch(true).catch(() => {});
    startBilling();
    changed();
  }
  async function signUp(email, password) {
    keep(await call("POST", AUTH + "signUp?key=" + F.apiKey, { email, password, returnSecureToken: true }));
    call("POST", AUTH + "sendOobCode?key=" + F.apiKey, { requestType: "VERIFY_EMAIL", idToken: session.idToken }).catch(() => {});
    await afterSignIn();
  }
  async function signIn(email, password) {
    keep(await call("POST", AUTH + "signInWithPassword?key=" + F.apiKey, { email, password, returnSecureToken: true }));
    await afterSignIn();
  }
  const resetPassword = email => call("POST", AUTH + "sendOobCode?key=" + F.apiKey, { requestType: "PASSWORD_RESET", email });
  function signOut() {
    session = null; user = null;
    ["account.json", "account_user.json", "account_ok.json", "account_touch.json"].forEach(n => Store.remove(n));
    lastOk = 0;
    changed();
  }
  /** Delete the account and its data (Google Play requires this in the app). Needs the password again. */
  async function deleteAccount(password) {
    await signIn(session.email, password);
    const t = await token();
    await call("DELETE", `${DOCS}/users/${session.uid}`, null, t).catch(() => {});
    await call("POST", AUTH + "delete?key=" + F.apiKey, { idToken: t });
    signOut();
  }

  /** Re-read everything from the server (on start, and when the app comes back after an hour). */
  let refreshing = null, lastRefresh = 0;
  /* Re-read config/app (the announcement, trial length, minimum version) when the app comes back to the front: one
     small read, at most once a minute, so an announcement published from the admin page shows within a minute instead
     of after the hourly refresh or the next cold start (2026-10-07). */
  let lastConfig = 0;
  async function refreshConfig(minAgeMs = 60000) {
    if (!session || Date.now() - lastConfig < minAgeMs) return;
    lastConfig = Date.now();
    try { await loadConfig(); changed(); } catch (e) { /* offline: keep the last copy */ }
  }
  function refresh(force) {
    if (!session) return Promise.resolve();
    if (!force && Date.now() - lastRefresh < 3600000) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { await loadUser(); await loadConfig(); lastRefresh = lastConfig = Date.now(); touch().catch(() => {}); }
      catch (e) { if (e.code === "USER_DISABLED" || e.code === "TOKEN_EXPIRED" || e.code === "USER_NOT_FOUND" || e.code === "INVALID_REFRESH_TOKEN") signOut(); }
      finally { refreshing = null; startBilling(); changed(); }
    })();
    return refreshing;
  }

  // ---- Google Play ----
  function startBilling() {
    if (!(Store.native && Native.billingStart)) return;
    if (Native.billingAddons) Native.billingAddons((P.addons || []).map(a => a.id).join(","));   // the one-time products to price and check
    Native.billingStart();
  }
  window.onBilling = s => {
    const was = billing.active;
    billing = Object.assign({}, s);
    Store.set("account_billing.json", { ready: s.ready, active: s.active, plans: s.plans, autoRenew: s.autoRenew, orderId: s.orderId, token: s.token, addons: s.addons || {}, addonPrices: s.addonPrices || {} });
    if (session && s.ready && (s.active !== was || s.justBought || s.justBoughtAddon)) touch(true).catch(() => {});
    changed(s);
  };
  function buy(planId) {
    if (!(Store.native && Native.billingBuy)) { changed({ error: Store.web ? "Pro is bought in the Android app on Google Play. Sign in there with this same account and your plan carries over here." : "Purchases work only in the copy installed from Google Play." }); return; }
    Native.billingBuy(planId, session ? session.uid : "");
  }
  function manage() {
    const pkg = Store.native && Native.packageName ? Native.packageName() : "com.dynastymover.app";
    Net.open(`https://play.google.com/store/account/subscriptions?sku=${encodeURIComponent(P.product || "")}&package=${encodeURIComponent(pkg)}`);
  }

  // ---- who gets in ----
  function trialEnd() {
    if (!user) return 0;
    if (user.trialEnds) return Date.parse(user.trialEnds);
    const days = parseInt(config.trialDays || P.trialDays || 7, 10);
    return user.created ? Date.parse(user.created) + days * DAY : Date.now() + days * DAY;
  }
  function status() {
    if (!ON) return { access: true, pro: true, kind: "free" };
    if (!configured) return { access: false, kind: "setup" };
    if (!session) return { access: false, kind: "signedout" };
    const now = Date.now();
    const compUntil = user && user.compUntil ? Date.parse(user.compUntil) : 0;
    let s;
    if (isAdmin() && (Store.get("app.json") || {}).previewBasic) return { access: true, pro: false, kind: "basic", preview: true, email: session.email };
    if (isAdmin()) s = { access: true, pro: true, kind: "owner" };                       // the owner's own sign-in: everything on, no trial clock
    else if (user && user.comp && (!compUntil || compUntil > now)) s = { access: true, pro: true, kind: "comp", until: compUntil || 0 };
    else if (billing.active) s = { access: true, pro: true, kind: "paid", autoRenew: !!billing.autoRenew };
    else {
      const end = trialEnd();
      if (end > now) s = { access: true, pro: true, kind: "trial", ends: end, daysLeft: Math.max(1, Math.ceil((end - now) / DAY)) };
      else s = { access: true, pro: false, kind: "basic", ends: end };
    }
    if (s.pro) { if (now - lastOk > 600000) Store.set("account_ok.json", { at: now }); lastOk = now; }
    else if (!navigator.onLine && now - lastOk < OFFLINE_GRACE) s = { access: true, pro: true, kind: "offline" };
    s.email = session.email;
    return s;
  }

  /** A one-time product (an add-on such as a season's draft kit): owned through Google Play, given by the admin
   *  (users/{uid}.kits), or the owner's own sign-in. The Basic preview switch hides it, like the rest of Pro. */
  function hasAddon(id) {
    if (!ON) return true;
    if (!configured || !session) return false;
    if (isAdmin()) return !(Store.get("app.json") || {}).previewBasic;
    if (user && user.kits && user.kits[id]) return true;
    const a = billing.addons && billing.addons[id];
    return !!(a && a.owned);
  }
  const addonPrice = id => (billing.addonPrices || {})[id] || ((P.addons || []).find(a => a.id === id) || {}).fallback || "";
  const addonPending = id => !!(billing.addons && billing.addons[id] && billing.addons[id].pending);

  /** The owner's own sign-in (window.PRO.admin): gets the "Preview Basic plan" switch. */
  function isAdmin() { return !!(session && P.admin && String(session.email || "").toLowerCase() === String(P.admin).toLowerCase()); }

  function needsUpdate() {
    const min = String(config.minVersion || "").trim();
    if (!min) return false;
    const a = version().split(".").map(n => parseInt(n, 10) || 0), b = min.split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); }
    return false;
  }

  function changed(extra) { listeners.forEach(fn => { try { fn(extra || {}); } catch (e) { console.error(e); } }); }

  return {
    ON, configured, isAdmin, signUp, signIn, signOut, resetPassword, deleteAccount, refresh, refreshConfig, buy, manage, status, needsUpdate, token,
    hasAddon, addonPrice, addonPending, startBilling,
    onChange: fn => listeners.push(fn),
    get email() { return session && session.email; },
    get config() { return config; },
    get billing() { return billing; },
    get user() { return user; },
    get trialDays() { return parseInt(config.trialDays || P.trialDays || 7, 10); },
  };
})();
