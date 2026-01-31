/**
 * server.js — Bitrix24 Live Wallboard (Railway) — FINAL (supports Bitrix AUTH_ID installs)
 *
 * Works with Bitrix24 Cloud Local App install payload:
 *  - AUTH_ID (access token)
 *  - REFRESH_ID
 *  - SERVER_ENDPOINT (e.g. https://YOURDOMAIN/rest/)
 *  - member_id
 * and also supports OAuth "code" flow (if present).
 *
 * Required env vars (Railway Variables):
 *  - APP_BASE_URL           e.g. https://bitrix24-wallboard1-production.up.railway.app
 *  - BITRIX_CLIENT_ID       (only used for OAuth code flow)
 *  - BITRIX_CLIENT_SECRET   (only used for OAuth code flow)
 *
 * Optional:
 *  - PORT
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const path = require("path");

const app = express();

/** body parsers MUST be BEFORE routes */
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

/* Live state */
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

function parseDomainFromServerEndpoint(serverEndpoint) {
  // Expected: https://SOMEDOMAIN/rest/ or https://SOMEDOMAIN/rest/123/...
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

  // Official REST endpoint:
  // https://{domain}/rest/{method}
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

    // Bitrix "Local App" install often sends these:
    // query: DOMAIN, PROTOCOL, LANG, APP_SID
    // body: AUTH_ID, REFRESH_ID, SERVER_ENDPOINT, member_id, status, PLACEMENT, PLACEMENT_OPTIONS
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(q));
    console.log("🔧 INSTALL body keys:", Object.keys(b));

    const memberId = pick(b, "member_id") || pick(q, "member_id") || pick(b, "memberId") || pick(q, "memberId");

    // CASE A) Your current Bitrix payload: direct token install
    const authId = pick(b, "AUTH_ID");
    const refreshId = pick(b, "REFRESH_ID");
    const serverEndpoint = pick(b, "SERVER_ENDPOINT");

    // DOMAIN sometimes comes in query uppercase
    const domainUpper = pick(q, "DOMAIN");
    const domainLower = pick(q, "domain");
    const derivedDomain = serverEndpoint ? parseDomainFromServerEndpoint(serverEndpoint) : null;

    const domain = domainLower || domainUpper || derivedDomain;

    if (memberId && authId && domain) {
      // Store token immediately (no OAuth exchange needed)
      portals.set(memberId, {
        domain,
        access_token: authId,
        refresh_token: refreshId || null,
        // AUTH_EXPIRES is seconds; if missing, keep 1 hour default
        expires_at: Date.now() + (Number(pick(b, "AUTH_EXPIRES") || 3600) * 1000)
      });

      const handlerUrl = `${process.env.APP_BASE_URL}/bitrix/events`;

      // Bind telephony events (if telephony scope/plan allows)
      try {
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallInit", handler: handlerUrl });
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallStart", handler: handlerUrl });
        await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallEnd", handler: handlerUrl });
        console.log("✅ Installed via AUTH_ID + events bound:", { domain, memberId, handlerUrl });
      } catch (bindErr) {
        console.log("⚠️ Token stored but event.bind failed:", bindErr?.response?.data || bindErr.message);
      }

      return res.redirect(`${process.env.APP_BASE_URL}/`);
    }

    // CASE B) OAuth code flow (only if Bitrix sends `code`)
    const code = pick(q, "code") || pick(b, "code");
    const oauthDomain =
      pick(q, "domain") ||
      pick(b, "domain") ||
      pick(q, "DOMAIN") ||
      pick(b, "DOMAIN") ||
      derivedDomain;

    if (code && oauthDomain && memberId) {
      const clientId = process.env.BITRIX_CLIENT_ID;
      const clientSecret = process.env.BITRIX_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(500).send("Missing BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET for OAuth flow.");
      }

      const tokenUrl = `https://${oauthDomain}/oauth/token/`;
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
        domain: oauthDomain,
        access_token,
        refresh_token,
        expires_at: Date.now() + (Number(expires_in || 3600) * 1000)
      });

      const handlerUrl = `${process.env.APP_BASE_URL}/bitrix/events`;
      await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallInit", handler: handlerUrl });
      await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallStart", handler: handlerUrl });
      await bitrixRestCall(memberId, "event.bind", { event: "OnVoximplantCallEnd", handler: handlerUrl });

      console.log("✅ Installed via OAuth code + events bound:", { oauthDomain, memberId, handlerUrl });
      return res.redirect(`${process.env.APP_BASE_URL}/`);
    }

    console.log("❌ INSTALL missing required fields:", {
      memberId: !!memberId,
      authId: !!authId,
      domain: !!domain,
      code: !!code
    });

    // If opened from menu / user action: show UI
    return res.redirect(`${process.env.APP_BASE_URL}/`);
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
      if (a) a.onCallNow = true;
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

      // Basic classification until we enrich from voximplant.statistic.get
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
  }
});

/* =========================
   Start
   ========================= */
server.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running on port", process.env.PORT || 3000);
});
