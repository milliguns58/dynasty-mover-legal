/* Storage and network for the app.
   On the phone, window.Native (MainActivity.Bridge) fetches any URL without CORS limits and keeps
   files in the app's private storage. In a desktop browser, dev_server.py offers the same two things
   at /proxy and /store, so the app can be tested on the PC unchanged. The web version (window.WEB, the
   page iPhone users add to their home screen) keeps files in the browser's IndexedDB and fetches
   straight from the sources that allow a browser, the rest through the Worker's /proxy. */
"use strict";

const Store = (() => {
  const mem = new Map();                    // parsed JSON cache; files are read once per session
  const hasNative = typeof window.Native !== "undefined";
  const web = !hasNative && !!window.WEB;
  const dev = !hasNative && !web && /^https?:$/.test(location.protocol);

  /* The web version: every file is read into memory once before the app starts (the engine reads files
     synchronously), then each write goes to memory at once and to IndexedDB in order behind it. */
  const raw = new Map();                    // name -> text, the web version's copy of IndexedDB
  let db = null, queue = Promise.resolve(), idbOk = false;
  const DB = "dynasty-mover", OS = "files";
  function openDb() {
    return new Promise((res, rej) => {
      if (typeof indexedDB === "undefined") return rej(new Error("no IndexedDB"));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(OS);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("IndexedDB failed"));
      r.onblocked = () => rej(new Error("IndexedDB blocked"));
    });
  }
  function preload() {
    return openDb().then(d => new Promise((res, rej) => {
      db = d; idbOk = true;
      const tx = d.transaction(OS, "readonly"), st = tx.objectStore(OS), req = st.openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { raw.set(String(c.key), String(c.value)); c.continue(); } else res(); };
      req.onerror = () => rej(req.error);
    })).catch(() => {                        // no IndexedDB (a private window, an old browser): localStorage holds what fits
      idbOk = false;
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("dta:")) raw.set(k.slice(4), localStorage.getItem(k)); } } catch (e) { /* none */ }
    });
  }
  function idb(fn) {                        // one write after another, so a save never lands before an earlier one
    if (!idbOk) return;
    queue = queue.then(() => new Promise(res => { try { const tx = db.transaction(OS, "readwrite"); fn(tx.objectStore(OS)); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; } catch (e) { res(); } }));
  }
  const ready = web ? preload().then(() => { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ } }) : Promise.resolve();

  function rawLoad(name) {
    if (hasNative) return Native.load(name);
    if (web) return raw.has(name) ? raw.get(name) : null;
    if (dev) {
      const x = new XMLHttpRequest();       // synchronous on purpose: the engine reads files synchronously
      x.open("GET", "/store/" + encodeURIComponent(name), false);
      x.send();
      return x.status === 200 ? x.responseText : null;
    }
    try { return localStorage.getItem("dta:" + name); } catch (e) { return null; }
  }

  function rawSave(name, text) {
    if (hasNative) return Native.save(name, text);
    if (web) {
      raw.set(name, text);
      if (idbOk) idb(st => st.put(text, name));
      else { try { localStorage.setItem("dta:" + name, text); } catch (e) { return false; } }
      return true;
    }
    if (dev) {
      const x = new XMLHttpRequest();
      x.open("PUT", "/store/" + encodeURIComponent(name), false);
      x.send(text);
      return x.status === 200;
    }
    try { localStorage.setItem("dta:" + name, text); return true; } catch (e) { return false; }
  }

  return {
    native: hasNative,
    web,
    ready,                                   // the web version waits for this before the app's scripts run
    get(name, fallback = null) {
      if (mem.has(name)) { const v = mem.get(name); return v === null ? fallback : v; }
      const t = rawLoad(name);
      let v = null;
      if (t) { try { v = JSON.parse(t); } catch (e) { v = null; } }
      mem.set(name, v);                     // misses are remembered too, so a missing file is not re-read on every call
      return v === null ? fallback : v;
    },
    set(name, obj) {
      mem.set(name, obj);
      return rawSave(name, JSON.stringify(obj));
    },
    remove(name) {
      mem.delete(name);
      if (hasNative) return Native.remove(name);
      if (web) { raw.delete(name); if (idbOk) idb(st => st.delete(name)); else { try { localStorage.removeItem("dta:" + name); } catch (e) { /* none */ } } return; }
      if (dev) { const x = new XMLHttpRequest(); x.open("DELETE", "/store/" + encodeURIComponent(name), false); x.send(); return; }
      try { localStorage.removeItem("dta:" + name); } catch (e) { /* private mode */ }
    },
    list() {
      if (hasNative) return JSON.parse(Native.list() || "[]");
      if (web) return [...raw.keys()];
      if (dev) { const x = new XMLHttpRequest(); x.open("GET", "/store/", false); x.send(); return x.status === 200 ? JSON.parse(x.responseText) : []; }
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("dta:")) out.push(k.slice(4)); } } catch (e) { /* none */ }
      return out;
    },
    forget(name) { mem.delete(name); },
  };
})();

const Net = (() => {
  let seq = 0;
  const waiting = new Map();
  window.__nativeDone = (id, status) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    const body = Native.take(id);
    if (w.raw) return w.raw({ status, body });
    if (status >= 200 && status < 300) w.resolve(body);
    else w.reject(new Error(status ? `HTTP ${status}` : String(body || "network error").replace(/^java\.\w+(\.\w+)*:\s*/, "")));
  };

  /* The web version: sources that refuse a browser (GitHub's release downloads, where the nflverse stats live) go
     through the Worker's /proxy; everything else is fetched straight. A straight fetch that fails the way a refused
     one does (a TypeError, no status) is tried once more through the proxy. */
  const PROXY_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "news.google.com", "api.myfantasyleague.com"];
  const proxy = url => (window.PROXY_URL ? window.PROXY_URL + (window.PROXY_URL.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(url) : null);
  function webText(url) {
    let host = ""; try { host = new URL(url).hostname; } catch (e) { /* relative */ }
    const via = PROXY_HOSTS.includes(host) ? proxy(url) : null;
    const get = u => fetch(u).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
    if (via) return get(via);
    return get(url).catch(e => { const p = proxy(url); if (p && e instanceof TypeError) return get(p); throw e; });
  }

  /* The same URL asked for again while it is still downloading shares that download (2026-10-22: an open read the
     league, rosters and trending lists twice); requests with headers go on their own. */
  const inflight = new Map();
  function text(url, headers, timeoutMs = 180000) {
    if (headers && Object.keys(headers).length) return text1(url, headers, timeoutMs);
    if (inflight.has(url)) return inflight.get(url);
    const p = text1(url, headers, timeoutMs).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }
  function text1(url, headers, timeoutMs = 180000) {
    if (Store.native) {
      return new Promise((resolve, reject) => {
        const id = "r" + (++seq);
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error("timed out")); }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        Native.fetch(id, url, JSON.stringify(headers || {}));
      });
    }
    if (Store.web) return webText(url);
    const target = /^https?:$/.test(location.protocol) ? "/proxy?url=" + encodeURIComponent(url) : url;
    return fetch(target).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); });
  }

  /* Any method with a JSON body; resolves {status, body} whatever the status (the account code reads the errors). */
  function request(method, url, body, headers) {
    const h = Object.assign({ "Content-Type": "application/json" }, headers || {});
    const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    if (Store.native && Native.request) {
      return new Promise(resolve => {
        const id = "q" + (++seq);
        const timer = setTimeout(() => { waiting.delete(id); resolve({ status: 0, body: "timed out" }); }, 60000);
        waiting.set(id, { raw: resolve, timer });
        Native.request(id, method, url, JSON.stringify(h), data);
      });
    }
    return fetch(url, { method, headers: h, body: data }).then(async r => ({ status: r.status, body: await r.text() }),
      e => ({ status: 0, body: String(e) }));
  }

  return {
    text,
    request,
    json: (url, headers, timeoutMs) => text(url, headers, timeoutMs).then(t => JSON.parse(t)),
    open(url) { if (Store.native) Native.openUrl(url); else window.open(url, "_blank"); },
  };
})();
