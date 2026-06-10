const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const TEMP_GAME_TOKEN = "0x3e1a6d23303be04403badc8bff348027148fef27";

const Difficulty = {
  Easy: 0,
  Normal: 1,
  Hardcore: 2,
};

function asBytes32(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

describe("ChancyGameFixedTokenTestnet", function () {
  async function deployFixture() {
    const [owner, host, player] = await ethers.getSigners();

    const MockGameToken = await ethers.getContractFactory("MockGameToken");
    const deployedToken = await MockGameToken.deploy();
    const runtimeCode = await ethers.provider.getCode(await deployedToken.getAddress());
    await network.provider.send("hardhat_setCode", [TEMP_GAME_TOKEN, runtimeCode]);
    const token = await ethers.getContractAt("MockGameToken", TEMP_GAME_TOKEN);

    const Chancy = await ethers.getContractFactory("ChancyGameFixedTokenTestnet");
    const chancy = await Chancy.deploy();

    await token.mint(player.address, ethers.parseEther("1000"));
    await token.connect(player).approve(await chancy.getAddress(), ethers.parseEther("1000"));

    return { owner, host, player, token, chancy };
  }

  it("uses the temporary fixed game token address", async function () {
    const { chancy } = await deployFixture();

    expect((await chancy.GAME_TOKEN()).toLowerCase()).to.equal(TEMP_GAME_TOKEN);
  });

  it("lets host create an Easy session with fixed bomb/prize config", async function () {
    const { host, chancy } = await deployFixture();

    await expect(
      chancy.connect(host).createSession(
        Difficulty.Easy,
        ethers.parseEther("10"),
        4,
        ethers.parseEther("2"),
        asBytes32("board-commitment")
      )
    ).to.emit(chancy, "SessionCreated").withArgs(1, host.address, Difficulty.Easy, 5, 3);

    const session = await chancy.sessions(1);
    expect(session.host).to.equal(host.address);
    expect(session.bombCount).to.equal(5);
    expect(session.prizeCount).to.equal(3);
  });

  it("transfers entry token when a player joins", async function () {
    const { host, player, token, chancy } = await deployFixture();
    const entryAmount = ethers.parseEther("10");

    await chancy.connect(host).createSession(
      Difficulty.Normal,
      entryAmount,
      4,
      ethers.parseEther("2"),
      asBytes32("board-commitment")
    );

    await expect(chancy.connect(player).joinSession(1))
      .to.emit(chancy, "PlayerJoined")
      .withArgs(1, player.address);

    expect(await token.balanceOf(await chancy.getAddress())).to.equal(entryAmount);
  });

  it("rejects duplicate tile clicks", async function () {
    const { host, player, chancy } = await deployFixture();

    await chancy.connect(host).createSession(
      Difficulty.Hardcore,
      ethers.parseEther("10"),
      4,
      ethers.parseEther("2"),
      asBytes32("board-commitment")
    );
    await chancy.connect(player).joinSession(1);

    await expect(chancy.connect(player).clickTile(1, 7))
      .to.emit(chancy, "TileClicked")
      .withArgs(1, player.address, 7);

    await expect(chancy.connect(player).clickTile(1, 7)).to.be.revertedWith("TILE_ALREADY_CLICKED");
  });
});
