#!/usr/bin/env node
"use strict";

/**
 * Chancy V2 hot-wallet rebalancer.
 *
 * Keeps the hot wallet (payout liquidity) topped up by sweeping USDC from the
 * vault contract when the hot balance drops below a target threshold.
 *
 * Loop:
 *   1. Read vault USDC balance + hot wallet USDC balance (on-chain)
 *   2. If hot < HOT_TARGET, compute needed = HOT_TARGET - hot
 *   3. Sweep min(needed, vaultBalance) via vault.sweepToHot() from hot wallet
 *   4. Wait REBALANCE_INTERVAL_MS, repeat
 *
 * Safety:
 *   - Fails closed: refuses to start without HOT_WALLET_PRIVATE_KEY, VAULT_ADDRESS,
 *     USDC address, RPC URL.
 *   - Never sweeps more than the vault actually holds.
 *   - Per-call try/catch: transient RPC failures don't crash the process.
 *   - Logs every action with timestamps for audit.
 *
 * Env:
 *   CHANCY_VAULT_ADDRESS           vault contract address
 *   CHANCY_HOT_WALLET_PRIVATE_KEY  hot wallet key (authorized caller for sweepToHot)
 *   CHANCY_USDC_ADDRESS            ERC-20 USDC on the target chain
 *   CHANCY_RPC_URL | BASE_RPC_URL  RPC endpoint
 *   CHANCY_REBALANCE_INTERVAL_MS   poll interval (default 300000 = 5 min)
 *   CHANCY_REBALANCE_HOT_TARGET    hot wallet target in human USDC (default 50)
 *   CHANCY_REBALANCE_ONCE          "1" to run a single pass and exit
 */

const {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { base, baseSepolia } = require("viem/chains");

const VAULT_ABI = parseAbi([
  "function sweepToHot(uint256 amount)",
  "function hotWallet() view returns (address)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

function requireEnv(name, fallbacks = []) {
  for (const key of [name, ...fallbacks]) {
    if (process.env[key]) return process.env[key];
  }
  throw new Error(`MISSING_ENV:${name}`);
}

function buildConfig() {
  const vaultAddress = requireEnv("CHANCY_VAULT_ADDRESS");
  const privateKey = requireEnv("CHANCY_HOT_WALLET_PRIVATE_KEY");
  const usdcAddress = requireEnv("CHANCY_USDC_ADDRESS");
  const rpcUrl = requireEnv("CHANCY_RPC_URL", ["BASE_RPC_URL"]);
  const chainName = (process.env.CHANCY_RELAYER_CHAIN || "base").toLowerCase();
  const chain = chainName === "base" ? base : baseSepolia;
  const intervalMs = Number(process.env.CHANCY_REBALANCE_INTERVAL_MS || 300000);
  const hotTarget = Number(process.env.CHANCY_REBALANCE_HOT_TARGET || 50);
  const once = process.env.CHANCY_REBALANCE_ONCE === "1";
  return { vaultAddress, privateKey, usdcAddress, rpcUrl, chain, intervalMs, hotTarget, once };
}

function ts() {
  return new Date().toISOString();
}

function formatUsdc(wei) {
  return (Number(wei) / 1e6).toFixed(2);
}

async function runPass(ctx) {
  const { cfg, publicClient, walletClient, account } = ctx;
  const { vaultAddress, usdcAddress, hotTarget } = cfg;

  const vaultBal = await publicClient.readContract({
    address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [vaultAddress],
  });
  const hotBal = await publicClient.readContract({
    address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address],
  });

  const targetWei = BigInt(Math.round(hotTarget * 1e6));

  console.log(`[rebalance] ${ts()} vault=${formatUsdc(vaultBal)} hot=${formatUsdc(hotBal)} target=${hotTarget.toFixed(2)}`);

  if (hotBal >= targetWei) {
    console.log(`[rebalance] hot wallet above target — no action`);
    return { action: "noop", vaultBal, hotBal };
  }

  const needed = targetWei - hotBal;
  const sweepAmount = vaultBal < needed ? vaultBal : needed;

  if (sweepAmount <= 0n) {
    console.warn(`[rebalance] vault empty — cannot sweep`);
    return { action: "empty", vaultBal, hotBal };
  }

  console.log(`[rebalance] sweeping ${formatUsdc(sweepAmount)} USDC vault→hot`);

  const txHash = await walletClient.writeContract({
    address: vaultAddress,
    abi: VAULT_ABI,
    functionName: "sweepToHot",
    args: [sweepAmount],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });

  if (receipt.status !== "success") {
    console.error(`[rebalance] sweep tx reverted: ${txHash}`);
    return { action: "reverted", txHash };
  }

  console.log(`[rebalance] sweep confirmed tx=${txHash} amount=${formatUsdc(sweepAmount)}`);
  return { action: "swept", txHash, amount: sweepAmount.toString() };
}

async function main() {
  const cfg = buildConfig();
  const account = privateKeyToAccount(
    cfg.privateKey.startsWith("0x") ? cfg.privateKey : `0x${cfg.privateKey}`
  );
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.chain, transport });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport });

  console.log(`[rebalance] hot=${account.address} vault=${cfg.vaultAddress} chain=${cfg.chain.name} target=${cfg.hotTarget} interval=${cfg.intervalMs}ms`);

  const ctx = { cfg, publicClient, walletClient, account };

  if (cfg.once) {
    const result = await runPass(ctx);
    console.log(`[rebalance] single pass done: ${JSON.stringify(result, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    return;
  }

  // Long-lived poll loop.
  while (true) {
    try {
      await runPass(ctx);
    } catch (err) {
      console.error(`[rebalance] ${ts()} pass failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[rebalance] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runPass, buildConfig };
