/* Beta updates without a store. The app's site holds version.json: the newest build's version, a line of notes and the
   APK for each edition. The app reads it when it opens (at most every six hours) and when it comes back to the front;
   a newer version shows a banner with a Get it button that opens the APK link, and Android offers to install it over
   the copy already on the phone (same package, same signing key). People who installed by hand keep getting updates this
   way; a Play copy would update through Play instead. store/BETA.md has the steps for pushing a build. */
const Update = (() => {
  const URL = (typeof window !== "undefined" && window.UPDATE_URL) || "https://milliguns58.github.io/dynasty-mover-legal/version.json";
  const EVERY = 6 * 3600000;
  let info = null;
  const mine = () => (typeof Store !== "undefined" && Store.native && typeof Native !== "undefined" && Native.version ? Native.version() : null);
  function cmp(a, b) {                                             // "3.10" is newer than "3.9"
    const A = String(a || "").split(".").map(n => parseInt(n, 10) || 0), B = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(A.length, B.length); i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
    return 0;
  }
  async function check(force) {
    if (!mine()) return null;                                      // the desktop dev page has no version to compare
    const c = Store.get("update_check.json") || {};
    if (!force && c.at && Date.now() - new Date(c.at).getTime() < EVERY) { info = c.info || null; return info; }
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
    if (!available() || !link() || seen === info.versionName) { el.innerHTML = ""; el.classList.add("hidden"); return; }
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    el.innerHTML = `<div class="banner news"><span><b>Dynasty Mover ${esc(info.versionName)} is ready.</b> ${esc(info.notes || "Install it over this copy; your leagues stay.")}</span>
      <button class="btn sm primary" id="updGet">Get it</button><button class="x" id="updX" aria-label="Not now">×</button></div>`;
    el.classList.remove("hidden");
    document.getElementById("updGet").onclick = () => Net.open(link());
    document.getElementById("updX").onclick = () => { if (typeof saveApp === "function") saveApp({ updateSeen: info.versionName }); banner(); };
  }
  return { check, available, link, banner, cmp, info: () => info };
})();
if (typeof module !== "undefined") module.exports = Update;
