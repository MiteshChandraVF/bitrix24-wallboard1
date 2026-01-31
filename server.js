/* server.js - Bitrix24 Wallboard Receiver (Railway) */
const express = require("express");
const http = require("http");
const path = require("path");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();

/**
 * Body parsers
 * Bitrix install often comes as application/x-www-form-urlencoded
 * Events may be JSON or form-urlencoded depending on sender
 */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/** ---------------------------
 * In-memory state
 * -------------------------- */
const portals = new Map(); // key: domain|member_id -> { domain, memberId, authId, refreshId, serverEndpoint, storedAt }
const liveCalls = new Map(); // callId -> { direction, agentId, startedAt }
const agents = new Map(); // agentId -> { id, inboundAnswered, inboundMissed, outboundAnswered, outboundMissed, onCallNow }

const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0
};

function clampDown(obj, key) {
  if (!obj || typeof obj[key] !== "number") return;
  obj[key] = Math.max(0, obj[key] - 1);
}

function ensureAgent(agentId) {
  if (!agentId) return null;
  const id = String(agentId);
  if (!agents.has(id)) {
    agents.set(id, {
      id,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
      onCallNow: false
    });
  }
  return agents.get(id);
}

function getState() {
  return {
    ok: true,
    portalsStored: portals.size,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
    agents: Array.from(agents.values())
  };
}

/** ---------------------------
 * WebSocket (for wallboard UI)
 * -------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast() {
  const payload = JSON.stringify({ type: "state", data: getState() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", data: getState() }));
});

/** ---------------------------
 * Basic UI (simple wallboard page)
 * -------------------------- */
app.get("/", (req, res) => {
  // Minimal UI so you can confirm websocket + state quickly
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Bitrix Wallboard</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:8px; overflow:auto; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .card { border:1px solid #ddd; border-radius:10px; padding:12px; min-width:220px; }
    h2 { margin:0 0 8px 0; }
    small { color:#777; }
  </style>
</head>
<body>
  <h2>Bitrix24 Wallboard (Live)</h2>
  <small>WebSocket state updates</small>
  <div class="row">
    <div class="card"><b>Incoming In Progress:</b> <span id="inProg">0</span></div>
    <div class="card"><b>Incoming Missed:</b> <span id="inMiss">0</span></div>
    <div class="card"><b>Outgoing In Progress:</b> <span id="outProg">0</span></div>
    <div class="card"><b>Outgoing Cancelled:</b> <span id="outCan">0</span></div>
    <div class="card"><b>Missed/Dropped/Abandoned:</b> <span id="mda">0</span></div>
  </div>

  <h3>Raw State</h3>
  <pre id="raw">{}</pre>

  <script>
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "state") return;
      const s = msg.data;
      document.getElementById("inProg").textContent = s.metrics.incoming.inProgress;
      document.getElementById("inMiss").textContent = s.metrics.incoming.missed;
      document.getElementById("outProg").textContent = s.metrics.outgoing.inProgress;
      document.getElementById("outCan").textContent = s.metrics.outgoing.cancelled;
      document.getElementById("mda").textContent = s.metrics.missedDroppedAbandoned;
      document.getElementById("raw").textContent = JSON.stringify(s, null, 2);
    };
  </script>
</body>
</html>
  `);
});

/** ---------------------------
 * Health
 * -------------------------- */
app.get("/health", (req, res) => res.json({ ok: true }));

/** ---------------------------
 * Debug endpoints
 * -------------------------- */
app.get("/debug/state", (req, res) => res.json(getState()));

app.get("/debug/offline", (req, res) => {
  // If no portal token stored, show clear error
  if (portals.size === 0) {
    return res.status(400).json({ error: "No portal token stored yet. Reinstall the Bitrix app first." });
  }

  // Simulate an event for testing UI update
  const fake = {
    event: "OnVoximplantCallEnd",
    callId: "debug-" + Date.now(),
    direction: "IN",
    agentId: "debugAgent"
  };
  handleEvent(fake);
  return res.json({ ok: true, simulated: fake });
});

/** ---------------------------
 * Bitrix install endpoint
 * -------------------------- */
app.post("/bitrix/install", (req, res) => {
  const ct = req.headers["content-type"] || "";
  console.log("🔧 INSTALL content-type:", ct);
  console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
  console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

  // Bitrix sends domain in query as DOMAIN
  const domain = req.query.DOMAIN || req.query.domain || req.body.DOMAIN || req.body.domain;
  const memberId = req.body.member_id || req.body.MEMBER_ID || req.query.member_id || req.query.MEMBER_ID;

  // Tokens are typically in body
  const authId = req.body.AUTH_ID || req.body.auth_id;
  const refreshId = req.body.REFRESH_ID || req.body.refresh_id;
  const serverEndpoint = req.body.SERVER_ENDPOINT || req.body.server_endpoint;

  const missing = {
    domain: !domain,
    memberId: !memberId,
    authId: !authId
  };

  if (missing.domain || missing.memberId || missing.authId) {
    console.log("❌ INSTALL missing params:", missing);
    return res.status(400).json({
      error: "Missing install params",
      missing,
      got: { domain, memberId, authIdPresent: !!authId }
    });
  }

  const key = `${domain}|${memberId}`;
  portals.set(key, {
    domain: String(domain),
    memberId: String(memberId),
    authId: String(authId),
    refreshId: refreshId ? String(refreshId) : null,
    serverEndpoint: serverEndpoint ? String(serverEndpoint) : null,
    storedAt: new Date().toISOString()
  });

  console.log("✅ INSTALL stored token for:", key);
  broadcast();

  // Bitrix likes a redirect after install
  return res.redirect(302, "/?installed=1");
});

/** ---------------------------
 * Bitrix events endpoint
 * -------------------------- */
app.post("/bitrix/events", (req, res) => {
  // Your earlier test used JSON: { "event": "OnVoximplantCallEnd" }
  // Bitrix may post many other fields too
  const payload = req.body || {};

  // Some senders post raw JSON under "data"
  const evt = payload.event || payload.EVENT || (payload.data && payload.data.event);
  if (!evt) {
    // still return 200 to avoid Bitrix retries storm
    console.log("⚠️ EVENTS missing event field. body keys:", Object.keys(payload));
    return res.status(200).json({ ok: true, ignored: true });
  }

  handleEvent(payload);
  return res.status(200).json({ ok: true });
});

/** ---------------------------
 * Event handler (core logic)
 * -------------------------- */
function handleEvent(payload) {
  const eventName = payload.event || payload.EVENT;

  // Flexible field mapping (Bitrix can vary)
  const callId =
    payload.callId ||
    payload.CALL_ID ||
    payload.call_id ||
    (payload.data && (payload.data.callId || payload.data.CALL_ID));

  const direction =
    payload.direction ||
    payload.DIRECTION ||
    payload.callDirection ||
    (payload.data && (payload.data.direction || payload.data.DIRECTION)) ||
    "IN";

  const agentId =
    payload.agentId ||
    payload.AGENT_ID ||
    payload.userId ||
    payload.USER_ID ||
    (payload.data && (payload.data.agentId || payload.data.userId));

  console.log("📩 EVENT:", eventName, { callId, direction, agentId });

  // Minimal logic to prove updates work.
  if (eventName === "OnVoximplantCallStart") {
    if (!callId) return;

    liveCalls.set(String(callId), {
      direction: String(direction).toUpperCase() === "OUT" ? "OUT" : "IN",
      agentId: agentId ? String(agentId) : null,
      startedAt: Date.now()
    });

    if (String(direction).toUpperCase() === "OUT") metrics.outgoing.inProgress += 1;
    else metrics.incoming.inProgress += 1;

    if (agentId) {
      const a = ensureAgent(agentId);
      if (a) a.onCallNow = true;
    }

    broadcast();
    return;
  }

  if (eventName === "OnVoximplantCallEnd") {
    if (!callId) {
      // Still update something if no callId came through (your reqbin test)
      broadcast();
      return;
    }

    const lc = liveCalls.get(String(callId));
    if (!lc) {
      // If we didn't record start, still broadcast for visibility
      broadcast();
      return;
    }

    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    // Your current logic: treat IN end as missed, OUT end as cancelled.
    // You can refine later based on status codes.
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

    liveCalls.delete(String(callId));
    broadcast();
    return;
  }

  // Any other event — just broadcast state so UI can reflect changes
  broadcast();
}

/** ---------------------------
 * Start server
 * -------------------------- */
// No Caddy now: Railway provides PORT. Must listen on process.env.PORT.
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
