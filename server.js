/**
 * FINAL server.js — Bitrix24 Live Call Wallboard
 * Works with Bitrix24 Cloud + SIP Connector (Vodafone PBX)
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

/* =========================
   In-memory stores
   ========================= */
const portals = new Map(); // member_id → { domain, access_token }
const liveCalls = new Map(); // callId → { direction, startedAt }
const metrics = {
  inboundInProgress: 0,
  outboundInProgress: 0,
  missedToday: 0
};

/* =========================
   Helpers
   ========================= */
function broadcast() {
  const payload = JSON.stringify({
    metrics,
    liveCalls: Array.from(liveCalls.values())
  });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

async function bitrixRestCall(memberId, method, params = {}) {
  const p = portals.get(memberId);
  if (!p) throw new Error("Portal not installed");
  const url = `https://${p.domain}/rest/${method}`;
  return axios.post(url, params, {
    headers: { Authorization: `Bearer ${p.access_token}` }
  });
}

/* =========================
   Serve Wallboard UI
   ========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   WebSocket init
   ========================= */
wss.on("connection", ws => {
  ws.send(JSON.stringify({
    metrics,
    liveCalls: Array.from(liveCalls.values())
  }));
});

/* =========================
   Bitrix INSTALL (GET + POST)
   ========================= */
async function handleInstall(req, res) {
  try {
    const code = req.query.code || req.body.code;
    const domain = req.query.domain || req.body.domain;
    const memberId = req.query.member_id || req.body.member_id;

    // Menu open / health open → just show UI
    if (!code || !domain || !memberId) {
      return res.redirect(`${process.env.APP_BASE_URL}/`);
    }

    const tokenUrl = `https://${domain}/oauth/token/`;
    const tokenResp = await axios.get(tokenUrl, {
      params: {
        grant_type: "authorization_code",
        client_id: process.env.BITRIX_CLIENT_ID,
        client_secret: process.env.BITRIX_CLIENT_SECRET,
        code
      }
    });

    portals.set(memberId, {
      domain,
      access_token: tokenResp.data.access_token
    });

    const handlerUrl = `${process.env.APP_BASE_URL}/bitrix/events`;

    // Bind ALL required telephony events
    await bitrixRestCall(memberId, "event.bind", {
      event: "OnVoximplantCallInit",
      handler: handlerUrl
    });
    await bitrixRestCall(memberId, "event.bind", {
      event: "OnVoximplantCallStart",
      handler: handlerUrl
    });
    await bitrixRestCall(memberId, "event.bind", {
      event: "OnVoximplantCallEnd",
      handler: handlerUrl
    });

    console.log("✅ Installed + events bound for", domain);
    return res.redirect(`${process.env.APP_BASE_URL}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed");
  }
}

app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

/* =========================
   Bitrix EVENTS
   ========================= */

// IMPORTANT: Bitrix may probe with GET
app.get("/bitrix/events", (req, res) => {
  res.status(200).send("OK");
});

app.post("/bitrix/events", (req, res) => {
  res.status(200).send("OK");

  const body = req.body || {};
  const event =
    body.event ||
    body.EVENT_NAME ||
    body?.data?.event ||
    body?.data?.EVENT_NAME;

  const callId =
    body.callId ||
    body.CALL_ID ||
    body?.data?.CALL_ID ||
    `call-${Date.now()}`;

  const direction =
    (body?.data?.FIELDS?.CALL_TYPE === 2 ||
     body?.data?.FIELDS?.DIRECTION === "out")
      ? "OUT"
      : "IN";

  // ---- Call INIT (ringing / dialing)
  if (event === "OnVoximplantCallInit") {
    liveCalls.set(callId, {
      callId,
      direction,
      startedAt: Date.now()
    });
    direction === "IN"
      ? metrics.inboundInProgress++
      : metrics.outboundInProgress++;
    broadcast();
    return;
  }

  // ---- Call END
  if (event === "OnVoximplantCallEnd") {
    const call = liveCalls.get(callId);
    if (call) {
      call.direction === "IN"
        ? metrics.inboundInProgress--
        : metrics.outboundInProgress--;
      liveCalls.delete(callId);
      metrics.missedToday++;
      broadcast();
    }
  }
});

/* =========================
   Health
   ========================= */
app.get("/health", (req, res) => res.send("OK"));

/* =========================
   Start
   ========================= */
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running on port", process.env.PORT || 3000);
});
