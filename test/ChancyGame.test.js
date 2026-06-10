const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ChancyGame", function () {
  it("uses constructor-configured game token and entropy addresses", async function () {
    const [entropyProvider] = await ethers.getSigners();

    const MockGameToken = await ethers.getContractFactory("MockGameToken");
    const token = await MockGameToken.deploy();

    const MockEntropy = await ethers.getContractFactory("MockEntropy");
    const entropy = await MockEntropy.deploy(entropyProvider.address);

    const ChancyGame = await ethers.getContractFactory("ChancyGame");
    const chancy = await ChancyGame.deploy(await token.getAddress(), await entropy.getAddress());

    expect(await chancy.gameToken()).to.equal(await token.getAddress());
    expect(await chancy.entropy()).to.equal(await entropy.getAddress());
  });

  it("rejects zero game token or entropy address", async function () {
    const [entropyProvider] = await ethers.getSigners();

    const MockGameToken = await ethers.getContractFactory("MockGameToken");
    const token = await MockGameToken.deploy();

    const MockEntropy = await ethers.getContractFactory("MockEntropy");
    const entropy = await MockEntropy.deploy(entropyProvider.address);

    const ChancyGame = await ethers.getContractFactory("ChancyGame");

    await expect(ChancyGame.deploy(ethers.ZeroAddress, await entropy.getAddress()))
      .to.be.revertedWith("INVALID_TOKEN");
    await expect(ChancyGame.deploy(await token.getAddress(), ethers.ZeroAddress))
      .to.be.revertedWith("INVALID_ENTROPY");
  });
});
