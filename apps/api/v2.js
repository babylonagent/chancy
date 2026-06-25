const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { persistSqliteStore } = require("./sqlite-store");
const { MAX_CONCURRENT_SESSIONS } = require("./security");

// ───────────────────────────────────────────────────────────────────────────
// P2P HOST/PLAYER ECONOMICS — V1 design restored
// Host creates session, funds prize pot. Player pays per-tile reveal.
// Host earns player's spent on loss/quit/idle. Player earns prize pot shares.
// ───────────────────────────────────────────────────────────────────────────
const BOARD_SIZE = 64;
const BOMBS_TO_GAME_OVER = 3;

const modeConfig = {
  Easy:     { bombs: 5,  prizes: 3, startBps: 150,  capBps: 15000 },
  Normal:   { bombs: 7,  prizes: 2, startBps: 250,  capBps: 20000 },
  Hardcore: { bombs: 10, prizes: 1, startBps: 350,  capBps: 25000 },
};

// Business constants (6-decimal USDC)
const MIN_PRIZE_POT = 5_000_000n;     // $5
const MAX_PRIZE_POT = 1_000_000_000n; // $1,000
const ENTRANCE_FEE = 50_000n;         // $0.05 — paid by player to host at join
const IDLE_TIMEOUT_MS = 60_000;       // 60s auto-kick
const REVEAL_TIMEOUT_MS = 120_000;    // 2 min to reveal before auto-reopen
const BPS_DENOMINATOR = 10_000n;
const WITHDRAWAL_FEE_BPS = 500n;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintString = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);

function sha256Hex(value) {
  return "0x" + crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeTile(tile) {
  const n = Number(tile);
  if (!Number.isInteger(n) || n < 1 || n > BOARD_SIZE) throw new Error("INVALID_TILE");
  return n;
}

// Progressive per-tile reveal cost (from V1 contract formula).
// Cost increases monotonically with revealIndex. Sum of all 64 costs ≤ cap.
function revealCostAt(prizePot, mode, revealIndex) {
  const cfg = modeConfig[mode];
  if (!cfg) throw new Error("INVALID_MODE");
  const baseTotalBps = cfg.startBps * BOARD_SIZE;
  const stepBps = cfg.capBps > baseTotalBps
    ? Math.floor((cfg.capBps - baseTotalBps) * 2 / (BOARD_SIZE * (BOARD_SIZE - 1)))
    : 0;
  const costBps = cfg.startBps + stepBps * revealIndex;
  return BigInt(prizePot) * BigInt(costBps) / BPS_DENOMINATOR;
}

// Pro-rata prize value per prize tile found.
function prizePerTile(prizePot, mode) {
  const cfg = modeConfig[mode];
  return BigInt(prizePot) / BigInt(cfg.prizes);
}

function deriveBoard({ entropy, sessionId, player, mode }) {
  const cfg = modeConfig[mode];
  if (!cfg) throw new Error("INVALID_MODE");
  const taken = new Set();
  let nonce = 0;
  while (taken.size < cfg.bombs + cfg.prizes) {
    const hash = crypto.createHash("sha256").update(`${entropy}:${sessionId}:${player.toLowerCase()}:${mode}:${nonce}`).digest();
    const tile = (hash.readUInt32BE(0) % BOARD_SIZE) + 1;
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
// COMMIT-REVEAL FAIRNESS
// Player commits hash(entropy:salt) at join. Server can't see entropy until
// reveal — by then entrance fee is paid and session is occupied. Prevents
// server from grinding boards by selectively aborting.
// ───────────────────────────────────────────────────────────────────────────

function computeCommitment(entropy, salt) {
  return sha256Hex(`${entropy}:${salt}`);
}

// Record cumulative stats when a run ends (host earns spent).
function recordRunEnd(session, hostEarnings) {
  session.cumulativeEarnings = (BigInt(session.cumulativeEarnings || "0") + BigInt(hostEarnings || "0")).toString();
  session.cumulativeRuns = (session.cumulativeRuns || 0) + 1;
  session.lastPlayedAt = new Date().toISOString();
}

// Track unique players per session (by address).
function trackPlayer(session) {
  if (!session._playersSeen) session._playersSeen = new Set();
  session._playersSeen.add(session.activePlayer?.toLowerCase());
  session.cumulativePlayers = session._playersSeen.size;
}

// Reset a session's run state so it can accept a new player.
function resetRun(session) {
  session.activePlayer = null;
  session.commitment = null;
  session.commitExpiresAt = null;
  session.board = null;
  session.boardCommitHash = null;
  session.entropy = null;
  session.salt = null;
  session.pythRandomNumber = null;
  session.entropySequenceNumber = null;
  session.entropyTxHash = null;
  session.entropyError = null;
  session.clicked = new Map();
  session.bombsHit = 0;
  session.prizesFound = 0;
  session.spentAmount = "0";
  session.prizeEarned = "0";
  session.runStatus = null;
  session.lastActionAt = null;
  session.status = "open";
}

// Auto-reopen sessions where player joined but never revealed (timeout).
// Also auto-kick idle players (>60s no action).
function cleanupStaleSessions(store, persist) {
  const now = Date.now();
  let changed = false;
  for (const session of store.sessions.values()) {
    if (session.status !== "occupied") continue;
    // Player committed but never revealed → refund entrance, reopen
    if (session.runStatus === "committed" && session.commitExpiresAt && now > session.commitExpiresAt) {
      setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + ENTRANCE_FEE);
      session.runStatus = "expired";
      resetRun(session);
      changed = true;
      continue;
    }
    // Player is idle → host gets spent, reopen
    if (session.runStatus === "active" && session.lastActionAt && now > session.lastActionAt + IDLE_TIMEOUT_MS) {
      const spent = BigInt(session.spentAmount || "0");
      if (spent > 0n) {
        setBalance(store, session.host, getBalance(store, session.host) + spent);
      }
      recordRunEnd(session, spent);
      session.runStatus = "idle_kicked";
      resetRun(session);
      changed = true;
    }
  }
  if (changed) persist();
}

// ───────────────────────────────────────────────────────────────────────────
// STORE — same shape, sessions now host-owned
// ───────────────────────────────────────────────────────────────────────────

function createV2Store() {
  return {
    balances: new Map(),
    sessions: new Map(),
    withdrawals: new Map(),
    deposits: new Map(),
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
      _playersSeen: session._playersSeen ? [...session._playersSeen] : [],
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
    store.sessions.set(id, {
      ...session,
      clicked: new Map(session.clicked || []),
      _playersSeen: new Set(session._playersSeen || []),
    });
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
    .filter((w) => w.player.toLowerCase() === player.toLowerCase() && w.status === "pending")
    .reduce((sum, w) => sum + BigInt(w.amount), 0n);
}

function withdrawableBalance(store, player) {
  const balance = getBalance(store, player);
  const pending = pendingWithdrawals(store, player);
  return balance > pending ? balance - pending : 0n;
}

async function defaultVerifyDeposit() { throw new Error("DEPOSIT_VERIFIER_NOT_CONFIGURED"); }
async function defaultRequestEntropy() { throw new Error("ENTROPY_REQUESTER_NOT_CONFIGURED"); }

// ───────────────────────────────────────────────────────────────────────────
// ROUTES — deposit/withdraw/credits unchanged, game handlers rewritten
// ───────────────────────────────────────────────────────────────────────────

function installV2Routes(app, {
  store = createV2Store(),
  storePath = "",
  db = null,
  verifyDeposit = defaultVerifyDeposit,
  requestEntropy = defaultRequestEntropy,
  adminToken = "",
} = {}) {
  const persist = db ? () => persistSqliteStore(db, store) : () => persistStore(store, storePath);

  // ── DEPOSIT (unchanged) ───────────────────────────────────────────────────
  app.post("/v2/credits/deposit", async (req, res) => {
    const parsed = z.object({ player: addressSchema, txHash: bytes32Schema }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const { player, txHash } = parsed.data;
    const txKey = txHash.toLowerCase();
    const existing = store.deposits.get(txKey);
    if (existing) return res.json({ player, balance: getBalance(store, player).toString(), asset: "USD_CREDIT", credited: existing.creditedAmount, txHash: txKey, idempotent: true });
    let verified;
    try { verified = await verifyDeposit({ txHash, player }); }
    catch (error) {
      const code = error.message || "DEPOSIT_VERIFICATION_FAILED";
      const status = code === "DEPOSIT_NOT_FOUND" ? 404 : code === "DEPOSIT_PLAYER_MISMATCH" ? 403 : 422;
      return res.status(status).json({ error: code });
    }
    if (verified.player.toLowerCase() !== player.toLowerCase()) return res.status(403).json({ error: "DEPOSIT_PLAYER_MISMATCH" });
    const credited = BigInt(verified.creditedAmount);
    const next = getBalance(store, player) + credited;
    setBalance(store, player, next);
    store.deposits.set(txKey, { player: player.toLowerCase(), grossAmount: String(verified.grossAmount), creditedAmount: credited.toString(), feeAmount: String(verified.feeAmount), at: new Date().toISOString() });
    persist();
    return res.json({ player, balance: next.toString(), asset: "USD_CREDIT", credited: credited.toString(), txHash: txKey, idempotent: false });
  });

  // ── CREDITS (unchanged) ───────────────────────────────────────────────────
  app.get("/v2/credits/:player", (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    return res.json({ player: parsed.data.player, balance: getBalance(store, parsed.data.player).toString(), withdrawable: withdrawableBalance(store, parsed.data.player).toString() });
  });

  // ── WITHDRAWALS (unchanged) ───────────────────────────────────────────────
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
    const withdrawal = { withdrawalId, player, amount: requested.toString(), payoutAmount: payoutAmount.toString(), feeAmount: feeAmount.toString(), destination, status: "pending", createdAt: new Date().toISOString() };
    store.withdrawals.set(withdrawalId, withdrawal);
    persist();
    return res.json(withdrawal);
  });

  app.get("/v2/withdrawals/:player", (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    const withdrawals = [...store.withdrawals.values()].filter((w) => w.player.toLowerCase() === parsed.data.player.toLowerCase());
    return res.json({ player: parsed.data.player, withdrawals });
  });

  app.get("/v2/admin/withdrawals", (req, res) => {
    if (!adminToken) return res.status(503).json({ error: "ADMIN_DISABLED" });
    if ((req.headers?.authorization || "") !== `Bearer ${adminToken}`) return res.status(401).json({ error: "UNAUTHORIZED" });
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

  // ══════════════════════════════════════════════════════════════════════════
  // P2P GAME — HOST CREATES SESSION, PLAYER JOINS AND PAYS PER-TILE
  // ══════════════════════════════════════════════════════════════════════════

  // HOST: Create a session — lock prize pot credits, pick difficulty.
  app.post("/v2/sessions/create", (req, res) => {
    const parsed = z.object({
      host: addressSchema,
      mode: z.enum(["Easy", "Normal", "Hardcore"]),
      prizePot: uintString,
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const { host, mode, prizePot } = parsed.data;
    const pot = BigInt(prizePot);

    if (pot < MIN_PRIZE_POT) return res.status(400).json({ error: "PRIZE_POT_TOO_LOW", min: MIN_PRIZE_POT.toString() });
    if (pot > MAX_PRIZE_POT) return res.status(400).json({ error: "PRIZE_POT_TOO_HIGH", max: MAX_PRIZE_POT.toString() });
    if (getBalance(store, host) < pot) return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });

    // Limit host to N open sessions
    const hostOpenCount = [...store.sessions.values()].filter(
      (s) => s.host.toLowerCase() === host.toLowerCase() && s.status === "open"
    ).length;
    if (hostOpenCount >= MAX_CONCURRENT_SESSIONS) {
      return res.status(429).json({ error: "TOO_MANY_OPEN_SESSIONS", max: MAX_CONCURRENT_SESSIONS });
    }

    cleanupStaleSessions(store, persist);

    const sessionId = String(store.nextSessionId++);
    setBalance(store, host, getBalance(store, host) - pot);

    const session = {
      sessionId,
      host,
      mode,
      prizePot: pot.toString(),
      entranceFee: ENTRANCE_FEE.toString(),
      status: "open",
      activePlayer: null,
      commitment: null,
      commitExpiresAt: null,
      board: null,
      boardCommitHash: null,
      entropy: null,
      salt: null,
      pythRandomNumber: null,
      entropySequenceNumber: null,
      entropyTxHash: null,
      entropyError: null,
      clicked: new Map(),
      bombsHit: 0,
      prizesFound: 0,
      spentAmount: "0",
      prizeEarned: "0",
      runStatus: null,
      lastActionAt: null,
      createdAt: new Date().toISOString(),
      // Cumulative stats (never reset by resetRun)
      cumulativeEarnings: "0",
      cumulativePlayers: 0,
      cumulativeRuns: 0,
      lastPlayedAt: null,
    };
    store.sessions.set(sessionId, session);
    persist();
    return res.json({
      sessionId,
      host,
      mode,
      prizePot: pot.toString(),
      entranceFee: ENTRANCE_FEE.toString(),
      bombs: modeConfig[mode].bombs,
      prizes: modeConfig[mode].prizes,
      status: "open",
    });
  });

  // LIST: Open sessions available for players to join.
  app.get("/v2/sessions", (_req, res) => {
    cleanupStaleSessions(store, persist);
    const open = [...store.sessions.values()]
      .filter((s) => s.status === "open")
      .map((s) => ({
        sessionId: s.sessionId,
        host: s.host,
        mode: s.mode,
        prizePot: s.prizePot,
        entranceFee: s.entranceFee,
        bombs: modeConfig[s.mode].bombs,
        prizes: modeConfig[s.mode].prizes,
        firstTileCost: revealCostAt(s.prizePot, s.mode, 0).toString(),
        createdAt: s.createdAt,
        earnings: s.cumulativeEarnings || "0",
        players: s.cumulativePlayers || 0,
        runs: s.cumulativeRuns || 0,
        lastPlayedAt: s.lastPlayedAt || null,
      }));
    return res.json({ sessions: open, count: open.length });
  });

  // PLAYER: Join an open session — pay entrance fee, submit commitment.
  app.post("/v2/sessions/:sessionId/join", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({
      player: addressSchema,
      commitment: bytes32Schema,
    }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (session.status !== "open") return res.status(409).json({ error: "SESSION_NOT_OPEN", status: session.status });
    if (bodyParse.data.player.toLowerCase() === session.host.toLowerCase()) return res.status(403).json({ error: "HOST_CANNOT_PLAY" });

    cleanupStaleSessions(store, persist);
    // Re-check after cleanup (may have been reopened)
    if (session.status !== "open") return res.status(409).json({ error: "SESSION_NOT_OPEN", status: session.status });

    const player = bodyParse.data.player;
    if (getBalance(store, player) < ENTRANCE_FEE) return res.status(402).json({ error: "INSUFFICIENT_CREDITS", needed: ENTRANCE_FEE.toString() });

    // Pay entrance fee → host
    setBalance(store, player, getBalance(store, player) - ENTRANCE_FEE);
    setBalance(store, session.host, getBalance(store, session.host) + ENTRANCE_FEE);

    session.activePlayer = player;
    session.commitment = bodyParse.data.commitment;
    session.commitExpiresAt = Date.now() + REVEAL_TIMEOUT_MS;
    session.status = "occupied";
    session.runStatus = "committed";
    trackPlayer(session);
    persist();
    return res.json({
      sessionId: session.sessionId,
      player,
      mode: session.mode,
      prizePot: session.prizePot,
      entranceFee: ENTRANCE_FEE.toString(),
      status: "occupied",
      runStatus: "committed",
      commitExpiresAt: session.commitExpiresAt,
    });
  });

  // PLAYER: Reveal entropy → triggers Pyth → board derived.
  app.post("/v2/sessions/:sessionId/reveal", async (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema, entropy: bytes32Schema, salt: bytes32Schema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.activePlayer?.toLowerCase()) return res.status(403).json({ error: "NOT_ACTIVE_PLAYER" });
    if (session.runStatus !== "committed") return res.status(409).json({ error: "SESSION_NOT_COMMITTED", status: session.runStatus });

    const expected = computeCommitment(bodyParse.data.entropy, bodyParse.data.salt);
    if (expected !== session.commitment) return res.status(400).json({ error: "COMMITMENT_MISMATCH" });

    let entropyResult;
    try {
      entropyResult = await requestEntropy(bodyParse.data.entropy);
    } catch (error) {
      // Pyth failed — refund entrance fee, reopen session.
      setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + ENTRANCE_FEE);
      setBalance(store, session.host, getBalance(store, session.host) - ENTRANCE_FEE);
      session.entropyError = error.message || "ENTROPY_REQUEST_FAILED";
      session.runStatus = "failed";
      resetRun(session);
      persist();
      return res.status(503).json({ error: "ENTROPY_REQUEST_FAILED", message: session.entropyError, refunded: true });
    }

    const pythRandom = entropyResult.randomNumber;
    const board = deriveBoard({ entropy: pythRandom, sessionId: session.sessionId, player: session.activePlayer, mode: session.mode });
    const commit = boardCommitHash({ entropy: pythRandom, sessionId: session.sessionId, player: session.activePlayer, mode: session.mode, board });

    session.entropy = bodyParse.data.entropy;
    session.salt = bodyParse.data.salt;
    session.pythRandomNumber = pythRandom;
    session.entropySequenceNumber = String(entropyResult.sequenceNumber);
    session.entropyTxHash = entropyResult.txHash;
    session.board = board;
    session.boardCommitHash = commit;
    session.runStatus = "active";
    session.lastActionAt = Date.now();
    persist();

    return res.json({
      sessionId: session.sessionId,
      boardCommitHash: commit,
      status: "active",
      runStatus: "active",
      entropySequenceNumber: String(entropyResult.sequenceNumber),
      entropyTxHash: entropyResult.txHash,
    });
  });

  // PLAYER: Click a tile — progressive cost debited, outcome resolved.
  app.post("/v2/sessions/:sessionId/click", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema, tile: z.number().int() }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.activePlayer?.toLowerCase()) return res.status(403).json({ error: "NOT_ACTIVE_PLAYER" });

    let tile;
    try { tile = normalizeTile(bodyParse.data.tile); } catch { return res.status(400).json({ error: "INVALID_TILE" }); }
    if (session.clicked.has(tile)) return res.json(session.clicked.get(tile));
    if (session.runStatus !== "active") return res.status(409).json({ error: "SESSION_NOT_ACTIVE", status: session.runStatus });

    // Progressive cost based on how many tiles already revealed
    const revealIndex = session.clicked.size;
    const cost = revealCostAt(session.prizePot, session.mode, revealIndex);
    if (getBalance(store, session.activePlayer) < cost) {
      return res.status(402).json({ error: "INSUFFICIENT_CREDITS_FOR_REVEAL", cost: cost.toString() });
    }

    // Debit cost from player, add to session spent
    setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) - cost);
    session.spentAmount = (BigInt(session.spentAmount) + cost).toString();
    session.lastActionAt = Date.now();

    let outcome = "empty";
    let prizeCredited = "0";

    if (session.board.bombPositions.includes(tile)) {
      outcome = "bomb";
      session.bombsHit += 1;
      if (session.bombsHit >= BOMBS_TO_GAME_OVER) {
        // Game over — host gets all spent, session reopens
        const spent = BigInt(session.spentAmount);
        if (spent > 0n) setBalance(store, session.host, getBalance(store, session.host) + spent);
        recordRunEnd(session, spent);
        session.runStatus = "lost";
        const result = {
          sessionId: session.sessionId, tile, outcome,
          bombsHit: session.bombsHit, prizesFound: session.prizesFound,
          status: "lost", runStatus: "lost",
          cost: cost.toString(), spentTotal: session.spentAmount,
          prizeEarned: session.prizeEarned,
        };
        session.clicked.set(tile, result);
        resetRun(session);
        persist();
        return res.json(result);
      }
    } else if (session.board.prizePositions.includes(tile)) {
      outcome = "prize";
      session.prizesFound += 1;
      const prize = prizePerTile(session.prizePot, session.mode);
      setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + prize);
      session.prizeEarned = (BigInt(session.prizeEarned) + prize).toString();
      prizeCredited = prize.toString();

      if (session.prizesFound >= modeConfig[session.mode].prizes) {
        // All prizes found — player wins, host gets spent, session reopens
        const spent = BigInt(session.spentAmount);
        if (spent > 0n) setBalance(store, session.host, getBalance(store, session.host) + spent);
        recordRunEnd(session, spent);
        session.runStatus = "won";
        const result = {
          sessionId: session.sessionId, tile, outcome,
          bombsHit: session.bombsHit, prizesFound: session.prizesFound,
          status: "won", runStatus: "won",
          cost: cost.toString(), spentTotal: session.spentAmount,
          prizeEarned: session.prizeEarned, prizeCredited: prizeCredited,
        };
        session.clicked.set(tile, result);
        resetRun(session);
        persist();
        return res.json(result);
      }
    }

    const result = {
      sessionId: session.sessionId, tile, outcome,
      bombsHit: session.bombsHit, prizesFound: session.prizesFound,
      status: "active", runStatus: "active",
      cost: cost.toString(), spentTotal: session.spentAmount,
      prizeEarned: session.prizeEarned, prizeCredited,
      nextTileCost: revealCostAt(session.prizePot, session.mode, session.clicked.size + 1).toString(),
    };
    session.clicked.set(tile, result);
    persist();
    return res.json(result);
  });

  // PLAYER: Quit — host gets spent, session reopens.
  app.post("/v2/sessions/:sessionId/quit", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.activePlayer?.toLowerCase()) return res.status(403).json({ error: "NOT_ACTIVE_PLAYER" });

    // If committed but never revealed → refund entrance, reopen
    if (session.runStatus === "committed") {
      setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + ENTRANCE_FEE);
      setBalance(store, session.host, getBalance(store, session.host) - ENTRANCE_FEE);
      session.runStatus = "cancelled";
      const resp = { sessionId: session.sessionId, status: "cancelled", refunded: ENTRANCE_FEE.toString(), spentTotal: "0", prizeEarned: "0" };
      resetRun(session);
      persist();
      return res.json(resp);
    }

    // Active → host gets spent, player keeps prizeEarned
    const spent = BigInt(session.spentAmount);
    if (spent > 0n) setBalance(store, session.host, getBalance(store, session.host) + spent);
    recordRunEnd(session, spent);
    session.runStatus = "quit";
    const resp = {
      sessionId: session.sessionId,
      status: "quit",
      spentTotal: session.spentAmount,
      prizeEarned: session.prizeEarned,
      board: session.board,
      boardCommitHash: session.boardCommitHash,
      pythRandomNumber: session.pythRandomNumber,
      entropySequenceNumber: session.entropySequenceNumber,
    };
    resetRun(session);
    persist();
    return res.json(resp);
  });

  // HOST: Close session — reclaim unspent prize pot. Only when open (no active player).
  app.post("/v2/sessions/:sessionId/close", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ host: addressSchema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.host.toLowerCase() !== session.host.toLowerCase()) return res.status(403).json({ error: "NOT_SESSION_HOST" });
    if (session.status !== "open") return res.status(409).json({ error: "SESSION_NOT_OPEN", status: session.status });

    // Refund prize pot to host
    setBalance(store, session.host, getBalance(store, session.host) + BigInt(session.prizePot));
    session.status = "closed";
    persist();
    return res.json({ sessionId: session.sessionId, status: "closed", refunded: session.prizePot });
  });

  // Anyone: Kick idle player (>60s no action).
  app.post("/v2/sessions/:sessionId/kick-idle", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    if (!paramParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (session.status !== "occupied" || session.runStatus !== "active") return res.status(409).json({ error: "NO_ACTIVE_PLAYER" });
    if (!session.lastActionAt || Date.now() <= session.lastActionAt + IDLE_TIMEOUT_MS) return res.status(400).json({ error: "PLAYER_NOT_IDLE" });

    // Host gets spent, session reopens
    const spent = BigInt(session.spentAmount);
    if (spent > 0n) setBalance(store, session.host, getBalance(store, session.host) + spent);
    recordRunEnd(session, spent);
    session.runStatus = "idle_kicked";
    const resp = { sessionId: session.sessionId, status: "idle_kicked", spentTotal: session.spentAmount, prizeEarned: session.prizeEarned };
    resetRun(session);
    persist();
    return res.json(resp);
  });

  // Get session detail (for UI).
  app.get("/v2/sessions/:sessionId", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    if (!paramParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return res.json({
      sessionId: session.sessionId,
      host: session.host,
      mode: session.mode,
      prizePot: session.prizePot,
      entranceFee: session.entranceFee,
      status: session.status,
      runStatus: session.runStatus,
      activePlayer: session.activePlayer,
      bombs: modeConfig[session.mode].bombs,
      prizes: modeConfig[session.mode].prizes,
      bombsHit: session.bombsHit,
      prizesFound: session.prizesFound,
      spentAmount: session.spentAmount,
      prizeEarned: session.prizeEarned,
      createdAt: session.createdAt,
      earnings: session.cumulativeEarnings || "0",
      players: session.cumulativePlayers || 0,
      runs: session.cumulativeRuns || 0,
      lastPlayedAt: session.lastPlayedAt || null,
    });
  });

  return store;
}

module.exports = {
  installV2Routes, createV2Store, loadV2Store, deriveBoard, boardCommitHash,
  computeCommitment, modeConfig, revealCostAt, prizePerTile,
  ENTRANCE_FEE, MIN_PRIZE_POT, MAX_PRIZE_POT, BOMBS_TO_GAME_OVER, IDLE_TIMEOUT_MS,
};
