require('dotenv').config();
const hre = require('hardhat');

const ZERO = hre.ethers.ZeroAddress;
const abi = [
  'function ENTROPY_CALLBACK_GAS_LIMIT() view returns (uint32)',
  'function createSession(address,uint8,uint256,uint256,uint256) returns (uint256)',
  'function joinSession(uint256,bytes32) payable',
  'function playerGames(uint256,address) view returns (bool joined,bool boardReady,bool gameOver,uint64 entropySequenceNumber,uint64 bombMask,uint64 prizeMask,uint64 clickedMask,uint8 bombsHit,uint8 prizesFound)',
  'event SessionCreated(uint256 indexed sessionId,address indexed host,address indexed asset,uint8 difficulty,uint8 bombCount,uint8 prizeCount)',
  'event EntropyRequested(uint256 indexed sessionId,address indexed player,address indexed provider,uint64 sequenceNumber)',
];
const erc20Abi = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const entropyAbi = [
  'function getDefaultProvider() view returns (address)',
  'function getFeeV2(address,uint32) view returns (uint128)',
];

function seed(label) {
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`${label}:${Date.now()}`));
}

function parseEvent(receipt, contract, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch {}
  }
  return null;
}

async function wait(tx, label) {
  const receipt = await tx.wait();
  return { label, hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status };
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const contractAddress = process.env.CHANCY_CONTRACT_ADDRESS;
  const usdcAddress = process.env.CHANCY_USDC_ADDRESS;
  const entropyAddress = process.env.PYTH_ENTROPY_ADDRESS;
  const ethEntry = BigInt(process.env.SMOKE_ETH_ENTRY_WEI || '100000000000000');
  const usdcEntryUnits = BigInt(process.env.SMOKE_USDC_ENTRY_UNITS || '1000000');

  if (!contractAddress) throw new Error('CHANCY_CONTRACT_ADDRESS is required');
  if (!usdcAddress) throw new Error('CHANCY_USDC_ADDRESS is required');
  if (!entropyAddress) throw new Error('PYTH_ENTROPY_ADDRESS is required');

  const chancy = new hre.ethers.Contract(contractAddress, abi, signer);
  const usdc = new hre.ethers.Contract(usdcAddress, erc20Abi, signer);
  const entropy = new hre.ethers.Contract(entropyAddress, entropyAbi, signer);
  const provider = await entropy.getDefaultProvider();
  const gasLimit = await chancy.ENTROPY_CALLBACK_GAS_LIMIT();
  const fee = await entropy.getFeeV2(provider, gasLimit);

  const output = { signer: signer.address, entropyProvider: provider, entropyFeeWei: fee.toString(), txs: [] };

  let tx = await chancy.createSession(ZERO, 0, ethEntry, 1, 0);
  let receipt = await tx.wait();
  output.txs.push({ label: 'eth.createSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const ethSessionId = parseEvent(receipt, chancy, 'SessionCreated').args.sessionId;
  tx = await chancy.joinSession(ethSessionId, seed('eth'), { value: ethEntry + fee });
  receipt = await tx.wait();
  output.txs.push({ label: 'eth.joinSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const ethEntropy = parseEvent(receipt, chancy, 'EntropyRequested');
  const ethGame = await chancy.playerGames(ethSessionId, signer.address);
  output.eth = { sessionId: ethSessionId.toString(), entropySequenceNumber: ethEntropy.args.sequenceNumber.toString(), joined: ethGame.joined, boardReadyAfterJoin: ethGame.boardReady };

  const allowance = await usdc.allowance(signer.address, contractAddress);
  if (allowance < usdcEntryUnits) output.txs.push(await wait(await usdc.approve(contractAddress, usdcEntryUnits), 'usdc.approve'));
  tx = await chancy.createSession(usdcAddress, 1, usdcEntryUnits, 1, 0);
  receipt = await tx.wait();
  output.txs.push({ label: 'usdc.createSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const usdcSessionId = parseEvent(receipt, chancy, 'SessionCreated').args.sessionId;
  tx = await chancy.joinSession(usdcSessionId, seed('usdc'), { value: fee });
  receipt = await tx.wait();
  output.txs.push({ label: 'usdc.joinSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const usdcEntropy = parseEvent(receipt, chancy, 'EntropyRequested');
  const usdcGame = await chancy.playerGames(usdcSessionId, signer.address);
  const usdcBal = await usdc.balanceOf(signer.address);
  output.usdc = { sessionId: usdcSessionId.toString(), entropySequenceNumber: usdcEntropy.args.sequenceNumber.toString(), joined: usdcGame.joined, boardReadyAfterJoin: usdcGame.boardReady, signerUsdcBalance: usdcBal.toString() };
  console.log(JSON.stringify(output, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
