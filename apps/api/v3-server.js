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

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[v3-server] Chancy V3 API running on port ${PORT}`);
  console.log(`[v3-server] Engine routes at /v3/*`);
});