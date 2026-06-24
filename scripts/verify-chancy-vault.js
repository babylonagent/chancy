const { requireAddress } = require("./deploy-chancy-game");

async function verifyChancyVault({ ethers, vaultAddress, usdcAddress, controllerAddress, hotWalletAddress, coldWalletAddress }) {
  const vault = requireAddress("CHANCY_VAULT_ADDRESS", vaultAddress);
  const expectedUsdc = requireAddress("CHANCY_USDC_ADDRESS", usdcAddress).toLowerCase();
  const expectedController = requireAddress("CHANCY_CONTROLLER_ADDRESS", controllerAddress).toLowerCase();
  const expectedHot = requireAddress("CHANCY_HOT_WALLET_ADDRESS", hotWalletAddress).toLowerCase();
  const expectedCold = requireAddress("CHANCY_COLD_WALLET_ADDRESS", coldWalletAddress).toLowerCase();

  const contract = await ethers.getContractAt("ChancyVault", vault);
  const [owner, usdc, hotWallet, coldWallet, depositFeeBps, maxDepositFeeBps] = await Promise.all([
    contract.owner(),
    contract.usdc(),
    contract.hotWallet(),
    contract.coldWallet(),
    contract.depositFeeBps(),
    contract.MAX_DEPOSIT_FEE_BPS(),
  ]);

  const checks = {
    ownerMatches: owner.toLowerCase() === expectedController,
    usdcMatches: usdc.toLowerCase() === expectedUsdc,
    hotWalletMatches: hotWallet.toLowerCase() === expectedHot,
    coldWalletMatches: coldWallet.toLowerCase() === expectedCold,
    feeIs500: depositFeeBps.toString() === "500",
    maxFeeIs500: maxDepositFeeBps.toString() === "500",
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, vault, owner, usdc, hotWallet, coldWallet, depositFeeBps: depositFeeBps.toString(), maxDepositFeeBps: maxDepositFeeBps.toString(), checks };
}

async function main() {
  const hre = require("hardhat");
  const result = await verifyChancyVault({
    ethers: hre.ethers,
    vaultAddress: process.env.CHANCY_VAULT_ADDRESS,
    usdcAddress: process.env.CHANCY_USDC_ADDRESS,
    controllerAddress: process.env.CHANCY_CONTROLLER_ADDRESS,
    hotWalletAddress: process.env.CHANCY_HOT_WALLET_ADDRESS,
    coldWalletAddress: process.env.CHANCY_COLD_WALLET_ADDRESS,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { verifyChancyVault };
