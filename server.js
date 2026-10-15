"use strict";

// Coco Tchat — serveur Node.js pour Render
// Installation : npm install
// Démarrage : npm start

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const SALT = process.env.SALT || crypto.randomBytes(32).toString("hex");
const DATA_DIR = process.env.DATA_DIR || __dirname;
const BAN_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "bans.json");
const FEEDBACK_FILE =
  process.env.FEEDBACK_FILE || path.join(DATA_DIR, "avis.json");

const MAX_PAYLOAD = 5 * 1024 * 1024;
const MAX_MEDIA_TOTAL = 150 * 1024 * 1024;
const MEDIA_TTL = 30 * 60 * 1000;
const HISTORY_LIMIT = 40;
const REPORT_WINDOW = 2 * 60 * 1000;
const MIN_REPORT_TIME = 20 * 1000;
const MAX_REPORTS_PER_MINUTE = 5;

const SALONS = [
  "Général",
  "18-25 ans",
  "26-40 ans",
  "Musique",
  "Jeux vidéo",
  "Détente",
  "Avis & idées"
];

const RESERVED = [
  "équipe", "equipe", "admin", "administrateur",
  "modérateur", "moderateur", "modo", "staff", "support"
];

const PUB = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const histories = Object.fromEntries(
  SALONS.map((name) => [name, []])
);

histories["Avis & idées"].push({
  t: "msg",
  s: "Avis & idées",
  n: "Équipe",
  x: "Bienvenue ! Tu peux partager tes idées pour améliorer Coco Tchat.",
  ts: Date.now(),
  i: "",
  p: 0
});

const clients = new Map();
const avatars = new Map();
const mediaFiles = new Map();
const recentReports = new Map();

let mediaBytes = 0;
let onlineTimer = null;

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;

  try {
    const params = new URLSearchParams();
    params.append("secret", TURNSTILE_SECRET_KEY);
    params.append("response", token);
    if (ip) params.append("remoteip", ip);

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: params
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error("Erreur de vérification Turnstile :", error.message);
    return false;
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (error) {
    console.error("Impossible d'enregistrer", path.basename(file), error.message);
  }
}

let store = readJSON(BAN_FILE, { strikes: {}, bans: {} });
if (!store || typeof store !== "object") store = { strikes: {}, bans: {} };
if (!store.strikes) store.strikes = {};
if (!store.bans) store.bans = {};

let feedback = readJSON(FEEDBACK_FILE, []);
if (!Array.isArray(feedback)) feedback = [];

const saveBans = () => saveJSON(BAN_FILE, store);
const saveFeedback = () => saveJSON(FEEDBACK_FILE, feedback);

function clean(value, maxLength = 500) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastSalon(salon, data) {
  for (const [ws, client] of clients) {
    if (client.s === salon) send(ws, data);
  }
}

function systemMessage(salon, message) {
  broadcastSalon(salon, {
    t: "sys",
    s: salon,
    x: clean(message, 300),
    ts: Date.now()
  });
}

function pushOnline() {
  if (onlineTimer) return;

  onlineTimer = setTimeout(() => {
    onlineTimer = null;

    const list = [...clients.values()]
      .slice(0, 300)
      .map((c) => ({
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

function uniqueName(name) {
  const used = new Set(
    [...clients.values()].map((c) => c.n.toLocaleLowerCase("fr"))
  );

  let result = name;
  let index = 2;

  while (used.has(result.toLocaleLowerCase("fr"))) {
    result = name.slice(0, 12) + "_" + index++;
  }

  return result;
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  const ip = forwarded || req.socket.remoteAddress || "unknown";

  return crypto
    .createHash("sha256")
    .update(SALT + ":" + ip)
    .digest("hex")
    .slice(0, 32);
}

function banRemaining(key) {
  const ban = store.bans[key];

  if (ban === -1) return Infinity;
  if (typeof ban !== "number" || ban <= Date.now()) return 0;

  return ban - Date.now();
}

function humanDuration(ms) {
  if (ms === Infinity) return "définitivement";

  const minutes = Math.ceil(ms / 60000);
  if (minutes >= 1440) return Math.ceil(minutes / 1440) + " jour(s)";
  if (minutes >= 60) return Math.ceil(minutes / 60) + " heure(s)";

  return minutes + " minute(s)";
}

function removeClientMedia(clientId) {
  for (const [id, file] of mediaFiles) {
    if (file.owner === clientId) deleteMedia(id);
  }
}

function deleteMedia(id) {
  const file = mediaFiles.get(id);
  if (!file) return;

  mediaBytes -= file.buf.length;
  mediaFiles.delete(id);
}

function addMedia(buffer, type, owner) {
  if (buffer.length > MAX_MEDIA_TOTAL) {
    throw new Error("Fichier trop volumineux.");
  }

  while (mediaBytes + buffer.length > MAX_MEDIA_TOTAL && mediaFiles.size) {
    deleteMedia(mediaFiles.keys().next().value);
  }

  if (mediaBytes + buffer.length > MAX_MEDIA_TOTAL) {
    throw new Error("Espace média temporairement indisponible.");
  }

  const id = crypto.randomBytes(16).toString("hex");

  mediaFiles.set(id, {
    buf: buffer,
    type,
    at: Date.now(),
    owner
  });

  mediaBytes += buffer.length;
  return id;
}

function parseDataURL(value) {
  if (typeof value !== "string") {
    throw new Error("Fichier invalide.");
  }

  const match = /^data:(image\/jpeg|image\/png|image\/webp|video\/mp4|video\/webm);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);

  if (!match) {
    throw new Error("Format de fichier non accepté.");
  }

  const buffer = Buffer.from(match[2], "base64");

  if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
    throw new Error("Fichier trop volumineux (4 Mo maximum).");
  }

  return { buffer, type: match[1] };
}

function mimeExtension(type) {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm"
  })[type] || "bin";
}

function removeClient(ws) {
  const client = clients.get(ws);
  if (!client) return;

  clients.delete(ws);
  avatars.delete(client.id);
  removeClientMedia(client.id);

  systemMessage(client.s, client.n + " a quitté le salon.");
  pushOnline();
}

function disconnectBanned(key, message) {
  for (const [ws, client] of [...clients]) {
    if (client.key !== key) continue;

    send(ws, { t: "banned", x: message });
    clients.delete(ws);
    avatars.delete(client.id);
    removeClientMedia(client.id);

    try {
      ws.close(1008, "Accès suspendu");
    } catch {}
  }

  pushOnline();
}

function applySanction(key, name, reporterKey) {
  if (!store.strikes[key]) store.strikes[key] = 0;

  store.strikes[key] += 1;

  const strikes = store.strikes[key];
  let duration;
  let message;

  if (strikes === 1) {
    duration = 15 * 60 * 1000;
    message = "Suspension de 15 minutes après signalement.";
  } else if (strikes === 2) {
    duration = 30 * 60 * 1000;
    message = "Suspension de 30 minutes après signalement.";
  } else {
    duration = 24 * 60 * 60 * 1000;
    message = "Suspension de 24 heures après signalement.";
  }

  store.bans[key] = Date.now() + duration;
  saveBans();

  disconnectBanned(key, message);
  console.log("Sanction appliquée à", clean(name, 30), "niveau", strikes);
}

function validSalon(name) {
  return SALONS.includes(name);
}

function addHistory(salon, message) {
  const history = histories[salon];
  if (!history) return;

  history.push(message);
  if (history.length > HISTORY_LIMIT) history.shift();
}

function isAdminMessage(message) {
  return ADMIN_KEY.length > 0 &&
    typeof message.adminKey === "string" &&
    message.adminKey.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(
      Buffer.from(message.adminKey),
      Buffer.from(ADMIN_KEY)
    );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    });
    return res.end("ok");
  }

  if (pathname === "/media/" + pathname.split("/").pop()) {
    const match = /^\/media\/([a-f0-9]{32})$/.exec(pathname);

    if (match) {
      const file = mediaFiles.get(match[1]);

      if (!file || Date.now() - file.at > MEDIA_TTL) {
        if (file) deleteMedia(match[1]);
        res.writeHead(404);
        return res.end("Fichier introuvable");
      }

      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": file.buf.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'inline; filename="media.' + mimeExtension(file.type) + '"'
      });

      return res.end(file.buf);
    }
  }

  const avatarMatch = /^\/avatar\/([a-f0-9]{12})$/.exec(pathname);

  if (avatarMatch) {
    const avatar = avatars.get(avatarMatch[1]);

    if (!avatar) {
      res.writeHead(404);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": avatar.length,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    });

    return res.end(avatar);
  }

  if (pathname === "/avis") {
    if (!ADMIN_KEY || !url.searchParams.has("key")) {
      res.writeHead(404);
      return res.end();
    }

    const supplied = url.searchParams.get("key") || "";
    const authorized = supplied.length === ADMIN_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_KEY));

    if (!authorized) {
      res.writeHead(404);
      return res.end();
    }

    const rows = feedback.slice(-200).reverse().map((item) => {
      return "<article style='padding:12px;border-bottom:1px solid #ddd'>" +
        "<b>" + escapeHTML(item.name) + "</b> — " +
        escapeHTML(new Date(item.ts).toLocaleString("fr-FR")) +
        "<p>" + escapeHTML(item.text) + "</p></article>";
    }).join("");

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });

    return res.end(
      "<!doctype html><html lang='fr'><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<title>Avis Coco Tchat</title><body style='font:16px sans-serif;max-width:800px;margin:30px auto;padding:0 16px'>" +
      "<h1>Avis reçus</h1>" + (rows || "<p>Aucun avis pour le moment.</p>") +
      "</body></html>"
    );
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  const staticFiles = {
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
    "/icon-192.png": ["icon-192.png", "image/png"],
    "/icon-512.png": ["icon-512.png", "image/png"],
    "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"]
  };

  if (staticFiles[pathname]) {
    const [filename, type] = staticFiles[pathname];
    const file = path.join(PUB, filename);

    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    });

    return fs.createReadStream(file).pipe(res);
  }

  if (pathname !== "/" && pathname !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Page introuvable");
  }

  const page = path.join(PUB, "index.html");

  if (!fs.existsSync(page)) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Le fichier index.html est manquant.");
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });

  fs.createReadStream(page).pipe(res);
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  perMessageDeflate: false
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;

  const key = clientKey(req);
  const clientIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  const messageTimes = [];

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: "err", x: "Message invalide." });
    }

    if (!message || typeof message.t !== "string") return;

    const now = Date.now();

    while (messageTimes.length && messageTimes[0] < now - 10000) {
      messageTimes.shift();
    }

    if (message.t !== "avatar" && message.t !== "media") {
      messageTimes.push(now);

      if (messageTimes.length > 60) {
        send(ws, { t: "err", x: "Tu envoies trop de messages. Réessaie plus tard." });
        return;
      }
    }

    let client = clients.get(ws);

    if (message.t === "join" && !client) {
      const remaining = banRemaining(key);

      if (remaining > 0) {
        return send(ws, {
          t: "err",
          x: "Accès suspendu pendant " + humanDuration(remaining) + "."
        });
      }

      // Vérification du jeton Turnstile
      const turnstileValid = await verifyTurnstile(message.token, clientIp);
      if (!turnstileValid) {
        return send(ws, {
          t: "err",
          x: "Vérification de sécurité (Turnstile) échouée. Merci de réessayer."
        });
      }

      const age = Number.parseInt(message.a, 10);

      if (!Number.isInteger(age) || age < 18 || age > 99) {
        return send(ws, {
          t: "err",
          x: "Ce service est réservé aux personnes majeures (18 ans et plus)."
        });
      }

      const name = clean(message.n, 16);

      if (!name || name.length < 2) {
        return send(ws, { t: "err", x: "Choisis un pseudo de 2 à 16 caractères." });
      }

      const admin = isAdminMessage(message);
      const normalizedName = name.toLocaleLowerCase("fr");

      if (RESERVED.includes(normalizedName) && !admin) {
        return send(ws, { t: "err", x: "Ce pseudo est réservé." });
      }

      const chosenSalon = validSalon(message.s) ? message.s : SALONS[0];

      client = {
        n: uniqueName(name),
        a: age,
        sx: ["H", "F", "T", "Autre"].includes(message.sx) ? message.sx : "",
        v: clean(message.v, 20),
        r: clean(message.r, 30),
        d: /^(2[AB]|\d{2,3}|XX)$/.test(String(message.d || ""))
          ? String(message.d)
          : "",
        c: ["H", "F", "HF", "T"].includes(message.c) ? message.c : "",
        o: ["hetero", "homo", "bi", "autre"].includes(message.o) ? message.o : "",
        s: chosenSalon,
        key,
        admin,
        sentTo: new Set(),
        since: now,
        id: crypto.randomBytes(6).toString("hex"),
        av: 0,
        reportTimes: [],
        banned: false
      };

      clients.set(ws, client);

      send(ws, {
        t: "init",
        i: client.id,
        n: client.n,
        salons: SALONS,
        s: client.s,
        hist: histories[client.s],
        admin: client.admin
      });

      systemMessage(client.s, client.n + " a rejoint le salon.");
      pushOnline();
      return;
    }

    if (!client) {
      return send(ws, { t: "err", x: "Connecte-toi avant d'envoyer un message." });
    }

    if (message.t === "salon") {
      const salon = clean(message.s, 40);

      if (!validSalon(salon)) {
        return send(ws, { t: "err", x: "Salon inconnu." });
      }

      if (salon === client.s) {
        return send(ws, {
          t: "history",
          s: salon,
          hist: histories[salon]
        });
      }

      const previousSalon = client.s;
      systemMessage(previousSalon, client.n + " a quitté le salon.");
      client.s = salon;

      send(ws, {
        t: "history",
        s: salon,
        hist: histories[salon]
      });

      systemMessage(salon, client.n + " a rejoint le salon.");
      pushOnline();
      return;
    }

    if (message.t === "msg") {
      const text = clean(message.x, 1000);

      if (!text) return;

      const item = {
        t: "msg",
        s: client.s,
        n: client.n,
        x: text,
        ts: now,
        i: client.id,
        p: 0
      };

      addHistory(client.s, item);
      broadcastSalon(client.s, item);
      return;
    }

    if (message.t === "pm") {
      const recipientName = clean(message.to, 16);
      const text = clean(message.x, 1000);

      if (!recipientName || !text) return;

      let recipientSocket = null;
      let recipient = null;

      for (const [otherSocket, otherClient] of clients) {
        if (otherClient.n.toLocaleLowerCase("fr") === recipientName.toLocaleLowerCase("fr")) {
          recipientSocket = otherSocket;
          recipient = otherClient;
          break;
        }
      }

      if (!recipient || !recipientSocket) {
        return send(ws, { t: "err", x: "Cette personne n'est plus connectée." });
      }

      const privateMessage = {
        t: "pm",
        from: client.n,
        to: recipient.n,
        x: text,
        ts: now,
        fid: client.id,
        fp: client.av
      };

      send(recipientSocket, privateMessage);
      send(ws, privateMessage);
      client.sentTo.add(recipient.n);
      return;
    }

    if (message.t === "avatar") {
      if (typeof message.d !== "string") return;

      const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(message.d);
      if (!match) {
        return send(ws, { t: "err", x: "Avatar invalide. Utilise une image JPEG." });
      }

      const buffer = Buffer.from(match[1], "base64");

      if (!buffer.length || buffer.length > 300 * 1024) {
        return send(ws, { t: "err", x: "Avatar trop volumineux." });
      }

      avatars.set(client.id, buffer);
      client.av = now;

      send(ws, { t: "avatar_ok", i: client.id, p: client.av });
      pushOnline();
      return;
    }

    if (message.t === "media") {
      try {
        const parsed = parseDataURL(message.d);
        const mediaId = addMedia(parsed.buffer, parsed.type, client.id);
        const kind = parsed.type.startsWith("image/") ? "img" : "vid";
        const isPrivate = Boolean(message.to);
        const mediaMessage = {
          t: isPrivate ? "pm" : "msg",
          s: client.s,
          n: client.n,
          from: client.n,
          to: isPrivate ? clean(message.to, 16) : "",
          x: "",
          ts: now,
          i: client.id,
          fid: client.id,
          fp: client.av,
          media: { id: mediaId, k: kind }
        };

        if (isPrivate) {
          let targetSocket = null;
          let targetClient = null;

          for (const [otherSocket, otherClient] of clients) {
            if (otherClient.n.toLocaleLowerCase("fr") === mediaMessage.to.toLocaleLowerCase("fr")) {
              targetSocket = otherSocket;
              targetClient = otherClient;
              break;
            }
          }

          if (!targetClient || !targetSocket) {
            deleteMedia(mediaId);
            return send(ws, { t: "err", x: "Cette personne n'est plus connectée." });
          }

          send(targetSocket, mediaMessage);
          send(ws, mediaMessage);
        } else {
          addHistory(client.s, mediaMessage);
          broadcastSalon(client.s, mediaMessage);
        }

        return;
      } catch (error) {
        return send(ws, {
          t: "err",
          x: error.message || "Impossible d'envoyer ce fichier."
        });
      }
    }

    if (message.t === "feedback") {
      const text = clean(message.x, 2000);

      if (!text) {
        return send(ws, { t: "err", x: "Écris ton avis avant de l'envoyer." });
      }

      feedback.push({
        name: client.n,
        text,
        ts: now
      });

      if (feedback.length > 2000) feedback = feedback.slice(-2000);

      saveFeedback();
      send(ws, { t: "feedback_ok", x: "Merci pour ton avis !" });
      return;
    }

    if (message.t === "report") {
      const targetName = clean(message.to || message.n, 16);

      if (!targetName) {
        return send(ws, { t: "err", x: "Personne à signaler introuvable." });
      }

      if (targetName.toLocaleLowerCase("fr") === client.n.toLocaleLowerCase("fr")) {
        return send(ws, { t: "err", x: "Tu ne peux pas te signaler toi-même." });
      }

      const times = recentReports.get(key) || [];
      const recent = times.filter((time) => time > now - 60000);

      if (recent.length >= MAX_REPORTS_PER_MINUTE) {
        return send(ws, { t: "err", x: "Trop de signalements. Réessaie plus tard." });
      }

      recent.push(now);
      recentReports.set(key, recent);

      let targetSocket = null;
      let target = null;

      for (const [otherSocket, otherClient] of clients) {
        if (otherClient.n.toLocaleLowerCase("fr") === targetName.toLocaleLowerCase("fr")) {
          targetSocket = otherSocket;
          target = otherClient;
          break;
        }
      }

      if (!target || !targetSocket) {
        return send(ws, { t: "err", x: "Cette personne n'est plus connectée." });
      }

      if (target.admin) {
        return send(ws, { t: "err", x: "Les comptes de modération ne peuvent pas être signalés ici." });
      }

      if (now - target.since < MIN_REPORT_TIME) {
        return send(ws, {
          t: "err",
          x: "Attends quelques secondes avant de signaler ce compte."
        });
      }

      if (!target.reportTimes) target.reportTimes = [];
      target.reportTimes = target.reportTimes.filter((time) => time > now - REPORT_WINDOW);
      target.reportTimes.push(now);

      send(ws, { t: "report_ok", x: "Signalement transmis." });

      const reporters = new Set(
        [...clients.entries()]
          .filter(([socket, c]) =>
            socket !== targetSocket &&
            c.n !== target.n &&
            c.reportTimes &&
            c.reportTimes.some((time) => time > now - REPORT_WINDOW)
          )
          .map(([, c]) => c.key)
      );

      reporters.add(key);

      if (reporters.size >= 3) {
        applySanction(target.key, target.n, key);
      }

      return;
    }

    if (message.t === "ping") {
      return send(ws, { t: "pong", ts: now });
    }
  });

  ws.on("close", () => removeClient(ws));

  ws.on("error", (error) => {
    console.error("Erreur WebSocket :", error.message);
  });
});

setInterval(() => {
  const cutoff = Date.now() - MEDIA_TTL;

  for (const [id, file] of mediaFiles) {
    if (file.at < cutoff) deleteMedia(id);
  }

  for (const [key, times] of recentReports) {
    const kept = times.filter((time) => time > Date.now() - 60000);
    if (kept.length) recentReports.set(key, kept);
    else recentReports.delete(key);
  }
}, 60 * 1000).unref();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

heartbeat.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log("Coco Tchat écoute sur le port " + PORT);
});

process.on("SIGTERM", () => {
  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    try {
      ws.close(1001, "Serveur en arrêt");
    } catch {}
  }

  server.close(() => process.exit(0));
});
