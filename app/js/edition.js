/* Pro edition: the business version on Google Play. Same data rules as the free Play edition (store/SOURCES.md),
   plus an account (Firebase), a free trial and a Google Play subscription. Setup: store/PRO-SETUP.md. */
window.EDITION = "pro";

/* From Firebase console > Project settings > General > Your apps > Web app (step 2 of PRO-SETUP.md).
   These two values are not secret: every Firebase app ships them. The security rules protect the data. */
window.FIREBASE = {
  apiKey: "AIzaSyBj3hBLQ52y2txsqukLZsNpYVzP6arN_XM",
  projectId: "device-streaming-dab57064",
};

window.PRO = {
  trialDays: 7,                         // the admin page can change this for new sign-ups (App settings)
  product: "dynasty_mover_pro",         // Play Console subscription ID (must match Billing.java)
  plans: [                              // base plan IDs in Play Console; the prices shown come from Google Play
    { id: "yearly", label: "Yearly", fallback: "$19.99 a year", note: "Best value: 44% off monthly" },
    { id: "monthly", label: "Monthly", fallback: "$2.99 a month" },
  ],
  addons: [                             // one-time products in Play Console (Monetize > Products > In-app products); the prices shown come from Google Play
    { id: "draft_kit_2027", year: 2027, label: "2027 draft kit", fallback: "$10" },
  ],
  termsUrl: "https://milliguns58.github.io/dynasty-mover-legal/terms.html",
  // Other ways to pay, shown on the WEB version's paywall only (never inside the Play app: Google requires Play Billing
  // there). Fill in what you use; an empty one is left out, all empty hides the section. People send the amount with
  // their sign-in email in the note, and you switch them on from the admin page (Paid a month / Paid a year).
  pay: { cashapp: "", paypal: "", venmo: "" },           // e.g. cashapp: "$DynastyMover", paypal: "https://paypal.me/dynastymover", venmo: "@DynastyMover"
  admin: "markamilligan00@gmail.com",   // this sign-in gets a "Preview Basic plan" switch on the League tab (this phone only)
};

/* 8-bit player faces (js/pixel.js, js/faces-data.js). Faces that match real players' skin tone and hair, on their team and number, use their likeness (Keller v. Electronic Arts, 2013).
   Set to false before launch unless you accept that risk or have an NFLPA group license; players then show as team helmets. */
window.FACES_ON = false;

/* Player values: only our own (Dynasty Mover values, engine.js src_dmv), built from public stats, age and draft slot,
   so the paid app uses nobody else's value list. */
window.OWN_VALUES_ONLY = true;

/* Your GM (Pro): the chat that knows your league. The app sends the league brief and your question to your own
   Cloudflare Worker (gm/worker.js), which holds the Anthropic API key and checks the sign-in. Put the Worker's URL in
   url after deploying it (gm/README.md). Empty url: the GM tab is hidden on phones; the desktop dev server answers
   with a stand-in so the screen can be tried. dailyCap is the app's own count; the Worker enforces its own. */
window.GM_CFG = { url: "https://dynasty-mover-gm.dynastymover-app.workers.dev", dailyCap: 40 };

/* The web version (tools/web/build_web.py): files live in the browser's IndexedDB, sources that refuse a browser are
   fetched through the Worker's /proxy, there is no Play billing and no APK updater. */
window.WEB = true;
window.APP_VERSION = "3.2.22";
window.PROXY_URL = "https://dynasty-mover-gm.dynastymover-app.workers.dev/proxy";
