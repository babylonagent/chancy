const { expect } = require("chai");
const hre = require("hardhat");
const { deployChancyGame } = require("../scripts/deploy-chancy-game");

describe("deployChancyGame", function () {
  it("deploys ChancyGame with provided USDC and entropy addresses", async function () {
    const [entropyProvider] = await hre.ethers.getSigners();

    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const MockEntropy = await hre.ethers.getContractFactory("MockEntropy");
    const entropy = await MockEntropy.deploy(entropyProvider.address);

    const deployment = await deployChancyGame({
      ethers: hre.ethers,
      entropyAddress: await entropy.getAddress(),
      usdcAddress: await usdc.getAddress(),
    });

    expect(deployment.contractAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(deployment.usdcAddress).to.equal(await usdc.getAddress());
    expect(deployment.entropyAddress).to.equal(await entropy.getAddress());
    expect(await deployment.contract.isAssetAllowed(await usdc.getAddress())).to.equal(true);
    expect(await deployment.contract.entropy()).to.equal(await entropy.getAddress());
  });

  it("requires explicit USDC and entropy addresses", async function () {
    await expect(deployChancyGame({ ethers: hre.ethers, entropyAddress: "", usdcAddress: "0x000000000000000000000000000000000000dEaD" }))
      .to.be.rejectedWith("PYTH_ENTROPY_ADDRESS is required");
    await expect(deployChancyGame({ ethers: hre.ethers, entropyAddress: "0x000000000000000000000000000000000000dEaD", usdcAddress: "" }))
      .to.be.rejectedWith("CHANCY_USDC_ADDRESS is required");
  });
});
