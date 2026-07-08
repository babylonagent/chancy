"use strict";

/**
 * Chancy V3 Engine — Off-chain game state ONLY.
 * No money, no balances, no deposits, no withdrawals.
 * Money is handled by ChancySettlementV3 contract on-chain.
 *
 * This engine:
 *   - Derives boards (using v3-board.js, keccak256 for Solidity parity)
 *   - Tracks clicks per session
 *   - Provides game state to frontend
 *   - Feeds click data to the settler bot for settlement
 */

const express = require("express");
const crypto = require("crypto");
const { keccak256, encodePacked, bytesToHex, hexToBytes } = require("viem");
const { deriveBoardV3, computeBoardSeed, computeHostCommitment, revealCostAt, modeConfig } = require("./v3-board");

// ── Session Storage ─────────────────────────────────────────────────────────
// In-memory only. No SQLite. No persistence needed — if the engine crashes,
// the contract still has the escrowed funds and the 24h timeout refunds everyone.
// The settler bot can re-derive the board from on-chain data.
const sessions = new Map();

// ── Constants ────────────────────────────────────────────────────────────────
const BOARD_SIZE = 36;
const BOMBS_TO_GAME_OVER = 3;

// ── Session Structure ───────────────────────────────────────────────────────
function createSession(gameId, host, player, difficulty, prizePot, maxSpend, hostSecret, pythRandom) {
  const mode = difficulty === 0 ? "Easy" : difficulty === 1 ? "Normal" : "Hardcore";
  const boardSeed = computeBoardSeed(pythRandom, hostSecret, gameId);
  const board = deriveBoardV3(boardSeed, mode);

  const session = {
    gameId,
    host,
    player,
    difficulty: mode,
    prizePot: BigInt(prizePot),
    maxSpend: BigInt(maxSpend),
    hostSecret,
    pythRandom,
    board,
    clicks: [],
    bombsHit: 0,
    prizesFound: 0,
    clickedMask: 0n,
    spent: 0n,
    status: "active",
    outcome: null,
    createdAt: Date.now(),
    activatedAt: Date.now(),
  };

  sessions.set(gameId, session);
  console.log(`[v3-engine] Session ${gameId} activated: ${mode} mode, pot=${prizePot}, maxSpend=${maxSpend}`);
  console.log(`[v3-engine] Board: ${board.bombPositions.length} bombs, ${board.prizePositions.length} prizes`);
  return session;
}

// ── Click Processing ────────────────────────────────────────────────────────
function processClick(gameId, player, tileIndex) {
  const session = sessions.get(gameId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.status !== "active") throw new Error("SESSION_NOT_ACTIVE");
  if (session.player.toLowerCase() !== player.toLowerCase()) throw new Error("NOT_YOUR_SESSION");

  if (tileIndex < 0 || tileIndex >= BOARD_SIZE) throw new Error("INVALID_TILE");
  const bit = 1n << BigInt(tileIndex);
  if ((session.clickedMask & bit) !== 0n) throw new Error("TILE_ALREADY_CLICKED");

  // Record click
  session.clicks.push(tileIndex);
  session.clickedMask |= bit;

  // Calculate cost
  const cost = revealCostAt(session.prizePot, session.difficulty, session.clicks.length - 1);
  session.spent += cost;

  // Check if bomb
  if (session.board.bombPositions.includes(tileIndex)) {
    session.bombsHit++;
    if (session.bombsHit >= BOMBS_TO_GAME_OVER) {
      session.status = "finished";
      session.outcome = "loss";
      return {
        tile: tileIndex,
        type: "bomb",
        bombsHit: session.bombsHit,
        spent: session.spent.toString(),
        gameOver: true,
        outcome: "loss",
      };
    }
    return {
      tile: tileIndex,
      type: "bomb",
      bombsHit: session.bombsHit,
      spent: session.spent.toString(),
      gameOver: false,
    };
  }

  // Check if prize
  if (session.board.prizePositions.includes(tileIndex)) {
    session.prizesFound++;
    const totalPrizes = modeConfig[session.difficulty].prizes;
    if (session.prizesFound >= totalPrizes) {
      session.status = "finished";
      session.outcome = "win";
      return {
        tile: tileIndex,
        type: "prize",
        prizesFound: session.prizesFound,
        totalPrizes,
        spent: session.spent.toString(),
        gameOver: true,
        outcome: "win",
      };
    }
    return {
      tile: tileIndex,
      type: "prize",
      prizesFound: session.prizesFound,
      totalPrizes,
      spent: session.spent.toString(),
      gameOver: false,
    };
  }

  // Empty tile
  return {
    tile: tileIndex,
    type: "empty",
    spent: session.spent.toString(),
    gameOver: false,
  };
}

function quitSession(gameId, player) {
  const session = sessions.get(gameId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.player.toLowerCase() !== player.toLowerCase()) throw new Error("NOT_YOUR_SESSION");
  if (session.status !== "active") throw new Error("SESSION_NOT_ACTIVE");

  session.status = "finished";
  session.outcome = "quit";
  return { outcome: "quit", spent: session.spent.toString() };
}

function getSessionState(gameId) {
  const session = sessions.get(gameId);
  if (!session) return null;

  return {
    gameId: session.gameId,
    host: session.host,
    player: session.player,
    difficulty: session.difficulty,
    prizePot: session.prizePot.toString(),
    maxSpend: session.maxSpend.toString(),
    status: session.status,
    outcome: session.outcome,
    clicks: session.clicks,
    bombsHit: session.bombsHit,
    prizesFound: session.prizesFound,
    spent: session.spent.toString(),
    // Don't expose bomb/prize positions to frontend (only to settler bot)
    bombPositions: session.status === "finished" ? session.board.bombPositions : undefined,
    prizePositions: session.status === "finished" ? session.board.prizePositions : undefined,
  };
}

function getSettlementData(gameId) {
  const session = sessions.get(gameId);
  if (!session) return null;
  if (session.status !== "finished") return null;

  return {
    gameId: session.gameId,
    hostSecret: session.hostSecret,
    clicks: session.clicks,
    outcome: session.outcome, // "win", "loss", "quit"
    spent: session.spent.toString(),
  };
}

// ── API Routes ──────────────────────────────────────────────────────────────
function installV3Routes(app) {
  const router = express.Router();

  // Activate session (called by settler bot after on-chain activateGame)
  router.post("/v3/sessions/:gameId/activate", (req, res) => {
    const { gameId } = req.params;
    const { host, player, difficulty, prizePot, maxSpend, hostSecret, pythRandom } = req.body;

    if (!host || !player || difficulty === undefined || !hostSecret || !pythRandom) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    if (sessions.has(gameId)) {
      return res.status(409).json({ error: "SESSION_ALREADY_ACTIVE" });
    }

    try {
      const session = createSession(
        Number(gameId),
        host,
        player,
        Number(difficulty),
        BigInt(prizePot),
        BigInt(maxSpend),
        hostSecret,
        pythRandom
      );
      res.json({ ok: true, gameId: Number(gameId) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Click a tile
  router.post("/v3/sessions/:gameId/click", (req, res) => {
    const { gameId } = req.params;
    const { player, tile } = req.body;

    if (!player || tile === undefined) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    try {
      const result = processClick(Number(gameId), player, Number(tile));
      res.json(result);
    } catch (err) {
      const code = err.message.includes("NOT_YOUR") ? 403 :
                   err.message.includes("NOT_ACTIVE") ? 409 :
                   err.message.includes("NOT_FOUND") ? 404 : 400;
      res.status(code).json({ error: err.message });
    }
  });

  // Quit session
  router.post("/v3/sessions/:gameId/quit", (req, res) => {
    const { gameId } = req.params;
    const { player } = req.body;

    if (!player) return res.status(400).json({ error: "MISSING_FIELDS" });

    try {
      const result = quitSession(Number(gameId), player);
      res.json(result);
    } catch (err) {
      const code = err.message.includes("NOT_FOUND") ? 404 : 400;
      res.status(code).json({ error: err.message });
    }
  });

  // Get session state (frontend polls this)
  router.get("/v3/sessions/:gameId/state", (req, res) => {
    const { gameId } = req.params;
    const state = getSessionState(Number(gameId));
    if (!state) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    res.json(state);
  });

  // Get settlement data (settler bot calls this)
  router.get("/v3/sessions/:gameId/settlement", (req, res) => {
    const { gameId } = req.params;
    const data = getSettlementData(Number(gameId));
    if (!data) return res.status(404).json({ error: "NOT_READY_FOR_SETTLEMENT" });
    res.json(data);
  });

  // List active sessions (for lobby view — supplements on-chain events)
  router.get("/v3/sessions", (req, res) => {
    const list = [];
    for (const [id, s] of sessions) {
      if (s.status === "active") {
        list.push({
          gameId: s.gameId,
          host: s.host,
          player: s.player,
          difficulty: s.difficulty,
          prizePot: s.prizePot.toString(),
          status: s.status,
        });
      }
    }
    res.json({ sessions: list });
  });

  app.use(router);
  console.log("[v3-engine] Routes installed at /v3/*");
}

module.exports = {
  installV3Routes,
  createSession,
  processClick,
  quitSession,
  getSessionState,
  getSettlementData,
  sessions,
};