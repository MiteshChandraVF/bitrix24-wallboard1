/**
 * Bitrix24 Wallboard Backend (Railway)
 * - Uses Bitrix INCOMING WEBHOOK for REST calls (no OAuth auth_id)
 * - Persists portal installs to TOKENS_FILE (default /data/portalTokens.json)
 * - Exposes:
 *    GET  /                 -> "Backend is running"
 *    GET  /health           -> {ok:true}
 *    GET  /debug/state      -> state snapshot
 *    POST /bitrix/install   -> Bitrix app install callback (saves portal, binds events)
 *    POST /bitrix/events    -> Bitrix event receiver (updates metrics + broadcasts)
 *    WS   /ws               -> realtime broadcast to wallboard UI (if you have one)
 *
 * Required Railway env vars:
 *   PUBLIC_URL=https://bitrix24-wallboard1-production.up.railway.app
 *   BITRIX_WEBHOOK_BASE=https://contactcenter.fincorp.com.pg/rest/1/xxxxxxxxxxxx
 * Optional:
 *   DATA_DIR=/data
 *   PORT=3000  (Railway sets this automatically; must match Railway "Target port")
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

// -------------------- APP BOOT --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const normalizeBase = (u) => (u || "").toString().trim().replace(/\/+$/, "");

// Env
const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = normalizeBase(process.env.PUBLIC_URL);
const BITRIX_WEBHOOK_BASE = normalizeBase(process.env.BITRIX_WEBHOOK_BASE);
const DATA_DIR = (process.env.DATA_DIR || "/data").toString();
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

const HANDLER_URL = PUBLIC_URL ? `${PUBLIC_URL}/bitrix/events` : "";

// Ensure data dir exists (Railway volume mount should provide it)
function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // If mount exists but mkdir fails, we still continue; will fail on write if not writable.
  }
}
ensureDirSync(DATA_DIR);

// -------------------- TOKENS STORAGE --------------------
let portalTokens = {};

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const raw = fs.readFileSync(TOKENS_FILE, "utf8");
      portalTokens = JSON.parse(raw || "{}") || {};
    } else {
      portalTokens = {};
    }
  } catch (e) {
    console.error("❌ Failed to load tokens:", e.message);
    portalTokens = {};
  }
}

function saveTokens(obj) {
  try {
    ensureDirSync(DATA_DIR);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to save tokens:", e.message);
  }
}

console.log("🚀 Boot");
console.log("💾 Tokens file:", TOKENS_FILE);
loadTokens();
console.log("🔑 Tokens loaded:", Object.keys(portalTokens).length);

if (PUBLIC_URL) console.log("🔗 Handler URL:", HANDLER_URL);
else console.log("⚠️  PUBLIC_URL not set (required for event.bind handler URL)");

if (!BITRIX_WEBHOOK_BASE) {
  console.log("⚠️  BITRIX_WEBHOOK_BASE not set (required to call event.bind via webhook)");
}

// -------------------- BITRIX REST via INCOMING WEBHOOK --------------------
async function bitrixCall(method, params = {}) {
  if (!BITRIX_WEBHOOK_BASE) {
    throw new Error("Missing BITRIX_WEBHOOK_BASE env var");
  }

  const url = `${BITRIX_WEBHOOK_BASE}/${method}.json`;

  try {
    const resp = await axios.post(
      url,
      new URLSearchParams(params),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      }
    );
    return resp.data;
  } catch (e) {
    const msg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`Bitrix HTTP ${e?.response?.status || "ERR"}: ${msg}`);
  }
}

// Bind Voximplant events -> your handler URL
async function bindVoximplantEvents() {
  if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL env var");
  if (!BITRIX_WEBHOOK_BASE) throw new Error("Missing BITRIX_WEBHOOK_BASE env var");

  const events = [
    "OnVoximplantCallInit",
    "OnVoximplantCallStart",
    "OnVoximplantCallConnected",
    "OnVoximplantCallEnd",
  ];

  const results = [];

  for (const ev of events) {
    try {
      const r = await bitrixCall("event.bind", {
        event: ev,
        handler: HANDLER_URL,
      });
      results.push({ event: ev, ok: true, result: r });
    } catch (err) {
      results.push({ event: ev, ok: false, error: err.message });
    }
  }

  return results;
}

// Optional helper: unbind first (useful when handler changes)
// async function unbindVoximplantEvents() {
//   const events = ["OnVoximplantCallInit","OnVoximplantCallStart","OnVoximplantCallConnected","OnVoximplantCallEnd"];
//   const results = [];
//   for (const ev of events) {
//     try {
//       const r = await bitrixCall("event.unbind", { event: ev, handler: HANDLER_URL });
//       results.push({ event: ev, ok: true, result: r });
//     } catch (err) {
//       results.push({ event: ev, ok: false, error: err.message });
//     }
//   }
//   return results;
// }

// -------------------- WALLBOARD STATE + METRICS --------------------
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

const liveCalls = new Map(); // callId -> {direction, agentId, startedAt, from, to}
const agents = new Map(); // agentId -> {agentId, name, onCallNow, inboundAnswered, inboundMissed, outboundAnswered, outboundMissed}

function clampDown(obj, key) {
  if (!obj || typeof obj[key] !== "number") return;
  obj[key] = Math.max(0, obj[key] - 1);
}

function ensureAgent(agentId, name) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      name: name || "",
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
    });
  } else if (name && agents.get(agentId).name !== name) {
    agents.get(agentId).name = name;
  }
  return agents.get(agentId);
}

// -------------------- WS BROADCAST --------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

function snapshot() {
  return {
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    handlerUrl: HANDLER_URL,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
    agents: Array.from(agents.values()),
  };
}

function broadcast() {
  const payload = JSON.stringify(snapshot());
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(snapshot()));
});

// -------------------- ROUTES --------------------
app.get("/", (req, res) => res.send("Bitrix24 Wallboard Backend is running."));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => res.json(snapshot()));

// ---- INSTALL ENDPOINT (Bitrix app install callback) ----
app.post("/bitrix/install", async (req, res) => {
  try {
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
    console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

    const domain =
      req.query.DOMAIN || req.body.DOMAIN || req.body.domain || "unknown-domain";
    const memberId = req.body.member_id || req.body.MEMBER_ID || "unknown-member";

    const key = `${domain}|${memberId}`;
    portalTokens[key] = {
      domain,
      memberId,
      installedAt: new Date().toISOString(),
    };

    saveTokens(portalTokens);
    console.log("✅ INSTALL stored portal key:", key);
    console.log("💾 Tokens saved to:", TOKENS_FILE);

    console.log("📌 Binding events to handler:", HANDLER_URL);
    const bindResults = await bindVoximplantEvents();
    console.log("📌 event.bind results:", bindResults);

    return res.json({ ok: true, bound: bindResults });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- EVENTS ENDPOINT (Bitrix will POST here) ----
app.post("/bitrix/events", (req, res) => {
  // Respond fast
  res.json({ ok: true });

  // Bitrix payload can differ; handle both styles
  const eventName = req.body.event || req.body.EVENT || "unknown";
  const data = req.body.data || req.body.DATA || req.body || {};

  console.log("📨 EVENT received:", eventName);

  // Attempt to extract callId + direction + agent
  const callId =
    data.CALL_ID || data.callId || data.call_id || data?.FIELDS?.CALL_ID || data?.FIELDS?.callId;

  const directionRaw =
    data.DIRECTION || data.direction || data.callDirection || data?.FIELDS?.DIRECTION || "";

  const direction =
    (directionRaw || "").toString().toUpperCase().includes("OUT") ? "OUT" : "IN";

  const from =
    data.FROM || data.from || data.CALLER_ID || data?.FIELDS?.FROM || data?.FIELDS?.CALLER_ID;

  const to =
    data.TO || data.to || data.PHONE_NUMBER || data?.FIELDS?.TO || data?.FIELDS?.PHONE_NUMBER;

  const agentId =
    data.USER_ID || data.userId || data.agentId || data?.FIELDS?.USER_ID || data?.FIELDS?.userId;

  const agentName =
    data.USER_NAME || data.userName || data.agentName || data?.FIELDS?.USER_NAME || data?.FIELDS?.userName;

  // ----- Update metrics based on event -----
  // Note: This is a best-effort mapping. If your Bitrix event payload includes status/result fields,
  // we can refine answered/missed/cancelled logic precisely.
  if (!callId) {
    console.log("⚠️  Event missing callId; skipping metrics update.");
    return;
  }

  if (eventName === "OnVoximplantCallInit") {
    // A call exists, usually ringing/initializing
    if (direction === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    liveCalls.set(callId, {
      direction,
      agentId: agentId ? String(agentId) : null,
      startedAt: new Date().toISOString(),
      from: from || null,
      to: to || null,
    });

    if (agentId) {
      const a = ensureAgent(String(agentId), agentName);
      if (a) a.onCallNow = true;
    }

    broadcast();
    return;
  }

  if (eventName === "OnVoximplantCallConnected") {
    // Treat as answered
    const lc = liveCalls.get(callId);
    const dir = lc?.direction || direction;

    if (dir === "IN") {
      clampDown(metrics.incoming, "inProgress");
      metrics.incoming.answered += 1;
      if (lc?.agentId) {
        const a = ensureAgent(String(lc.agentId), agentName);
        if (a) a.inboundAnswered += 1;
      }
    } else {
      clampDown(metrics.outgoing, "inProgress");
      metrics.outgoing.answered += 1;
      if (lc?.agentId) {
        const a = ensureAgent(String(lc.agentId), agentName);
        if (a) a.outboundAnswered += 1;
      }
    }

    broadcast();
    return;
  }

  if (eventName === "OnVoximplantCallEnd") {
    const lc = liveCalls.get(callId);
    if (!lc) {
      // If we never saw init, still try to clamp
      if (direction === "IN") clampDown(metrics.incoming, "inProgress");
      else clampDown(metrics.outgoing, "inProgress");
      broadcast();
      return;
    }

    // Heuristic: if it ended without connect => missed/cancelled
    // If you have a field like data.STATUS or data.CALL_FAILED, we can use that instead.
    const assumedConnected = false; // unknown with current payload
    if (!assumedConnected) {
      if (lc.direction === "IN") {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        if (lc.agentId) {
          const a = ensureAgent(String(lc.agentId), agentName);
          if (a) a.inboundMissed += 1;
        }
      } else {
        metrics.outgoing.cancelled += 1;
        if (lc.agentId) {
          const a = ensureAgent(String(lc.agentId), agentName);
          if (a) a.outboundMissed += 1;
        }
      }
    }

    // always decrement inProgress on end
    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    if (lc.agentId) {
      const a = ensureAgent(String(lc.agentId), agentName);
      if (a) a.onCallNow = false;
    }

    liveCalls.delete(callId);
    broadcast();
    return;
  }

  // OnVoximplantCallStart or other events: keep as signal/heartbeat
  if (eventName === "OnVoximplantCallStart") {
    // Some installs send Start before Init; ensure liveCalls exists
    if (!liveCalls.has(callId)) {
      if (direction === "IN") metrics.incoming.inProgress += 1;
      else metrics.outgoing.inProgress += 1;

      liveCalls.set(callId, {
        direction,
        agentId: agentId ? String(agentId) : null,
        startedAt: new Date().toISOString(),
        from: from || null,
        to: to || null,
      });

      if (agentId) {
        const a = ensureAgent(String(agentId), agentName);
        if (a) a.onCallNow = true;
      }
    }
    broadcast();
    return;
  }

  // default: just broadcast state update if needed
  broadcast();
});


// -------------------- WEBSOCKET --------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Send initial state immediately
  const snapshot = {
    ok: true,
    metrics,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, c]) => ({ callId, ...c })),
    agents: Array.from(agents.values()),
  };
  ws.send(JSON.stringify(snapshot));
});

// -------------------- LISTEN --------------------
const PORT = parseInt(process.env.PORT || "3000", 10);

// IMPORTANT: only ONE listen. Railway must see this port open.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  if (!BITRIX_WEBHOOK_BASE) {
    console.log("⚠️ BITRIX_WEBHOOK_BASE is not set (event.bind will fail).");
  }
  if (!PUBLIC_URL) {
    console.log("⚠️ PUBLIC_URL is not set (handler URL will be wrong).");
  } else {
    console.log("🔗 Handler URL:", getHandlerUrl());
  }
});

setInterval(() => console.log("🫀 alive", new Date().toISOString()), 30000);
