/* Beta updates without a store. The app's site holds version.json: the newest build's version, a line of notes and the
   APK for each edition. The app reads it when it opens (at most every six hours) and when it comes back to the front;
   a newer version shows a banner with a Get it button that opens the APK link, and Android offers to install it over
   the copy already on the phone (same package, same signing key). People who installed by hand keep getting updates this
   way; a Play copy would update through Play instead. store/BETA.md has the steps for pushing a build. */
const Update = (() => {
  const URL = (typeof window !== "undefined" && window.UPDATE_URL) || "https://milliguns58.github.io/dynasty-mover-legal/version.json";
  // the web version (2026-10-20, the user's ask): it checks every 30 minutes and when the tab comes back to the front,
  // and its banner reloads the page onto the new version instead of downloading an APK
  const web = () => typeof Store !== "undefined" && !!Store.web;
  const EVERY = () => (web() ? 30 * 60000 : 6 * 3600000);
  let info = null;
  const mine = () => (typeof Store !== "undefined" && Store.native && typeof Native !== "undefined" && Native.version ? Native.version()
    : web() && typeof window !== "undefined" && window.APP_VERSION ? window.APP_VERSION : null);
  function cmp(a, b) {                                             // "3.10" is newer than "3.9"
    const A = String(a || "").split(".").map(n => parseInt(n, 10) || 0), B = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    return 0;
  }
  async function check(force) {
    if (!mine()) return null;                                      // the desktop dev page has no version to compare
    const c = Store.get("update_check.json") || {};
    if (!force && c.at && Date.now() - new Date(c.at).getTime() < EVERY()) { info = c.info || null; return info; }
    try { const j = await Net.json(URL + (URL.includes("?") ? "&" : "?") + "t=" + Date.now()); info = j && j.versionName ? j : null; }
    catch (e) { info = c.info || null; }
    Store.set("update_check.json", { at: new Date().toISOString(), info });
    return info;
  }
  const available = () => { const v = mine(); return !!(info && v && cmp(info.versionName, v) > 0); };
  const edition = () => (typeof window !== "undefined" && window.EDITION) || "personal";
  const link = () => (info ? ((info.apk || {})[edition()] || info.url || null) : null);
  /* The banner, above the app's own bars. Dismissing it hides that version until a newer one appears. */
  function banner() {
    const el = document.getElementById("updbar");
    if (!el) return;
    const seen = (typeof app === "function" ? app().updateSeen : null) || "";
    if (!available() || (!web() && !link()) || seen === info.versionName) { el.innerHTML = ""; el.classList.add("hidden"); return; }
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    el.innerHTML = `<div class="banner news"><span><b>Dynasty Mover ${esc(info.versionName)} is ready.</b> ${esc(info.notes || (web() ? "Reload to get it; your leagues stay." : "Install it over this copy; your leagues stay."))}</span>
      <button class="btn sm primary" id="updGet">${web() ? "Reload" : "Get it"}</button><button class="x" id="updX" aria-label="Not now">×</button></div>`;
    el.classList.remove("hidden");
    document.getElementById("updGet").onclick = () => (web() ? reloadWeb() : Net.open(link()));
    document.getElementById("updX").onclick = () => { if (typeof saveApp === "function") saveApp({ updateSeen: info.versionName }); banner(); };
  }
  /* The web version onto the new build: the saved copy of the app's files is cleared and the page reloads from the site. */
  async function reloadWeb() {
    try { const r = navigator.serviceWorker && await navigator.serviceWorker.getRegistration(); if (r) await r.update(); } catch (e) { /* no worker */ }
    try { for (const k of await caches.keys()) if (k.startsWith("dynasty-mover-")) await caches.delete(k); } catch (e) { /* no caches */ }
    location.reload();
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (!document.hidden && web()) check().then(banner).catch(() => {}); });
  return { check, available, link, banner, cmp, info: () => info, reloadWeb };
})();
if (typeof module !== "undefined") module.exports = Update;
