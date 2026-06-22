import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import { installV2Routes, deriveBoard } from "./v2.js";

// Deterministic mock verifier: simulates the on-chain Deposited event without
// network access. Maps txHash -> the verified on-chain result the real
// viem-backed verifier would return.
function mockVerifier(ledger) {
  return async ({ txHash }) => {
    const rec = ledger[txHash.toLowerCase()];
    if (!rec) throw new Error("DEPOSIT_NOT_FOUND");
    return rec;
  };
}

const PLAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const DEST = "0x3333333333333333333333333333333333333333";
const TX1 = "0x" + "a".repeat(64);
const TX2 = "0x" + "b".repeat(64);
const ENTROPY = "0x" + "c".repeat(64);

function engineApp(verifyDeposit) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  installV2Routes(app, { storePath: "", verifyDeposit });
  return app;
}

// The board is deterministic from (entropy, sessionId, player, mode), and
// deriveBoard is exported — so a test can compute the exact prize/bomb layout
// and play a guaranteed win. This is also the fairness-verification primitive
// players will use to audit a finished session.
function computeBoard(sessionId, player, mode) {
  return deriveBoard({ entropy: ENTROPY, sessionId, player, mode });
}

describe("V2 credit engine money core", () => {
  let app;
  let ledger;
  beforeEach(() => {
    ledger = {
      [TX1.toLowerCase()]: { player: PLAYER, grossAmount: "1000000", creditedAmount: "950000", feeAmount: "50000" },
      [TX2.toLowerCase()]: { player: PLAYER, grossAmount: "2000000", creditedAmount: "1900000", feeAmount: "100000" },
    };
    app = engineApp(mockVerifier(ledger));
  });

  it("credits the on-chain net amount, never a client-claimed value", async () => {
    const res = await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX1 });
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe("950000");
    expect(res.body.balance).toBe("950000");
    expect(res.body.idempotent).toBe(false);
  });

  it("is idempotent: replaying the same txHash never double-credits", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX1 });
    const res = await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX1 });
    expect(res.body.idempotent).toBe(true);
    expect(res.body.balance).toBe("950000");
  });

  it("rejects an unverifiable deposit (the $1-vanished bug class) with zero credit", async () => {
    const res = await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: "0x" + "f".repeat(64) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("DEPOSIT_NOT_FOUND");
    const bal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(bal.body.balance).toBe("0");
  });

  it("rejects a deposit whose on-chain player != claimed player", async () => {
    const res = await request(app).post("/v2/credits/deposit").send({ player: OTHER, txHash: TX1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("DEPOSIT_PLAYER_MISMATCH");
  });

  it("plays a guaranteed winning session and pays the pot back to credits", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 }); // 1,900,000
    const stake = "50000"; // $0.05
    const create = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Hardcore", stake, entropy: ENTROPY });
    expect(create.status).toBe(200);
    const sessionId = create.body.sessionId;

    const afterDebit = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(afterDebit.body.balance).toBe("1850000"); // 1,900,000 - 50,000

    // Compute the real board and click only the prize tiles → guaranteed win.
    const board = computeBoard(sessionId, PLAYER, "Hardcore");
    let payout = "0";
    let status = "active";
    for (const tile of board.prizePositions) {
      const click = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile });
      status = click.body.status;
      payout = click.body.payout;
    }
    expect(status).toBe("won");
    expect(payout).toBe("250000"); // 50,000 * 5.0x Hardcore

    const finalBal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(finalBal.body.balance).toBe("2100000"); // 1,850,000 + 250,000
  });

  it("forfeits stake on 3 bombs and pays nothing", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const stake = "50000";
    const create = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Normal", stake, entropy: ENTROPY });
    const sessionId = create.body.sessionId;
    const board = computeBoard(sessionId, PLAYER, "Normal");

    let status = "active";
    for (const tile of board.bombPositions.slice(0, 3)) {
      const click = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile });
      status = click.body.status;
    }
    expect(status).toBe("lost");
    const finalBal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(finalBal.body.balance).toBe("1850000"); // stake forfeited, no payout
  });

  it("blocks a session when credits are insufficient", async () => {
    const res = await request(app).post("/v2/sessions").send({ player: OTHER, host: OTHER, mode: "Easy", stake: "100", entropy: ENTROPY });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("INSUFFICIENT_CREDITS");
  });

  it("withdrawal reserves withdrawable immediately and deducts balance on mark-paid", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX1 }); // 950,000
    const wd = await request(app).post("/v2/withdrawals/request").send({ player: PLAYER, amount: "100000", destination: DEST });
    expect(wd.body.payoutAmount).toBe("95000");
    expect(wd.body.feeAmount).toBe("5000");

    const afterReq = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(afterReq.body.balance).toBe("950000"); // total unchanged
    expect(afterReq.body.withdrawable).toBe("850000"); // gross reserved

    const paid = await request(app).post(`/v2/withdrawals/${wd.body.withdrawalId}/mark-paid`).send({ txHash: TX2 });
    expect(paid.body.status).toBe("paid");

    const afterPaid = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(afterPaid.body.balance).toBe("850000"); // gross deducted on payout
  });

  it("idempotent tile clicks never double-charge or double-pay", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const create = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Normal", stake: "50000", entropy: ENTROPY });
    const sessionId = create.body.sessionId;
    const first = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile: 7 });
    const repeat = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile: 7 });
    expect(repeat.body).toEqual(first.body);
  });
});
