function requireAddress(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return value;
}

async function deployChancyGame({ ethers, gameTokenAddress, entropyAddress }) {
  const token = requireAddress("CHANCY_GAME_TOKEN_ADDRESS", gameTokenAddress);
  const entropy = requireAddress("PYTH_ENTROPY_ADDRESS", entropyAddress);

  const ChancyGame = await ethers.getContractFactory("ChancyGame");
  const contract = await ChancyGame.deploy(token, entropy);
  await contract.waitForDeployment();

  return {
    contract,
    contractAddress: await contract.getAddress(),
    gameTokenAddress: token,
    entropyAddress: entropy,
  };
}

async function main() {
  const hre = require("hardhat");
  const deployment = await deployChancyGame({
    ethers: hre.ethers,
    gameTokenAddress: process.env.CHANCY_GAME_TOKEN_ADDRESS,
    entropyAddress: process.env.PYTH_ENTROPY_ADDRESS,
  });

  console.log(JSON.stringify({
    contract: "ChancyGame",
    address: deployment.contractAddress,
    gameTokenAddress: deployment.gameTokenAddress,
    entropyAddress: deployment.entropyAddress,
    network: hre.network.name,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { deployChancyGame, requireAddress };
