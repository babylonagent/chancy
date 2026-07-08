"use strict";

/**
 * Wallet signature authentication middleware.
 *
 * Protects all state-changing /v2/ endpoints that accept a player/host address.
 * Without this, anyone who knows a player's address can act as them.
 *
 * Scheme: EIP-191 personal_sign
 * Message format: "chancy:{endpoint}:{bodyHash}:{nonce}:{timestamp}"
 *   - endpoint:  the API path (e.g. /v2/sessions/create)
 *   - bodyHash:  SHA-256 hex of canonical JSON body (binds signature to request body)
 *   - nonce:     random hex string (frontend generates)
 *   - timestamp: Unix seconds
 *
 * Client sends:
 *   Headers: x-chancy-signer: 0x... (wallet address)
 *            x-chancy-signature: 0x... (personal_sign output)
 *            x-chancy-nonce: <hex>
 *            x-chancy-timestamp: <unix-seconds>
 *            x-chancy-body-hash: <sha256 hex> (optional — server computes from req.body)
 *
 * Server verifies:
 *   1. Timestamp within ±60s window
 *   2. Body hash matches (if header provided, compare; always compute for message)
 *   3. recoverAddress(message, signature) === x-chancy-signer
 *   4. signer matches the player/host in the body
 *
 * Nonce replay prevention: in-memory Map of used nonces, TTL 120s.
 * Race-safe: nonce is RESERVED before await, deleted on failure.
 */

const crypto = require("crypto");
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

// ── Canonical JSON & Body Hashing ───────────────────────────────────────────

/**
 * Canonical JSON stringify — stable key order for body hashing.
 * Both frontend and backend MUST produce identical output.
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",") + "}";
}

/**
 * SHA-256 hex hash of canonical JSON body.
 */
function computeBodyHash(body) {
  return crypto.createHash("sha256").update(canonicalStringify(body || {})).digest("hex");
}

// ── Message Building ────────────────────────────────────────────────────────

/**
 * Build the message string that the client must sign.
 * Format: "chancy:{endpoint}:{bodyHash}:{nonce}:{timestamp}"
 *
 * @param {string} endpoint - API path (e.g. /v2/sessions/create)
 * @param {string} bHash - SHA-256 hex of canonical JSON body
 * @param {string} nonce - hex nonce
 * @param {string} timestamp - Unix seconds string
 */
function buildMessage(endpoint, bHash, nonce, timestamp) {
  return `chancy:${endpoint}:${bHash}:${nonce}:${timestamp}`;
}

// ── Signature Verification ──────────────────────────────────────────────────

/**
 * Verify a signature against a signer address.
 * @returns {Promise<boolean>}
 */
async function verifySignature(message, signature, expectedSigner) {
  try {
    return await verifyMessage({ message, signature, address: expectedSigner });
  } catch {
    return false;
  }
}

// ── Middleware ──────────────────────────────────────────────────────────────

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
    const clientBodyHash = req.headers["x-chancy-body-hash"] || "";

    // All core headers required
    if (!signer || !signature || !nonce || !timestamp) {
      return res.status(401).json({ error: "SIGNATURE_REQUIRED", message: "Missing x-chancy-* headers" });
    }

    // Timestamp within window
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_WINDOW_MS / 1000) {
      return res.status(401).json({ error: "STALE_TIMESTAMP", message: "Timestamp outside ±60s window" });
    }

    // ── RACE-SAFE NONCE: reserve BEFORE any await ───────────────────────────
    // If another concurrent request with the same nonce arrives while we await,
    // it will see the nonce as used and get rejected.
    if (usedNonces.has(nonce)) {
      return res.status(401).json({ error: "NONCE_REPLAY", message: "Nonce already used" });
    }
    usedNonces.set(nonce, Date.now()); // reserve

    // Signer matches body role
    const bodySigner = req.body?.[role] || "";
    if (bodySigner.toLowerCase() !== signer.toLowerCase()) {
      usedNonces.delete(nonce); // release — not a real use
      return res.status(403).json({ error: "SIGNER_MISMATCH", message: `Signer does not match ${role}` });
    }

    // Compute body hash from parsed body
    const serverBodyHash = computeBodyHash(req.body);

    // If client sent a body hash header, verify it matches our computation
    if (clientBodyHash && clientBodyHash !== serverBodyHash) {
      usedNonces.delete(nonce); // release
      return res.status(401).json({ error: "BODY_HASH_MISMATCH", message: "Body hash does not match" });
    }

    // Verify signature over new format (with body hash)
    const endpoint = req.path;
    const message = buildMessage(endpoint, serverBodyHash, nonce, timestamp);
    const isValid = await verifySignature(message, signature, signer);

    if (!isValid) {
      usedNonces.delete(nonce); // release nonce on failed verification
      return res.status(401).json({ error: "INVALID_SIGNATURE", message: "Signature verification failed" });
    }

    // Nonce stays reserved — successful auth
    next();
  };
}

module.exports = {
  requireSignature,
  buildMessage,
  verifySignature,
  canonicalStringify,
  computeBodyHash,
};
