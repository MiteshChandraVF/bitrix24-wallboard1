/**
 * server.js — Bitrix24 Wallboard Backend (Railway)
 *
 * ✅ Fixes included:
 * 1) Trust reverse proxy (Railway/Caddy) so req.protocol / X-Forwarded-* works
 * 2) Pin HTTPS safely via PUBLIC_URL (recommended)
 * 3) Persist tokens to DATA_DIR (/data on Railway volume) so they survive restarts
 * 4) Bind Voximplant events to your /bitrix/events endpoint (POST)
 * 5) WebSocket broadcast to connected wallboards
 * 6) Debug endpoints: /health, /debug/state, /debug/offline
 *
 * IMPORTANT:
 * - Set Railway ENV:
 *   PUBLIC_URL=https://bitrix24-wallboard1-production.up.railway.app
 *   DATA_DIR=/data
 * - Make sure a Railway Volume is mounted to /data (Service → Volumes)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const app = express();

/** Railway / reverse-proxy */
app.set("trust proxy", 1);

/** Middleware to parse Bitrix install + event posts */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/** --- Config / Paths --- */
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

/** Multer (some Bitrix webhooks can be multipart in edge cases) */
const upload = multer();

/** --- In-memory state (wallboard metrics) --- */
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

const liveCalls = new Map(); // callId -> { direction, agentId, phone, startedAt }
const agents = new Map(); // agentId -> { id, name?, onCallNow, inboundAnswered, inboundMissed, outboundAnswered, outboundMissed }

/** --- Token storage (persisted) --- */
let portalTokens = {}; // key: `${domain}|${memberId}` -> token object

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore if exists
  }
}

function loadTokens() {
  ensureDirSync(DATA_DIR);
  if (!fs.existsSync(TOKENS_FILE)) {
    portalTokens = {};
    return 0;
  }
  try {
    const raw = fs.readFileSync(TOKENS_FILE, "utf-8");
    portalTokens = JSON.parse(raw || "{}");
    if (!portalTokens || typeof portalTokens !== "object") portalTokens = {};
    return Object.keys(portalTokens).length;
  } catch (e) {
    portalTokens = {};
    return 0;
  }
}

function saveTokens() {
  ensureDirSync(DATA_DIR);
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(portalTokens, null, 2), "utf-8");
}

function tokenKey(domain, memberId) {
  return `${String(domain || "").trim().toLowerCase()}|${String(memberId || "").trim()}`;
}

function getAnyToken() {
  const keys = Object.keys(portalTokens || {});
  if (!keys.length) return null;
  return portalTokens[keys[0]];
}

/** --- Helpers for metrics/agents --- */
function clampDown(obj, field) {
  if (!obj || typeof obj[field] !== "number") return;
  obj[field] = Math.max(0, obj[field] - 1);
}

function ensureAgent(agentId) {
  if (!agentId) return null;
  const id = String(agentId);
  if (!agents.has(id)) {
    agents.set(id, {
      id,
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
    });
  }
  return agents.get(id);
}

function asArray(map) {
  return Array.from(map.values());
}

/** --- WebSocket broadcast --- */
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Boot");
  console.log(`💾 Tokens file: ${TOKENS_FILE}`);
  const count = loadTokens();
  console.log(`🔑 Tokens loaded: ${count}`);
  console.log(`🚀 Server running on ${PORT}`);
});

const wss = new WebSocketServer({ server });

function snapshotState() {
  return {
    ok: true,
    portalsStored: Object.keys(portalTokens || {}).length,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: asArray(liveCalls),
    agents: asArray(agents),
  };
}

function broadcast() {
  const payload = JSON.stringify({ type: "state", data: snapshotState() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (_) {}
    }
  });
}

wss.on("connection", (ws) => {
  // Send immediate snapshot
  try {
    ws.send(JSON.stringify({ type: "state", data: snapshotState() }));
  } catch (_) {}

  ws.on("message", (buf) => {
    // Optional: future commands
    const msg = String(buf || "");
    if (msg === "ping") {
      try {
        ws.send("pong");
      } catch (_) {}
    }
  });
});

/** --- Base URL / Handler URL --- */
function detectedBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function baseUrl(req) {
  // Fix 2: pin HTTPS via PUBLIC_URL if set
  return PUBLIC_URL || detectedBaseUrl(req);
}

function handlerUrl(req) {
  return `${baseUrl(req)}/bitrix/events`;
}

/** --- Basic pages --- */
app.get("/", (req, res) => {
  res.status(200).send("Bitrix24 Wallboard Backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** Debug state JSON */
app.get("/debug/state", (req, res) => {
  res.json(snapshotState());
});

/** Debug offline helper */
app.get("/debug/offline", (req, res) => {
  const hasAny = Object.keys(portalTokens || {}).length > 0;
  if (!hasAny) {
    return res.status(400).json({
      ok: false,
      error: "No portal token stored yet. Reinstall the Bitrix app first.",
      tokensFile: TOKENS_FILE,
    });
  }
  res.json({
    ok: true,
    message: "Token exists. If events are not coming, check event.bind status and HTTPS pinning.",
    tokensFile: TOKENS_FILE,
  });
});

/** --- Bitrix UI (iframe) page --- */
app.get("/bitrix/app", (req, res) => {
  const hUrl = handlerUrl(req);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Bitrix24 Wallboard</title>
  <style>
    body{font-family:Arial, sans-serif; padding:16px; background:#0b1220; color:#e5e7eb;}
    .card{max-width:900px;margin:0 auto;background:#0f172a;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .pill{padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);font-size:12px}
    button{background:#ef4444;color:white;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:700}
    button.secondary{background:#334155}
    code{background:rgba(0,0,0,.3);padding:2px 6px;border-radius:6px}
    pre{background:rgba(0,0,0,.3);padding:12px;border-radius:10px;overflow:auto}
    a{color:#93c5fd}
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin:0 0 8px">Bitrix24 Wallboard Backend</h2>
    <div class="row" style="margin-bottom:10px">
      <span class="pill">PUBLIC_URL: ${PUBLIC_URL ? "set" : "not set"}</span>
      <span class="pill">Handler URL: <code>${hUrl}</code></span>
      <span class="pill">Tokens file: <code>${TOKENS_FILE}</code></span>
    </div>

    <p style="margin:0 0 14px; opacity:.9">
      This is the iframe page. If you have “No Bitrix iframe UI page at the moment”,
      make sure your Bitrix24 app settings point to:
      <code>${baseUrl(req)}/bitrix/app</code>
    </p>

    <div class="row" style="margin-bottom:12px">
      <button id="btnState">Load State</button>
      <button id="btnOpen" class="secondary">Open /debug/state</button>
    </div>

    <pre id="out">Click "Load State" to view live metrics.</pre>
  </div>

<script>
  const out = document.getElementById("out");
  const btnState = document.getElementById("btnState");
  const btnOpen = document.getElementById("btnOpen");

  btnOpen.onclick = () => window.open("/debug/state", "_blank");

  async function loadState() {
    const r = await fetch("/debug/state");
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  }

  btnState.onclick = loadState;

  // Live updates via WS
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(proto + "://" + location.host);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        out.textContent = JSON.stringify(msg.data, null, 2);
      }
    } catch(e){}
  };
</script>
</body>
</html>`);
});

/** --- Bitrix install endpoint (called by Bitrix on app install) --- */
/**
 * Bitrix sends:
 * - query: DOMAIN, PROTOCOL, LANG, APP_SID (sometimes v=12 etc.)
 * - body: AUTH_ID, AUTH_EXPIRES, REFRESH_ID, SERVER_ENDPOINT, member_id, status...
 */
app.post("/bitrix/install", upload.none(), async (req, res) => {
  const contentType = req.get("content-type") || "";
  const q = req.query || {};
  const b = req.body || {};

  console.log("🔧 INSTALL content-type:", contentType);
  console.log("🔧 INSTALL query keys:", Object.keys(q || {}));
  console.log("🔧 INSTALL body keys:", Object.keys(b || {}));

  const domain = (q.DOMAIN || b.DOMAIN || "").toString().trim();
  const memberId = (b.member_id || q.member_id || "").toString().trim();

  // Token fields Bitrix typically sends
  const authId = (b.AUTH_ID || "").toString().trim();
  const refreshId = (b.REFRESH_ID || "").toString().trim();
  const serverEndpoint = (b.SERVER_ENDPOINT || "").toString().trim();
  const authExpires = (b.AUTH_EXPIRES || "").toString().trim();

  // Basic validation
  const missing = {
    domain: !domain,
    memberId: !memberId,
    authId: !authId,
    refreshId: !refreshId,
    serverEndpoint: !serverEndpoint,
  };

  if (missing.domain || missing.memberId || missing.authId || missing.refreshId || missing.serverEndpoint) {
    console.log("❌ INSTALL missing params:", missing);
    return res.status(400).json({ ok: false, missing, received: { query: q, bodyKeys: Object.keys(b || {}) } });
  }

  // Store token persistently
  const key = tokenKey(domain, memberId);
  portalTokens[key] = {
    domain,
    memberId,
    authId,
    refreshId,
    serverEndpoint,
    authExpires,
    storedAt: new Date().toISOString(),
  };

  try {
    saveTokens();
  } catch (e) {
    console.log("❌ Failed to save tokens:", e?.message || e);
  }

  console.log("✅ INSTALL stored token for:", key);
  console.log("💾 Tokens saved to:", TOKENS_FILE);

  // Try binding events (may fail with WRONG_AUTH_TYPE depending on portal permissions/auth type)
  const hUrl = handlerUrl(req);
  console.log("📌 Binding events to handler:", hUrl);

  const bindEvents = [
    "OnVoximplantCallInit",
    "OnVoximplantCallConnected",
    "OnVoximplantCallStart",
    "OnVoximplantCallEnd",
  ];

  const results = [];
  for (const eventName of bindEvents) {
    try {
      const r = await bitrixCall(key, "event.bind", {
        event: eventName,
        handler: hUrl,
      });
      results.push({ event: eventName, ok: true, result: r });
    } catch (e) {
      results.push({
        event: eventName,
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  console.log("📌 event.bind results:", results);

  // Redirect back to app root (Bitrix sometimes expects a redirect)
  // and return JSON for debugging.
  // We'll do both: send JSON if requested, otherwise redirect.
  const accept = req.get("accept") || "";
  if (accept.includes("application/json")) {
    return res.json({ ok: true, stored: key, handler: hUrl, bindResults: results });
  }

  // 302 to iframe page can be convenient
  res.redirect(302, "/");
});

/** --- Bitrix events webhook endpoint (POST only) --- */
app.get("/bitrix/events", (req, res) => {
  res.status(405).send("Method Not Allowed. Use POST /bitrix/events");
});

/**
 * Bitrix will POST events here after successful event.bind.
 * This endpoint updates in-memory metrics and broadcasts via WebSocket.
 */
app.post("/bitrix/events", upload.none(), (req, res) => {
  const body = req.body || {};
  const eventName = body.event || body.EVENT || body["event[name]"] || body["EVENT_NAME"];
  const callId = String(body.CALL_ID || body.callId || body.call_id || body["data[CALL_ID]"] || "").trim();

  // Log minimal info
  console.log("📩 EVENT:", eventName, "callId:", callId || "(none)");

  // Some Bitrix webhooks include nested fields; best-effort parsing:
  const directionRaw = (body.DIRECTION || body.direction || body["data[DIRECTION]"] || "").toString().toUpperCase();
  const direction = directionRaw === "OUT" || directionRaw === "OUTGOING" ? "OUT" : "IN";

  const phone = (body.PHONE_NUMBER || body.phone || body["data[PHONE_NUMBER]"] || "").toString().trim();
  const agentId = (body.PORTAL_USER_ID || body.agentId || body.agent_id || body["data[PORTAL_USER_ID]"] || "").toString().trim() || null;

  // Handle events (best effort)
  if (eventName === "OnVoximplantCallInit") {
    if (callId) {
      liveCalls.set(callId, {
        callId,
        direction,
        phone,
        agentId,
        startedAt: new Date().toISOString(),
      });
      if (direction === "IN") metrics.incoming.inProgress += 1;
      else metrics.outgoing.inProgress += 1;

      if (agentId) {
        const a = ensureAgent(agentId);
        if (a) a.onCallNow = true;
      }

      broadcast();
    }
  }

  if (eventName === "OnVoximplantCallConnected") {
    // Treat as answered
    const lc = callId ? liveCalls.get(callId) : null;
    if (lc) {
      if (lc.direction === "IN") {
        clampDown(metrics.incoming, "inProgress");
        metrics.incoming.answered += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) {
            a.onCallNow = true;
            a.inboundAnswered += 1;
          }
        }
      } else {
        clampDown(metrics.outgoing, "inProgress");
        metrics.outgoing.answered += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) {
            a.onCallNow = true;
            a.outboundAnswered += 1;
          }
        }
      }
      broadcast();
    }
  }

  if (eventName === "OnVoximplantCallStart") {
    // Optional: keep alive; ensure it exists
    if (callId) {
      if (!liveCalls.has(callId)) {
        liveCalls.set(callId, {
          callId,
          direction,
          phone,
          agentId,
          startedAt: new Date().toISOString(),
        });
        if (direction === "IN") metrics.incoming.inProgress += 1;
        else metrics.outgoing.inProgress += 1;
      }
      if (agentId) {
        const a = ensureAgent(agentId);
        if (a) a.onCallNow = true;
      }
      broadcast();
    }
  }

  if (eventName === "OnVoximplantCallEnd") {
    const lc = callId ? liveCalls.get(callId) : null;
    if (lc) {
      if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
      else clampDown(metrics.outgoing, "inProgress");

      // If you have a reliable status field you can refine this later.
      // For now: treat IN end as missed (common when not connected),
      // OUT end as cancelled if no explicit "answered" tracked.
      if (lc.direction === "IN") {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) a.inboundMissed += 1;
        }
      } else {
        metrics.outgoing.cancelled += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) a.outboundMissed += 1;
        }
      }

      if (lc.agentId) {
        const a = ensureAgent(lc.agentId);
        if (a) a.onCallNow = false;
      }

      liveCalls.delete(callId);
      broadcast();
    }
  }

  // Always respond quickly (Bitrix expects 200)
  res.json({ ok: true });
});

/** --- Bitrix REST call helper --- */
async function bitrixCall(key, method, params = {}) {
  const t = portalTokens[key];
  if (!t) throw new Error(`No token for portal: ${key}`);

  // Typically serverEndpoint ends with /rest/ or similar.
  // We build a URL: `${SERVER_ENDPOINT}${method}`
  const base = t.serverEndpoint.replace(/\/+$/, "") + "/";
  const url = base + method;

  try {
    const r = await axios.post(
      url,
      new URLSearchParams({
        auth: t.authId,
        ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
    );

    // Bitrix returns {result: ...} or {error: ...}
    if (r.data && r.data.error) {
      throw new Error(`Bitrix REST error ${r.data.error}: ${JSON.stringify(r.data)}`);
    }
    return r.data;
  } catch (e) {
    // Normalize Bitrix REST errors for logs
    const status = e?.response?.status;
    const data = e?.response?.data;
    if (status && data) {
      throw new Error(`Bitrix REST error ${status}: ${JSON.stringify(data)}`);
    }
    throw e;
  }
}

/** Graceful shutdown */
process.on("SIGTERM", () => {
  try {
    console.log("🧯 SIGTERM received. Closing server...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  } catch (_) {
    process.exit(0);
  }
});
