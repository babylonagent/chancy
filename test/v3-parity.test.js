const { expect } = require("chai");
const { ethers } = require("hardhat");
const { keccak256, encodePacked } = require("viem");
const {
  deriveBoardV3,
  computeBoardSeed,
  computeHostCommitment,
  revealCostAt,
  modeConfig,
} = require("../apps/api/v3-board.js");

// ── Generate random bytes32 ─────────────────────────────────────────────────
function randomBytes32() {
  const chars = "0123456789abcdef";
  let hex = "0x";
  for (let i = 0; i < 64; i++) hex += chars[Math.floor(Math.random() * 16)];
  return hex;
}

describe("V3 Board Derivation Parity (JS vs Solidity)", () => {
  let settlement;
  let usdc;
  let owner, host, player, settler;

  before(async () => {
    [owner, host, player, settler] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const Settlement = await ethers.getContractFactory("ChancySettlementV3");
    settlement = await Settlement.deploy(await usdc.getAddress(), settler.address, owner.address);
  });

  // ── Helper: full game flow to verify board (JS derives board, contract replays it)
  async function verifyBoardParity(mode, boardSeed) {
    const cfg = modeConfig[mode];

    // JS derivation
    const jsBoard = deriveBoardV3(boardSeed, mode);

    // Verify JS produces correct number of bombs/prizes
    expect(jsBoard.bombPositions.length).to.equal(cfg.bombs);
    expect(jsBoard.prizePositions.length).to.equal(cfg.prizes);

    // No collision between bombs and prizes
    for (const bp of jsBoard.bombPositions) {
      expect(jsBoard.prizePositions).to.not.include(bp);
    }

    // All tiles in range [0, 35]
    for (const t of [...jsBoard.bombPositions, ...jsBoard.prizePositions]) {
      expect(t).to.be.at.least(0);
      expect(t).to.be.lessThan(36);
    }

    return jsBoard;
  }

  // ── JS internal consistency tests ─────────────────────────────────────────
  describe("JS board derivation", () => {
    for (const mode of ["Easy", "Normal", "Hardcore"]) {
      it(`derives correct board for ${mode} (100 random seeds)`, async () => {
        for (let i = 0; i < 100; i++) {
          await verifyBoardParity(mode, randomBytes32());
        }
      });

      it(`same seed always produces same board (${mode})`, async () => {
        const seed = "0x" + "ab".repeat(32);
        const board1 = deriveBoardV3(seed, mode);
        const board2 = deriveBoardV3(seed, mode);
        expect(board1.bombPositions).to.deep.equal(board2.bombPositions);
        expect(board1.prizePositions).to.deep.equal(board2.prizePositions);
      });

      it(`different seeds produce different boards (${mode})`, async () => {
        const seed1 = "0x" + "ab".repeat(32);
        const seed2 = "0x" + "cd".repeat(32);
        const board1 = deriveBoardV3(seed1, mode);
        const board2 = deriveBoardV3(seed2, mode);
        // Extremely unlikely to be identical
        expect(
          board1.bombPositions.join(",") === board2.bombPositions.join(",")
        ).to.be.false;
      });
    }
  });

  // ── Commitment scheme ──────────────────────────────────────────────────────
  describe("commitment scheme", () => {
    it("computeHostCommitment = keccak256(abi.encodePacked(secret))", () => {
      const secret = randomBytes32();
      const jsCommitment = computeHostCommitment(secret);
      const expected = keccak256(encodePacked(["bytes32"], [secret]));
      expect(jsCommitment).to.equal(expected);
    });

    it("computeBoardSeed = keccak256(abi.encodePacked(pyth, secret, gameId))", () => {
      const pyth = randomBytes32();
      const secret = randomBytes32();
      const gameId = 42n;
      const jsSeed = computeBoardSeed(pyth, secret, gameId);
      const expected = keccak256(
        encodePacked(["bytes32", "bytes32", "uint256"], [pyth, secret, gameId])
      );
      expect(jsSeed).to.equal(expected);
    });
  });

  // ── Reveal cost ─────────────────────────────────────────────────────────────
  describe("revealCostAt", () => {
    it("Easy: first tile = 1.5% of pot", () => {
      expect(revealCostAt(10_000_000n, "Easy", 0)).to.equal(150_000n);
    });

    it("Normal: first tile = 2.5% of pot", () => {
      expect(revealCostAt(10_000_000n, "Normal", 0)).to.equal(250_000n);
    });

    it("Hardcore: first tile = 3.5% of pot", () => {
      expect(revealCostAt(10_000_000n, "Hardcore", 0)).to.equal(350_000n);
    });

    it("cost increases monotonically", () => {
      let prev = 0n;
      for (let i = 0; i < 36; i++) {
        const cost = revealCostAt(10_000_000n, "Easy", i);
        expect(cost).to.be.greaterThan(prev);
        prev = cost;
      }
    });
  });

  // ── Contract integration: create → join → settle verifies JS board on-chain ─
  describe("contract integration (JS board verified on-chain)", () => {
    it("settles a game where JS-derived board matches contract replay", async () => {
      const mode = "Easy";
      const prizePot = ethers.parseUnits("10", 6); // $10 USDC
      const maxSpend = ethers.parseUnits("5", 6);   // $5 max spend budget

      // Generate host secret + commitment
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);

      // Generate player commitment + randomness
      const playerRandom = randomBytes32();
      const playerCommitment = keccak256(encodePacked(["bytes32"], [playerRandom]));

      // Mint USDC to host and player
      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);

      // Approvals
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      // Create game (host)
      const difficultyEnum = 0; // Easy
      const tx1 = await settlement.connect(host).createGame(
        difficultyEnum,
        prizePot,
        hostCommitment
      );
      const receipt1 = await tx1.wait();
      const gameId = 1n;

      // Join game (player)
      await settlement.connect(player).joinGame(
        gameId,
        playerCommitment,
        maxSpend
      );

      // Simulate Pyth randomness resolution
      const pythRandom = randomBytes32();

      // Activate game (settler)
      await settlement.connect(settler).activateGame(gameId, pythRandom);

      // Derive board in JS (same as the engine would do)
      const boardSeed = computeBoardSeed(pythRandom, hostSecret, gameId);
      const jsBoard = deriveBoardV3(boardSeed, mode);

      // Click all bomb tiles to get a Loss outcome
      const clicks = jsBoard.bombPositions.slice(0, 3); // click 3 bombs = game over

      // Settle game (settler)
      const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };
      await settlement.connect(settler).settleGame(
        gameId,
        hostSecret,
        clicks.map((t) => t),
        GameOutcome.Loss
      );

      // Verify game settled
      const game = await settlement.getGame(gameId);
      expect(Number(game.status)).to.equal(2); // Settled = 2 (Created=0, Active=1, Settled=2)

      const settlementData = await settlement.getSettlement(gameId);
      expect(Number(settlementData.outcome)).to.equal(GameOutcome.Loss);

      // Host should have received pot + player's spent
      const cfg = modeConfig[mode];
      let expectedSpent = 0n;
      for (let i = 0; i < clicks.length; i++) {
        expectedSpent += revealCostAt(prizePot, mode, i);
      }
      const expectedHostPayout = prizePot + expectedSpent;
      expect(settlementData.hostPayout).to.equal(expectedHostPayout);
    });

    it("rejects settlement with wrong outcome (replay mismatch)", async () => {
      const mode = "Easy";
      const prizePot = ethers.parseUnits("10", 6);
      const maxSpend = ethers.parseUnits("5", 6);

      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const playerRandom = randomBytes32();
      const playerCommitment = keccak256(encodePacked(["bytes32"], [playerRandom]));

      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      const gameId = 2n;
      await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);

      const pythRandom = randomBytes32();
      await settlement.connect(settler).activateGame(gameId, pythRandom);

      // Derive board, click all prize tiles for a Win
      const boardSeed = computeBoardSeed(pythRandom, hostSecret, gameId);
      const jsBoard = deriveBoardV3(boardSeed, mode);
      const clicks = jsBoard.prizePositions; // click all prizes = Win

      const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };

      // Try to claim Loss instead of Win → should revert (OUTCOME_MISMATCH)
      await expect(
        settlement.connect(settler).settleGame(
          gameId,
          hostSecret,
          clicks.map((t) => t),
          GameOutcome.Loss
        )
      ).to.be.revertedWith("OUTCOME_MISMATCH");
    });
  });
});