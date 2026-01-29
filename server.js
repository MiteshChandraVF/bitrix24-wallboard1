/**
 * server.js — Bitrix24 Live Wallboard (Railway)
 * - Serves wallboard UI at /
 * - Supports Bitrix Local App install via GET/POST /bitrix/install
 * - Receives Bitrix telephony events at POST /bitrix/events
 * - Pushes live KPI updates to the wallboard via WebSockets
 *
 * Required Railway env vars:
 *   BITRIX_CLIENT_ID
 *   BITRIX_CLIENT_SECRET
 *   APP_BASE_URL   (e.g., https://bitrix24-wallboard1-production.up.railway.app)
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -----------------------------
// In-memory stores (OK for now)
// -----------------------------
// Portal tokens (member_id -> token data)
const portals = new Map();

// "Live Now" metrics (single-portal/simple version)
// Later we can key this by member_id for multi-portal support.
const metrics = {
  inboundRinging: 0,
  activeCalls: 0,
  answeredToday: 0,
  missedToday: 0,
  abandonedToday: 0,
  talkSecondsToday: 0
};

// Live calls map (callId -> { status, direction, startTs, agentId? })
const liveCalls = new Map();

// -----------------------------
// Helpers
// -----------------------------
function broadcast() {
  const msg = JSON.stringify({ type: "update", metrics });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function safeDec(key) {
  metrics[key] = Math.max(0, (metrics[key] || 0) - 1);
}

async function bitrixRestCall(memberId, method, params = {}) {
  const p = portals.get(memberId);
  if (!p) throw new Error("Portal not installed (missing token).");

  // Bitrix24 REST endpoint (OAuth bearer)
  const url = `https://${p.domain}/rest/${method}`;

  const resp = await axios.post(url, params, {
    headers: { Authorization: `Bearer ${p.access_token}` }
  });

  return resp.data;
}

// -----------------------------
// Serve UI at ROOT (Bitrix menu opens /)
// -----------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------
// WebSocket: send initial metrics
// -----------------------------
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", metrics }));
});

// -----------------------------
// Metrics API (optional)
// -----------------------------
app.get("/api/metrics", (req, res) => res.json(metrics));

// -----------------------------
// Bitrix Install (GET or POST)
// -----------------------------
async function handleInstall(req, res) {
  try {
    // Bitrix may send params via query (GET) or body (POST)
    const code = req.query.code || req.body.code;
    const domain = req.query.domain || req.body.domain;
    const memberId = req.query.member_id || req.body.member_id;

  if (!code || !domain || !memberId) {
  // If a user opens the app from the Bitrix menu (no OAuth params),
  // show the wallboard instead of an error.
  return res.redirect(`${process.env.APP_BASE_URL}/`);
}


    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;
    const appBase = process.env.APP_BASE_URL;

    if (!clientId || !clientSecret || !appBase) {
      return res
        .status(500)
        .send("Server missing BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET / APP_BASE_URL");
    }

    // Exchange authorization_code for tokens
    // Bitrix token endpoint:
    // https://{your_portal}/oauth/token/?grant_type=authorization_code&client_id=...&client_secret=...&code=...
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

    // Bind telephony events to our event receiver
    // NOTE: event.bind works in app authorization context.
    const handlerUrl = `${appBase}/bitrix/events`;

    await bitrixRestCall(memberId, "event.bind", {
      event: "OnVoximplantCallInit",
      handler: handlerUrl
    });

    await bitrixRestCall(memberId, "event.bind", {
      event: "OnVoximplantCallEnd",
      handler: handlerUrl
    });

    console.log("✅ Installed + events bound:", { domain, memberId, handlerUrl });

    // Redirect user to the wallboard UI
    return res.redirect(`${appBase}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check Railway logs.");
  }
}

app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

// -----------------------------
// Bitrix Telephony Events Receiver
// -----------------------------
app.post("/bitrix/events", async (req, res) => {
  // Always ACK quickly
  res.status(200).send("OK");

  try {
    const body = req.body || {};

    /**
     * IMPORTANT:
     * Bitrix event payload formats can vary. For now:
     * - We try multiple locations for event name
     * - If unknown, we log once to help you map fields safely
     */
    const eventName =
      body.event ||
      body.EVENT_NAME ||
      body?.data?.event ||
      body?.data?.EVENT_NAME ||
      body?.eventName;

    // Log the first time we see an unknown payload shape
    if (!eventName) {
      console.log("⚠️ Event received (unknown shape). Body:", JSON.stringify(body).slice(0, 2000));
      return;
    }

    // Extract call id in a defensive way
    const callId =
      body.callId ||
      body.CALL_ID ||
      body?.data?.CALL_ID ||
      body?.data?.callId ||
      body?.data?.FIELDS?.CALL_ID ||
      body?.data?.FIELDS?.CALLID ||
      body?.data?.FIELDS?.ID ||
      body?.data?.FIELDS?.CallID;

    if (eventName === "OnVoximplantCallInit") {
      // Live ringing / active call start
      metrics.inboundRinging += 1;

      if (callId) {
        liveCalls.set(callId, {
          status: "RINGING",
          startTs: Date.now()
        });
      }

      broadcast();
      return;
    }

    if (eventName === "OnVoximplantCallEnd") {
      // Call ended: decrement ringing; increment missed placeholder
      safeDec("inboundRinging");

      if (callId && liveCalls.has(callId)) {
        liveCalls.delete(callId);
      }

      // Placeholder logic until we enrich with call history:
      metrics.missedToday += 1;

      broadcast();
      return;
    }

    // Other events (ignore for now)
    console.log("ℹ️ Event received:", eventName, "callId:", callId || "n/a");
  } catch (e) {
    console.error("❌ Event handler error:", e?.response?.data || e.message);
  }
});

// -----------------------------
// Health check
// -----------------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

// -----------------------------
// Start server
// -----------------------------
server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});
