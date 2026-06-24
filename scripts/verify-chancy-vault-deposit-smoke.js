const { requireAddress } = require("./deploy-chancy-game");

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const vaultAddress = requireAddress("CHANCY_VAULT_ADDRESS", process.env.CHANCY_VAULT_ADDRESS);
  const usdcAddress = requireAddress("CHANCY_USDC_ADDRESS", process.env.CHANCY_USDC_ADDRESS);
  const txHash = process.env.CHANCY_DEPOSIT_TX;
  const vault = await ethers.getContractAt("ChancyVault", vaultAddress);
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);
  const receipt = txHash ? await ethers.provider.getTransactionReceipt(txHash) : null;
  const deposits = txHash ? await vault.queryFilter(vault.filters.Deposited(), receipt.blockNumber, receipt.blockNumber) : [];
  const owner = await vault.owner();
  const result = {
    network: hre.network.name,
    vault: vaultAddress,
    txStatus: receipt ? receipt.status : null,
    txBlock: receipt ? receipt.blockNumber : null,
    depositEvents: deposits.map((e) => ({ player: e.args.player, grossAmount: e.args.grossAmount.toString(), creditedAmount: e.args.creditedAmount.toString(), feeAmount: e.args.feeAmount.toString(), txHash: e.transactionHash })),
    vaultUsdcBalance: (await usdc.balanceOf(vaultAddress)).toString(),
    controller: owner,
    controllerUsdcBalance: (await usdc.balanceOf(owner)).toString(),
    totalDeposited: (await vault.totalDeposited()).toString(),
    totalCredited: (await vault.totalCredited()).toString(),
    totalFeesCollected: (await vault.totalFeesCollected()).toString(),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!receipt || receipt.status !== 1 || deposits.length < 1) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
