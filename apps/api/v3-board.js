"use strict";

/**
 * Chancy V3 Board Derivation — JS implementation.
 *
 * MUST produce identical output to ChancySettlementV3.sol _deriveBoard().
 *
 * Solidity uses: keccak256(abi.encodePacked(boardSeed, "B", nonce))
 * JS uses:       keccak256(toHex(boardSeed) + toHex("B") + toHex(nonce))
 *
 * The key is matching abi.encodePacked byte-for-byte:
 *   - bytes32 boardSeed → 32 bytes
 *   - string "B" or "P" → 1 byte each (ASCII)
 *   - uint256 nonce → 32 bytes (big-endian)
 */
const { keccak256, encodePacked } = require("viem");

const BOARD_SIZE = 36;

const modeConfig = {
  Easy:     { bombs: 3, prizes: 3, startBps: 150,  capBps: 15000 },
  Normal:   { bombs: 4, prizes: 2, startBps: 250,  capBps: 20000 },
  Hardcore: { bombs: 6, prizes: 1, startBps: 350,  capBps: 25000 },
};

const difficultyMap = { Easy: 0, Normal: 1, Hardcore: 2 };

/**
 * Derive bomb and prize positions from a board seed.
 * Mirrors ChancySettlementV3._deriveBoard exactly.
 *
 * @param {string|Buffer} boardSeed - 32-byte board seed (hex string or Buffer)
 * @param {string} mode - "Easy" | "Normal" | "Hardcore"
 * @returns {{ bombPositions: number[], prizePositions: number[] }}
 */
function deriveBoardV3(boardSeed, mode) {
  const cfg = modeConfig[mode];
  if (!cfg) throw new Error("INVALID_MODE");

  // Normalize boardSeed to hex string
  const seedHex = typeof boardSeed === "string"
    ? boardSeed
    : "0x" + boardSeed.toString("hex");

  let bombMask = 0n;
  let prizeMask = 0n;

  // Place bombs — matching Solidity: keccak256(abi.encodePacked(boardSeed, "B", nonce))
  let placed = 0;
  let nonce = 0n;
  while (placed < cfg.bombs) {
    const hash = keccak256(encodePacked(
      ["bytes32", "string", "uint256"],
      [seedHex, "B", nonce]
    ));
    const tile = BigInt(hash) % BigInt(BOARD_SIZE);
    const bit = 1n << tile;
    if ((bombMask & bit) === 0n) {
      bombMask |= bit;
      placed++;
    }
    nonce++;
  }

  // Place prizes — matching Solidity: keccak256(abi.encodePacked(boardSeed, "P", nonce))
  placed = 0;
  nonce = 0n;
  while (placed < cfg.prizes) {
    const hash = keccak256(encodePacked(
      ["bytes32", "string", "uint256"],
      [seedHex, "P", nonce]
    ));
    const tile = BigInt(hash) % BigInt(BOARD_SIZE);
    const bit = 1n << tile;
    if ((bombMask & bit) === 0n && (prizeMask & bit) === 0n) {
      prizeMask |= bit;
      placed++;
    }
    nonce++;
  }

  // Extract positions from bitmask
  const bombPositions = [];
  const prizePositions = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    if ((bombMask & (1n << BigInt(i))) !== 0n) bombPositions.push(i);
    if ((prizeMask & (1n << BigInt(i))) !== 0n) prizePositions.push(i);
  }

  return { bombPositions, prizePositions };
}

/**
 * Compute the board seed from on-chain inputs.
 * boardSeed = keccak256(abi.encodePacked(pythRandomNumber, hostSecret, gameId))
 *
 * Matches Solidity: keccak256(abi.encodePacked(game.pythRandomNumber, hostSecret, gameId))
 *
 * @param {string} pythRandomNumber - bytes32 hex
 * @param {string} hostSecret - bytes32 hex
 * @param {string|number|bigint} gameId - uint256
 * @returns {string} bytes32 hex
 */
function computeBoardSeed(pythRandomNumber, hostSecret, gameId, playerCommitment) {
  if (playerCommitment) {
    return keccak256(encodePacked(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [pythRandomNumber, hostSecret, playerCommitment, BigInt(gameId)]
    ));
  }
  // Backward-compatible fallback (no playerCommitment provided)
  return keccak256(encodePacked(
    ["bytes32", "bytes32", "uint256"],
    [pythRandomNumber, hostSecret, BigInt(gameId)]
  ));
}

/**
 * Compute host commitment from host secret.
 * hostCommitment = keccak256(abi.encodePacked(hostSecret))
 *
 * @param {string} hostSecret - bytes32 hex
 * @returns {string} bytes32 hex
 */
function computeHostCommitment(hostSecret) {
  return keccak256(encodePacked(["bytes32"], [hostSecret]));
}

/**
 * Progressive per-tile reveal cost.
 * Matches Solidity _revealCostAt exactly.
 *
 * @param {string|bigint} prizePot - 6-decimal USDC amount
 * @param {string} mode - "Easy" | "Normal" | "Hardcore"
 * @param {number} revealIndex - 0-based index (0 for first click, etc.)
 * @returns {bigint} cost in USDC units (6 decimals)
 */
function revealCostAt(prizePot, mode, revealIndex) {
  const cfg = modeConfig[mode];
  if (!cfg) throw new Error("INVALID_MODE");
  const baseTotalBps = cfg.startBps * BOARD_SIZE;
  const stepBps = cfg.capBps > baseTotalBps
    ? Math.floor((cfg.capBps - baseTotalBps) * 2 / (BOARD_SIZE * (BOARD_SIZE - 1)))
    : 0;
  const costBps = cfg.startBps + stepBps * revealIndex;
  return BigInt(prizePot) * BigInt(costBps) / 10000n;
}

module.exports = {
  deriveBoardV3,
  computeBoardSeed,
  computeHostCommitment,
  revealCostAt,
  modeConfig,
  BOARD_SIZE,
  difficultyMap,
};