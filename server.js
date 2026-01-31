/**
 * server.js - Bitrix24 Wallboard Backend (Railway + Caddy compatible)
 *
 * Key points:
 * - MUST listen on process.env.PORT (Railway/Nixpacks/Caddy expects this; usually 3000)
 * - /bitrix/install accepts x-www-form-urlencoded from Bitrix
 * - /bitrix/events accepts BOTH JSON and x-www-form-urlencoded
 * - Handles common Voximplant call events to update wallboard in real time
 */

const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// Bitrix commonly posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
// Also accept JSON (your reqbin test uses JSON)
app.use(express.json());

// ----------------------------
// In-memory state (note: resets on redeploy)
// ----------------------------

/**
 * portalTokens: Map key = `${domain}|${memberId}`
 * value: { domain, memberId, authId, refreshId, serverEndpoint, createdAt }
 */
const portalTokens = new Map();

/**
 * liveCalls: Map key = callId
 * value: { callId, direction, agentId, startedAt, connectedAt }
 */
const liveCalls = new Map();

/**
 * agents: Map key = agentId (string)
 * value: { agentId, name, onCallNow, inboundAnswered, inboundMissed, outboundAnswered, outboundCancelled }
 */
const agents = new Map();

const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

// ----------------------------
// Helpers
// ----------------------------

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
    // update name if provided
    const a = agents.get(id);
    a.name = a.name || name;
  }
  return agents.get(id);
}

// Try to extract callId from many possible payload formats
function getCallId(payload = {}) {
  return (
    payload.callId ||
    payload.CALL_ID ||
    payload.call_id ||
    payload?.data?.CALL_ID ||
    payload?.data?.callId ||
    payload?.data?.call_id ||
    payload?.["data[CALL_ID]"] ||
    payload?.["CALL_ID"] ||
    null
  );
}

// Try to extract direction
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

// Try to extract agent/user id
function getAgentId(payload = {}) {
  return (
    payload.agentId ||
    payload.AGENT_ID ||
    payload.userId ||
    payload.USER_ID ||
    payload?.data?.USER_ID ||
    payload?.data?.userId ||
    payload?.data?.AGENT_ID ||
    payload?.["data[USER_ID]"] ||
    payload?.["data[AGENT_ID]"] ||
    null
  );
}

// ----------------------------
// WebSocket for live wallboard
// ----------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function snapshot() {
  return {
    ok: true,
    portalsStored: portalTokens.size,
    metrics,
    liveCalls: Array.from(liveCalls.values()),
    agents: Array.from(agents.values()),
  };
}

function broadcast() {
  const msg = JSON.stringify({ type: "state", data: snapshot() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", data: snapshot() }));
});

// ----------------------------
// Routes
// ----------------------------

app.get("/", (req, res) => {
  // If you serve a wallboard HTML elsewhere, keep this minimal.
  res.status(200).send("Bitrix24 Wallboard Backend is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug/state", (req, res) => {
  res.json(snapshot());
});

app.get("/debug/offline", (req, res) => {
  if (portalTokens.size < 1) {
    return res.status(400).json({
      error: "No portal token stored yet. Reinstall the Bitrix app first.",
    });
  }
  res.json({
    ok: true,
    message:
      "Token exists. If calls don't update, Bitrix is likely not POSTing events to /bitrix/events or the event names differ.",
    portalsStored: portalTokens.size,
    keys: Array.from(portalTokens.keys()),
  });
});

/**
 * Bitrix install endpoint (x-www-form-urlencoded)
 * Bitrix sends: DOMAIN in querystring, member_id in body, AUTH_ID/REFRESH_ID in body
 */
app.post("/bitrix/install", async (req, res) => {
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
      received: { query: req.query, bodyKeys: Object.keys(req.body || {}) },
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

  console.log("✅ INSTALL stored token for:", key);

  // Bitrix often expects a redirect back to your app UI
  return res.redirect(302, "/");
});

/**
 * Bitrix events endpoint
 * Accepts JSON and form-urlencoded.
 *
 * You should configure Bitrix app event handler URL to:
 *   https://<your-railway-domain>/bitrix/events
 */
app.post("/bitrix/events", (req, res) => {
  // Some Bitrix payloads come nested; support both
  const eventName = req.body.event || req.body.EVENT || req.query.event || null;

  // For troubleshooting: ALWAYS log a compact line, and optionally full payload
  console.log("📩 EVENT received:", {
    event: eventName,
    contentType: req.headers["content-type"],
    bodyKeys: Object.keys(req.body || {}),
  });

  // If you need deep debugging uncomment:
  // console.log("📩 EVENT body full:", JSON.stringify(req.body, null, 2));

  if (!eventName) {
    return res.status(400).json({ ok: false, error: "Missing event name" });
  }

  // Attempt to extract key fields
  const callId = getCallId(req.body);
  const direction = getDirection(req.body);
  const agentId = getAgentId(req.body);

  // -------- Event handling --------
  // 1) Call start: mark in-progress
  if (eventName === "OnVoximplantCallStart" || eventName === "OnVoximplantCallInit") {
    if (callId) {
      // If we already know this call, don't double count
      if (!liveCalls.has(callId)) {
        const dir = direction || "IN"; // fallback
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
      }
      broadcast();
    }
    return res.json({ ok: true });
  }

  // 2) Call connected: treat as answered
  if (eventName === "OnVoximplantCallConnected") {
    if (callId) {
      const lc = liveCalls.get(callId);
      // If we didn’t receive start, create minimal record so board still updates
      if (!lc) {
        const dir = direction || "IN";
        liveCalls.set(callId, {
          callId,
          direction: dir,
          agentId: agentId ? String(agentId) : null,
          startedAt: Date.now(),
          connectedAt: Date.now(),
        });
        if (dir === "IN") clampUp(metrics.incoming, "inProgress");
        else clampUp(metrics.outgoing, "inProgress");
      } else {
        lc.connectedAt = Date.now();
        if (agentId && !lc.agentId) lc.agentId = String(agentId);
      }

      const cur = liveCalls.get(callId);
      const dir = cur.direction;

      // Count answered once (only if first time connected)
      if (cur && cur.connectedAt && cur.connectedAt === cur.startedAt) {
        // this is unlikely; ignore
      }

      // Safer: increment answered only if we haven't flagged it
      if (cur && !cur._answeredCounted) {
        cur._answeredCounted = true;
        if (dir === "IN") metrics.incoming.answered += 1;
        else metrics.outgoing.answered += 1;

        const a = ensureAgent(cur.agentId);
        if (a) {
          a.onCallNow = true;
          if (dir === "IN") a.inboundAnswered += 1;
          else a.outboundAnswered += 1;
        }
      }

      broadcast();
    }
    return res.json({ ok: true });
  }

  // 3) Call end: decrement in-progress and tally missed/cancelled if not connected
  if (eventName === "OnVoximplantCallEnd") {
    if (!callId) return res.json({ ok: true });

    const lc = liveCalls.get(callId);

    // If we never saw the call, just ack (don’t crash)
    if (!lc) return res.json({ ok: true });

    // Decrement in-progress
    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    const wasConnected = !!lc.connectedAt;

    // If not connected, treat as missed/cancelled
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

    // Agent now off call
    if (lc.agentId) {
      const a = ensureAgent(lc.agentId);
      if (a) a.onCallNow = false;
    }

    liveCalls.delete(callId);
    broadcast();
    return res.json({ ok: true });
  }

  // Unknown event - still OK
  return res.json({ ok: true, ignored: true, event: eventName });
});

// For debugging: if someone hits GET /bitrix/events, return 405 clearly
app.get("/bitrix/events", (req, res) => {
  res.status(405).send("Method Not Allowed. Use POST /bitrix/events");
});

// ----------------------------
// Start
// ----------------------------

// CRITICAL: Must listen on process.env.PORT for Railway/Nixpacks (Caddy upstream)
const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
