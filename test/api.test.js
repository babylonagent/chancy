const { expect } = require("chai");
const request = require("supertest");
const { decodeFunctionData } = require("viem");
const { createApp, chancyAbi } = require("../apps/api/server");

const CONTRACT = "0x1111111111111111111111111111111111111111";
const PLAYER = "0x2222222222222222222222222222222222222222";
const USDC_ASSET = "0x3333333333333333333333333333333333333333";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("agent API", function () {
  it("returns health status", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app).get("/health").expect(200);

    expect(res.body).to.deep.equal({ ok: true, service: "chancy-api", contractAddress: CONTRACT });
  });

  it("supports Vercel /api-prefixed health routing", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app).get("/api/health").expect(200);

    expect(res.body).to.deep.equal({ ok: true, service: "chancy-api", contractAddress: CONTRACT });
  });

  it("builds a createSession transaction (USDC)", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app)
      .post("/tx/create-session")
      .send({ asset: USDC_ASSET, difficulty: "Normal", entryAmount: "10000000", maxPlayers: 4, rewardPerPrize: "2000000" })
      .expect(200);

    expect(res.body.to).to.equal(CONTRACT);
    expect(res.body.value).to.equal("0");

    const decoded = decodeFunctionData({ abi: chancyAbi, data: res.body.data });
    expect(decoded.functionName).to.equal("createSession");
    // [asset, difficulty=1(Normal), entry, maxPlayers, rewardPerPrize]
    expect(decoded.args.map(String)).to.deep.equal([USDC_ASSET, "1", "10000000", "4", "2000000"]);
  });

  it("builds a createSession transaction (ETH)", async function () {
    const app = createApp({ contractAddress: CONTRACT });
    const res = await request(app)
      .post("/tx/create-session")
      .send({ asset: ZERO_ADDRESS, difficulty: "Easy", entryAmount: "10000000000000000", maxPlayers: 2, rewardPerPrize: "20000000000000000" })
      .expect(200);
    const decoded = decodeFunctionData({ abi: chancyAbi, data: res.body.data });
    // [asset=0x0(ETH), difficulty=0(Easy), ...]
    expect(decoded.args.map(String)).to.deep.equal([ZERO_ADDRESS, "0", "10000000000000000", "2", "20000000000000000"]);
  });

  it("builds join, click, fund, and claim transactions", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    // USDC join: entry not added to msg.value, only the entropy fee.
    const join = await request(app)
      .post("/tx/join-session")
      .send({ sessionId: "1", asset: USDC_ASSET, userRandomNumber: "0x" + "11".repeat(32), entropyFee: "123" })
      .expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: join.body.data }).functionName).to.equal("joinSession");
    expect(join.body.value).to.equal("123");

    // ETH join: msg.value = entropy fee + entry amount.
    const joinEth = await request(app)
      .post("/tx/join-session")
      .send({ sessionId: "1", asset: ZERO_ADDRESS, userRandomNumber: "0x" + "11".repeat(32), entropyFee: "100", entryAmount: "900" })
      .expect(200);
    expect(joinEth.body.value).to.equal("1000");

    const click = await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 7 }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: click.body.data }).functionName).to.equal("clickTile");

    // USDC fund: value 0 (pulled via approval).
    const fund = await request(app).post("/tx/fund-session-rewards").send({ sessionId: "1", asset: USDC_ASSET, amount: "16000000" }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: fund.body.data }).functionName).to.equal("fundSessionRewards");
    expect(fund.body.value).to.equal("0");

    // ETH fund: value = amount.
    const fundEth = await request(app).post("/tx/fund-session-rewards").send({ sessionId: "1", asset: ZERO_ADDRESS, amount: "80000000000000000" }).expect(200);
    expect(fundEth.body.value).to.equal("80000000000000000");

    const claim = await request(app).post("/tx/claim-rewards").send({ asset: USDC_ASSET }).expect(200);
    const decodedClaim = decodeFunctionData({ abi: chancyAbi, data: claim.body.data });
    expect(decodedClaim.functionName).to.equal("claimRewards");
    expect(decodedClaim.args.map(String)).to.deep.equal([USDC_ASSET]);
  });

  it("builds read-call payloads for session and player state", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const session = await request(app).get("/read/session/1").expect(200);
    expect(session.body.to).to.equal(CONTRACT);
    expect(session.body.value).to.equal("0");
    expect(session.body.decodeAs).to.equal("sessions");
    expect(decodeFunctionData({ abi: chancyAbi, data: session.body.data }).functionName).to.equal("sessions");

    const player = await request(app).get(`/read/player-game/1/${PLAYER}`).expect(200);
    expect(player.body.decodeAs).to.equal("playerGames");
    const decodedPlayer = decodeFunctionData({ abi: chancyAbi, data: player.body.data });
    expect(decodedPlayer.functionName).to.equal("playerGames");
    expect(decodedPlayer.args.map(String)).to.deep.equal(["1", PLAYER]);

    const rewards = await request(app).get(`/read/claimable-rewards/${PLAYER}/${USDC_ASSET}`).expect(200);
    expect(rewards.body.decodeAs).to.equal("claimableRewards");
    const decodedRewards = decodeFunctionData({ abi: chancyAbi, data: rewards.body.data });
    expect(decodedRewards.functionName).to.equal("claimableRewards");
    expect(decodedRewards.args.map(String)).to.deep.equal([PLAYER, USDC_ASSET]);

    const next = await request(app).get("/read/next-session-id").expect(200);
    expect(next.body.decodeAs).to.equal("nextSessionId");
    expect(decodeFunctionData({ abi: chancyAbi, data: next.body.data }).functionName).to.equal("nextSessionId");
  });

  it("rejects invalid request bodies and read params", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    await request(app).post("/tx/create-session").send({ difficulty: "Impossible" }).expect(400);
    await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 64 }).expect(400);
    await request(app).get("/read/session/not-a-number").expect(400);
    await request(app).get("/read/player-game/1/not-address").expect(400);
  });
});
