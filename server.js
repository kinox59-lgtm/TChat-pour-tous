"use strict";

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
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.join(DATA_DIR, "avis.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

const MAX_PAYLOAD = 15 * 1024 * 1024;
const MAX_MEDIA_TOTAL = 150 * 1024 * 1024;
const HISTORY_LIMIT = 40;

const SALONS = [
  "Général",
  "18-25 ans",
  "26-40 ans",
  "Musique",
  "Jeux vidéo",
  "Détente",
  "Avis & idées"
];

const PUB = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

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

let usersDB = readJSON(USERS_FILE, {});
if (!usersDB || typeof usersDB !== "object") usersDB = {};

let feedback = readJSON(FEEDBACK_FILE, []);
if (!Array.isArray(feedback)) feedback = [];

let histories = readJSON(HISTORY_FILE, null);
if (!histories || typeof histories !== "object") {
  histories = Object.fromEntries(SALONS.map((name) => [name, []]));
  histories["Avis & idées"].push({
    t: "msg",
    s: "Avis & idées",
    n: "Équipe",
    x: "Bienvenue ! Tu peux partager tes idées pour améliorer Coco Tchat.",
    ts: Date.now(),
    i: "",
    p: 0
  });
}

const saveBans = () => saveJSON(BAN_FILE, store);
const saveUsers = () => saveJSON(USERS_FILE, usersDB);
const saveFeedback = () => saveJSON(FEEDBACK_FILE, feedback);
const saveHistories = () => saveJSON(HISTORY_FILE, histories);

const clients = new Map();
const mediaFiles = new Map();

let mediaBytes = 0;

function hashPassword(password) {
  return crypto.createHash("sha256").update(SALT + password).digest("hex");
}

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
    console.error("Erreur Turnstile :", error.message);
    return false;
  }
}

function clean(value, maxLength = 500) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
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

// Diffusion instantanée sans délai (temps réel pur)
function pushOnline() {
  const list = [...clients.values()].slice(0, 300).map((c) => ({
    n: c.n, a: c.a, sx: c.sx, v: c.v, i: c.id, p: c.av, s: c.s
  }));

  for (const ws of clients.keys()) {
    send(ws, { t: "online", list });
    send(ws, { t: "online_count", count: clients.size });
  }
}

function uniqueName(name) {
  const used = new Set([...clients.values()].map((c) => c.n.toLocaleLowerCase("fr")));
  let result = name;
  let index = 2;
  while (used.has(result.toLocaleLowerCase("fr"))) {
    result = name.slice(0, 12) + "_" + index++;
  }
  return result;
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  return crypto.createHash("sha256").update(SALT + ":" + ip).digest("hex").slice(0, 32);
}

function banRemaining(key) {
  const ban = store.bans[key];
  if (ban === -1) return Infinity;
  if (typeof ban !== "number" || ban <= Date.now()) return 0;
  return ban - Date.now();
}

function deleteMedia(id) {
  const file = mediaFiles.get(id);
  if (!file) return;
  mediaBytes -= file.buf.length;
  mediaFiles.delete(id);
}

function addMedia(buffer, type, owner) {
  if (buffer.length > MAX_MEDIA_TOTAL) throw new Error("Fichier trop volumineux.");
  while (mediaBytes + buffer.length > MAX_MEDIA_TOTAL && mediaFiles.size) {
    deleteMedia(mediaFiles.keys().next().value);
  }
  const id = crypto.randomBytes(16).toString("hex");
  mediaFiles.set(id, { buf: buffer, type, at: Date.now(), owner });
  mediaBytes += buffer.length;
  return id;
}

function parseDataURL(value) {
  if (typeof value !== "string") throw new Error("Fichier invalide.");
  const match = /^data:(image\/[a-zA-Z+.-]+|video\/[a-zA-Z+.-]+|audio\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new Error("Format non accepté.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("Fichier trop volumineux (10 Mo max).");
  return { buffer, type: match[1] };
}

function removeClient(ws) {
  const client = clients.get(ws);
  if (!client) return;
  clients.delete(ws);
  systemMessage(client.s, client.n + " a quitté le salon.");
  pushOnline();
}

function disconnectBanned(key, message) {
  for (const [ws, client] of [...clients]) {
    if (client.key !== key) continue;
    send(ws, { t: "banned", x: message });
    clients.delete(ws);
    try { ws.close(1008, "Accès suspendu"); } catch {}
  }
  pushOnline();
}

function applySanction(key) {
  if (!store.strikes[key]) store.strikes[key] = 0;
  store.strikes[key] += 1;
  const duration = 30 * 60 * 1000;
  store.bans[key] = Date.now() + duration;
  saveBans();
  disconnectBanned(key, "Suspension administrative.");
}

function validSalon(name) {
  return SALONS.includes(name);
}

function addHistory(salon, message) {
  if (!histories[salon]) histories[salon] = [];
  histories[salon].push(message);
  if (histories[salon].length > HISTORY_LIMIT) histories[salon].shift();
  saveHistories();
}

function isAdminMessage(message) {
  return ADMIN_KEY.length > 0 &&
    typeof message.adminKey === "string" &&
    message.adminKey.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(message.adminKey), Buffer.from(ADMIN_KEY));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }

  if (pathname === "/admin") {
    const supplied = url.searchParams.get("key") || "";
    const authorized = ADMIN_KEY.length > 0 && supplied.length === ADMIN_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_KEY));

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

    if (!authorized) {
      return res.end(`
        <!doctype html><html lang='fr'><meta charset='utf-8'>
        <title>Admin - Coco Tchat</title>
        <body style='font-family:sans-serif;max-width:400px;margin:80px auto;padding:0 20px;text-align:center;'>
          <h2>Administration Coco Tchat</h2>
          <form method='GET' action='/admin' style='display:grid;gap:12px;'>
            <input type='password' name='key' placeholder='Mot de passe administrateur' style='padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px;' required>
            <button type='submit' style='padding:10px;font-size:16px;background:#6658e8;color:white;border:0;border-radius:8px;cursor:pointer;'>Se connecter</button>
          </form>
        </body></html>
      `);
    }

    const onlineRows = [...clients.values()].map(c => 
      `<li><b>${escapeHTML(c.n)}</b> (${c.s}) - IP Key: ${c.key.slice(0,8)}... <a href="/admin/kick?key=${supplied}&name=${encodeURIComponent(c.n)}">[Exclure]</a></li>`
    ).join("");

    return res.end(`
      <!doctype html><html lang='fr'><meta charset='utf-8'>
      <title>Panel Admin Coco Tchat</title>
      <body style='font-family:sans-serif;max-width:800px;margin:30px auto;padding:0 20px'>
        <h1>Panneau d'administration</h1>
        <p><b>Utilisateurs connectés (${clients.size}) :</b></p>
        <ul>${onlineRows || "<li>Personne en ligne</li>"}</ul>
        <p><a href="/avis?key=${supplied}" target="_blank">Voir les avis (${feedback.length})</a></p>
        <p><a href="/admin">Se déconnecter</a></p>
      </body></html>
    `);
  }

  if (pathname === "/admin/kick") {
    const supplied = url.searchParams.get("key") || "";
    const targetName = url.searchParams.get("name") || "";
    const authorized = ADMIN_KEY.length > 0 && supplied.length === ADMIN_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_KEY));

    if (authorized) {
      for (const [ws, client] of clients) {
        if (client.n === targetName) {
          send(ws, { t: "banned", x: "Exclu par l'administrateur." });
          ws.close();
        }
      }
    }
    res.writeHead(302, { Location: "/admin?key=" + supplied });
    return res.end();
  }

  if (pathname.startsWith("/media/")) {
    const match = /^\/media\/([a-f0-9]{32})$/.exec(pathname);
    if (match) {
      const file = mediaFiles.get(match[1]);
      if (!file) {
        res.writeHead(404);
        return res.end("Fichier introuvable");
      }
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": file.buf.length,
        "Cache-Control": "private, no-store"
      });
      return res.end(file.buf);
    }
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
    if (fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
      return fs.createReadStream(file).pipe(res);
    }
  }

  const page = path.join(PUB, "index.html");
  if (!fs.existsSync(page)) {
    res.writeHead(500);
    return res.end("index.html manquant");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  fs.createReadStream(page).pipe(res);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  const key = clientKey(req);
  const clientIp = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message.t !== "string") return;

    const now = Date.now();
    let client = clients.get(ws);

    if (message.t === "join" && !client) {
      if (banRemaining(key) > 0) return send(ws, { t: "err", x: "Accès suspendu." });
      if (!await verifyTurnstile(message.token, clientIp)) return send(ws, { t: "err", x: "Turnstile invalide." });

      const name = clean(message.n, 16);
      const password = message.p ? String(message.p) : "";
      const isRegister = message.register === true;
      const lowerName = name.toLocaleLowerCase("fr");

      if (!name || name.length < 2) return send(ws, { t: "err", x: "Pseudo trop court." });

      let userFriends = [];

      if (password) {
        if (usersDB[lowerName]) {
          if (usersDB[lowerName].pwd !== hashPassword(password)) {
            return send(ws, { t: "err", x: "Mot de passe incorrect." });
          }
          userFriends = usersDB[lowerName].friends || [];
        } else {
          if (!isRegister) {
            return send(ws, { t: "err", x: "Ce pseudo n'a pas de compte. Coche 'Créer un compte' pour l'enregistrer." });
          }
          usersDB[lowerName] = {
            pwd: hashPassword(password),
            friends: []
          };
          saveUsers();
        }
      } else if (usersDB[lowerName]) {
        return send(ws, { t: "err", x: "Ce pseudo est protégé par un mot de passe. Entre ton mot de passe pour te connecter." });
      }

      const admin = isAdminMessage(message);

      client = {
        n: uniqueName(name),
        a: Number(message.a) || 18,
        sx: message.sx || "",
        v: clean(message.v, 20),
        s: validSalon(message.s) ? message.s : SALONS[0],
        key, admin, id: crypto.randomBytes(6).toString("hex"), av: 0, since: now,
        lowerName: password ? lowerName : null
      };

      clients.set(ws, client);
      
      send(ws, { 
        t: "init", 
        i: client.id, 
        n: client.n, 
        salons: SALONS, 
        s: client.s, 
        hist: histories[client.s] || [], 
        admin: client.admin,
        friends: userFriends
      });

      systemMessage(client.s, client.n + " a rejoint le salon.");
      pushOnline();
      return;
    }

    if (!client) return;

    if (message.t === "update_friends") {
      if (client.lowerName && Array.isArray(message.friends) && usersDB[client.lowerName]) {
        usersDB[client.lowerName].friends = message.friends.map(f => clean(f, 16));
        saveUsers();
      }
      return;
    }

    if (message.t === "salon") {
      const salon = clean(message.s, 40);
      if (!validSalon(salon)) return;
      systemMessage(client.s, client.n + " a quitté le salon.");
      client.s = salon;
      send(ws, { t: "history", s: salon, hist: histories[salon] || [] });
      systemMessage(salon, client.n + " a rejoint le salon.");
      pushOnline();
      return;
    }

    if (message.t === "msg") {
      const text = clean(message.x, 1000);
      if (!text) return;

      if (client.admin && text.startsWith("/ban ")) {
        const targetName = text.slice(5).trim();
        for (const [targetWs, targetClient] of clients) {
          if (targetClient.n.toLocaleLowerCase() === targetName.toLocaleLowerCase()) {
            applySanction(targetClient.key);
            systemMessage(client.s, "⚠️ " + targetClient.n + " a été banni par l'administrateur.");
          }
        }
        return;
      }

      const item = { t: "msg", s: client.s, n: client.n, x: text, ts: now, i: client.id, p: 0 };
      addHistory(client.s, item);
      broadcastSalon(client.s, item);
      return;
    }

    if (message.t === "pm") {
      const recipientName = clean(message.to, 16);
      const text = clean(message.x, 1000);
      if (!recipientName || !text) return;

      let found = false;
      for (const [otherSocket, otherClient] of clients) {
        if (otherClient.n.toLocaleLowerCase("fr") === recipientName.toLocaleLowerCase("fr")) {
          const pm = { t: "pm", from: client.n, to: otherClient.n, x: text, ts: now, fid: client.id };
          send(otherSocket, pm);
          send(ws, pm);
          found = true;
          break;
        }
      }
      if (!found) {
        send(ws, { t: "err", x: "Destinataire hors ligne." });
      }
      return;
    }

    if (message.t === "media") {
      try {
        const parsed = parseDataURL(message.d);
        const mediaId = addMedia(parsed.buffer, parsed.type, client.id);
        let kind = parsed.type.startsWith("image/") ? "img" : parsed.type.startsWith("audio/") ? "aud" : "vid";

        const isPrivate = Boolean(message.to);
        const mediaMsg = {
          t: isPrivate ? "pm" : "msg", s: client.s, n: client.n, from: client.n,
          to: isPrivate ? clean(message.to, 16) : "", x: "", ts: now, i: client.id, fid: client.id,
          media: { id: mediaId, k: kind }
        };

        if (isPrivate) {
          let found = false;
          for (const [otherSocket, otherClient] of clients) {
            if (otherClient.n.toLocaleLowerCase("fr") === mediaMsg.to.toLocaleLowerCase("fr")) {
              send(otherSocket, mediaMsg);
              send(ws, mediaMsg);
              found = true;
              break;
            }
          }
          if (!found) {
            deleteMedia(mediaId);
            send(ws, { t: "err", x: "Destinataire hors ligne." });
          }
        } else {
          addHistory(client.s, mediaMsg);
          broadcastSalon(client.s, mediaMsg);
        }
      } catch (err) {
        send(ws, { t: "err", x: err.message });
      }
      return;
    }

    if (message.t === "feedback") {
      const text = clean(message.x, 2000);
      if (!text) return;
      feedback.push({ name: client.n, text, ts: now });
      saveFeedback();
      send(ws, { t: "feedback_ok", x: "Avis enregistré !" });
      return;
    }
  });

  ws.on("close", () => removeClient(ws));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Coco Tchat démarré sur le port " + PORT);
});
