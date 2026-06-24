const hre = require("hardhat");

/**
 * Deploy ChancyRandomness to the current network.
 *
 * Env vars:
 *   PYTH_ENTROPY_ADDRESS — Pyth Entropy contract on Base
 *   CHANCY_HOT_WALLET    — Hot wallet address (becomes the operator)
 */
async function main() {
  const entropy = process.env.PYTH_ENTROPY_ADDRESS;
  const operator = process.env.CHANCY_HOT_WALLET;

  if (!entropy) throw new Error("PYTH_ENTROPY_ADDRESS not set");
  if (!operator) throw new Error("CHANCY_HOT_WALLET not set");

  console.log(`Deploying ChancyRandomness to ${hre.network.name}...`);
  console.log(`  Entropy: ${entropy}`);
  console.log(`  Operator (hot wallet): ${operator}`);

  const Factory = await hre.ethers.getContractFactory("ChancyRandomness");
  const contract = await Factory.deploy(entropy, operator);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();

  console.log(JSON.stringify({
    contract: "ChancyRandomness",
    address,
    network: hre.network.name,
    deployTxHash: deployTx.hash,
    entropy,
    operator,
  }, null, 2));

  // Verify the operator and entropy are set correctly
  const op = await contract.operator();
  const ent = await contract.entropy();
  console.log(`  Verified: operator=${op}, entropy=${ent}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
