/**
 * server.js — Bitrix24 Wallboard Backend (Railway)
 * ------------------------------------------------
 * Key fixes included:
 * 1) ✅ NO event.bind from backend (prevents WRONG_AUTH_TYPE 403)
 * - Outbound Webhook in Bitrix handles event delivery to /bitrix/events
 *
 * 2) ✅ Stable storage for tokens/portals using Railway Volume
 * - DATA_DIR=/data (Railway service variable)
 *
 * 3) ✅ /bitrix/events accepts ONLY POST (Bitrix outbound webhook)
 * - Logs inbound webhook payload
 * - Normalizes event names to UPPERCASE and supports CamelCase too
 *
 * 4) ✅ Debug endpoints:
 * - /health
 * - /debug/state
 * - /debug/last-events (optional)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

// -------------------- Config --------------------
const PORT = parseInt(process.env.PORT || "3000", 10);

// PUBLIC_URL should be your Railway public domain (HTTPS)
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();

// Persist tokens/portal info
const DATA_DIR = (process.env.DATA_DIR || "/data").trim();
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

// Optional: Outbound webhook token (if you want to validate source)
const BITRIX_OUTBOUND_TOKEN = (process.env.BITRIX_OUTBOUND_TOKEN || "").trim();

// In-memory state
let portalTokens = {}; // stored in TOKENS_FILE
const lastEvents = []; // keep last N webhook events for debugging

// Example metrics state (you can replace with your own structure)
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};
const liveCalls = new Map(); // callId -> {direction, agentId, ...}
const agents = new Map(); // agentId -> { onCallNow, inboundMissed, outboundMissed, ... }

// -------------------- Helpers --------------------
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error("❌ Failed to create DATA_DIR:", dir, e);
  }
}

function loadTokens() {
  try {
    ensureDir(DATA_DIR);
    if (!fs.existsSync(TOKENS_FILE)) return {};
    const raw = fs.readFileSync(TOKENS_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("❌ Failed to load tokens:", e);
    return {};
  }
}

function saveTokens(obj) {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to save tokens:", e);
  }
}

function pushLastEvent(evt) {
  lastEvents.unshift(evt);
  while (lastEvents.length > 25) lastEvents.pop();
}

function normalizeEventName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "UNKNOWN";

  // Many Bitrix outbound webhooks arrive like: ONVOXIMPLANTCALLINIT
  // Some older code may send: OnVoximplantCallInit
  // Normalize to uppercase token for comparisons:
  return s.toUpperCase();
}

function clampDown(obj, key) {
  if (!obj || typeof obj[key] !== "number") return;
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

// -------------------- App --------------------
const app = express();

// Bitrix outbound webhook often sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

// Simple “alive” heartbeat in logs (helps confirm container not sleeping)
setInterval(() => {
  console.log("🫀 alive", new Date().toISOString());
}, 30_000);

// Boot logs
console.log("🚀 Boot");
console.log("💾 Tokens file:", TOKENS_FILE);
portalTokens = loadTokens();
console.log("🔑 Tokens loaded:", Object.keys(portalTokens).length);

const handlerUrl =
  PUBLIC_URL && PUBLIC_URL.startsWith("http")
    ? `${PUBLIC_URL.replace(/\/+$/, "")}/bitrix/events`
    : "(set PUBLIC_URL to show handler)";
console.log("🔗 Handler URL:", handlerUrl);

// Root
app.get("/", (req, res) => {
  res.type("text/plain").send("Bitrix24 Wallboard Backend is running.");
});

// -------------------- INSTALL ENDPOINT --------------------
// NOTE: We do NOT event.bind here.
// Outbound Webhook in Bitrix UI pushes events to /bitrix/events.
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
      installedAt: new Date().toISOString(),
    };

    saveTokens(portalTokens);
    console.log("✅ INSTALL stored portal key:", key);
    console.log("💾 Tokens saved to:", TOKENS_FILE);

    return res.json({
      ok: true,
      message:
        "Installed OK. Configure Bitrix Outbound Webhook to POST events to /bitrix/events.",
      handler: handlerUrl,
    });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- EVENTS ENDPOINT --------------------
// Bitrix Outbound Webhook -> POST /bitrix/events
app.post("/bitrix/events", (req, res) => {
  // Respond fast (Bitrix expects quick ack)
  res.json({ ok: true });

  // Optional validation if Bitrix includes "auth[application_token]" or "auth[application_token]" style token
  // Your outbound webhook UI shows: "Application token"
  // Bitrix sometimes sends it in req.body["auth[application_token]"] or req.body.auth?.application_token
  if (BITRIX_OUTBOUND_TOKEN) {
    const token1 = req.body?.auth?.application_token;
    const token2 = req.body["auth[application_token]"];
    const got = token1 || token2;

    if (!got || String(got) !== BITRIX_OUTBOUND_TOKEN) {
      console.warn("⚠️ Webhook token mismatch (event accepted but ignored).");
      console.warn("Expected:", BITRIX_OUTBOUND_TOKEN);
      console.warn("Got:", got);
      return; // ignore processing
    }
  }

  console.log("✅ OUTBOUND WEBHOOK HIT:", new Date().toISOString());
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  const eventRaw = req.body.event || req.body.EVENT || req.body?.data?.EVENT;
  const eventName = normalizeEventName(eventRaw);

  // Keep last events for debugging
  pushLastEvent({
    at: new Date().toISOString(),
    eventRaw,
    eventName,
    body: req.body,
  });

  // --- Extract common fields (Bitrix payload can vary) ---
  // Try multiple shapes to locate callId and direction/agent
  const data = req.body.data || req.body.DATA || req.body;

  const callId =
    data.callId ||
    data.CALL_ID ||
    data?.PARAMS?.CALL_ID ||
    data?.FIELDS?.CALL_ID ||
    data?.FIELDS?.callId ||
    data?.call?.id ||
    data?.CALLID ||
    null;

  // direction may appear as IN/OUT or inbound/outbound; depends on event.
  const directionRaw =
    data.direction ||
    data.DIRECTION ||
    data?.PARAMS?.DIRECTION ||
    data?.FIELDS?.DIRECTION ||
    data?.FIELDS?.direction ||
    null;

  const directionNorm = directionRaw
    ? String(directionRaw).toUpperCase()
    : null;

  const agentId =
    data.agentId ||
    data.AGENT_ID ||
    data?.PARAMS?.PORTAL_USER_ID ||
    data?.PARAMS?.USER_ID ||
    data?.FIELDS?.PORTAL_USER_ID ||
    data?.FIELDS?.USER_ID ||
    null;

  // --- Event mapping based on your outbound webhook selection ---
  // You selected:
  // - Phone call started (ONVOXIMPLANTCALLINIT)
  // - Phone call answered (ONVOXIMPLANTCALLSTART)
  // - Phone call finished (ONVOXIMPLANTCALLEND)
  //
  
  // The above got silly due to copy safety—let’s do it properly:
  const isInit2 =
    eventName === "ONVOXIMPLANTCALLINIT" || eventName === "ONVOXIMPLANTCALLINIT".toUpperCase();
  const isAnswered =
    eventName === "ONVOXIMPLANTCALLSTART" || eventName === "ONVOXIMPLANTCALLSTART".toUpperCase();
  const isEnd =
    eventName === "ONVOXIMPLANTCALLEND" || eventName === "ONVOXIMPLANTCALLEND".toUpperCase();

  // If Bitrix sends camel-case names in event, also support:
  const camel = String(eventRaw || "").trim();
  const isInitCamel = camel === "OnVoximplantCallInit";
  const isAnsweredCamel = camel === "OnVoximplantCallStart";
  const isEndCamel = camel === "OnVoximplantCallEnd";

  const isInitFinal = isInit2 || isInitCamel;
  const isAnsweredFinal = isAnswered || isAnsweredCamel;
  const isEndFinal = isEnd || isEndCamel;

  // Determine direction
  // If not provided, we guess: phone call events are usually inbound unless Bitrix indicates OUT
  const dir =
    directionNorm === "OUT" || directionNorm === "OUTBOUND"
      ? "OUT"
      : "IN";

  if (!callId) {
    console.warn("⚠️ No callId found in payload; skipping metrics update.");
    return;
  }

  // ------------------- Metrics Logic -------------------
  // INIT: call created / ringing -> inProgress++
  if (isInitFinal) {
    liveCalls.set(callId, { direction: dir, agentId, startedAt: Date.now() });
    if (dir === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    const a = ensureAgent(agentId);
    if (a) a.onCallNow = true;

    console.log("📞 CALL INIT:", callId, "dir:", dir, "agent:", agentId);
    return;
  }

  // START (answered): move from inProgress to answered
  if (isAnsweredFinal) {
    const lc = liveCalls.get(callId);
    if (!lc) {
      // If we missed INIT, create one
      liveCalls.set(callId, { direction: dir, agentId, startedAt: Date.now() });
    }
    if (dir === "IN") {
      clampDown(metrics.incoming, "inProgress");
      metrics.incoming.answered += 1;
    } else {
      clampDown(metrics.outgoing, "inProgress");
      metrics.outgoing.answered += 1;
    }
    const a = ensureAgent(agentId);
    if (a) a.onCallNow = true;

    console.log("✅ CALL ANSWERED:", callId, "dir:", dir, "agent:", agentId);
    return;
  }

  // END: finished -> decrement inProgress if still there, otherwise classify as missed/cancelled
  if (isEndFinal) {
    const lc = liveCalls.get(callId) || { direction: dir, agentId };

    // If call ends without being answered, count missed/cancelled
    // NOTE: This is basic logic; you can refine using status fields if present.
    if (lc.direction === "IN") {
      // If it was still in progress (ringing) and ended -> missed
      if (metrics.incoming.inProgress > 0) {
        clampDown(metrics.incoming, "inProgress");
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;

        const a = ensureAgent(lc.agentId);
        if (a) a.inboundMissed += 1;
      } else {
        // If it was answered already, we just mark agent off call (nothing else)
      }
    } else {
      // outbound
      if (metrics.outgoing.inProgress > 0) {
        clampDown(metrics.outgoing, "inProgress");
        metrics.outgoing.cancelled += 1;

        const a = ensureAgent(lc.agentId);
        if (a) a.outboundMissed += 1;
      } else {
        // was answered already, nothing else
      }
    }

    const a = ensureAgent(lc.agentId);
    if (a) a.onCallNow = false;

    liveCalls.delete(callId);

    console.log("🛑 CALL END:", callId, "dir:", lc.direction, "agent:", lc.agentId);
    return;
  }

  console.log("ℹ️ Unhandled event:", eventRaw);
});

// Helpful message for GET on /bitrix/events
app.get("/bitrix/events", (req, res) => {
  res
    .status(405)
    .type("text/plain")
    .send("Method Not Allowed. Use POST /bitrix/events");
});

// -------------------- Debug --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => {
  res.json({
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
    handler: handlerUrl,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([id, v]) => ({ callId: id, ...v })),
    agents: Array.from(agents.values()),
  });
});

app.get("/debug/last-events", (req, res) => {
  res.json({ ok: true, count: lastEvents.length, lastEvents });
});

// -------------------- Listen --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
/end
