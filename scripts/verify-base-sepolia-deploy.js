require('dotenv').config();
const hre = require('hardhat');

const abi = [
  'function entropy() view returns (address)',
  'function isAssetAllowed(address) view returns (bool)',
  'function owner() view returns (address)',
  'function nextSessionId() view returns (uint256)',
];

async function main() {
  const provider = hre.ethers.provider;
  const contractAddress = process.env.CHANCY_CONTRACT_ADDRESS;
  const usdc = process.env.CHANCY_USDC_ADDRESS;
  const entropyExpected = process.env.PYTH_ENTROPY_ADDRESS;

  if (!contractAddress) throw new Error('CHANCY_CONTRACT_ADDRESS is required');
  if (!usdc) throw new Error('CHANCY_USDC_ADDRESS is required');
  if (!entropyExpected) throw new Error('PYTH_ENTROPY_ADDRESS is required');

  const chancy = new hre.ethers.Contract(contractAddress, abi, provider);
  const [network, code, entropy, usdcAllowed, ethAllowed, owner, nextSessionId] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(contractAddress),
    chancy.entropy(),
    chancy.isAssetAllowed(usdc),
    chancy.isAssetAllowed(hre.ethers.ZeroAddress),
    chancy.owner(),
    chancy.nextSessionId(),
  ]);
  console.log(JSON.stringify({
    network: { name: hre.network.name, chainId: Number(network.chainId) },
    contractAddress,
    hasCode: code !== '0x',
    entropy,
    entropyMatchesEnv: entropy.toLowerCase() === entropyExpected.toLowerCase(),
    usdc,
    usdcAllowed,
    ethAllowed,
    owner,
    nextSessionId: nextSessionId.toString(),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
