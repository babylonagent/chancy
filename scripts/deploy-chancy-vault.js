const { requireAddress } = require("./deploy-chancy-game");

async function deployChancyVault({ ethers, usdcAddress, controllerAddress, hotWalletAddress, coldWalletAddress }) {
  const usdc = requireAddress("CHANCY_USDC_ADDRESS", usdcAddress);
  const controller = requireAddress("CHANCY_CONTROLLER_ADDRESS", controllerAddress);
  const hotWallet = requireAddress("CHANCY_HOT_WALLET_ADDRESS", hotWalletAddress);
  const coldWallet = requireAddress("CHANCY_COLD_WALLET_ADDRESS", coldWalletAddress);

  const ChancyVault = await ethers.getContractFactory("ChancyVault");
  const contract = await ChancyVault.deploy(usdc, controller, hotWallet, coldWallet);
  await contract.waitForDeployment();

  return {
    contract,
    contractAddress: await contract.getAddress(),
    usdcAddress: usdc,
    controllerAddress: controller,
    hotWalletAddress: hotWallet,
    coldWalletAddress: coldWallet,
  };
}

async function main() {
  const hre = require("hardhat");
  const [deployer] = await hre.ethers.getSigners();
  const deployment = await deployChancyVault({
    ethers: hre.ethers,
    usdcAddress: process.env.CHANCY_USDC_ADDRESS,
    controllerAddress: process.env.CHANCY_CONTROLLER_ADDRESS,
    hotWalletAddress: process.env.CHANCY_HOT_WALLET_ADDRESS,
    coldWalletAddress: process.env.CHANCY_COLD_WALLET_ADDRESS,
  });

  const feeBps = await deployment.contract.depositFeeBps();
  console.log(JSON.stringify({
    contract: "ChancyVault",
    address: deployment.contractAddress,
    network: hre.network.name,
    deployer: deployer.address,
    usdcAddress: deployment.usdcAddress,
    controllerAddress: deployment.controllerAddress,
    hotWalletAddress: deployment.hotWalletAddress,
    coldWalletAddress: deployment.coldWalletAddress,
    depositFeeBps: feeBps.toString(),
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { deployChancyVault };
