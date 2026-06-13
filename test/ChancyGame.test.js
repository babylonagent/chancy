const { expect } = require("chai");
const { ethers } = require("hardhat");

const ZERO = ethers.ZeroAddress;
const Difficulty = { Easy: 0, Normal: 1, Hardcore: 2 };
const TileOutcome = { Empty: 0, Prize: 1, Bomb: 2 };

const USDC = (n) => ethers.parseUnits(String(n), 6);
const ETH = (n) => ethers.parseEther(String(n));

function userRandom(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function firstTileFromMask(mask) {
  for (let i = 0; i < 64; i++) {
    if (((mask >> BigInt(i)) & 1n) === 1n) return i;
  }
  throw new Error("mask has no tile");
}

function firstEmptyTile(bombMask, prizeMask) {
  const occupied = bombMask | prizeMask;
  for (let i = 0; i < 64; i++) {
    if (((occupied >> BigInt(i)) & 1n) === 0n) return i;
  }
  throw new Error("no empty tile");
}

async function deployFixture() {
  const [owner, entropyProvider, host, player, otherPlayer] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();

  const MockEntropy = await ethers.getContractFactory("MockEntropy");
  const entropy = await MockEntropy.deploy(entropyProvider.address);

  const ChancyGame = await ethers.getContractFactory("ChancyGame");
  const chancy = await ChancyGame.deploy(await entropy.getAddress(), await usdc.getAddress());

  for (const signer of [host, player, otherPlayer]) {
    await usdc.mint(signer.address, USDC(1000));
    await usdc.connect(signer).approve(await chancy.getAddress(), USDC(1000));
  }

  return { owner, entropyProvider, host, player, otherPlayer, usdc, entropy, chancy };
}

async function joinAndReveal({ chancy, entropy, entropyProvider, player }, sessionId, label, value = 0n) {
  const tx = await chancy.connect(player).joinSession(sessionId, userRandom(label), { value });
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

describe("ChancyGame", function () {
  it("configures entropy and allow-lists the initial ERC20 asset", async function () {
    const { chancy, usdc, entropy } = await deployFixture();
    expect(await chancy.entropy()).to.equal(await entropy.getAddress());
    expect(await chancy.isAssetAllowed(await usdc.getAddress())).to.equal(true);
    expect(await chancy.isAssetAllowed(ZERO)).to.equal(true); // ETH always allowed
  });

  it("rejects a zero entropy address", async function () {
    const { usdc } = await deployFixture();
    const ChancyGame = await ethers.getContractFactory("ChancyGame");
    await expect(ChancyGame.deploy(ZERO, await usdc.getAddress()))
      .to.be.revertedWith("INVALID_ENTROPY");
  });

  it("lets the owner manage allow-listed assets", async function () {
    const { chancy, owner } = await deployFixture();
    const random = "0x000000000000000000000000000000000000dEaD";
    expect(await chancy.isAssetAllowed(random)).to.equal(false);
    await chancy.connect(owner).setAssetAllowed(random, true);
    expect(await chancy.isAssetAllowed(random)).to.equal(true);
    await expect(chancy.connect(owner).setAssetAllowed(ZERO, true)).to.be.revertedWith("NATIVE_ALWAYS_ALLOWED");
  });

  it("rejects sessions in a non-allow-listed asset", async function () {
    const { chancy, host } = await deployFixture();
    const random = "0x000000000000000000000000000000000000bEEF";
    await expect(chancy.connect(host).createSession(random, Difficulty.Normal, USDC(10), 4, USDC(2)))
      .to.be.revertedWith("ASSET_NOT_ALLOWED");
  });

  describe("USDC settlement", function () {
    async function fundedUsdcSession({ chancy, usdc, host }, difficulty = Difficulty.Normal, maxPlayers = 4) {
      const asset = await usdc.getAddress();
      await chancy.connect(host).createSession(asset, difficulty, USDC(10), maxPlayers, USDC(2));
      const session = await chancy.sessions(1);
      await chancy.connect(host).fundSessionRewards(1, session.totalRewardReserve);
      return 1;
    }

    it("creates an Easy USDC session with fixed bomb/prize config", async function () {
      const { host, usdc, chancy } = await deployFixture();
      const asset = await usdc.getAddress();
      await expect(chancy.connect(host).createSession(asset, Difficulty.Easy, USDC(10), 4, USDC(2)))
        .to.emit(chancy, "SessionCreated")
        .withArgs(1, host.address, asset, Difficulty.Easy, 5, 3);

      const session = await chancy.sessions(1);
      expect(session.asset).to.equal(asset);
      expect(session.bombCount).to.equal(5);
      expect(session.totalRewardReserve).to.equal(USDC(24));
    });

    it("requires host-funded prize reserve before players can join", async function () {
      const { host, player, usdc, chancy } = await deployFixture();
      await chancy.connect(host).createSession(await usdc.getAddress(), Difficulty.Normal, USDC(10), 4, USDC(2));
      await expect(chancy.connect(player).joinSession(1, userRandom("seed")))
        .to.be.revertedWith("SESSION_REWARDS_NOT_FUNDED");
    });

    it("pulls USDC reserve from host on fund", async function () {
      const { host, usdc, chancy } = await deployFixture();
      await chancy.connect(host).createSession(await usdc.getAddress(), Difficulty.Normal, USDC(10), 4, USDC(2));
      const session = await chancy.sessions(1);
      const before = await usdc.balanceOf(await chancy.getAddress());
      await expect(chancy.connect(host).fundSessionRewards(1, session.totalRewardReserve))
        .to.emit(chancy, "SessionRewardsFunded").withArgs(1, host.address, session.totalRewardReserve);
      expect((await usdc.balanceOf(await chancy.getAddress())) - before).to.equal(session.totalRewardReserve);
    });

    it("rejects native value sent to a USDC fund call", async function () {
      const { host, usdc, chancy } = await deployFixture();
      await chancy.connect(host).createSession(await usdc.getAddress(), Difficulty.Normal, USDC(10), 2, USDC(2));
      const reserve = (await chancy.sessions(1)).totalRewardReserve;
      await expect(chancy.connect(host).fundSessionRewards(1, reserve, { value: 1n }))
        .to.be.revertedWith("UNEXPECTED_ETH");
    });

    it("transfers USDC entry and requests entropy on join", async function () {
      const { host, player, usdc, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host });
      const reserve = (await chancy.sessions(1)).totalRewardReserve;

      await expect(chancy.connect(player).joinSession(1, userRandom("seed")))
        .to.emit(chancy, "PlayerJoined").withArgs(1, player.address)
        .and.to.emit(chancy, "EntropyRequested").withArgs(1, player.address, entropyProvider.address, 1);

      expect(await usdc.balanceOf(await chancy.getAddress())).to.equal(reserve + USDC(10));
    });

    it("builds isolated per-player boards after entropy callback", async function () {
      const { host, player, otherPlayer, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host });
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");
      await joinAndReveal({ chancy, entropy, entropyProvider, player: otherPlayer }, 1, "p2");

      const a = await chancy.playerGames(1, player.address);
      const b = await chancy.playerGames(1, otherPlayer.address);
      expect(a.boardReady).to.equal(true);
      expect(b.boardReady).to.equal(true);
      expect(a.bombMask & a.prizeMask).to.equal(0n);
      expect(a.bombMask).to.not.equal(b.bombMask);
    });

    it("rejects clicks before board ready and duplicate clicks", async function () {
      const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host }, Difficulty.Hardcore);
      await chancy.connect(player).joinSession(1, userRandom("seed"));
      await expect(chancy.connect(player).clickTile(1, 7)).to.be.revertedWith("BOARD_NOT_READY");

      const seq = (await chancy.playerGames(1, player.address)).entropySequenceNumber;
      await entropy.mockReveal(entropyProvider.address, seq, userRandom("seed-pyth-result"));

      await chancy.connect(player).clickTile(1, 7);
      await expect(chancy.connect(player).clickTile(1, 7)).to.be.revertedWith("TILE_ALREADY_CLICKED");
    });

    it("resolves bomb/prize/empty and accrues USDC rewards", async function () {
      const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host });
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");

      const game = await chancy.playerGames(1, player.address);
      const bombTile = firstTileFromMask(game.bombMask);
      const prizeTile = firstTileFromMask(game.prizeMask);
      const emptyTile = firstEmptyTile(game.bombMask, game.prizeMask);

      await expect(chancy.connect(player).clickTile(1, bombTile))
        .to.emit(chancy, "TileResolved").withArgs(1, player.address, bombTile, TileOutcome.Bomb);
      await expect(chancy.connect(player).clickTile(1, prizeTile))
        .to.emit(chancy, "TileResolved").withArgs(1, player.address, prizeTile, TileOutcome.Prize);
      await expect(chancy.connect(player).clickTile(1, emptyTile))
        .to.emit(chancy, "TileResolved").withArgs(1, player.address, emptyTile, TileOutcome.Empty);

      expect(await chancy.claimableRewards(player.address, await usdc.getAddress())).to.equal(USDC(2));
    });

    it("marks game over after 3 bombs", async function () {
      const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host }, Difficulty.Hardcore);
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");

      const game = await chancy.playerGames(1, player.address);
      const bombTiles = [];
      for (let i = 0; i < 64 && bombTiles.length < 3; i++) {
        if (((game.bombMask >> BigInt(i)) & 1n) === 1n) bombTiles.push(i);
      }
      for (const tile of bombTiles) await chancy.connect(player).clickTile(1, tile);

      const updated = await chancy.playerGames(1, player.address);
      expect(updated.bombsHit).to.equal(3);
      expect(updated.gameOver).to.equal(true);
      await expect(chancy.connect(player).clickTile(1, firstEmptyTile(game.bombMask, game.prizeMask)))
        .to.be.revertedWith("PLAYER_GAME_OVER");
    });

    it("claims accrued USDC rewards", async function () {
      const { host, player, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host });
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");

      const prizeTile = firstTileFromMask((await chancy.playerGames(1, player.address)).prizeMask);
      await chancy.connect(player).clickTile(1, prizeTile);

      const asset = await usdc.getAddress();
      const before = await usdc.balanceOf(player.address);
      await expect(chancy.connect(player).claimRewards(asset))
        .to.emit(chancy, "RewardsClaimed").withArgs(player.address, asset, USDC(2));
      expect((await usdc.balanceOf(player.address)) - before).to.equal(USDC(2));
      expect(await chancy.claimableRewards(player.address, asset)).to.equal(0);
    });

    it("rejects full sessions, double joins, invalid tiles, empty claims", async function () {
      const { host, player, otherPlayer, usdc, entropy, entropyProvider, chancy } = await deployFixture();
      await fundedUsdcSession({ chancy, usdc, host }, Difficulty.Normal, 1);
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1");

      await expect(chancy.connect(player).joinSession(1, userRandom("again"))).to.be.revertedWith("ALREADY_JOINED");
      await expect(chancy.connect(otherPlayer).joinSession(1, userRandom("other"))).to.be.revertedWith("SESSION_FULL");
      await expect(chancy.connect(player).clickTile(1, 64)).to.be.revertedWith("INVALID_TILE");
      await expect(chancy.connect(otherPlayer).claimRewards(await usdc.getAddress())).to.be.revertedWith("NO_REWARDS");
    });
  });

  describe("Native ETH settlement", function () {
    it("funds reserve with msg.value and settles a prize in ETH", async function () {
      const { host, player, entropy, entropyProvider, chancy } = await deployFixture();
      await chancy.connect(host).createSession(ZERO, Difficulty.Normal, ETH(0.01), 2, ETH(0.02));
      const reserve = (await chancy.sessions(1)).totalRewardReserve; // 0.02 * 2 * 2 = 0.08 ETH

      await expect(chancy.connect(host).fundSessionRewards(1, reserve, { value: reserve }))
        .to.emit(chancy, "SessionRewardsFunded").withArgs(1, host.address, reserve);

      await expect(chancy.connect(player).joinSession(1, userRandom("p1"), { value: 0n }))
        .to.be.revertedWith("INSUFFICIENT_VALUE");

      // entry (0.01) + entropy fee (mock = 0) as msg.value
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1", ETH(0.01));

      const prizeTile = firstTileFromMask((await chancy.playerGames(1, player.address)).prizeMask);
      await chancy.connect(player).clickTile(1, prizeTile);
      expect(await chancy.claimableRewards(player.address, ZERO)).to.equal(ETH(0.02));

      const before = await ethers.provider.getBalance(player.address);
      const tx = await chancy.connect(player).claimRewards(ZERO);
      const rcpt = await tx.wait();
      const gas = rcpt.gasUsed * rcpt.gasPrice;
      const after = await ethers.provider.getBalance(player.address);
      expect(after - before + gas).to.equal(ETH(0.02));
    });

    it("requires msg.value to cover the entropy fee on join", async function () {
      const { host, player, entropy, entropyProvider, chancy } = await deployFixture();
      // Set a non-zero entropy fee.
      await entropy.setFee(ETH(0.001));
      await chancy.connect(host).createSession(ZERO, Difficulty.Normal, ETH(0.01), 2, ETH(0.02));
      const reserve = (await chancy.sessions(1)).totalRewardReserve;
      await chancy.connect(host).fundSessionRewards(1, reserve, { value: reserve });

      // entry only, no fee -> revert
      await expect(chancy.connect(player).joinSession(1, userRandom("p1"), { value: ETH(0.01) }))
        .to.be.revertedWith("INSUFFICIENT_VALUE");
      // entry + fee -> ok
      await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "p1", ETH(0.011));
      expect((await chancy.playerGames(1, player.address)).boardReady).to.equal(true);
    });
  });
});
