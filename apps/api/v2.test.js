import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { installV2Routes, deriveBoard, computeCommitment } from "./v2.js";

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
const SALT = "0x" + "d".repeat(64);

// Mock entropy requester: simulates on-chain Pyth Entropy by passing the
// userRandomNumber through as the randomNumber. This keeps deriveBoard
// deterministic for test board computation (computeBoard uses ENTROPY directly,
// and the mock returns ENTROPY as the Pyth result → same board).
function mockRequestEntropy() {
  let seq = 0n;
  return async (userRandomNumber) => {
    seq += 1n;
    return {
      sequenceNumber: seq,
      randomNumber: userRandomNumber,
      txHash: "0x" + "e".repeat(64),
    };
  };
}

function engineApp(verifyDeposit, requestEntropy = mockRequestEntropy()) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  installV2Routes(app, { storePath: "", verifyDeposit, requestEntropy });
  return app;
}

// The board is deterministic from (entropy, sessionId, player, mode), and
// deriveBoard is exported — so a test can compute the exact prize/bomb layout
// and play a guaranteed win. This is also the fairness-verification primitive
// players will use to audit a finished session.
function computeBoard(sessionId, player, mode) {
  return deriveBoard({ entropy: ENTROPY, sessionId, player, mode });
}

// C39 two-phase helper: commit (stake debited, board hidden) then reveal.
async function createSession(app, { player, host, mode, stake, entropy = ENTROPY, salt = SALT }) {
  const commitment = computeCommitment(entropy, salt);
  const commit = await request(app).post("/v2/sessions").send({ player, host, mode, stake, commitment });
  expect(commit.status).toBe(200);
  expect(commit.body.status).toBe("committed");
  const sessionId = commit.body.sessionId;
  const reveal = await request(app).post(`/v2/sessions/${sessionId}/reveal`).send({ player, entropy, salt });
  expect(reveal.status).toBe(200);
  expect(reveal.body.status).toBe("active");
  return { sessionId, boardCommitHash: reveal.body.boardCommitHash };
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
    const { sessionId } = await createSession(app, { player: PLAYER, host: PLAYER, mode: "Hardcore", stake });

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
    expect(payout).toBe("435000"); // 50,000 * 8.7x Hardcore

    const finalBal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(finalBal.body.balance).toBe("2285000"); // 1,850,000 + 435,000
  });

  it("forfeits stake on 3 bombs and pays nothing", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const stake = "50000";
    const { sessionId } = await createSession(app, { player: PLAYER, host: PLAYER, mode: "Normal", stake });
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
    const commitment = computeCommitment(ENTROPY, SALT);
    const res = await request(app).post("/v2/sessions").send({ player: OTHER, host: OTHER, mode: "Easy", stake: "50000", commitment });
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
    const { sessionId } = await createSession(app, { player: PLAYER, host: PLAYER, mode: "Normal", stake: "50000" });
    const first = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile: 7 });
    const repeat = await request(app).post(`/v2/sessions/${sessionId}/click`).send({ player: PLAYER, tile: 7 });
    expect(repeat.body).toEqual(first.body);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C39 — COMMIT-REVEAL FAIRNESS
// ───────────────────────────────────────────────────────────────────────────
describe("C39 commit-reveal fairness", () => {
  let app;
  let ledger;
  beforeEach(() => {
    ledger = {
      [TX2.toLowerCase()]: { player: PLAYER, grossAmount: "2000000", creditedAmount: "1900000", feeAmount: "100000" },
    };
    app = engineApp(mockVerifier(ledger));
  });

  it("commit debits the stake but does NOT reveal the board (status=committed)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    expect(commit.status).toBe(200);
    expect(commit.body.status).toBe("committed");
    expect(commit.body.sessionId).toBeTruthy();
    expect(commit.body.boardCommitHash).toBeUndefined(); // board not derived yet
    // Stake was debited.
    const bal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(bal.body.balance).toBe("1850000");
  });

  it("reveal with the correct entropy+salt activates the session and derives the board", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    const sessionId = commit.body.sessionId;
    const reveal = await request(app).post(`/v2/sessions/${sessionId}/reveal`).send({ player: PLAYER, entropy: ENTROPY, salt: SALT });
    expect(reveal.status).toBe(200);
    expect(reveal.body.status).toBe("active");
    expect(reveal.body.boardCommitHash).toBeTruthy();
    // Balance unchanged by reveal (stake already debited at commit).
    const bal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(bal.body.balance).toBe("1850000");
  });

  it("rejects a reveal with the wrong salt (COMMITMENT_MISMATCH)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    const wrongSalt = "0x" + "e".repeat(64);
    const reveal = await request(app).post(`/v2/sessions/${commit.body.sessionId}/reveal`).send({ player: PLAYER, entropy: ENTROPY, salt: wrongSalt });
    expect(reveal.status).toBe(400);
    expect(reveal.body.error).toBe("COMMITMENT_MISMATCH");
    // Session remains committed (not active) — stake still locked.
    const exit = await request(app).post(`/v2/sessions/${commit.body.sessionId}/exit`).send({ player: PLAYER });
    expect(exit.body.status).toBe("cancelled");
  });

  it("rejects a click on a committed (unrevealed) session (SESSION_NOT_ACTIVE)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    const click = await request(app).post(`/v2/sessions/${commit.body.sessionId}/click`).send({ player: PLAYER, tile: 1 });
    expect(click.status).toBe(409);
    expect(click.body.error).toBe("SESSION_NOT_ACTIVE");
    expect(click.body.status).toBe("committed");
  });

  it("exit on a committed (unrevealed) session refunds the stake", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    const exit = await request(app).post(`/v2/sessions/${commit.body.sessionId}/exit`).send({ player: PLAYER });
    expect(exit.body.status).toBe("cancelled");
    expect(exit.body.refunded).toBe("50000");
    const bal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(bal.body.balance).toBe("1900000"); // full refund
  });

  it("rejects a double reveal (SESSION_NOT_COMMITTED)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const commitment = computeCommitment(ENTROPY, SALT);
    const commit = await request(app).post("/v2/sessions").send({ player: PLAYER, host: PLAYER, mode: "Easy", stake: "50000", commitment });
    const r1 = await request(app).post(`/v2/sessions/${commit.body.sessionId}/reveal`).send({ player: PLAYER, entropy: ENTROPY, salt: SALT });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/v2/sessions/${commit.body.sessionId}/reveal`).send({ player: PLAYER, entropy: ENTROPY, salt: SALT });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("SESSION_NOT_COMMITTED");
  });

  it("commitment hides entropy: two different entropy values can produce the same commitment only by coincidence (SHA-256 collision resistance)", async () => {
    // Smoke test: commitment != entropy, and different entropy → different commitment.
    const entropy2 = "0x" + "9".repeat(64);
    const c1 = computeCommitment(ENTROPY, SALT);
    const c2 = computeCommitment(entropy2, SALT);
    expect(c1).not.toBe(ENTROPY);
    expect(c1).not.toBe(c2);
    expect(c1).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
