const { expect } = require("chai");
const request = require("supertest");
const { decodeFunctionData } = require("viem");
const { createApp, chancyAbi, chancyVaultAbi } = require("../apps/api/server");

const CONTRACT = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const PLAYER = "0x2222222222222222222222222222222222222222";
const USDC_ASSET = "0x3333333333333333333333333333333333333333";

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

  it("builds V2 vault approve and deposit transactions", async function () {
    const app = createApp({ contractAddress: CONTRACT, vaultAddress: VAULT, usdcAddress: USDC_ASSET });

    const config = await request(app).get("/v2/config").expect(200);
    expect(config.body).to.include({ ok: true, vaultAddress: VAULT, usdcAddress: USDC_ASSET, depositFeeBps: "500" });

    const approve = await request(app).post("/v2/tx/approve-usdc").send({ amount: "1000000" }).expect(200);
    expect(approve.body.to).to.equal(USDC_ASSET);
    const decodedApprove = decodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], data: approve.body.data });
    expect(decodedApprove.args.map(String)).to.deep.equal([VAULT, "1000000"]);

    const deposit = await request(app).post("/v2/tx/deposit").send({ amount: "1000000" }).expect(200);
    expect(deposit.body.to).to.equal(VAULT);
    const decodedDeposit = decodeFunctionData({ abi: chancyVaultAbi, data: deposit.body.data });
    expect(decodedDeposit.functionName).to.equal("deposit");
    expect(decodedDeposit.args.map(String)).to.deep.equal(["1000000"]);
  });

  it("builds a createSession transaction with a prize pot", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const res = await request(app)
      .post("/tx/create-session")
      .send({ asset: USDC_ASSET, difficulty: "Normal", prizePot: "100000000" })
      .expect(200);

    expect(res.body.to).to.equal(CONTRACT);
    expect(res.body.value).to.equal("0");

    const decoded = decodeFunctionData({ abi: chancyAbi, data: res.body.data });
    expect(decoded.functionName).to.equal("createSession");
    expect(decoded.args.map(String)).to.deep.equal([USDC_ASSET, "1", "100000000"]);
  });

  it("builds approve, join, click, quit, idle-kick, and claim transactions", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    const approve = await request(app)
      .post("/tx/approve-usdc")
      .send({ asset: USDC_ASSET, amount: "100000000" })
      .expect(200);
    const decodedApprove = decodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], data: approve.body.data });
    expect(approve.body.to).to.equal(USDC_ASSET);
    expect(decodedApprove.functionName).to.equal("approve");
    expect(decodedApprove.args.map(String)).to.deep.equal([CONTRACT, "100000000"]);

    const join = await request(app)
      .post("/tx/join-session")
      .send({ sessionId: "1", userRandomNumber: "0x" + "11".repeat(32), entropyFee: "123" })
      .expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: join.body.data }).functionName).to.equal("joinSession");
    expect(join.body.value).to.equal("123");

    const click = await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 7 }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: click.body.data }).functionName).to.equal("clickTile");

    const quit = await request(app).post("/tx/quit-session").send({ sessionId: "1" }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: quit.body.data }).functionName).to.equal("quitSession");

    const kick = await request(app).post("/tx/kick-idle-player").send({ sessionId: "1" }).expect(200);
    expect(decodeFunctionData({ abi: chancyAbi, data: kick.body.data }).functionName).to.equal("kickIdlePlayer");

    const claim = await request(app).post("/tx/claim-rewards").send({ asset: USDC_ASSET }).expect(200);
    const decodedClaim = decodeFunctionData({ abi: chancyAbi, data: claim.body.data });
    expect(decodedClaim.functionName).to.equal("claimRewards");
    expect(decodedClaim.args.map(String)).to.deep.equal([USDC_ASSET]);
  });

  it("builds read-call payloads for session, player, rewards, and reveal cost", async function () {
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

    const nextCost = await request(app).get("/read/current-reveal-cost/1").expect(200);
    expect(nextCost.body.decodeAs).to.equal("currentRevealCost");
    expect(decodeFunctionData({ abi: chancyAbi, data: nextCost.body.data }).functionName).to.equal("currentRevealCost");

    const next = await request(app).get("/read/next-session-id").expect(200);
    expect(next.body.decodeAs).to.equal("nextSessionId");
    expect(decodeFunctionData({ abi: chancyAbi, data: next.body.data }).functionName).to.equal("nextSessionId");
  });

  it("returns discovered session data from the contract reader", async function () {
    const app = createApp({ contractAddress: "0x0000000000000000000000000000000000000000" });

    const res = await request(app).get("/data/sessions").expect(200);

    expect(res.body).to.deep.equal({ sessions: [], nextSessionId: "1", source: "unconfigured" });
  });

  it("rejects invalid request bodies and read params", async function () {
    const app = createApp({ contractAddress: CONTRACT });

    await request(app).post("/tx/create-session").send({ difficulty: "Impossible" }).expect(400);
    await request(app).post("/tx/click-tile").send({ sessionId: "1", tileIndex: 64 }).expect(400);
    await request(app).get("/read/session/not-a-number").expect(400);
    await request(app).get("/read/player-game/1/not-address").expect(400);
  });
});
