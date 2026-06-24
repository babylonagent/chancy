import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import {
  installV2Routes,
  deriveBoard,
  computeCommitment,
  revealCostAt,
  prizePerTile,
  modeConfig,
  ENTRANCE_FEE,
  MIN_PRIZE_POT,
} from "./v2.js";

// Mock deposit verifier
function mockVerifier(ledger) {
  return async ({ txHash }) => {
    const rec = ledger[txHash.toLowerCase()];
    if (!rec) throw new Error("DEPOSIT_NOT_FOUND");
    return rec;
  };
}

// Mock entropy requester — passes userRandom through as randomNumber
function mockRequestEntropy() {
  let seq = 0n;
  return async (userRandomNumber) => {
    seq += 1n;
    return { sequenceNumber: seq, randomNumber: userRandomNumber, txHash: "0x" + "e".repeat(64) };
  };
}

const HOST = "0x1111111111111111111111111111111111111111";
const PLAYER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const DEST = "0x4444444444444444444444444444444444444444";
const TX1 = "0x" + "a".repeat(64);
const TX2 = "0x" + "b".repeat(64);
const ENTROPY = "0x" + "c".repeat(64);
const SALT = "0x" + "d".repeat(64);
const POT = "10000000"; // $10 prize pot

function engineApp(verifyDeposit, requestEntropy = mockRequestEntropy()) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  installV2Routes(app, { storePath: "", verifyDeposit, requestEntropy });
  return app;
}

// Helper: compute board for a session (for deterministic test play)
function computeBoard(sessionId, player, mode, entropy = ENTROPY) {
  return deriveBoard({ entropy, sessionId, player, mode });
}

// Helper: host creates session
async function createSession(app, { host = HOST, mode = "Easy", prizePot = POT } = {}) {
  const res = await request(app).post("/v2/sessions/create").send({ host, mode, prizePot });
  expect(res.status).toBe(200);
  return res.body;
}

// Helper: player joins + reveals (full join flow)
async function joinAndReveal(app, sessionId, { player = PLAYER, entropy = ENTROPY, salt = SALT, mode = "Easy" } = {}) {
  const commitment = computeCommitment(entropy, salt);
  const join = await request(app).post(`/v2/sessions/${sessionId}/join`).send({ player, commitment });
  expect(join.status).toBe(200);
  expect(join.body.runStatus).toBe("committed");
  const reveal = await request(app).post(`/v2/sessions/${sessionId}/reveal`).send({ player, entropy, salt });
  expect(reveal.status).toBe(200);
  expect(reveal.body.runStatus || reveal.body.status).toBe("active");
  return { sessionId, player, board: computeBoard(sessionId, player, mode, entropy) };
}

// Fund a player with credits via mock deposit
async function fund(app, player, amount, txHash = TX1) {
  const ledger = { [txHash.toLowerCase()]: { player, grossAmount: amount, creditedAmount: amount, feeAmount: "0" } };
  // Can't reconfigure verifier after app creation, so fund via direct deposit
  // with a pre-set ledger. For tests we create a new app with the ledger.
  return ledger;
}

describe("P2P host/player game mechanics", () => {
  let app;
  let ledger;

  beforeEach(() => {
    // Fund both host and player
    ledger = {
      [TX1.toLowerCase()]: { player: HOST, grossAmount: "50000000", creditedAmount: "50000000", feeAmount: "0" },
      [TX2.toLowerCase()]: { player: PLAYER, grossAmount: "50000000", creditedAmount: "50000000", feeAmount: "0" },
    };
    app = engineApp(mockVerifier(ledger));
  });

  it("host creates a session and locks the prize pot", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    const beforeBal = await request(app).get(`/v2/credits/${HOST}`);
    expect(beforeBal.body.balance).toBe("50000000");

    const session = await createSession(app);
    expect(session.sessionId).toBeTruthy();
    expect(session.status).toBe("open");
    expect(session.prizePot).toBe(POT);
    expect(session.bombs).toBe(modeConfig.Easy.bombs);
    expect(session.prizes).toBe(modeConfig.Easy.prizes);

    // Host balance reduced by prize pot
    const afterBal = await request(app).get(`/v2/credits/${HOST}`);
    expect(afterBal.body.balance).toBe("40000000"); // 50M - 10M
  });

  it("rejects prize pot below minimum ($5)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    const res = await request(app).post("/v2/sessions/create").send({ host: HOST, mode: "Easy", prizePot: "100000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("PRIZE_POT_TOO_LOW");
  });

  it("player joins, pays entrance fee to host", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const session = await createSession(app);

    const commitment = computeCommitment(ENTROPY, SALT);
    const join = await request(app).post(`/v2/sessions/${session.sessionId}/join`).send({ player: PLAYER, commitment });
    expect(join.status).toBe(200);
    expect(join.body.runStatus).toBe("committed");

    // Player balance reduced by entrance fee
    const playerBal = await request(app).get(`/v2/credits/${PLAYER}`);
    expect(playerBal.body.balance).toBe("49950000"); // 50M - 0.05M

    // Host balance increased by entrance fee
    const hostBal = await request(app).get(`/v2/credits/${HOST}`);
    expect(hostBal.body.balance).toBe("40050000"); // 40M + 0.05M
  });

  it("host cannot play their own session", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    const session = await createSession(app);
    const commitment = computeCommitment(ENTROPY, SALT);
    const join = await request(app).post(`/v2/sessions/${session.sessionId}/join`).send({ player: HOST, commitment });
    expect(join.status).toBe(403);
    expect(join.body.error).toBe("HOST_CANNOT_PLAY");
  });

  it("progressive reveal costs increase monotonically", async () => {
    const pot = BigInt(POT);
    let prev = 0n;
    for (let i = 0; i < 64; i++) {
      const cost = revealCostAt(pot, "Easy", i);
      expect(cost).toBeGreaterThanOrEqual(prev);
      prev = cost;
    }
    // First tile cost = 1.5% of pot = $0.15
    expect(revealCostAt(pot, "Easy", 0).toString()).toBe("150000");
  });

  it("player clicks tiles, pays progressive cost, host earns on 3 bombs", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const session = await createSession(app, { mode: "Easy", prizePot: POT });
    const { board } = await joinAndReveal(app, session.sessionId);

    // Click 3 bomb tiles → game over
    let lastResult;
    for (const tile of board.bombPositions.slice(0, 3)) {
      lastResult = await request(app).post(`/v2/sessions/${session.sessionId}/click`).send({ player: PLAYER, tile });
    }
    expect(lastResult.body.status).toBe("lost");

    // Host should have received the player's spent amount
    const hostBal = await request(app).get(`/v2/credits/${HOST}`);
    // Host started with 50M, locked 10M pot, got 0.05M entrance + spent amount
    const expectedHostMin = 40050000n; // at minimum entrance fee
    expect(BigInt(hostBal.body.balance)).toBeGreaterThanOrEqual(expectedHostMin);

    // Session should be open again (reopened after game over)
    const sessDetail = await request(app).get(`/v2/sessions/${session.sessionId}`);
    expect(sessDetail.body.status).toBe("open");
  });

  it("player finds all prizes and wins pro-rata pot shares", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const session = await createSession(app, { mode: "Hardcore", prizePot: POT });
    const { board } = await joinAndReveal(app, session.sessionId, { mode: "Hardcore" });
    const prizeTile = board.prizePositions[0];
    const click = await request(app).post(`/v2/sessions/${session.sessionId}/click`).send({ player: PLAYER, tile: prizeTile });
    expect(click.body.outcome).toBe("prize");
    expect(click.body.status).toBe("won");

    // Player should have received the full prize pot (1 prize = pot/1)
    const playerBal = await request(app).get(`/v2/credits/${PLAYER}`);
    // Player: 50M - 0.05M entrance - tile cost + 10M prize
    const expectedMin = 59950000n - BigInt(revealCostAt(POT, "Hardcore", 0).toString());
    expect(BigInt(playerBal.body.balance)).toBeGreaterThanOrEqual(expectedMin);
  });

  it("player quits — host gets spent, player keeps prizes earned", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const session = await createSession(app, { mode: "Easy", prizePot: POT });
    const { board } = await joinAndReveal(app, session.sessionId);

    // Click one prize tile
    const prizeTile = board.prizePositions[0];
    await request(app).post(`/v2/sessions/${session.sessionId}/click`).send({ player: PLAYER, tile: prizeTile });

    // Quit
    const quit = await request(app).post(`/v2/sessions/${session.sessionId}/quit`).send({ player: PLAYER });
    expect(quit.body.status).toBe("quit");
    expect(quit.body.prizeEarned).toBeTruthy();
    expect(BigInt(quit.body.prizeEarned)).toBeGreaterThan(0n);

    // Session reopens
    const sessDetail = await request(app).get(`/v2/sessions/${session.sessionId}`);
    expect(sessDetail.body.status).toBe("open");
  });

  it("host closes an open session and reclaims prize pot", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    const session = await createSession(app);

    const close = await request(app).post(`/v2/sessions/${session.sessionId}/close`).send({ host: HOST });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("closed");
    expect(close.body.refunded).toBe(POT);

    // Host balance restored
    const hostBal = await request(app).get(`/v2/credits/${HOST}`);
    expect(hostBal.body.balance).toBe("50000000"); // full refund
  });

  it("lists open sessions for players to browse", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await createSession(app, { mode: "Easy", prizePot: POT });
    await createSession(app, { mode: "Normal", prizePot: "20000000" });

    const list = await request(app).get("/v2/sessions");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    expect(list.body.sessions[0].mode).toBe("Easy");
    expect(list.body.sessions[1].mode).toBe("Normal");
    expect(list.body.sessions[0].firstTileCost).toBeTruthy();
  });

  it("commit-reveal: wrong salt rejected", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, txHash: TX2 });
    const session = await createSession(app);

    const commitment = computeCommitment(ENTROPY, SALT);
    await request(app).post(`/v2/sessions/${session.sessionId}/join`).send({ player: PLAYER, commitment });

    const wrongSalt = "0x" + "e".repeat(64);
    const reveal = await request(app).post(`/v2/sessions/${session.sessionId}/reveal`).send({ player: PLAYER, entropy: ENTROPY, salt: wrongSalt });
    expect(reveal.status).toBe(400);
    expect(reveal.body.error).toBe("COMMITMENT_MISMATCH");
  });

  it("deposit and withdrawal still work (infrastructure unchanged)", async () => {
    await request(app).post("/v2/credits/deposit").send({ player: HOST, txHash: TX1 });
    const bal = await request(app).get(`/v2/credits/${HOST}`);
    expect(bal.body.balance).toBe("50000000");

    const wd = await request(app).post("/v2/withdrawals/request").send({ player: HOST, amount: "1000000", destination: DEST });
    expect(wd.body.payoutAmount).toBe("950000"); // 5% fee
    expect(wd.body.feeAmount).toBe("50000");
  });
});
