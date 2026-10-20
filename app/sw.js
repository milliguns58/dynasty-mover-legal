/* The web version's service worker: the app's own files are kept so the page opens offline and installs to the
   home screen. Data (Sleeper, nflverse, the Worker, Firebase) is never cached here; the app keeps that in IndexedDB.
   The version is written in by tools/web/build_web.py; a new version replaces the old cache on the next open. */
const VERSION = "3.2.12.30";
const CACHE = "dynasty-mover-" + VERSION;
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon.png", "icon-512.png", "css/app.css", "css/retro.css",
  "js/edition.js", "js/store.js", "js/predict_params.js", "js/engine.js", "js/predict.js", "js/week.js", "js/score.js", "js/history.js", "js/draft.js",
  "js/faces-data.js", "js/pixel.js", "js/account.js", "js/pro.js", "js/update.js", "js/ui.js", "js/gm.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(f => c.add(f + (f.endsWith(".js") || f.endsWith(".css") ? "?v=" + VERSION : "")).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("dynasty-mover-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;       // data and other sites: straight through
  const mine = url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if (!mine) return;
  // the app's files: the network first (so a new build shows), the cache when offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || (url.pathname.endsWith("/") ? caches.match("./") : undefined))));
});
