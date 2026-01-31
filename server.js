"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();

/**
 * Railway/Reverse-proxy notes:
 * - Always listen on process.env.PORT
 * - Build external base URL using X-Forwarded-* headers
 */

// ---------- Config / Storage ----------
const DATA_DIR = (process.env.DATA_DIR || "/data").trim();
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ Failed reading JSON:", file, e.message);
    return fallback;
  }
}

function safeWriteJsonAtomic(file, obj) {
  try {
    ensureDirSync(path.dirname(file));
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error("❌ Failed writing JSON:", file, e.message);
    return false;
  }
}

let portalTokens = safeReadJson(TOKENS_FILE, {}); // { "<domain>|<member_id>": { domain, memberId, authId, refreshId, serverEndpoint, savedAt } }

console.log(`🚀 Boot`);
console.log(`💾 Tokens file: ${TOKENS_FILE}`);
console.log(`🔑 Tokens loaded: ${Object.keys(portalTokens).length}`);

// ---------- In-memory wallboard state ----------
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

const liveCalls = new Map(); // callId -> { direction, agentId, startedAt }
const agents = new Map(); // agentId -> { agentId, onCallNow, inboundMissed, outboundMissed }

// ---------- Websocket (push updates to wallboard UI) ----------
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast() {
  const payload = JSON.stringify({
    ok: true,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
    agents: Array.from(agents.values()),
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  // send initial state
  ws.send(
    JSON.stringify({
      ok: true,
      metrics,
      liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
      agents: Array.from(agents.values()),
      portalsStored: Object.keys(portalTokens).length,
      tokensFile: TOKENS_FILE,
    })
  );
});

// ---------- Middleware ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true })); // Bitrix install posts x-www-form-urlencoded

// ---------- Helpers ----------
function clampDown(obj, key) {
  if (typeof obj[key] !== "number") obj[key] = 0;
  obj[key] = Math.max(0, obj[key] - 1);
}

function ensureAgent(agentId) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      onCallNow: false,
      inboundMissed: 0,
      outboundMissed: 0,
    });
  }
  return agents.get(agentId);
}

function getPublicBaseUrl(req) {
  // best effort for Railway / proxy
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

async function bitrixCall(serverEndpoint, method, params) {
  // Bitrix REST typically: {serverEndpoint}{method}.json
  // Example serverEndpoint: https://contactcenter.fincorp.com.pg/rest/
  const url = `${serverEndpoint.replace(/\/+$/, "")}/${method}.json`;

  const resp = await axios.post(url, params, {
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  if (resp.status >= 200 && resp.status < 300) return resp.data;
  throw new Error(`Bitrix REST error ${resp.status}: ${JSON.stringify(resp.data).slice(0, 300)}`);
}

async function bindTelephonyEvents({ serverEndpoint, authId, handlerUrl }) {
  // Bind only what we need. You can add more later.
  const eventsToBind = [
    "OnVoximplantCallInit",
    "OnVoximplantCallStart",
    "OnVoximplantCallConnected",
    "OnVoximplantCallEnd",
  ];

  const results = [];
  for (const ev of eventsToBind) {
    try {
      const data = await bitrixCall(serverEndpoint, "event.bind", {
        auth: authId,
        event: ev,
        handler: handlerUrl,
      });
      results.push({ event: ev, ok: true, data });
    } catch (e) {
      results.push({ event: ev, ok: false, error: e.message });
    }
  }
  return results;
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.status(200).send("Bitrix24 Wallboard Backend is running.");
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => {
  res.json({
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
    agents: Array.from(agents.values()),
  });
});

// Optional: quick check whether tokens exist
app.get("/debug/offline", (req, res) => {
  const count = Object.keys(portalTokens).length;
  if (!count) return res.status(400).json({ error: "No portal token stored yet. Reinstall the Bitrix app first." });
  res.json({ ok: true, portalsStored: count, tokensFile: TOKENS_FILE });
});

/**
 * Bitrix install handler:
 * Bitrix sends x-www-form-urlencoded (body) with AUTH_ID, REFRESH_ID, SERVER_ENDPOINT, member_id, etc.
 * Query often has DOMAIN.
 */
app.post("/bitrix/install", async (req, res) => {
  const domain = (req.query.DOMAIN || req.body.DOMAIN || "").toString().trim();
  const authId = (req.body.AUTH_ID || "").toString().trim();
  const refreshId = (req.body.REFRESH_ID || "").toString().trim();
  const serverEndpoint = (req.body.SERVER_ENDPOINT || "").toString().trim();
  const memberId = (req.body.member_id || req.body.MEMBER_ID || "").toString().trim();

  console.log(`🔧 INSTALL content-type: ${req.headers["content-type"]}`);
  console.log(`🔧 INSTALL query keys:`, Object.keys(req.query || {}));
  console.log(`🔧 INSTALL body keys:`, Object.keys(req.body || {}));

  if (!domain || !authId || !serverEndpoint || !memberId) {
    console.log("❌ INSTALL missing params:", {
      domain: !!domain,
      authId: !!authId,
      serverEndpoint: !!serverEndpoint,
      memberId: !!memberId,
    });
    return res.status(400).json({ error: "Missing install parameters", domain, memberIdPresent: !!memberId });
  }

  const key = `${domain}|${memberId}`;
  portalTokens[key] = {
    domain,
    memberId,
    authId,
    refreshId,
    serverEndpoint,
    savedAt: new Date().toISOString(),
  };

  const ok = safeWriteJsonAtomic(TOKENS_FILE, portalTokens);
  console.log(`✅ INSTALL stored token for: ${key}`);
  console.log(`💾 Tokens saved to: ${TOKENS_FILE}`);

  // Bind telephony events to your public handler
  const baseUrl = getPublicBaseUrl(req);
  const handlerUrl = `${baseUrl}/bitrix/events`;
  console.log(`📌 Binding events to handler: ${handlerUrl}`);

  let bindResults = [];
  try {
    bindResults = await bindTelephonyEvents({ serverEndpoint, authId, handlerUrl });
    console.log("📌 event.bind results:", bindResults);
  } catch (e) {
    console.log("❌ event.bind failed:", e.message);
  }

  // Redirect back to app root (Bitrix is OK with 302)
  return res.status(302).set("Location", "/").end();
});

/**
 * Bitrix event receiver:
 * MUST be POST. GET should be "Method Not Allowed" (your current behavior is correct).
 */
app.all("/bitrix/events", (req, res, next) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed. Use POST /bitrix/events");
  next();
});

app.post("/bitrix/events", (req, res) => {
  // Bitrix may send different shapes; we’ll support several common patterns
  const body = req.body || {};
  const eventName = body.event || body.EVENT || body.eventName || body.type;

  // callId may appear under different keys
  const callId =
    body.callId ||
    body.CALL_ID ||
    body.data?.CALL_ID ||
    body.data?.callId ||
    body.data?.CALL_ID?.toString() ||
    body.data?.callId?.toString();

  // Try to infer direction (IN/OUT) if provided
  const direction =
    body.direction ||
    body.DIRECTION ||
    body.data?.DIRECTION ||
    body.data?.direction ||
    null;

  // Agent/user id may appear in different structures
  const agentId =
    body.agentId ||
    body.AGENT_ID ||
    body.userId ||
    body.USER_ID ||
    body.data?.USER_ID ||
    body.data?.userId ||
    body.data?.AGENT_ID ||
    body.data?.agentId ||
    null;

  console.log("📨 EVENT:", eventName, "callId:", callId, "dir:", direction, "agent:", agentId);

  // If Bitrix sends a test ping-like event, just ACK
  if (!eventName) {
    return res.status(200).json({ ok: true, note: "No event name found", receivedKeys: Object.keys(body) });
  }

  // ---- EVENT LOGIC ----
  if (eventName === "OnVoximplantCallInit" || eventName === "OnVoximplantCallStart") {
    // count in-progress
    const dir = (direction || "IN").toString().toUpperCase().includes("OUT") ? "OUT" : "IN";
    if (dir === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    if (callId) {
      liveCalls.set(callId.toString(), {
        direction: dir,
        agentId: agentId ? agentId.toString() : null,
        startedAt: new Date().toISOString(),
      });
    }

    if (agentId) {
      const a = ensureAgent(agentId.toString());
      if (a) a.onCallNow = true; // “ringing/handling” state
    }

    broadcast();
    return res.status(200).json({ ok: true });
  }

  if (eventName === "OnVoximplantCallConnected") {
    // mark answered (still in-progress, but connected)
    const dir = (direction || "IN").toString().toUpperCase().includes("OUT") ? "OUT" : "IN";
    if (dir === "IN") metrics.incoming.answered += 1;
    else metrics.outgoing.answered += 1;

    if (callId && liveCalls.has(callId.toString())) {
      const lc = liveCalls.get(callId.toString());
      lc.connectedAt = new Date().toISOString();
      liveCalls.set(callId.toString(), lc);
    }

    broadcast();
    return res.status(200).json({ ok: true });
  }

  if (eventName === "OnVoximplantCallEnd") {
    const id = callId ? callId.toString() : null;
    const lc = id ? liveCalls.get(id) : null;

    // If we never saw call start, still ACK
    if (!lc) {
      broadcast();
      return res.status(200).json({ ok: true, note: "call not found in liveCalls" });
    }

    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    // Basic tally:
    // - If connectedAt exists -> it was answered
    // - If not connected -> treat as missed/cancelled
    const connected = !!lc.connectedAt;

    if (lc.direction === "IN") {
      if (!connected) {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) a.inboundMissed += 1;
        }
      }
    } else {
      if (!connected) {
        metrics.outgoing.cancelled += 1;
        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) a.outboundMissed += 1;
        }
      }
    }

    if (lc.agentId) {
      const a = ensureAgent(lc.agentId);
      if (a) a.onCallNow = false;
    }

    liveCalls.delete(id);
    broadcast();
    return res.status(200).json({ ok: true });
  }

  // Unknown event — still ACK so Bitrix doesn’t retry
  return res.status(200).json({ ok: true, ignored: eventName });
});

// ---------- Start server ----------
const PORT = process.env.PORT || 8080; // Railway sets PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log(`💾 Tokens file: ${TOKENS_FILE}`);
  console.log(`🔑 Tokens loaded: ${Object.keys(portalTokens).length}`);
});
