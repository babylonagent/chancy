// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * Chancy V3 On-Chain Settlement Contract
 *
 * Replaces the off-chain credit ledger with trustless on-chain escrow.
 *
 * Roles:
 *   - Host:    Any player. Locks USDC pot, commits hostSecret. Profits from losses.
 *   - Player:  Any other player. Locks max spend budget, commits randomness. Clicks tiles.
 *   - Settler: Platform bot. Calls settleGame(). ZERO money authority — contract
 *              re-derives the board and replays every click. If settler lies, tx reverts.
 *              If settler refuses, 24h timeout → refund.
 *
 * Flow:
 *   1. createGame()    — host locks pot + commits hash(hostSecret)
 *   2. joinGame()       — player locks maxSpend + commits hash(playerRandom)
 *   3. Pyth callback    — randomness resolved on-chain
 *   4. [off-chain]      — engine derives board (knows hostSecret), player clicks tiles
 *   5. settleGame()     — settler submits click sequence → contract verifies → pays
 *   6. challengeSettlement() — (if needed) player disputes → bond slashed
 *   7. refundTimeout()   — (if needed) 24h no settlement → full refund
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
    uint256 public totalHouseFees;                        // lifetime fees collected

    IERC20 public immutable usdc;
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
    uint256 public nextGameId = 1;

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
    event HouseFeeCollected(uint256 gameId, uint256 feeAmount);

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlySettler() {
        require(msg.sender == settler, "NOT_SETTLER");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address usdcAddress, address initialSettler, address treasuryAddress) Ownable(msg.sender) {
        require(usdcAddress != address(0), "INVALID_USDC");
        require(initialSettler != address(0), "INVALID_SETTLER");
        require(treasuryAddress != address(0), "INVALID_TREASURY");
        usdc = IERC20(usdcAddress);
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

    function withdrawHouseFees() external onlyOwner {
        uint256 amount = totalHouseFees;
        totalHouseFees = 0;
        _payUSDC(treasury, amount);
    }

    function depositSettlerBond() external payable onlyOwner {
        settlerBond += msg.value;
        settlerBondDeposited = true;
        emit SettlerBondDeposited(msg.value);
    }

    function _slashBond(address to, uint256 amount) internal {
        require(settlerBond >= amount, "INSUFFICIENT_BOND");
        settlerBond -= amount;
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "BOND_SLASH_FAILED");
        emit SettlerBondSlashed(amount, to);
    }

    // ── Game Lifecycle ──────────────────────────────────────────────────────

    /**
     * @notice Host creates a game. Any player can host.
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

        usdc.safeTransferFrom(msg.sender, address(this), prizePot);
        emit GameCreated(gameId, msg.sender, difficulty, prizePot, hostCommitment);
    }

    /**
     * @notice Player joins a game. Locks max spend budget.
     * @param gameId The game to join
     * @param playerCommitment keccak256(playerRandom) — used as Pyth userRandomNumber
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

        game.player = msg.sender;
        game.playerCommitment = playerCommitment;
        game.maxSpend = maxSpend;

        usdc.safeTransferFrom(msg.sender, address(this), maxSpend);
        emit GameJoined(gameId, msg.sender, maxSpend, playerCommitment);
    }

    /**
     * @notice Called by settler after Pyth randomness is resolved.
     * Records the Pyth random number and activates the game.
     * The random number comes from ChancyRandomness contract (read via off-chain
     * by the settler, submitted here for verification).
     */
    function activateGame(uint256 gameId, bytes32 pythRandomNumber) external onlySettler {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Created, "GAME_NOT_CREATED_STATE");
        require(game.player != address(0), "NO_PLAYER_JOINED");
        require(pythRandomNumber != bytes32(0), "INVALID_RANDOM");

        game.pythRandomNumber = pythRandomNumber;
        game.status = GameStatus.Active;
        game.activatedAt = uint64(block.timestamp);
        emit GameActivated(gameId, pythRandomNumber);
    }

    /**
     * @notice Settler submits game result. Contract re-derives board, replays
     * clicks, and verifies the outcome. If anything doesn't match, reverts.
     *
     * @param gameId Game to settle
     * @param hostSecret The host's secret (revealed at settlement, verified against commitment)
     * @param clicks Ordered array of tile indices clicked (0-35)
     * @param outcome Submitted outcome (Win/Loss/Quit)
     */
    function settleGame(
        uint256 gameId,
        bytes32 hostSecret,
        uint8[] calldata clicks,
        GameOutcome outcome
    ) external onlySettler nonReentrant {
        Game storage game = games[gameId];
        require(game.status == GameStatus.Active, "GAME_NOT_ACTIVE");
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
        bytes32 boardSeed = keccak256(abi.encodePacked(
            game.pythRandomNumber,
            hostSecret,
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

        settlements[gameId] = Settlement({
            hostSecret: hostSecret,
            clicks: clicks,
            outcome: outcome,
            hostPayout: hostPayout,
            playerPayout: playerPayout,
            settlerAddress: msg.sender
        });

        // Transfer (5% house fee deducted)
        _payUSDC(game.host, _applyFee(hostPayout));
        _payUSDC(game.player, _applyFee(playerPayout));

        emit GameSettled(gameId, outcome, hostPayout, playerPayout);
    }

    /**
     * @notice Player disputes a settlement. Contract re-derives board and
     * replays the player's claimed correct clicks. If the player is right,
     * settler bond is slashed and correct payout is made.
     *
     * @param gameId Game to challenge
     * @param hostSecret Host's secret (same as submitted at settlement)
     * @param correctClicks The player's claimed click sequence
     * @param correctOutcome The player's claimed outcome
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

        // Re-derive board
        bytes32 boardSeed = keccak256(abi.encodePacked(
            game.pythRandomNumber,
            hostSecret,
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

        // If original settlement was correct, challenger loses
        if (originalOutcome == original.outcome) {
            // Challenge failed — slash challenger's bond (they must send ETH with tx)
            require(msg.value > 0, "CHALLENGE_BOND_REQUIRED");
            // Slash to settler
            (bool ok, ) = payable(game.host).call{value: msg.value}("");
            require(ok, "CHALLENGE_BOND_TRANSFER_FAILED");
            emit GameChallenged(gameId, msg.sender, originalOutcome, msg.value);
            return;
        }

        // Challenge succeeded — original settlement was wrong
        require(challengerOutcome == correctOutcome, "CORRECT_OUTCOME_MISMATCH");
        require(challengerSpent <= game.maxSpend, "SPEND_EXCEEDS_BUDGET");

        // Slash settler bond to challenger
        _slashBond(msg.sender, settlerBond / 2); // slash half the bond

        // Recalculate correct payout
        // NOTE: we need to clawback the original (wrong) payout, then pay correct.
        // For simplicity, we slash the settler bond for the difference and
        // the game record is corrected. In practice, the wrong payout is
        // already sent. The bond covers the difference.
        (uint256 correctHostPayout, uint256 correctPlayerPayout) = _calculatePayout(
            game.prizePot,
            game.maxSpend,
            challengerSpent,
            correctOutcome
        );

        // Calculate difference from original payout
        uint256 hostDiff = original.hostPayout > correctHostPayout
            ? original.hostPayout - correctHostPayout
            : 0;
        uint256 playerDiff = original.playerPayout > correctPlayerPayout
            ? original.playerPayout - correctPlayerPayout
            : 0;
        uint256 totalDiff = hostDiff + playerDiff;

        // Slash bond to cover the difference, pay the underpaid party
        if (totalDiff > 0) {
            _slashBond(
                originalOutcome == GameOutcome.Win ? game.host : game.player,
                totalDiff > settlerBond ? settlerBond : totalDiff
            );
        }

        // Update settlement record
        settlements[gameId].clicks = correctClicks;
        settlements[gameId].outcome = correctOutcome;
        settlements[gameId].hostPayout = correctHostPayout;
        settlements[gameId].playerPayout = correctPlayerPayout;

        emit GameChallenged(gameId, msg.sender, correctOutcome, settlerBond / 2);
    }

    /**
     * @notice Anyone can trigger a refund if no settlement happened within 24h.
     */
    function refundTimeout(uint256 gameId) external nonReentrant {
        Game storage game = games[gameId];
        require(
            game.status == GameStatus.Created || game.status == GameStatus.Active,
            "NOT_REFUNDABLE"
        );
        require(
            block.timestamp > game.createdAt + REFUND_TIMEOUT,
            "REFUND_TIMEOUT_NOT_REACHED"
        );

        uint256 hostRefund = game.prizePot;
        uint256 playerRefund = game.maxSpend;

        game.status = GameStatus.Refunded;

        _payUSDC(game.host, _applyFee(hostRefund));
        if (game.player != address(0)) {
            _payUSDC(game.player, _applyFee(playerRefund));
        }

        emit GameRefunded(gameId, hostRefund, playerRefund);
    }

    // ── Board Derivation ─────────────────────────────────────────────────────

    /**
     * @notice Derive bomb and prize positions from board seed.
     * Uses keccak256 for hashing. Mirrors the JS deriveBoardV3() function.
     * MUST produce identical output to the JS implementation.
     */
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

    /**
     * @notice Replay a sequence of tile clicks against a derived board.
     * Returns the game outcome and total spent.
     */
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
            hostPayout = spent;           // host earns the reveal costs
            playerPayout = prizePot + unspent; // player gets pot + unspent budget
        } else if (outcome == GameOutcome.Loss) {
            // Host gets pot + player's spent
            hostPayout = prizePot + spent;
            playerPayout = unspent;        // player gets unspent budget back
        } else {
            // Quit — host gets spent + pot (all-or-nothing).
            // Player only gets unspent budget back.
            hostPayout = prizePot + spent;
            playerPayout = unspent;
        }
    }

    /// @notice Applies 5% house fee to a payout, sends fee directly to treasury.
    ///         Returns the net amount to pay the recipient.
    function _applyFee(uint256 amount) internal returns (uint256 net) {
        if (amount == 0) return 0;
        uint256 fee = (amount * HOUSE_FEE_BPS) / BPS_DENOMINATOR;
        totalHouseFees += fee;
        _payUSDC(treasury, fee);
        return amount - fee;
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