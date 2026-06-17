const express = require("express");
const cors = require("cors");
const { z } = require("zod");
const { encodeFunctionData, createPublicClient, http, parseAbi } = require("viem");
const chancyAbiJson = require("../../abi/ChancyGame.json");
const chancyAbi = chancyAbiJson.abi || chancyAbiJson;

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
  const rows = await Promise.all(ids.map(async (id) => normalizeSession(id, await client.readContract({ address: contract, abi: chancyAbi, functionName: "sessions", args: [id] }))));
  return { sessions: rows, nextSessionId: nextSessionId.toString(), source: "contract" };
}

async function getEntropyFee({ contract, rpcUrl }) {
  const client = createPublicClient({ transport: http(rpcUrl || DEFAULT_BASE_RPC_URL) });
  const entropyAddress = await client.readContract({ address: contract, abi: chancyAbi, functionName: "entropy" });
  const provider = await client.readContract({ address: entropyAddress, abi: entropyAbi, functionName: "getDefaultProvider" });
  const fee = await client.readContract({ address: entropyAddress, abi: entropyAbi, functionName: "getFeeV2", args: [provider, ENTROPY_CALLBACK_GAS_LIMIT] });
  return { fee: fee.toString(), provider, entropyAddress };
}

function createApp({ contractAddress = process.env.CHANCY_CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS, rpcUrl = process.env.BASE_RPC_URL || process.env.CHANCY_RPC_URL || DEFAULT_BASE_RPC_URL } = {}) {
  const contract = addressSchema.parse(contractAddress);
  const app = express();

  app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
    next();
  });
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "chancy-api", contractAddress: contract });
  });

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

module.exports = { createApp, chancyAbi, readCall, listSessions, getEntropyFee };
