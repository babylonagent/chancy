const hre = require("hardhat");
const { deployChancyGame } = require("./deploy-chancy-game");

async function main() {
  const [deployer, entropyProvider] = await hre.ethers.getSigners();

  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  const MockEntropy = await hre.ethers.getContractFactory("MockEntropy");
  const entropy = await MockEntropy.deploy(entropyProvider.address);
  await entropy.waitForDeployment();

  const deployment = await deployChancyGame({
    ethers: hre.ethers,
    entropyAddress: await entropy.getAddress(),
    usdcAddress: await usdc.getAddress(),
  });

  const assetOk = await deployment.contract.isAssetAllowed(await usdc.getAddress());
  const entropyOk = await deployment.contract.entropy() === await entropy.getAddress();

  if (!assetOk || !entropyOk) {
    throw new Error("Smoke verification failed");
  }

  console.log(JSON.stringify({
    ok: true,
    network: hre.network.name,
    deployer: deployer.address,
    chancyGame: deployment.contractAddress,
    usdc: await usdc.getAddress(),
    entropy: await entropy.getAddress(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
