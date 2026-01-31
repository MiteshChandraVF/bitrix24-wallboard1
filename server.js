/**
 * server.js — Bitrix24 Wallboard webhook + WS broadcaster
 *
 * IMPORTANT (Railway):
 * Your logs show Caddy is running and reverse_proxy tries 127.0.0.1:3000.
 * So Node MUST listen on port 3000, not 8080, otherwise you'll get:
 * dial tcp 127.0.0.1:3000: connect: connection refused
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");

const app = express();

// --- Body parsing (Bitrix can send form-encoded; your tests send JSON) ---
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Simple persistent store (best-effort; Railway filesystem may be ephemeral) ----
const STORE_FILE = process.env.STORE_FILE || path.join("/tmp", "portal_store.json");

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { portals: {} };
  }
}
function saveStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️ Could not persist store:", e.message);
  }
}

const store = loadStore();

/**
 * portals key = `${domain}|${memberId}`
 * value = { domain, memberId, authId, refreshId, serverEndpoint, installedAt, eventsBoundAt }
 */

// ---- Metrics + state ----
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

const liveCalls = new Map(); // callId -> { direction, agentId, startedAt }
const agents = new Map(); // agentId -> { agentId, name, onCallNow, inboundMissed, outboundMissed }

let lastEvent = null;

// ---- Helpers ----
function clampDown(obj, key) {
  if (!obj || typeof obj[key] !== "number") return;
  obj[key] = Math.max(0, obj[key] - 1);
}

function ensureAgent(agentId, name) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      name: name || `Agent ${agentId}`,
      onCallNow: false,
      inboundMissed: 0,
      outboundMissed: 0,
    });
  } else if (name) {
    agents.get(agentId).name = name;
  }
  return agents.get(agentId);
}

function snapshotState() {
  return {
    ok: true,
    portalsStored: Object.keys(store.portals || {}).length,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({ callId, ...v })),
    agents: Array.from(agents.values()),
    lastEvent,
  };
}

function getBaseUrl(req) {
  // Railway behind proxy: trust x-forwarded-proto/host
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

// ---- WebSocket server (same HTTP server) ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcast() {
  const payload = JSON.stringify(snapshotState());
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(snapshotState()));
});

// ---- Health + debug ----
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => res.json(snapshotState()));

app.get("/debug/last-event", (req, res) => {
  if (!lastEvent) return res.status(404).json({ ok: false, error: "No events received yet." });
  res.json({ ok: true, lastEvent });
});

app.get("/debug/offline", (req, res) => {
  const count = Object.keys(store.portals || {}).length;
  if (!count) return res.status(400).json({ error: "No portal token stored yet. Reinstall the Bitrix app first." });
  res.json({ ok: true, portalsStored: count });
});

// ---- Bitrix install handler ----
// Bitrix often hits this inside an iframe, POST form-encoded.
app.all("/bitrix/install", async (req, res) => {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  console.log("🔧 INSTALL content-type:", ct);
  console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
  console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

  // Domain can arrive in query as DOMAIN, or body/domain-ish
  const domain =
    req.query.DOMAIN ||
    req.body.DOMAIN ||
    req.body.domain ||
    req.query.domain ||
    null;

  const memberId =
    req.body.member_id ||
    req.body.MEMBER_ID ||
    req.query.member_id ||
    req.query.MEMBER_ID ||
    null;

  const authId = req.body.AUTH_ID || req.body.auth || req.query.AUTH_ID || req.query.auth || null;
  const refreshId = req.body.REFRESH_ID || null;
  const serverEndpoint = req.body.SERVER_ENDPOINT || null;

  const missing = {
    domain: !domain,
    memberId: !memberId,
    authId: !authId,
    serverEndpoint: !serverEndpoint,
  };

  if (missing.domain || missing.memberId || missing.authId || missing.serverEndpoint) {
    console.log("❌ INSTALL missing params:", missing);
    return res.status(400).json({ ok: false, error: "Missing install params", missing });
  }

  const key = `${domain}|${memberId}`;
  store.portals[key] = {
    domain,
    memberId,
    authId,
    refreshId,
    serverEndpoint,
    installedAt: new Date().toISOString(),
    eventsBoundAt: store.portals[key]?.eventsBoundAt || null,
  };
  saveStore(store);

  console.log("✅ INSTALL stored token for:", key);

  // Bind Bitrix events to our handler URL
  const baseUrl = getBaseUrl(req);
  const handlerUrl = `${baseUrl}/bitrix/events`;

  try {
    await bindBitrixEvent(serverEndpoint, authId, "OnVoximplantCallStart", handlerUrl);
    await bindBitrixEvent(serverEndpoint, authId, "OnVoximplantCallEnd", handlerUrl);

    store.portals[key].eventsBoundAt = new Date().toISOString();
    saveStore(store);

    console.log("✅ Events bound to:", handlerUrl);
  } catch (e) {
    console.error("❌ Failed to bind events:", e?.response?.data || e.message);
    // Don't fail install hard, but surface for debugging
    return res.status(500).json({
      ok: false,
      error: "Stored token, but failed to bind events",
      details: e?.response?.data || e.message,
      handlerUrl,
    });
  }

  // Redirect to wallboard UI
  return res.redirect(302, "/");
});

// ---- Bitrix event binding helper ----
// Bitrix REST typically accepts auth as `auth` parameter.
// Many Bitrix endpoints expect x-www-form-urlencoded.
async function bindBitrixEvent(serverEndpoint, authId, eventName, handlerUrl) {
  if (!serverEndpoint) throw new Error("Missing SERVER_ENDPOINT");
  if (!authId) throw new Error("Missing AUTH_ID");

  // serverEndpoint usually looks like: https://<domain>/rest/
  // We call: <serverEndpoint>event.bind
  const url = serverEndpoint.endsWith("/") ? `${serverEndpoint}event.bind` : `${serverEndpoint}/event.bind`;

  const form = new URLSearchParams();
  form.set("auth", authId);
  form.set("event", eventName);
  form.set("handler", handlerUrl);

  const resp = await axios.post(url, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  // Bitrix usually returns { result: true } or similar
  return resp.data;
}

// ---- Bitrix events receiver ----
app.get("/bitrix/events", (req, res) => {
  // Friendly response so "Cannot GET /bitrix/events" doesn't confuse you anymore
  res.status(200).json({
    ok: true,
    message: "Use POST /bitrix/events. This endpoint receives Bitrix telephony events.",
  });
});

app.post("/bitrix/events", (req, res) => {
  // Bitrix might send event info in body or query
  const body = req.body || {};
  const eventName = body.event || req.query.event || null;

  // Some Bitrix payloads put parameters under `data` or `params`
  const data = body.data || body.params || body;

  // Try common call id fields
  const callId =
    data.CALL_ID ||
    data.callId ||
    data.call_id ||
    data.CALLID ||
    data.id ||
    null;

  // Try common direction / agent fields
  const direction =
    data.DIRECTION ||
    data.direction ||
    data.callDirection ||
    null;

  const agentId =
    data.USER_ID ||
    data.userId ||
    data.agentId ||
    data.AGENT_ID ||
    null;

  const agentName =
    data.USER_NAME ||
    data.userName ||
    data.agentName ||
    null;

  lastEvent = {
    receivedAt: new Date().toISOString(),
    eventName,
    callId,
    direction,
    agentId,
    raw: body,
  };

  // Log just enough (avoid huge dumps in logs)
  console.log("📩 EVENT", { eventName, callId, direction, agentId });

  // If we can't interpret the event, still ACK 200 so Bitrix doesn't retry forever
  if (!eventName) {
    broadcast();
    return res.status(200).json({ ok: true, warning: "No eventName in payload", received: true });
  }

  // --- Event handling ---
  if (eventName === "OnVoximplantCallStart") {
    // Decide IN/OUT
    const dir = (direction || "").toString().toUpperCase();
    const normalizedDir = dir.startsWith("OUT") ? "OUT" : "IN";

    if (normalizedDir === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    if (agentId) {
      const a = ensureAgent(String(agentId), agentName);
      if (a) a.onCallNow = true;
    }

    if (callId) {
      liveCalls.set(String(callId), {
        direction: normalizedDir,
        agentId: agentId ? String(agentId) : null,
        startedAt: Date.now(),
      });
    }

    broadcast();
    return res.status(200).json({ ok: true });
  }

  if (eventName === "OnVoximplantCallEnd") {
    if (!callId) {
      broadcast();
      return res.status(200).json({ ok: true, warning: "No callId for CallEnd" });
    }

    const lc = liveCalls.get(String(callId));
    if (!lc) {
      broadcast();
      return res.status(200).json({ ok: true, warning: "Call not found in liveCalls" });
    }

    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    // Basic tally (refine later if you get proper status fields)
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
    return res.status(200).json({ ok: true });
  }

  // Unknown event: still broadcast so UI can show lastEvent
  broadcast();
  return res.status(200).json({ ok: true, ignored: true });
});

// ---- Serve your wallboard UI (optional) ----
// If you have a /public/index.html, enable this. Otherwise remove.
// app.use(express.static(path.join(__dirname, "public")));

// Root placeholder (so / doesn't 404 if you don't serve static)
app.get("/", (req, res) => {
  res.status(200).send(`
    <html>
      <head><title>Bitrix Wallboard</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h2>Bitrix Wallboard Service</h2>
        <ul>
          <li><a href="/health">/health</a></li>
          <li><a href="/debug/state">/debug/state</a></li>
          <li><a href="/debug/last-event">/debug/last-event</a></li>
          <li><a href="/debug/offline">/debug/offline</a></li>
        </ul>
        <p>Webhook endpoint: <code>POST /bitrix/events</code></p>
      </body>
    </html>
  `);
});

// ---- LISTEN ----
// Force 3000 so Caddy reverse_proxy works (your logs show it proxies to 127.0.0.1:3000)
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on ${PORT}`));
