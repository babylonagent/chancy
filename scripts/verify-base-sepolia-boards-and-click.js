require('dotenv').config();
const hre = require('hardhat');

const abi = [
  'function playerGames(uint256,address) view returns (bool joined,bool boardReady,bool gameOver,uint64 entropySequenceNumber,uint64 bombMask,uint64 prizeMask,uint64 clickedMask,uint8 bombsHit,uint8 prizesFound,uint256 spentAmount,uint256 lastActionAt)',
  'function clickTile(uint256,uint8)',
];

async function waitForBoard(chancy, sessionId, player, maxTries = 40) {
  for (let i = 0; i < maxTries; i += 1) {
    const game = await chancy.playerGames(sessionId, player);
    if (game.boardReady) return game;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`board not ready for session ${sessionId}`);
}

function firstSafeTile(game) {
  const bad = BigInt(game.bombMask) | BigInt(game.prizeMask);
  for (let i = 0; i < 64; i += 1) {
    if (((bad >> BigInt(i)) & 1n) === 0n) return i;
  }
  return 0;
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const contractAddress = process.env.CHANCY_CONTRACT_ADDRESS;
  const sessionIds = (process.env.SMOKE_SESSION_IDS || '').split(',').map((value) => Number(value.trim())).filter(Boolean);

  if (!contractAddress) throw new Error('CHANCY_CONTRACT_ADDRESS is required');
  if (sessionIds.length === 0) throw new Error('SMOKE_SESSION_IDS is required, e.g. SMOKE_SESSION_IDS=1,2');

  const chancy = new hre.ethers.Contract(contractAddress, abi, signer);
  const output = { signer: signer.address, checks: [] };
  for (const sessionId of sessionIds) {
    const ready = await waitForBoard(chancy, sessionId, signer.address);
    const tile = firstSafeTile(ready);
    const tx = await chancy.clickTile(sessionId, tile);
    const receipt = await tx.wait();
    const after = await chancy.playerGames(sessionId, signer.address);
    output.checks.push({ sessionId, boardReady: ready.boardReady, bombMask: ready.bombMask.toString(), prizeMask: ready.prizeMask.toString(), clickedTile: tile, clickTx: receipt.hash, status: receipt.status, clickedMaskAfter: after.clickedMask.toString() });
  }
  console.log(JSON.stringify(output, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
