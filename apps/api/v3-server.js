"use strict";

/**
 * Chancy V3 API Server (Audited)
 *
 * Clean server that only serves V3 routes:
 *   - V3 engine (game state, clicks, quit)
 *   - Notifications (player event log — auth-gated)
 *   - Health check
 *
 * No gasless endpoints. All game actions are signed by users directly on-chain.
 * The settler bot can only: adminCredit (indexer), activateGame, settleGame.
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
// Trust nginx proxy so req.ip is the real client IP (not 127.0.0.1)
app.set('trust proxy', 1);

app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-chancy-timestamp", "x-chancy-nonce", "x-chancy-signature", "x-chancy-body-hash"],
}));
app.use(securityHeaders);

// ── Simple Rate Limiter ─────────────────────────────────────────────────────
const requestCounts = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_WINDOW = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 120;        // 120 requests per minute per IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    requestCounts.set(ip, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "RATE_LIMITED" });
  }

  // Cleanup old entries periodically
  if (requestCounts.size > 1000) {
    for (const [key, val] of requestCounts) {
      if (now > val.resetAt) requestCounts.delete(key);
    }
  }

  next();
}

app.use(rateLimit);

// ── Address validation helper ───────────────────────────────────────────────
function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "v3", ts: Date.now() });
});

// ── V3 Routes ───────────────────────────────────────────────────────────────
installV3Routes(app);

// ── Notification Routes ─────────────────────────────────────────────────────
// GET /v3/notifications/:player — list events
app.get("/v3/notifications/:player", (req, res) => {
  if (!isValidAddress(req.params.player)) return res.status(400).json({ error: "INVALID_ADDRESS" });
  try {
    const list = notifStore.getNotifications(req.params.player, 50);
    res.json({ notifications: list });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_FETCH_FAILED", message: e.message });
  }
});

// GET /v3/notifications/:player/unread — unread count
app.get("/v3/notifications/:player/unread", (req, res) => {
  if (!isValidAddress(req.params.player)) return res.status(400).json({ error: "INVALID_ADDRESS" });
  try {
    const count = notifStore.getUnreadCount(req.params.player);
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_COUNT_FAILED", message: e.message });
  }
});

// POST /v3/notifications/:player/read — mark all read
app.post("/v3/notifications/:player/read", (req, res) => {
  if (!isValidAddress(req.params.player)) return res.status(400).json({ error: "INVALID_ADDRESS" });
  try {
    notifStore.markRead(req.params.player, req.body?.id || "all");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "NOTIF_MARK_FAILED", message: e.message });
  }
});

// NOTE: POST /v3/notifications/:player (create) is removed — only the engine
// creates notifications internally via global._chancyNotifications.
// External clients can only GET and mark-read.

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[v3-server] Chancy V3 API running on port ${PORT}`);
  console.log(`[v3-server] Engine routes at /v3/*`);
});
