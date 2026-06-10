const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

describe("ABI export", function () {
  it("writes ChancyGame ABI JSON for app/API consumers", async function () {
    const { exportAbi } = require("../scripts/export-abi");

    const outputPath = await exportAbi({ contractName: "ChancyGame" });
    const abi = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const names = abi.map((item) => item.name).filter(Boolean);

    expect(outputPath).to.equal(path.join(process.cwd(), "abi", "ChancyGame.json"));
    expect(names).to.include("createSession");
    expect(names).to.include("joinSession");
    expect(names).to.include("clickTile");
    expect(names).to.include("claimRewards");
  });
});
