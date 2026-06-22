import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cors from "cors";
import { installV2Routes } from "./v2.js";
import { runPass } from "../../scripts/payout-relayer.js";

// Mock on-chain verifier (same shape as v2.test.js): txHash -> Deposited event.
function mockVerifier(ledger) {
  return async ({ txHash }) => {
    const rec = ledger[txHash.toLowerCase()];
    if (!rec) throw new Error("DEPOSIT_NOT_FOUND");
    return rec;
  };
}

const PLAYER = "0x1111111111111111111111111111111111111111";
const DEST = "0x3333333333333333333333333333333333333333";
const HOT = "0x4444444444444444444444444444444444444444";
const TX1 = "0x" + "a".repeat(64);
const PAYOUT_TX = "0x" + "e".repeat(64);
const ADMIN_TOKEN = "test-admin-token";

// Spin up the real V2 API on an ephemeral port so the relayer can hit it over
// HTTP exactly as it will in production (fetch against CHANCY_API_BASE).
function startApi() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  const ledger = {
    [TX1.toLowerCase()]: { player: PLAYER, grossAmount: "1000000", creditedAmount: "950000", feeAmount: "50000" },
  };
  installV2Routes(app, { storePath: "", verifyDeposit: mockVerifier(ledger), adminToken: ADMIN_TOKEN });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

// Mock on-chain layer: records transfers, returns a fixed tx hash, reports a
// hot-wallet balance we control to exercise the underfunded-skip path.
function mockChain({ balance = 10_000_000n } = {}) {
  const sent = [];
  return {
    sent,
    account: { address: HOT },
    walletClient: {
      writeContract: async ({ args }) => {
        sent.push({ to: args[0], amount: args[1] });
        return PAYOUT_TX;
      },
    },
    publicClient: {
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
    usdc: {
      read: { balanceOf: async () => balance },
    },
  };
}

describe("V2 auto-payout relayer", () => {
  let api;
  let cfg;
  beforeEach(async () => {
    api = await startApi();
    cfg = { apiBase: `http://127.0.0.1:${api.port}`, adminToken: ADMIN_TOKEN, usdcAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" };
  });
  afterEach(() => {
    api.server.close();
  });

  async function postJson(path, body) {
    const res = await fetch(`${cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("admin endpoint requires the bearer token", async () => {
    const noauth = await fetch(`${cfg.apiBase}/v2/admin/withdrawals?status=pending`);
    expect(noauth.status).toBe(401);
    const ok = await fetch(`${cfg.apiBase}/v2/admin/withdrawals?status=pending`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it("pays a pending withdrawal on-chain then marks it paid (gross debited)", async () => {
    await postJson("/v2/credits/deposit", { player: PLAYER, txHash: TX1 }); // 950,000 net
    const wd = await postJson("/v2/withdrawals/request", { player: PLAYER, amount: "100000", destination: DEST });
    expect(wd.body.payoutAmount).toBe("95000");

    const chain = mockChain();
    const summary = await runPass({ cfg, ...chain });

    expect(summary).toEqual({ processed: 1, paid: 1, skipped: 0 });
    // Relayer sent exactly the NET payout (95,000) to the destination.
    expect(chain.sent).toEqual([{ to: DEST, amount: 95000n }]);

    // Ledger reflects gross (100,000) debited, withdrawal now paid.
    const bal = await (await fetch(`${cfg.apiBase}/v2/credits/${PLAYER}`)).json();
    expect(bal.balance).toBe("850000");
    const list = await (await fetch(`${cfg.apiBase}/v2/admin/withdrawals?status=paid`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })).json();
    expect(list.count).toBe(1);
    expect(list.withdrawals[0].txHash).toBe(PAYOUT_TX);
  });

  it("skips (leaves pending) when the hot wallet is underfunded", async () => {
    await postJson("/v2/credits/deposit", { player: PLAYER, txHash: TX1 });
    await postJson("/v2/withdrawals/request", { player: PLAYER, amount: "100000", destination: DEST });

    const chain = mockChain({ balance: 1n }); // can't cover 95,000
    const summary = await runPass({ cfg, ...chain });

    expect(summary).toEqual({ processed: 1, paid: 0, skipped: 1 });
    expect(chain.sent).toEqual([]);
    const stillPending = await (await fetch(`${cfg.apiBase}/v2/admin/withdrawals?status=pending`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })).json();
    expect(stillPending.count).toBe(1);
  });

  it("is a no-op when there are no pending withdrawals", async () => {
    const chain = mockChain();
    const summary = await runPass({ cfg, ...chain });
    expect(summary).toEqual({ processed: 0, paid: 0, skipped: 0 });
  });
});
