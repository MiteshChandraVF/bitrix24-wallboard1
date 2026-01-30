/**
 * server.js — Bitrix24 Live Wallboard (Railway)
 * Live KPIs:
 * - Incoming: in progress / cancelled / missed
 * - Outgoing: in progress / cancelled / missed
 * - Missed / dropped / abandoned
 * - Per-agent productivity + who is on call now
 *
 * Env vars (Railway):
 *  BITRIX_CLIENT_ID
 *  BITRIX_CLIENT_SECRET
 *  APP_BASE_URL = https://bitrix24-wallboard1-production.up.railway.app
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
// Portal tokens (testing: memory)
// -----------------------------
const portals = new Map(); // member_id -> { domain, access_token, refresh_token, expires_at }

// -----------------------------
// Live state (memory)
// -----------------------------
const liveCalls = new Map(); // callId -> { direction, status, startedAt, agentId, from, to }
const agentLive = new Map(); // agentId -> { onCallNow:boolean, inboundHandled, inboundMissed, outboundHandled, outboundMissed, talkSeconds }

// -----------------------------
// KPI counters (today-ish). In production you’ll reset at midnight or store in DB.
// -----------------------------
const metrics = {
  incoming: { inProgress: 0, cancelled: 0, missed: 0 },
  outgoing: { inProgress: 0, cancelled: 0, missed: 0 },
  missedDroppedAbandoned: 0,
  activeAgentsOnCall: 0
};

// -----------------------------
// Helpers
// -----------------------------
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

function broadcast() {
  const payload = JSON.stringify({
    type: "update",
    metrics,
    liveCalls: Array.from(liveCalls.values()).slice(0, 200),
    agents: Array.from(agentLive.values()).sort((a, b) => (b.inboundHandled + b.outboundHandled) - (a.inboundHandled + a.outboundHandled))
  });

  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

function clampDown(obj, key) {
  obj[key] = Math.max(0, (obj[key] || 0) - 1);
}

function recomputeActiveAgentsOnCall() {
  let count = 0;
  for (const a of agentLive.values()) if (a.onCallNow) count++;
  metrics.activeAgentsOnCall = count;
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

/**
 * Optional enrichment: get final call details from Bitrix call history.
 * NOTE: Call history method names/filters can vary; we keep it optional and safe.
 * If it fails, we still update basic KPIs from event info.
 */
async function tryEnrichFromHistory(memberId, callId) {
  if (!memberId || !callId) return null;
  try {
    // Voximplant call statistics endpoint (authoritative)
    // Docs: voximplant.statistic.get
    const r = await bitrixRestCall(memberId, "voximplant.statistic.get", {
      FILTER: { CALL_ID: callId },
      SORT: { CALL_START_DATE: "DESC" },
      LIMIT: 1
    });

    const row = r?.result?.[0] || null;
    return row;
  } catch (e) {
    console.log("History enrich skipped/failed:", e?.response?.data || e.message);
    return null;
  }
}

// -----------------------------
// Serve UI at root (Bitrix menu often opens /)
// -----------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------
// WebSocket init
// -----------------------------
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "init",
    metrics,
    liveCalls: Array.from(liveCalls.values()),
    agents: Array.from(agentLive.values())
  }));
});

// -----------------------------
// Simple API
// -----------------------------
app.get("/api/metrics", (req, res) => res.json({ metrics }));

// -----------------------------
// Install endpoint (GET/POST). Missing params => show UI.
// -----------------------------
async function handleInstall(req, res) {
  try {
    const code = req.query.code || req.body.code;
    const domain = req.query.domain || req.body.domain;
    const memberId = req.query.member_id || req.body.member_id;

    // If opened from menu / user action: show UI (NO binds here)
    if (!code || !domain || !memberId) {
      return res.redirect(`${process.env.APP_BASE_URL}/`);
    }

    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;
    const appBase = process.env.APP_BASE_URL;

    // 1) Exchange code for token
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

    // 2) Bind events AFTER we have tokens
    const handlerUrl = `${appBase}/bitrix/events`;

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

    console.log("✅ Installed + events bound (Init/Start/End):", { domain, memberId });

    // 3) Redirect to UI
    return res.redirect(`${appBase}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check Railway logs.");
  }
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

    // Bind telephony events
    const handlerUrl = `${appBase}/bitrix/events`;

    await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallInit", handler: handlerUrl });
    await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallEnd", handler: handlerUrl });

    console.log("✅ Installed + events bound:", { domain, memberId });

    return res.redirect(`${appBase}/`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check Railway logs.");
  }
}
app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

// -----------------------------
// Telephony event receiver
// -----------------------------
function extractEventName(body) {
  return body.event || body.EVENT_NAME || body?.data?.event || body?.data?.EVENT_NAME || body?.eventName || null;
}

function extractCallId(body) {
  return body.callId ||
    body.CALL_ID ||
    body?.data?.CALL_ID ||
    body?.data?.callId ||
    body?.data?.FIELDS?.CALL_ID ||
    body?.data?.FIELDS?.CALLID ||
    body?.data?.FIELDS?.ID ||
    null;
}

function extractAgentId(body) {
  return body.userId ||
    body.USER_ID ||
    body?.data?.USER_ID ||
    body?.data?.userId ||
    body?.data?.FIELDS?.USER_ID ||
    body?.data?.FIELDS?.PORTAL_USER_ID ||
    null;
}

function extractDirection(body) {
  // Try several common keys. Fallback: assume incoming.
  const v = (body.direction || body.DIRECTION || body?.data?.DIRECTION || body?.data?.FIELDS?.DIRECTION || "").toString().toLowerCase();
  if (v.includes("out")) return "OUT";
  if (v.includes("in")) return "IN";

  const isOutgoing = body?.data?.FIELDS?.CALL_TYPE === "out" || body?.data?.FIELDS?.CALL_TYPE === 2;
  return isOutgoing ? "OUT" : "IN";
}

function extractNumbers(body) {
  const from = body.from || body.FROM || body?.data?.FIELDS?.PHONE_NUMBER || body?.data?.FIELDS?.FROM || "";
  const to = body.to || body.TO || body?.data?.FIELDS?.TO || "";
  return { from, to };
}

app.post("/bitrix/events", async (req, res) => {
  res.status(200).send("OK");

  const body = req.body || {};
  console.log("📩 RAW EVENT:", JSON.stringify(body).slice(0, 4000));

  const eventName = extractEventName(body);
  const callId = extractCallId(body) || `unknown-${Date.now()}`; // keep live flow even if missing
  const agentId = extractAgentId(body);
  const direction = extractDirection(body);
  const { from, to } = extractNumbers(body);

  // Bitrix includes member_id in some event payloads; if not, we can’t enrich reliably.
  const memberId = req.body.member_id || req.query.member_id || body.member_id || body?.auth?.member_id || null;

  // Uncomment this for ONE real call if you need to inspect payload:
  // console.log("📩 Bitrix event payload:", JSON.stringify(body).slice(0, 4000));

  if (!eventName) {
    console.log("⚠️ Event received but eventName not found. Body:", JSON.stringify(body).slice(0, 1200));
    return;
  }

  // --- CALL INIT: treat as "in progress" (ringing / starting) ---
  if (eventName === "OnVoximplantCallInit") {
    // Create live call record
    liveCalls.set(callId, {
      callId,
      direction,
      status: "IN_PROGRESS",
      startedAt: Date.now(),
      agentId: agentId || null,
      from,
      to
    });

    if (direction === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;

    // Mark agent on call if present
    if (agentId) {
      const a = ensureAgent(agentId);
      if (a && !a.onCallNow) a.onCallNow = true;
    }

    recomputeActiveAgentsOnCall();
    broadcast();
    return;
  }

  // --- CALL END: finalize outcome ---
  if (eventName === "OnVoximplantCallEnd") {
    const lc = liveCalls.get(callId);

    // Decrement in-progress
    if (lc?.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else if (lc?.direction === "OUT") clampDown(metrics.outgoing, "inProgress");
    else {
      // fallback to extracted direction
      if (direction === "IN") clampDown(metrics.incoming, "inProgress");
      else clampDown(metrics.outgoing, "inProgress");
    }

    // Default classification if we can’t enrich:
    // - incoming ended: count as missed/abandoned (until history says answered)
    // - outgoing ended: count as cancelled (until history says connected)
    let finalType = (direction === "IN") ? "MISSED" : "CANCELLED";
    let talkSeconds = 0;
    let finalAgentId = lc?.agentId || agentId || null;

    // Try to enrich from call history (recommended)
    const row = await tryEnrichFromHistory(memberId, callId);
    if (row) {
      // These keys vary by portal. Common ones:
      // - CALL_DURATION / DURATION / TALK_DURATION
      // - CALL_FAILED_CODE / CALL_STATUS
      // - PORTAL_USER_ID / USER_ID
      talkSeconds = Number(row.CALL_DURATION || row.DURATION || row.TALK_DURATION || 0);

      finalAgentId = finalAgentId || row.PORTAL_USER_ID || row.USER_ID || null;

      const statusStr = (row.CALL_STATUS || row.STATUS || "").toString().toLowerCase();
      const failedCode = (row.CALL_FAILED_CODE || row.FAILED_CODE || "").toString().toLowerCase();

      // Heuristic mapping:
      // - answered/connected => handled
      // - no_answer/busy/failed => missed/cancelled
      const answeredLike = statusStr.includes("answer") || statusStr.includes("success") || failedCode.includes("answered") || failedCode === "200";

      if (direction === "IN") {
        finalType = answeredLike ? "ANSWERED" : "MISSED";
      } else {
        finalType = answeredLike ? "CONNECTED" : "CANCELLED";
      }
    }

    // Apply to counters
    if (direction === "IN") {
      if (finalType === "ANSWERED") {
        // nothing to increment in "missed" for incoming
      } else {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1; // treat missed/dropped/abandoned together for now
        metrics.abandonedToday += 1; // for IVR, "ended without answer" is effectively abandoned
      }
    } else {
      if (finalType === "CONNECTED") {
        // ok
      } else {
        metrics.outgoing.cancelled += 1;
      }
    }

    // Per-agent productivity
    if (finalAgentId) {
      const a = ensureAgent(finalAgentId);
      if (a) {
        if (direction === "IN") {
          if (finalType === "ANSWERED") a.inboundHandled += 1;
          else a.inboundMissed += 1;
        } else {
          if (finalType === "CONNECTED") a.outboundHandled += 1;
          else a.outboundMissed += 1;
        }
        a.talkSeconds += talkSeconds;
        a.onCallNow = false;
      }
    }

    liveCalls.delete(callId);
    recomputeActiveAgentsOnCall();
    broadcast();
    return;
  }

  // Other events ignored for now
  // console.log("ℹ️ Event received:", eventName);
});

// Cleanup stale live calls (in case we miss an END event)
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 30 * 60 * 1000; // 30 minutes
  let changed = false;

  for (const [callId, c] of liveCalls.entries()) {
    if (now - c.startedAt > STALE_MS) {
      liveCalls.delete(callId);
      if (c.direction === "IN") clampDown(metrics.incoming, "inProgress");
      else clampDown(metrics.outgoing, "inProgress");
      if (c.agentId) {
        const a = ensureAgent(c.agentId);
        if (a) a.onCallNow = false;
      }
      changed = true;
    }
  }

  if (changed) {
    recomputeActiveAgentsOnCall();
    broadcast();
  }
}, 60 * 1000);

app.get("/health", (req, res) => res.status(200).send("OK"));

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});
