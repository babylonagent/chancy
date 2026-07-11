"use strict";

/**
 * Chancy V3 Delegated Operations
 *
 * Handles gasless create/join by telling the settler bot to call
 * createGameFor() / joinGameFor() on-chain on behalf of the user.
 *
 * The user never signs a transaction — they just POST to the API.
 */

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// ── Config ──────────────────────────────────────────────────────────────────
const SETTLEMENT_ADDRESS = process.env.CHANCY_V3_SETTLEMENT_ADDRESS;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://mainnet.base.org";
const SETTLER_KEY = process.env.SANDBOX_WALLET_PRIVATE_KEY || process.env.SETTLER_PRIVATE_KEY;

if (!SETTLEMENT_ADDRESS) throw new Error("CHANCY_V3_SETTLEMENT_ADDRESS not set");
if (!SETTLER_KEY) throw new Error("SETTLER_PRIVATE_KEY or SANDBOX_WALLET_PRIVATE_KEY not set");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const settler = new ethers.Wallet(
  SETTLER_KEY.startsWith("0x") ? SETTLER_KEY : "0x" + SETTLER_KEY,
  provider
);

// Load artifact
const artifactPath = fs.existsSync(path.join(__dirname, "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json"))
  ? path.join(__dirname, "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json")
  : path.join(__dirname, "..", "artifacts", "contracts", "ChancySettlementV3.sol", "ChancySettlementV3.json");

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const contract = new ethers.Contract(SETTLEMENT_ADDRESS, artifact.abi, settler);

// Difficulty mapping
const Difficulty = { Easy: 0, Normal: 1, Hardcore: 2 };

/**
 * Create a game on behalf of a host (gasless for the host).
 * @param {string} host - Host wallet address
 * @param {number} difficulty - 0=Easy, 1=Normal, 2=Hardcore
 * @param {string} prizePot - USDC amount in 6-decimal units (string)
 * @param {string} hostSecret - 32-byte hex string
 * @returns {Promise<{gameId: string, txHash: string}>}
 */
async function createGameForHost(host, difficulty, prizePot, hostSecret) {
  const hostCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [hostSecret]));
  const pot = BigInt(prizePot);

  console.log(`[delegated] createGameFor host=${host} diff=${difficulty} pot=${pot}`);

  // Check host has enough balance on-chain
  const balance = await contract.balances(host);
  if (balance < pot) {
    throw new Error(`INSUFFICIENT_BALANCE: host has ${balance}, needs ${pot}`);
  }

  const tx = await contract.createGameFor(host, difficulty, pot, hostCommitment);
  console.log(`[delegated] createGameFor tx: ${tx.hash}`);
  const receipt = await tx.wait();

  // Parse GameCreated event for gameId
  let gameId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "GameCreated") {
        gameId = parsed.args.gameId.toString();
        break;
      }
    } catch {}
  }

  if (!gameId) throw new Error("GameCreated event not found");
  console.log(`[delegated] Game created: gameId=${gameId}`);
  return { gameId, txHash: tx.hash };
}

/**
 * Join a game on behalf of a player (gasless for the player).
 * @param {string} gameId - Game ID
 * @param {string} player - Player wallet address
 * @param {string} maxSpend - Max USDC to spend (6-decimal string)
 * @param {string} playerRandom - 32-byte hex random value
 * @returns {Promise<{txHash: string}>}
 */
async function joinGameForPlayer(gameId, player, maxSpend, playerRandom) {
  const playerCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [playerRandom]));
  const spend = BigInt(maxSpend);

  console.log(`[delegated] joinGameFor game=${gameId} player=${player} maxSpend=${spend}`);

  const balance = await contract.balances(player);
  if (balance < spend) {
    throw new Error(`INSUFFICIENT_BALANCE: player has ${balance}, needs ${spend}`);
  }

  const tx = await contract.joinGameFor(Number(gameId), player, playerCommitment, spend);
  console.log(`[delegated] joinGameFor tx: ${tx.hash}`);
  await tx.wait();
  console.log(`[delegated] Player joined game ${gameId}`);

  // Now activate the game (settler calls activateGame)
  // Generate pythRandom from playerRandom + block entropy
  const block = await provider.getBlock();
  const pythRandom = ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "uint256"],
    [playerRandom, block.timestamp]
  ));

  const activateTx = await contract.activateGame(Number(gameId), pythRandom);
  console.log(`[delegated] activateGame tx: ${activateTx.hash}`);
  await activateTx.wait();
  console.log(`[delegated] Game ${gameId} activated`);

  return { txHash: tx.hash, pythRandom };
}

/**
 * Withdraw on behalf of a user (gasless).
 * @param {string} user - User wallet address
 * @param {string} amount - USDC amount (6-decimal string)
 * @returns {Promise<{txHash: string}>}
 */
async function withdrawForUser(user, amount) {
  const amt = BigInt(amount);
  console.log(`[delegated] withdrawFor user=${user} amount=${amt}`);

  const tx = await contract.withdrawFor(user, amt);
  console.log(`[delegated] withdrawFor tx: ${tx.hash}`);
  await tx.wait();
  console.log(`[delegated] Withdrawal complete for ${user}`);
  return { txHash: tx.hash };
}

module.exports = { createGameForHost, joinGameForPlayer, withdrawForUser, contract, settler };
