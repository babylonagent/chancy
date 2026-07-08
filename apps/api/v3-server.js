"use strict";

/**
 * Chancy V3 API Server
 *
 * Clean server that only serves V3 routes:
 *   - V3 engine (game state, clicks, quit)
 *   - Health check
 *
 * No V2 code. No deposits. No withdrawals. No balances. No payout-relayer.
 * No SQLite. No sig-auth. No x402 (for now — will add batch settlement later).
 */

const express = require("express");
const cors = require("cors");
const { securityHeaders } = require("./security");
const { installV3Routes } = require("./v3-engine");

const PORT = process.env.V3_API_PORT || 8790;

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

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[v3-server] Chancy V3 API running on port ${PORT}`);
  console.log(`[v3-server] Engine routes at /v3/*`);
});