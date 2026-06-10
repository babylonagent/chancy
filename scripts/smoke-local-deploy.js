const hre = require("hardhat");
const { deployChancyGame } = require("./deploy-chancy-game");

async function main() {
  const [deployer, entropyProvider] = await hre.ethers.getSigners();

  const MockGameToken = await hre.ethers.getContractFactory("MockGameToken");
  const token = await MockGameToken.deploy();
  await token.waitForDeployment();

  const MockEntropy = await hre.ethers.getContractFactory("MockEntropy");
  const entropy = await MockEntropy.deploy(entropyProvider.address);
  await entropy.waitForDeployment();

  const deployment = await deployChancyGame({
    ethers: hre.ethers,
    gameTokenAddress: await token.getAddress(),
    entropyAddress: await entropy.getAddress(),
  });

  const tokenOk = await deployment.contract.gameToken() === await token.getAddress();
  const entropyOk = await deployment.contract.entropy() === await entropy.getAddress();

  if (!tokenOk || !entropyOk) {
    throw new Error("Smoke verification failed");
  }

  console.log(JSON.stringify({
    ok: true,
    network: hre.network.name,
    deployer: deployer.address,
    chancyGame: deployment.contractAddress,
    gameToken: await token.getAddress(),
    entropy: await entropy.getAddress(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
