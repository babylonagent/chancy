#!/usr/bin/env node
"use strict";

/**
 * Chancy V2 auto-payout relayer.
 *
 * Closes the gap between a withdrawal REQUEST (which records a pending payout in
 * the ledger) and the actual on-chain USDC transfer. Without this, mark-paid is
 * a manual step — players would never get paid automatically.
 *
 * Loop:
 *   1. GET  /v2/admin/withdrawals?status=pending   (bearer-protected)
 *   2. For each pending withdrawal: send `payoutAmount` USDC from the hot wallet
 *      to `destination` on-chain, wait for confirmation.
 *   3. POST /v2/withdrawals/:id/mark-paid { txHash }  (debits gross from ledger)
 *
 * Safety:
 *   - Fails closed: refuses to start without HOT_WALLET_PRIVATE_KEY, ADMIN_TOKEN,
 *     USDC address, RPC URL, and API base.
 *   - Idempotent: mark-paid 409s on already-paid rows; we treat that as success.
 *   - Per-withdrawal try/catch: one bad payout never stalls the queue.
 *   - Balance preflight: skips (and logs) if the hot wallet can't cover a payout.
 *
 * Env:
 *   CHANCY_API_BASE              e.g. http://127.0.0.1:8788
 *   CHANCY_ADMIN_TOKEN           shared secret with the API
 *   CHANCY_HOT_WALLET_PRIVATE_KEY  0x-prefixed key funded with USDC + gas
 *   CHANCY_USDC_ADDRESS          ERC-20 USDC on the target chain
 *   CHANCY_RPC_URL | BASE_RPC_URL | BASE_SEPOLIA_RPC_URL
 *   CHANCY_RELAYER_INTERVAL_MS   poll interval (default 15000)
 *   CHANCY_RELAYER_CHAIN         "base" | "base-sepolia" (default base-sepolia)
 *   CHANCY_RELAYER_ONCE          "1" to run a single pass and exit (for tests/CI)
 */

const {
  createWalletClient,
  createPublicClient,
  http,
  getContract,
  parseAbi,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { base, baseSepolia } = require("viem/chains");

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

function requireEnv(name, fallbacks = []) {
  for (const key of [name, ...fallbacks]) {
    if (process.env[key]) return process.env[key];
  }
  throw new Error(`MISSING_ENV:${name}`);
}

function buildConfig() {
  const apiBase = requireEnv("CHANCY_API_BASE").replace(/\/+$/, "");
  const adminToken = requireEnv("CHANCY_ADMIN_TOKEN");
  const privateKey = requireEnv("CHANCY_HOT_WALLET_PRIVATE_KEY");
  const usdcAddress = requireEnv("CHANCY_USDC_ADDRESS");
  const rpcUrl = requireEnv("CHANCY_RPC_URL", ["BASE_RPC_URL", "BASE_SEPOLIA_RPC_URL"]);
  const chainName = (process.env.CHANCY_RELAYER_CHAIN || "base-sepolia").toLowerCase();
  const chain = chainName === "base" ? base : baseSepolia;
  const intervalMs = Number(process.env.CHANCY_RELAYER_INTERVAL_MS || 15000);
  const once = process.env.CHANCY_RELAYER_ONCE === "1";
  return { apiBase, adminToken, privateKey, usdcAddress, rpcUrl, chain, intervalMs, once };
}

async function fetchPending({ apiBase, adminToken }) {
  const res = await fetch(`${apiBase}/v2/admin/withdrawals?status=pending`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`ADMIN_LIST_FAILED:${res.status}`);
  const body = await res.json();
  return Array.isArray(body.withdrawals) ? body.withdrawals : [];
}

async function markPaid({ apiBase, adminToken, withdrawalId, txHash }) {
  const res = await fetch(`${apiBase}/v2/withdrawals/${withdrawalId}/mark-paid`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ txHash }),
  });
  if (res.status === 409) return { ok: true, alreadyPaid: true };
  if (!res.ok) throw new Error(`MARK_PAID_FAILED:${res.status}`);
  return { ok: true, withdrawal: await res.json() };
}

async function runPass(ctx) {
  const { cfg, publicClient, walletClient, usdc, account } = ctx;
  const pending = await fetchPending(cfg);
  if (pending.length === 0) {
    console.log(`[relayer] no pending withdrawals`);
    return { processed: 0, paid: 0, skipped: 0 };
  }
  console.log(`[relayer] ${pending.length} pending withdrawal(s)`);
  let paid = 0;
  let skipped = 0;
  for (const w of pending) {
    const amount = BigInt(w.payoutAmount);
    try {
      const balance = await usdc.read.balanceOf([account.address]);
      if (balance < amount) {
        console.warn(`[relayer] SKIP ${w.withdrawalId}: hot wallet USDC ${balance} < payout ${amount}`);
        skipped += 1;
        continue;
      }
      const txHash = await walletClient.writeContract({
        address: cfg.usdcAddress,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [w.destination, amount],
      });
      console.log(`[relayer] sent ${amount} USDC -> ${w.destination} tx=${txHash} (${w.withdrawalId})`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      if (receipt.status !== "success") {
        console.error(`[relayer] tx reverted ${txHash} (${w.withdrawalId}) — leaving pending`);
        skipped += 1;
        continue;
      }
      const result = await markPaid({ apiBase: cfg.apiBase, adminToken: cfg.adminToken, withdrawalId: w.withdrawalId, txHash });
      console.log(`[relayer] PAID ${w.withdrawalId}${result.alreadyPaid ? " (already)" : ""}`);
      paid += 1;
    } catch (err) {
      console.error(`[relayer] ERROR ${w.withdrawalId}: ${err.message}`);
      skipped += 1;
    }
  }
  return { processed: pending.length, paid, skipped };
}

async function main() {
  const cfg = buildConfig();
  const account = privateKeyToAccount(cfg.privateKey.startsWith("0x") ? cfg.privateKey : `0x${cfg.privateKey}`);
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.chain, transport });
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport });
  const usdc = getContract({ address: cfg.usdcAddress, abi: ERC20_ABI, client: publicClient });

  console.log(`[relayer] hot wallet=${account.address} chain=${cfg.chain.name} api=${cfg.apiBase} interval=${cfg.intervalMs}ms once=${cfg.once}`);
  const ctx = { cfg, publicClient, walletClient, usdc, account };

  if (cfg.once) {
    const summary = await runPass(ctx);
    console.log(`[relayer] single pass done: ${JSON.stringify(summary)}`);
    return;
  }

  // Long-lived poll loop. Each pass is isolated; a transient failure logs and
  // retries on the next tick rather than crashing the process.
  /* eslint-disable no-constant-condition */
  while (true) {
    try {
      await runPass(ctx);
    } catch (err) {
      console.error(`[relayer] pass failed: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.intervalMs));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[relayer] fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runPass, fetchPending, markPaid, buildConfig };
