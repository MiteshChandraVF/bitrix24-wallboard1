/**
 * server.js — Bitrix24 Live Wallboard (Railway) — COMPLETE & ROBUST
 *
 * Fixes:
 *  ✅ Serves UI at /
 *  ✅ /bitrix/install accepts Bitrix params from query, body, or body.auth
 *  ✅ Logs install payload KEYS (no secrets) to diagnose Bitrix install payload format
 *  ✅ Stores portal token in memory (NOTE: will reset on redeploy/restart)
 *  ✅ Binds telephony events Init/Start/End to /bitrix/events
 *  ✅ /bitrix/events supports GET (health check) and POST (events)
 *  ✅ WebSocket pushes updates to wallboard instantly
 *  ✅ /debug/offline checks Bitrix offline events queue (requires token stored)
 *
 * Required env vars (Railway Variables):
 *  - APP_BASE_URL           e.g. https://bitrix24-wallboard1-production.up.railway.app
 *  - BITRIX_CLIENT_ID
 *  - BITRIX_CLIENT_SECRET
 *
 * Optional:
 *  - PORT (Railway sets automatically)
 */
const multer = require("multer");
const upload = multer();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const path = require("path");

const app = express();

/** IMPORTANT: body parsers must be BEFORE routes */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =========================
   In-memory stores
   =========================
   NOTE: These reset on Railway redeploy/restart.
   For production: store tokens in Postgres/Redis.
*/
const portals = new Map(); // member_id → { domain, access_token, refresh_token, expires_at }
const liveCalls = new Map(); // callId → { callId, direction, startedAt, agentId }
const agentLive = new Map(); // agentId → stats

const metrics = {
  incoming: { inProgress: 0, missed: 0, cancelled: 0 },
  outgoing: { inProgress: 0, missed: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
  activeAgentsOnCall: 0
};

/* =========================
   Helpers
   ========================= */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function ensureAgent(agentId) {
  if (!agentId) return null;
  if (!agentLive.has(agentId)) {
    agentLive.set(agentId, {
      agentId,
      onCallNow: false,
      inboundHandled: 0,
      inboundMissed: 0,
      outboundHandled: 0,
      outboundMissed: 0,
      talkSeconds: 0
    });
  }
  return agentLive.get(agentId);
}

function recomputeActiveAgentsOnCall() {
  let count = 0;
  for (const a of agentLive.values()) if (a.onCallNow) count++;
  metrics.activeAgentsOnCall = count;
}

function clampDown(obj, key) {
  obj[key] = Math.max(0, (obj[key] || 0) - 1);
}

function broadcast() {
  recomputeActiveAgentsOnCall();

  const payload = JSON.stringify({
    type: "update",
    metrics,
    liveCalls: Array.from(liveCalls.values()).slice(0, 200),
    agents: Array.from(agentLive.values()).sort(
      (a, b) =>
        (b.inboundHandled + b.outboundHandled) -
        (a.inboundHandled + a.outboundHandled)
    )
  });

  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

async function bitrixRestCall(memberId, method, params = {}) {
  const p = portals.get(memberId);
  if (!p) throw new Error("Portal not installed (missing token).");

  const url = `https://${p.domain}/rest/${method}`;
  const resp = await axios.post(url, params, {
    headers: { Authorization: `Bearer ${p.access_token}` }
  });
  return resp.data;
}

/* =========================
   UI at root (Bitrix menu opens /)
   ========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   WebSocket init
   ========================= */
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      metrics,
      liveCalls: Array.from(liveCalls.values()),
      agents: Array.from(agentLive.values())
    })
  );
});

/* =========================
   Debug endpoints
   ========================= */
app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/debug/state", (req, res) => {
  res.json({
    hasToken: portals.size > 0,
    portals: Array.from(portals.entries()).map(([memberId, v]) => ({
      memberId,
      domain: v.domain,
      expires_at: v.expires_at
    })),
    metrics
  });
});

app.get("/debug/offline", async (req, res) => {
  try {
    const memberId = Array.from(portals.keys())[0];
    if (!memberId) {
      return res.status(400).json({
        error: "No portal token stored yet. Reinstall the Bitrix app first."
      });
    }

    const r = await bitrixRestCall(memberId, "event.offline.get", {});
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ error: e?.response?.data || e.message });
  }
});

/* =========================
   Bitrix INSTALL (GET + POST)
   ========================= */
async function handleInstall(req, res) {
  try {
    const q = req.query || {};
    const b = req.body || {};
    const a = b.auth || b.AUTH || b?.data?.auth || {};

    // Debug: show only keys (no secrets)
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(q));
    console.log("🔧 INSTALL body keys:", Object.keys(b));
    if (a && typeof a === "object") console.log("🔧 INSTALL auth keys:", Object.keys(a));

    const code = pick(q, "code") || pick(b, "code") || pick(a, "code");
    const domain =
      pick(q, "domain") ||
      pick(b, "domain") ||
      pick(a, "domain") ||
      pick(q, "server_domain") ||
      pick(b, "server_domain") ||
      pick(a, "server_domain");
    const memberId =
      pick(q, "member_id") ||
      pick(b, "member_id") ||
      pick(a, "member_id") ||
      pick(q, "memberId") ||
      pick(b, "memberId") ||
      pick(a, "memberId");

    // If opened from menu / user action: show UI (no install params)
    if (!code || !domain || !memberId) {
      console.log("❌ INSTALL missing params:", { code: !!code, domain: !!domain, memberId: !!memberId });
      return res.redirect(`${process.env.APP_BASE_URL}/`);
    }

    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;
    const appBase = process.env.APP_BASE_URL;

    if (!clientId || !clientSecret || !appBase) {
      return res.status(500).send("Missing env vars: BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET / APP_BASE_URL");
    }

    // Exchange code for token
    const tokenUrl = `https://${domain}/oauth/token/`;
    const tokenResp = await axios.get(tokenUrl, {
      params: {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data;

    portals.set(memberId, {
      domain,
      access_token,
      refresh_token,
      expires_at: Date.now() + (Number(expires_in || 3600) * 1000)
    });

    const handlerUrl = `${appBase}/bitrix/events`;

    // Bind telephony events
    await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallInit", handler: handlerUrl });
    await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallStart", handler: handlerUrl });
    await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallEnd", handler: handlerUrl });

    console.log("✅ Installed + events bound (Init/Start/End):", { domain, memberId, handlerUrl });

    return res.redirect(`${appBase}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check Railway logs.");
  }
}

app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

/* =========================
   Bitrix EVENTS handler
   ========================= */

// Bitrix/network checks may call handler with GET. Must return 200.
app.get("/bitrix/events", (req, res) => {
  res.status(200).send("OK");
});

function extractEventName(body) {
  return body.event || body.EVENT_NAME || body?.data?.event || body?.data?.EVENT_NAME || body?.eventName || null;
}

function extractCallId(body) {
  return (
    body.callId ||
    body.CALL_ID ||
    body?.data?.CALL_ID ||
    body?.data?.callId ||
    body?.data?.FIELDS?.CALL_ID ||
    body?.data?.FIELDS?.CALLID ||
    body?.data?.FIELDS?.ID ||
    null
  );
}

function extractAgentId(body) {
  return (
    body.userId ||
    body.USER_ID ||
    body?.data?.USER_ID ||
    body?.data?.userId ||
    body?.data?.FIELDS?.USER_ID ||
    body?.data?.FIELDS?.PORTAL_USER_ID ||
    null
  );
}

function extractDirection(body) {
  const v = (body.direction || body.DIRECTION || body?.data?.DIRECTION || body?.data?.FIELDS?.DIRECTION || "")
    .toString()
    .toLowerCase();

  if (v.includes("out")) return "OUT";
  if (v.includes("in")) return "IN";

  // fallback heuristics
  const ct = body?.data?.FIELDS?.CALL_TYPE;
  if (ct === "out" || ct === 2) return "OUT";
  return "IN";
}

app.post("/bitrix/events", (req, res) => {
  res.status(200).send("OK");

  const body = req.body || {};
  const eventName = extractEventName(body);
  const callId = extractCallId(body) || `unknown-${Date.now()}`;
  const agentId = extractAgentId(body);
  const direction = extractDirection(body);

  console.log("📞 EVENT HIT:", { eventName, callId, direction, agentId });

  if (!eventName) return;

  // INIT: treat as in-progress
  if (eventName === "OnVoximplantCallInit") {
    liveCalls.set(callId, { callId, direction, startedAt: Date.now(), agentId: agentId || null });

    if (direction === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    if (agentId) {
      const a = ensureAgent(agentId);
      if (a) a.onCallNow = true; // may be ringing; Start will confirm
    }

    broadcast();
    return;
  }

  // START: agent answered / call connected
  if (eventName === "OnVoximplantCallStart") {
    const lc = liveCalls.get(callId);
    if (lc) lc.agentId = agentId || lc.agentId;

    if (agentId) {
      const a = ensureAgent(agentId);
      if (a) a.onCallNow = true;
    }

    broadcast();
    return;
  }

  // END: finalize
  if (eventName === "OnVoximplantCallEnd") {
    const lc = liveCalls.get(callId);

    if (lc) {
      if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
      else clampDown(metrics.outgoing, "inProgress");

      // Basic classification (until we enrich with call history):
      // If it ended and was inbound, count missed/abandoned bucket.
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

      // clear agent on-call
      if (lc.agentId) {
        const a = ensureAgent(lc.agentId);
        if (a) a.onCallNow = false;
      }

      liveCalls.delete(callId);
      broadcast();
    }
  }
});

/* =========================
   Start
   ========================= */
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running on port", process.env.PORT || 3000);
});
