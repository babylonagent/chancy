/**
 * Deposit Indexer — watches USDC Transfer events to the vault address.
 *
 * When a user sends USDC directly to the vault (raw `transfer`), this indexer:
 *   1. Detects the Transfer(from, to=vault, amount) event
 *   2. Waits for N confirmations (default 3 on Base ~6-9s)
 *   3. Credits the `from` address: 95% net, 5% fee stays in vault
 *   4. Records the deposit by txHash (idempotent — never double-credits)
 *
 * This replaces the approve+deposit flow with a single raw send.
 * Works with ANY wallet — MetaMask, Rabby, Bankr, CLI, etc.
 */

const { createPublicClient, http, parseAbi, parseEventLogs } = require("viem");

const DEPOSIT_FEE_BPS = 500n; // 5%
const BPS_DENOMINATOR = 10_000n;

// ERC20 Transfer event topic
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * Create and start the deposit indexer.
 *
 * @param {object} opts
 * @param {string} opts.rpcUrl — Base RPC URL
 * @param {string} opts.vaultAddress — vault contract address
 * @param {string} opts.usdcAddress — USDC contract address
 * @param {object} opts.store — V2 store (has balances Map, deposits Map)
 * @param {function} opts.persist — persist function (writes store to disk/sqlite)
 * @param {number} opts.minConfirmations — blocks to wait before crediting (default 3)
 * @param {number} opts.pollIntervalMs — poll frequency (default 5000)
 * @param {function} opts.getLastBlock — () => number: last scanned block from DB
 * @param {function} opts.setLastBlock — (block) => void: save last scanned block to DB
 * @returns {{ stop: () => void }}
 */
function createDepositIndexer({
  rpcUrl,
  vaultAddress,
  usdcAddress,
  store,
  persist,
  minConfirmations = 3,
  pollIntervalMs = 5000,
  getLastBlock,
  setLastBlock,
}) {
  const vaultLower = vaultAddress.toLowerCase();

  const client = createPublicClient({
    transport: http(rpcUrl),
  });

  let running = true;
  let timer = null;

  function log(msg) {
    console.log(`[indexer] ${new Date().toISOString()} ${msg}`);
  }

  function creditPlayer(player, grossAmount, txHash, blockNumber) {
    const playerKey = player.toLowerCase();
    const txKey = txHash.toLowerCase();

    // Idempotent: skip if already processed
    if (store.deposits && store.deposits.has(txKey)) {
      return false;
    }

    const gross = BigInt(grossAmount);
    const feeAmount = gross * DEPOSIT_FEE_BPS / BPS_DENOMINATOR;
    const creditedAmount = gross - feeAmount;

    // Credit player balance
    const current = store.balances.has(playerKey)
      ? BigInt(store.balances.get(playerKey))
      : 0n;
    store.balances.set(playerKey, current + creditedAmount);

    // Record deposit (idempotency key)
    if (!store.deposits) store.deposits = new Map();
    store.deposits.set(txKey, {
      player: playerKey,
      grossAmount: gross.toString(),
      creditedAmount: creditedAmount.toString(),
      feeAmount: feeAmount.toString(),
      blockNumber: String(blockNumber),
      at: new Date().toISOString(),
      source: "indexer",
    });

    persist();
    return true;
  }

  async function scanBlocks(fromBlock, toBlock) {
    // Fetch Transfer logs where to=vaultAddress
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: usdcAddress,
          topics: [TRANSFER_TOPIC, null, padAddressTopic(vaultLower)],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
        },
      ],
    });

    if (!logs || logs.length === 0) return 0;

    let credited = 0;
    for (const evt of logs) {
      // Decode Transfer(from indexed, to indexed, value)
      // topics[1] = from, topics[2] = to, data = amount
      const from = "0x" + evt.topics[1].slice(26); // remove padding
      const amount = BigInt(evt.data);

      // Skip zero-amount (some tokens emit on approve, etc.)
      if (amount === 0n) continue;

      const wasNew = creditPlayer(from, amount, evt.transactionHash, Number(evt.blockNumber));
      if (wasNew) {
        credited++;
        log(`Credited ${from.slice(0, 10)}... ${formatUsdc(amount)} → ${formatUsdc(creditedAmount(amount))} net`);
      }
    }
    return credited;
  }

  function creditedAmount(gross) {
    const fee = BigInt(gross) * DEPOSIT_FEE_BPS / BPS_DENOMINATOR;
    return BigInt(gross) - fee;
  }

  function formatUsdc(raw) {
    return `$${(Number(raw) / 1e6).toFixed(2)}`;
  }

  async function tick() {
    if (!running) return;
    try {
      const currentBlock = Number(await client.getBlockNumber());
      const safeBlock = currentBlock - minConfirmations;
      if (safeBlock <= 0) return;

      let lastScanned = getLastBlock();
      if (!lastScanned || lastScanned < 1) {
        // First run: start from current safe block (don't scan history)
        lastScanned = safeBlock - 1;
      }

      if (safeBlock <= lastScanned) return; // nothing new

      // Scan in small chunks to stay within Alchemy free-tier limits (max 10 blocks per eth_getLogs)
      const fromBlock = lastScanned + 1;
      const toBlock = Math.min(safeBlock, fromBlock + 9);

      const count = await scanBlocks(fromBlock, toBlock);
      setLastBlock(toBlock);

      if (count > 0) {
        log(`Scanned blocks ${fromBlock}-${toBlock}: ${count} deposit(s) credited`);
      }
    } catch (err) {
      log(`ERROR: ${err.message || err}`);
    }
  }

  function start() {
    log(`Starting — vault=${vaultAddress} usdc=${usdcAddress} confirmations=${minConfirmations} poll=${pollIntervalMs}ms`);
    // Run immediately, then on interval
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {});
    }, pollIntervalMs);
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    log("Stopped");
  }

  return { start, stop, creditPlayer };
}

/**
 * Pad an address to 32-byte topic format (left-padded with zeros).
 * Input: 0xabc... Output: 0x000...000abc...
 */
function padAddressTopic(address) {
  return "0x" + address.slice(2).toLowerCase().padStart(64, "0");
}

module.exports = { createDepositIndexer };
