/**
 * Deploy ChancySettlementV3 to Base Sepolia.
 *
 * Usage:
 *   set -a; source /root/.babylon/secrets/rpc.env; source /root/.chancy/secrets/sandbox-wallet.env; set +a
 *   node scripts/deploy-v3-sepolia.js
 */
const { ethers } = require("ethers");

async function main() {
  const PRIVATE_KEY = process.env.SANDBOX_WALLET_PRIVATE_KEY;
  const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  if (!PRIVATE_KEY) throw new Error("SANDBOX_WALLET_PRIVATE_KEY not set");

  const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(
    PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY,
    provider
  );

  console.log("=== Chancy V3 Sepolia Deployment ===");
  console.log("Deployer:", deployer.address);
  console.log("USDC:", USDC_SEPOLIA);

  const balance = await provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance < ethers.parseEther("0.001")) {
    throw new Error("Insufficient ETH for gas");
  }

  // Load compiled artifact
  const artifact = require("../artifacts/contracts/ChancySettlementV3.sol/ChancySettlementV3.json");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  console.log("Deploying ChancySettlementV3...");
  const settlement = await factory.deploy(USDC_SEPOLIA, deployer.address, deployer.address);
  await settlement.waitForDeployment();
  const addr = await settlement.getAddress();
  console.log("ChancySettlementV3 deployed to:", addr);
  console.log("Owner:", deployer.address);
  console.log("Settler:", deployer.address);
  console.log("USDC:", USDC_SEPOLIA);
  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log("Contract address:", addr);
  console.log("Basescan:", `https://sepolia.basescan.org/address/${addr}`);
  console.log("\nAdd to .env:");
  console.log(`CHANCY_V3_SETTLEMENT_ADDRESS=${addr}`);
  console.log(`VITE_CHANCY_V3_SETTLEMENT_ADDRESS=${addr}`);

  return addr;
}

main()
  .then((addr) => process.exit(0))
  .catch((err) => {
    console.error("Deploy failed:", err);
    process.exit(1);
  });