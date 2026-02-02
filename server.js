/**
 * Bitrix24 Wallboard Backend (Railway-ready)
 * - Uses Incoming Webhook for REST calls (prevents WRONG_AUTH_TYPE)
 * - Pins handler URL to HTTPS using PUBLIC_URL
 * - Persists portal install info to a file (DATA_DIR)
 * - Receives Bitrix events at POST /bitrix/events
 * - Tracks basic inbound/outbound metrics + live calls
 * - Broadcasts state over WebSocket to connected wallboards
 *
 * Required Railway env vars:
 *  - BITRIX_WEBHOOK_BASE = https://contactcenter.fincorp.com.pg/rest/1/xxxxxxxxxxxx
 *  - PUBLIC_URL         = https://bitrix24-wallboard1-production.up.railway.app
 *  - DATA_DIR           = /data   (Railway volume mount)
 *  - PORT               = 3000    (recommended)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const axios = require("axios");
const { WebSocketServer } = require("ws");

// -------------------- CONFIG --------------------
const app = express();

// Accept both Bitrix formats:
// 1) application/json
// 2) application/x-www-form-urlencoded
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= BITRIX REST (INCOMING WEBHOOK) =================

function normalizeBase(u) {
  return (u || "").replace(/\/+$/, "");
}

const BITRIX_WEBHOOK_BASE = normalizeBase(process.env.BITRIX_WEBHOOK_BASE);
const PUBLIC_URL = normalizeBase(process.env.PUBLIC_URL);
const HANDLER_URL = `${PUBLIC_URL}/bitrix/events`;

console.log("🔗 Handler URL:", HANDLER_URL);

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
    const msg = e?.response?.data
      ? JSON.stringify(e.response.data)
      : e.message;
    throw new Error(`Bitrix HTTP ${e?.response?.status || "ERR"}: ${msg}`);
  }
}

async function bindVoximplantEvents() {
  if (!PUBLIC_URL) {
    throw new Error("Missing PUBLIC_URL env var");
  }

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




// Safety for Railway / production
process.on("unhandledRejection", (reason) => {
  console.error("❌ UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ UncaughtException:", err);
});

const BITRIX_WEBHOOK_BASE = (process.env.BITRIX_WEBHOOK_BASE || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const DATA_DIR = (process.env.DATA_DIR || path.join(__dirname, "data")).trim();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

console.log("🚀 Boot");
console.log("💾 Tokens file:", TOKENS_FILE);

// -------------------- STATE --------------------
function safeReadJson(filepath, fallback) {
  try {
    if (!fs.existsSync(filepath)) return fallback;
    const raw = fs.readFileSync(filepath, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("⚠️ Failed reading JSON:", filepath, e.message);
    return fallback;
  }
}

function safeWriteJson(filepath, obj) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("⚠️ Failed writing JSON:", filepath, e.message);
    return false;
  }
}

// Minimal portal store (install visibility / debugging)
let portalTokens = safeReadJson(TOKENS_FILE, {});
console.log("🔑 Tokens loaded:", Object.keys(portalTokens).length);

// Call metrics
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

// Live calls keyed by callId
const liveCalls = new Map(); // callId -> { direction, agentId, connected, startedAt, from, to }
const agents = new Map(); // agentId -> { agentId, name, onCallNow, inboundAnswered, inboundMissed, outboundAnswered, outboundMissed }

// -------------------- HELPERS --------------------
function clampDown(obj, key) {
  obj[key] = Math.max(0, (obj[key] || 0) - 1);
}

function ensureAgent(agentId, name) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      name: name || `Agent ${agentId}`,
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
    });
  }
  return agents.get(agentId);
}

function getHandlerUrl() {
  // Pin HTTPS always (your Fix 2)
  // PUBLIC_URL should be like: https://bitrix24-wallboard1-production.up.railway.app
  const base = (PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/bitrix/events`;
}

function normalizeWebhookBase() {
  // User supplies: https://domain/rest/1/xxxxxxx
  // We'll remove trailing slashes
  return (BITRIX_WEBHOOK_BASE || "").replace(/\/+$/, "");
}

async function bitrixCall(method, params = {}) {
  const base = normalizeWebhookBase();
  if (!base) throw new Error("Missing BITRIX_WEBHOOK_BASE env var.");

  // Bitrix REST via webhook typically supports: <base>/<method>.json
  // Example: https://portal/rest/1/xxxx/event.bind.json
  const url = `${base}/${method}.json`;

  // Bitrix accepts either query params or form body. We'll use POST form-style.
  // Some portals are strict; POST with URLSearchParams is very compatible.
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  });

  const resp = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    const msg = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    throw new Error(`Bitrix HTTP ${resp.status}: ${msg}`);
  }
  if (resp.data && resp.data.error) {
    throw new Error(`Bitrix REST error: ${JSON.stringify(resp.data)}`);
  }
  return resp.data;
}

async function bindVoximplantEvents() {
  const handler = getHandlerUrl();
  console.log("📌 Binding events to handler:", handler);

  const events = [
    "OnVoximplantCallInit",
    "OnVoximplantCallStart",
    "OnVoximplantCallConnected",
    "OnVoximplantCallEnd",
  ];

  const results = [];
  for (const ev of events) {
    try {
      const r = await bitrixCall("event.bind", { event: ev, handler });
      results.push({ event: ev, ok: true, result: r });
    } catch (e) {
      results.push({ event: ev, ok: false, error: e.message });
    }
  }

  console.log("📌 event.bind results:", results);
  return results;
}

function extractEventName(body) {
  return body?.event || body?.EVENT || body?.Event || "unknown";
}

function extractData(body) {
  // Bitrix sometimes sends `data`, `DATA`, or nested.
  return body?.data || body?.DATA || body?.params || body?.PARAMS || body?.["data[FIELDS]"] || body;
}

function pick(obj, keys, fallback = null) {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function normalizeDirection(val) {
  const s = String(val || "").toUpperCase();
  if (s.includes("IN")) return "IN";
  if (s.includes("OUT")) return "OUT";
  // Some payloads use 1/2
  if (s === "1") return "IN";
  if (s === "2") return "OUT";
  return null;
}

function normalizeCallId(val) {
  if (val === undefined || val === null) return null;
  return String(val);
}

function broadcast() {
  const snapshot = {
    ok: true,
    metrics,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, c]) => ({ callId, ...c })),
    agents: Array.from(agents.values()),
  };

  const msg = JSON.stringify(snapshot);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => res.send("Bitrix24 Wallboard Backend is running."));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => {
  res.json({
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, c]) => ({ callId, ...c })),
    agents: Array.from(agents.values()),
    publicUrl: PUBLIC_URL,
    handlerUrl: PUBLIC_URL ? getHandlerUrl() : null,
    bitrixWebhookSet: !!BITRIX_WEBHOOK_BASE,
  });
});

// Optional: allow a manual rebind from browser (protect with a secret if you want)
app.post("/debug/rebind", async (req, res) => {
  try {
    const results = await bindVoximplantEvents();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- INSTALL ENDPOINT (Bitrix app install callback) ----------
app.post("/bitrix/install", async (req, res) => {
  try {
    const domain = req.query.DOMAIN || "unknown";
    const memberId = req.body.member_id || "unknown";

    const key = `${domain}|${memberId}`;
    portalTokens[key] = {
      domain,
      memberId,
      installedAt: new Date().toISOString(),
    };

    saveTokens(portalTokens);

    console.log("✅ INSTALL stored portal key:", key);

    // 🔥 THIS IS THE ONLY PLACE WE BIND EVENTS
    const bindResults = await bindVoximplantEvents();

    res.json({ ok: true, bound: bindResults });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


    // Bind events using Incoming Webhook (BITRIX_WEBHOOK_BASE) not AUTH_ID
    const bindResults = await bindVoximplantEvents();

    return res.json({ ok: true, bound: bindResults });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- EVENTS ENDPOINT (Bitrix will POST here) ----------
app.post("/bitrix/events", (req, res) => {
  // Respond fast to Bitrix
  res.json({ ok: true });

  const eventName = extractEventName(req.body);
  const data = extractData(req.body) || {};

  console.log("📨 EVENT received:", eventName);

  // Try to grab a call id and direction from many possible keys
  const callId = normalizeCallId(
    pick(data, ["CALL_ID", "callId", "CALLID", "ID", "id", "CALL_ID_INTERNAL"])
  );

  const direction = normalizeDirection(
    pick(data, ["CALL_DIRECTION", "direction", "DIRECTION", "CALL_TYPE", "type"])
  );

  const from = pick(data, ["PHONE_NUMBER", "FROM", "from", "CALL_FROM", "callerId"]);
  const to = pick(data, ["PORTAL_NUMBER", "TO", "to", "CALL_TO", "callee"]);
  const agentId = pick(data, ["PORTAL_USER_ID", "agentId", "AGENT_ID", "USER_ID", "userId"]);
  const agentName = pick(data, ["PORTAL_USER_NAME", "agentName", "USER_NAME", "userName"]);

  // We can’t update liveCalls without a callId.
  // Still log payload hints so you can adjust mapping if needed.
  if (!callId) {
    console.log("⚠️ EVENT missing callId. Keys:", Object.keys(data));
    return;
  }

  // Ensure agent record if present
  const a = ensureAgent(agentId, agentName);

  // Create or get live call
  if (!liveCalls.has(callId)) {
    liveCalls.set(callId, {
      direction: direction || "UNKNOWN",
      agentId: agentId || null,
      agentName: agentName || null,
      connected: false,
      startedAt: new Date().toISOString(),
      from: from || null,
      to: to || null,
    });
  }

  const lc = liveCalls.get(callId);

  // Update any missing fields
  if (direction && lc.direction === "UNKNOWN") lc.direction = direction;
  if (agentId && !lc.agentId) lc.agentId = agentId;
  if (agentName && !lc.agentName) lc.agentName = agentName;
  if (from && !lc.from) lc.from = from;
  if (to && !lc.to) lc.to = to;

  // Basic logic by event type
  if (eventName === "OnVoximplantCallInit" || eventName === "OnVoximplantCallStart") {
    if (lc.direction === "IN") metrics.incoming.inProgress += 1;
    else if (lc.direction === "OUT") metrics.outgoing.inProgress += 1;

    if (a) a.onCallNow = true;

    broadcast();
    return;
  }

  if (eventName === "OnVoximplantCallConnected") {
    lc.connected = true;

    // Still in progress; mark agent as on call
    if (a) a.onCallNow = true;

    broadcast();
    return;
  }

  if (eventName === "OnVoximplantCallEnd") {
    // Decrement inProgress
    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else if (lc.direction === "OUT") clampDown(metrics.outgoing, "inProgress");

    // Determine outcome
    if (lc.direction === "IN") {
      if (lc.connected) {
        metrics.incoming.answered += 1;
        if (a) a.inboundAnswered += 1;
      } else {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        if (a) a.inboundMissed += 1;
      }
    } else if (lc.direction === "OUT") {
      if (lc.connected) {
        metrics.outgoing.answered += 1;
        if (a) a.outboundAnswered += 1;
      } else {
        metrics.outgoing.cancelled += 1;
        if (a) a.outboundMissed += 1;
      }
    }

    if (a) a.onCallNow = false;

    liveCalls.delete(callId);
    broadcast();
    return;
  }

  // Unknown Voximplant event; still broadcast so UI can show activity
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
