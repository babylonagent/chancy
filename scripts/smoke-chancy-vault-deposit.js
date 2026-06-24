const { requireAddress } = require("./deploy-chancy-game");

const USDC_DECIMALS = 6n;
const DEFAULT_AMOUNT = 1_000_000n; // 1 USDC

async function main() {
  const hre = require("hardhat");
  const { ethers } = hre;
  const [player] = await ethers.getSigners();

  const vaultAddress = requireAddress("CHANCY_VAULT_ADDRESS", process.env.CHANCY_VAULT_ADDRESS);
  const usdcAddress = requireAddress("CHANCY_USDC_ADDRESS", process.env.CHANCY_USDC_ADDRESS);
  const amount = process.env.CHANCY_SMOKE_DEPOSIT_USDC
    ? ethers.parseUnits(process.env.CHANCY_SMOKE_DEPOSIT_USDC, Number(USDC_DECIMALS))
    : DEFAULT_AMOUNT;

  const vault = await ethers.getContractAt("ChancyVault", vaultAddress);
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);

  const beforeVaultBalance = await usdc.balanceOf(vaultAddress);
  const beforePlayerBalance = await usdc.balanceOf(player.address);
  const beforeControllerBalance = await usdc.balanceOf(await vault.owner());
  const beforeTotalDeposited = await vault.totalDeposited();
  const beforeTotalCredited = await vault.totalCredited();
  const beforeTotalFees = await vault.totalFeesCollected();

  if (beforePlayerBalance < amount) {
    throw new Error(`INSUFFICIENT_USDC: have ${beforePlayerBalance}, need ${amount}`);
  }

  const approveTx = await usdc.approve(vaultAddress, amount);
  await approveTx.wait(1);
  const depositTx = await vault.deposit(amount);
  const receipt = await depositTx.wait(1);

  const fee = amount * 500n / 10_000n;
  const credited = amount - fee;
  const afterVaultBalance = await usdc.balanceOf(vaultAddress);
  const afterPlayerBalance = await usdc.balanceOf(player.address);
  const afterControllerBalance = await usdc.balanceOf(await vault.owner());
  const afterTotalDeposited = await vault.totalDeposited();
  const afterTotalCredited = await vault.totalCredited();
  const afterTotalFees = await vault.totalFeesCollected();

  const checks = {
    vaultBalanceIncreasedByCredited: afterVaultBalance - beforeVaultBalance === credited,
    playerBalanceDecreasedByAmount: beforePlayerBalance - afterPlayerBalance === amount,
    controllerBalanceIncreasedByFee: afterControllerBalance - beforeControllerBalance === fee,
    totalDepositedIncreasedByAmount: afterTotalDeposited - beforeTotalDeposited === amount,
    totalCreditedIncreasedByCredited: afterTotalCredited - beforeTotalCredited === credited,
    totalFeesIncreasedByFee: afterTotalFees - beforeTotalFees === fee,
  };
  const ok = Object.values(checks).every(Boolean);

  console.log(JSON.stringify({
    ok,
    network: hre.network.name,
    player: player.address,
    vault: vaultAddress,
    amount: amount.toString(),
    credited: credited.toString(),
    fee: fee.toString(),
    approveTx: approveTx.hash,
    depositTx: depositTx.hash,
    blockNumber: receipt.blockNumber,
    checks,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
