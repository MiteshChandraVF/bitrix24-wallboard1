const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
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

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
