const express = require("express");
const cors = require("cors");
const { z } = require("zod");
const { encodeFunctionData } = require("viem");
const chancyAbiJson = require("../../abi/ChancyGame.json");
const chancyAbi = chancyAbiJson.abi || chancyAbiJson;

const difficultyMap = {
  Easy: 0,
  Normal: 1,
  Hardcore: 2,
};

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

function createApp({ contractAddress = process.env.CHANCY_CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS } = {}) {
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

module.exports = { createApp, chancyAbi, readCall };
