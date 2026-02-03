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
function pickEventName(body) {
  return (
    body?.event ||
    body?.EVENT ||
    body?.type ||
    body?.TYPE ||
    body?.eventName ||
    "unknown"
  );
}

function pickEventData(body) {
  return body?.data || body?.DATA || body?.payload || body?.PAYLOAD || {};
}

// Bitrix outbound webhooks use event names like:
// ONVOXIMPLANTCALLINIT, ONVOXIMPLANTCALLSTART, ONVOXIMPLANTCALLEND
function isInitEvent(e) {
  const x = String(e || "").toUpperCase();
  return x.includes("ONVOXIMPLANTCALLINIT") || x.includes("CALLINIT");
}
function isStartEvent(e) {
  const x = String(e || "").toUpperCase();
  return x.includes("ONVOXIMPLANTCALLSTART") || x.includes("CALLSTART");
}
function isEndEvent(e) {
  const x = String(e || "").toUpperCase();
  return x.includes("ONVOXIMPLANTCALLEND") || x.includes("CALLEND");
}

function wasAnswered(lc) {
  return String(lc?.status || "").toUpperCase().includes("ANSWER");
}

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
("/", (req, res) => {
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
// ---------- EVENTS ENDPOINT (Bitrix will POST here) ----------
let lastEvent = null;

app.post("/bitrix/events", (req, res) => {
  // Respond fast
  res.json({ ok: true });

  // Keep a copy for debugging
app.get("/debug/last-event", (req, res) => {
  res.json({ ok: true, lastEvent });
});

  
  lastEvent = req.body;

  const eventName = pickEventName(req.body);
  const data = pickEventData(req.body);

  console.log("📨 EVENT:", eventName, "| keys:", Object.keys(data || {}));

  // Extract call id + phone fields as best-effort across payload variations
  const callId =
    data.CALL_ID ||
    data.callId ||
    data.id ||
    data.ID ||
    data.CALL_ID_EXTERNAL ||
    data.EXTERNAL_CALL_ID;

  if (!callId) {
    console.log("⚠️ No CALL_ID found. Add /debug/last-event to inspect payload.");
    return;
  }

  const from =
    data.PHONE_NUMBER ||
    data.PHONE ||
    data.CALLER_ID ||
    data.CALLER ||
    data.FROM ||
    data.from ||
    "";

  const to =
    data.LINE_NUMBER ||
    data.LINE ||
    data.TO ||
    data.to ||
    data.DESTINATION ||
    "";

  // Agent / user handling the call (Bitrix often sends USER_ID / PORTAL_USER_ID)
  const agentId =
    data.USER_ID ||
    data.PORTAL_USER_ID ||
    data.AGENT_ID ||
    data.agentId ||
    null;

  // Direction (best effort)
  const directionRaw =
    data.DIRECTION ||
    data.direction ||
    data.CALL_DIRECTION ||
    "";

  const direction =
    String(directionRaw).toUpperCase().includes("OUT") ? "OUT" : "IN";

  // Status/state fields (best effort)
  const status =
    data.STATUS ||
    data.status ||
    data.STATE ||
    data.state ||
    eventName;

  // Ensure live call exists
  let lc = liveCalls.get(callId);
  if (!lc) {
    lc = {
      callId,
      direction,
      from,
      to,
      status: "INIT",
      agentId: null,
      startedAt: Date.now(),
    };
    liveCalls.set(callId, lc);

    if (direction === "IN") metrics.incoming.inProgress += 1;
    else metrics.outgoing.inProgress += 1;
  }

  // Update with latest info (don’t overwrite non-empty values with empty)
  if (from) lc.from = from;
  if (to) lc.to = to;
  if (direction) lc.direction = direction;
  if (agentId) lc.agentId = String(agentId);
  lc.status = String(status);

  // Update agent state (if we have agent)
  if (lc.agentId) {
    const a = ensureAgent(lc.agentId);
    a.onCallNow = !isEndEvent(eventName);
    a.name = a.name || `Agent ${lc.agentId}`;
  }

  // Interpret key call events (map Bitrix webhook event names)
  if (isInitEvent(eventName)) {
    // still ringing/initial
    lc.status = "RINGING";
  }

  if (isStartEvent(eventName)) {
    // answered
    lc.status = "ANSWERED";
    if (lc.direction === "IN") metrics.incoming.answered += 1;
    else metrics.outgoing.answered += 1;
  }

  if (isEndEvent(eventName)) {
    // finished
    lc.status = "ENDED";

    // decrement inProgress
    if (lc.direction === "IN") clampDown(metrics.incoming, "inProgress");
    else clampDown(metrics.outgoing, "inProgress");

    // If never answered and ended => missed/cancelled
    const neverAnswered = !wasAnswered(lc);

    if (lc.direction === "IN") {
      if (neverAnswered) {
        metrics.incoming.missed += 1;
        metrics.missedDroppedAbandoned += 1;
        if (lc.agentId) ensureAgent(lc.agentId).inboundMissed += 1;
      }
    } else {
      if (neverAnswered) {
        metrics.outgoing.cancelled += 1;
        if (lc.agentId) ensureAgent(lc.agentId).outboundMissed += 1;
      }
    }

    // agent no longer on call
    if (lc.agentId) ensureAgent(lc.agentId).onCallNow = false;

    // remove call from live list
    liveCalls.delete(callId);
  }

  broadcast();
});


// ---------- WALLBOARD UI (HTML) ----------
app.get("/wallboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getWallboardHtml());
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
function getWallboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fincorp Contact Center Wallboard</title>
  <style>
    :root{
      --vodafone-red:#E60000;
      --bg:#0b0f14;
      --panel:#121923;
      --panel2:#0f151e;
      --text:#eaf0f7;
      --muted:#9fb0c3;
      --good:#2ecc71;
      --bad:#ff4d4d;
      --warn:#f6c343;
      --border:rgba(255,255,255,.08);
      --shadow: 0 12px 30px rgba(0,0,0,.35);
      --radius: 16px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial;
      color:var(--text);
      background: radial-gradient(1200px 600px at 20% 0%, rgba(230,0,0,.12), transparent 60%),
                  radial-gradient(1000px 500px at 100% 20%, rgba(0,170,255,.12), transparent 55%),
                  var(--bg);
    }
    .topbar{
      position:sticky; top:0; z-index:5;
      background: linear-gradient(180deg, rgba(11,15,20,.95), rgba(11,15,20,.78));
      backdrop-filter: blur(10px);
      border-bottom:1px solid var(--border);
    }
    .wrap{max-width:1280px; margin:0 auto; padding:18px 18px;}
    .brand{
      display:flex; align-items:center; gap:12px; justify-content:space-between;
    }
    .brand-left{display:flex; align-items:center; gap:12px;}
    .dot{
      width:12px;height:12px;border-radius:50%;
      background:var(--vodafone-red);
      box-shadow:0 0 0 6px rgba(230,0,0,.12);
    }
    h1{margin:0; font-size:18px; letter-spacing:.2px}
    .sub{margin:2px 0 0; color:var(--muted); font-size:12px}
    .status{
      display:flex; align-items:center; gap:10px; font-size:12px; color:var(--muted);
      padding:8px 10px; border:1px solid var(--border); border-radius:999px;
      background: rgba(18,25,35,.55);
    }
    .badge{
      width:10px;height:10px;border-radius:50%;
      background:var(--warn);
      box-shadow:0 0 0 6px rgba(246,195,67,.10);
    }

    .grid{
      display:grid;
      grid-template-columns: 1fr;
      gap:14px;
      padding:18px;
      max-width:1280px;
      margin:0 auto;
    }
    @media(min-width:900px){
      .grid{grid-template-columns: 1.1fr .9fr;}
    }

    .card{
      background: linear-gradient(180deg, rgba(18,25,35,.92), rgba(15,21,30,.85));
      border:1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .card-h{
      padding:14px 16px;
      border-bottom:1px solid var(--border);
      display:flex; justify-content:space-between; align-items:center;
    }
    .card-h strong{font-size:13px; letter-spacing:.2px}
    .pill{
      font-size:11px; color:var(--muted);
      border:1px solid var(--border);
      padding:6px 10px; border-radius:999px;
      background: rgba(0,0,0,.15);
    }
    .content{padding:14px 16px;}

    .kpis{
      display:grid;
      grid-template-columns: repeat(2, 1fr);
      gap:12px;
    }
    @media(min-width:600px){
      .kpis{grid-template-columns: repeat(4, 1fr);}
    }
    .kpi{
      padding:12px;
      border:1px solid var(--border);
      border-radius: 14px;
      background: rgba(0,0,0,.12);
    }
    .kpi .label{color:var(--muted); font-size:11px}
    .kpi .val{font-size:26px; font-weight:700; margin-top:6px}
    .kpi .meta{color:var(--muted); font-size:11px; margin-top:6px}
    .kpi.red .val{color:var(--vodafone-red)}
    .kpi.good .val{color:var(--good)}

    .row{
      display:grid;
      grid-template-columns: 1fr;
      gap:12px;
      margin-top:12px;
    }
    @media(min-width:900px){
      .row{grid-template-columns: 1fr 1fr;}
    }

    table{
      width:100%;
      border-collapse:collapse;
      font-size:12px;
    }
    th, td{
      padding:10px 10px;
      border-bottom:1px solid var(--border);
      text-align:left;
      color: var(--text);
    }
    th{color:var(--muted); font-weight:600; font-size:11px; letter-spacing:.2px}
    .small{font-size:11px; color:var(--muted)}
    .tag{
      display:inline-flex; align-items:center; gap:6px;
      padding:6px 10px; border-radius:999px;
      border:1px solid var(--border);
      background: rgba(0,0,0,.12);
      font-size:11px;
      color: var(--muted);
    }
    .tag .b{width:8px;height:8px;border-radius:50%;}
    .b.good{background:var(--good)}
    .b.bad{background:var(--bad)}
    .b.warn{background:var(--warn)}
    .footer{
      max-width:1280px; margin:0 auto; padding:0 18px 24px;
      color:var(--muted); font-size:11px;
    }
    .muted{color:var(--muted)}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="wrap">
      <div class="brand">
        <div class="brand-left">
          <div class="dot"></div>
          <div>
            <h1>Fincorp Contact Center Wallboard</h1>
            <div class="sub">Live call activity • Auto-refresh</div>
          </div>
        </div>
        <div class="status">
          <span class="badge" id="badge"></span>
          <span id="connText">Connecting…</span>
          <span class="mono" id="lastTs"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-h">
        <strong>Call Metrics</strong>
        <span class="pill">Source: /debug/state</span>
      </div>
      <div class="content">
        <div class="kpis">
          <div class="kpi">
            <div class="label">Inbound • In Progress</div>
            <div class="val" id="inProg">0</div>
            <div class="meta">Current active inbound calls</div>
          </div>
          <div class="kpi good">
            <div class="label">Inbound • Answered</div>
            <div class="val" id="inAns">0</div>
            <div class="meta">Answered inbound calls</div>
          </div>
          <div class="kpi red">
            <div class="label">Inbound • Missed</div>
            <div class="val" id="inMiss">0</div>
            <div class="meta">Missed inbound calls</div>
          </div>
          <div class="kpi red">
            <div class="label">Missed/Dropped/Abandoned</div>
            <div class="val" id="mda">0</div>
            <div class="meta">All missed-type totals</div>
          </div>
        </div>

        <div class="row">
          <div class="kpi">
            <div class="label">Outbound • In Progress</div>
            <div class="val" id="outProg">0</div>
            <div class="meta">Current active outbound calls</div>
          </div>
          <div class="kpi">
            <div class="label">Outbound • Answered</div>
            <div class="val" id="outAns">0</div>
            <div class="meta">Answered outbound calls</div>
          </div>
          <div class="kpi">
            <div class="label">Outbound • Cancelled</div>
            <div class="val" id="outCan">0</div>
            <div class="meta">Cancelled outbound calls</div>
          </div>
          <div class="kpi">
            <div class="label">Portals Stored</div>
            <div class="val" id="portals">0</div>
            <div class="meta">Install tokens stored</div>
          </div>
        </div>

        <div style="margin-top:12px" class="small">
          <span class="tag"><span class="b good"></span>Healthy</span>
          <span class="tag"><span class="b warn"></span>Connecting</span>
          <span class="tag"><span class="b bad"></span>Offline</span>
          <span class="muted"> • Tip: Keep this tab open on a TV/monitor for a live wallboard.</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">
        <strong>Live View</strong>
        <span class="pill" id="liveCount">0 live calls</span>
      </div>
      <div class="content">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
          <div class="small">Calls in progress (if you’re tracking live calls)</div>
          <div class="small mono" id="uptime"></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Direction</th>
              <th>Caller / From</th>
              <th>To</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="callsBody">
            <tr><td colspan="4" class="small muted">No active calls</td></tr>
          </tbody>
        </table>

        <div style="height:12px"></div>

        <div class="small" style="margin-bottom:8px;">Agents (if you’re tracking agents)</div>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Inbound Missed</th>
              <th>Outbound Missed</th>
            </tr>
          </thead>
          <tbody id="agentsBody">
            <tr><td colspan="4" class="small muted">No agent data</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="footer">
    <div>Backend: <span class="mono">/health</span>, <span class="mono">/debug/state</span>, <span class="mono">/bitrix/events</span></div>
  </div>

<script>
  const els = {
    badge: document.getElementById("badge"),
    connText: document.getElementById("connText"),
    lastTs: document.getElementById("lastTs"),
    portals: document.getElementById("portals"),
    inProg: document.getElementById("inProg"),
    inAns: document.getElementById("inAns"),
    inMiss: document.getElementById("inMiss"),
    outProg: document.getElementById("outProg"),
    outAns: document.getElementById("outAns"),
    outCan: document.getElementById("outCan"),
    mda: document.getElementById("mda"),
    callsBody: document.getElementById("callsBody"),
    agentsBody: document.getElementById("agentsBody"),
    liveCount: document.getElementById("liveCount"),
    uptime: document.getElementById("uptime")
  };

  let lastOk = 0;
  let startedAt = Date.now();

  function setStatus(mode, text){
    els.connText.textContent = text;
    if(mode === "good"){
      els.badge.style.background = "var(--good)";
      els.badge.style.boxShadow = "0 0 0 6px rgba(46,204,113,.10)";
    } else if(mode === "bad"){
      els.badge.style.background = "var(--bad)";
      els.badge.style.boxShadow = "0 0 0 6px rgba(255,77,77,.10)";
    } else {
      els.badge.style.background = "var(--warn)";
      els.badge.style.boxShadow = "0 0 0 6px rgba(246,195,67,.10)";
    }
  }

  function fmtUptime(ms){
    const s = Math.floor(ms/1000);
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const ss = s%60;
    return \`Uptime: \${h}h \${m}m \${ss}s\`;
  }

  function safeText(v){ return (v === undefined || v === null) ? "" : String(v); }

  function renderCalls(liveCalls){
    const calls = Array.isArray(liveCalls) ? liveCalls : [];
    els.liveCount.textContent = calls.length + " live calls";
    if(!calls.length){
      els.callsBody.innerHTML = '<tr><td colspan="4" class="small muted">No active calls</td></tr>';
      return;
    }
    els.callsBody.innerHTML = calls.map(c => {
      const dir = safeText(c.direction || c.dir || "");
      const from = safeText(c.from || c.caller || c.CALLER || "");
      const to = safeText(c.to || c.destination || c.TO || "");
      const st = safeText(c.status || c.state || "");
      return \`<tr>
        <td>\${dir}</td>
        <td>\${from}</td>
        <td>\${to}</td>
        <td>\${st}</td>
      </tr>\`;
    }).join("");
  }

  function renderAgents(agents){
    const a = Array.isArray(agents) ? agents : [];
    if(!a.length){
      els.agentsBody.innerHTML = '<tr><td colspan="4" class="small muted">No agent data</td></tr>';
      return;
    }
    els.agentsBody.innerHTML = a.map(x => {
      const name = safeText(x.name || x.agentName || x.id || "");
      const onCall = !!(x.onCallNow || x.onCall);
      const status = onCall ? '<span class="tag"><span class="b good"></span>On Call</span>' : '<span class="tag"><span class="b warn"></span>Idle</span>';
      const inM = safeText(x.inboundMissed || 0);
      const outM = safeText(x.outboundMissed || 0);
      return \`<tr>
        <td>\${name}</td>
        <td>\${status}</td>
        <td>\${inM}</td>
        <td>\${outM}</td>
      </tr>\`;
    }).join("");
  }

  async function poll(){
    try{
      setStatus("warn", "Connecting…");
      const r = await fetch("/debug/state", { cache: "no-store" });
      if(!r.ok) throw new Error("HTTP " + r.status);
      const s = await r.json();

      // fill KPIs (your backend already returns these)
      const m = s.metrics || {};
      const incoming = m.incoming || {};
      const outgoing = m.outgoing || {};

      els.portals.textContent = safeText(s.portalsStored ?? 0);
      els.inProg.textContent = safeText(incoming.inProgress ?? 0);
      els.inAns.textContent = safeText(incoming.answered ?? 0);
      els.inMiss.textContent = safeText(incoming.missed ?? 0);
      els.outProg.textContent = safeText(outgoing.inProgress ?? 0);
      els.outAns.textContent = safeText(outgoing.answered ?? 0);
      els.outCan.textContent = safeText(outgoing.cancelled ?? 0);
      els.mda.textContent = safeText(m.missedDroppedAbandoned ?? 0);

      renderCalls(s.liveCalls || []);
      renderAgents(s.agents || []);

      lastOk = Date.now();
      els.lastTs.textContent = new Date().toLocaleTimeString();
      setStatus("good", "Live");
    } catch(e){
      const age = Date.now() - lastOk;
      setStatus("bad", age < 8000 ? "Intermittent…" : "Offline");
    } finally {
      els.uptime.textContent = fmtUptime(Date.now() - startedAt);
    }
  }

  poll();
  setInterval(poll, 1000);
</script>
</body>
</html>`;
}

// -------------------- Listen --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
