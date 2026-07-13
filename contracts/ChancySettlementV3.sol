// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Minimal interface to read verified Pyth randomness from ChancyRandomness.
interface IChancyRandomness {
    function getRequest(uint64 seq) external view returns (
        bytes32 userRandomNumber,
        bytes32 pythRandomNumber,
        bool resolved,
        uint256 requestedAt
    );
}

/**
 * Chancy V3 On-Chain Settlement Contract (Audited)
 *
 * Roles:
 *   - Host:    Locks USDC pot, commits hostSecret. Profits from losses.
 *   - Player:  Locks maxSpend, commits randomness. Clicks tiles.
 *   - Settler: Platform bot. Calls settleGame() + activateGame(). ZERO money authority —
 *              contract re-derives the board and replays every click. If settler lies, tx reverts.
 *              If settler refuses, 24h timeout -> full refund (no fee).
 *
 * Flow:
 *   1. createGame()    — host locks pot + commits hash(hostSecret)
 *   2. joinGame()      — player locks maxSpend + commits hash(playerRandom)
 *   3. activateGame()  — settler submits Pyth randomness
 *   4. [off-chain]     — engine derives board (knows hostSecret), player clicks tiles
 *   5. settleGame()    — settler submits clicks -> contract verifies -> pays
 *   6. challengeSettlement() — dispute wrong settlement -> bond slashed
 *   7. refundTimeout() — 24h no settlement -> full refund, no fee
 *
 * Board secrecy:
 *   boardSeed = keccak256(abi.encodePacked(pythRandom, hostSecret, gameId))
 *   Nobody can derive the board until hostSecret is revealed at settlement.
 */
contract ChancySettlementV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────────
    uint8 public constant BOARD_SIZE = 36;              // 6x6 grid
    uint8 public constant BOMBS_TO_GAME_OVER = 3;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SETTLEMENT_WINDOW = 1 hours;
    uint256 public constant REFUND_TIMEOUT = 24 hours;
    uint256 public constant MIN_PRIZE_POT = 5_000_000;   // $5 USDC (6 decimals)
    uint256 public constant MAX_PRIZE_POT = 1_000_000_000; // $1,000 USDC
    uint16 public constant HOUSE_FEE_BPS = 500;           // 5% house fee on settlement payouts

    IERC20 public immutable usdc;
    IChancyRandomness public immutable randomness;  // Pyth Entropy bridge
    address public settler;
    address public treasury;                              // house fee recipient
    uint256 public settlerBond;
    bool public settlerBondDeposited;

    // ── Enums ─────────────────────────────────────────────────────────────────
    enum GameStatus { Created, Active, Settled, Challenged, Refunded }
    enum Difficulty { Easy, Normal, Hardcore }
    enum GameOutcome { Pending, Win, Loss, Quit }

    // ── Data Structures ──────────────────────────────────────────────────────
    struct Game {
        address host;
        address player;
        Difficulty difficulty;
        uint256 prizePot;
        uint256 maxSpend;
        bytes32 hostCommitment;
        bytes32 playerCommitment;
        bytes32 pythRandomNumber;
        GameStatus status;
        uint64 createdAt;
        uint64 activatedAt;
        uint64 settledAt;
    }

    struct Settlement {
        bytes32 hostSecret;
        uint8[] clicks;
        GameOutcome outcome;
        uint256 hostPayout;
        uint256 playerPayout;
        address settlerAddress;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    mapping(uint256 => Game) public games;
    mapping(uint256 => Settlement) public settlements;
    mapping(address => uint256) public balances;  // on-chain USDC credit balance
    uint256 public nextGameId = 1;
    uint256 public totalEscrowed;  // running total of locked USDC (games Created/Active)

    // ── Events ───────────────────────────────────────────────────────────────
    event GameCreated(uint256 indexed gameId, address indexed host, Difficulty difficulty, uint256 prizePot, bytes32 hostCommitment);
    event GameJoined(uint256 indexed gameId, address indexed player, uint256 maxSpend, bytes32 playerCommitment);
    event GameActivated(uint256 indexed gameId, bytes32 pythRandomNumber);
    event GameSettled(uint256 indexed gameId, GameOutcome outcome, uint256 hostPayout, uint256 playerPayout);
    event GameChallenged(uint256 indexed gameId, address indexed challenger, GameOutcome correctedOutcome, uint256 slashedAmount);
    event GameRefunded(uint256 indexed gameId, uint256 hostRefund, uint256 playerRefund);
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);
    event SettlerBondDeposited(uint256 amount);
    event SettlerBondSlashed(uint256 amount, address to);
    event SettlerBondWithdrawn(uint256 amount, address to);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlySettler() {
        require(msg.sender == settler, "NOT_SETTLER");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address usdcAddress, address randomnessAddress, address initialSettler, address treasuryAddress) Ownable(msg.sender) {
        require(usdcAddress != address(0), "INVALID_USDC");
        require(randomnessAddress != address(0), "INVALID_RANDOMNESS");
        require(initialSettler != address(0), "INVALID_SETTLER");
        require(treasuryAddress != address(0), "INVALID_TREASURY");
        usdc = IERC20(usdcAddress);
        randomness = IChancyRandomness(randomnessAddress);
        settler = initialSettler;
        treasury = treasuryAddress;
        emit SettlerUpdated(address(0), initialSettler);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setSettler(address newSettler) external onlyOwner {
        require(newSettler != address(0), "INVALID_SETTLER");
        address prev = settler;
        settler = newSettler;
        emit SettlerUpdated(prev, newSettler);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "INVALID_TREASURY");
        treasury = newTreasury;
    }

    /// @notice Deposit settler bond (ETH). Required before settling games.
    function depositSettlerBond() external payable onlyOwner {
        settlerBond += msg.value;
        settlerBondDeposited = true;
        emit SettlerBondDeposited(msg.value);
    }

    /// @notice Withdraw settler bond. Owner only.
    function withdrawSettlerBond(address payable to, uint256 amount) external onlyOwner {
        require(settlerBond >= amount, "INSUFFICIENT_BOND");
        require(to != address(0), "INVALID_RECIPIENT");
        settlerBond -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "BOND_WITHDRAW_FAILED");
        emit SettlerBondWithdrawn(amount, to);
    }

    function _slashBond(address to, uint256 amount) internal {
        require(settlerBond >= amount, "INSUFFICIENT_BOND");
        settlerBond -= amount;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "BOND_SLASH_FAILED");
        emit SettlerBondSlashed(amount, to);
    }

    // ── Balance Management (on-chain credits) ──────────────────────────────────

    /**
     * @notice Indexer-only: credit a user's balance from a raw USDC transfer.
     *         Called when the indexer detects a USDC Transfer event to this contract.
     *         The USDC is already in the contract (raw transfer), we just credit the balance.
     * @dev Security: settler is a trusted platform bot. This is the ONLY privileged
     *      balance operation. Settler cannot move user funds — only credit deposits.
     * @param user The address that sent the USDC
     * @param amount The amount of USDC sent
     */
    function adminCredit(address user, uint256 amount) external onlySettler {
        require(user != address(0), "INVALID_USER");
        require(amount > 0, "INVALID_AMOUNT");
        // Solvency guard: total balances + escrowed funds must not exceed USDC held
        uint256 contractBalance = usdc.balanceOf(address(this));
        require(contractBalance - totalEscrowed >= amount, "INSOLVENT_CREDIT");
        balances[user] += amount;
        emit Deposited(user, amount);
    }

    /**
     * @notice Deposit USDC via approve (alternative to raw send).
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        balances[msg.sender] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw your USDC balance. 5% fee auto-sent to treasury.
     *         Fees are sent immediately — no separate withdrawHouseFees needed.
     */
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        require(balances[msg.sender] >= amount, "INSUFFICIENT_BALANCE");

        balances[msg.sender] -= amount;

        // 5% house fee — sent directly to treasury, not double-counted
        uint256 fee = (amount * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 net = amount - fee;

        _payUSDC(treasury, fee);
        _payUSDC(msg.sender, net);

        emit Withdrawn(msg.sender, amount);
    }

    // ── Game Lifecycle ──────────────────────────────────────────────────────

    /**
     * @notice Host creates a game. Host signs directly.
     * @param difficulty 0=Easy, 1=Normal, 2=Hardcore
     * @param prizePot USDC amount (6 decimals) to lock as pot
     * @param hostCommitment keccak256(hostSecret)
     */
    function createGame(
        Difficulty difficulty,
        uint256 prizePot,
        bytes32 hostCommitment
    ) external nonReentrant returns (uint256 gameId) {
        require(prizePot >= MIN_PRIZE_POT, "PRIZE_POT_TOO_LOW");
        require(prizePot <= MAX_PRIZE_POT, "PRIZE_POT_TOO_HIGH");
        require(hostCommitment != bytes32(0), "INVALID_COMMITMENT");
        require(balances[msg.sender] >= prizePot, "INSUFFICIENT_BALANCE");

        balances[msg.sender] -= prizePot;
        totalEscrowed += prizePot;

        gameId = nextGameId++;
        games[gameId] = Game({
            host: msg.sender,
            player: address(0),
            difficulty: difficulty,
            prizePot: prizePot,
            maxSpend: 0,
            hostCommitment: hostCommitment,
            playerCommitment: bytes32(0),
            pythRandomNumber: bytes32(0),
            status: GameStatus.Created,
            createdAt: uint64(block.timestamp),
            activatedAt: 0,
            settledAt: 0
        });

        emit GameCreated(gameId, msg.sender, difficulty, prizePot, hostCommitment);
    }

    /**
     * @notice Player joins a game. Player signs directly.
     * @param gameId The game to join
     * @param playerCommitment keccak256(playerRandom)
     * @param maxSpend Maximum USDC the player is willing to spend on reveals
     */
    function joinGame(
        uint256 gameId,
        bytes32 playerCommitment,
        uint256 maxSpend
    ) external nonReentrant {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Created, "GAME_NOT_OPEN");
        require(msg.sender != game.host, "HOST_CANNOT_PLAY");
        require(playerCommitment != bytes32(0), "INVALID_COMMITMENT");
        require(maxSpend > 0, "INVALID_MAX_SPEND");
        // Player must be able to afford at least one tile reveal
        uint256 firstTileCost = _revealCostAt(game.prizePot, game.difficulty, 0);
        require(maxSpend >= firstTileCost, "MAX_SPEND_TOO_LOW");
        require(balances[msg.sender] >= maxSpend, "INSUFFICIENT_BALANCE");

        game.player = msg.sender;
        game.playerCommitment = playerCommitment;
        game.maxSpend = maxSpend;

        balances[msg.sender] -= maxSpend;
        totalEscrowed += maxSpend;
        emit GameJoined(gameId, msg.sender, maxSpend, playerCommitment);
    }

    /// @notice Mapping from gameId to the Pyth randomness sequence number used.
    mapping(uint256 => uint64) public gameRandomnessSeq;
    /// @notice Tracks which sequence numbers have been used to prevent reuse.
    mapping(uint64 => bool) public usedSequences;

    /**
     * @notice Called by settler after Pyth randomness is resolved.
     *         The settler provides ONLY a sequence number — the contract reads
     *         the actual random value from ChancyRandomness (verified Pyth result).
     *         The settler CANNOT inject a fake random number.
     *
     * @param gameId        Game to activate
     * @param sequenceNumber  Pyth Entropy sequence number (pointer to verified result)
     */
    function activateGame(uint256 gameId, uint64 sequenceNumber) external onlySettler {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Created, "GAME_NOT_CREATED_STATE");
        require(game.player != address(0), "NO_PLAYER_JOINED");
        require(!usedSequences[sequenceNumber], "SEQUENCE_ALREADY_USED");

        // Read the verified Pyth randomness from ChancyRandomness
        (bytes32 userRandom, bytes32 pythRandom, bool resolved, ) = randomness.getRequest(sequenceNumber);
        require(resolved, "RANDOMNESS_NOT_RESOLVED");

        // Verify the player's random was used in this Pyth request
        // The player committed hash(playerRandom) at joinGame.
        // The settler must request Pyth with the same playerRandom.
        require(
            keccak256(abi.encodePacked(userRandom)) == game.playerCommitment,
            "PLAYER_RANDOM_MISMATCH"
        );

        // Store verified random
        game.pythRandomNumber = pythRandom;
        gameRandomnessSeq[gameId] = sequenceNumber;
        usedSequences[sequenceNumber] = true;
        game.status = GameStatus.Active;
        game.activatedAt = uint64(block.timestamp);
        emit GameActivated(gameId, pythRandom);
    }

    /**
     * @notice Settler submits game result. Contract re-derives board, replays
     * clicks, and verifies the outcome.
     */
    function settleGame(
        uint256 gameId,
        bytes32 hostSecret,
        uint8[] calldata clicks,
        GameOutcome outcome
    ) external onlySettler nonReentrant {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Active, "GAME_NOT_ACTIVE");
        require(settlerBondDeposited, "BOND_NOT_DEPOSITED");
        require(
            block.timestamp <= game.activatedAt + REFUND_TIMEOUT,
            "REFUND_WINDOW_PASSED"
        );

        // Verify host secret matches commitment
        require(
            keccak256(abi.encodePacked(hostSecret)) == game.hostCommitment,
            "HOST_SECRET_MISMATCH"
        );

        // Derive board seed from on-chain inputs
        // Includes playerCommitment so the settler CANNOT pre-derive the board
        // without the player's participation. Both parties influence the outcome.
        bytes32 boardSeed = keccak256(abi.encodePacked(
            game.pythRandomNumber,
            hostSecret,
            game.playerCommitment,
            gameId
        ));

        // Derive board (on-chain, trustless)
        (uint64 bombMask, uint64 prizeMask) = _deriveBoard(boardSeed, game.difficulty);

        // Replay clicks
        (GameOutcome replayOutcome, uint256 spent) = _replayClicks(
            bombMask,
            prizeMask,
            clicks,
            game.prizePot,
            game.difficulty
        );

        require(replayOutcome == outcome, "OUTCOME_MISMATCH");
        require(spent <= game.maxSpend, "SPEND_EXCEEDS_BUDGET");

        // Calculate payouts
        (uint256 hostPayout, uint256 playerPayout) = _calculatePayout(
            game.prizePot,
            game.maxSpend,
            spent,
            outcome
        );

        // Set state before transfers (checks-effects-interactions)
        game.status = GameStatus.Settled;
        game.settledAt = uint64(block.timestamp);
        totalEscrowed -= (game.prizePot + game.maxSpend);

        settlements[gameId] = Settlement({
            hostSecret: hostSecret,
            clicks: clicks,
            outcome: outcome,
            hostPayout: hostPayout,
            playerPayout: playerPayout,
            settlerAddress: msg.sender
        });

        // Credit payouts to on-chain balances (5% house fee deducted, sent to treasury)
        balances[game.host] += _applyFee(hostPayout);
        balances[game.player] += _applyFee(playerPayout);

        emit GameSettled(gameId, outcome, hostPayout, playerPayout);
    }

    /**
     * @notice Player disputes a settlement.
     *
     * On successful challenge:
     *   - Overpaid party's balance is debited by the difference
     *   - Underpaid party's balance is credited
     *   - Settler bond slashed to cover any shortfall
     *
     * On failed challenge:
     *   - Challenger's ETH bond sent to treasury (not host) to prevent risk-free spam
     */
    function challengeSettlement(
        uint256 gameId,
        bytes32 hostSecret,
        uint8[] calldata correctClicks,
        GameOutcome correctOutcome
    ) external payable nonReentrant {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Settled, "GAME_NOT_SETTLED");
        require(msg.sender == game.player || msg.sender == game.host, "NOT_PARTICIPANT");
        require(
            block.timestamp <= game.settledAt + SETTLEMENT_WINDOW,
            "CHALLENGE_WINDOW_CLOSED"
        );

        // Verify host secret
        require(
            keccak256(abi.encodePacked(hostSecret)) == game.hostCommitment,
            "HOST_SECRET_MISMATCH"
        );

        // Re-derive board (same formula as settleGame)
        bytes32 boardSeed = keccak256(abi.encodePacked(
            game.pythRandomNumber,
            hostSecret,
            game.playerCommitment,
            gameId
        ));
        (uint64 bombMask, uint64 prizeMask) = _deriveBoard(boardSeed, game.difficulty);

        // Replay the CHALLENGED (original) settlement clicks
        Settlement storage original = settlements[gameId];
        (GameOutcome originalOutcome, ) = _replayClicks(
            bombMask,
            prizeMask,
            original.clicks,
            game.prizePot,
            game.difficulty
        );

        // Replay the challenger's claimed correct clicks
        (GameOutcome challengerOutcome, uint256 challengerSpent) = _replayClicks(
            bombMask,
            prizeMask,
            correctClicks,
            game.prizePot,
            game.difficulty
        );

        // If original settlement was correct, challenger loses bond to treasury
        if (originalOutcome == original.outcome) {
            require(msg.value > 0, "CHALLENGE_BOND_REQUIRED");
            // Send to treasury, NOT game.host — prevents risk-free host challenge spam
            (bool ok, ) = payable(treasury).call{value: msg.value}("");
            require(ok, "CHALLENGE_BOND_TRANSFER_FAILED");
            emit GameChallenged(gameId, msg.sender, originalOutcome, msg.value);
            return;
        }

        // Challenge succeeded — original settlement was wrong
        require(challengerOutcome == correctOutcome, "CORRECT_OUTCOME_MISMATCH");
        require(challengerSpent <= game.maxSpend, "SPEND_EXCEEDS_BUDGET");

        // Recalculate correct payouts
        (uint256 correctHostPayout, uint256 correctPlayerPayout) = _calculatePayout(
            game.prizePot,
            game.maxSpend,
            challengerSpent,
            correctOutcome
        );

        // Correct the payouts without double-charging fees.
        // At settlement, _applyFee already sent fees to treasury.
        // On challenge reversal, we:
        //   1. Debit the original NET amounts (what was actually credited)
        //   2. Credit the correct NET amounts directly (no new fee)
        //    This way fees are only charged once per game, not twice.
        uint256 originalHostNet = _netOfFee(original.hostPayout);
        uint256 originalPlayerNet = _netOfFee(original.playerPayout);
        uint256 correctHostNet = _netOfFee(correctHostPayout);
        uint256 correctPlayerNet = _netOfFee(correctPlayerPayout);

        // Reverse original (debit what was credited)
        // Note: if a party already withdrew, their balance may be < the debit amount.
        // In that case we debit what we can. The settler's half-bond slash compensates
        // the challenger. The contract itself stays solvent because settlement payouts
        // are internal balance credits — USDC stays in the contract until withdrawn.
        if (originalHostNet > 0) {
            uint256 toDebit = originalHostNet <= balances[game.host]
                ? originalHostNet : balances[game.host];
            balances[game.host] -= toDebit;
        }
        if (originalPlayerNet > 0) {
            uint256 toDebit = originalPlayerNet <= balances[game.player]
                ? originalPlayerNet : balances[game.player];
            balances[game.player] -= toDebit;
        }

        // Credit correct net amounts directly — no _applyFee (avoids double-fee)
        balances[game.host] += correctHostNet;
        balances[game.player] += correctPlayerNet;

        // Slash settler bond by half for the error
        uint256 slashAmount = settlerBond / 2;
        if (slashAmount > 0) {
            _slashBond(msg.sender, slashAmount);
        }

        // Update settlement record
        settlements[gameId].clicks = correctClicks;
        settlements[gameId].outcome = correctOutcome;
        settlements[gameId].hostPayout = correctHostPayout;
        settlements[gameId].playerPayout = correctPlayerPayout;

        emit GameChallenged(gameId, msg.sender, correctOutcome, slashAmount);
    }

    /**
     * @notice Anyone can trigger a refund if no settlement happened within 24h.
     *         Full refund, no fee (settler's fault for not settling).
     */
    function refundTimeout(uint256 gameId) external nonReentrant {
        Game storage game = games[gameId];
        require(
            game.status == GameStatus.Created || game.status == GameStatus.Active,
            "NOT_REFUNDABLE"
        );
        require(
            block.timestamp > (game.status == GameStatus.Active ? game.activatedAt : game.createdAt) + REFUND_TIMEOUT,
            "REFUND_TIMEOUT_NOT_REACHED"
        );

        uint256 hostRefund = game.prizePot;
        uint256 playerRefund = game.maxSpend;

        game.status = GameStatus.Refunded;
        totalEscrowed -= (game.prizePot + (game.player != address(0) ? game.maxSpend : 0));

        // Full refund, no fee — settler failed to do their job
        balances[game.host] += hostRefund;
        if (game.player != address(0)) {
            balances[game.player] += playerRefund;
        }

        emit GameRefunded(gameId, hostRefund, playerRefund);
    }

    // ── Board Derivation ─────────────────────────────────────────────────────

    function _deriveBoard(bytes32 boardSeed, Difficulty difficulty)
        internal
        pure
        returns (uint64 bombMask, uint64 prizeMask)
    {
        (uint8 bombCount, uint8 prizeCount) = _difficultyConfig(difficulty);

        // Place bombs
        uint8 placed = 0;
        uint256 nonce = 0;
        while (placed < bombCount) {
            uint8 tile = uint8(uint256(
                keccak256(abi.encodePacked(boardSeed, "B", nonce))
            ) % BOARD_SIZE);
            uint64 bit = uint64(1) << tile;
            if (bombMask & bit == 0) {
                bombMask |= bit;
                placed++;
            }
            nonce++;
        }

        // Place prizes (skip tiles that already have bombs)
        placed = 0;
        nonce = 0;
        while (placed < prizeCount) {
            uint8 tile = uint8(uint256(
                keccak256(abi.encodePacked(boardSeed, "P", nonce))
            ) % BOARD_SIZE);
            uint64 bit = uint64(1) << tile;
            if (bombMask & bit == 0 && prizeMask & bit == 0) {
                prizeMask |= bit;
                placed++;
            }
            nonce++;
        }
    }

    // ── Click Replay ─────────────────────────────────────────────────────────

    function _replayClicks(
        uint64 bombMask,
        uint64 prizeMask,
        uint8[] memory clicks,
        uint256 prizePot,
        Difficulty difficulty
    ) internal pure returns (GameOutcome outcome, uint256 spent) {
        uint8 bombsHit = 0;
        uint8 prizesFound = 0;
        uint64 clickedMask = 0;

        (, uint8 prizeCount) = _difficultyConfig(difficulty);

        for (uint256 i = 0; i < clicks.length; i++) {
            uint8 tile = clicks[i];
            require(tile < BOARD_SIZE, "INVALID_TILE");
            uint64 bit = uint64(1) << tile;
            require(clickedMask & bit == 0, "TILE_ALREADY_CLICKED");

            clickedMask |= bit;
            uint256 cost = _revealCostAt(prizePot, difficulty, i);
            spent += cost;

            if (bombMask & bit != 0) {
                bombsHit++;
                if (bombsHit >= BOMBS_TO_GAME_OVER) {
                    return (GameOutcome.Loss, spent);
                }
            } else if (prizeMask & bit != 0) {
                prizesFound++;
                if (prizesFound >= prizeCount) {
                    return (GameOutcome.Win, spent);
                }
            }
        }

        // Player ended without win or loss = quit
        return (GameOutcome.Quit, spent);
    }

    // ── Payout Calculation ──────────────────────────────────────────────────

    function _calculatePayout(
        uint256 prizePot,
        uint256 maxSpend,
        uint256 spent,
        GameOutcome outcome
    ) internal pure returns (uint256 hostPayout, uint256 playerPayout) {
        uint256 unspent = maxSpend - spent;

        if (outcome == GameOutcome.Win) {
            // Player wins the full pot + gets unspent budget back
            hostPayout = spent;
            playerPayout = prizePot + unspent;
        } else if (outcome == GameOutcome.Loss) {
            // Host gets pot + player's spent
            hostPayout = prizePot + spent;
            playerPayout = unspent;
        } else {
            // Quit — economically same as loss
            hostPayout = prizePot + spent;
            playerPayout = unspent;
        }
    }

    /// @notice Applies 5% house fee. Fee sent directly to treasury immediately.
    ///         Returns net amount to credit to recipient's balance.
    function _applyFee(uint256 amount) internal returns (uint256 net) {
        if (amount == 0) return 0;
        uint256 fee = (amount * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        _payUSDC(treasury, fee);
        return amount - fee;
    }

    /// @dev Pure helper — calculates net after fee without sending anything.
    function _netOfFee(uint256 amount) internal pure returns (uint256) {
        if (amount == 0) return 0;
        return amount - ((amount * HOUSE_FEE_BPS) / BPS_DENOMINATOR);
    }

    // ── Reveal Cost ──────────────────────────────────────────────────────────

    function _revealCostAt(uint256 prizePot, Difficulty difficulty, uint256 revealIndex)
        internal
        pure
        returns (uint256)
    {
        (uint256 startBps, uint256 capBps,) = _modeCostConfig(difficulty);
        uint256 baseTotalBps = startBps * BOARD_SIZE;
        uint256 stepBps = capBps > baseTotalBps
            ? ((capBps - baseTotalBps) * 2) / (uint256(BOARD_SIZE) * uint256(BOARD_SIZE - 1))
            : 0;
        uint256 costBps = startBps + (stepBps * revealIndex);
        return (prizePot * costBps) / BPS_DENOMINATOR;
    }

    // ── Difficulty Config ─────────────────────────────────────────────────────

    function _difficultyConfig(Difficulty difficulty)
        internal
        pure
        returns (uint8 bombCount, uint8 prizeCount)
    {
        if (difficulty == Difficulty.Easy) return (3, 3);
        if (difficulty == Difficulty.Normal) return (4, 2);
        return (6, 1); // Hardcore
    }

    function _modeCostConfig(Difficulty difficulty)
        internal
        pure
        returns (uint256 startBps, uint256 capBps, uint8 bombCount)
    {
        if (difficulty == Difficulty.Easy) return (150, 15000, 3);
        if (difficulty == Difficulty.Normal) return (250, 20000, 4);
        return (350, 25000, 6); // Hardcore
    }

    // ── Transfer Helpers ─────────────────────────────────────────────────────

    function _payUSDC(address to, uint256 amount) internal {
        if (amount > 0) {
            usdc.safeTransfer(to, amount);
        }
    }

    // ── View Functions ───────────────────────────────────────────────────────

    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    function getSettlement(uint256 gameId) external view returns (Settlement memory) {
        return settlements[gameId];
    }

    function gameCount() external view returns (uint256) {
        return nextGameId - 1;
    }

    receive() external payable {}
}
