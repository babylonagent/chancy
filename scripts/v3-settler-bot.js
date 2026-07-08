"use strict";

/**
 * Chancy V3 Settler Bot
 *
 * Watches ChancySettlementV3 contract for game lifecycle events:
 *   1. GameActivated → notify engine to create session
 *   2. Game over (engine reports finished) → call settleGame on contract
 *   3. Refund timeout → monitored but not triggered by bot
 *
 * The settler bot has ZERO money authority. The contract re-derives the board
 * and replays clicks. If the bot submits wrong data, the tx reverts.
 */

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const SETTLEMENT_ADDRESS = process.env.CHANCY_V3_SETTLEMENT_ADDRESS;
const USDC_ADDRESS = process.env.CHANCY_V3_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const SETTLER_KEY = process.env.SANDBOX_WALLET_PRIVATE_KEY || process.env.SETTLER_PRIVATE_KEY;
const ENGINE_URL = process.env.V3_ENGINE_URL || "http://127.0.0.1:8790";

if (!SETTLEMENT_ADDRESS) throw new Error("CHANCY_V3_SETTLEMENT_ADDRESS not set");
if (!SETTLER_KEY) throw new Error("SETTLER_PRIVATE_KEY or SANDBOX_WALLET_PRIVATE_KEY not set");

// ── Setup ───────────────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const settler = new ethers.Wallet(
  SETTLER_KEY.startsWith("0x") ? SETTLER_KEY : "0x" + SETTLER_KEY,
  provider
);

const artifact = require(
  fs.existsSync(path.join(__dirname, "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json"))
    ? path.join(__dirname, "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json")
    : path.join(__dirname, "..", "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json")
);
const contract = new ethers.Contract(SETTLEMENT_ADDRESS, artifact.abi, settler);

// ── Outcome mapping ─────────────────────────────────────────────────────────
const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };
const outcomeEnum = { win: 1, loss: 2, quit: 3 };

// ── Settler Logic ───────────────────────────────────────────────────────────

/**
 * Main loop: poll engine for finished sessions, settle them on-chain.
 */
async function runSettlerLoop() {
  console.log("[settler] Bot started");
  console.log("[settler] Contract:", SETTLEMENT_ADDRESS);
  console.log("[settler] Settler:", settler.address);
  console.log("[settler] Engine:", ENGINE_URL);

  const balance = await provider.getBalance(settler.address);
  console.log("[settler] Balance:", ethers.formatEther(balance), "ETH");

  // Watch GameActivated events — when fired, tell the engine to create a session
  const filter = contract.filters.GameActivated();
  contract.on(filter, async (gameId, pythRandomNumber, event) => {
    console.log(`[settler] GameActivated: gameId=${gameId}, pyth=${pythRandomNumber}`);

    try {
      // Read game data from the contract
      const game = await contract.getGame(gameId);
      const gameData = {
        host: game.host,
        player: game.player,
        difficulty: Number(game.difficulty),
        prizePot: game.prizePot.toString(),
        maxSpend: game.maxSpend.toString(),
        pythRandom: pythRandomNumber,
      };

      console.log(`[settler] Activating engine session for game ${gameId}...`);

      // Tell the engine to create the session
      // The engine will retrieve the hostSecret from pendingSecrets
      const resp = await fetch(`${ENGINE_URL}/v3/sessions/${gameId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameData),
      });

      if (resp.ok) {
        console.log(`[settler] Engine session activated for game ${gameId}`);
      } else {
        const err = await resp.text();
        console.error(`[settler] Engine activation failed for game ${gameId}: ${err}`);
      }
    } catch (err) {
      console.error(`[settler] GameActivated handler error:`, err.message);
    }
  });

  // Poll for finished sessions every 5 seconds
  setInterval(async () => {
    try {
      await checkAndSettle();
    } catch (err) {
      console.error("[settler] Loop error:", err.message);
    }
  }, 5000);

  // Watch GameSettled events
  const settledFilter = contract.filters.GameSettled();
  contract.on(settledFilter, (gameId, outcome, hostPayout, playerPayout) => {
    console.log(`[settler] GameSettled: gameId=${gameId}, outcome=${outcome}, host=${hostPayout}, player=${playerPayout}`);
  });
}

async function checkAndSettle() {
  // Get finished sessions from engine
  const resp = await fetch(`${ENGINE_URL}/v3/sessions/finished`);
  if (!resp.ok) return;
  const { sessions } = await resp.json();

  for (const s of sessions) {
    // Check if already settled on-chain
    const game = await contract.getGame(s.gameId);
    if (Number(game.status) !== 1) continue; // Only settle Active games (status=1)

    // Get settlement data from engine
    const settleResp = await fetch(`${ENGINE_URL}/v3/sessions/${s.gameId}/settlement`);
    if (!settleResp.ok) continue;
    const settleData = await settleResp.json();

    console.log(`[settler] Settling game ${s.gameId}: outcome=${settleData.outcome}, clicks=${settleData.clicks.length}`);

    try {
      const outcomeVal = outcomeEnum[settleData.outcome];
      if (!outcomeVal) {
        console.error(`[settler] Invalid outcome: ${settleData.outcome}`);
        continue;
      }

      const tx = await contract.settleGame(
        s.gameId,
        settleData.hostSecret,
        settleData.clicks,
        outcomeVal
      );
      console.log(`[settler] settleGame tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[settler] Game ${s.gameId} settled in block ${receipt.blockNumber}`);

      // Notify engine to clean up (optional — session stays in memory but won't be re-settled
      // because on-chain status will be != 1)
    } catch (err) {
      console.error(`[settler] settleGame failed for game ${s.gameId}:`, err.message?.slice(0, 200));
    }
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
runSettlerLoop().catch((err) => {
  console.error("[settler] Fatal:", err);
  process.exit(1);
});