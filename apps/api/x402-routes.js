/**
 * Chancy x402 Payment Integration
 *
 * Adds pay-per-action endpoints alongside the existing credit-based ones.
 * Agents don't need to pre-fund — they pay USDC per request via HTTP 402.
 *
 * x402 endpoints (parallel to credit-based):
 *   POST /v2/x402/sessions/:sessionId/join    — pay entrance fee via x402
 *   POST /v2/x402/sessions/:sessionId/click   — pay per tile reveal via x402
 *   POST /v2/x402/sessions/create             — host funds prize pot via x402
 *   GET  /v2/x402/sessions                    — list open sessions (free)
 *   GET  /v2/x402/sessions/:sessionId         — session detail (free)
 *   GET  /v2/x402/credits/:player             — check x402 prize balance (free)
 *
 * Flow:
 *   1. Agent calls POST /v2/x402/sessions/:id/click { player, tile }
 *   2. Server returns 402 with payment requirements (amount = next tile cost)
 *   3. Agent signs EIP-3009 USDC payment, sends PAYMENT-SIGNATURE header
 *   4. Server verifies via facilitator, calls game handler
 *   5. Game handler skips credit debit (x402 already collected)
 *   6. Middleware settles payment → USDC goes to receiving wallet
 *   7. Agent gets tile result (bomb/prize/empty)
 *
 * Prize earnings from x402 games are credited to internal balance for withdrawal.
 */

const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { z } = require("zod");

const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const COINBASE_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
const TESTNET_FACILITATOR = "https://x402.org/facilitator";

// CDP JWT auth
const { createCDPAuthHeaders } = require("./cdp-auth");

/**
 * Create x402 middleware + route handlers for Chancy.
 *
 * @param {object} opts
 * @param {string} opts.receivingWallet — wallet receiving x402 payments
 * @param {object} opts.store — Chancy v2 store
 * @param {function} opts.revealCostAt — (prizePot, mode, revealIndex) → bigint
 * @param {function} opts.modeConfig — Chancy mode config
 * @param {boolean} opts.testnet — use testnet facilitator
 * @param {function} opts.persist — persist store function
 * @returns {{ middleware: function, installX402Routes: function }}
 */
function createChancyX402({
  receivingWallet,
  store,
  revealCostAt,
  modeConfig,
  testnet = false,
  persist = () => {},
  cdpKeyName = "",
  cdpPrivateKey = "",
}) {
  const network = testnet ? BASE_SEPOLIA : BASE_MAINNET;
  const facilitatorUrl = testnet ? TESTNET_FACILITATOR : COINBASE_FACILITATOR;

  // Build facilitator config — add CDP auth for mainnet
  const facilitatorConfig = { url: facilitatorUrl };
  if (!testnet && cdpKeyName && cdpPrivateKey) {
    facilitatorConfig.createAuthHeaders = createCDPAuthHeaders(cdpKeyName, cdpPrivateKey);
  }
  const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    network,
    new ExactEvmScheme(),
  );

  // Convert raw USDC units (6 decimals) to x402 price string
  function usdcToPrice(rawUnits) {
    const dollars = Number(rawUnits) / 1e6;
    return `$${dollars.toFixed(6)}`;
  }

  // Extract sessionId from path: /v2/x402/sessions/:sessionId/click
  function extractSessionId(path) {
    const parts = path.split("/");
    const idx = parts.indexOf("sessions");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return null;
  }

  // Dynamic price: look up session, calculate next tile cost
  function dynamicTilePrice(context) {
    const body = context.adapter?.getBody?.() || {};
    const sid = extractSessionId(context.path) || body.sessionId;
    if (!sid) return "$0.01";

    const session = store.sessions.get(String(sid));
    if (!session || session.runStatus !== "active") return "$0.01";

    const revealIndex = session.clicked?.size || 0;
    const cost = revealCostAt(session.prizePot, session.mode, revealIndex);
    return usdcToPrice(cost.toString());
  }

  // Dynamic price: entrance fee
  function entranceFeePrice() {
    return "$0.05"; // 50_000 raw = $0.05
  }

  // Dynamic price: session creation (prize pot amount)
  function sessionCreatePrice(context) {
    const body = context.adapter?.getBody?.() || {};
    const pot = Number(body.prizePot || "5000000") / 1e6;
    return `$${pot.toFixed(2)}`;
  }

  // x402 route definitions
  const routes = {
    "POST /v2/x402/sessions/:sessionId/click": {
      accepts: { scheme: "exact", price: dynamicTilePrice, network, payTo: receivingWallet },
      description: "Chancy — reveal a tile (minesweeper on Base)",
      mimeType: "application/json",
    },
    "POST /v2/x402/sessions/:sessionId/join": {
      accepts: { scheme: "exact", price: entranceFeePrice, network, payTo: receivingWallet },
      description: "Chancy — join game session (entrance fee)",
      mimeType: "application/json",
    },
    "POST /v2/x402/sessions/create": {
      accepts: { scheme: "exact", price: sessionCreatePrice, network, payTo: receivingWallet },
      description: "Chancy — create game session (host funds prize pot)",
      mimeType: "application/json",
    },
  };

  const middleware = paymentMiddleware(routes, resourceServer);

  // ── x402 Game Route Handlers ──
  // These run AFTER x402 verification succeeds (middleware calls next()).
  // req.x402Paid is set by a pre-middleware flag to indicate x402 mode.

  const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
  const BOARD_SIZE = 64;
  const BOMBS_TO_GAME_OVER = 3;
  const ENTRANCE_FEE = 50_000n;

  function installX402Routes(app, deps) {
    const {
      getBalance,
      setBalance,
      generateCommitment,
      deriveBoard,
      boardCommitHash,
      computeCommitment,
      requestEntropy,
      prizePerTile,
      trackPlayer,
      recordRunEnd,
      resetRun,
      cleanupStaleSessions,
      MAX_CONCURRENT_SESSIONS,
      MIN_PRIZE_POT,
      MAX_PRIZE_POT,
    } = deps;

    // Flag middleware: marks x402 mode before x402 middleware runs
    app.use("/v2/x402", (req, _res, next) => {
      req.x402Mode = true;
      next();
    });

    // ── Free x402 endpoints (no payment needed) ──

    // List open sessions
    app.get("/v2/x402/sessions", (_req, res) => {
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
          x402Enabled: true,
          createdAt: s.createdAt,
        }));
      return res.json({ sessions: open, count: open.length, payment: "x402" });
    });

    // Session detail
    app.get("/v2/x402/sessions/:sessionId", (req, res) => {
      const session = store.sessions.get(req.params.sessionId);
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
        x402Enabled: true,
      });
    });

    // Check x402 prize balance
    app.get("/v2/x402/credits/:player", (req, res) => {
      const parsed = addressSchema.safeParse(req.params.player);
      if (!parsed.success) return res.status(400).json({ error: "INVALID_ADDRESS" });
      const balance = getBalance(store, parsed.data);
      return res.json({
        player: parsed.data,
        prizeBalance: balance.toString(),
        note: "Prize earnings from x402 games. Withdraw via /v2/withdrawals/request",
      });
    });

    // ── Paid x402 endpoints (payment collected by middleware) ──

    // HOST: Create session — prize pot paid via x402
    app.post("/v2/x402/sessions/create", (req, res) => {
      const parsed = z.object({
        host: addressSchema,
        mode: z.enum(["Easy", "Normal", "Hardcore"]),
        prizePot: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String),
      }).safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
      const { host, mode, prizePot } = parsed.data;
      const pot = BigInt(prizePot);

      if (pot < MIN_PRIZE_POT) return res.status(400).json({ error: "PRIZE_POT_TOO_LOW", min: MIN_PRIZE_POT.toString() });
      if (pot > MAX_PRIZE_POT) return res.status(400).json({ error: "PRIZE_POT_TOO_HIGH", max: MAX_PRIZE_POT.toString() });

      // x402 mode: don't check host's credit balance — they paid via x402
      // Just track the prize pot as session data
      cleanupStaleSessions(store, persist);

      const hostOpenCount = [...store.sessions.values()].filter(
        (s) => s.host.toLowerCase() === host.toLowerCase() && s.status === "open",
      ).length;
      if (hostOpenCount >= MAX_CONCURRENT_SESSIONS) {
        return res.status(429).json({ error: "TOO_MANY_OPEN_SESSIONS", max: MAX_CONCURRENT_SESSIONS });
      }

      const sessionId = String(store.nextSessionId++);
      // In x402 mode, credit host the prize pot (they paid via x402, so credit it back as spendable)
      setBalance(store, host, getBalance(store, host) + pot);

      const session = {
        sessionId, host, mode,
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
        cumulativeEarnings: "0",
        cumulativePlayers: 0,
        cumulativeRuns: 0,
        lastPlayedAt: null,
        x402: true, // mark as x402-funded session
      };
      store.sessions.set(sessionId, session);
      persist();
      return res.json({
        sessionId, host, mode,
        prizePot: pot.toString(),
        entranceFee: ENTRANCE_FEE.toString(),
        bombs: modeConfig[mode].bombs,
        prizes: modeConfig[mode].prizes,
        status: "open",
        payment: "x402",
      });
    });

    // PLAYER: Join session — entrance fee paid via x402
    app.post("/v2/x402/sessions/:sessionId/join", (req, res) => {
      const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
      const bodyParse = z.object({
        player: addressSchema,
        commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      }).safeParse(req.body || {});
      if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });

      const session = store.sessions.get(paramParse.data.sessionId);
      if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
      if (session.status !== "open") return res.status(409).json({ error: "SESSION_NOT_OPEN", status: session.status });
      if (bodyParse.data.player.toLowerCase() === session.host.toLowerCase()) return res.status(403).json({ error: "HOST_CANNOT_PLAY" });

      cleanupStaleSessions(store, persist);
      if (session.status !== "open") return res.status(409).json({ error: "SESSION_NOT_OPEN", status: session.status });

      const player = bodyParse.data.player;

      // x402 mode: entrance fee paid via x402, credit it to host's balance
      setBalance(store, session.host, getBalance(store, session.host) + ENTRANCE_FEE);

      session.activePlayer = player;
      session.commitment = bodyParse.data.commitment;
      session.commitExpiresAt = Date.now() + 120_000; // 2 min reveal timeout
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
        payment: "x402",
      });
    });

    // PLAYER: Reveal entropy (free — no payment needed, just triggers Pyth)
    app.post("/v2/x402/sessions/:sessionId/reveal", async (req, res) => {
      const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
      const bodyParse = z.object({
        player: addressSchema,
        entropy: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      }).safeParse(req.body || {});
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
        // Refund entrance fee, reopen
        setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + ENTRANCE_FEE);
        setBalance(store, session.host, getBalance(store, session.host) - ENTRANCE_FEE);
        session.entropyError = error.message || "ENTROPY_REQUEST_FAILED";
        session.runStatus = "failed";
        resetRun(session);
        persist();
        return res.status(503).json({ error: "ENTROPY_REQUEST_FAILED", message: session.entropyError, refunded: true });
      }

      const pythRandom = entropyResult.randomNumber;
      const board = deriveBoard({
        entropy: pythRandom,
        sessionId: session.sessionId,
        player: session.activePlayer,
        mode: session.mode,
      });
      const commit = boardCommitHash({
        entropy: pythRandom,
        sessionId: session.sessionId,
        player: session.activePlayer,
        mode: session.mode,
        board,
      });

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
        payment: "x402",
      });
    });

    // PLAYER: Click tile — tile cost paid via x402
    app.post("/v2/x402/sessions/:sessionId/click", (req, res) => {
      const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
      const bodyParse = z.object({
        player: addressSchema,
        tile: z.number().int(),
      }).safeParse(req.body || {});
      if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });

      const session = store.sessions.get(paramParse.data.sessionId);
      if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
      if (bodyParse.data.player.toLowerCase() !== session.activePlayer?.toLowerCase()) return res.status(403).json({ error: "NOT_ACTIVE_PLAYER" });

      const tile = Number(bodyParse.data.tile);
      if (!Number.isInteger(tile) || tile < 1 || tile > BOARD_SIZE) return res.status(400).json({ error: "INVALID_TILE" });
      if (session.clicked.has(tile)) return res.json(session.clicked.get(tile));
      if (session.runStatus !== "active") return res.status(409).json({ error: "SESSION_NOT_ACTIVE", status: session.runStatus });

      // x402 mode: payment already collected by middleware — skip credit debit
      // Just track the spent amount for game economics
      const revealIndex = session.clicked.size;
      const cost = revealCostAt(session.prizePot, session.mode, revealIndex);
      session.spentAmount = (BigInt(session.spentAmount) + cost).toString();
      session.lastActionAt = Date.now();

      let outcome = "empty";
      let prizeCredited = "0";

      if (session.board.bombPositions.includes(tile)) {
        outcome = "bomb";
        session.bombsHit += 1;
        if (session.bombsHit >= BOMBS_TO_GAME_OVER) {
          // Game over — host earns spent (already received via x402 payments)
          recordRunEnd(session, BigInt(session.spentAmount));
          session.runStatus = "lost";
          const result = {
            sessionId: session.sessionId, tile, outcome,
            bombsHit: session.bombsHit, prizesFound: session.prizesFound,
            status: "lost", runStatus: "lost",
            cost: cost.toString(), spentTotal: session.spentAmount,
            prizeEarned: session.prizeEarned,
            payment: "x402",
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
        // Prize credited to player's internal balance (withdrawable later)
        setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + prize);
        session.prizeEarned = (BigInt(session.prizeEarned) + prize).toString();
        prizeCredited = prize.toString();

        if (session.prizesFound >= modeConfig[session.mode].prizes) {
          // All prizes found — player wins
          recordRunEnd(session, BigInt(session.spentAmount));
          session.runStatus = "won";
          const result = {
            sessionId: session.sessionId, tile, outcome,
            bombsHit: session.bombsHit, prizesFound: session.prizesFound,
            status: "won", runStatus: "won",
            cost: cost.toString(), spentTotal: session.spentAmount,
            prizeEarned: session.prizeEarned, prizeCredited,
            payment: "x402",
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
        payment: "x402",
      };
      session.clicked.set(tile, result);
      persist();
      return res.json(result);
    });

    // PLAYER: Quit (free — just ends the run)
    app.post("/v2/x402/sessions/:sessionId/quit", (req, res) => {
      const paramParse = z.object({ sessionId: z.string().regex(/^\d+$/) }).safeParse(req.params || {});
      const bodyParse = z.object({ player: addressSchema }).safeParse(req.body || {});
      if (!paramParse.success || !bodyParse.success) return res.status(400).json({ error: "INVALID_REQUEST" });

      const session = store.sessions.get(paramParse.data.sessionId);
      if (!session) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
      if (bodyParse.data.player.toLowerCase() !== session.activePlayer?.toLowerCase()) return res.status(403).json({ error: "NOT_ACTIVE_PLAYER" });

      if (session.runStatus === "committed") {
        // Never revealed — refund entrance fee
        setBalance(store, session.activePlayer, getBalance(store, session.activePlayer) + ENTRANCE_FEE);
        setBalance(store, session.host, getBalance(store, session.host) - ENTRANCE_FEE);
        session.runStatus = "cancelled";
        const resp = { sessionId: session.sessionId, status: "cancelled", refunded: ENTRANCE_FEE.toString(), spentTotal: "0", prizeEarned: "0", payment: "x402" };
        resetRun(session);
        persist();
        return res.json(resp);
      }

      // Active → host already received payments via x402, player keeps prizes
      recordRunEnd(session, BigInt(session.spentAmount));
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
        payment: "x402",
      };
      resetRun(session);
      persist();
      return res.json(resp);
    });
  }

  return { middleware, installX402Routes };
}

module.exports = { createChancyX402, BASE_MAINNET, BASE_SEPOLIA };
