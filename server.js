/**
 * Bitrix24 Wallboard Backend (Railway)
 * ------------------------------------------------------------
 * Key design change:
 * ✅ DO NOT call event.bind from the backend (avoids 403 WRONG_AUTH_TYPE)
 * ✅ Use Bitrix24 OUTGOING WEBHOOK (configured in Bitrix UI) to POST events to:
 *    https://<your-public-domain>/bitrix/events
 *
 * What this server provides:
 * - POST /bitrix/events   (receives Bitrix webhook event payloads)
 * - GET  /debug/state     (see current metrics + liveCalls + agents)
 * - GET  /health          (Railway healthcheck)
 * - GET  /               (simple status)
 *
 * Optional:
 * - POST /bitrix/install  (kept for compatibility; stores portal key only; no binding)
 *
 * ENV VARS (Railway → Service → Variables):
 * - PUBLIC_URL=https://bitrix24-wallboard1-production.up.railway.app   (recommended)
 * - DATA_DIR=/data                                                  (recommended; Railway volume mount)
 * - BITRIX_WEBHOOK_SECRET=someStrongSecret                           (optional: verify outgoing webhook secret/header)
 *
 * NOTE:
 * - Your Bitrix24 OUTGOING webhook should point to:
 *   https://bitrix24-wallboard1-production.up.railway.app/bitrix/events
 * - Add Voximplant events there:
 *   OnVoximplantCallInit, OnVoximplantCallStart, OnVoximplantCallConnected, OnVoximplantCallEnd
 */

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();

// Bitrix sends application/x-www-form-urlencoded sometimes, and application/json other times.
// Support both:
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- ENV / PATHS --------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL =
  (process.env.PUBLIC_URL || "").trim() ||
  `https://${process.env.RAILWAY_PUBLIC_DOMAIN || "localhost"}`;

// Data dir (Railway volume should be mounted to /data)
const DATA_DIR = (process.env.DATA_DIR || "/data").trim();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Could not create DATA_DIR:", DATA_DIR, e.message);
}

const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");
let portalTokens = {};

// -------------------- HELPERS --------------------
function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const raw = fs.readFileSync(TOKENS_FILE, "utf8");
      portalTokens = raw ? JSON.parse(raw) : {};
    } else {
      portalTokens = {};
    }
  } catch (e) {
    console.error("❌ Tokens load error:", e.message);
    portalTokens = {};
  }
  console.log("💾 Tokens file:", TOKENS_FILE);
  console.log("🔑 Tokens loaded:", Object.keys(portalTokens).length);
}

function saveTokens(obj) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), "utf8");
    console.log("💾 Tokens saved to:", TOKENS_FILE);
  } catch (e) {
    console.error("❌ Tokens save error:", e.message);
  }
}

function nowISO() {
  return new Date().toISOString();
}

function clampDown(bucket, key) {
  bucket[key] = Math.max(0, (bucket[key] || 0) - 1);
}

// -------------------- STATE (metrics + live calls + agents) --------------------
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

// callId -> { callId, direction: 'IN'|'OUT', startedAt, phone, lineName, agentId }
const liveCalls = new Map();

// agentId -> { agentId, name?, onCallNow, inboundAnswered, inboundMissed, outboundAnswered, outboundMissed }
const agents = new Map();

function ensureAgent(agentId, name) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      name: name || "",
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
    });
  } else if (name && !agents.get(agentId).name) {
    agents.get(agentId).name = name;
  }
  return agents.get(agentId);
}

// -------------------- SIMPLE "ALIVE" LOG (helps diagnose restarts) --------------------
setInterval(() => {
  console.log("🫀 alive", nowISO());
}, 30_000);

// -------------------- BOOT --------------------
console.log("🔗 Handler URL:", `${PUBLIC_URL.replace(/\/+$/, "")}/bitrix/events`);
console.log("🚀 Boot");
loadTokens();

// -------------------- ROUTES --------------------
app.get("/", (req, res) => {
  res.type("text/plain").send("Bitrix24 Wallboard Backend is running.");
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * INSTALL callback (optional)
 * If you are NOT using an iframe app, you can ignore this endpoint.
 * Keeping it here because you previously used it; it stores minimal portal info.
 *
 * IMPORTANT: We DO NOT call event.bind here anymore.
 */
app.post("/bitrix/install", (req, res) => {
  try {
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
    console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

    const domain =
      req.query.DOMAIN || req.body.DOMAIN || req.body.domain || "unknown-domain";
    const memberId =
      req.body.member_id || req.body.MEMBER_ID || "unknown-member";

    const key = `${domain}|${memberId}`;
    portalTokens[key] = {
      domain,
      memberId,
      installedAt: nowISO(),
    };
    saveTokens(portalTokens);

    return res.json({
      ok: true,
      message:
        "Installed. Configure Bitrix24 OUTGOING webhook to POST events to /bitrix/events (no REST event.bind required).",
      handler: `${PUBLIC_URL.replace(/\/+$/, "")}/bitrix/events`,
      portalsStored: Object.keys(portalTokens).length,
    });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * EVENTS endpoint — Bitrix OUTGOING webhook posts here.
 *
 * Bitrix payload can vary. Common patterns:
 * - req.body.event + req.body.data
 * - req.body.EVENT + req.body.DATA
 *
 * We attempt to normalize into:
 *   eventName, data, callId, direction, agentId, phone, lineName
 */
app.post("/bitrix/events", (req, res) => {
  // Respond fast so Bitrix doesn't retry
  res.json({ ok: true });

  try {
    // Optional security check (only if you add and use it)
    // Bitrix outgoing webhooks can send a key in query or header depending on your setup.
    // If you want to enforce it:
    //
    // const SECRET = process.env.BITRIX_WEBHOOK_SECRET;
    // if (SECRET) {
    //   const provided = req.query.secret || req.headers["x-bitrix-secret"];
    //   if (provided !== SECRET) {
    //     console.warn("⚠️ Webhook rejected: bad secret");
    //     return;
    //   }
    // }

    const raw = req.body || {};
    const eventName = raw.event || raw.EVENT || "unknown";
    const data = raw.data || raw.DATA || raw;

    console.log("📨 EVENT received:", eventName);

    // Try to find callId from typical Bitrix Voximplant payload structures
    const callId =
      data.callId ||
      data.CALL_ID ||
      (data.CALL && (data.CALL.callId || data.CALL.CALL_ID)) ||
      data.call_id ||
      raw.callId ||
      raw.CALL_ID ||
      null;

    // Determine direction (IN/OUT) best-effort
    const direction =
      data.direction ||
      data.DIRECTION ||
      (data.CALL && (data.CALL.direction || data.CALL.DIRECTION)) ||
      (data.call && (data.call.direction || data.call.DIRECTION)) ||
      null;

    // Agent info (best-effort)
    const agentId =
      data.agentId ||
      data.AGENT_ID ||
      data.userId ||
      data.USER_ID ||
      (data.CALL && (data.CALL.agentId || data.CALL.userId || data.CALL.USER_ID)) ||
      null;

    const agentName =
      data.agentName ||
      data.AGENT_NAME ||
      (data.USER && data.USER.NAME) ||
      null;

    // Caller/line info (best-effort)
    const phone =
      data.phoneNumber ||
      data.PHONE_NUMBER ||
      data.phone ||
      data.PHONE ||
      (data.CALL && (data.CALL.phoneNumber || data.CALL.phone || data.CALL.PHONE)) ||
      null;

    const lineName =
      data.lineName ||
      data.LINE_NAME ||
      data.queueName ||
      data.QUEUE_NAME ||
      (data.CALL && (data.CALL.lineName || data.CALL.queueName)) ||
      null;

    // If no callId, just log and exit
    if (!callId) {
      console.log("⚠️ No callId found in payload; ignoring metrics update.");
      return;
    }

    // Normalize direction to IN/OUT if possible
    let dir = null;
    if (direction) {
      const d = String(direction).toUpperCase();
      if (d.includes("IN")) dir = "IN";
      if (d.includes("OUT")) dir = "OUT";
    }

    // If still unknown, keep last known direction if call exists
    const existing = liveCalls.get(callId);
    if (!dir && existing && existing.direction) dir = existing.direction;
    if (!dir) dir = "IN"; // safe fallback (you can change)

    // Ensure agent record
    const a = ensureAgent(agentId, agentName);

    // -------------------- EVENT HANDLERS --------------------
    if (eventName === "OnVoximplantCallInit") {
      // Call is being created/initialized
      if (!liveCalls.has(callId)) {
        liveCalls.set(callId, {
          callId,
          direction: dir,
          startedAt: nowISO(),
          phone: phone || "",
          lineName: lineName || "",
          agentId: agentId || "",
        });

        if (dir === "IN") metrics.incoming.inProgress += 1;
        else metrics.outgoing.inProgress += 1;

        if (a) a.onCallNow = true;
      }
      return;
    }

    if (eventName === "OnVoximplantCallStart") {
      // Call started ringing / dialing
      // Ensure it's tracked
      if (!liveCalls.has(callId)) {
        liveCalls.set(callId, {
          callId,
          direction: dir,
          startedAt: nowISO(),
          phone: phone || "",
          lineName: lineName || "",
          agentId: agentId || "",
        });
        if (dir === "IN") metrics.incoming.inProgress += 1;
        else metrics.outgoing.inProgress += 1;
      }
      if (a) a.onCallNow = true;
      return;
    }

    if (eventName === "OnVoximplantCallConnected") {
      // Call connected / answered
      const lc = liveCalls.get(callId);
      if (!lc) return;

      // Reduce inProgress; count answered
      if (lc.direction === "IN") {
        clampDown(metrics.incoming, "inProgress");
        metrics.incoming.answered += 1;
        if (a) a.inboundAnswered += 1;
      } else {
        clampDown(metrics.outgoing, "inProgress");
        metrics.outgoing.answered += 1;
        if (a) a.outboundAnswered += 1;
      }
      if (a) a.onCallNow = true;
      return;
    }

    if (eventName === "OnVoximplantCallEnd") {
      // Call ended — determine missed/cancelled best-effort
      const lc = liveCalls.get(callId);
      if (!lc) return;

      const lcAgent = ensureAgent(lc.agentId, agentName);

      // If it never connected, count as missed/cancelled.
      // We don’t have definitive status fields across all payloads,
      // so treat end without "connected" marker as missed/cancelled.
      //
      // You can refine later by reading data.status, data.callStatus, etc.
      const connectedFlag =
        data.connected ||
        data.CONNECTED ||
        data.isConnected ||
        data.IS_CONNECTED ||
        false;

      if (lc.direction === "IN") {
        clampDown(metrics.incoming, "inProgress");

        // if no explicit connected => count missed
        if (!connectedFlag) {
          metrics.incoming.missed += 1;
          metrics.missedDroppedAbandoned += 1;
          if (lcAgent) lcAgent.inboundMissed += 1;
        }
      } else {
        clampDown(metrics.outgoing, "inProgress");

        // if no explicit connected => count cancelled/missed
        if (!connectedFlag) {
          metrics.outgoing.cancelled += 1;
          if (lcAgent) lcAgent.outboundMissed += 1;
        }
      }

      if (lcAgent) lcAgent.onCallNow = false;

      liveCalls.delete(callId);
      return;
    }

    // Unknown event — no-op
  } catch (e) {
    console.error("❌ /bitrix/events handler error:", e.message);
  }
});

// Debug state
app.get("/debug/state", (req, res) => {
  res.json({
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: Array.from(liveCalls.values()),
    agents: Array.from(agents.values()),
  });
});


// -------------------- LISTEN --------------------
// IMPORTANT: only ONE listen. Railway must see this port open.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  

setInterval(() => console.log("🫀 alive", new Date().toISOString()), 30000);
