/**
 * server.js - Bitrix24 Wallboard Backend (Railway + persistent token storage)
 *
 * IMPORTANT:
 * - Must listen on process.env.PORT
 * - Tokens must persist across restarts (Railway SIGTERM restarts wipe RAM)
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();

// Accept both x-www-form-urlencoded and JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ----------------------------
// Persistent storage (file)
// ----------------------------

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("❌ Failed to create data dir:", DATA_DIR, e);
  }
}

function loadTokensFromDisk() {
  ensureDataDir();
  try {
    if (!fs.existsSync(TOKENS_FILE)) return new Map();
    const raw = fs.readFileSync(TOKENS_FILE, "utf8");
    if (!raw) return new Map();
    const obj = JSON.parse(raw); // { key: tokenObj }
    return new Map(Object.entries(obj));
  } catch (e) {
    console.error("❌ Failed to load tokens from disk:", e);
    return new Map();
  }
}

function saveTokensToDisk(tokensMap) {
  ensureDataDir();
  try {
    const obj = Object.fromEntries(tokensMap.entries());
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to save tokens to disk:", e);
  }
}

// ----------------------------
// In-memory state
// ----------------------------

let portalTokens = loadTokensFromDisk(); // Map key = `${domain}|${memberId}`

const liveCalls = new Map();
const agents = new Map();

const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

function clampDown(bucket, key) {
  bucket[key] = Math.max(0, (bucket[key] || 0) - 1);
}
function clampUp(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function ensureAgent(agentId, name) {
  if (!agentId) return null;
  const id = String(agentId);
  if (!agents.has(id)) {
    agents.set(id, {
      agentId: id,
      name: name || null,
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundCancelled: 0,
    });
  } else if (name) {
    const a = agents.get(id);
    a.name = a.name || name;
  }
  return agents.get(id);
}

function getCallId(payload = {}) {
  return (
    payload.callId ||
    payload.CALL_ID ||
    payload.call_id ||
    payload?.data?.CALL_ID ||
    payload?.data?.callId ||
    payload?.data?.call_id ||
    payload?.["data[CALL_ID]"] ||
    null
  );
}

function getDirection(payload = {}) {
  const d =
    payload.direction ||
    payload.DIRECTION ||
    payload?.data?.DIRECTION ||
    payload?.data?.direction ||
    payload?.["data[DIRECTION]"] ||
    null;

  if (!d) return null;
  const s = String(d).toUpperCase();
  if (s.includes("IN")) return "IN";
  if (s.includes("OUT")) return "OUT";
  return null;
}

function getAgentId(payload = {}) {
  return (
    payload.agentId ||
    payload.AGENT_ID ||
    payload.userId ||
    payload.USER_ID ||
    payload?.data?.USER_ID ||
    payload?.data?.userId ||
    payload?.["data[USER_ID]"] ||
    null
  );
}

// ----------------------------
// WebSocket
// ----------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function snapshot() {
  return {
    ok: true,
    portalsStored: portalTokens.size,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: Array.from(liveCalls.values()),
    agents: Array.from(agents.values()),
  };
}

function broadcast() {
  const msg = JSON.stringify({ type: "state", data: snapshot() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", data: snapshot() }));
});

// ----------------------------
// Routes
// ----------------------------

app.get("/", (req, res) => {
  res.status(200).send("Bitrix24 Wallboard Backend is running.");
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => res.json(snapshot()));

app.get("/debug/offline", (req, res) => {
  if (portalTokens.size < 1) {
    return res.status(400).json({
      error: "No portal token stored yet. Reinstall the Bitrix app first.",
      tokensFile: TOKENS_FILE,
    });
  }
  return res.json({
    ok: true,
    portalsStored: portalTokens.size,
    keys: Array.from(portalTokens.keys()),
    tokensFile: TOKENS_FILE,
  });
});

// Bitrix install (stores token to disk)
app.post("/bitrix/install", (req, res) => {
  const ct = req.headers["content-type"] || "";
  const domain =
    req.query.DOMAIN ||
    req.query.domain ||
    req.body.DOMAIN ||
    req.body.domain ||
    null;

  const memberId =
    req.body.member_id ||
    req.body.MEMBER_ID ||
    req.query.member_id ||
    req.query.MEMBER_ID ||
    null;

  console.log("🔧 INSTALL content-type:", ct);
  console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
  console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

  const authId = req.body.AUTH_ID || req.body.auth_id || null;
  const refreshId = req.body.REFRESH_ID || req.body.refresh_id || null;
  const serverEndpoint =
    req.body.SERVER_ENDPOINT || req.body.server_endpoint || null;

  if (!domain || !memberId) {
    console.log("❌ INSTALL missing params:", {
      domain: !!domain,
      memberId: !!memberId,
    });
    return res.status(400).json({
      ok: false,
      error: "Missing DOMAIN or member_id in install payload.",
    });
  }

  const key = `${domain}|${memberId}`;
  portalTokens.set(key, {
    domain,
    memberId,
    authId,
    refreshId,
    serverEndpoint,
    createdAt: new Date().toISOString(),
  });

  saveTokensToDisk(portalTokens);

  console.log("✅ INSTALL stored token for:", key);
  console.log("💾 Tokens saved to:", TOKENS_FILE);

  return res.redirect(302, "/");
});

// Events endpoint (must be POST)
app.post("/bitrix/events", (req, res) => {
  const eventName = req.body.event || req.body.EVENT || req.query.event || null;

  console.log("📩 EVENT received:", {
    event: eventName,
    contentType: req.headers["content-type"],
    bodyKeys: Object.keys(req.body || {}),
  });

  if (!eventName) {
    return res.status(400).json({ ok: false, error: "Missing event name" });
  }

  const callId = getCallId(req.body);
  const direction = getDirection(req.body);
  const agentId = getAgentId(req.body);

  if (eventName === "OnVoximplantCallStart" || eventName === "OnVoximplantCallInit") {
    if (callId && !liveCalls.has(callId)) {
      const dir = direction || "IN";
      liveCalls.set(callId, {
        callId,
        direction: dir,
        agentId: agentId ? String(agentId) : null,
        startedAt: Date.now(),
        connectedAt: null,
      });

      if (dir === "IN") clampUp(metrics.incoming, "inProgress");
      else clampUp(metrics.outgoing, "inProgress");

      const a = ensureAgent(agentId);
      if (a) a.onCallNow = true;

      broadcast();
    }
    return res.json({ ok: true });
  }

  if (eventName === "OnVoximplantCallConnected") {
    if (callId) {
      if (!liveCalls.has(callId)) {
        const dir = direction || "IN";
        liveCalls.set(callId, {
          callId,
          direction: dir,
          agentId: agentId ? String(agentId) : null,
          startedAt: Date.now(),
          connectedAt: Date.now(),
          _answeredCounted: false,
        });

        if (dir === "IN") clampUp(metrics.incoming, "inProgress");
        else clampUp(metrics.outgoing, "inProgress");
      }

      const lc = liveCalls.get(callId);
      lc.connectedAt = lc.connectedAt || Date.now();
      lc.agentId = lc.agentId || (agentId ? String(agentId) : null);

      if (!lc._answeredCounted) {
        lc._answeredCounted = true;
        if (lc.direction === "IN") metrics.incoming.answered += 1;
        else metrics.outgoing.answered += 1;

        const a = ensureAgent(lc.agentId);
        if (a) a.onCallNow = true;
      }

      broadcast();
    }
    return res.json({ ok: true });
  }

  if (eventName === "OnVoximplantCallEnd") {
    if (!callId) return res.json({ ok: true });

    const lc = liveCalls.get(callId);
    if (!lc) return res.json({ ok: true });

    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    const wasConnected = !!lc.connectedAt;

    if (!wasConnected) {
      if (lc.direction === "IN") {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        const a = ensureAgent(lc.agentId);
        if (a) a.inboundMissed += 1;
      } else {
        metrics.outgoing.cancelled += 1;
        const a = ensureAgent(lc.agentId);
        if (a) a.outboundCancelled += 1;
      }
    }

    if (lc.agentId) {
      const a = ensureAgent(lc.agentId);
      if (a) a.onCallNow = false;
    }

    liveCalls.delete(callId);
    broadcast();
    return res.json({ ok: true });
  }

  return res.json({ ok: true, ignored: true, event: eventName });
});

app.get("/bitrix/events", (req, res) => {
  res.status(405).send("Method Not Allowed. Use POST /bitrix/events");
});

// ----------------------------
// Start
// ----------------------------

// MUST exist on Railway, do not default to 8080 for this stack
const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error("❌ process.env.PORT is missing. Railway must provide PORT.");
  process.exit(1);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log(`💾 Tokens file: ${TOKENS_FILE}`);
  console.log(`🔑 Tokens loaded: ${portalTokens.size}`);
});
