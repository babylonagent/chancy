const { expect } = require("chai");
const request = require("supertest");
const { decodeFunctionData } = require("viem");
const { createApp, chancyAbi } = require("../apps/api/server");

const CONTRACT = "0x1111111111111111111111111111111111111111";

describe("agent API", function () {
  it("returns health status", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app).get("/health").expect(200);

    expect(res.body).to.deep.equal({ ok: true, service: "chancy-api" });
  });

  it("builds a createSession transaction", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app)
      .post("/tx/create-session")
      .send({ difficulty: "Normal", entryAmount: "10000000000000000000", maxPlayers: 4, rewardPerPrize: "2000000000000000000" })
      .expect(200);

    expect(res.body.to).to.equal(CONTRACT);
    expect(res.body.value).to.equal("0");

    const decoded = decodeFunctionData({ abi: chancyAbi, data: res.body.data });
    expect(decoded.functionName).to.equal("createSession");
    expect(decoded.args.map(String)).to.deep.equal(["1", "10000000000000000000", "4", "2000000000000000000"]);
  });

  it("builds join, click, fund, and claim transactions", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const join = await request(app)
      .post("/tx/join-session")
      .send({ sessionId: "1", userRandomNumber: "0x" + "11".repeat(32), entropyFee: "123" })
      .expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: join.body.data }).functionName).to.equal("joinSession");
    expect(join.body.value).to.equal("123");

    const click = await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 7 }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: click.body.data }).functionName).to.equal("clickTile");

    const fund = await request(app).post("/tx/fund-session-rewards").send({ sessionId: "1", amount: "16000000000000000000" }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: fund.body.data }).functionName).to.equal("fundSessionRewards");

    const claim = await request(app).post("/tx/claim-rewards").send({}).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: claim.body.data }).functionName).to.equal("claimRewards");
  });

  it("rejects invalid request bodies", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    await request(app).post("/tx/create-session").send({ difficulty: "Impossible" }).expect(400);
    await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 64 }).expect(400);
  });
});
