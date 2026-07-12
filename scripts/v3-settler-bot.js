"use strict";

/**
 * Chancy V3 Settler Bot (with on-chain Pyth verification)
 *
 * Lifecycle:
 *   1. GameJoined  → fetch playerRandom from engine → request Pyth Entropy → activateGame(seq)
 *   2. GameActivated → notify engine to create game session
 *   3. Game over (engine reports finished) → call settleGame on contract
 *
 * The settler bot CANNOT inject fake randomness. The contract reads the verified
 * Pyth result directly from ChancyRandomness using the sequence number.
 */

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const SETTLEMENT_ADDRESS = process.env.CHANCY_V3_SETTLEMENT_ADDRESS;
const RANDOMNESS_ADDRESS = process.env.CHANCY_V3_RANDOMNESS_ADDRESS || "0xf67713989c9c2e45037b71d70e9e561bd6019976";
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

// Load artifacts
function loadArtifact(relPath) {
  const local = path.join(__dirname, "artifacts", "contracts", relPath);
  const parent = path.join(__dirname, "..", "artifacts", "contracts", relPath);
  return require(fs.existsSync(local) ? local : parent);
}

const settlementArtifact = loadArtifact("ChancySettlementV3.sol/ChancySettlementV3.json");
const randomnessArtifact = loadArtifact("ChancyRandomness.sol/ChancyRandomness.json");

const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, settlementArtifact.abi, settler);
const randomness = new ethers.Contract(RANDOMNESS_ADDRESS, randomnessArtifact.abi, settler);

// ── Outcome mapping ─────────────────────────────────────────────────────────
const outcomeEnum = { win: 1, loss: 2, quit: 3 };

// ── Track pending Pyth requests ─────────────────────────────────────────────
const pendingActivations = new Map(); // gameId → { seq, attempts }

// ── Settler Logic ───────────────────────────────────────────────────────────

async function runSettlerLoop() {
  console.log("[settler] Bot started");
  console.log("[settler] Settlement:", SETTLEMENT_ADDRESS);
  console.log("[settler] Randomness:", RANDOMNESS_ADDRESS);
  console.log("[settler] Settler:", settler.address);
  console.log("[settler] Engine:", ENGINE_URL);

  const balance = await provider.getBalance(settler.address);
  console.log("[settler] ETH balance:", ethers.formatEther(balance));

  // ── Polling loop (event filters don't work on free RPC) ──
  let lastProcessedBlock = await provider.getBlockNumber();
  console.log("[settler] Starting from block", lastProcessedBlock);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastProcessedBlock) return;

      // Scan for GameJoined events
      const joinFilter = settlement.filters.GameJoined();
      const joinEvents = await settlement.queryFilter(joinFilter, lastProcessedBlock + 1, currentBlock);
      for (const event of joinEvents) {
        const gameId = Number(event.args[0]);
        console.log(`[settler] GameJoined detected: gameId=${gameId}`);
        await handleGameJoined(gameId);
      }

      // Scan for GameActivated events
      const activatedFilter = settlement.filters.GameActivated();
      const activatedEvents = await settlement.queryFilter(activatedFilter, lastProcessedBlock + 1, currentBlock);
      for (const event of activatedEvents) {
        const gameId = Number(event.args[0]);
        const pythRandom = event.args[1];
        console.log(`[settler] GameActivated detected: gameId=${gameId}`);
        await handleGameActivated(gameId, pythRandom);
      }

      // Scan for GameSettled events
      const settledFilter = settlement.filters.GameSettled();
      const settledEvents = await settlement.queryFilter(settledFilter, lastProcessedBlock + 1, currentBlock);
      for (const event of settledEvents) {
        const gameId = Number(event.args[0]);
        console.log(`[settler] GameSettled: gameId=${gameId}`);
      }

      // Retry pending activations
      for (const [gameId, info] of pendingActivations) {
        if (info.attempts > 30) {
          console.error(`[settler] Giving up on activation for game ${gameId}`);
          pendingActivations.delete(gameId);
          continue;
        }
        info.attempts++;
        try {
          const game = await settlement.getGame(gameId);
          if (Number(game.status) !== 0) {
            pendingActivations.delete(gameId);
            continue;
          }
          if (info.playerRandom) {
            await requestPythAndActivate(gameId, info.playerRandom);
          } else {
            const resp = await fetch(`${ENGINE_URL}/v3/sessions/${gameId}/player-random`);
            if (resp.ok) {
              const data = await resp.json();
              info.playerRandom = data.playerRandom;
              await requestPythAndActivate(gameId, data.playerRandom);
            }
          }
        } catch (err) {
          // Will retry next cycle
        }
      }

      // Settle finished games
      await checkAndSettle();

      lastProcessedBlock = currentBlock;
    } catch (err) {
      console.error("[settler] Polling error:", err.message);
    }
  }, 5000);
}

/**
 * Handle GameJoined event — fetch playerRandom, request Pyth, activate game.
 */
async function handleGameJoined(gameId) {
  try {
    // Fetch playerRandom from engine
    let playerRandom = null;
    for (let i = 0; i < 5; i++) {
      const resp = await fetch(`${ENGINE_URL}/v3/sessions/${gameId}/player-random`);
      if (resp.ok) {
        const data = await resp.json();
        playerRandom = data.playerRandom;
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!playerRandom) {
      console.log(`[settler] No playerRandom for game ${gameId} yet, will retry`);
      pendingActivations.set(gameId, { playerRandom: null, attempts: 0 });
      return;
    }

    await requestPythAndActivate(gameId, playerRandom);
  } catch (err) {
    console.error(`[settler] handleGameJoined error:`, err.message);
    pendingActivations.set(gameId, { playerRandom: null, attempts: 0 });
  }
}

/**
 * Handle GameActivated event — notify engine to create session.
 */
async function handleGameActivated(gameId, pythRandomNumber) {
  try {
    const game = await settlement.getGame(gameId);
    const gameData = {
      host: game.host,
      player: game.player,
      difficulty: Number(game.difficulty),
      prizePot: game.prizePot.toString(),
      maxSpend: game.maxSpend.toString(),
      pythRandom: pythRandomNumber,
      playerCommitment: game.playerCommitment,
    };

    const resp = await fetch(`${ENGINE_URL}/v3/sessions/${gameId}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gameData),
    });

    if (resp.ok) {
      console.log(`[settler] Engine session activated for game ${gameId}`);
      pendingActivations.delete(gameId);
    } else {
      const err = await resp.text();
      console.error(`[settler] Engine activation failed for game ${gameId}: ${err}`);
    }
  } catch (err) {
    console.error(`[settler] handleGameActivated error:`, err.message);
  }
}

/**
 * Request Pyth Entropy randomness and call activateGame with the sequence number.
 * The contract verifies the randomness on-chain — settler can't fake it.
 */
async function requestPythAndActivate(gameId, playerRandom) {
  console.log(`[settler] Requesting Pyth randomness for game ${gameId}...`);

  // 1. Get the current Pyth fee
  const fee = await randomness.getFee();
  console.log(`[settler] Pyth fee: ${ethers.formatEther(fee)} ETH`);

  // 2. Request randomness from ChancyRandomness
  const requestTx = await randomness.request(playerRandom, { value: fee });
  const requestReceipt = await requestTx.wait();
  console.log(`[settler] Pyth request tx: ${requestTx.hash}`);

  // 3. Parse the sequence number from RandomnessRequested event
  let sequenceNumber = null;
  for (const log of requestReceipt.logs) {
    try {
      const parsed = randomness.interface.parseLog(log);
      if (parsed && parsed.name === "RandomnessRequested") {
        sequenceNumber = parsed.args.sequenceNumber;
        break;
      }
    } catch {}
  }

  if (sequenceNumber === null) {
    throw new Error("Failed to extract sequenceNumber from Pyth request receipt");
  }

  console.log(`[settler] Pyth sequence: ${sequenceNumber} for game ${gameId}`);
  pendingActivations.set(gameId, { seq: sequenceNumber, attempts: 0 });

  // 4. Wait for Pyth callback to resolve (usually 1-5 seconds)
  let resolved = false;
  for (let i = 0; i < 30; i++) {
    const req = await randomness.getRequest(sequenceNumber);
    if (req.resolved) {
      resolved = true;
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!resolved) {
    console.error(`[settler] Pyth randomness not resolved for seq ${sequenceNumber}`);
    return;
  }

  console.log(`[settler] Pyth resolved for seq ${sequenceNumber}, activating game ${gameId}...`);

  // 5. Call activateGame with ONLY the sequence number
  //    The contract reads the verified random from ChancyRandomness itself.
  const activateTx = await settlement.activateGame(gameId, sequenceNumber);
  await activateTx.wait();
  console.log(`[settler] activateGame tx confirmed: ${activateTx.hash}`);

  // GameActivated event fires → the handler above notifies the engine
}

async function checkAndSettle() {
  const resp = await fetch(`${ENGINE_URL}/v3/sessions/finished`);
  if (!resp.ok) return;
  const { sessions } = await resp.json();
  if (!sessions || sessions.length === 0) return;

  for (const s of sessions) {
    const game = await settlement.getGame(s.gameId);
    if (Number(game.status) !== 1) continue; // Only settle Active games (status=1)

    const settleResp = await fetch(`${ENGINE_URL}/v3/sessions/${s.gameId}/settlement`);
    if (!settleResp.ok) continue;
    const settleData = await settleResp.json();

    console.log(`[settler] Settling game ${s.gameId}: outcome=${settleData.outcome}`);

    try {
      const outcomeVal = outcomeEnum[settleData.outcome];
      if (!outcomeVal) {
        console.error(`[settler] Invalid outcome: ${settleData.outcome}`);
        continue;
      }

      const tx = await settlement.settleGame(
        s.gameId,
        settleData.hostSecret,
        settleData.clicks,
        outcomeVal
      );
      console.log(`[settler] settleGame tx: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`[settler] Game ${s.gameId} settled in block ${receipt.blockNumber}`);
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
