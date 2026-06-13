function requireAddress(name, value) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return value;
}

// Deploys ChancyGame. Sessions settle in native ETH or USDC; pass the USDC
// token address (USDC on Base in production) and the Pyth Entropy address.
async function deployChancyGame({ ethers, entropyAddress, usdcAddress }) {
  const entropy = requireAddress("PYTH_ENTROPY_ADDRESS", entropyAddress);
  const usdc = requireAddress("CHANCY_USDC_ADDRESS", usdcAddress);

  const ChancyGame = await ethers.getContractFactory("ChancyGame");
  const contract = await ChancyGame.deploy(entropy, usdc);
  await contract.waitForDeployment();

  return {
    contract,
    contractAddress: await contract.getAddress(),
    entropyAddress: entropy,
    usdcAddress: usdc,
  };
}

async function main() {
  const hre = require("hardhat");
  const deployment = await deployChancyGame({
    ethers: hre.ethers,
    entropyAddress: process.env.PYTH_ENTROPY_ADDRESS,
    usdcAddress: process.env.CHANCY_USDC_ADDRESS,
  });

  console.log(JSON.stringify({
    contract: "ChancyGame",
    address: deployment.contractAddress,
    entropyAddress: deployment.entropyAddress,
    usdcAddress: deployment.usdcAddress,
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
