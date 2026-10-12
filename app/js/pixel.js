/* 8-bit player sprites for the Retro look, 24x24, drawn on a canvas and cached as images:
     face()   a Tecmo-style portrait: the player's skin tone, hair and facial hair (codes in faces-data.js), team jersey, number
     sprite() a helmet and jersey in the team's colours, for players without a face code (or when window.FACES_ON is false)
   No photos, logos or game graphics are used. Note: matching real players' appearance is using their likeness
   (store/SOURCES.md); edition.js turns the faces on or off with window.FACES_ON. */
"use strict";

const Pixel = (() => {
  // k outline, h shell, H shell highlight, s stripe, m facemask, v dark visor, j jersey, S sleeve stripe
  const HEAD = [
    "........kkkkkkkk........",
    "......kkHHHssHHHkk......",
    ".....kHHhhhsshhhhhk.....",
    "....khHhhhhsshhhhhhk....",
    "....khhhhhhsshhhhhhk....",
    "...khhhhhhhsshhhhhhhk...",
    "...khhhhhhhsshhhhhhhk...",
    "...khhhkkkkkkkkkkhhhk...",
    "...khhkvvvvvvvvvvkhhk...",
    "...khhkmmmmmmmmmmkhhk...",
    "...khhkvvmvvvvmvvkhhk...",
    "...khhkmmmmmmmmmmkhhk...",
    "...kkhkvvmvvvvmvvkhkk...",
    "....kkkkmmmmmmmmkkkk....",
    "......kkkkmmmmkkkk......",
    "....kkkjjjkkkkjjjkkk....",
    "..kkjjjjjjjjjjjjjjjjkk..",
    ".kjjjjjjjjjjjjjjjjjjjjk.",
    "kjSjjjjjjjjjjjjjjjjjjSjk",
    "kjSjjjjjjjjjjjjjjjjjjSjk",
    "kjjjjjjjjjjjjjjjjjjjjjjk",
    "kjjjjjjjjjjjjjjjjjjjjjjk",
    "kjjjjjjjjjjjjjjjjjjjjjjk",
    "kjjjjjjjjjjjjjjjjjjjjjjk",
  ];
  // 3x5 digits
  const DIG = {
    0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"], 2: ["111", "001", "111", "100", "111"],
    3: ["111", "001", "011", "001", "111"], 4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
    6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"], 8: ["111", "101", "111", "101", "111"],
    9: ["111", "101", "111", "001", "111"],
  };
  // face portrait: f skin, F skin shade, w/e eye, y brow, m mouth, h hair, b beard, j jersey, S/c stripe; overlays use _ for 'keep'
  const FACE = [
      "........................",
      "........................",
      "........................",
      ".......kkkkkkkkkk.......",
      "......kffffffffffk......",
      "......kffffffffffk......",
      "......kffffffffffk......",
      "......kffffffffffk......",
      "......kffyyffyyffk......",
      "....kFkfweffffewfkFk....",
      "....kFkffffffffffkFk....",
      "....kFkffffFFffffkFk....",
      ".....kkffffffffffkk.....",
      "......kffmffffmffk......",
      "......kfffmmmmfffk......",
      ".......kffffffffk.......",
      "........kkffffkk........",
      ".........kFFFFk.........",
      "...kkkjjjjcFFcjjjjkkk...",
      "..kjjjjjjjjccjjjjjjjjk..",
      ".kjjjjjjjjjjjjjjjjjjjjk.",
      "kjSjjjjjjjjjjjjjjjjjjSjk",
      "kjSjjjjjjjjjjjjjjjjjjSjk",
      "kjjjjjjjjjjjjjjjjjjjjjjk"
  ];
  const FACE_HAIR = {"1": {"2": ".......kkkkkkkkkk.......", "3": "......khhhhhhhhhhk......", "4": "......khhhhhhhhhhk......", "5": "______khffffffffhk______"}, "2": {"0": ".......kkkkkkkkkk.......", "1": "......khhhhhhhhhhk......", "2": ".....khhhhhhhhhhhhk.....", "3": ".....khhhhhhhhhhhhk.....", "4": ".....khhhhhhhhhhhhk.....", "5": "______khffffffffhk______"}, "3": {"1": "........kkkkkkkk........", "2": "......kkhhhhhhhhkk......", "3": ".....khhhhhhhhhhhhk.....", "4": "....khhhhhhhhhhhhhhk....", "5": "....khhhffffffffhhhk....", "6": "...khh____________hhk...", "7": "...khh____________hhk...", "8": "...khk____________khk...", "9": "...khh____________hhk...", "10": "...khh____________hhk...", "11": "...khk____________khk...", "12": "...khh____________hhk...", "13": "...khh____________hhk...", "14": "...khk____________khk...", "15": "...khh____________hhk...", "16": "...khh____________hhk...", "17": "...khk____________khk..."}};
  const FACE_BEARD = {"1": {"12": "__________bbbb__________", "15": "__________bbbb__________", "16": "__________bbbb__________"}, "2": {"11": "_______b________b_______", "12": "_______b__bbbb__b_______", "13": "_______bb______bb_______", "14": "_______bbb____bbb_______", "15": "________bbbbbbbb________", "16": "__________bbbb__________"}};
  const SKIN = ["#f8d4b4", "#eebc98", "#dca47c", "#c68a60", "#a8704a", "#8a5634", "#6c4026", "#4e2c1a"];
  const HAIR = ["#16100c", "#3a2414", "#6a4020", "#9a6a38", "#d8b050", "#a84818", "#9a9a9a"];
  // [shell/jersey, stripe] per team; "NONE" is a free agent
  const TEAM = {
    ARI: ["#97233F", "#FFFFFF"], ATL: ["#A71930", "#101820"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"], CAR: ["#0085CA", "#101820"],
    CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#101820"], CLE: ["#FF3C00", "#311D00"], DAL: ["#003594", "#B0B7BC"], DEN: ["#FB4F14", "#002244"],
    DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"], HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#FFFFFF"], JAX: ["#006778", "#D7A22A"],
    KC: ["#E31837", "#FFB81C"], LV: ["#2b2b2b", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFA300"], MIA: ["#008E97", "#FC4C02"],
    MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#C60C30"], NO: ["#9f8958", "#101820"], NYG: ["#0B2265", "#A71930"], NYJ: ["#125740", "#FFFFFF"],
    PHI: ["#004C54", "#A5ACAF"], PIT: ["#2b2b2b", "#FFB612"], SF: ["#AA0000", "#B3995D"], SEA: ["#002244", "#69BE28"], TB: ["#D50A0A", "#34302B"],
    TEN: ["#4B92DB", "#0C2340"], WAS: ["#5A1414", "#FFB612"], NONE: ["#6b7280", "#d1d5db"],
  };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => "#" + hex(a).map((c, i) => Math.round(c + (hex(b)[i] - c) * t).toString(16).padStart(2, "0")).join("");
  const light = h => { const [r, g, b] = hex(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62; };
  const cache = new Map();

  function sprite(team, number) {
    const key = `${team}|${number}`;
    if (cache.has(key)) return cache.get(key);
    const [base, stripe] = TEAM[team] || TEAM.NONE;
    const pal = { k: "#0a0a0a", h: base, H: mix(base, "#ffffff", 0.45), s: stripe, m: "#d8d8d8", v: "#1c1c24", j: base, S: stripe };
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const g = c.getContext("2d");
    HEAD.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
    const n = String(number ?? "").replace(/\D/g, "").slice(0, 2);
    if (n) {
      const ink = light(base) ? "#111111" : "#ffffff";
      const w = n.length * 4 - 1, x0 = Math.floor((24 - w) / 2), y0 = 18;
      [...n].forEach((d, i) => DIG[d].forEach((r, y) => [...r].forEach((b, x) => {
        if (b === "1") { g.fillStyle = ink; g.fillRect(x0 + i * 4 + x, y0 + y, 1, 1); }
      })));
    }
    const url = c.toDataURL("image/png");
    cache.set(key, url);
    return url;
  }

  function drawNumber(g, number, base, y0) {
    const n = String(number ?? "").replace(/\D/g, "").slice(0, 2);
    if (!n) return;
    const ink = light(base) ? "#111111" : "#ffffff";
    const w = n.length * 4 - 1, x0 = Math.floor((24 - w) / 2);
    [...n].forEach((d, i) => DIG[d].forEach((r, y) => [...r].forEach((b, x) => {
      if (b === "1") { g.fillStyle = ink; g.fillRect(x0 + i * 4 + x, y0 + y, 1, 1); }
    })));
  }

  /** code = 4 digits: skin 0-7, hair colour 0-6, style (0 bald, 1 short, 2 tall, 3 locs/long), beard (0 none, 1 goatee, 2 full) */
  function face(team, number, code) {
    const key = `F|${team}|${number}|${code}`;
    if (cache.has(key)) return cache.get(key);
    const [sk, hc, st, bd] = [...code].map(Number);
    const g0 = FACE.map(r => [...r]);
    for (const layer of [FACE_HAIR[st] || {}, FACE_BEARD[bd] || {}])
      for (const [y, row] of Object.entries(layer)) [...row].forEach((ch, x) => { if (ch !== "_") g0[y][x] = ch; });
    const [base, stripe] = TEAM[team] || TEAM.NONE;
    const skin = SKIN[sk] || SKIN[3], hair = HAIR[hc] || HAIR[0];
    const pal = { k: "#0a0a0a", f: skin, F: mix(skin, "#000000", 0.2), w: "#fcfcfc", e: "#101010", y: st ? hair : mix(skin, "#000000", 0.45),
      m: "#5a1a1a", h: hair, b: mix(hair, "#ffffff", 0.06), j: base, S: stripe, c: stripe };
    const c = document.createElement("canvas");
    c.width = c.height = 24;
    const g = c.getContext("2d");
    g0.forEach((row, y) => row.forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); } }));
    drawNumber(g, number, base, 19);
    const url = c.toDataURL("image/png");
    cache.set(key, url);
    return url;
  }

  /** The sprite for a player: his face when there is a code for him and faces are on, else the helmet. */
  function player(team, sid) {
    const code = window.FACES_ON !== false && window.FACES && window.FACES[String(sid)];
    const num = number(sid);
    return code ? face(team, num, code) : sprite(team, num);
  }

  /** Jersey number from the cached Sleeper player list (no download). */
  function number(sid) {
    const c = Store.get("sleeper_players.json");
    const p = c && c.players && c.players[String(sid)];
    return p && p.number != null ? p.number : "";
  }

  return { sprite, face, player, number, TEAM };
})();
