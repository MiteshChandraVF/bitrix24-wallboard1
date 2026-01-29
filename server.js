const axios = require("axios");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// In-memory “live now” state
let metrics = {
  inboundRinging: 0,
  missedToday: 0
};

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", metrics }));
});

function broadcast() {
  const msg = JSON.stringify({ type: "update", metrics });
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(msg));
}

// Bitrix telephony events land here
app.post("/bitrix/events", (req, res) => {
  const event = req.body?.event;

  if (event === "OnVoximplantCallInit") {
    metrics.inboundRinging += 1;
    broadcast();
  } else if (event === "OnVoximplantCallEnd") {
    metrics.inboundRinging = Math.max(0, metrics.inboundRinging - 1);
    metrics.missedToday += 1; // placeholder until we enrich with call history
    broadcast();
  }

  res.status(200).send("OK");
});

app.get("/api/metrics", (req, res) => res.json(metrics));

async function handleInstall(req, res) {
  try {
    // Bitrix may send params via query (GET) or body (POST)
    const code = req.query.code || req.body.code;
    const domain = req.query.domain || req.body.domain;
    const memberId = req.query.member_id || req.body.member_id;

    if (!code || !domain || !memberId) {
      console.log("Install called but missing params:", { code: !!code, domain, memberId });
      return res.status(400).send("Missing code/domain/member_id");
    }

    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;

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
      expires_at: Date.now() + (expires_in * 1000)
    });

    const handlerUrl = `${process.env.APP_BASE_URL}/bitrix/events`;

    await bitrixCall(memberId, "event.bind", {
      event: "OnVoximplantCallInit",
      handler: handlerUrl
    });

    await bitrixCall(memberId, "event.bind", {
      event: "OnVoximplantCallEnd",
      handler: handlerUrl
    });

    console.log("✅ Installed + events bound:", { domain, memberId });

    return res.redirect(`${process.env.APP_BASE_URL}/index.html`);
  } catch (e) {
    console.error("❌ Install error:", e?.response?.data || e.message);
    return res.status(500).send("Install failed. Check Railway logs.");
  }
}

// Accept BOTH GET and POST
app.get("/bitrix/install", handleInstall);
app.post("/bitrix/install", handleInstall);

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
