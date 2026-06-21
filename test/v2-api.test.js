const { expect } = require("chai");
const request = require("supertest");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../apps/api/server");

const PLAYER = "0x2222222222222222222222222222222222222222";
const HOST = "0x3333333333333333333333333333333333333333";
const ENTROPY = "0x" + "ab".repeat(32);

describe("Chancy V2 credit game API", function () {
  it("credits a player ledger deposit 1:1 in USDC cents", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });

    const deposit = await request(app)
      .post("/v2/credits/deposit")
      .send({ player: PLAYER, amount: "25000000", txHash: "0x" + "01".repeat(32) })
      .expect(200);

    expect(deposit.body.balance).to.equal("25000000");
    expect(deposit.body.asset).to.equal("USD_CREDIT");

    const balance = await request(app).get(`/v2/credits/${PLAYER}`).expect(200);
    expect(balance.body).to.deep.equal({ player: PLAYER, balance: "25000000", withdrawable: "25000000" });
  });

  it("creates a committed server-side board from entropy and hides positions until game end", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, amount: "100000000", txHash: "0x" + "02".repeat(32) }).expect(200);

    const session = await request(app)
      .post("/v2/sessions")
      .send({ player: PLAYER, host: HOST, mode: "Normal", stake: "1000000", entropy: ENTROPY })
      .expect(200);

    expect(session.body.sessionId).to.be.a("string");
    expect(session.body.mode).to.equal("Normal");
    expect(session.body.boardCommitHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(session.body).to.not.have.property("bombPositions");
    expect(session.body).to.not.have.property("prizePositions");

    const balance = await request(app).get(`/v2/credits/${PLAYER}`).expect(200);
    expect(balance.body.balance).to.equal("99000000");
  });

  it("resolves duplicate clicks idempotently and reveals full board only when ended", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, amount: "100000000", txHash: "0x" + "03".repeat(32) }).expect(200);
    const started = await request(app).post("/v2/sessions").send({ player: PLAYER, host: HOST, mode: "Easy", stake: "1000000", entropy: ENTROPY }).expect(200);

    const first = await request(app).post(`/v2/sessions/${started.body.sessionId}/click`).send({ player: PLAYER, tile: 1 }).expect(200);
    const second = await request(app).post(`/v2/sessions/${started.body.sessionId}/click`).send({ player: PLAYER, tile: 1 }).expect(200);
    expect(second.body).to.deep.equal(first.body);

    const exit = await request(app).post(`/v2/sessions/${started.body.sessionId}/exit`).send({ player: PLAYER }).expect(200);
    expect(exit.body.status).to.equal("exited");
    expect(exit.body.board.bombPositions).to.have.length(5);
    expect(exit.body.board.prizePositions).to.have.length(3);
    expect(exit.body.boardCommitHash).to.equal(started.body.boardCommitHash);
  });

  it("rejects clicks from non-players and invalid tiles", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, amount: "100000000", txHash: "0x" + "04".repeat(32) }).expect(200);
    const started = await request(app).post("/v2/sessions").send({ player: PLAYER, host: HOST, mode: "Hardcore", stake: "1000000", entropy: ENTROPY }).expect(200);

    await request(app).post(`/v2/sessions/${started.body.sessionId}/click`).send({ player: HOST, tile: 1 }).expect(403);
    await request(app).post(`/v2/sessions/${started.body.sessionId}/click`).send({ player: PLAYER, tile: 65 }).expect(400);
  });

  it("persists credit balances and sessions across app instances when a store path is configured", async function () {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chancy-v2-")), "store.json");
    const firstApp = createApp({ contractAddress: "0x1111111111111111111111111111111111111111", v2StorePath: storePath });
    await request(firstApp).post("/v2/credits/deposit").send({ player: PLAYER, amount: "42000000", txHash: "0x" + "05".repeat(32) }).expect(200);
    const started = await request(firstApp).post("/v2/sessions").send({ player: PLAYER, host: HOST, mode: "Normal", stake: "2000000", entropy: ENTROPY }).expect(200);

    const secondApp = createApp({ contractAddress: "0x1111111111111111111111111111111111111111", v2StorePath: storePath });
    const balance = await request(secondApp).get(`/v2/credits/${PLAYER}`).expect(200);
    expect(balance.body.balance).to.equal("40000000");

    const exit = await request(secondApp).post(`/v2/sessions/${started.body.sessionId}/exit`).send({ player: PLAYER }).expect(200);
    expect(exit.body.board.prizePositions).to.have.length(2);
  });

  it("queues withdrawals against withdrawable credit without immediately touching vault funds", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, amount: "50000000", txHash: "0x" + "06".repeat(32) }).expect(200);

    const queued = await request(app)
      .post("/v2/withdrawals/request")
      .send({ player: PLAYER, amount: "12000000", destination: PLAYER })
      .expect(200);

    expect(queued.body).to.include({
      player: PLAYER,
      amount: "12000000",
      payoutAmount: "11400000",
      feeAmount: "600000",
      destination: PLAYER,
      status: "pending",
    });
    expect(queued.body.withdrawalId).to.match(/^wd_/);

    const balance = await request(app).get(`/v2/credits/${PLAYER}`).expect(200);
    expect(balance.body.balance).to.equal("50000000");
    expect(balance.body.withdrawable).to.equal("38000000");

    const list = await request(app).get(`/v2/withdrawals/${PLAYER}`).expect(200);
    expect(list.body.withdrawals).to.have.length(1);
  });

  it("marks queued withdrawals paid with a hot-wallet transaction hash", async function () {
    const app = createApp({ contractAddress: "0x1111111111111111111111111111111111111111" });
    await request(app).post("/v2/credits/deposit").send({ player: PLAYER, amount: "50000000", txHash: "0x" + "07".repeat(32) }).expect(200);
    const queued = await request(app).post("/v2/withdrawals/request").send({ player: PLAYER, amount: "12000000", destination: PLAYER }).expect(200);

    const paid = await request(app)
      .post(`/v2/withdrawals/${queued.body.withdrawalId}/mark-paid`)
      .send({ txHash: "0x" + "08".repeat(32) })
      .expect(200);

    expect(paid.body.status).to.equal("paid");
    expect(paid.body.txHash).to.equal("0x" + "08".repeat(32));
    expect(paid.body.payoutAmount).to.equal("11400000");
    expect(paid.body.feeAmount).to.equal("600000");

    const balance = await request(app).get(`/v2/credits/${PLAYER}`).expect(200);
    expect(balance.body.balance).to.equal("38000000");
    expect(balance.body.withdrawable).to.equal("38000000");
  });
});
