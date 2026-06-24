"use strict";

/**
 * Lightweight security middleware for Chancy V2 API.
 * Zero external dependencies — pure Express middleware.
 *
 * - Rate limiting: token bucket per IP / per player
 * - Stake caps: min/max stake per session
 * - Concurrent session limit per player
 * - CORS restriction to configured origins
 * - Basic security headers
 */

// ─── Rate Limiter ───────────────────────────────────────────────────────────

/**
 * Token bucket rate limiter.
 * @param {object} opts
 * @param {number} opts.maxTokens    — bucket capacity
 * @param {number} opts.refillPerSec — tokens added per second
 * @param {function} opts.keyFn      — (req) => string — bucket key
 * @param {string} opts.name         — name for error messages
 * @returns Express middleware
 */
function rateLimit({ maxTokens, refillPerSec, keyFn, name = "rate_limit" }) {
  const buckets = new Map();
  const refillMs = 1000 / refillPerSec;

  // Cleanup stale buckets every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastAccess > 300_000) buckets.delete(key);
    }
  }, 300_000).unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now, lastAccess: now };
      buckets.set(key, bucket);
    }
    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    const refilled = Math.floor(elapsed / refillMs);
    if (refilled > 0) {
      bucket.tokens = Math.min(maxTokens, bucket.tokens + refilled);
      bucket.lastRefill = now;
    }
    bucket.lastAccess = now;

    if (bucket.tokens <= 0) {
      const retryAfter = Math.ceil(refillMs / 1000);
      return res.status(429).json({
        error: "RATE_LIMITED",
        message: `Too many requests to ${name}. Retry in ${retryAfter}s.`,
        retryAfter,
      });
    }
    bucket.tokens -= 1;
    next();
  };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// ─── Stake Caps ─────────────────────────────────────────────────────────────

const MIN_STAKE = 50_000n;    // $0.05 — minimum session stake
const MAX_STAKE = 10_000_000n; // $10.00 — maximum session stake
const MAX_CONCURRENT_SESSIONS = 3; // per player

function stakeCap(req, res, next) {
  const stake = BigInt(req.body?.stake || "0");
  if (stake < MIN_STAKE) {
    return res.status(400).json({ error: "STAKE_TOO_LOW", min: MIN_STAKE.toString() });
  }
  if (stake > MAX_STAKE) {
    return res.status(400).json({ error: "STAKE_TOO_HIGH", max: MAX_STAKE.toString() });
  }
  next();
}

// ─── CORS Restriction ───────────────────────────────────────────────────────

function corsRestriction(allowedOrigins) {
  const origins = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins])
      .filter(Boolean)
      .map((o) => o.trim().replace(/\/$/, ""))
  );

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origins.size > 0 && origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");
      if (req.method === "OPTIONS") return res.status(204).end();
    } else if (origins.size === 0) {
      // No origins configured — allow all (dev mode)
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.status(204).end();
    }
    next();
  };
}

// ─── Security Headers ───────────────────────────────────────────────────────

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
}

module.exports = {
  rateLimit,
  getClientIp,
  stakeCap,
  corsRestriction,
  securityHeaders,
  MIN_STAKE,
  MAX_STAKE,
  MAX_CONCURRENT_SESSIONS,
};
