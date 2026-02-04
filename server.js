/**
 * server.js — Bitrix24 Wallboard Backend (Railway)
 * ------------------------------------------------
 * Key features:
 * 1) Daily reset of metrics at midnight
 * 2) Working hours tracking (8 AM to 6 PM GMT+10)
 * 3) Date display in Papua New Guinea timezone
 * 4) Previous day stats in separate tab
 */

"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

// -------------------- Config --------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const DATA_DIR = (process.env.DATA_DIR || "/data").trim();
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");
const DAILY_STATS_FILE = path.join(DATA_DIR, "dailyStats.json");

// Working hours: 8 AM to 6 PM in Papua New Guinea time (GMT+10)
const WORK_START_HOUR = 8; // 8 AM in GMT+10
const WORK_END_HOUR = 18;  // 6 PM in GMT+10

// Papua New Guinea timezone
const TIMEZONE = 'Pacific/Port_Moresby'; // GMT+10

// In-memory state
let portalTokens = {};
const lastEvents = [];

// Daily metrics (reset daily)
let dailyMetrics = {
  date: getCurrentDate(),
  isWithinWorkHours: checkIfWithinWorkHours(),
  incoming: { inProgress: 0, answered: 0, missed: 0 },
  outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
  startedAt: new Date().toISOString(),
  lastReset: new Date().toISOString()
};

// Previous day stats (loaded from file)
let previousDayStats = {
  date: "",
  incoming: { answered: 0, missed: 0 },
  outgoing: { answered: 0, cancelled: 0 },
  missedDroppedAbandoned: 0,
  totalCalls: 0
};

const liveCalls = new Map();
const agents = new Map();

// -------------------- Timezone Helper Functions --------------------
function getPNGTime() {
  // Convert UTC to Papua New Guinea time (GMT+10)
  const now = new Date();
  const pngOffset = 10 * 60; // GMT+10 in minutes
  const pngTime = new Date(now.getTime() + pngOffset * 60000);
  return pngTime;
}

function getCurrentDate() {
  const pngTime = getPNGTime();
  return pngTime.toISOString().split('T')[0]; // YYYY-MM-DD format
}

function getCurrentDateTime() {
  return getPNGTime().toISOString();
}

function checkIfWithinWorkHours() {
  const pngTime = getPNGTime();
  const hour = pngTime.getUTCHours(); // Using getUTCHours because we already added offset
  const minute = pngTime.getUTCMinutes();
  
  // Check if current time is between 8:00 AM and 6:00 PM PNG time
  const currentTimeInMinutes = hour * 60 + minute;
  const workStartInMinutes = WORK_START_HOUR * 60; // 8:00 AM = 480 minutes
  const workEndInMinutes = WORK_END_HOUR * 60;     // 6:00 PM = 1080 minutes
  
  return currentTimeInMinutes >= workStartInMinutes && currentTimeInMinutes < workEndInMinutes;
}

function formatTimePNG(date) {
  const pngTime = getPNGTime();
  return pngTime.toLocaleTimeString('en-AU', { 
    timeZone: 'Australia/Sydney', // Closest to PNG timezone
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  });
}

function formatDatePNG(date) {
  const pngTime = getPNGTime();
  return pngTime.toLocaleDateString('en-AU', { 
    timeZone: 'Australia/Sydney',
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
}

function formatDateTimePNG(date) {
  const pngTime = getPNGTime();
  return {
    date: pngTime.toLocaleDateString('en-AU', { 
      timeZone: 'Australia/Sydney',
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    }),
    time: pngTime.toLocaleTimeString('en-AU', { 
      timeZone: 'Australia/Sydney',
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: false 
    })
  };
}

function getWorkHoursStatus() {
  const pngTime = getPNGTime();
  const hour = pngTime.getUTCHours();
  const minute = pngTime.getUTCMinutes();
  const isWorkHours = checkIfWithinWorkHours();
  
  // Log for debugging
  console.log(`🌐 PNG Time: ${hour}:${minute.toString().padStart(2, '0')} (GMT+10)`);
  console.log(`🏢 Work hours check: ${isWorkHours ? 'OPEN' : 'CLOSED'}`);
  
  if (isWorkHours) {
    const remainingMinutes = (WORK_END_HOUR * 60) - (hour * 60 + minute);
    const remainingHours = Math.floor(remainingMinutes / 60);
    const remainingMins = remainingMinutes % 60;
    
    // Format closing time
    const closingTime = `${WORK_END_HOUR.toString().padStart(2, '0')}:00`;
    
    return `Open (Closes at ${closingTime} - ${remainingHours}h ${remainingMins}m remaining)`;
  } else {
    if (hour < WORK_START_HOUR) {
      const remainingMinutes = (WORK_START_HOUR * 60) - (hour * 60 + minute);
      const remainingHours = Math.floor(remainingMinutes / 60);
      const remainingMins = remainingMinutes % 60;
      return `Closed (Opens at 08:00 - in ${remainingHours}h ${remainingMins}m)`;
    } else {
      // Calculate time until tomorrow 8 AM
      const minutesUntilMidnight = (24 * 60) - (hour * 60 + minute);
      const minutesFromMidnightTo8AM = WORK_START_HOUR * 60;
      const remainingMinutes = minutesUntilMidnight + minutesFromMidnightTo8AM;
      const remainingHours = Math.floor(remainingMinutes / 60);
      const remainingMins = remainingMinutes % 60;
      return `Closed (Opens at 08:00 - in ${remainingHours}h ${remainingMins}m)`;
    }
  }
}

function loadDailyStats() {
  try {
    ensureDir(DATA_DIR);
    if (!fs.existsSync(DAILY_STATS_FILE)) return {};
    const raw = fs.readFileSync(DAILY_STATS_FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("❌ Failed to load daily stats:", e);
    return {};
  }
}

function saveDailyStats(stats) {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Failed to save daily stats:", e);
  }
}

function checkAndResetDailyMetrics() {
  const currentDate = getCurrentDate();
  
  if (dailyMetrics.date !== currentDate) {
    console.log(`🔄 Resetting daily metrics for ${currentDate}`);
    
    // Save yesterday's stats
    const yesterdayStats = {
      date: dailyMetrics.date,
      incoming: { 
        answered: dailyMetrics.incoming.answered,
        missed: dailyMetrics.incoming.missed
      },
      outgoing: { 
        answered: dailyMetrics.outgoing.answered,
        cancelled: dailyMetrics.outgoing.cancelled
      },
      missedDroppedAbandoned: dailyMetrics.missedDroppedAbandoned,
      totalCalls: dailyMetrics.incoming.answered + dailyMetrics.incoming.missed + 
                  dailyMetrics.outgoing.answered + dailyMetrics.outgoing.cancelled,
      endedAt: new Date().toISOString()
    };
    
    // Load existing stats and save
    const allStats = loadDailyStats();
    allStats[dailyMetrics.date] = yesterdayStats;
    saveDailyStats(allStats);
    
    // Load previous day stats
    previousDayStats = yesterdayStats;
    
    // Reset daily metrics
    dailyMetrics = {
      date: currentDate,
      isWithinWorkHours: checkIfWithinWorkHours(),
      incoming: { inProgress: 0, answered: 0, missed: 0 },
      outgoing: { inProgress: 0, answered: 0, cancelled: 0 },
      missedDroppedAbandoned: 0,
      startedAt: new Date().toISOString(),
      lastReset: new Date().toISOString()
    };
    
    // Reset agent daily stats but keep their IDs/names
    for (const agent of agents.values()) {
      agent.inboundMissed = 0;
      agent.outboundMissed = 0;
    }
  }
}

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

function clampDown(obj, key) {
  if (!obj || typeof obj[key] !== "number") return;
  obj[key] = Math.max(0, obj[key] - 1);
}

function ensureAgent(agentId, agentName = "") {
  if (!agentId) return null;
  
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agentId,
      name: agentName || `Agent ${agentId}`,
      onCallNow: false,
      inboundMissed: 0,
      outboundMissed: 0,
    });
  } else if (agentName && agentName !== agents.get(agentId).name) {
    const agent = agents.get(agentId);
    agent.name = agentName;
  }
  
  return agents.get(agentId);
}

function extractCallerNumber(data) {
  const possibleFields = [
    'PHONE_NUMBER', 'CALLER_ID', 'CALLER', 'FROM_NUMBER', 'FROM', 
    'from', 'phoneNumber', 'phone', 'PHONE', 'NUMBER', 'number', 'CALLER_NUMBER'
  ];
  
  for (const field of possibleFields) {
    if (data[field] && data[field].toString().trim()) {
      // Extract only digits from the phone number
      const rawNumber = data[field].toString().trim();
      const digitsOnly = rawNumber.replace(/\D/g, '');
      return digitsOnly || rawNumber; // Return digits only if found, otherwise raw
    }
  }
  
  return "";
}

function extractAgentName(data) {
  // Bitrix24 typically sends user info in these fields
  const possibleFields = [
    'USER_NAME',        // Bitrix user name
    'USER_FULL_NAME',   // Bitrix full name
    'USER',             // Sometimes just USER
    'AGENT_NAME',       // Alternative field
    'AGENT_FULL_NAME',  // Alternative full name
    'agentName',        // lowercase variant
    'agent_name',       // snake_case variant
    'FULL_NAME',        // Generic full name
    'fullName',         // camelCase variant
    'NAME',             // Simple name
    'name',             // lowercase name
    'PORTAL_USER_NAME', // Portal user name
    'PORTAL_USER_FULL_NAME' // Portal user full name
  ];
  
  for (const field of possibleFields) {
    if (data[field] && data[field].toString().trim()) {
      const name = data[field].toString().trim();
      console.log(`👤 Extracted agent name from field '${field}': ${name}`);
      return name;
    }
  }
  
  return ""; // Return empty if not found
}

function extractAgentId(data) {
  const possibleFields = [
    'USER_ID', 'PORTAL_USER_ID', 'AGENT_ID', 
    'agentId', 'agent_id', 'USER', 'user', 'userId'
  ];
  
  for (const field of possibleFields) {
    if (data[field] && data[field].toString().trim()) {
      const id = data[field].toString().trim();
      console.log(`🔢 Extracted agent ID from field '${field}': ${id}`);
      return id;
    }
  }
  
  return null;
}

// -------------------- App --------------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));

// Initialize
console.log("🚀 Boot");
portalTokens = loadTokens();

// Load previous day stats
const allStats = loadDailyStats();
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yesterdayDate = yesterday.toISOString().split('T')[0];
if (allStats[yesterdayDate]) {
  previousDayStats = allStats[yesterdayDate];
}

// Check and reset metrics on startup
checkAndResetDailyMetrics();

// Schedule daily reset check every minute
setInterval(() => {
  checkAndResetDailyMetrics();
  // Update work hours status
  dailyMetrics.isWithinWorkHours = checkIfWithinWorkHours();
}, 60000);

// Update work hours status periodically
setInterval(() => {
  dailyMetrics.isWithinWorkHours = checkIfWithinWorkHours();
}, 30000);

// Heartbeat with PNG time
setInterval(() => {
  const pngTime = getPNGTime();
  console.log("🫀 alive", pngTime.toISOString(), "(GMT+10)");
}, 30000);

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.type("text/plain").send("Bitrix24 Wallboard Backend is running.");
});

app.post("/bitrix/install", (req, res) => {
  try {
    const domain = req.query.DOMAIN || req.body.DOMAIN || req.body.domain || "unknown-domain";
    const memberId = req.body.member_id || req.body.MEMBER_ID || "unknown-member";
    const key = `${domain}|${memberId}`;
    
    portalTokens[key] = {
      domain,
      memberId,
      installedAt: new Date().toISOString(),
    };

    saveTokens(portalTokens);
    console.log("✅ INSTALL stored portal key:", key);

    return res.json({
      ok: true,
      message: "Installed OK. Configure Bitrix Outbound Webhook to POST events to /bitrix/events.",
    });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- EVENTS ENDPOINT --------------------
let lastEvent = null;

app.post("/bitrix/events", (req, res) => {
  res.json({ ok: true });
  lastEvent = req.body;
  
  const eventName = pickEventName(req.body);
  const data = pickEventData(req.body);
  
  console.log("📨 EVENT:", eventName);
  console.log("📊 Event data keys:", Object.keys(data).join(', '));

  const callId = data.CALL_ID || data.callId || data.id || data.ID || data.CALL_ID_EXTERNAL || data.EXTERNAL_CALL_ID || data.externalCallId;

  if (!callId) {
    console.log("⚠️ No CALL_ID found.");
    return;
  }

  // Get PNG time for logging
  const pngTime = getPNGTime();
  const currentPNGTime = pngTime.toLocaleTimeString('en-AU', { 
    timeZone: 'Australia/Sydney',
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });

  // Only process calls during work hours
  if (!dailyMetrics.isWithinWorkHours) {
    console.log(`⏰ Outside work hours (${currentPNGTime} GMT+10), ignoring call ${callId}`);
    return;
  }

  const from = extractCallerNumber(data);
  const to = data.LINE_NUMBER || data.LINE || data.TO || data.to || data.DESTINATION || data.destination || "";
  const agentId = extractAgentId(data);
  const agentName = extractAgentName(data);
  const directionRaw = data.DIRECTION || data.direction || data.CALL_DIRECTION || data.callDirection || "";
  const direction = String(directionRaw).toUpperCase().includes("OUT") ? "OUT" : "IN";
  const status = data.STATUS || data.status || data.STATE || data.state || eventName;

  let lc = liveCalls.get(callId);
  if (!lc) {
    lc = {
      callId,
      direction,
      from,
      to,
      status: "INIT",
      wasAnswered: false,
      agentId: null,
      agentName: "",
      startedAt: Date.now(),
    };
    liveCalls.set(callId, lc);

    if (direction === "IN") dailyMetrics.incoming.inProgress += 1;
    else dailyMetrics.outgoing.inProgress += 1;
  }

  // Update with latest info
  if (from) lc.from = from;
  if (to) lc.to = to;
  if (direction) lc.direction = direction;
  
  // Update agent info - prioritize new info from event
  if (agentId) {
    lc.agentId = String(agentId);
  }
  if (agentName) {
    lc.agentName = agentName;
  }
  
  lc.status = String(status);

  // Update agent state (if we have agent)
  if (lc.agentId) {
    const a = ensureAgent(lc.agentId, lc.agentName || agentName);
    a.onCallNow = !isEndEvent(eventName);
    
    // Update agent name from the call data if available
    if (lc.agentName && a.name !== lc.agentName) {
      a.name = lc.agentName;
      console.log(`📝 Updated agent ${lc.agentId} name to: ${lc.agentName}`);
    }
  }

  if (isInitEvent(eventName)) {
    lc.status = "RINGING";
    console.log(`📞 ${direction === 'IN' ? 'Inbound' : 'Outbound'} call ${callId}: ${from || 'Unknown'} → ${to || 'Unknown'}`);
  }

  if (isStartEvent(eventName)) {
    lc.status = "ANSWERED";
    lc.wasAnswered = true;
    
    // Make sure we have the agent info from this event
    if (agentId && !lc.agentId) {
      lc.agentId = String(agentId);
    }
    if (agentName && !lc.agentName) {
      lc.agentName = agentName;
    }
    
    console.log(`✅ Call ${callId} answered by ${lc.agentName || `Agent ${lc.agentId}` || 'Unknown'}`);
    
    if (lc.direction === "IN") {
      dailyMetrics.incoming.answered += 1;
      clampDown(dailyMetrics.incoming, "inProgress");
    } else {
      dailyMetrics.outgoing.answered += 1;
      clampDown(dailyMetrics.outgoing, "inProgress");
    }
  }

  if (isEndEvent(eventName)) {
    lc.status = "ENDED";

    if (!lc.wasAnswered) {
      if (lc.direction === "IN") {
        clampDown(dailyMetrics.incoming, "inProgress");
        dailyMetrics.incoming.missed += 1;
        dailyMetrics.missedDroppedAbandoned += 1;
        if (lc.agentId) {
          const agent = ensureAgent(lc.agentId, lc.agentName);
          agent.inboundMissed += 1;
        }
      } else {
        clampDown(dailyMetrics.outgoing, "inProgress");
        dailyMetrics.outgoing.cancelled += 1;
        if (lc.agentId) {
          const agent = ensureAgent(lc.agentId, lc.agentName);
          agent.outboundMissed += 1;
        }
      }
      console.log(`❌ Call ${callId} ${lc.direction === 'IN' ? 'missed' : 'cancelled'}`);
    } else {
      console.log(`📞 Call ${callId} ended`);
    }

    if (lc.agentId) ensureAgent(lc.agentId, lc.agentName).onCallNow = false;
    liveCalls.delete(callId);
  }
});

// -------------------- Wallboard Pages --------------------
app.get("/wallboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getWallboardHtml(false));
});

app.get("/wallboard/yesterday", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getWallboardHtml(true));
});

// -------------------- Debug Endpoints --------------------
app.get("/debug/last-event", (req, res) => {
  res.json({ ok: true, lastEvent });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => {
  const pngDateTime = formatDateTimePNG();
  
  res.json({
    ok: true,
    currentDate: dailyMetrics.date,
    isWithinWorkHours: dailyMetrics.isWithinWorkHours,
    workHoursStatus: getWorkHoursStatus(),
    pngDateTime: {
      date: pngDateTime.date,
      time: pngDateTime.time
    },
    dailyMetrics,
    previousDayStats,
    liveCalls: Array.from(liveCalls.entries()).map(([id, v]) => ({ 
      callId: id, 
      direction: v.direction,
      from: v.from,
      to: v.to,
      status: v.status,
      agentId: v.agentId,
      agentName: v.agentName || `Agent ${v.agentId}`,
      wasAnswered: v.wasAnswered
    })),
    agents: Array.from(agents.values()),
  });
});

app.get("/debug/daily-stats", (req, res) => {
  const allStats = loadDailyStats();
  res.json({ ok: true, allStats });
});

// -------------------- HTML Generation --------------------
function getWallboardHtml(isYesterdayPage = false) {
  const pngDateTime = formatDateTimePNG();
  const currentDate = pngDateTime.date;
  const currentTime = pngDateTime.time;
  
  if (isYesterdayPage) {
    return getYesterdayStatsHtml(currentDate, currentTime);
  } else {
    return getTodayWallboardHtml(currentDate, currentTime);
  }
}

function getTodayWallboardHtml(currentDate, currentTime) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fincorp Contact Center Wallboard - Today</title>
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
      padding:12px 0;
    }
    .wrap{max-width:1280px; margin:0 auto; padding:0 18px;}
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
    .date-time{
      display:flex; align-items:center; gap:20px; font-size:12px; color:var(--muted);
    }
    .date, .time{display:flex; align-items:center; gap:6px;}
    .date:before{content:"📅";}
    .time:before{content:"🕒";}
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
    .nav-tabs{
      display:flex; gap:8px; margin-top:12px;
    }
    .nav-tab{
      padding:8px 16px; border:1px solid var(--border);
      border-radius:8px; background:rgba(18,25,35,.55);
      color:var(--muted); text-decoration:none; font-size:12px;
      transition:all 0.2s;
    }
    .nav-tab:hover{
      background:rgba(30,40,55,.7); color:var(--text);
    }
    .nav-tab.active{
      background:var(--vodafone-red); color:white; border-color:var(--vodafone-red);
    }
    .work-hours{
      padding:8px 12px; background:rgba(46,204,113,.1);
      border:1px solid rgba(46,204,113,.3); border-radius:8px;
      font-size:11px; color:#2ecc71; margin-left:auto;
    }
    .work-hours.closed{
      background:rgba(255,77,77,.1); border-color:rgba(255,77,77,.3);
      color:#ff4d4d;
    }
    .timezone{
      font-size:10px; color:var(--muted); opacity:0.7;
      margin-left:4px;
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
            <div class="sub">Live call activity • Auto-refresh • Working Hours: 8:00 AM - 6:00 PM (GMT+10)</div>
          </div>
        </div>
        <div class="date-time">
          <div class="date" id="currentDate">${currentDate}</div>
          <div class="time" id="currentTime">${currentTime} <span class="timezone">GMT+10</span></div>
          <div class="status">
            <span class="badge" id="badge"></span>
            <span id="connText">Connecting…</span>
            <span class="mono" id="lastTs"></span>
          </div>
          <div class="work-hours" id="workHoursStatus"></div>
        </div>
      </div>
      
      <div class="nav-tabs">
        <a href="/wallboard" class="nav-tab active">Today's Activity</a>
        <a href="/wallboard/yesterday" class="nav-tab">Yesterday's Stats</a>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-h">
        <strong>Today's Call Metrics</strong>
        <span class="pill" id="todayDate"></span>
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
            <div class="meta">Answered inbound calls today</div>
          </div>
          <div class="kpi red">
            <div class="label">Inbound • Missed</div>
            <div class="val" id="inMiss">0</div>
            <div class="meta">Missed inbound calls today</div>
          </div>
          <div class="kpi red">
            <div class="label">Missed/Dropped/Abandoned</div>
            <div class="val" id="mda">0</div>
            <div class="meta">All missed-type totals today</div>
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
            <div class="meta">Answered outbound calls today</div>
          </div>
          <div class="kpi">
            <div class="label">Outbound • Cancelled</div>
            <div class="val" id="outCan">0</div>
            <div class="meta">Cancelled outbound calls today</div>
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
          <div class="small">Calls in progress (if you're tracking live calls)</div>
          <div class="small mono" id="uptime"></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Direction</th>
              <th>Caller / From</th>
              <th>To</th>
              <th>Agent</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="callsBody">
            <tr><td colspan="5" class="small muted">No active calls</td></tr>
          </tbody>
        </table>

        <div style="height:12px"></div>

        <div class="small" style="margin-bottom:8px;">Agents (if you're tracking agents)</div>
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
    currentDate: document.getElementById("currentDate"),
    currentTime: document.getElementById("currentTime"),
    workHoursStatus: document.getElementById("workHoursStatus"),
    todayDate: document.getElementById("todayDate"),
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

  function updateDateTime(){
    // Time will be updated from server response
    // We'll update it when we get fresh data from server
  }

  function renderCalls(liveCalls){
    const calls = Array.isArray(liveCalls) ? liveCalls : [];
    els.liveCount.textContent = calls.length + " live calls";
    if(!calls.length){
      els.callsBody.innerHTML = '<tr><td colspan="5" class="small muted">No active calls</td></tr>';
      return;
    }
    els.callsBody.innerHTML = calls.map(c => {
      const dir = safeText(c.direction || c.dir || "");
      const from = safeText(c.from || c.caller || c.CALLER || "Unknown");
      const to = safeText(c.to || c.destination || c.TO || "Unknown");
      const agent = safeText(c.agentName || c.agent || \`Agent \${c.agentId}\` || "No agent");
      const st = safeText(c.status || c.state || "");
      return \`<tr>
        <td>\${dir}</td>
        <td>\${from}</td>
        <td>\${to}</td>
        <td>\${agent}</td>
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
      const name = safeText(x.name || x.agentName || \`Agent \${x.agentId}\` || x.id || "");
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

      // Update PNG date and time
      if(s.pngDateTime){
        els.currentDate.textContent = s.pngDateTime.date || "";
        els.currentTime.textContent = (s.pngDateTime.time || "") + " <span class='timezone'>GMT+10</span>";
      }

      // Update work hours status
      els.workHoursStatus.textContent = s.workHoursStatus || "";
      if(s.workHoursStatus && s.workHoursStatus.includes("Closed")) {
        els.workHoursStatus.classList.add("closed");
        els.workHoursStatus.classList.remove("open");
      } else {
        els.workHoursStatus.classList.add("open");
        els.workHoursStatus.classList.remove("closed");
      }

      // Update today's date
      els.todayDate.textContent = "Today: " + (s.currentDate || "");

      // fill KPIs from daily metrics
      const m = s.dailyMetrics || {};
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

function getYesterdayStatsHtml(currentDate, currentTime) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fincorp Contact Center - Yesterday's Stats</title>
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
      padding:12px 0;
    }
    .wrap{max-width:1280px; margin:0 auto; padding:0 18px;}
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
    .date-time{
      display:flex; align-items:center; gap:20px; font-size:12px; color:var(--muted);
    }
    .date, .time{display:flex; align-items:center; gap:6px;}
    .date:before{content:"📅";}
    .time:before{content:"🕒";}
    .timezone{
      font-size:10px; color:var(--muted); opacity:0.7;
      margin-left:4px;
    }
    .nav-tabs{
      display:flex; gap:8px; margin-top:12px;
    }
    .nav-tab{
      padding:8px 16px; border:1px solid var(--border);
      border-radius:8px; background:rgba(18,25,35,.55);
      color:var(--muted); text-decoration:none; font-size:12px;
      transition:all 0.2s;
    }
    .nav-tab:hover{
      background:rgba(30,40,55,.7); color:var(--text);
    }
    .nav-tab.active{
      background:var(--vodafone-red); color:white; border-color:var(--vodafone-red);
    }

    .grid{
      display:grid;
      grid-template-columns: 1fr;
      gap:14px;
      padding:18px;
      max-width:1280px;
      margin:0 auto;
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
      margin-bottom:20px;
    }
    @media(min-width:600px){
      .kpis{grid-template-columns: repeat(4, 1fr);}
    }
    .kpi{
      padding:12px;
      border:1px solid var(--border);
      border-radius: 14px;
      background: rgba(0,0,0,.12);
      text-align:center;
    }
    .kpi .label{color:var(--muted); font-size:11px}
    .kpi .val{font-size:32px; font-weight:700; margin-top:6px}
    .kpi .meta{color:var(--muted); font-size:11px; margin-top:6px}
    .kpi.red .val{color:var(--vodafone-red)}
    .kpi.good .val{color:var(--good)}
    
    .summary{
      background: rgba(0,0,0,.15);
      border:1px solid var(--border);
      border-radius: 14px;
      padding:20px;
      margin-top:20px;
    }
    .summary h3{margin:0 0 15px 0; color:var(--text); font-size:14px;}
    .summary-grid{
      display:grid;
      grid-template-columns: repeat(2, 1fr);
      gap:15px;
    }
    @media(min-width:600px){
      .summary-grid{grid-template-columns: repeat(4, 1fr);}
    }
    .summary-item{
      text-align:center;
    }
    .summary-item .number{
      font-size:24px; font-weight:bold; color:var(--text);
      margin-bottom:5px;
    }
    .summary-item .label{
      font-size:11px; color:var(--muted);
    }
    
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
            <h1>Fincorp Contact Center - Yesterday's Statistics</h1>
            <div class="sub">Previous day call metrics and performance (GMT+10)</div>
          </div>
        </div>
        <div class="date-time">
          <div class="date" id="currentDate">${currentDate}</div>
          <div class="time" id="currentTime">${currentTime} <span class="timezone">GMT+10</span></div>
        </div>
      </div>
      
      <div class="nav-tabs">
        <a href="/wallboard" class="nav-tab">Today's Activity</a>
        <a href="/wallboard/yesterday" class="nav-tab active">Yesterday's Stats</a>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-h">
        <strong>Yesterday's Performance Summary</strong>
        <span class="pill" id="yesterdayDate">Loading...</span>
      </div>
      <div class="content">
        <div class="kpis">
          <div class="kpi good">
            <div class="label">Inbound Answered</div>
            <div class="val" id="y-inAns">0</div>
            <div class="meta">Inbound calls answered</div>
          </div>
          <div class="kpi red">
            <div class="label">Inbound Missed</div>
            <div class="val" id="y-inMiss">0</div>
            <div class="meta">Inbound calls missed</div>
          </div>
          <div class="kpi good">
            <div class="label">Outbound Answered</div>
            <div class="val" id="y-outAns">0</div>
            <div class="meta">Outbound calls answered</div>
          </div>
          <div class="kpi">
            <div class="label">Outbound Cancelled</div>
            <div class="val" id="y-outCan">0</div>
            <div class="meta">Outbound calls cancelled</div>
          </div>
        </div>
        
        <div class="summary">
          <h3>Overall Statistics</h3>
          <div class="summary-grid">
            <div class="summary-item">
              <div class="number" id="totalCalls">0</div>
              <div class="label">Total Calls</div>
            </div>
            <div class="summary-item">
              <div class="number" id="totalAnswered">0</div>
              <div class="label">Total Answered</div>
            </div>
            <div class="summary-item">
              <div class="number" id="totalMissed">0</div>
              <div class="label">Total Missed</div>
            </div>
            <div class="summary-item">
              <div class="number" id="answerRate">0%</div>
              <div class="label">Answer Rate</div>
            </div>
          </div>
        </div>
        
        <div style="margin-top:20px; padding:15px; background:rgba(0,0,0,.1); border-radius:8px; border:1px solid var(--border);">
          <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">📊 Note:</div>
          <div style="font-size:11px; color:var(--muted);">
            • Statistics are automatically saved at midnight PNG time (GMT+10)<br>
            • Working hours: 8:00 AM - 6:00 PM (GMT+10)<br>
            • Only calls during work hours are counted in the statistics
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div>Backend: <span class="mono">/health</span>, <span class="mono">/debug/state</span>, <span class="mono">/bitrix/events</span></div>
  </div>

<script>
  async function loadYesterdayStats(){
    try {
      const r = await fetch("/debug/state", { cache: "no-store" });
      if(!r.ok) throw new Error("HTTP " + r.status);
      const s = await r.json();
      
      // Update current date/time from PNG timezone
      if(s.pngDateTime){
        document.getElementById('currentDate').textContent = s.pngDateTime.date || "";
        document.getElementById('currentTime').textContent = (s.pngDateTime.time || "") + " <span class='timezone'>GMT+10</span>";
      }
      
      const stats = s.previousDayStats || {};
      
      // Update date
      document.getElementById('yesterdayDate').textContent = stats.date || "No data";
      
      // Update KPIs
      document.getElementById('y-inAns').textContent = stats.incoming?.answered || 0;
      document.getElementById('y-inMiss').textContent = stats.incoming?.missed || 0;
      document.getElementById('y-outAns').textContent = stats.outgoing?.answered || 0;
      document.getElementById('y-outCan').textContent = stats.outgoing?.cancelled || 0;
      
      // Calculate summary
      const totalAnswered = (stats.incoming?.answered || 0) + (stats.outgoing?.answered || 0);
      const totalMissed = (stats.incoming?.missed || 0) + (stats.outgoing?.cancelled || 0);
      const totalCalls = totalAnswered + totalMissed;
      const answerRate = totalCalls > 0 ? Math.round((totalAnswered / totalCalls) * 100) : 0;
      
      document.getElementById('totalCalls').textContent = totalCalls;
      document.getElementById('totalAnswered').textContent = totalAnswered;
      document.getElementById('totalMissed').textContent = totalMissed;
      document.getElementById('answerRate').textContent = answerRate + '%';
      
    } catch(e) {
      console.error("Failed to load yesterday stats:", e);
    }
  }
  
  // Load stats on page load and every 30 seconds
  loadYesterdayStats();
  setInterval(loadYesterdayStats, 30000);
</script>
</body>
</html>`;
}

// -------------------- Listen --------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log(`🌐 Configured for Papua New Guinea timezone (GMT+10)`);
  console.log(`🕒 Working hours: ${WORK_START_HOUR}:00 - ${WORK_END_HOUR}:00 (GMT+10)`);
  
  // Log current PNG time and status
  const pngTime = getPNGTime();
  const pngHour = pngTime.getUTCHours();
  const pngMinute = pngTime.getUTCMinutes();
  const isWorkHours = checkIfWithinWorkHours();
  const status = getWorkHoursStatus();
  
  console.log(`⏰ Current PNG time: ${pngHour.toString().padStart(2, '0')}:${pngMinute.toString().padStart(2, '0')} (GMT+10)`);
  console.log(`🏢 Contact Center status: ${status}`);
  console.log(`📞 Calls will ${isWorkHours ? 'be processed' : 'NOT be processed (outside work hours)'}`);
});
