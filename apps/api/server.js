const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { z } = require("zod");
const { encodeFunctionData, createPublicClient, http, parseAbi, decodeEventLog } = require("viem");
const chancyAbiJson = require("../../abi/ChancyGame.json");
const chancyVaultAbiJson = require("../../abi/ChancyVault.json");
const { installV2Routes, loadV2Store, getBalance, setBalance, trackPlayer, recordRunEnd, resetRun, cleanupStaleSessions, persistStore, modeConfig, revealCostAt, prizePerTile, deriveBoard, boardCommitHash, computeCommitment, ENTRANCE_FEE, MIN_PRIZE_POT, MAX_PRIZE_POT, MAX_CONCURRENT_SESSIONS: _unused } = require("./v2");
const { initDatabase, loadSqliteStore, migrateJsonToSqlite } = require("./sqlite-store");
const { makeEntropyRequester } = require("./entropy");
const { createChancyX402 } = require("./x402-routes");
const { createDepositIndexer } = require("./deposit-indexer");
const { rateLimit, getClientIp, stakeCap, corsRestriction, securityHeaders, MAX_CONCURRENT_SESSIONS } = require("./security");
const chancyRandomnessAbiJson = require("../../abi/ChancyRandomness.json");
const chancyAbi = chancyAbiJson.abi || chancyAbiJson;
const chancyVaultAbi = chancyVaultAbiJson.abi || chancyVaultAbiJson;

const difficultyMap = {
  Easy: 0,
  Normal: 1,
  Hardcore: 2,
};
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const entropyAbi = parseAbi([
  "function getDefaultProvider() view returns (address)",
  "function getFeeV2(address provider, uint32 gasLimit) view returns (uint128)",
]);
const ENTROPY_CALLBACK_GAS_LIMIT = 350000;

// Settlement asset is an address: native ETH is the zero address, USDC (or any
// allow-listed ERC20) is its token address. New assets need no API change.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintString = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

function isNative(asset) {
  return asset.toLowerCase() === ZERO_ADDRESS;
}

function tx(to, data, value = "0") {
  return { to, data, value };
}

function readCall(to, functionName, args = []) {
  return {
    to,
    data: encodeFunctionData({ abi: chancyAbi, functionName, args }),
    value: "0",
    decodeAs: functionName,
  };
}

function validate(schema, handler) {
  return (req, res) => {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }

    try {
      return res.json(handler(parsed.data));
    } catch (error) {
      return res.status(500).json({ error: "TX_BUILD_FAILED", message: error.message });
    }
  };
}

function validateParams(schema, handler) {
  return (req, res) => {
    const parsed = schema.safeParse(req.params || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_PARAMS", details: parsed.error.flatten() });
    }

    try {
      return res.json(handler(parsed.data));
    } catch (error) {
      return res.status(500).json({ error: "READ_BUILD_FAILED", message: error.message });
    }
  };
}

const DEFAULT_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

function normalizeSession(sessionId, raw) {
  return {
    sessionId: sessionId.toString(),
    host: raw[0],
    asset: raw[1],
    difficulty: ["Easy", "Normal", "Hardcore"][Number(raw[2])] || String(raw[2]),
    prizePot: raw[3].toString(),
    activePlayer: raw[4],
    bombCount: Number(raw[5]),
    prizeCount: Number(raw[6]),
    open: raw[7],
  };
}

async function listSessions({ contract, rpcUrl, limit = 24 }) {
  if (contract === DEFAULT_CONTRACT_ADDRESS) return { sessions: [], nextSessionId: "1", source: "unconfigured" };
  const client = createPublicClient({ transport: http(rpcUrl || DEFAULT_BASE_RPC_URL) });
  const nextSessionId = await client.readContract({ address: contract, abi: chancyAbi, functionName: "nextSessionId" });
  const latestId = nextSessionId - 1n;
  if (latestId === 0n) return { sessions: [], nextSessionId: nextSessionId.toString(), source: "contract" };
  const count = BigInt(Math.max(1, Math.min(Number(limit) || 24, 50)));
  const start = latestId > count ? latestId - count + 1n : 1n;
  const ids = [];
  for (let id = latestId; id >= start; id -= 1n) ids.push(id);
  const rows = [];
  const errors = [];
  for (const id of ids) {
    try {
      const raw = await client.readContract({ address: contract, abi: chancyAbi, functionName: "sessions", args: [id] });
      rows.push(normalizeSession(id, raw));
    } catch (error) {
      errors.push({ sessionId: id.toString(), message: error.shortMessage || error.message });
    }
  }
  return { sessions: rows, nextSessionId: nextSessionId.toString(), source: "contract", errors };
}

// On-chain deposit verifier. Reads the tx receipt, requires it succeeded, finds
// the Deposited log emitted BY OUR VAULT (ignores spoofed logs from other
// contracts), decodes it, and returns the real on-chain net amount. This is the
// trust boundary: credits come from chain truth, never from the client body.
function makeDepositVerifier({ vault, rpcUrl, minConfirmations = 1 }) {
  const vaultLower = vault.toLowerCase();
  return async function verifyDeposit({ txHash }) {
    const client = createPublicClient({ transport: http(rpcUrl || DEFAULT_BASE_RPC_URL) });
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (/could not be found|not be found|not found/i.test(error.shortMessage || error.message || "")) {
        throw new Error("DEPOSIT_NOT_FOUND");
      }
      throw new Error("DEPOSIT_RPC_ERROR");
    }
    if (!receipt) throw new Error("DEPOSIT_NOT_FOUND");
    if (receipt.status !== "success") throw new Error("DEPOSIT_TX_REVERTED");

    if (minConfirmations > 1) {
      try {
        const head = await client.getBlockNumber();
        const confs = head - receipt.blockNumber + 1n;
        if (confs < BigInt(minConfirmations)) throw new Error("DEPOSIT_NOT_CONFIRMED");
      } catch (error) {
        if (error.message === "DEPOSIT_NOT_CONFIRMED") throw error;
        // confirmation check is best-effort; don't fail a valid deposit on RPC hiccup
      }
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vaultLower) continue; // must come from our vault
      let decoded;
      try {
        decoded = decodeEventLog({ abi: chancyVaultAbi, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (decoded.eventName !== "Deposited") continue;
      const { player, grossAmount, creditedAmount, feeAmount } = decoded.args;
      return {
        player,
        grossAmount: grossAmount.toString(),
        creditedAmount: creditedAmount.toString(),
        feeAmount: feeAmount.toString(),
      };
    }
    throw new Error("DEPOSIT_EVENT_NOT_FOUND");
  };
}

async function getEntropyFee({ contract, rpcUrl }) {
  const client = createPublicClient({ transport: http(rpcUrl || DEFAULT_BASE_RPC_URL) });
  const entropyAddress = await client.readContract({ address: contract, abi: chancyAbi, functionName: "entropy" });
  const provider = await client.readContract({ address: entropyAddress, abi: entropyAbi, functionName: "getDefaultProvider" });
  const fee = await client.readContract({ address: entropyAddress, abi: entropyAbi, functionName: "getFeeV2", args: [provider, ENTROPY_CALLBACK_GAS_LIMIT] });
  return { fee: fee.toString(), provider, entropyAddress };
}

function createApp({
  contractAddress = process.env.CHANCY_CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS,
  vaultAddress = process.env.CHANCY_VAULT_ADDRESS || DEFAULT_CONTRACT_ADDRESS,
  usdcAddress = process.env.CHANCY_USDC_ADDRESS || process.env.VITE_CHANCY_BASE_USDC_ADDRESS || DEFAULT_CONTRACT_ADDRESS,
  randomnessAddress = process.env.CHANCY_RANDOMNESS_ADDRESS || "",
  hotWalletKey = process.env.CHANCY_HOT_WALLET_KEY || process.env.CHANCY_HOT_WALLET_PRIVATE_KEY || "",
  rpcUrl = process.env.BASE_RPC_URL || process.env.CHANCY_RPC_URL || DEFAULT_BASE_RPC_URL,
  v2StorePath = process.env.CHANCY_V2_STORE_PATH || "",
  v2DbPath = process.env.CHANCY_V2_DB_PATH || "",
} = {}) {
  const contract = addressSchema.parse(contractAddress);
  const vault = addressSchema.parse(vaultAddress);
  const usdc = addressSchema.parse(usdcAddress);
  const app = express();

  // ── Security middleware ──
  const allowedOrigins = (process.env.CHANCY_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  app.use(securityHeaders);
  app.use(corsRestriction(allowedOrigins));
  app.use(express.json());

  // Global rate limit: 120 req/min per IP
  app.use(rateLimit({
    maxTokens: 120, refillPerSec: 2,
    keyFn: (req) => `ip:${getClientIp(req)}`,
    name: "global",
  }));

  // Per-endpoint rate limits
  app.use("/v2/credits/deposit", rateLimit({
    maxTokens: 10, refillPerSec: 0.2, // 10/min — each does an RPC call
    keyFn: (req) => `deposit:${getClientIp(req)}`,
    name: "deposit",
  }));
  app.use("/v2/sessions", rateLimit({
    maxTokens: 20, refillPerSec: 0.5, // 20/min — session creation + entropy
    keyFn: (req) => `session:${getClientIp(req)}`,
    name: "session",
  }));
  app.use("/v2/withdrawals/request", rateLimit({
    maxTokens: 10, refillPerSec: 0.2, // 10/min
    keyFn: (req) => `withdraw:${getClientIp(req)}`,
    name: "withdraw",
  }));
  app.use("/v2/tx/", rateLimit({
    maxTokens: 30, refillPerSec: 0.5, // 30/min — tx building endpoints
    keyFn: (req) => `tx:${getClientIp(req)}`,
    name: "tx_build",
  }));

  app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    next();
  });

  // Persistence: SQLite when db path is set, JSON file otherwise.
  // On first run with SQLite, auto-migrate from JSON if it has data.
  let db = null;
  let store;
  if (v2DbPath) {
    // Auto-migrate from JSON store if SQLite is empty and JSON exists.
    if (v2StorePath && fs.existsSync(v2StorePath) && fs.statSync(v2StorePath).size > 2) {
      const { migrateJsonToSqlite } = require("./sqlite-store");
      const mig = migrateJsonToSqlite(v2StorePath, v2DbPath);
      if (mig.migrated) {
        console.log(JSON.stringify({ ok: true, migrated: "json-to-sqlite", ...mig }));
      }
    }
    db = initDatabase(v2DbPath);
    store = loadSqliteStore(db);
  } else {
    store = loadV2Store(v2StorePath);
  }

  // Entropy requester: on-chain Pyth randomness for cheat-proof board generation.
  let requestEntropy = null;
  if (randomnessAddress && hotWalletKey) {
    requestEntropy = makeEntropyRequester({
      contractAddress: randomnessAddress,
      hotWalletKey,
      rpcUrl,
    });
  }

  installV2Routes(app, {
    store,
    storePath: v2StorePath,
    db,
    verifyDeposit: makeDepositVerifier({ vault, rpcUrl, minConfirmations: Number(process.env.CHANCY_DEPOSIT_MIN_CONFIRMATIONS || 1) }),
    requestEntropy,
    adminToken: process.env.CHANCY_ADMIN_TOKEN || "",
  });

  // ── x402 Pay-Per-Action Integration ──
  // Adds /v2/x402/* endpoints with HTTP 402 payment protocol.
  // Agents pay USDC per-request via Coinbase facilitator — no pre-funding needed.
  const x402Wallet = process.env.CHANCY_X402_WALLET || process.env.CHANCY_HOT_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";
  const x402Testnet = process.env.CHANCY_X402_TESTNET === "true"; // default: mainnet (false)

  const x402PersistFn = db
    ? () => require("./sqlite-store").persistSqliteStore(db, store)
    : () => persistStore(store, v2StorePath);

  try {
    // Load CDP API key for mainnet facilitator auth
    const cdpKeyName = process.env.CHANCY_X402_CDP_KEY_NAME || "";
    const cdpKeyFile = process.env.CHANCY_X402_CDP_KEY_FILE || "";
    let cdpPrivateKey = "";
    if (!x402Testnet && cdpKeyName && cdpKeyFile) {
      try {
        cdpPrivateKey = require("fs").readFileSync(cdpKeyFile, "utf8").trim();
      } catch (e) {
        console.error(JSON.stringify({ ok: false, x402: false, error: "CDP_KEY_FILE_READ_FAILED: " + e.message }));
      }
    }

    const { middleware: x402Mw, installX402Routes } = createChancyX402({
      receivingWallet: x402Wallet,
      store,
      revealCostAt,
      modeConfig,
      testnet: x402Testnet,
      persist: x402PersistFn,
      cdpKeyName,
      cdpPrivateKey,
    });

    // x402 middleware must run BEFORE route handlers for protected routes
    app.use(x402Mw);

    // Install x402 game route handlers
    const { MAX_CONCURRENT_SESSIONS } = require("./security");
    installX402Routes(app, {
      getBalance, setBalance,
      generateCommitment: (entropy, salt) => computeCommitment(entropy, salt),
      deriveBoard, boardCommitHash, computeCommitment,
      requestEntropy: requestEntropy || (async () => { throw new Error("ENTROPY_NOT_CONFIGURED"); }),
      prizePerTile, trackPlayer, recordRunEnd, resetRun, cleanupStaleSessions,
      MAX_CONCURRENT_SESSIONS,
      MIN_PRIZE_POT, MAX_PRIZE_POT,
    });

    console.log(JSON.stringify({ ok: true, x402: true, network: x402Testnet ? "base-sepolia" : "base-mainnet", wallet: x402Wallet }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, x402: false, error: err.message }));
  }

  // x402 resourceServer.initialize() runs async AFTER the try-catch above.
  // If CDP credentials are missing/misconfigured, it throws an unhandled rejection
  // that crashes the whole API. Catch it here so the core game service stays up.
  process.on("unhandledRejection", (reason) => {
    const msg = String(reason?.message || reason || "");
    if (msg.includes("Facilitator") || msg.includes("x402") || msg.includes("supported payment kinds")) {
      console.error(JSON.stringify({ ok: false, x402: false, error: "x402 async init failed (non-fatal): " + msg }));
      return; // swallow — core game still works
    }
    console.error("Unhandled rejection:", reason);
    process.exit(1);
  });

  // ── Deposit Indexer — auto-credits raw USDC transfers to vault ──
  // Watches Transfer events, credits from address 95% net (5% fee stays in vault).
  // Replaces approve+deposit flow with single raw send.
  const persistFn = db
    ? () => require("./sqlite-store").persistSqliteStore(db, store)
    : () => {};

  // lastScannedBlock tracking (DB-backed if SQLite, in-memory otherwise)
  let _lastScannedBlock = 0;
  const getLastBlock = () => {
    if (db) {
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("indexerLastBlock");
        return row ? Number(row.value) : 0;
      } catch { return _lastScannedBlock; }
    }
    return _lastScannedBlock;
  };
  const setLastBlock = (block) => {
    _lastScannedBlock = block;
    if (db) {
      try {
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("indexerLastBlock", String(block));
      } catch { /* best-effort */ }
    }
  };

  let indexer = null;
  if (process.env.CHANCY_INDEXER_DISABLED !== "1") {
    indexer = createDepositIndexer({
      rpcUrl,
      vaultAddress: vault,
      usdcAddress: usdc,
      store,
      persist: x402PersistFn,
      minConfirmations: Number(process.env.CHANCY_DEPOSIT_MIN_CONFIRMATIONS || 3),
      pollIntervalMs: Number(process.env.CHANCY_INDEXER_POLL_MS || 5000),
      getLastBlock,
      setLastBlock,
    });
    indexer.start();
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "chancy-api", contractAddress: contract });
  });

  app.get("/v2/config", (_req, res) => {
    res.json({
      ok: true,
      vaultAddress: vault,
      usdcAddress: usdc,
      randomnessAddress: randomnessAddress || null,
      pythEntropyAddress: process.env.PYTH_ENTROPY_ADDRESS || null,
      creditAsset: "USD_CREDIT",
      depositFeeBps: "500",
    });
  });

  app.post("/v2/tx/approve-usdc", validate(z.object({
    amount: uintString,
  }), (body) => tx(usdc, encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [vault, BigInt(body.amount)],
  }))));

  // Check current allowance — frontend uses this to skip redundant approve txs
  app.get("/v2/allowance/:player", async (req, res) => {
    const parsed = z.object({ player: addressSchema }).safeParse(req.params || {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARAMS" });
    try {
      const allowance = await client.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [parsed.data.player, vault],
      });
      return res.json({ player: parsed.data.player, allowance: allowance.toString() });
    } catch (err) {
      return res.status(502).json({ error: "ALLOWANCE_READ_FAILED", message: err.message });
    }
  });

  app.post("/v2/tx/deposit", validate(z.object({
    amount: uintString,
  }), (body) => tx(vault, encodeFunctionData({
    abi: chancyVaultAbi,
    functionName: "deposit",
    args: [BigInt(body.amount)],
  }))));

  app.get("/data/sessions", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 24), 50);
      res.json(await listSessions({ contract, rpcUrl, limit }));
    } catch (error) {
      res.status(502).json({ error: "SESSION_DISCOVERY_FAILED", message: error.message });
    }
  });

  app.get("/data/entropy-fee", async (_req, res) => {
    try {
      res.json(await getEntropyFee({ contract, rpcUrl }));
    } catch (error) {
      res.status(502).json({ error: "ENTROPY_FEE_FAILED", message: error.message });
    }
  });

  app.post("/tx/approve-usdc", validate(z.object({
    asset: addressSchema,
    amount: uintString,
  }), (body) => tx(body.asset, encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [contract, BigInt(body.amount)],
  }))));

  app.post("/tx/create-session", validate(z.object({
    asset: addressSchema,
    difficulty: z.enum(["Easy", "Normal", "Hardcore"]),
    prizePot: uintString,
  }), (body) => tx(contract, encodeFunctionData({
    abi: chancyAbi,
    functionName: "createSession",
    args: [body.asset, difficultyMap[body.difficulty], BigInt(body.prizePot)],
  }))));

  app.post("/tx/join-session", validate(z.object({
    sessionId: uintString,
    userRandomNumber: bytes32Schema,
    entropyFee: uintString.default("0"),
  }), (body) => tx(
    contract,
    encodeFunctionData({
      abi: chancyAbi,
      functionName: "joinSession",
      args: [BigInt(body.sessionId), body.userRandomNumber],
    }),
    body.entropyFee,
  )));

  app.post("/tx/click-tile", validate(z.object({
    sessionId: uintString,
    tileIndex: z.number().int().min(0).max(63),
  }), (body) => tx(contract, encodeFunctionData({
    abi: chancyAbi,
    functionName: "clickTile",
    args: [BigInt(body.sessionId), body.tileIndex],
  }))));

  app.post("/tx/claim-rewards", validate(z.object({
    asset: addressSchema,
  }), (body) => tx(contract, encodeFunctionData({
    abi: chancyAbi,
    functionName: "claimRewards",
    args: [body.asset],
  }))));

  app.post("/tx/quit-session", validate(z.object({
    sessionId: uintString,
  }), (body) => tx(contract, encodeFunctionData({
    abi: chancyAbi,
    functionName: "quitSession",
    args: [BigInt(body.sessionId)],
  }))));

  app.post("/tx/kick-idle-player", validate(z.object({
    sessionId: uintString,
  }), (body) => tx(contract, encodeFunctionData({
    abi: chancyAbi,
    functionName: "kickIdlePlayer",
    args: [BigInt(body.sessionId)],
  }))));

  app.get("/read/session/:sessionId", validateParams(z.object({
    sessionId: uintString,
  }), (params) => readCall(contract, "sessions", [BigInt(params.sessionId)])));

  app.get("/read/player-game/:sessionId/:player", validateParams(z.object({
    sessionId: uintString,
    player: addressSchema,
  }), (params) => readCall(contract, "playerGames", [BigInt(params.sessionId), params.player])));

  app.get("/read/claimable-rewards/:player/:asset", validateParams(z.object({
    player: addressSchema,
    asset: addressSchema,
  }), (params) => readCall(contract, "claimableRewards", [params.player, params.asset])));

  app.get("/read/next-session-id", (_req, res) => {
    res.json(readCall(contract, "nextSessionId"));
  });

  app.get("/read/current-reveal-cost/:sessionId", validateParams(z.object({
    sessionId: uintString,
  }), (params) => readCall(contract, "currentRevealCost", [BigInt(params.sessionId)])));

  return app;
}

function main() {
  const port = Number(process.env.PORT || 8787);
  const app = createApp();
  app.listen(port, () => {
    console.log(JSON.stringify({ ok: true, service: "chancy-api", port }));
  });
}

if (require.main === module) {
  main();
}

module.exports = { createApp, chancyAbi, chancyVaultAbi, readCall, listSessions, getEntropyFee, makeDepositVerifier };
