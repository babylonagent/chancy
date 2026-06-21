const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const modeConfig = {
  Easy: { bombs: 5, prizes: 3 },
  Normal: { bombs: 7, prizes: 2 },
  Hardcore: { bombs: 10, prizes: 1 },
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

function createV2Store() {
  return { balances: new Map(), sessions: new Map(), withdrawals: new Map(), nextSessionId: 1, nextWithdrawalId: 1 };
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

function installV2Routes(app, { store = createV2Store(), storePath = "" } = {}) {
  app.post("/v2/credits/deposit", (req, res) => {
    const parsed = z.object({ player: addressSchema, amount: uintString, txHash: bytes32Schema }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const { player, amount } = parsed.data;
    const next = getBalance(store, player) + BigInt(amount);
    setBalance(store, player, next);
    persistStore(store, storePath);
    return res.json({ player, balance: next.toString(), asset: "USD_CREDIT" });
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
    persistStore(store, storePath);
    return res.json(withdrawal);
  });

  app.get("/v2/withdrawals/:player", (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    const withdrawals = [...store.withdrawals.values()].filter((withdrawal) => withdrawal.player.toLowerCase() === parsed.data.player.toLowerCase());
    return res.json({ player: parsed.data.player, withdrawals });
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
    persistStore(store, storePath);
    return res.json(withdrawal);
  });

  app.post("/v2/sessions", (req, res) => {
    const parsed = z.object({
      player: addressSchema,
      host: addressSchema,
      mode: z.enum(["Easy", "Normal", "Hardcore"]),
      stake: uintString,
      entropy: bytes32Schema,
    }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const body = parsed.data;
    const balance = getBalance(store, body.player);
    const stake = BigInt(body.stake);
    if (stake <= 0n) return res.status(400).json({ error: "INVALID_STAKE" });
    if (balance < stake) return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });

    const sessionId = String(store.nextSessionId++);
    const board = deriveBoard({ entropy: body.entropy, sessionId, player: body.player, mode: body.mode });
    const commit = boardCommitHash({ entropy: body.entropy, sessionId, player: body.player, mode: body.mode, board });
    setBalance(store, body.player, balance - stake);
    const session = {
      sessionId,
      player: body.player,
      host: body.host,
      mode: body.mode,
      stake: stake.toString(),
      entropy: body.entropy,
      board,
      boardCommitHash: commit,
      clicked: new Map(),
      bombsHit: 0,
      prizesCollected: 0,
      status: "active",
    };
    store.sessions.set(sessionId, session);
    persistStore(store, storePath);
    return res.json({ sessionId, player: body.player, host: body.host, mode: body.mode, stake: stake.toString(), boardCommitHash: commit, status: "active" });
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
    if (session.board.bombPositions.includes(tile)) {
      outcome = "bomb";
      session.bombsHit += 1;
      if (session.bombsHit >= 3) session.status = "lost";
    } else if (session.board.prizePositions.includes(tile)) {
      outcome = "prize";
      session.prizesCollected += 1;
      if (session.prizesCollected >= modeConfig[session.mode].prizes) session.status = "won";
    }
    const result = { sessionId: session.sessionId, tile, outcome, bombsHit: session.bombsHit, prizesCollected: session.prizesCollected, status: session.status };
    session.clicked.set(tile, result);
    persistStore(store, storePath);
    return res.json(result);
  });

  app.post("/v2/sessions/:sessionId/exit", (req, res) => {
    const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
    const bodyParse = z.object({ player: addressSchema }).safeParse(req.body || {});
    if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });
    const session = store.sessions.get(paramParse.data.sessionId);
    if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    if (bodyParse.data.player.toLowerCase() !== session.player.toLowerCase()) return res.status(403).json({ error: "NOT_SESSION_PLAYER" });
    if (session.status === "active") session.status = "exited";
    persistStore(store, storePath);
    return res.json({ sessionId: session.sessionId, status: session.status, boardCommitHash: session.boardCommitHash, entropy: session.entropy, board: session.board, clicked: [...session.clicked.values()] });
  });

  return store;
}

module.exports = { installV2Routes, createV2Store, loadV2Store, deriveBoard, boardCommitHash };
