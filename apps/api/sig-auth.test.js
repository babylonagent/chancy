"use strict";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import { mnemonicToAccount } from "viem/accounts";

// Fresh module instance per test (isolated nonce Map)
function freshModule() {
  delete require.cache[require.resolve("./sig-auth.js")];
  return require("./sig-auth.js");
}

// ── Test wallet ─────────────────────────────────────────────────────────────
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const testAccount = mnemonicToAccount(TEST_MNEMONIC);
const TEST_ADDR = testAccount.address;

// ── Helper: create a test express app with the middleware ───────────────────
function createTestApp(sigAuth) {
  const app = express();
  app.use(express.json());
  app.post(
    "/v2/test-action",
    sigAuth.requireSignature({ role: "player" }),
    (req, res) => {
      res.json({ ok: true, body: req.body });
    }
  );
  return app;
}

// ── Helper: fire a request and get the response ────────────────────────────
function fireRequest(app, body, headers) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v2/test-action",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : {},
            });
          });
        }
      );
      req.on("error", () => {
        server.close();
        resolve({ status: 0, body: {} });
      });
      req.write(payload);
      req.end();
    });
  });
}

// ── Helper: build valid signed headers for a body ──────────────────────────
async function makeSignedHeaders(sigAuth, body, path = "/v2/test-action") {
  const nonce = Math.random().toString(36).slice(2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bHash = sigAuth.computeBodyHash(body);
  const message = sigAuth.buildMessage(path, bHash, nonce, timestamp);
  const signature = await testAccount.signMessage({ message });
  return {
    "x-chancy-signer": TEST_ADDR,
    "x-chancy-signature": signature,
    "x-chancy-nonce": nonce,
    "x-chancy-timestamp": timestamp,
    "x-chancy-body-hash": bHash,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ════════════════════════════════════════════════════════════════════════════

const SAVED_DISABLE = process.env.CHANCY_DISABLE_SIG_AUTH;

describe("sig-auth middleware", () => {
  let sigAuth;
  let app;

  beforeEach(() => {
    delete process.env.CHANCY_DISABLE_SIG_AUTH;
    sigAuth = freshModule();
    app = createTestApp(sigAuth);
  });

  afterEach(() => {
    if (SAVED_DISABLE !== undefined) {
      process.env.CHANCY_DISABLE_SIG_AUTH = SAVED_DISABLE;
    }
  });

  // ── 1. Valid body-bound signature passes ──────────────────────────────────
  it("accepts a valid body-bound signature", async () => {
    const body = { player: TEST_ADDR, amount: "1000", destination: TEST_ADDR };
    const headers = await makeSignedHeaders(sigAuth, body);
    const res = await fireRequest(app, body, headers);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── 2. Tampered body is rejected ──────────────────────────────────────────
  it("rejects tampered body (signature for body A, body B sent)", async () => {
    const bodyA = { player: TEST_ADDR, amount: "100", destination: TEST_ADDR };
    const bodyB = { player: TEST_ADDR, amount: "999999", destination: TEST_ADDR };

    const headers = await makeSignedHeaders(sigAuth, bodyA);
    const res = await fireRequest(app, bodyB, headers);
    expect(res.status).toBe(401);
    expect(["INVALID_SIGNATURE", "BODY_HASH_MISMATCH"]).toContain(res.body.error);
  });

  // ── 3. Legacy format (no body hash) is rejected ───────────────────────────
  it("rejects legacy signature format (no body hash in message)", async () => {
    const body = { player: TEST_ADDR, amount: "1000" };
    const nonce = Math.random().toString(36).slice(2);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const legacyMessage = `chancy:/v2/test-action:${nonce}:${timestamp}`;
    const signature = await testAccount.signMessage({ message: legacyMessage });

    const headers = {
      "x-chancy-signer": TEST_ADDR,
      "x-chancy-signature": signature,
      "x-chancy-nonce": nonce,
      "x-chancy-timestamp": timestamp,
    };

    const res = await fireRequest(app, body, headers);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_SIGNATURE");
  });

  // ── 4. Nonce replay is rejected ───────────────────────────────────────────
  it("rejects nonce replay (same nonce used twice)", async () => {
    const body = { player: TEST_ADDR, amount: "1000" };
    const headers = await makeSignedHeaders(sigAuth, body);

    const res1 = await fireRequest(app, body, headers);
    expect(res1.status).toBe(200);

    const res2 = await fireRequest(app, body, headers);
    expect(res2.status).toBe(401);
    expect(res2.body.error).toBe("NONCE_REPLAY");
  });

  // ── 5. Missing headers → 401 ──────────────────────────────────────────────
  it("rejects request with no signature headers", async () => {
    const body = { player: TEST_ADDR, amount: "1000" };
    const res = await fireRequest(app, body, {});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("SIGNATURE_REQUIRED");
  });

  // ── 6. Signer mismatch → 403 ──────────────────────────────────────────────
  it("rejects signer/body mismatch", async () => {
    const body = { player: "0x2222222222222222222222222222222222222222", amount: "1000" };
    const headers = await makeSignedHeaders(sigAuth, {
      player: TEST_ADDR,
      amount: "1000",
    });
    const res = await fireRequest(app, body, headers);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SIGNER_MISMATCH");
  });

  // ── 7. Stale timestamp → 401 ──────────────────────────────────────────────
  it("rejects stale timestamp", async () => {
    const body = { player: TEST_ADDR, amount: "1000" };
    const nonce = Math.random().toString(36).slice(2);
    const staleTs = String(Math.floor(Date.now() / 1000) - 300);
    const bHash = sigAuth.computeBodyHash(body);
    const message = sigAuth.buildMessage("/v2/test-action", bHash, nonce, staleTs);
    const signature = await testAccount.signMessage({ message });

    const res = await fireRequest(app, body, {
      "x-chancy-signer": TEST_ADDR,
      "x-chancy-signature": signature,
      "x-chancy-nonce": nonce,
      "x-chancy-timestamp": staleTs,
      "x-chancy-body-hash": bHash,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("STALE_TIMESTAMP");
  });

  // ── 8. Concurrent nonce race — only one passes ────────────────────────────
  it("prevents nonce replay via concurrent requests", async () => {
    const body = { player: TEST_ADDR, amount: "1000" };
    const nonce = Math.random().toString(36).slice(2);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bHash = sigAuth.computeBodyHash(body);
    const message = sigAuth.buildMessage("/v2/test-action", bHash, nonce, timestamp);
    const signature = await testAccount.signMessage({ message });

    const headers = {
      "x-chancy-signer": TEST_ADDR,
      "x-chancy-signature": signature,
      "x-chancy-nonce": nonce,
      "x-chancy-timestamp": timestamp,
      "x-chancy-body-hash": bHash,
    };

    const [res1, res2] = await Promise.all([
      fireRequest(app, body, headers),
      fireRequest(app, body, headers),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(200);
    expect(statuses).toContain(401);
    expect([res1.body.error, res2.body.error]).toContain("NONCE_REPLAY");
  });
});

// ── Unit tests for hashing utilities ────────────────────────────────────────
describe("canonicalStringify + computeBodyHash", () => {
  let sigAuth;
  beforeEach(() => {
    delete process.env.CHANCY_DISABLE_SIG_AUTH;
    sigAuth = freshModule();
  });

  it("produces identical hash regardless of key order", () => {
    const h1 = sigAuth.computeBodyHash({ b: 1, a: 2 });
    const h2 = sigAuth.computeBodyHash({ a: 2, b: 1 });
    expect(h1).toBe(h2);
  });

  it("produces different hash for different values", () => {
    const h1 = sigAuth.computeBodyHash({ amount: "100" });
    const h2 = sigAuth.computeBodyHash({ amount: "200" });
    expect(h1).not.toBe(h2);
  });

  it("handles nested objects deterministically", () => {
    const h1 = sigAuth.computeBodyHash({ a: { z: 1, y: 2 }, b: [3, 2, 1] });
    const h2 = sigAuth.computeBodyHash({ a: { y: 2, z: 1 }, b: [3, 2, 1] });
    expect(h1).toBe(h2);
  });

  it("handles empty objects", () => {
    const h = sigAuth.computeBodyHash({});
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
