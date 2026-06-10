const { expect } = require("chai");
const hre = require("hardhat");
const { deployChancyGame } = require("../scripts/deploy-chancy-game");

describe("deployChancyGame", function () {
  it("deploys ChancyGame with provided token and entropy addresses", async function () {
    const [entropyProvider] = await hre.ethers.getSigners();

    const MockGameToken = await hre.ethers.getContractFactory("MockGameToken");
    const token = await MockGameToken.deploy();

    const MockEntropy = await hre.ethers.getContractFactory("MockEntropy");
    const entropy = await MockEntropy.deploy(entropyProvider.address);

    const deployment = await deployChancyGame({
      ethers: hre.ethers,
      gameTokenAddress: await token.getAddress(),
      entropyAddress: await entropy.getAddress(),
    });

    expect(deployment.contractAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(deployment.gameTokenAddress).to.equal(await token.getAddress());
    expect(deployment.entropyAddress).to.equal(await entropy.getAddress());
    expect(await deployment.contract.gameToken()).to.equal(await token.getAddress());
    expect(await deployment.contract.entropy()).to.equal(await entropy.getAddress());
  });

  it("requires explicit token and entropy addresses", async function () {
    await expect(deployChancyGame({ ethers: hre.ethers, gameTokenAddress: "", entropyAddress: hre.ethers.ZeroAddress }))
      .to.be.rejectedWith("CHANCY_GAME_TOKEN_ADDRESS is required");
    await expect(deployChancyGame({ ethers: hre.ethers, gameTokenAddress: hre.ethers.ZeroAddress, entropyAddress: "" }))
      .to.be.rejectedWith("PYTH_ENTROPY_ADDRESS is required");
  });
});
