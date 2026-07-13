#!/usr/bin/env node
/**
 * Chancy V3 Deposit Indexer
 *
 * Watches USDC Transfer events to the settlement contract.
 * When a user raw-sends USDC to the contract, the indexer calls adminCredit()
 * to credit their on-chain balance.
 *
 * Usage: node v3-deposit-indexer.js
 * Env:
 *   CHANCY_V3_SETTLEMENT_ADDRESS  - settlement contract address
 *   CHANCY_V3_USDC_ADDRESS        - USDC token address
 *   RPC_URL                       - Base Sepolia RPC endpoint
 *   SANDBOX_WALLET_PRIVATE_KEY    - settler wallet key (for adminCredit)
 */

const { ethers } = require('ethers');

const SETTLEMENT = process.env.CHANCY_V3_SETTLEMENT_ADDRESS;
const USDC = process.env.CHANCY_V3_USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC = process.env.RPC_URL || 'https://sepolia.base.org';

// Minimal ABIs
const ERC20_ABI = [
  { anonymous: false, name: 'Transfer', type: 'event',
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ] },
];

const SETTLEMENT_ABI = [
  { name: 'adminCredit', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
];

// Track already-processed txs to avoid double-crediting
const processed = new Set();
let lastBlock = 0;

async function main() {
  if (!SETTLEMENT) { console.error('Missing CHANCY_V3_SETTLEMENT_ADDRESS'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(
    (process.env.SANDBOX_WALLET_PRIVATE_KEY || '').startsWith('0x')
      ? process.env.SANDBOX_WALLET_PRIVATE_KEY
      : '0x' + process.env.SANDBOX_WALLET_PRIVATE_KEY,
    provider
  );

  const settlement = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, wallet);
  const filter = {
    address: USDC,
    topics: [
      ethers.id('Transfer(address,address,uint256)'),
      null,
      ethers.zeroPadValue(SETTLEMENT, 32), // to = settlement contract
    ],
  };

  lastBlock = await provider.getBlockNumber();
  console.log(`[deposit-indexer] Started. Watching ${USDC} → ${SETTLEMENT} from block ${lastBlock}`);

  // Poll every 5 seconds
  setInterval(async () => {
    try {
      const current = await provider.getBlockNumber();
      if (current <= lastBlock) return;

      const events = await provider.getLogs({ ...filter, fromBlock: lastBlock + 1, toBlock: current - 3 });
      lastBlock = current - 3 > lastBlock ? current - 3 : lastBlock;

      for (const log of events) {
        const txHash = log.transactionHash + '-' + log.logIndex;
        if (processed.has(txHash)) continue;
        processed.add(txHash);

        // Decode: from is topics[1], value is data
        const from = ethers.getAddress('0x' + log.topics[1].slice(26));
        const value = BigInt(log.data);

        // Skip if from is the contract itself (internal transfers like payouts)
        if (from.toLowerCase() === SETTLEMENT.toLowerCase()) continue;

        console.log(`[deposit-indexer] Credit ${from} +${value} USDC (tx: ${log.transactionHash})`);

        try {
          const tx = await settlement.adminCredit(from, value);
          await tx.wait();
          console.log(`[deposit-indexer] ✓ Credited ${from} in tx ${tx.hash}`);
        } catch (e) {
          console.error(`[deposit-indexer] ✗ adminCredit failed: ${e.message?.slice(0, 200)}`);
          // Remove from processed so we retry next poll
          processed.delete(txHash);
        }
      }
    } catch (e) {
      console.error(`[deposit-indexer] Poll error: ${e.message?.slice(0, 200)}`);
    }
  }, 5000);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
