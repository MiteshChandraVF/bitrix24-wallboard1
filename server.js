const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const path = require("path");

const app = express();

// Parsers BEFORE routes
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory token store (reset on deploy)
const portals = new Map(); // member_id → { domain, access_token, refresh_token, expires_at }

// Live wallboard state
const liveCalls = new Map();
const agentLive = new Map();
const metrics = {
  incoming: { inProgress: 0, missed: 0, cancelled: 0 },
  outgoing: { inProgress: 0, missed: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
  activeAgentsOnCall: 0,
};

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function parseDomainFromServerEndpoint(serverEndpoint) {
  try {
    const u = new URL(serverEndpoint);
    return u.host;
  } catch {
    return null;
  }
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
      talkSeconds: 0,
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
    agents: Array.from(agentLive.values()),
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
    headers: { Authorization: `Bearer ${p.access_token}` },
  });
  return resp.data;
}

// UI
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// WS init
wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "init",
      metrics,
      liveCalls: Array.from(liveCalls.values()),
      agents: Array.from(agentLive.values()),
    })
  );
});

// Debug
app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/debug/state", (req, res) => {
  res.json({
    hasToken: portals.size > 0,
    portals: Array.from(portals.entries()).map(([memberId, v]) => ({
      memberId,
      domain: v.domain,
      expires_at: v.expires_at,
    })),
    metrics,
  });
});

app.get("/debug/offline", async (req, res) => {
  try {
    const memberId = Array.from(portals.keys())[0];
    if (!memberId) {
      return res.status(400).json({
        error: "No portal token stored yet. Reinstall the Bitrix app first.",
      });
    }
    const r = await bitrixRestCall(memberId, "event.offline.get", {});
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ error: e?.response?.data || e.message });
  }
});

// INSTALL handler (GET + POST)
async function handleInstall(req, res) {
  try {
    const q = req.query || {};
    const b = req.body || {};

    console.log("🔧 INSTALL method:", req.method);
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(q));
    console.log("🔧 INSTALL body keys:", Object.keys(b));

    const memberId = pick(b, "member_id") || pick(q, "member_id") || pick(b, "memberId") || pick(q, "memberId");

    // Local app install payload (your case)
    const authId = pick(b, "AUTH_ID");
    const refreshId = pick(b, "REFRESH_ID");
    const serverEndpoint = pick(b, "SERVER_ENDPOINT");

    const domainUpper = pick(q, "DOMAIN");
    const domainLower = pick(q, "domain");
    const derivedDomain = serverEndpoint ? parseDomainFromServerEndpoint(serverEndpoint) : null;
    const domain = domainLower || domainUpper || derivedDomain;

    if (memberId && authId && domain) {
      portals.set(memberId, {
        domain,
        access_token: authId,
        refresh_token: refreshId || null,
        expires_at: Date.now() + (Number(pick(b, "AUTH_EXPIRES") || 3600) * 1000),
      });

      const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;
      const handlerUrl = `${baseUrl}/bitrix/events`;

      try {
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallInit", handler: handlerUrl });
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallStart", handler: handlerUrl });
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallEnd", handler: handlerUrl });
        console.log("✅ Installed + events bound:", { domain, memberId, handlerUrl });
      } catch (bindErr) {
        console.log("⚠️ Token stored but event.bind failed:", bindErr?.response?.data || bindErr.message);
      }

      return res.redirect(`${baseUrl}/`);
    }

    console.log("❌ INSTALL missing fields:", {
      memberId: !!memberId,
      authId: !!authId,
      domain: !!domain,
    });

    const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    return res.redirect(`${baseUrl}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check logs.");
  }
}

app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

// EVENTS handler
app.get("/bitrix/events", (req, res) => res.status(200).send("OK"));

function extractEventName(body) {
  return body.event || body.EVENT_NAME || body?.data?.event || body?.data?.EVENT_NAME || body?.eventName || null;
}
function extractCallId(body) {
  return body.callId || body.CALL_ID || body?.data?.CALL_ID || body?.data?.callId || null;
}
function extractAgentId(body) {
  return body.userId || body.USER_ID || body?.data?.USER_ID || body?.data?.userId || null;
}
function extractDirection(body) {
  const v = (body.direction || body.DIRECTION || body?.data?.DIRECTION || "").toString().toLowerCase();
  if (v.includes("out")) return "OUT";
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

  if (eventName === "OnVoximplantCallInit") {
    liveCalls.set(callId, { callId, direction, startedAt: Date.now(), agentId: agentId || null });
    if (direction === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;
    if (agentId) {
      const a = ensureAgent(agentId);
      if (a) a.onCallNow = true;
    }
    broadcast();
    return;
  }

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

  if (eventName === "OnVoximplantCallEnd") {
    const lc = liveCalls.get(callId);
    if (!lc) return;

    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    // basic tally (you can refine later with call status fields)
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
});

// IMPORTANT: listen on 3000 so Caddy can reverse_proxy to it
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🚀 Node server listening on", PORT));
