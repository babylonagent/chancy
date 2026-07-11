"use strict";

/**
 * Chancy V3 API Server
 *
 * Clean server that only serves V3 routes:
 *   - V3 engine (game state, clicks, quit)
 *   - Notifications (player event log)
 *   - Health check
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const { securityHeaders } = require("./security");
const { installV3Routes } = require("./v3-engine");
const notifications = require("./notifications");
const PORT = process.env.V3_API_PORT || 8790;
const DB_PATH = process.env.CHANCY_V3_DB || path.join(__dirname, "data", "v3-chancy.db");

// ── Init notifications ──────────────────────────────────────────────────────
const notifStore = notifications.init(DB_PATH);

// ── Export for v3-engine to use ─────────────────────────────────────────────
global._chancyNotifications = notifStore;

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: true, // V3 is trustless — CORS doesn't matter for security
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-chancy-timestamp", "x-chancy-nonce", "x-chancy-signature", "x-chancy-body-hash"],
}));
app.use(securityHeaders);

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "v3", ts: Date.now() });
});

// ── V3 Routes ───────────────────────────────────────────────────────────────
installV3Routes(app);

// ── Notification Routes ─────────────────────────────────────────────────────
// GET /v3/notifications/:player — list events
app.get("/v3/notifications/:player", (req, res) => {
  try {
    const list = notifStore.getNotifications(req.params.player, 50);
    res.json({ notifications: list });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_FETCH_FAILED", message: e.message });
  }
});

// GET /v3/notifications/:player/unread — unread count
app.get("/v3/notifications/:player/unread", (req, res) => {
  try {
    const count = notifStore.getUnreadCount(req.params.player);
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_COUNT_FAILED", message: e.message });
  }
});

// POST /v3/notifications/:player — create notification (for deposits/withdrawals)
app.post("/v3/notifications/:player", (req, res) => {
  try {
    notifStore.recordNotification({ player: req.params.player, ...req.body });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_CREATE_FAILED", message: e.message });
  }
});

// POST /v3/notifications/:player/read — mark all read
app.post("/v3/notifications/:player/read", (req, res) => {
  try {
    notifStore.markRead(req.params.player, req.body?.id || "all");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_MARK_FAILED", message: e.message });
  }
});

// ── Gasless Delegated Routes ────────────────────────────────────────────────
// POST /v3/gasless/host — create game on behalf of host (no wallet popup)
app.post("/v3/gasless/host", async (req, res) => {
  try {
    const { host, difficulty, prizePot, hostSecret } = req.body;
    if (!host || difficulty === undefined || !prizePot || !hostSecret) {
      return res.status(400).json({ error: "MISSING_PARAMS" });
    }
    const delegated = require("./v3-delegated");
    const result = await delegated.createGameForHost(host, Number(difficulty), prizePot, hostSecret);

    // Store host secret in engine for later activation
    const { host: _h, difficulty: d, prizePot: p } = req.body;
    const engineResp = await fetch(`http://127.0.0.1:${PORT}/v3/sessions/${result.gameId}/host-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostSecret, host, difficulty: Number(difficulty), prizePot, maxSpend: "0" }),
    });

    res.json({ ok: true, gameId: result.gameId, txHash: result.txHash });
  } catch (e) {
    console.error("[gasless/host]", e.message);
    res.status(500).json({ error: "GASLESS_HOST_FAILED", message: e.message });
  }
});

// POST /v3/gasless/join — join game on behalf of player (no wallet popup)
app.post("/v3/gasless/join", async (req, res) => {
  try {
    const { gameId, player, maxSpend, playerRandom } = req.body;
    if (!gameId || !player || !maxSpend || !playerRandom) {
      return res.status(400).json({ error: "MISSING_PARAMS" });
    }
    const delegated = require("./v3-delegated");
    const result = await delegated.joinGameForPlayer(gameId, player, maxSpend, playerRandom);

    // Tell the engine to activate the session
    const gameData = await delegated.contract.getGame(Number(gameId));
    const engineResp = await fetch(`http://127.0.0.1:${PORT}/v3/sessions/${gameId}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: gameData.host,
        player: gameData.player,
        difficulty: Number(gameData.difficulty),
        prizePot: gameData.prizePot.toString(),
        maxSpend: gameData.maxSpend.toString(),
        pythRandom: result.pythRandom,
      }),
    });

    res.json({ ok: true, gameId, txHash: result.txHash, pythRandom: result.pythRandom });
  } catch (e) {
    console.error("[gasless/join]", e.message);
    res.status(500).json({ error: "GASLESS_JOIN_FAILED", message: e.message });
  }
});

// POST /v3/gasless/withdraw — withdraw on behalf of user
app.post("/v3/gasless/withdraw", async (req, res) => {
  try {
    const { user, amount } = req.body;
    if (!user || !amount) return res.status(400).json({ error: "MISSING_PARAMS" });
    const delegated = require("./v3-delegated");
    const result = await delegated.withdrawForUser(user, amount);
    res.json({ ok: true, txHash: result.txHash });
  } catch (e) {
    console.error("[gasless/withdraw]", e.message);
    res.status(500).json({ error: "GASLESS_WITHDRAW_FAILED", message: e.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[v3-server] Chancy V3 API running on port ${PORT}`);
  console.log(`[v3-server] Engine routes at /v3/*`);
});