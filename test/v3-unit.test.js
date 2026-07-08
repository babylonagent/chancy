const { expect } = require("chai");
const hre = require("hardhat");
const ethers = hre.ethers;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deriveBoardV3,
  computeBoardSeed,
  computeHostCommitment,
  revealCostAt,
  modeConfig,
} = require("../apps/api/v3-board");

function randomBytes32() {
  const chars = "0123456789abcdef";
  let hex = "0x";
  for (let i = 0; i < 64; i++) hex += chars[Math.floor(Math.random() * 16)];
  return hex;
}

describe("V3 Contract Unit Tests — Challenge, Timeout, Edge Cases", () => {
  let settlement;
  let usdc;
  let owner, host, player, settler, challenger;

  before(async () => {
    [owner, host, player, settler, challenger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const Settlement = await ethers.getContractFactory("ChancySettlementV3");
    settlement = await Settlement.deploy(await usdc.getAddress(), settler.address);
  });

  // ── Helper: full game flow ─────────────────────────────────────────────────
  async function playGame(mode, difficultyEnum, prizePot, maxSpend, clicks, expectedOutcome) {
    const hostSecret = randomBytes32();
    const hostCommitment = computeHostCommitment(hostSecret);
    const playerRandom = randomBytes32();
    const playerCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [playerRandom]));
    const pythRandom = randomBytes32();

    await usdc.mint(host.address, prizePot);
    await usdc.mint(player.address, maxSpend);
    await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
    await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

    let gameId;
    const tx = await settlement.connect(host).createGame(difficultyEnum, prizePot, hostCommitment);
    const receipt = await tx.wait();
    // Parse GameCreated event for gameId
    const iface = settlement.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === "GameCreated") {
          gameId = parsed.args.gameId;
          break;
        }
      } catch {}
    }

    await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);
    await settlement.connect(settler).activateGame(gameId, pythRandom);

    // Verify clicks match expected outcome
    const boardSeed = computeBoardSeed(pythRandom, hostSecret, gameId);
    const board = deriveBoardV3(boardSeed, mode);

    // If no clicks provided, auto-generate based on expected outcome
    if (!clicks) {
      if (expectedOutcome === 2) { // Loss
        clicks = board.bombPositions.slice(0, 3);
      } else if (expectedOutcome === 1) { // Win
        clicks = board.prizePositions;
      } else { // Quit
        clicks = [0, 1, 2].filter(t => !board.bombPositions.includes(t) && !board.prizePositions.includes(t));
      }
    }

    const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };
    await settlement.connect(settler).settleGame(gameId, hostSecret, clicks, expectedOutcome);

    return { gameId, hostSecret, clicks, board, pythRandom, outcome: expectedOutcome };
  }

  // ── Timeout Refund ─────────────────────────────────────────────────────────
  describe("timeout refund", () => {
    it("refunds both parties after 24h with no settlement", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const playerCommitment = randomBytes32();
      const prizePot = ethers.parseUnits("10", 6);
      const maxSpend = ethers.parseUnits("5", 6);

      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);

      // Don't settle — advance time past 24h
      await time.increase(25 * 3600);

      const hostBalBefore = await usdc.balanceOf(host.address);
      const playerBalBefore = await usdc.balanceOf(player.address);

      // Anyone can trigger refund
      await settlement.connect(challenger).refundTimeout(gameId);

      const hostBalAfter = await usdc.balanceOf(host.address);
      const playerBalAfter = await usdc.balanceOf(player.address);

      expect(hostBalAfter - hostBalBefore).to.equal(prizePot);
      expect(playerBalAfter - playerBalBefore).to.equal(maxSpend);

      const game = await settlement.getGame(gameId);
      expect(Number(game.status)).to.equal(4); // Refunded = 4
    });

    it("rejects refund before 24h", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const prizePot = ethers.parseUnits("10", 6);

      await usdc.mint(host.address, prizePot);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      // Try refund immediately
      await expect(
        settlement.connect(challenger).refundTimeout(gameId)
      ).to.be.revertedWith("REFUND_TIMEOUT_NOT_REACHED");
    });
  });

  // ── Access Control ─────────────────────────────────────────────────────────
  describe("access control", () => {
    it("rejects settleGame from non-settler", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const playerCommitment = randomBytes32();
      const prizePot = ethers.parseUnits("10", 6);
      const maxSpend = ethers.parseUnits("5", 6);

      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);
      await settlement.connect(settler).activateGame(gameId, randomBytes32());

      await expect(
        settlement.connect(host).settleGame(gameId, hostSecret, [0], 3)
      ).to.be.revertedWith("NOT_SETTLER");
    });

    it("rejects activateGame from non-settler", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const prizePot = ethers.parseUnits("10", 6);

      await usdc.mint(host.address, prizePot);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await expect(
        settlement.connect(host).activateGame(gameId, randomBytes32())
      ).to.be.revertedWith("NOT_SETTLER");
    });

    it("rejects createGame with pot too low", async () => {
      await expect(
        settlement.connect(host).createGame(0, 1, randomBytes32())
      ).to.be.revertedWith("PRIZE_POT_TOO_LOW");
    });

    it("rejects createGame with pot too high", async () => {
      const huge = ethers.parseUnits("10000", 6);
      await expect(
        settlement.connect(host).createGame(0, huge, randomBytes32())
      ).to.be.revertedWith("PRIZE_POT_TOO_HIGH");
    });

    it("rejects host joining own game", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const prizePot = ethers.parseUnits("10", 6);
      const maxSpend = ethers.parseUnits("5", 6);

      await usdc.mint(host.address, prizePot + maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot + maxSpend);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await expect(
        settlement.connect(host).joinGame(gameId, randomBytes32(), maxSpend)
      ).to.be.revertedWith("HOST_CANNOT_PLAY");
    });
  });

  // ── Spend Exceeds Budget ───────────────────────────────────────────────────
  describe("spend exceeds budget", () => {
    it("rejects settlement where spend exceeds maxSpend", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const playerCommitment = randomBytes32();
      const pythRandom = randomBytes32();

      // Very small maxSpend — can't afford even 1 click
      const prizePot = ethers.parseUnits("100", 6);
      const maxSpend = ethers.parseUnits("0.01", 6); // $0.01 — too low

      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);
      await settlement.connect(settler).activateGame(gameId, pythRandom);

      // Click 5 tiles — spend will exceed $0.01
      const boardSeed = computeBoardSeed(pythRandom, hostSecret, gameId);
      const board = deriveBoardV3(boardSeed, "Easy");

      // Find 5 empty tiles
      const emptyTiles = [];
      for (let i = 0; i < 36 && emptyTiles.length < 5; i++) {
        if (!board.bombPositions.includes(i) && !board.prizePositions.includes(i)) {
          emptyTiles.push(i);
        }
      }

      const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };
      await expect(
        settlement.connect(settler).settleGame(gameId, hostSecret, emptyTiles, GameOutcome.Quit)
      ).to.be.revertedWith("SPEND_EXCEEDS_BUDGET");
    });
  });

  // ── Host Secret Verification ───────────────────────────────────────────────
  describe("host secret verification", () => {
    it("rejects settlement with wrong host secret", async () => {
      const hostSecret = randomBytes32();
      const hostCommitment = computeHostCommitment(hostSecret);
      const playerCommitment = randomBytes32();
      const pythRandom = randomBytes32();
      const prizePot = ethers.parseUnits("10", 6);
      const maxSpend = ethers.parseUnits("5", 6);

      await usdc.mint(host.address, prizePot);
      await usdc.mint(player.address, maxSpend);
      await usdc.connect(host).approve(await settlement.getAddress(), prizePot);
      await usdc.connect(player).approve(await settlement.getAddress(), maxSpend);

      const tx = await settlement.connect(host).createGame(0, prizePot, hostCommitment);
      const receipt = await tx.wait();
      let gameId;
      for (const log of receipt.logs) {
        try { const p = settlement.interface.parseLog(log); if (p && p.name === 'GameCreated') { gameId = p.args.gameId; break; } } catch {}
      }

      await settlement.connect(player).joinGame(gameId, playerCommitment, maxSpend);
      await settlement.connect(settler).activateGame(gameId, pythRandom);

      // Use a different secret
      const wrongSecret = randomBytes32();
      const GameOutcome = { Pending: 0, Win: 1, Loss: 2, Quit: 3 };

      await expect(
        settlement.connect(settler).settleGame(gameId, wrongSecret, [0], GameOutcome.Quit)
      ).to.be.revertedWith("HOST_SECRET_MISMATCH");
    });
  });

  // ── Payout Verification ────────────────────────────────────────────────────
  describe("payout amounts", () => {
    it("Win: player gets pot + unspent, host gets spent", async () => {
      const result = await playGame("Easy", 0, ethers.parseUnits("10", 6), ethers.parseUnits("5", 6), null, 1);

      const settlementData = await settlement.getSettlement(result.gameId);
      const game = await settlement.getGame(result.gameId);

      // Calculate expected spend
      let expectedSpent = 0n;
      for (let i = 0; i < result.clicks.length; i++) {
        expectedSpent += revealCostAt(game.prizePot, "Easy", i);
      }
      const expectedUnspent = game.maxSpend - expectedSpent;

      expect(settlementData.hostPayout).to.equal(expectedSpent);
      expect(settlementData.playerPayout).to.equal(game.prizePot + expectedUnspent);
    });

    it("Loss: host gets pot + spent, player gets unspent", async () => {
      const result = await playGame("Easy", 0, ethers.parseUnits("10", 6), ethers.parseUnits("5", 6), null, 2);

      const settlementData = await settlement.getSettlement(result.gameId);
      const game = await settlement.getGame(result.gameId);

      let expectedSpent = 0n;
      for (let i = 0; i < result.clicks.length; i++) {
        expectedSpent += revealCostAt(game.prizePot, "Easy", i);
      }
      const expectedUnspent = game.maxSpend - expectedSpent;

      expect(settlementData.hostPayout).to.equal(game.prizePot + expectedSpent);
      expect(settlementData.playerPayout).to.equal(expectedUnspent);
    });
  });
});