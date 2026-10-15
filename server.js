// Coco Tchat – serveur Node.js (HTTP + WebSocket). Aucune inscription.
// Inclut le signalement avec bannissements progressifs.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const SALT = process.env.SALT || "change-moi-dans-les-variables-d-environnement";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "bans.json");

const MEDIA = process.env.MEDIA !== "off"; // MEDIA=off désactive photos/vidéos
const MEDIA_MAX_TOTAL = 150e6, MEDIA_TTL = 30 * 60e3;
const SALONS = ["Général", "18-25 ans", "26-40 ans", "Musique", "Jeux vidéo", "Détente", "Avis & idées"];
const HIST_MAX = 40;

// --- Règles de sanction ---------------------------------------------------
const DURATIONS = [15 * 60e3, 30 * 60e3, 24 * 3600e3]; // 1er, 2e, 3e signalement
const WINDOW = 2 * 60e3;       // fenêtre « en même temps »
const PERMA_REPORTERS = 3;     // 3 personnes différentes dans la fenêtre => à vie
const MIN_SEEN = 20e3;         // il faut être connecté 20 s pour signaler
const MAX_REPORTS_PER_MIN = 5; // par personne

const hist = Object.fromEntries(SALONS.map((s) => [s, []]));
hist["Avis & idées"].push({ t: "msg", s: "Avis & idées", n: "Équipe", x: "Bienvenue ! Dis-nous ici ce que tu aimes et ce qu'on peut améliorer. Tu peux aussi utiliser « 💡 Donner mon avis » dans la barre de gauche pour nous envoyer une idée directement.", ts: Date.now(), i: "", p: 0 });
const RESERVED = ["équipe", "equipe", "admin", "administrateur", "modérateur", "moderateur", "modo", "staff", "support"];
// --- Avis des visiteurs (consultables sur /avis?key=ADMIN_KEY) ---
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const FB_FILE = process.env.FEEDBACK_FILE || path.join(__dirname, "avis.json");
let feedback = [];
try { feedback = JSON.parse(fs.readFileSync(FB_FILE, "utf8")); } catch {}
const saveFb = () => { try { fs.writeFileSync(FB_FILE, JSON.stringify(feedback)); } catch {} };
const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const clients = new Map(); // ws -> {n,a,sx,v,s,key,stamps,since,reps}
const avatars = new Map(); // id -> Buffer JPEG
const media = new Map();   // id -> {buf,type,at,owner} (en mémoire, effacé après 30 min)
let mediaBytes = 0;
const mediaDel = (id) => { const f = media.get(id); if (f) { mediaBytes -= f.buf.length; media.delete(id); } };
const mediaAdd = (buf, type, owner) => {
  while (mediaBytes + buf.length > MEDIA_MAX_TOTAL && media.size) mediaDel(media.keys().next().value);
  const id = crypto.randomBytes(16).toString("hex");
  media.set(id, { buf, type, at: Date.now(), owner }); mediaBytes += buf.length; return id;
};
const recent = new Map();  // key -> {name, at, reporters:Set, banned, perma}

// --- Bannissements persistants (clé = empreinte de l'IP, pas l'IP brute) ---
let store = { strikes: {}, bans: {} };
try { store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch {} };

const keyOf = (req) => {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  return crypto.createHash("sha256").update(SALT + ip).digest("hex").slice(0, 24);
};
const banLeft = (key) => {
  const b = store.bans[key];
  if (b === -1) return Infinity;
  return b && b > Date.now() ? b - Date.now() : 0;
};
const human = (ms) => {
  if (ms === Infinity) return "définitivement";
  const m = Math.ceil(ms / 60e3);
  if (m >= 60 * 24) return Math.ceil(m / 60 / 24) + " jour(s)";
  if (m >= 60) return Math.ceil(m / 60) + " heure(s)";
  return m + " minute(s)";
};

// --- Outils ---------------------------------------------------------------
const PUB = fs.existsSync(path.join(__dirname, "public")) ? path.join(__dirname, "public") : __dirname;
const STATIC = {};
for (const [u, f, ty] of [["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"], ["/icon-192.png", "icon-192.png", "image/png"], ["/icon-512.png", "icon-512.png", "image/png"], ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"]]) {
  try { STATIC[u] = { buf: fs.readFileSync(path.join(PUB, f)), type: ty }; } catch {}
}
const page = fs.readFileSync(path.join(PUB, "index.html"));
const server = http.createServer((req, res) => {
  const st = STATIC[(req.url || "").split("?")[0]];
  if (st) { res.writeHead(200, { "Content-Type": st.type, "Cache-Control": "public, max-age=86400" }); return res.end(st.buf); }
  if ((req.url || "").split("?")[0] === "/avis") {
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    const okKey = ADMIN_KEY && key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
    if (!okKey) { res.writeHead(404); return res.end(); }
    const rows = feedback.slice().reverse().map((f) => "<div style='border-bottom:1px solid #ccc;padding:8px 0'><b>" + esc(f.k) + "</b> · " + esc(f.n) + " · <small>" + esc(new Date(f.ts).toLocaleString("fr-FR")) + "</small><br>" + esc(f.x) + "</div>").join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Cache-Control": "no-store" });
    return res.end("<meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font:15px system-ui;max-width:700px;margin:20px auto;padding:0 12px'><h2>Avis des visiteurs (" + feedback.length + ")</h2>" + (rows || "<p>Aucun avis pour l'instant.</p>"));
  }
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  const mm = /^\/media\/([a-f0-9]{32})$/.exec((req.url || "").split("?")[0]);
  if (mm) {
    const f = media.get(mm[1]);
    if (!f) { res.writeHead(404); return res.end(); }
    const total = f.buf.length;
    const hdr = { "Content-Type": f.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && (r[1] || r[2])) {
      const a = r[1] === "" ? total - parseInt(r[2], 10) : parseInt(r[1], 10);
      const b = r[1] === "" || r[2] === "" ? total - 1 : Math.min(parseInt(r[2], 10), total - 1);
      if (!(a >= 0) || a > b) { res.writeHead(416, { "Content-Range": "bytes */" + total }); return res.end(); }
      res.writeHead(206, Object.assign({}, hdr, { "Content-Range": "bytes " + a + "-" + b + "/" + total, "Content-Length": b - a + 1 }));
      return res.end(f.buf.subarray(a, b + 1));
    }
    res.writeHead(200, Object.assign({}, hdr, { "Content-Length": total }));
    return res.end(f.buf);
  }
  const am = /^\/avatar\/([a-f0-9]{12})(\?.*)?$/.exec(req.url || "");
  if (am) {
    const buf = avatars.get(am[1]);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
    return res.end(buf);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
});
const wss = new WebSocketServer({ server, maxPayload: 5000000 });
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const toSalon = (s, o) => { for (const [ws, c] of clients) if (c.s === s) send(ws, o); };
let ot = null;
const pushOnline = () => {
  if (ot) return;
  ot = setTimeout(() => {
    ot = null;
    const list = [...clients.values()].slice(0, 300).map((c) => ({ n: c.n, a: c.a, sx: c.sx, v: c.v, i: c.id, p: c.av, s: c.s, r: c.r, d: c.d, c: c.c, o: c.o }));
    for (const w of clients.keys()) send(w, { t: "online", list });
  }, 80);
};
const pushUsers = () => pushOnline();
const sys = (s, x) => toSalon(s, { t: "sys", s, x });

function uniqueName(n) {
  const taken = new Set([...clients.values()].map((c) => c.n.toLowerCase()));
  let name = n, i = 2;
  while (taken.has(name.toLowerCase())) name = n.slice(0, 13) + "_" + i++;
  return name;
}

// --- Sanction -------------------------------------------------------------
function kick(key, text) {
  for (const [ws, c] of [...clients]) {
    if (c.key !== key) continue;
    c.banned = true;
    avatars.delete(c.id);
    for (const [mid, f] of media) if (f.owner === c.id) mediaDel(mid);
    send(ws, { t: "banned", x: text });
    clients.delete(ws);
    sys(c.s, c.n + " a été banni(e) suite à un signalement");
    pushUsers(c.s);
    ws.close();
  }
}

function sanction(key, name, reporterKey) {
  const now = Date.now();
  let r = recent.get(key);
  if (!r || now - r.at > WINDOW) { r = { name, at: now, reporters: new Set(), banned: false, perma: false }; recent.set(key, r); }
  r.reporters.add(reporterKey);

  if (r.reporters.size >= PERMA_REPORTERS && !r.perma) {
    r.perma = true;
    store.bans[key] = -1;
    save();
    kick(key, "Tu as été banni(e) définitivement suite à plusieurs signalements simultanés.");
    return "perma";
  }
  if (!r.banned) {
    r.banned = true;
    const strikes = (store.strikes[key] || 0) + 1;
    store.strikes[key] = strikes;
    const dur = strikes <= DURATIONS.length ? DURATIONS[strikes - 1] : Infinity;
    store.bans[key] = dur === Infinity ? -1 : now + dur;
    save();
    kick(key, "Tu as été banni(e) " + (dur === Infinity ? "définitivement" : "pour " + human(dur)) + " suite à un signalement.");
    return "ban";
  }
  return "already";
}

// --- WebSocket ------------------------------------------------------------
wss.on("connection", (ws, req) => {
  ws.alive = true;
  ws.on("pong", () => (ws.alive = true));
  const key = keyOf(req);

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw);} catch { return; }

    if (!m || (m.t !== "avatar" && m.t !== "media" && raw.length > 2048)) return;
    const c = clients.get(ws);

    if (m.t === "join" && !c) {
      const left = banLeft(key);
      if (left) return send(ws, { t: "err", x: "Tu es banni(e) " + (left === Infinity ? "définitivement." : "encore " + human(left) + ".") });
      const a = parseInt(m.a, 10);
      if (!(a >= 18 && a <= 99)) return send(ws, { t: "err", x: "Réservé aux 18 ans et plus." });
      const n = clean(m.n, 16);
      if (!n) return send(ws, { t: "err", x: "Pseudo invalide." });
      if (RESERVED.includes(n.toLowerCase())) return send(ws, { t: "err", x: "Ce pseudo est réservé." });
      const me = { n: uniqueName(n), a, sx: ["H", "F", "T", "Autre"].includes(m.sx) ? m.sx : "", v: clean(m.v, 20), r: clean(m.r, 30), d: /^(2[AB]|\d{2,3}|XX)$/.test(String(m.d)) ? String(m.d) : "", c: ["H", "F", "HF", "T"].includes(m.c) ? m.c : "", o: ["hetero", "homo", "bi", "autre"].includes(m.o) ? m.o : "", sentTo: new Set(), mst: [], fbs: [], s: SALONS[0], key, stamps: [], reps: [], avst: [], since: Date.now(), id: crypto.randomBytes(6).toString("hex"), av: 0 };
      clients.set(ws, me);
      send(ws, { t: "init", i: me.id, n: me.n, salons: SALONS, s: me.s, hist: hist[me.s] });
      sys(me.s, me.n + " est entré(e) dans le salon");
      pushUsers(me.s);
      wss.clients.forEach(client => {
        if (client.readyState === 1) send(client, { t: "online_count", count: clients.size });
      });
      return;
    }
    if (!c) return;

    if (m.t === "salon" && SALONS.includes(m.s) && m.s !== c.s) {
      const old = c.s;
      c.s = m.s;
      sys(old, c.n + " a quitté le salon"); pushUsers(old);
      send(ws, { t: "salon", s: c.s, hist: hist[c.s] });
      sys(c.s, c.n + " est entré(e) dans le salon"); pushUsers(c.s);
      return;
    }

    if (m.t === "msg" || m.t === "img" || m.t === "media") {
      const x = String(m.x || "").trim();
      if (!x) return;
      const now = Date.now();
      c.stamps = c.stamps.filter((t) => now - t < 5000);
      if (c.stamps.length >= 5) return send(ws, { t: "sys", s: c.s, x: "Doucement, tu écris trop vite !" });
      c.stamps.push(now);
      const msg = { t: m.t, s: c.s, n: c.n, x, ts: now, i: c.id, p: c.av };
      hist[c.s].push(msg);
      if (hist[c.s].length > HIST_MAX) hist[c.s].shift();
      toSalon(c.s, msg);
      return;
    }

    if (m.t === "avatar") {
      const now = Date.now();
      c.avst = c.avst.filter((t) => now - t < 60e3);
      if (c.avst.length >= 3) return send(ws, { t: "sys", s: c.s, x: "Trop de changements de photo, patiente un instant." });
      c.avst.push(now);
      if (!m.d) { avatars.delete(c.id); c.av++; pushUsers(c.s); return; }
      const pre = "data:image/jpeg;base64,";
      const d = String(m.d);
      if (!d.startsWith(pre) || d.length > 45000) return send(ws, { t: "sys", s: c.s, x: "Photo refusée (format ou taille)." });
      const b64 = d.slice(pre.length);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return send(ws, { t: "sys", s: c.s, x: "Photo refusée." });
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 200 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return send(ws, { t: "sys", s: c.s, x: "Photo refusée (JPEG invalide)." });
      avatars.set(c.id, buf);
      c.av++;
      pushUsers(c.s);
      return;
    }

    if (m.t === "feedback") {
      const now = Date.now();
      c.fbs = c.fbs.filter((t) => now - t < 10 * 60e3);
      if (c.fbs.length >= 3) return send(ws, { t: "fberr", x: "Tu as déjà envoyé plusieurs avis, merci ! Réessaie dans quelques minutes." });
      const x = String(m.x == null ? "" : m.x).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 500);
      if (x.length < 5) return send(ws, { t: "fberr", x: "Ton message est trop court." });
      const k = ["Idée", "Problème", "Compliment"].includes(m.k) ? m.k : "Idée";
      c.fbs.push(now);
      feedback.push({ ts: now, n: c.n, k, x });
      if (feedback.length > 500) feedback.shift();
      saveFb();
      return send(ws, { t: "fbok" });
    }

    if (m.t === "media") {
      const say = (x) => send(ws, { t: "pmerr", to: m.to, x });
      if (!MEDIA) return say("Les photos et vidéos sont désactivées sur ce tchat.");
      const to = clean(m.to, 16).toLowerCase();
      let dest = null;
      for (const [dws, o] of clients) if (o.n.toLowerCase() === to) { dest = [dws, o]; break; }
      if (!dest) return say(clean(m.to, 16) + " n'est plus connecté(e).");
      if (dest[1] === c) return;
      if (!dest[1].sentTo.has(c.id)) return say("Pour envoyer une photo ou une vidéo, la personne doit d'abord t'avoir écrit.");
      const now = Date.now();
      c.mst = c.mst.filter((t) => now - t < 60e3);
      if (c.mst.length >= 5) return say("Trop d'envois d'affilée, patiente un instant.");
      const head = String(m.d || "").slice(0, 40);
      const mt = /^data:(image\/jpeg|video\/mp4|video\/webm);base64,/.exec(head);
      if (!mt) return say("Format non accepté (photo JPEG, vidéo MP4 ou WebM).");
      const buf = Buffer.from(String(m.d).slice(mt[0].length), "base64");
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const isMp4 = buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp";
      const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      let k = null;
      if (mt[1] === "image/jpeg" && isJpg && buf.length <= 700e3) k = "img";
      else if ((mt[1] === "video/mp4" && isMp4 || mt[1] === "video/webm" && isWebm) && buf.length <= 3.2e6) k = "vid";
      if (!k) return say("Fichier refusé (format ou taille).");
      c.mst.push(now);
      const id = mediaAdd(buf, mt[1], c.id);
      const pm = { t: "pm", from: c.n, to: dest[1].n, x: "", ts: now, fid: c.id, fp: c.av, media: { id, k } };
      send(dest[0], pm);
      send(ws, pm);
      return;
    }

    if (m.t === "pm") {
      const x = clean(m.x, 300);
      const to = clean(m.to, 16).toLowerCase();
      if (!x || !to) return;
      if (to === c.n.toLowerCase()) return;
      const now = Date.now();
      c.stamps = c.stamps.filter((t) => now - t < 5000);
      if (c.stamps.length >= 5) return send(ws, { t: "pmerr", to: m.to, x: "Doucement, tu écris trop vite !" });
      let dest = null;
      for (const [dws, o] of clients) if (o.n.toLowerCase() === to) { dest = [dws, o]; break; }
      if (!dest) return send(ws, { t: "pmerr", to: m.to, x: clean(m.to, 16) + " n'est plus connecté(e)." });
      c.stamps.push(now);
      c.sentTo.add(dest[1].id);
      const pm = { t: "pm", from: c.n, to: dest[1].n, x, ts: now, fid: c.id, fp: c.av };
      send(dest[0], pm);
      send(ws, pm);
      return;
    }

    if (m.t === "report") {
      const say = (x) => send(ws, { t: "sys", s: c.s, x });
      const now = Date.now();
      if (now - c.since < MIN_SEEN) return say("Patiente quelques secondes avant de pouvoir signaler.");
      c.reps = c.reps.filter((t) => now - t < 60e3);
      if (c.reps.length >= MAX_REPORTS_PER_MIN) return say("Trop de signalements d'affilée, patiente un instant.");

      const name = clean(m.n, 16).toLowerCase();
      let tKey = null, tName = "";
      for (const o of clients.values()) if (o.n.toLowerCase() === name) { tKey = o.key; tName = o.n; break; }
      if (!tKey) for (const [k, r] of recent) if (now - r.at <= WINDOW && r.name.toLowerCase() === name) { tKey = k; tName = r.name; break; }
      if (!tKey) return say("Utilisateur introuvable.");
      if (tKey === c.key) return say("Tu ne peux pas te signaler toi-même.");

      c.reps.push(now);
      const res = sanction(tKey, tName, c.key);
      say(res === "already" ? "Cette personne a déjà été sanctionnée. Merci !" : "Signalement pris en compte, la personne a été sanctionnée. Merci !");
    }
  });

  ws.on("close", () => {
    const c = clients.get(ws);
    if (!c) return;
    clients.delete(ws);
    avatars.delete(c.id);
    sys(c.s, c.n + " a quitté le tchat");
    pushUsers(c.s);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  const now = Date.now();
  for (const [k, r] of recent) if (now - r.at > WINDOW) recent.delete(k);
  for (const [id, f] of media) if (now - f.at > MEDIA_TTL) mediaDel(id);
}, 30000);

server.listen(PORT, () => console.log("Coco Tchat sur http://localhost:" + PORT));
