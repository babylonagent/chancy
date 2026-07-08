"use strict";

/**
 * Wallet signature authentication middleware.
 *
 * Protects all state-changing /v2/ endpoints that accept a player/host address.
 * Without this, anyone who knows a player's address can act as them.
 *
 * Scheme: EIP-191 personal_sign
 * Message format: "chancy:{endpoint}:{nonce}:{timestamp}"
 *   - endpoint: the API path (e.g. /v2/sessions/create)
 *   - nonce: random hex string (frontend generates)
 *   - timestamp: Unix seconds
 *
 * Client sends:
 *   Headers: x-chancy-signer: 0x... (wallet address)
 *            x-chancy-signature: 0x... (personal_sign output)
 *            x-chancy-nonce: <hex>
 *            x-chancy-timestamp: <unix-seconds>
 *
 * Server verifies:
 *   1. Timestamp within ±60s window
 *   2. recoverAddress(message, signature) === x-chancy-signer
 *   3. signer matches the player/host in the body
 *
 * Nonce replay prevention: in-memory Set of used nonces, TTL 120s.
 */

const { verifyMessage } = require("viem");

const TIMESTAMP_WINDOW_MS = 60_000; // ±60 seconds
const NONCE_TTL_MS = 120_000;
const usedNonces = new Map(); // nonce → timestamp

// Cleanup expired nonces periodically
setInterval(() => {
  const now = Date.now();
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > NONCE_TTL_MS) usedNonces.delete(nonce);
  }
}, 60_000).unref();

/**
 * Build the message string that the client must sign.
 * @param {string} endpoint - API path (e.g. /v2/sessions/create)
 * @param {string} nonce - hex nonce
 * @param {string} timestamp - Unix seconds string
 */
function buildMessage(endpoint, nonce, timestamp) {
  return `chancy:${endpoint}:${nonce}:${timestamp}`;
}

/**
 * Verify a signature against a signer address.
 * @param {string} message - The message that was signed
 * @param {string} signature - 0x-prefixed signature
 * @param {string} expectedSigner - 0x-prefixed wallet address
 * @returns {Promise<boolean>}
 */
async function verifySignature(message, signature, expectedSigner) {
  try {
    const recovered = await verifyMessage({ message, signature, address: expectedSigner });
    return recovered;
  } catch {
    return false;
  }
}

/**
 * Express middleware factory.
 * @param {object} opts
 * @param {string} opts.role - Which body field contains the signer address ("player" | "host")
 * @returns Express middleware
 */
function requireSignature({ role = "player" } = {}) {
  return async (req, res, next) => {
    // Skip in test mode if explicitly disabled
    if (process.env.CHANCY_DISABLE_SIG_AUTH === "1") return next();

    const signer = req.headers["x-chancy-signer"] || "";
    const signature = req.headers["x-chancy-signature"] || "";
    const nonce = req.headers["x-chancy-nonce"] || "";
    const timestamp = req.headers["x-chancy-timestamp"] || "";

    // All headers required
    if (!signer || !signature || !nonce || !timestamp) {
      return res.status(401).json({ error: "SIGNATURE_REQUIRED", message: "Missing x-chancy-* headers" });
    }

    // Timestamp within window
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_WINDOW_MS / 1000) {
      return res.status(401).json({ error: "STALE_TIMESTAMP", message: "Timestamp outside ±60s window" });
    }

    // Nonce not replayed
    if (usedNonces.has(nonce)) {
      return res.status(401).json({ error: "NONCE_REPLAY", message: "Nonce already used" });
    }

    // Signer matches body role
    const bodySigner = req.body?.[role] || "";
    if (bodySigner.toLowerCase() !== signer.toLowerCase()) {
      return res.status(403).json({ error: "SIGNER_MISMATCH", message: `Signer does not match ${role}` });
    }

    // Verify signature
    const endpoint = req.path;
    const message = buildMessage(endpoint, nonce, timestamp);
    const isValid = await verifySignature(message, signature, signer);
    if (!isValid) {
      return res.status(401).json({ error: "INVALID_SIGNATURE", message: "Signature verification failed" });
    }

    // Mark nonce as used
    usedNonces.set(nonce, Date.now());
    next();
  };
}

module.exports = { requireSignature, buildMessage, verifySignature };
