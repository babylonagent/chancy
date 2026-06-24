const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { persistSqliteStore } = require("./sqlite-store");

// Economics verified 2026-06-24: all modes 5-6.25% house edge.
// Easy 37.5% win / 2.5x (edge 6.25%), Normal 17.9% win / 5.3x (edge 5.4%),
// Hardcore 10.9% win / 8.7x (edge 5.1%). Multipliers ascend with difficulty.
const modeConfig = {
  Easy: { bombs: 3, prizes: 5 },
  Normal: { bombs: 5, prizes: 3 },
  Hardcore: { bombs: 9, prizes: 2 },
};

// ───────────────────────────────────────────────────────────────────────────
// PAYOUT ECONOMICS — TUNABLE BUSINESS VALUES (sign-off required before mainnet)
// Win = collect ALL prize tiles before 3 bombs. Payout = stake * multiplier.
// Partial prizes pay nothing. Hitting 3 bombs forfeits the stake.
// winMultiplierBps: 10000 = 1.0x. Harder mode → bigger multiplier.
// ───────────────────────────────────────────────────────────────────────────
const winMultiplierBps = {
  Easy: 25000n, // 2.5x
  Normal: 53000n, // 5.3x
  Hardcore: 87000n, // 8.7x
};

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintString = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const WITHDRAWAL_FEE_BPS = 500n;
const BPS_DENOMINATOR = 10_000n;

function sha256Hex(value) {
  return "0x" + crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeTile(tile) {
  const n = Number(tile);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error("INVALID_TILE");
  return n;
}

function deriveBoard({ entropy, sessionId, player, mode }) {
  const cfg = modeConfig[mode];
  if (!cfg) throw new Error("INVALID_MODE");
  const taken = new Set();
  let nonce = 0;
  while (taken.size < cfg.bombs + cfg.prizes) {
    const hash = crypto.createHash("sha256").update(`${entropy}:${sessionId}:${player.toLowerCase()}:${mode}:${nonce}`).digest();
    const tile = (hash.readUInt32BE(0) % 64) + 1;
    taken.add(tile);
    nonce += 1;
  }
  const ordered = [...taken];
  const bombPositions = ordered.slice(0, cfg.bombs).sort((a, b) => a - b);
  const prizePositions = ordered.slice(cfg.bombs).sort((a, b) => a - b);
  return { bombPositions, prizePositions };
}

function boardCommitHash({ entropy, sessionId, player, mode, board }) {
  return sha256Hex(JSON.stringify({ entropy, sessionId, player: player.toLowerCase(), mode, board }));
}

// ───────────────────────────────────────────────────────────────────────────
// C39 COMMIT-REVEAL FAIRNESS
// The client generates entropy + salt locally and sends only the commitment
// hash at session creation. The server cannot see the plaintext entropy until
// the reveal phase — by which point the stake is already debited and the
// sessionId assigned. This prevents the server from grinding boards by
// selectively aborting sessions whose pre-computed board favors the player.
// ───────────────────────────────────────────────────────────────────────────
const REVEAL_TIMEOUT_MS = 120_000; // 2 min to reveal before auto-refund

function computeCommitment(entropy, salt) {
  return sha256Hex(`${entropy}:${salt}`);
}

// Refund any committed sessions that never got revealed past their timeout.
// Called on each new commit so stale commits don't leak credits.
function cleanupExpiredCommits(store, persist) {
  const now = Date.now();
  let changed = false;
  for (const session of store.sessions.values()) {
    if (session.status === "committed" && session.commitExpiresAt && now > session.commitExpiresAt) {
      // Refund the stake — the game never started.
      setBalance(store, session.player, getBalance(store, session.player) + BigInt(session.stake));
      session.status = "expired";
      session.payout = "0";
      changed = true;
    }
  }
  if (changed) persist();
}

function createV2Store() {
  return {
    balances: new Map(),
    sessions: new Map(),
    withdrawals: new Map(),
    deposits: new Map(), // txHash(lowercased) -> { player, creditedAmount, grossAmount, feeAmount, at }
    nextSessionId: 1,
    nextWithdrawalId: 1,
  };
}

function serializeStore(store) {
  return {
    nextSessionId: store.nextSessionId,
    nextWithdrawalId: store.nextWithdrawalId,
    balances: Object.fromEntries([...store.balances.entries()].map(([key, value]) => [key, value.toString()])),
    sessions: Object.fromEntries([...store.sessions.entries()].map(([id, session]) => [id, {
      ...session,
      clicked: [...session.clicked.entries()],
    }])),
    withdrawals: Object.fromEntries(store.withdrawals.entries()),
    deposits: Object.fromEntries((store.deposits || new Map()).entries()),
  };
}

function hydrateStore(raw) {
  const store = createV2Store();
  store.nextSessionId = Number(raw?.nextSessionId || 1);
  store.nextWithdrawalId = Number(raw?.nextWithdrawalId || 1);
  for (const [key, value] of Object.entries(raw?.balances || {})) store.balances.set(key, BigInt(value));
  for (const [id, session] of Object.entries(raw?.sessions || {})) {
    store.sessions.set(id, { ...session, clicked: new Map(session.clicked || []) });
  }
  for (const [id, withdrawal] of Object.entries(raw?.withdrawals || {})) store.withdrawals.set(id, withdrawal);
  for (const [txHash, record] of Object.entries(raw?.deposits || {})) store.deposits.set(txHash, record);
  return store;
}

function loadV2Store(storePath) {
  if (!storePath || !fs.existsSync(storePath)) return createV2Store();
  return hydrateStore(JSON.parse(fs.readFileSync(storePath, "utf8")));
}

function persistStore(store, storePath) {
  if (!storePath) return;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializeStore(store), null, 2));
  fs.renameSync(tmp, storePath);
}

function getBalance(store, player) {
  return BigInt(store.balances.get(player.toLowerCase()) || 0n);
}

function setBalance(store, player, amount) {
  store.balances.set(player.toLowerCase(), BigInt(amount));
}

function pendingWithdrawals(store, player) {
  return [...store.withdrawals.values()]
    .filter((withdrawal) => withdrawal.player.toLowerCase() === player.toLowerCase() && withdrawal.status === "pending")
    .reduce((sum, withdrawal) => sum + BigInt(withdrawal.amount), 0n);
}

function withdrawableBalance(store, player) {
  const balance = getBalance(store, player);
  const pending = pendingWithdrawals(store, player);
  return balance > pending ? balance - pending : 0n;
}

// Default deposit verifier: rejects everything. The real viem-backed verifier is
// injected by server.js. This guarantees we NEVER credit an unverified deposit,
// even if wiring is forgotten — fail closed, not open.
async function defaultVerifyDeposit() {
  throw new Error("DEPOSIT_VERIFIER_NOT_CONFIGURED");
}

// Default entropy requester: rejects everything. The real on-chain Pyth-backed
// requester is injected by server.js. Fail closed if not configured.
async function defaultRequestEntropy() {
  throw new Error("ENTROPY_REQUESTER_NOT_CONFIGURED");
}

function installV2Routes(app, {
  store = createV2Store(),
  storePath = "",
  db = null,
  verifyDeposit = defaultVerifyDeposit,
  requestEntropy = defaultRequestEntropy,
  adminToken = "",
} = {}) {
  // Unified persistence: SQLite when db is provided, JSON file otherwise.
  const persist = db
    ? () => persistSqliteStore(db, store)
    : () => persistStore(store, storePath);
  // Deposit: client sends ONLY txHash + player. The server reads the on-chain
  // receipt, decodes the vault Deposited event, and credits the REAL net amount.
  // Idempotent by txHash so a retried POST never double-credits.
  app.post("/v2/credits/deposit", async (req, res) => {
    const parsed = z.object({ player: addressSchema, txHash: bytes32Schema }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const { player, txHash } = parsed.data;
    const txKey = txHash.toLowerCase();

    // Idempotency: already processed → return current balance, no re-credit.
    const existing = store.deposits.get(txKey);
    if (existing) {
      return res.json({
        player,
        balance: getBalance(store, player).toString(),
        asset: "USD_CREDIT",
        credited: existing.creditedAmount,
        txHash: txKey,
        idempotent: true,
      });
    }

    let verified;
    try {
      verified = await verifyDeposit({ txHash, player });
    } catch (error) {
      const code = error.message || "DEPOSIT_VERIFICATION_FAILED";
      const status = code === "DEPOSIT_NOT_FOUND" ? 404 : code === "DEPOSIT_PLAYER_MISMATCH" ? 403 : 422;
      return res.status(status).json({ error: code });
    }

    // verified = { player, grossAmount, creditedAmount, feeAmount }
    if (verified.player.toLowerCase() !== player.toLowerCase()) {
      return res.status(403).json({ error: "DEPOSIT_PLAYER_MISMATCH" });
    }
    const credited = BigInt(verified.creditedAmount);
    const next = getBalance(store, player) + credited;
    setBalance(store, player, next);
    store.deposits.set(txKey, {
      player: player.toLowerCase(),
      grossAmount: String(verified.grossAmount),
      creditedAmount: credited.toString(),
      feeAmount: String(verified.feeAmount),
      at: new Date().toISOString(),
    });
    persist();
    return res.json({
      player,
      balance: next.toString(),
      asset: "USD_CREDIT",
      credited: credited.toString(),
      txHash: txKey,
      idempotent: false,
    });
  });

  app.get("/v2/credits/:player", (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    const balance = getBalance(store, parsed.data.player).toString();
    const withdrawable = withdrawableBalance(store, parsed.data.player).toString();
    return res.json({ player: parsed.data.player, balance, withdrawable });
  });

  app.post("/v2/withdrawals/request", (req, res) => {
    const parsed = z.object({ player: addressSchema, amount: uintString, destination: addressSchema }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const { player, amount, destination } = parsed.data;
    const requested = BigInt(amount);
    if (requested <= 0n) return res.status(400).json({ error: "INVALID_AMOUNT" });
    if (withdrawableBalance(store, player) < requested) return res.status(402).json({ error: "INSUFFICIENT_WITHDRAWABLE_CREDITS" });
    const withdrawalId = `wd_${store.nextWithdrawalId++}`;
    const feeAmount = requested * WITHDRAWAL_FEE_BPS / BPS_DENOMINATOR;
    const payoutAmount = requested - feeAmount;
    const withdrawal = {
      withdrawalId,
      player,
      amount: requested.toString(),
      payoutAmount: payoutAmount.toString(),
      feeAmount: feeAmount.toString(),
      destination,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    store.withdrawals.set(withdrawalId, withdrawal);
    persist();
    return res.json(withdrawal);
  });

  app.get("/v2/withdrawals/:player", (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    const withdrawals = [...store.withdrawals.values()].filter((withdrawal) => withdrawal.player.toLowerCase() === parsed.data.player.toLowerCase());
    return res.json({ player: parsed.data.player, withdrawals });
  });

  // Admin: list ALL withdrawals (optionally filtered by status). Used by the
  // auto-payout relayer to discover pending payouts. Bearer-protected: only
  // enabled when ADMIN_TOKEN is configured, fail closed if it isn't.
  app.get("/v2/admin/withdrawals", (req, res) => {
    if (!adminToken) return res.status(503).json({ error: "ADMIN_DISABLED" });
    const auth = req.headers?.authorization || "";
    if (auth !== `Bearer ${adminToken}`) return res.status(401).json({ error: "UNAUTHORIZED" });
    const statusParse = z.object({ status: z.enum(["pending", "paid"]).optional() }).safeParse(req.query || {});
    if (!statusParse.success) return res.status(400).json({ error: "INVALID_QUERY" });
    const wanted = statusParse.data.status;
    const withdrawals = [...store.withdrawals.values()].filter((w) => !wanted || w.status === wanted);
    return res.json({ count: withdrawals.length, withdrawals });
  });

  app.post("/v2/withdrawals/:withdrawalId/mark-paid", (req, res) => {
    const paramParse = z.object({ withdrawalId: z.string().regex(/^wd_\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ txHash: bytes32Schema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const withdrawal = store.withdrawals.get(paramParse.data.withdrawalId);
    if (!withdrawal) return res.status(404).json({ error: "WITHDRAWAL_NOT_FOUND" });
    if (withdrawal.status !== "pending") return res.status(409).json({ error: "WITHDRAWAL_NOT_PENDING", status: withdrawal.status });
    const balance = getBalance(store, withdrawal.player);
    const amount = BigInt(withdrawal.amount);
    if (balance < amount) return res.status(409).json({ error: "LEDGER_UNDERFUNDED" });
    setBalance(store, withdrawal.player, balance - amount);
    withdrawal.status = "paid";
    withdrawal.txHash = bodyParse.data.txHash;
    withdrawal.paidAt = new Date().toISOString();
    persist();
    return res.json(withdrawal);
  });

  // C39 Phase 1 — COMMIT: client sends only the commitment hash.
  // Server debits stake, assigns sessionId, but does NOT derive the board yet.
  app.post("/v2/sessions", (req, res) => {
    const parsed = z.object({
      player: addressSchema,
      host: addressSchema,
      mode: z.enum(["Easy", "Normal", "Hardcore"]),
      stake: uintString,
      commitment: bytes32Schema, // sha256(entropy:salt) — server can't see entropy
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const body = parsed.data;
    cleanupExpiredCommits(store, persist);
    const balance = getBalance(store, body.player);
    const stake = BigInt(body.stake);
    if (stake <= 0n) return res.status(400).json({ error: "INVALID_STAKE" });
    if (balance < stake) return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });

    const sessionId = String(store.nextSessionId++);
    const commitExpiresAt = Date.now() + REVEAL_TIMEOUT_MS;
    setBalance(store, body.player, balance - stake);
    const session = {
      sessionId,
      player: body.player,
      host: body.host,
      mode: body.mode,
      stake: stake.toString(),
      commitment: body.commitment,
      commitExpiresAt,
      board: null, // not derived until reveal
      boardCommitHash: null,
      entropy: null, // stored at reveal
      salt: null,
      clicked: new Map(),
      bombsHit: 0,
      prizesCollected: 0,
      status: "committed", // → "active" after reveal
      payout: "0",
    };
    store.sessions.set(sessionId, session);
    persist();
    return res.json({ sessionId, player: body.player, host: body.host, mode: body.mode, stake: stake.toString(), commitment: body.commitment, status: "committed", commitExpiresAt });
  });

  // C39 Phase 2 — REVEAL: client sends plaintext entropy + salt.
  // Server verifies commitment, requests on-chain Pyth randomness, then derives
  // the board. The board seed = Pyth randomNumber (oracle + client contribution
  // mixed by Pyth). Neither server nor player alone controls it. The Pyth result
  // is on-chain and independently verifiable by anyone.
  app.post("/v2/sessions/:sessionId/reveal", async (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema, entropy: bytes32Schema, salt: bytes32Schema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.player.toLowerCase()) return res.status(403).json({ error: "NOT_SESSION_PLAYER" });
    if (session.status !== "committed") return res.status(409).json({ error: "SESSION_NOT_COMMITTED", status: session.status });
    // Verify the reveal matches the stored commitment.
    const expected = computeCommitment(bodyParse.data.entropy, bodyParse.data.salt);
    if (expected !== session.commitment) return res.status(400).json({ error: "COMMITMENT_MISMATCH" });

    // Request on-chain randomness from Pyth Entropy. The player's entropy is
    // passed as userRandomNumber — Pyth mixes it with oracle randomness. The
    // server cannot predict or bias the result.
    let entropyResult;
    try {
      entropyResult = await requestEntropy(bodyParse.data.entropy);
    } catch (error) {
      // Entropy request failed — refund the stake, mark as failed.
      setBalance(store, session.player, getBalance(store, session.player) + BigInt(session.stake));
      session.status = "failed";
      session.entropy = bodyParse.data.entropy;
      session.salt = bodyParse.data.salt;
      session.entropyError = error.message || "ENTROPY_REQUEST_FAILED";
      persist();
      return res.status(503).json({
        error: "ENTROPY_REQUEST_FAILED",
        message: session.entropyError,
        sessionId: session.sessionId,
        refunded: true,
      });
    }

    // Derive the board using the Pyth random number — the trustless seed that
    // already incorporates both the client's and oracle's contributions.
    const pythRandom = entropyResult.randomNumber;
    const board = deriveBoard({ entropy: pythRandom, sessionId: session.sessionId, player: session.player, mode: session.mode });
    const commit = boardCommitHash({ entropy: pythRandom, sessionId: session.sessionId, player: session.player, mode: session.mode, board });

    session.entropy = bodyParse.data.entropy;
    session.salt = bodyParse.data.salt;
    session.pythRandomNumber = pythRandom;
    session.entropySequenceNumber = String(entropyResult.sequenceNumber);
    session.entropyTxHash = entropyResult.txHash;
    session.board = board;
    session.boardCommitHash = commit;
    session.status = "active";
    persist();

    // Client can independently verify:
    //   1. Read getRequest(seq) from ChancyRandomness contract on-chain
    //   2. Get pythRandomNumber
    //   3. Run deriveBoard({ entropy: pythRandomNumber, sessionId, player, mode })
    //   4. Compare boardCommitHash
    return res.json({
      sessionId: session.sessionId,
      boardCommitHash: commit,
      status: "active",
      entropySequenceNumber: String(entropyResult.sequenceNumber),
      entropyTxHash: entropyResult.txHash,
    });
  });

  app.post("/v2/sessions/:sessionId/click", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema, tile: z.number().int() }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.player.toLowerCase()) return res.status(403).json({ error: "NOT_SESSION_PLAYER" });
    let tile;
    try { tile = normalizeTile(bodyParse.data.tile); } catch { return res.status(400).json({ error: "INVALID_TILE" }); }
    if (session.clicked.has(tile)) return res.json(session.clicked.get(tile));
    if (session.status !== "active") return res.status(409).json({ error: "SESSION_NOT_ACTIVE", status: session.status });

    let outcome = "empty";
    let payoutCredited = "0";
    if (session.board.bombPositions.includes(tile)) {
      outcome = "bomb";
      session.bombsHit += 1;
      if (session.bombsHit >= 3) session.status = "lost";
    } else if (session.board.prizePositions.includes(tile)) {
      outcome = "prize";
      session.prizesCollected += 1;
      if (session.prizesCollected >= modeConfig[session.mode].prizes) {
        session.status = "won";
        // Pay the pot: stake * winMultiplier. Credited to the player ledger.
        const stake = BigInt(session.stake);
        const payout = stake * (winMultiplierBps[session.mode] || 10000n) / BPS_DENOMINATOR;
        session.payout = payout.toString();
        payoutCredited = payout.toString();
        setBalance(store, session.player, getBalance(store, session.player) + payout);
      }
    }
    const result = {
      sessionId: session.sessionId,
      tile,
      outcome,
      bombsHit: session.bombsHit,
      prizesCollected: session.prizesCollected,
      status: session.status,
      payout: payoutCredited,
    };
    session.clicked.set(tile, result);
    persist();
    return res.json(result);
  });

  app.post("/v2/sessions/:sessionId/exit", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.player.toLowerCase()) return res.status(403).json({ error: "NOT_SESSION_PLAYER" });
    // C39: if the session was committed but never revealed, refund the stake.
    if (session.status === "committed") {
      setBalance(store, session.player, getBalance(store, session.player) + BigInt(session.stake));
      session.status = "cancelled";
      persist();
      return res.json({ sessionId: session.sessionId, status: "cancelled", payout: "0", refunded: session.stake, board: null, boardCommitHash: null, clicked: [] });
    }
    if (session.status === "active") session.status = "exited";
    persist();
    return res.json({
      sessionId: session.sessionId,
      status: session.status,
      payout: session.payout || "0",
      boardCommitHash: session.boardCommitHash,
      entropy: session.entropy,
      pythRandomNumber: session.pythRandomNumber || null,
      entropySequenceNumber: session.entropySequenceNumber || null,
      entropyTxHash: session.entropyTxHash || null,
      board: session.board,
      clicked: [...session.clicked.values()],
    });
  });

  return store;
}

module.exports = { installV2Routes, createV2Store, loadV2Store, deriveBoard, boardCommitHash, computeCommitment, modeConfig, winMultiplierBps };
