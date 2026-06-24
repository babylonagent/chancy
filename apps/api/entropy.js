"use strict";

/**
 * On-chain Pyth Entropy requester for Chancy V2.
 *
 * The server (hot wallet) calls ChancyRandomness.request(clientRandom) on Base,
 * waits for the Pyth callback, and returns the oracle-backed random number.
 *
 * This replaces the old deriveBoard(clientEntropy) call — the board is now
 * derived from oracle randomness mixed with the player's contribution,
 * making the entire flow verifiable on-chain.
 */

const {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  decodeEventLog,
} = require("viem");
const { base } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");
const crypto = require("crypto");

const RANDOMNESS_ABI = parseAbi([
  "function request(bytes32 userRandomNumber) payable returns (uint64)",
  "function getRequest(uint64 seq) view returns (bytes32 userRandomNumber, bytes32 pythRandomNumber, bool resolved, uint256 requestedAt)",
  "function getFee() view returns (uint128)",
  "function operator() view returns (address)",
  "event RandomnessRequested(uint64 indexed sequenceNumber, bytes32 indexed userRandomNumber, address indexed requester)",
  "event RandomnessResolved(uint64 indexed sequenceNumber, bytes32 pythRandomNumber)",
]);

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 30; // 30s max wait for callback

/**
 * Create the entropy requester.
 *
 * @param {object} opts
 * @param {string} opts.contractAddress  — ChancyRandomness contract address
 * @param {string} opts.hotWalletKey     — Hot wallet private key (0x-prefixed)
 * @param {string} opts.rpcUrl           — Base RPC URL
 * @returns {function} async requestEntropy(userRandomNumber) → { sequenceNumber, randomNumber }
 */
function makeEntropyRequester({ contractAddress, hotWalletKey, rpcUrl }) {
  if (!contractAddress) throw new Error("CHANCY_RANDOMNESS_ADDRESS not set");
  if (!hotWalletKey) throw new Error("HOT_WALLET_KEY not set");

  const account = privateKeyToAccount(hotWalletKey);
  const transport = http(rpcUrl || "https://mainnet.base.org");

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport,
  });
  const publicClient = createPublicClient({
    chain: base,
    transport,
  });

  /**
   * Request on-chain randomness from Pyth via the ChancyRandomness contract.
   *
   * @param {string} userRandomNumber — 0x-prefixed 32-byte hex (player's revealed entropy)
   * @returns {Promise<{sequenceNumber: bigint, randomNumber: string, txHash: string}>}
   */
  return async function requestEntropy(userRandomNumber) {
    // 1. Get the current Pyth fee
    const fee = await publicClient.readContract({
      address: contractAddress,
      abi: RANDOMNESS_ABI,
      functionName: "getFee",
    });

    // 2. Send the request tx via hot wallet
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: RANDOMNESS_ABI,
      functionName: "request",
      args: [userRandomNumber],
      value: fee,
      chain: base,
      account,
    });

    // 3. Wait for tx confirmation and extract sequenceNumber from event
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    let sequenceNumber = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: RANDOMNESS_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "RandomnessRequested") {
          sequenceNumber = decoded.args.sequenceNumber;
          break;
        }
      } catch {
        // Not our event — skip
      }
    }

    if (sequenceNumber === null) {
      throw new Error("ENTROPY_REQUEST_EVENT_NOT_FOUND");
    }

    // 4. Poll for Pyth callback resolution
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      const result = await publicClient.readContract({
        address: contractAddress,
        abi: RANDOMNESS_ABI,
        functionName: "getRequest",
        args: [sequenceNumber],
      });

      if (result[2]) {
        // resolved === true
        return {
          sequenceNumber,
          randomNumber: result[1], // pythRandomNumber
          txHash,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error("ENTROPY_CALLBACK_TIMEOUT");
  };
}

module.exports = { makeEntropyRequester, RANDOMNESS_ABI };
