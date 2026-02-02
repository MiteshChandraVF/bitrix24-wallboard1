const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

// Bitrix sends application/x-www-form-urlencoded on install/events sometimes
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- ENV ----------
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const BITRIX_WEBHOOK_BASE = (process.env.BITRIX_WEBHOOK_BASE || "").replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

if (!PUBLIC_URL) console.warn("⚠️ PUBLIC_URL is not set");
if (!BITRIX_WEBHOOK_BASE) console.warn("⚠️ BITRIX_WEBHOOK_BASE is not set");

// Tokens file stored on volume
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TOKENS_FILE = path.join(DATA_DIR, "portalTokens.json");

// ---------- SIMPLE TOKEN STORE (portal-based) ----------
function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch (e) {
    console.error("❌ Failed to load tokens:", e);
    return {};
  }
}
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

let portalTokens = loadTokens();
console.log("🚀 Boot");
console.log("💾 Tokens file:", TOKENS_FILE);
console.log("🔑 Tokens loaded:", Object.keys(portalTokens).length);

// ---------- BITRIX REST CALL USING INCOMING WEBHOOK ----------
async function bitrixCall(method, params = {}) {
  if (!BITRIX_WEBHOOK_BASE) throw new Error("BITRIX_WEBHOOK_BASE is not set");

  // Incoming webhook REST format:
  // https://domain/rest/1/<token>/method.json
  const url = `${BITRIX_WEBHOOK_BASE}/${method}.json`;

  const res = await axios.post(url, params, {
    timeout: 15000,
    headers: { "Content-Type": "application/json" },
  });

  if (res.data && res.data.error) {
    throw new Error(`Bitrix REST error: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ---------- BIND VOXIMPLANT EVENTS ----------
async function bindVoximplantEvents() {
  // force HTTPS handler always
  const handler = `${PUBLIC_URL}/bitrix/events`;

  console.log("📌 Binding events to handler:", handler);

  const events = [
    "OnVoximplantCallInit",
    "OnVoximplantCallConnected",
    "OnVoximplantCallStart",
    "OnVoximplantCallEnd",
  ];

  const results = [];
  for (const ev of events) {
    try {
      const r = await bitrixCall("event.bind", {
        event: ev,
        handler,
      });
      // Bitrix returns {result: true} typically
      results.push({ event: ev, ok: true, result: r.result ?? r });
    } catch (e) {
      results.push({ event: ev, ok: false, error: e.message });
    }
  }

  console.log("📌 event.bind results:", results);
  return results;
}

// ---------- INSTALL ENDPOINT (Bitrix app install callback) ----------
app.post("/bitrix/install", async (req, res) => {
  try {
    console.log("🔧 INSTALL content-type:", req.headers["content-type"]);
    console.log("🔧 INSTALL query keys:", Object.keys(req.query || {}));
    console.log("🔧 INSTALL body keys:", Object.keys(req.body || {}));

    const domain =
      req.query.DOMAIN || req.body.DOMAIN || req.body.domain || "unknown-domain";
    const memberId = req.body.member_id || req.body.MEMBER_ID || "unknown-member";

    // store something minimal so you can see "portalsStored: 1"
    const key = `${domain}|${memberId}`;
    portalTokens[key] = {
      domain,
      memberId,
      installedAt: new Date().toISOString(),
    };

    saveTokens(portalTokens);
    console.log("✅ INSTALL stored portal key:", key);
    console.log("💾 Tokens saved to:", TOKENS_FILE);

    // IMPORTANT: bind events using Incoming Webhook (BITRIX_WEBHOOK_BASE)
    // not using AUTH_ID
    const bindResults = await bindVoximplantEvents();

    return res.json({ ok: true, bound: bindResults });
  } catch (e) {
    console.error("❌ INSTALL error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- EVENTS ENDPOINT (Bitrix will POST here) ----------
app.post("/bitrix/events", (req, res) => {
  // Respond fast
  res.json({ ok: true });

  // Log the event for verification first
  const event = req.body.event || req.body.EVENT || "unknown";
  console.log("📨 EVENT received:", event);

  // TODO: your existing call metrics logic goes here
  // Use req.body.data or req.body.DATA depending on Bitrix payload
});

// ---------- DEBUG ----------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/state", (req, res) => {
  res.json({
    ok: true,
    portalsStored: Object.keys(portalTokens).length,
    tokensFile: TOKENS_FILE,
  });
});

// ---------- LISTEN ----------
const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
});
