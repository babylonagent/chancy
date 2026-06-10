const fs = require("fs");
const path = require("path");

async function exportAbi({ contractName = "ChancyGame", outputDir = path.join(process.cwd(), "abi") } = {}) {
  const artifactPath = path.join(process.cwd(), "artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found for ${contractName}. Run npm run build first.`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${contractName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(artifact.abi, null, 2));
  return outputPath;
}

async function main() {
  const outputPath = await exportAbi({ contractName: process.env.CONTRACT_NAME || "ChancyGame" });
  console.log(JSON.stringify({ ok: true, outputPath }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { exportAbi };
