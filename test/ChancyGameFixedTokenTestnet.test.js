const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const TEMP_GAME_TOKEN="0x3e1a6d23303be04403badc8bff348027148fef27";

const Difficulty = {
  Easy: 0,
  Normal: 1,
  Hardcore: 2,
};

const TileOutcome = {
  Empty: 0,
  Prize: 1,
  Bomb: 2,
};

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

async function placeMockTokenAtFixedAddress() {
  const MockGameToken = await ethers.getContractFactory("MockGameToken");
  const deployedToken = await MockGameToken.deploy();
  const runtimeCode = await ethers.provider.getCode(await deployedToken.getAddress());
  await network.provider.send("hardhat_setCode", [TEMP_GAME_TOKEN, runtimeCode]);
  return ethers.getContractAt("MockGameToken", TEMP_GAME_TOKEN);
}

describe("ChancyGameFixedTokenTestnet", function () {
  async function deployFixture() {
    const [owner, entropyProvider, host, player, otherPlayer] = await ethers.getSigners();

    const token = await placeMockTokenAtFixedAddress();

    const MockEntropy = await ethers.getContractFactory("MockEntropy");
    const entropy = await MockEntropy.deploy(entropyProvider.address);

    const Chancy = await ethers.getContractFactory("ChancyGameFixedTokenTestnet");
    const chancy = await Chancy.deploy(await entropy.getAddress());

    for (const signer of [host, player, otherPlayer]) {
      await token.mint(signer.address, ethers.parseEther("1000"));
      await token.connect(signer).approve(await chancy.getAddress(), ethers.parseEther("1000"));
    }

    return { owner, entropyProvider, host, player, otherPlayer, token, entropy, chancy };
  }

  async function createSession(chancy, host, difficulty = Difficulty.Normal, maxPlayers = 4) {
    const tx = await chancy.connect(host).createSession(
      difficulty,
      ethers.parseEther("10"),
      maxPlayers,
      ethers.parseEther("2")
    );
    await tx.wait();
    return 1;
  }

  async function createFundedSession({ chancy, token, host }, difficulty = Difficulty.Normal, maxPlayers = 4) {
    const sessionId = await createSession(chancy, host, difficulty, maxPlayers);
    const session = await chancy.sessions(sessionId);
    await token.connect(host).transfer(await chancy.getAddress(), session.totalRewardReserve);
    await chancy.connect(host).fundSessionRewards(sessionId, session.totalRewardReserve);
    return sessionId;
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

  it("uses the temporary fixed game token address", async function () {
    const { chancy } = await deployFixture();

    expect((await chancy.GAME_TOKEN()).toLowerCase()).to.equal(TEMP_GAME_TOKEN);
  });

  it("lets host create an Easy session with fixed bomb/prize config", async function () {
    const { host, chancy } = await deployFixture();

    await expect(chancy.connect(host).createSession(
      Difficulty.Easy,
      ethers.parseEther("10"),
      4,
      ethers.parseEther("2")
    ))
      .to.emit(chancy, "SessionCreated")
      .withArgs(1, host.address, Difficulty.Easy, 5, 3);

    const session = await chancy.sessions(1);
    expect(session.host).to.equal(host.address);
    expect(session.bombCount).to.equal(5);
    expect(session.prizeCount).to.equal(3);
    expect(session.totalRewardReserve).to.equal(ethers.parseEther("24"));
  });

  it("requires host-funded prize reserve before players can join", async function () {
    const { host, player, chancy } = await deployFixture();
    await createSession(chancy, host, Difficulty.Normal);

    await expect(chancy.connect(player).joinSession(1, userRandom("player-seed")))
      .to.be.revertedWith("SESSION_REWARDS_NOT_FUNDED");
  });

  it("lets the host fund exact session reward exposure", async function () {
    const { host, token, chancy } = await deployFixture();
    await createSession(chancy, host, Difficulty.Normal);
    const session = await chancy.sessions(1);

    await token.connect(host).transfer(await chancy.getAddress(), session.totalRewardReserve);
    await expect(chancy.connect(host).fundSessionRewards(1, session.totalRewardReserve))
      .to.emit(chancy, "SessionRewardsFunded")
      .withArgs(1, host.address, session.totalRewardReserve);

    const funded = await chancy.sessions(1);
    expect(funded.rewardReserveFunded).to.equal(true);
  });

  it("transfers entry token and requests Pyth Entropy when a player joins", async function () {
    const { host, player, token, entropyProvider, chancy } = await deployFixture();
    const entryAmount = ethers.parseEther("10");
    await createFundedSession({ chancy, token, host }, Difficulty.Normal);

    await expect(chancy.connect(player).joinSession(1, userRandom("player-seed")))
      .to.emit(chancy, "PlayerJoined")
      .withArgs(1, player.address)
      .and.to.emit(chancy, "EntropyRequested")
      .withArgs(1, player.address, entropyProvider.address, 1);

    const game = await chancy.playerGames(1, player.address);
    expect(game.joined).to.equal(true);
    expect(game.boardReady).to.equal(false);
    expect(game.entropySequenceNumber).to.equal(1);
    expect(await token.balanceOf(await chancy.getAddress())).to.equal(entryAmount + ethers.parseEther("16"));
  });

  it("builds an isolated per-player board after Pyth Entropy callback", async function () {
    const { host, player, otherPlayer, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Normal);

    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");
    await joinAndReveal({ chancy, entropy, entropyProvider, player: otherPlayer }, 1, "player-two");

    const firstGame = await chancy.playerGames(1, player.address);
    const secondGame = await chancy.playerGames(1, otherPlayer.address);

    expect(firstGame.boardReady).to.equal(true);
    expect(secondGame.boardReady).to.equal(true);
    expect(firstGame.bombMask).to.not.equal(0n);
    expect(firstGame.prizeMask).to.not.equal(0n);
    expect(firstGame.bombMask & firstGame.prizeMask).to.equal(0n);
    expect(secondGame.bombMask & secondGame.prizeMask).to.equal(0n);
    expect(firstGame.bombMask).to.not.equal(secondGame.bombMask);
  });

  it("prevents tile clicks before the player entropy board is ready", async function () {
    const { host, player, token, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Hardcore);
    await chancy.connect(player).joinSession(1, userRandom("player-seed"));

    await expect(chancy.connect(player).clickTile(1, 7)).to.be.revertedWith("BOARD_NOT_READY");
  });

  it("rejects duplicate tile clicks after board readiness", async function () {
    const { host, player, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Hardcore);
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");

    await expect(chancy.connect(player).clickTile(1, 7))
      .to.emit(chancy, "TileClicked")
      .withArgs(1, player.address, 7);

    await expect(chancy.connect(player).clickTile(1, 7)).to.be.revertedWith("TILE_ALREADY_CLICKED");
  });

  it("resolves bomb, prize, and empty outcomes from the player board", async function () {
    const { host, player, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Normal);
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");

    const game = await chancy.playerGames(1, player.address);
    const bombTile = firstTileFromMask(game.bombMask);
    const prizeTile = firstTileFromMask(game.prizeMask);
    const emptyTile = firstEmptyTile(game.bombMask, game.prizeMask);

    await expect(chancy.connect(player).clickTile(1, bombTile))
      .to.emit(chancy, "TileResolved")
      .withArgs(1, player.address, bombTile, TileOutcome.Bomb);
    await expect(chancy.connect(player).clickTile(1, prizeTile))
      .to.emit(chancy, "TileResolved")
      .withArgs(1, player.address, prizeTile, TileOutcome.Prize);
    await expect(chancy.connect(player).clickTile(1, emptyTile))
      .to.emit(chancy, "TileResolved")
      .withArgs(1, player.address, emptyTile, TileOutcome.Empty);

    const updated = await chancy.playerGames(1, player.address);
    expect(updated.bombsHit).to.equal(1);
    expect(updated.prizesFound).to.equal(1);
  });

  it("marks a player game over after 3 bombs", async function () {
    const { host, player, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Hardcore);
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");

    const game = await chancy.playerGames(1, player.address);
    const bombTiles = [];
    for (let i = 0; i < 64 && bombTiles.length < 3; i++) {
      if (((game.bombMask >> BigInt(i)) & 1n) === 1n) bombTiles.push(i);
    }

    for (const tile of bombTiles) {
      await chancy.connect(player).clickTile(1, tile);
    }

    const updated = await chancy.playerGames(1, player.address);
    expect(updated.bombsHit).to.equal(3);
    expect(updated.gameOver).to.equal(true);
    await expect(chancy.connect(player).clickTile(1, firstEmptyTile(game.bombMask, game.prizeMask)))
      .to.be.revertedWith("PLAYER_GAME_OVER");
  });

  it("accrues and claims rewardPerPrize for prize hits", async function () {
    const { host, player, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Normal);
    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");

    const game = await chancy.playerGames(1, player.address);
    const prizeTile = firstTileFromMask(game.prizeMask);

    await chancy.connect(player).clickTile(1, prizeTile);
    expect(await chancy.claimableRewards(player.address)).to.equal(ethers.parseEther("2"));

    const before = await token.balanceOf(player.address);
    await expect(chancy.connect(player).claimRewards())
      .to.emit(chancy, "RewardsClaimed")
      .withArgs(player.address, ethers.parseEther("2"));
    const after = await token.balanceOf(player.address);

    expect(after - before).to.equal(ethers.parseEther("2"));
    expect(await chancy.claimableRewards(player.address)).to.equal(0);
  });

  it("rejects full sessions, double joins, invalid tiles, and empty reward claims", async function () {
    const { host, player, otherPlayer, token, entropy, entropyProvider, chancy } = await deployFixture();
    await createFundedSession({ chancy, token, host }, Difficulty.Normal, 1);

    await joinAndReveal({ chancy, entropy, entropyProvider, player }, 1, "player-one");

    await expect(chancy.connect(player).joinSession(1, userRandom("again"))).to.be.revertedWith("ALREADY_JOINED");
    await expect(chancy.connect(otherPlayer).joinSession(1, userRandom("other"))).to.be.revertedWith("SESSION_FULL");
    await expect(chancy.connect(player).clickTile(1, 64)).to.be.revertedWith("INVALID_TILE");
    await expect(chancy.connect(otherPlayer).claimRewards()).to.be.revertedWith("NO_REWARDS");
  });
});
