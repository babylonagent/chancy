// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

/**
 * ChancyRandomness — on-chain randomness bridge for V2 credit-ledger sessions.
 *
 * The V2 game server (hot wallet) calls request() with the player's revealed
 * random number. Pyth Entropy mixes it with oracle randomness and calls back.
 * The result is stored on-chain and publicly readable.
 *
 * The server then reads the randomNumber and derives the game board using the
 * same deterministic algorithm as V1 (_deriveBoard). Because the randomness
 * source is on-chain and the derivation is pure/public, any player can
 * independently verify the board was not tampered with.
 *
 * Security:
 *   - Only the operator (hot wallet) can request randomness (anti-spam).
 *   - Each request gets a unique sequence number from Pyth.
 *   - Results are immutable once resolved.
 *   - Anyone can read getRequest() to verify.
 */
contract ChancyRandomness is IEntropyConsumer {
    uint32 public constant CALLBACK_GAS_LIMIT = 350_000;

    IEntropyV2 public immutable entropy;
    address public operator;

    struct RandomnessRequest {
        bytes32 userRandomNumber;   // player's contribution (revealed)
        bytes32 pythRandomNumber;   // oracle's result (filled on callback)
        bool resolved;
        uint64 sequenceNumber;
        uint256 requestedAt;
    }

    mapping(uint64 => RandomnessRequest) public requests;
    uint64[] public allSequenceNumbers;

    event RandomnessRequested(uint64 indexed sequenceNumber, bytes32 indexed userRandomNumber, address indexed requester);
    event RandomnessResolved(uint64 indexed sequenceNumber, bytes32 pythRandomNumber);

    error NOT_OPERATOR();
    error INSUFFICIENT_FEE();
    error ALREADY_RESOLVED(uint64 sequenceNumber);

    constructor(address entropyAddress, address operator_) {
        require(entropyAddress != address(0), "INVALID_ENTROPY");
        require(operator_ != address(0), "INVALID_OPERATOR");
        entropy = IEntropyV2(entropyAddress);
        operator = operator_;
    }

    function setOperator(address newOperator) external {
        if (msg.sender != operator) revert NOT_OPERATOR();
        require(newOperator != address(0), "INVALID_OPERATOR");
        operator = newOperator;
    }

    /**
     * @notice Request on-chain randomness from Pyth Entropy.
     * @param userRandomNumber The player's revealed random number (32 bytes).
     * @return sequenceNumber Unique ID for this request — used to read the result.
     */
    function request(bytes32 userRandomNumber) external payable returns (uint64 sequenceNumber) {
        if (msg.sender != operator) revert NOT_OPERATOR();

        address provider = entropy.getDefaultProvider();
        uint128 fee = entropy.getFeeV2(provider, CALLBACK_GAS_LIMIT);
        if (msg.value < fee) revert INSUFFICIENT_FEE();

        sequenceNumber = entropy.requestV2{value: fee}(provider, userRandomNumber, CALLBACK_GAS_LIMIT);

        requests[sequenceNumber] = RandomnessRequest({
            userRandomNumber: userRandomNumber,
            pythRandomNumber: bytes32(0),
            resolved: false,
            sequenceNumber: sequenceNumber,
            requestedAt: block.timestamp
        });
        allSequenceNumbers.push(sequenceNumber);

        // Refund excess ETH to operator
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok, ) = payable(operator).call{value: refund}("");
            require(ok, "REFUND_FAILED");
        }

        emit RandomnessRequested(sequenceNumber, userRandomNumber, msg.sender);
    }

    /**
     * @notice Pyth callback — stores the oracle random number.
     * Called by the Entropy contract only (enforced by IEntropyConsumer).
     */
    function entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) internal override {
        RandomnessRequest storage r = requests[sequence];
        if (r.resolved) revert ALREADY_RESOLVED(sequence);
        r.pythRandomNumber = randomNumber;
        r.resolved = true;
        emit RandomnessResolved(sequence, randomNumber);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    /**
     * @notice Read a request's full state (for off-chain verification).
     */
    function getRequest(uint64 seq) external view returns (
        bytes32 userRandomNumber,
        bytes32 pythRandomNumber,
        bool resolved,
        uint256 requestedAt
    ) {
        RandomnessRequest storage r = requests[seq];
        return (r.userRandomNumber, r.pythRandomNumber, r.resolved, r.requestedAt);
    }

    /**
     * @notice Total number of requests ever made.
     */
    function requestCount() external view returns (uint256) {
        return allSequenceNumbers.length;
    }

    /**
     * @notice Get the current Pyth fee for a request (for pre-flight checks).
     */
    function getFee() external view returns (uint128) {
        address provider = entropy.getDefaultProvider();
        return entropy.getFeeV2(provider, CALLBACK_GAS_LIMIT);
    }

    receive() external payable {}
}
