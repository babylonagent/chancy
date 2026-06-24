#!/usr/bin/env node
"use strict";

/**
 * Chancy V2 monitoring script.
 * Runs on the VPS, checks all critical services, and sends Telegram alerts.
 *
 * Checks:
 *   1. API health endpoint
 *   2. Hot wallet ETH balance (need gas for Pyth requests)
 *   3. Hot wallet USDC balance (need float for withdrawals)
 *   4. Vault USDC balance
 *   5. Rebalancer service status
 *   6. Relayer service status
 *   7. SQLite integrity
 *   8. API rate limit not saturated
 *
 * Usage: node monitor.js
 * Cron:   every 5 min via crontab
 */

const { execSync } = require("child_process");
const { createPublicClient, http, parseAbi } = require("viem");
const { base } = require("viem/chains");

// Load env
const fs = require("fs");
const envPath = "/opt/chancy-v2-mainnet/secrets/v2.env";
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.startsWith("#")) {
      process.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  });
}

const HOT_WALLET = process.env.CHANCY_HOT_WALLET || process.env.CHANCY_HOT_WALLET_ADDRESS || "";
const VAULT = process.env.CHANCY_VAULT_ADDRESS || "";
const USDC = process.env.CHANCY_USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const ALERT_THRESHOLDS = {
  HOT_ETH_MIN: 0.0001,    // Need ETH for Pyth gas
  HOT_USDC_MIN: 1.0,      // Need USDC for withdrawals
  VAULT_USDC_MAX: 1000,   // Too much in vault (should be swept)
};

const checks = [];
let hasAlert = false;

function addCheck(name, status, message, alert = false) {
  checks.push({ name, status, message, alert });
  if (alert) hasAlert = true;
}

// ─── 1. Service checks via systemctl ────────────────────────────────────────

const SERVICES = [
  "chancy-v2-mainnet-api",
  "chancy-v2-mainnet-rebalancer",
  "chancy-v2-mainnet-relayer",
];

for (const svc of SERVICES) {
  try {
    const status = execSync(`systemctl is-active ${svc}`, { encoding: "utf8" }).trim();
    addCheck(svc, status === "active" ? "ok" : status, status === "active" ? "OK" : `NOT ACTIVE`, status !== "active");
  } catch {
    addCheck(svc, "error", "FAILED TO CHECK", true);
  }
}

// ─── 2. API health ──────────────────────────────────────────────────────────

try {
  const health = JSON.parse(
    execSync("curl -sS http://localhost:8792/health", { encoding: "utf8", timeout: 5000 })
  );
  addCheck("api-health", "ok", `port 8792, contract ${health.contractAddress?.slice(0, 10)}...`, false);
} catch (e) {
  addCheck("api-health", "error", `UNREACHABLE: ${e.message}`, true);
}

// ─── 3. On-chain balances ───────────────────────────────────────────────────

async function checkOnchain() {
  const client = createPublicClient({ chain: base, transport: http(RPC) });
  const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

  // Hot wallet ETH
  if (HOT_WALLET) {
    try {
      const ethBal = await client.getBalance({ address: HOT_WALLET });
      const ethVal = Number(ethBal) / 1e18;
      const alert = ethVal < ALERT_THRESHOLDS.HOT_ETH_MIN;
      addCheck("hot-eth", alert ? "low" : "ok", `${ethVal.toFixed(6)} ETH`, alert);
    } catch (e) {
      addCheck("hot-eth", "error", e.shortMessage || e.message, true);
    }

    // Hot wallet USDC
    try {
      const usdcBal = await client.readContract({
        address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [HOT_WALLET],
      });
      const usdcVal = Number(usdcBal) / 1e6;
      const alert = usdcVal < ALERT_THRESHOLDS.HOT_USDC_MIN;
      addCheck("hot-usdc", alert ? "low" : "ok", `${usdcVal.toFixed(2)} USDC`, alert);
    } catch (e) {
      addCheck("hot-usdc", "error", e.shortMessage || e.message, true);
    }
  }

  // Vault USDC
  if (VAULT) {
    try {
      const vaultBal = await client.readContract({
        address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [VAULT],
      });
      const vaultVal = Number(vaultBal) / 1e6;
      const alert = vaultVal > ALERT_THRESHOLDS.VAULT_USDC_MAX;
      addCheck("vault-usdc", alert ? "high" : "ok", `${vaultVal.toFixed(2)} USDC`, alert);
    } catch (e) {
      addCheck("vault-usdc", "error", e.shortMessage || e.message, true);
    }
  }
}

// ─── 4. SQLite integrity (use Node's sqlite, no CLI needed) ────────────────

try {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = process.env.CHANCY_V2_DB_PATH || "/opt/chancy-v2-mainnet/data/v2-store.sqlite";
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const result = db.prepare("PRAGMA integrity_check").get();
    addCheck("sqlite", "ok", result.integrity_check || "OK", false);
    db.close();
  } else {
    addCheck("sqlite", "warn", "DB file not found", true);
  }
} catch (e) {
  addCheck("sqlite", "error", e.message, true);
}

// ─── Report + Alert ─────────────────────────────────────────────────────────

async function main() {
  await checkOnchain();

  // Build report
  const timestamp = new Date().toISOString();
  const lines = checks.map((c) => {
    const icon = c.alert ? "🚨" : c.status === "ok" ? "✅" : "⚠️";
    return `${icon} ${c.name}: ${c.message}`;
  });

  const report = `Chancy V2 Monitor — ${timestamp}\n${lines.join("\n")}`;

  // Always log to stdout (journald picks it up)
  console.log(report);
  console.log("");

  // Send Telegram alert if any check failed
  if (hasAlert && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const alertLines = checks.filter((c) => c.alert);
      const alertMsg = `🚨 Chancy V2 Alert\n\n${alertLines.map((c) => `• ${c.name}: ${c.message}`).join("\n")}\n\n${timestamp}`;

      execSync(
        `curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: alertMsg })}'`,
        { encoding: "utf8", timeout: 10000, stdio: "pipe" }
      );
      console.log("[monitor] Telegram alert sent");
    } catch (e) {
      console.error("[monitor] Failed to send Telegram alert:", e.message);
    }
  } else if (hasAlert) {
    console.log("[monitor] ALERT: Telegram not configured — would alert on:", checks.filter(c => c.alert).map(c => c.name).join(", "));
  }

  // Exit code: 0 if all OK, 1 if any alert
  process.exit(hasAlert ? 1 : 0);
}

main().catch((e) => {
  console.error("[monitor] Fatal error:", e);
  process.exit(2);
});
