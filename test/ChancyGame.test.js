const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const Difficulty = { Easy: 0, Normal: 1, Hardcore: 2 };
const TileOutcome = { Empty: 0, Prize: 1, Bomb: 2 };
const USDC = (n) => ethers.parseUnits(String(n), 6);

const MODE = {
  [Difficulty.Easy]: { startBps: 150n, capBps: 15000n, bombs: 5, prizes: 3 },
  [Difficulty.Normal]: { startBps: 250n, capBps: 20000n, bombs: 7, prizes: 2 },
  [Difficulty.Hardcore]: { startBps: 350n, capBps: 25000n, bombs: 10, prizes: 1 },
};

function userRandom(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function firstTileFromMask(mask, offset = 0) {
  let skipped = 0;
  for (let i = 0; i < 64; i++) {
    if (((mask >> BigInt(i)) & 1n) === 1n) {
      if (skipped === offset) return i;
      skipped += 1;
    }
  }
  throw new Error("mask has no tile");
}

async function deployFixture() {
  const [owner, entropyProvider, host, player, otherPlayer] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const MockEntropy = await ethers.getContractFactory("MockEntropy");
  const entropy = await MockEntropy.deploy(entropyProvider.address);

  const ChancyGame = await ethers.getContractFactory("ChancyGame");
  const chancy = await ChancyGame.deploy(await entropy.getAddress(), await usdc.getAddress(), host.address);

  for (const signer of [host, player, otherPlayer]) {
    await usdc.mint(signer.address, USDC(1000));
    await usdc.connect(signer).approve(await chancy.getAddress(), USDC(1000));
  }

  return { owner, entropyProvider, host, player, otherPlayer, usdc, entropy, chancy };
}

async function createSession({ chancy, usdc, host }, difficulty = Difficulty.Normal, prizePot = USDC(100)) {
  await chancy.connect(host).createSession(await usdc.getAddress(), difficulty, prizePot);
  return 1;
}

async function joinAndReveal({ chancy, entropy, entropyProvider, player }, sessionId, label) {
  const tx = await chancy.connect(player).joinSession(sessionId, userRandom(label));
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((log) => {
      try { return chancy.interface.parseLog(log); } catch (_) { return null; }
    })
    .find((event) => event && event.name === "EntropyRequested");
  const sequence = parsed.args.sequenceNumber;
  await entropy.mockReveal(entropyProvider.address, sequence, userRandom(`${label}-pyth-result`));
  return sequence;
}

describe("ChancyGame corrected V1 mechanics", function () {
  it("creates a one-player host session funded by a prize pot", async function () {
    const { host, player, usdc, chancy } = await deployFixture();
    const asset = await usdc.getAddress();
    const hostBefore = await usdc.balanceOf(host.address);

    await expect(chancy.connect(host).createSession(asset, Difficulty.Easy, USDC(100)))
      .to.emit(chancy, "SessionCreated")
      .withArgs(1, host.address, asset, Difficulty.Easy, USDC(100), 5, 3);

    const session = await chancy.sessions(1);
    expect(session.host).to.equal(host.address);
    expect(session.asset).to.equal(asset);
    expect(session.prizePot).to.equal(USDC(100));
    expect(session.activePlayer).to.equal(ZERO);
    expect(session.bombCount).to.equal(5);
    expect(session.prizeCount).to.equal(3);
    expect(hostBefore - await usdc.balanceOf(host.address)).to.equal(USDC(100));
    await expect(chancy.connect(host).joinSession(1, userRandom("host"))).to.be.revertedWith("HOST_CANNOT_PLAY");
    await expect(chancy.connect(player).joinSession(1, userRandom("player"))).to.emit(chancy, "PlayerJoined").withArgs(1, player.address);
  });

  it("uses monotonic reveal costs bounded by each mode cap", async function () {
    const { host, usdc, chancy } = await deployFixture();
    const prizePot = USDC(100);

    for (const difficulty of [Difficulty.Easy, Difficulty.Normal, Difficulty.Hardcore]) {
      const sessionId = await chancy.connect(host).createSession.staticCall(await usdc.getAddress(), difficulty, prizePot);
      await chancy.connect(host).createSession(await usdc.getAddress(), difficulty, prizePot);
      const mode = MODE[difficulty];
      let previous = 0n;
      let sum = 0n;
      for (let i = 0; i < 64; i++) {
        const cost = await chancy.revealCostAt(sessionId, i);
        if (i === 0) expect(cost).to.equal((prizePot * mode.startBps) / 10000n);
        expect(cost).to.be.gte(previous);
        previous = cost;
        sum += cost;
      }
      expect(sum).to.be.lte((prizePot * mode.capBps) / 10000n);
    }
  });

  it("allows only one active player and reopens after voluntary quit pays host", async function () {
    const { host, player, otherPlayer, usdc, entropy, entropyProvider, chancy } = await deployFixture();
    await createSession({ chancy, usdc, host });
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");
    await expect(chancy.connect(otherPlayer).joinSession(1, userRandom("other"))).to.be.revertedWith("ACTIVE_PLAYER_EXISTS");

    const game = await chancy.playerGames(1, player.address);
    const safeTile = firstTileFromMask(~(game.bombMask | game.prizeMask));
    const cost = await chancy.currentRevealCost(1);
    await chancy.connect(player).clickTile(1, safeTile);

    const hostBefore = await usdc.balanceOf(host.address);
    await expect(chancy.connect(player).quitSession(1)).to.emit(chancy, "PlayerExited").withArgs(1, player.address, cost);
    expect(await usdc.balanceOf(host.address) - hostBefore).to.equal(cost);
    expect((await chancy.sessions(1)).activePlayer).to.equal(ZERO);

    await expect(chancy.connect(otherPlayer).joinSession(1, userRandom("other"))).to.emit(chancy, "PlayerJoined").withArgs(1, otherPlayer.address);
  });

  it("pays spent amount to host on 3-bomb game over and resets the session", async function () {
    const { host, player, otherPlayer, usdc, entropy, entropyProvider, chancy } = await deployFixture();
    await createSession({ chancy, usdc, host }, Difficulty.Hardcore);
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");
    const game = await chancy.playerGames(1, player.address);
    const bombTiles = [0, 1, 2].map((n) => firstTileFromMask(game.bombMask, n));

    let spent = 0n;
    const hostBefore = await usdc.balanceOf(host.address);
    for (const tile of bombTiles) {
      const cost = await chancy.currentRevealCost(1);
      spent += cost;
      await chancy.connect(player).clickTile(1, tile);
    }

    expect(await usdc.balanceOf(host.address) - hostBefore).to.equal(spent);
    expect((await chancy.sessions(1)).activePlayer).to.equal(ZERO);
    await expect(chancy.connect(otherPlayer).joinSession(1, userRandom("fresh"))).to.emit(chancy, "PlayerJoined").withArgs(1, otherPlayer.address);
  });

  it("kicks an idle player after one minute and pays spent amount to host", async function () {
    const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
    await createSession({ chancy, usdc, host });
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");
    const game = await chancy.playerGames(1, player.address);
    const safeTile = firstTileFromMask(~(game.bombMask | game.prizeMask));
    const cost = await chancy.currentRevealCost(1);
    await chancy.connect(player).clickTile(1, safeTile);

    await network.provider.send("evm_increaseTime", [61]);
    await network.provider.send("evm_mine");

    const hostBefore = await usdc.balanceOf(host.address);
    await expect(chancy.kickIdlePlayer(1)).to.emit(chancy, "PlayerKickedIdle").withArgs(1, player.address, cost);
    expect(await usdc.balanceOf(host.address) - hostBefore).to.equal(cost);
    expect((await chancy.sessions(1)).activePlayer).to.equal(ZERO);
  });

  it("accrues prize rewards while bombs remain active", async function () {
    const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
    await createSession({ chancy, usdc, host }, Difficulty.Normal, USDC(100));
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");
    const game = await chancy.playerGames(1, player.address);
    const prizeTile = firstTileFromMask(game.prizeMask);
    const bombTile = firstTileFromMask(game.bombMask);

    await expect(chancy.connect(player).clickTile(1, prizeTile))
      .to.emit(chancy, "TileResolved").withArgs(1, player.address, prizeTile, TileOutcome.Prize, await chancy.revealCostAt(1, 0));
    expect(await chancy.claimableRewards(player.address, await usdc.getAddress())).to.equal(USDC(50));

    await expect(chancy.connect(player).clickTile(1, bombTile))
      .to.emit(chancy, "TileResolved").withArgs(1, player.address, bombTile, TileOutcome.Bomb, await chancy.revealCostAt(1, 1));
    expect((await chancy.playerGames(1, player.address)).bombsHit).to.equal(1);
  });
});
