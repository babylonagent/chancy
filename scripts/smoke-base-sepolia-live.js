require('dotenv').config();
const hre = require('hardhat');

const ZERO = hre.ethers.ZeroAddress;
const abi = [
  'function createSession(address,uint8,uint256) payable returns (uint256)',
  'function sessions(uint256) view returns (address host,address asset,uint8 difficulty,uint256 prizePot,address activePlayer,uint8 bombCount,uint8 prizeCount,bool open)',
  'event SessionCreated(uint256 indexed sessionId,address indexed host,address indexed asset,uint8 difficulty,uint256 prizePot,uint8 bombCount,uint8 prizeCount)',
];
const erc20Abi = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

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
  const ethPrizePot = BigInt(process.env.SMOKE_ETH_PRIZE_POT_WEI || '100000000000000');
  const usdcPrizePot = BigInt(process.env.SMOKE_USDC_PRIZE_POT_UNITS || '1000000');

  if (!contractAddress) throw new Error('CHANCY_CONTRACT_ADDRESS is required');
  if (!usdcAddress) throw new Error('CHANCY_USDC_ADDRESS is required');

  const chancy = new hre.ethers.Contract(contractAddress, abi, signer);
  const usdc = new hre.ethers.Contract(usdcAddress, erc20Abi, signer);
  const output = { signer: signer.address, txs: [] };

  let tx = await chancy.createSession(ZERO, 0, ethPrizePot, { value: ethPrizePot });
  let receipt = await tx.wait();
  output.txs.push({ label: 'eth.createSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const ethSessionId = parseEvent(receipt, chancy, 'SessionCreated').args.sessionId;
  const ethSession = await chancy.sessions(ethSessionId);
  output.eth = { sessionId: ethSessionId.toString(), host: ethSession[0], open: ethSession[7], prizePot: ethSession[3].toString() };

  const allowance = await usdc.allowance(signer.address, contractAddress);
  if (allowance < usdcPrizePot) output.txs.push(await wait(await usdc.approve(contractAddress, usdcPrizePot), 'usdc.approve'));
  tx = await chancy.createSession(usdcAddress, 1, usdcPrizePot);
  receipt = await tx.wait();
  output.txs.push({ label: 'usdc.createSession', hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
  const usdcSessionId = parseEvent(receipt, chancy, 'SessionCreated').args.sessionId;
  const usdcSession = await chancy.sessions(usdcSessionId);
  const usdcBal = await usdc.balanceOf(signer.address);
  output.usdc = { sessionId: usdcSessionId.toString(), host: usdcSession[0], open: usdcSession[7], prizePot: usdcSession[3].toString(), signerUsdcBalance: usdcBal.toString() };
  console.log(JSON.stringify(output, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
