/**
 * server.js — Bitrix24 Wallboard Backend + minimal iframe UI binder
 * - Works on Railway (listen on process.env.PORT)
 * - Persists portal tokens to DATA_DIR (default /data if set)
 * - Binds telephony events using BX24.callMethod from iframe page (/bitrix/app)
 *
 * Env:
 *   PORT=8080 (Railway sets this)
 *   DATA_DIR=/data (Railway Volume mount path)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// Bitrix sends x-www-form-urlencoded for install/events
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

// -------------------------
// Persistence (tokens)
// -------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {}
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJsonSafe(file, obj) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("❌ Failed to write tokens file:", e.message);
    return false;
  }
}

// Store tokens keyed by portal domain + member_id
let portalTokens = readJsonSafe(TOKENS_FILE, {});
console.log("🚀 Boot");
console.log("💾 Tokens file:", TOKENS_FILE);
console.log("🔑 Tokens loaded:", Object.keys(portalTokens || {}).length);

// -------------------------
// In-memory live metrics
// -------------------------
const metrics = {
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
};

const liveCalls = new Map(); // callId -> { direction, agentId, startedAt }
const agents = new Map(); // agentId -> agent metrics

function ensureAgent(agentId) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      onCallNow: false,
      inboundAnswered: 0,
      inboundMissed: 0,
      outboundAnswered: 0,
      outboundMissed: 0,
      lastCallAt: null,
    });
  }
  return agents.get(agentId);
}

function clampDown(obj, key) {
  obj[key] = Math.max(0, (obj[key] || 0) - 1);
}

function normalizeCallId(payload) {
  // Bitrix telephony payloads vary; try a few common fields
  return (
    payload.CALL_ID ||
    payload.callId ||
    payload.CALLID ||
    payload.data?.CALL_ID ||
    payload.data?.CALLID ||
    payload.data?.callId ||
    payload.call?.id ||
    null
  );
}

function detectDirection(payload) {
  // best-effort direction detection
  const dir =
    payload.DIRECTION ||
    payload.direction ||
    payload.data?.DIRECTION ||
    payload.data?.direction ||
    "";
  const up = String(dir).toUpperCase();
  if (up.includes("IN")) return "IN";
  if (up.includes("OUT")) return "OUT";

  // fallback: if has FROM and TO and "PHONE_NUMBER" etc, can't be sure
  return "IN";
}

function detectAgentId(payload) {
  return (
    payload.PORTAL_USER_ID ||
    payload.USER_ID ||
    payload.agentId ||
    payload.data?.PORTAL_USER_ID ||
    payload.data?.USER_ID ||
    payload.data?.agentId ||
    null
  );
}

// -------------------------
// Web server + WebSocket
// -------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function getState() {
  return {
    ok: true,
    portalsStored: Object.keys(portalTokens || {}).length,
    tokensFile: TOKENS_FILE,
    metrics,
    liveCalls: Array.from(liveCalls.entries()).map(([callId, v]) => ({
      callId,
      ...v,
    })),
    agents: Array.from(agents.values()),
  };
}

function broadcast() {
  const msg = JSON.stringify({ type: "state", data: getState() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", data: getState() }));
});

// -------------------------
// Routes
// -------------------------

app.get("/", (req, res) => {
  res
    .status(200)
    .send("Bitrix24 Wallboard Backend is running. Visit /bitrix/app in Bitrix.");
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => res.json(getState()));

app.get("/debug/offline", (req, res) => {
  const st = getState();
  if ((st.portalsStored || 0) < 1) {
    return res
      .status(400)
      .send('No portal token stored yet. Reinstall the Bitrix app first.');
  }
  res
    .status(200)
    .send(
      `<pre>${escapeHtml(JSON.stringify(st, null, 2))}</pre>`
    );
});

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Minimal iframe UI page:
 * - Uses BX24 JS API to bind events (avoids WRONG_AUTH_TYPE from backend)
 * - Shows status on screen
 *
 * Register this URL in Bitrix app settings as the placement/handler:
 * https://<your-domain>/bitrix/app
 */
app.get("/bitrix/app", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const handlerUrl = `${baseUrl}/bitrix/events`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bitrix Wallboard Binder</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script src="//api.bitrix24.com/api/v1/"></script>
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; background:#0b1020; color:#e9eefc; }
    .card { background:#121a33; border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:16px; max-width:740px; }
    h2 { margin:0 0 8px 0; font-size:18px; }
    .muted { opacity:.8; font-size:13px; }
    .ok { color:#61ff9a; }
    .bad { color:#ff6b6b; }
    code { background:rgba(255,255,255,.06); padding:2px 6px; border-radius:6px; }
    .log { margin-top:12px; white-space:pre-wrap; background:rgba(0,0,0,.25); padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,.08); }
    button { margin-top:12px; padding:10px 14px; border:0; border-radius:10px; cursor:pointer; font-weight:700; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Bitrix24 Wallboard — Event Binder</h2>
    <div class="muted">This page binds Voximplant call events to your webhook handler.</div>
    <div class="muted">Handler URL: <code>${handlerUrl}</code></div>
    <div id="status" style="margin-top:10px;">Initializing...</div>
    <button onclick="bindAll()">Bind events now</button>
    <div class="log" id="log"></div>
  </div>

<script>
  const handlerUrl = ${JSON.stringify(handlerUrl)};
  const eventsToBind = [
    "OnVoximplantCallInit",
    "OnVoximplantCallStart",
    "OnVoximplantCallConnected",
    "OnVoximplantCallEnd",
  ];

  function log(msg) {
    const el = document.getElementById("log");
    el.textContent += msg + "\\n";
  }

  function setStatus(ok, msg) {
    const el = document.getElementById("status");
    el.innerHTML = ok
      ? '<span class="ok">✅ ' + msg + '</span>'
      : '<span class="bad">❌ ' + msg + '</span>';
  }

  function bindOne(eventName) {
    return new Promise((resolve) => {
      BX24.callMethod("event.bind", { event: eventName, handler: handlerUrl }, function(res) {
        const err = res && res.error ? res.error() : null;
        if (err) {
          resolve({ event: eventName, ok:false, error: err });
        } else {
          resolve({ event: eventName, ok:true, result: res.data() });
        }
      });
    });
  }

  async function bindAll() {
    setStatus(true, "Binding events...");
    log("Binding to: " + handlerUrl);
    const results = [];
    for (const e of eventsToBind) {
      log("• event.bind " + e + " ...");
      const r = await bindOne(e);
      results.push(r);
      log("  -> " + (r.ok ? "OK" : ("FAIL: " + r.error)));
    }

    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;

    if (failCount === 0) setStatus(true, "All events bound successfully (" + okCount + "/" + results.length + ")");
    else setStatus(false, "Some events failed (" + okCount + "/" + results.length + "). See log.");

    // Ask Bitrix to resize iframe nicely
    try { BX24.fitWindow(); } catch(e){}
  }

  BX24.init(function() {
    setStatus(true, "BX24 initialized. Click 'Bind events now'.");
    log("BX24 initialized.");
    try { BX24.fitWindow(); } catch(e){}
  });
</script>
</body>
</html>`);
});

/**
 * Bitrix app install callback
 * Stores token material to disk.
 * DO NOT call event.bind here (often fails with WRONG_AUTH_TYPE).
 */
app.post("/bitrix/install", (req, res) => {
  const q = req.query || {};
  const b = req.body || {};

  const domain = q.DOMAIN || q.domain || b.DOMAIN || b.domain;
  const memberId = b.member_id || b.MEMBER_ID || q.member_id || q.MEMBER_ID;
  const authId = b.AUTH_ID;
  const refreshId = b.REFRESH_ID;
  const serverEndpoint = b.SERVER_ENDPOINT;

  if (!domain || !memberId) {
    console.log("❌ INSTALL missing:", { domain: !!domain, memberId: !!memberId });
    return res.status(400).send("Missing DOMAIN or member_id");
  }

  const key = `${domain}|${memberId}`;
  portalTokens[key] = {
    domain,
    memberId,
    authId: authId || null,
    refreshId: refreshId || null,
    serverEndpoint: serverEndpoint || null,
    installedAt: new Date().toISOString(),
  };

  const saved = writeJsonSafe(TOKENS_FILE, portalTokens);
  console.log("✅ INSTALL stored token for:", key);
  console.log("💾 Tokens saved to:", TOKENS_FILE, "saved=", saved);

  // Bitrix expects redirect back (302) often, but 200 is usually fine.
  // We'll do a 302 to root so iframe doesn't show blank.
  res.redirect("/");
});

/**
 * Webhook receiver for bound events
 * Bitrix will POST to this once event.bind succeeds.
 */
app.get("/bitrix/events", (req, res) => {
  res.status(405).send("Method Not Allowed. Use POST /bitrix/events");
});

app.post("/bitrix/events", (req, res) => {
  const payload = req.body || {};
  const eventName = payload.event || payload.EVENT || payload.type || payload.EVENT_NAME;

  // Many Bitrix event payloads wrap data in "data"
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;

  const callId = normalizeCallId(data);
  const direction = detectDirection(data);
  const agentId = detectAgentId(data);

  if (!eventName) {
    return res.status(200).json({ ok: true, ignored: true, reason: "no event name" });
  }

  // For debugging (keep lightweight)
  console.log("📨 EVENT:", eventName, "callId=", callId, "dir=", direction, "agentId=", agentId);

  // --- Event handling (best-effort)
  if (eventName === "OnVoximplantCallInit" || eventName === "OnVoximplantCallStart") {
    if (callId) {
      liveCalls.set(callId, {
        direction,
        agentId: agentId || null,
        startedAt: Date.now(),
      });

      if (direction === "IN") metrics.incoming.inProgress += 1;
      else metrics.outgoing.inProgress += 1;

      if (agentId) {
        const a = ensureAgent(agentId);
        if (a) a.onCallNow = true;
      }

      broadcast();
    }
  }

  if (eventName === "OnVoximplantCallConnected") {
    if (callId) {
      const lc = liveCalls.get(callId);
      if (lc) {
        // Mark answered
        if (lc.direction === "IN") {
          metrics.incoming.answered += 1;
          clampDown(metrics.incoming, "inProgress");
          if (lc.agentId) {
            const a = ensureAgent(lc.agentId);
            if (a) a.inboundAnswered += 1;
          }
        } else {
          metrics.outgoing.answered += 1;
          clampDown(metrics.outgoing, "inProgress");
          if (lc.agentId) {
            const a = ensureAgent(lc.agentId);
            if (a) a.outboundAnswered += 1;
          }
        }
        broadcast();
      }
    }
  }

  if (eventName === "OnVoximplantCallEnd") {
    if (callId) {
      const lc = liveCalls.get(callId);
      if (lc) {
        // If it ended without "connected" we count as missed/cancelled
        if (lc.direction === "IN") {
          // If you want “missed” only when not answered, we can refine later.
          metrics.incoming.missed += 1;
          metrics.missedDroppedAbandoned += 1;
          clampDown(metrics.incoming, "inProgress");

          if (lc.agentId) {
            const a = ensureAgent(lc.agentId);
            if (a) a.inboundMissed += 1;
          }
        } else {
          metrics.outgoing.cancelled += 1;
          clampDown(metrics.outgoing, "inProgress");

          if (lc.agentId) {
            const a = ensureAgent(lc.agentId);
            if (a) a.outboundMissed += 1;
          }
        }

        if (lc.agentId) {
          const a = ensureAgent(lc.agentId);
          if (a) {
            a.onCallNow = false;
            a.lastCallAt = new Date().toISOString();
          }
        }

        liveCalls.delete(callId);
        broadcast();
      }
    }
  }

  return res.status(200).json({ ok: true });
});

// -------------------------
// Start server
// -------------------------
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log(`💾 Tokens file: ${TOKENS_FILE}`);
});
