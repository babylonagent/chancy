require('dotenv').config();
const hre = require('hardhat');

const DEFAULT_WALLET = '0x8741b8a825644D9Ef18Faf2DAB5e9b47B900F2b6';
const DEFAULT_USDC_CANDIDATES = [
  ['Circle USDC Base Sepolia', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'],
];
const erc20Abi = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];
const entropyAbi = [
  'function getDefaultProvider() view returns (address)',
  'function getFeeV2(address,uint32) view returns (uint128)',
];

async function tryToken(provider, label, address, walletAddress) {
  const code = await provider.getCode(address);
  if (code === '0x') return { label, address, hasCode: false };
  const token = new hre.ethers.Contract(address, erc20Abi, provider);
  const [name, symbol, decimals, balance] = await Promise.all([
    token.name().catch((e) => `ERR:${e.shortMessage || e.message}`),
    token.symbol().catch((e) => `ERR:${e.shortMessage || e.message}`),
    token.decimals().catch(() => null),
    walletAddress ? token.balanceOf(walletAddress).catch(() => null) : Promise.resolve(null),
  ]);
  return { label, address, hasCode: true, name, symbol, decimals: decimals == null ? null : Number(decimals), balance: balance == null ? null : balance.toString() };
}

async function main() {
  const provider = hre.ethers.provider;
  const entropyAddress = process.env.PYTH_ENTROPY_ADDRESS;
  const walletAddress = process.env.CHECK_WALLET_ADDRESS || DEFAULT_WALLET;
  const usdcCandidates = process.env.CHECK_USDC_ADDRESS
    ? [['Configured USDC', process.env.CHECK_USDC_ADDRESS]]
    : DEFAULT_USDC_CANDIDATES;

  if (!entropyAddress) throw new Error('PYTH_ENTROPY_ADDRESS is required');

  const network = await provider.getNetwork();
  const ethBalance = walletAddress ? await provider.getBalance(walletAddress) : null;
  const codeEntropy = await provider.getCode(entropyAddress);
  const entropyInfo = codeEntropy === '0x' ? null : { defaultProvider: await new hre.ethers.Contract(entropyAddress, entropyAbi, provider).getDefaultProvider() };
  if (entropyInfo) {
    const entropy = new hre.ethers.Contract(entropyAddress, entropyAbi, provider);
    entropyInfo.feeV2_350k = (await entropy.getFeeV2(entropyInfo.defaultProvider, 350000)).toString();
  }

  const tokenResults = [];
  for (const [label, address] of usdcCandidates) tokenResults.push(await tryToken(provider, label, address, walletAddress));

  console.log(JSON.stringify({
    network: { name: hre.network.name, chainId: Number(network.chainId) },
    wallet: walletAddress || null,
    ethBalanceWei: ethBalance == null ? null : ethBalance.toString(),
    entropy: { address: entropyAddress, hasCode: codeEntropy !== '0x', ...entropyInfo },
    tokenCandidates: tokenResults,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
