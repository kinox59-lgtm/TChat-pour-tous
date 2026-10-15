
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const SALT = process.env.SALT;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const MEDIA_ENABLED = process.env.MEDIA !== "off";

if (!SALT || SALT.length < 32) {
  console.error("ERREUR : configure SALT (au moins 32 caractères) dans Render.");
  process.exit(1);
}

const PUB = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "bans.json");
const FB_FILE = process.env.FEEDBACK_FILE || path.join(DATA_DIR, "avis.json");

const SALONS = [
  "Général",
  "18-25 ans",
  "26-40 ans",
  "Musique",
  "Jeux vidéo",
  "Détente",
  "Avis & idées"
];

const HIST_MAX = 40;
const MEDIA_MAX_TOTAL = 150 * 1024 * 1024;
const MEDIA_TTL = 30 * 60 * 1000;
const MAX_IMAGE = 700 * 1024;
const MAX_VIDEO = 3.2 * 1024 * 1024;

const DURATIONS = [15 * 60 * 1000, 30 * 60 * 1000, 24 * 60 * 60 * 1000];
const WINDOW = 2 * 60 * 1000;
const PERMA_REPORTERS = 3;
const MIN_SEEN = 20 * 1000;
const MAX_REPORTS_PER_MIN = 5;

const RESERVED = [
  "équipe", "equipe", "admin", "administrateur",
  "modérateur", "moderateur", "modo", "staff", "support"
];

const hist = Object.fromEntries(SALONS.map(s => [s, []]));

hist["Avis & idées"].push({
  t: "msg",
  s: "Avis & idées",
  n: "Équipe",
  x: "Bienvenue ! Dis-nous ici ce que tu aimes et ce qu'on peut améliorer.",
  ts: Date.now(),
  i: "",
  p: 0
});

const clients = new Map();
const avatars = new Map();
const media = new Map();
const recent = new Map();

let mediaBytes = 0;
let feedback = [];
let store = { strikes: {}, bans: {} };

try {
  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (parsed && parsed.strikes && parsed.bans) store = parsed;
} catch {}

try {
  const parsed = JSON.parse(fs.readFileSync(FB_FILE, "utf8"));
  if (Array.isArray(parsed)) feedback = parsed;
} catch {}

function saveJSON(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  } catch (err) {
    console.error("Impossible d'enregistrer", path.basename(file), err.message);
  }
}

function saveBans() {
  saveJSON(DATA_FILE, store);
}

function saveFeedback() {
  saveJSON(FB_FILE, feedback);
}

function clean(value, max = 300) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

function send(ws, data) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

function keyOf(req) {
  // Sur Render, n'utilise l'en-tête proxy que parce que le serveur
  // est placé derrière le proxy de la plateforme.
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  const ip = forwarded.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  return crypto
    .createHash("sha256")
    .update(SALT + ip)
    .digest("hex")
    .slice(0, 24);
}

function banLeft(key) {
  const ban = store.bans[key];
  if (ban === -1) return Infinity;
  return ban && ban > Date.now() ? ban - Date.now() : 0;
}

function human(ms) {
  if (ms === Infinity) return "définitivement";
  const minutes = Math.ceil(ms / 60000);
  if (minutes >= 1440) return Math.ceil(minutes / 1440) + " jour(s)";
  if (minutes >= 60) return Math.ceil(minutes / 60) + " heure(s)";
  return minutes + " minute(s)";
}

function uniqueName(name) {
  const taken = new Set([...clients.values()].map(c => c.n.toLowerCase()));
  let result = name;
  let suffix = 2;

  while (taken.has(result.toLowerCase())) {
    result = name.slice(0, 12) + "_" + suffix++;
  }

  return result;
}

function toSalon(salon, data) {
  for (const [ws, client] of clients) {
    if (client.s === salon) send(ws, data);
  }
}

function sys(salon, text) {
  toSalon(salon, { t: "sys", s: salon, x: text });
}

let onlineTimer = null;

function pushOnline() {
  if (onlineTimer) return;

  onlineTimer = setTimeout(() => {
    onlineTimer = null;

    const list = [...clients.values()].slice(0, 300).map(c => ({
      n: c.n,
      a: c.a,
      sx: c.sx,
      v: c.v,
      i: c.id,
      p: c.av,
      s: c.s,
      r: c.r,
      d: c.d,
      c: c.c,
      o: c.o
    }));

    for (const ws of clients.keys()) {
      send(ws, { t: "online", list });
      send(ws, { t: "online_count", count: clients.size });
    }
  }, 80);
}

function removeClient(ws, announce = true) {
  const c = clients.get(ws);
  if (!c) return;

  clients.delete(ws);
  avatars.delete(c.id);

  for (const [id, file] of media) {
    if (file.owner === c.id) deleteMedia(id);
  }

  if (announce) sys(c.s, c.n + " a quitté le tchat");
  pushOnline();
}

function deleteMedia(id) {
  const file = media.get(id);
  if (!file) return;

  mediaBytes -= file.buf.length;
  media.delete(id);
}

function addMedia(buf, type, owner) {
  if (!buf.length || buf.length > MEDIA_MAX_TOTAL) return null;

  while (mediaBytes + buf.length > MEDIA_MAX_TOTAL && media.size) {
    deleteMedia(media.keys().next().value);
  }

  if (mediaBytes + buf.length > MEDIA_MAX_TOTAL) return null;

  const id = crypto.randomBytes(16).toString("hex");
  media.set(id, { buf, type, at: Date.now(), owner });
  mediaBytes += buf.length;
  return id;
}

function kick(key, reason) {
  for (const [ws, c] of [...clients]) {
    if (c.key !== key) continue;

    send(ws, { t: "banned", x: reason });
    removeClient(ws, false);
    ws.close(1008, "Banned");
  }
}

function sanction(key, name, reporterKey) {
  const now = Date.now();
  let record = recent.get(key);

  if (!record || now - record.at > WINDOW) {
    record = {
      name,
      at: now,
      reporters: new Set(),
      banned: false,
      perma: false
    };
    recent.set(key, record);
  }

  record.reporters.add(reporterKey);

  if (record.reporters.size >= PERMA_REPORTERS && !record.perma) {
    record.perma = true;
    store.bans[key] = -1;
    saveBans();

    kick(key, "Bannissement définitif après plusieurs signalements.");
    return "perma";
  }

  if (!record.banned) {
    record.banned = true;

    const strikes = (store.strikes[key] || 0) + 1;
    store.strikes[key] = strikes;

    const duration = strikes <= DURATIONS.length
      ? DURATIONS[strikes - 1]
      : Infinity;

    store.bans[key] = duration === Infinity ? -1 : now + duration;
    saveBans();

    kick(
      key,
      "Tu as été banni(e) " +
        (duration === Infinity ? "définitivement" : "pour " + human(duration)) +
        " suite à un signalement."
    );

    return "ban";
  }

  return "already";
}

function parseDataURL(data, allowedTypes) {
  if (typeof data !== "string" || data.length > 4_500_000) return null;

  const match = /^data:(image\/jpeg|video\/mp4|video\/webm);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
  if (!match || !allowedTypes.includes(match[1])) return null;

  const buf = Buffer.from(match[2], "base64");
  if (!buf.length) return null;

  // Vérifie aussi que la chaîne base64 est valide.
  if (buf.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    return null;
  }

  return { type: match[1], buf };
}

const STATIC = {};

for (const [url, file, type] of [
  ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
  ["/icon-192.png", "icon-192.png", "image/png"],
  ["/icon-512.png", "icon-512.png", "image/png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"]
]) {
  try {
    STATIC[url] = {
      buf: fs.readFileSync(path.join(PUB, file)),
      type
    };
  } catch {}
}

let page;

try {
  page = fs.readFileSync(path.join(PUB, "index.html"));
} catch {
  console.error("index.html introuvable dans", PUB);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }

  if (STATIC[pathname]) {
    const item = STATIC[pathname];
    res.writeHead(200, {
      "Content-Type": item.type,
      "Cache-Control": "public, max-age=86400"
    });
    return res.end(item.buf);
  }

  if (pathname === "/avis") {
    const key = url.searchParams.get("key") || "";
    const a = Buffer.from(key);
    const b = Buffer.from(ADMIN_KEY);

    const authorized =
      ADMIN_KEY.length > 0 &&
      a.length === b.length &&
      crypto.timingSafeEqual(a, b);

    if (!authorized) {
      res.writeHead(404);
      return res.end();
    }

    const rows = feedback.slice().reverse().map(f =>
      "<div style='border-bottom:1px solid #ccc;padding:8px 0'>" +
      "<b>" + escapeHTML(f.k) + "</b> · " +
      escapeHTML(f.n) + " · <small>" +
      escapeHTML(new Date(f.ts).toLocaleString("fr-FR")) +
      "</small><br>" + escapeHTML(f.x) + "</div>"
    ).join("");

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store"
    });

    return res.end(
      "<meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<body style='font:15px system-ui;max-width:700px;margin:20px auto;padding:0 12px'>" +
      "<h2>Avis des visiteurs (" + feedback.length + ")</h2>" +
      (rows || "<p>Aucun avis pour l'instant.</p>")
    );
  }

  const mediaMatch = /^\/media\/([a-f0-9]{32})$/.exec(pathname);

  if (mediaMatch) {
    const file = media.get(mediaMatch[1]);
    if (!file) {
      res.writeHead(404);
      return res.end();
    }

    const total = file.buf.length;
    const headers = {
      "Content-Type": file.type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'"
    };

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");

    if (range && (range[1] || range[2])) {
      let start;
      let end;

      if (range[1] === "") {
        const suffixLength = Number(range[2]);
        start = Math.max(0, total - suffixLength);
        end = total - 1;
      } else {
        start = Number(range[1]);
        end = range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
      }

      if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= total) {
        res.writeHead(416, { "Content-Range": "bytes */" + total });
        return res.end();
      }

      res.writeHead(206, {
        ...headers,
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Content-Length": end - start + 1
      });

      return res.end(file.buf.subarray(start, end + 1));
    }

    res.writeHead(200, { ...headers, "Content-Length": total });
    return res.end(file.buf);
  }

  const avatarMatch = /^\/avatar\/([a-f0-9]{12})$/.exec(pathname);

  if (avatarMatch) {
    const buf = avatars.get(avatarMatch[1]);

    if (!buf) {
      res.writeHead(404);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'"
    });

    return res.end(buf);
  }

  if (pathname !== "/" && pathname !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Introuvable");
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(page);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4_500_000
});

wss.on("connection", (ws, req) => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });

  const key = keyOf(req);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;

    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: "err", x: "Message invalide." });
    }

    if (!m || typeof m.t !== "string") return;

    const c = clients.get(ws);

    if (m.t === "join" && !c) {
      const remaining = banLeft(key);

      if (remaining) {
        return send(ws, {
          t: "err",
          x: "Tu es banni(e) " +
            (remaining === Infinity ? "définitivement." : "encore " + human(remaining) + ".")
        });
      }

      const age = Number.parseInt(m.a, 10);
      if (!(age >= 18 && age <= 99)) {
        return send(ws, { t: "err", x: "Réservé aux 18 ans et plus." });
      }

      const name = clean(m.n, 16);
      if (!name) return send(ws, { t: "err", x: "Pseudo invalide." });

      if (RESERVED.includes(name.toLowerCase())) {
        return send(ws, { t: "err", x: "Ce pseudo est réservé." });
      }

      const me = {
        n: uniqueName(name),
        a: age,
        sx: ["H", "F", "T", "Autre"].includes(m.sx) ? m.sx : "",
        v: clean(m.v, 20),
        r: clean(m.r, 30),
        d: /^(2[AB]|\d{2,3}|XX)$/.test(String(m.d)) ? String(m.d) : "",
        c: ["H", "F", "HF", "T"].includes(m.c) ? m.c : "",
        o: ["hetero", "homo", "bi", "autre"].includes(m.o) ? m.o : "",
        sentTo: new Set(),
        mst: [],
        fbs: [],
        s: SALONS[0],
        key,
        stamps: [],
        reps: [],
        avst: [],
        since: Date.now(),
        id: crypto.randomBytes(6).toString("hex"),
        av: 0
      };

      clients.set(ws, me);

      send(ws, {
        t: "init",
        i: me.id,
        n: me.n,
        salons: SALONS,
        s: me.s,
        hist: hist[me.s]
      });

      sys(me.s, me.n + " est entré(e) dans le salon");
      pushOnline();
      return;
    }

    if (!c) return;

    if (m.t === "salon" && SALONS.includes(m.s) && m.s !== c.s) {
      const oldSalon = c.s;
      c.s = m.s;

      sys(oldSalon, c.n + " a quitté le salon");
      send(ws, { t: "salon", s: c.s, hist: hist[c.s] });
      sys(c.s, c.n + " est entré(e) dans le salon");
      pushOnline();
      return;
    }

    if (m.t === "msg" || m.t === "img") {
      const x = clean(m.x, 1000);
      if (!x) return;

      const now = Date.now();
      c.stamps = c.stamps.filter(t => now - t < 5000);

      if (c.stamps.length >= 5) {
        return send(ws, { t: "sys", s: c.s, x: "Doucement, tu écris trop vite !" });
      }

      c.stamps.push(now);

      const msg = {
        t: m.t,
        s: c.s,
        n: c.n,
        x,
        ts: now,
        i: c.id,
        p: c.av
      };

      hist[c.s].push(msg);
      if (hist[c.s].length > HIST_MAX) hist[c.s].shift();

      toSalon(c.s, msg);
      return;
    }

    if (m.t === "avatar") {
      const now = Date.now();
      c.avst = c.avst.filter(t => now - t < 60000);

      if (c.avst.length >= 3) {
        return send(ws, {
          t: "sys",
          s: c.s,
          x: "Trop de changements de photo, patiente un instant."
        });
      }

      c.avst.push(now);

      if (!m.d) {
        avatars.delete(c.id);
        c.av++;
        pushOnline();
        return;
      }

      if (typeof m.d !== "string" || m.d.length > 45000 ||
          !m.d.startsWith("data:image/jpeg;base64,")) {
        return send(ws, { t: "sys", s: c.s, x: "Photo refusée (format ou taille)." });
      }

      const encoded = m.d.slice("data:image/jpeg;base64,".length);

      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return send(ws, { t: "sys", s: c.s, x: "Photo refusée." });
      }

      const buf = Buffer.from(encoded, "base64");

      if (
        buf.length < 200 ||
        buf.length > 32000 ||
        buf[0] !== 0xff ||
        buf[1] !== 0xd8 ||
        buf[2] !== 0xff ||
        buf[buf.length - 2] !== 0xff ||
        buf[buf.length - 1] !== 0xd9
      ) {
        return send(ws, { t: "sys", s: c.s, x: "Photo JPEG invalide." });
      }

      avatars.set(c.id, buf);
      c.av++;
      pushOnline();
      return;
    }

    if (m.t === "feedback") {
      const now = Date.now();

      c.fbs = c.fbs.filter(t => now - t < 10 * 60 * 1000);

      if (c.fbs.length >= 3) {
        return send(ws, {
          t: "fberr",
          x: "Tu as déjà envoyé plusieurs avis. Réessaie plus tard."
        });
      }

      const x = String(m.x == null ? "" : m.x)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, 500);

      if (x.length < 5) {
        return send(ws, { t: "fberr", x: "Ton message est trop court." });
      }

      const category = ["Idée", "Problème", "Compliment"].includes(m.k) ? m.k : "Idée";

      c.fbs.push(now);
      feedback.push({ ts: now, n: c.n, k: category, x });

      if (feedback.length > 500) feedback.shift();
      saveFeedback();

      return send(ws, { t: "fbok" });
    }

    // Médias privés : ce bloc doit rester distinct du bloc msg/img.
    if (m.t === "media") {
      const fail = text => send(ws, { t: "pmerr", to: m.to, x: text });

      if (!MEDIA_ENABLED) return fail("Les photos et vidéos sont désactivées.");

      const recipient = clean(m.to, 16).toLowerCase();
      let dest = null;

      for (const [destWs, user] of clients) {
        if (user.n.toLowerCase() === recipient) {
          dest = [destWs, user];
          break;
        }
      }

      if (!dest) return fail(clean(m.to, 16) + " n'est plus connecté(e).");
      if (dest[1] === c) return;

      if (!dest[1].sentTo.has(c.id)) {
        return fail("La personne doit d'abord t'avoir écrit.");
      }

      const now = Date.now();
      c.mst = c.mst.filter(t => now - t < 60000);

      if (c.mst.length >= 5) return fail("Trop d'envois d'affilée.");

      // Le client doit envoyer m.d sous forme data URL.
      const parsed = parseDataURL(m.d || m.x, [
        "image/jpeg",
        "video/mp4",
        "video/webm"
      ]);

      if (!parsed) {
        return fail("Format refusé : JPEG, MP4 ou WebM uniquement.");
      }

      const { buf, type } = parsed;
      const isJpg =
        buf.length >= 3 &&
        buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

      const isMp4 =
        buf.length > 12 &&
        buf.toString("latin1", 4, 8) === "ftyp";

      const isWebm =
        buf.length > 4 &&
        buf[0] === 0x1a && buf[1] === 0x45 &&
        buf[2] === 0xdf && buf[3] === 0xa3;

      const valid =
        (type === "image/jpeg" && isJpg && buf.length <= MAX_IMAGE) ||
        (type === "video/mp4" && isMp4 && buf.length <= MAX_VIDEO) ||
        (type === "video/webm" && isWebm && buf.length <= MAX_VIDEO);

      if (!valid) return fail("Fichier refusé (format ou taille).");

      const id = addMedia(buf, type, c.id);
      if (!id) return fail("Stockage des médias temporairement saturé.");

      c.mst.push(now);

      const privateMessage = {
        t: "pm",
        from: c.n,
        to: dest[1].n,
        x: "",
        ts: now,
        fid: c.id,
        fp: c.av,
        media: { id, k: type === "image/jpeg" ? "img" : "vid" }
      };

      send(dest[0], privateMessage);
      send(ws, privateMessage);
      return;
    }

    if (m.t === "pm") {
      const x = clean(m.x, 300);
      const recipient = clean(m.to, 16).toLowerCase();

      if (!x || !recipient || recipient === c.n.toLowerCase()) return;

      const now = Date.now();
      c.stamps = c.stamps.filter(t => now - t < 5000);

      if (c.stamps.length >= 5) {
        return send(ws, {
          t: "pmerr",
          to: m.to,
          x: "Doucement, tu écris trop vite !"
        });
      }

      let dest = null;

      for (const [destWs, user] of clients) {
        if (user.n.toLowerCase() === recipient) {
          dest = [destWs, user];
          break;
        }
      }

      if (!dest) {
        return send(ws, {
          t: "pmerr",
          to: m.to,
          x: clean(m.to, 16) + " n'est plus connecté(e)."
        });
      }

      c.stamps.push(now);
      c.sentTo.add(dest[1].id);

      const privateMessage = {
        t: "pm",
        from: c.n,
        to: dest[1].n,
        x,
        ts: now,
        fid: c.id,
        fp: c.av
      };

      send(dest[0], privateMessage);
      send(ws, privateMessage);
      return;
    }

    if (m.t === "report") {
      const say = x => send(ws, { t: "sys", s: c.s, x });
      const now = Date.now();

      if (now - c.since < MIN_SEEN) {
        return say("Patiente quelques secondes avant de pouvoir signaler.");
      }

      c.reps = c.reps.filter(t => now - t < 60000);

      if (c.reps.length >= MAX_REPORTS_PER_MIN) {
        return say("Trop de signalements d'affilée, patiente un instant.");
      }

      const name = clean(m.n, 16).toLowerCase();
      let targetKey = null;
      let targetName = "";

      for (const user of clients.values()) {
        if (user.n.toLowerCase() === name) {
          targetKey = user.key;
          targetName = user.n;
          break;
        }
      }

      if (!targetKey) {
        for (const [storedKey, record] of recent) {
          if (now - record.at <= WINDOW && record.name.toLowerCase() === name) {
            targetKey = storedKey;
            targetName = record.name;
            break;
          }
        }
      }

      if (!targetKey) return say("Utilisateur introuvable.");
      if (targetKey === c.key) return say("Tu ne peux pas te signaler toi-même.");

      c.reps.push(now);

      const result = sanction(targetKey, targetName, c.key);

      say(result === "already"
        ? "Cette personne a déjà été sanctionnée. Merci !"
        : "Signalement pris en compte. Merci !");
      return;
    }

    // L'administration est vérifiée côté serveur.
    // ADMIN_KEY doit être défini dans les variables Render.
    if (m.t === "admin_ban") {
      if (!ADMIN_KEY) {
        return send(ws, { t: "err", x: "Administration non configurée." });
      }

      const suppliedKey = String(m.key || m.pwd || "");
      const supplied = Buffer.from(suppliedKey);
      const expected = Buffer.from(ADMIN_KEY);

      const authorized =
        supplied.length === expected.length &&
        crypto.timingSafeEqual(supplied, expected);

      if (!authorized) {
        return send(ws, { t: "err", x: "Accès administrateur refusé." });
      }

      const targetName = clean(m.n || m.to, 16).toLowerCase();
      let target = null;

      for (const [targetWs, user] of clients) {
        if (user.n.toLowerCase() === targetName) {
          target = [targetWs, user];
          break;
        }
      }

      if (!target) {
        return send(ws, { t: "err", x: "Utilisateur introuvable." });
      }

      const durationMinutes = Number(m.minutes);
      const duration = Number.isFinite(durationMinutes)
        ? Math.min(Math.max(durationMinutes, 1), 525600) * 60000
        : DURATIONS[0];

      store.bans[target[1].key] = Date.now() + duration;
      saveBans();

      send(target[0], {
        t: "banned",
        x: "Tu as été banni(e) par la modération pour " + human(duration) + "."
      });

      removeClient(target[0], false);
      target[0].close(1008, "Moderation");

      sys(c.s, "Une sanction de modération a été appliquée.");
      return;
    }
  });

  ws.on("close", () => removeClient(ws));
  ws.on("error", () => removeClient(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }

    ws.alive = false;
    ws.ping();
  }

  const now = Date.now();

  for (const [key, record] of recent) {
    if (now - record.at > WINDOW) recent.delete(key);
  }

  for (const [id, file] of media) {
    if (now - file.at > MEDIA_TTL) deleteMedia(id);
  }
}, 30000);

server.on("close", () => clearInterval(heartbeat));

server.listen(PORT, "0.0.0.0", () => {
  console.log("Coco Tchat écoute sur le port " + PORT);
});
