// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

/// @title ChancyGameBase
/// @notice Per-player commit-reveal block game on Base. Each session settles in
///         one asset chosen by its host at creation: native ETH (address(0)) or
///         an allow-listed ERC20 such as USDC. Board randomness comes from Pyth
///         Entropy, requested per player on join.
/// @dev Only ETH and owner-allow-listed ERC20s are accepted. New assets can be
///      enabled later via setAssetAllowed without redeploying or touching the
///      game logic.
abstract contract ChancyGameBase is IEntropyConsumer, Ownable {
    using SafeERC20 for IERC20;

    uint32 public constant ENTROPY_CALLBACK_GAS_LIMIT = 350000;
    uint8 public constant BOMBS_TO_GAME_OVER = 3;

    /// @notice Sentinel asset address for native ETH.
    address public constant NATIVE_ASSET = address(0);

    IEntropyV2 public immutable entropy;

    /// @notice ERC20 assets allowed for new sessions. ETH is always allowed.
    mapping(address => bool) public allowedAssets;

    enum Difficulty {
        Easy,
        Normal,
        Hardcore
    }

    enum TileOutcome {
        Empty,
        Prize,
        Bomb
    }

    struct Session {
        address host;
        address asset; // NATIVE_ASSET (ETH) or an allow-listed ERC20 (e.g. USDC)
        Difficulty difficulty;
        uint8 bombCount;
        uint8 prizeCount;
        uint256 entryAmount;
        uint256 maxPlayers;
        uint256 joinedPlayers;
        uint256 rewardPerPrize;
        uint256 totalRewardReserve;
        bool rewardReserveFunded;
    }

    struct PlayerGame {
        bool joined;
        bool boardReady;
        bool gameOver;
        uint64 entropySequenceNumber;
        uint64 bombMask;
        uint64 prizeMask;
        uint64 clickedMask;
        uint8 bombsHit;
        uint8 prizesFound;
    }

    uint256 public nextSessionId = 1;

    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => PlayerGame)) public playerGames;
    mapping(uint64 => uint256) public entropySequenceToSessionId;
    mapping(uint64 => address) public entropySequenceToPlayer;
    /// @notice Claimable rewards keyed by player then asset.
    mapping(address => mapping(address => uint256)) public claimableRewards;

    event AssetAllowed(address indexed asset, bool allowed);
    event SessionCreated(
        uint256 indexed sessionId,
        address indexed host,
        address indexed asset,
        Difficulty difficulty,
        uint8 bombCount,
        uint8 prizeCount
    );
    event SessionRewardsFunded(uint256 indexed sessionId, address indexed host, uint256 amount);
    event PlayerJoined(uint256 indexed sessionId, address indexed player);
    event EntropyRequested(uint256 indexed sessionId, address indexed player, address indexed provider, uint64 sequenceNumber);
    event PlayerBoardReady(uint256 indexed sessionId, address indexed player, uint64 bombMask, uint64 prizeMask);
    event TileClicked(uint256 indexed sessionId, address indexed player, uint8 tileIndex);
    event TileResolved(uint256 indexed sessionId, address indexed player, uint8 tileIndex, TileOutcome outcome);
    event PlayerGameOver(uint256 indexed sessionId, address indexed player);
    event RewardsClaimed(address indexed player, address indexed asset, uint256 amount);

    constructor(address entropyAddress, address initialAllowedAsset) Ownable(msg.sender) {
        require(entropyAddress != address(0), "INVALID_ENTROPY");
        entropy = IEntropyV2(entropyAddress);
        if (initialAllowedAsset != NATIVE_ASSET) {
            allowedAssets[initialAllowedAsset] = true;
            emit AssetAllowed(initialAllowedAsset, true);
        }
    }

    /// @notice Owner enables/disables an ERC20 asset for new sessions.
    function setAssetAllowed(address asset, bool allowed) external onlyOwner {
        require(asset != NATIVE_ASSET, "NATIVE_ALWAYS_ALLOWED");
        allowedAssets[asset] = allowed;
        emit AssetAllowed(asset, allowed);
    }

    /// @notice True if an asset can be used to create a session.
    function isAssetAllowed(address asset) public view returns (bool) {
        return asset == NATIVE_ASSET || allowedAssets[asset];
    }

    function createSession(
        address asset,
        Difficulty difficulty,
        uint256 entryAmount,
        uint256 maxPlayers,
        uint256 rewardPerPrize
    ) external returns (uint256 sessionId) {
        require(entryAmount > 0, "INVALID_ENTRY_AMOUNT");
        require(maxPlayers > 0, "INVALID_MAX_PLAYERS");
        require(isAssetAllowed(asset), "ASSET_NOT_ALLOWED");

        (uint8 bombCount, uint8 prizeCount) = _difficultyConfig(difficulty);
        uint256 totalRewardReserve = rewardPerPrize * prizeCount * maxPlayers;

        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            host: msg.sender,
            asset: asset,
            difficulty: difficulty,
            bombCount: bombCount,
            prizeCount: prizeCount,
            entryAmount: entryAmount,
            maxPlayers: maxPlayers,
            joinedPlayers: 0,
            rewardPerPrize: rewardPerPrize,
            totalRewardReserve: totalRewardReserve,
            rewardReserveFunded: totalRewardReserve == 0
        });

        emit SessionCreated(sessionId, msg.sender, asset, difficulty, bombCount, prizeCount);
    }

    /// @notice Host funds the exact maximum reward exposure for a session.
    /// @dev ERC20 sessions: approve this contract and pass `amount` (msg.value 0).
    ///      ETH sessions: send `amount` as msg.value and pass it as `amount`.
    function fundSessionRewards(uint256 sessionId, uint256 amount) external payable {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(msg.sender == session.host, "ONLY_HOST");
        require(!session.rewardReserveFunded, "SESSION_REWARDS_ALREADY_FUNDED");
        require(amount == session.totalRewardReserve, "INVALID_REWARD_RESERVE");

        session.rewardReserveFunded = true;

        if (session.asset == NATIVE_ASSET) {
            require(msg.value == amount, "INVALID_ETH_RESERVE");
        } else {
            require(msg.value == 0, "UNEXPECTED_ETH");
            IERC20(session.asset).safeTransferFrom(msg.sender, address(this), amount);
        }

        emit SessionRewardsFunded(sessionId, msg.sender, amount);
    }

    /// @notice Join a funded session, pay the entry amount, and request a board.
    /// @dev msg.value must cover the Pyth entropy fee, plus the entry amount when
    ///      the session asset is ETH. Any ETH overpayment is refunded.
    function joinSession(uint256 sessionId, bytes32 userRandomNumber) external payable {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(session.rewardReserveFunded, "SESSION_REWARDS_NOT_FUNDED");

        PlayerGame storage game = playerGames[sessionId][msg.sender];
        require(!game.joined, "ALREADY_JOINED");
        require(session.joinedPlayers < session.maxPlayers, "SESSION_FULL");

        address provider = entropy.getDefaultProvider();
        uint128 fee = entropy.getFeeV2(provider, ENTROPY_CALLBACK_GAS_LIMIT);

        uint256 entryNative = session.asset == NATIVE_ASSET ? session.entryAmount : 0;
        require(msg.value >= entryNative + fee, "INSUFFICIENT_VALUE");

        session.joinedPlayers += 1;
        game.joined = true;

        if (session.asset != NATIVE_ASSET) {
            IERC20(session.asset).safeTransferFrom(msg.sender, address(this), session.entryAmount);
        }

        uint64 sequenceNumber = entropy.requestV2{value: fee}(provider, userRandomNumber, ENTROPY_CALLBACK_GAS_LIMIT);
        game.entropySequenceNumber = sequenceNumber;
        entropySequenceToSessionId[sequenceNumber] = sessionId;
        entropySequenceToPlayer[sequenceNumber] = msg.sender;

        uint256 refund = msg.value - entryNative - fee;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "REFUND_FAILED");
        }

        emit PlayerJoined(sessionId, msg.sender);
        emit EntropyRequested(sessionId, msg.sender, provider, sequenceNumber);
    }

    function clickTile(uint256 sessionId, uint8 tileIndex) external {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(tileIndex < 64, "INVALID_TILE");

        PlayerGame storage game = playerGames[sessionId][msg.sender];
        require(game.joined, "PLAYER_NOT_JOINED");
        require(game.boardReady, "BOARD_NOT_READY");
        require(!game.gameOver, "PLAYER_GAME_OVER");

        uint64 tileBit = uint64(1) << tileIndex;
        require(game.clickedMask & tileBit == 0, "TILE_ALREADY_CLICKED");

        game.clickedMask |= tileBit;

        TileOutcome outcome = TileOutcome.Empty;
        if (game.bombMask & tileBit != 0) {
            game.bombsHit += 1;
            outcome = TileOutcome.Bomb;
            if (game.bombsHit >= BOMBS_TO_GAME_OVER) {
                game.gameOver = true;
                emit PlayerGameOver(sessionId, msg.sender);
            }
        } else if (game.prizeMask & tileBit != 0) {
            game.prizesFound += 1;
            claimableRewards[msg.sender][session.asset] += session.rewardPerPrize;
            outcome = TileOutcome.Prize;
        }

        emit TileClicked(sessionId, msg.sender, tileIndex);
        emit TileResolved(sessionId, msg.sender, tileIndex, outcome);
    }

    /// @notice Claim accrued rewards for a given settlement asset.
    function claimRewards(address asset) external {
        uint256 amount = claimableRewards[msg.sender][asset];
        require(amount > 0, "NO_REWARDS");

        claimableRewards[msg.sender][asset] = 0;

        if (asset == NATIVE_ASSET) {
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            require(ok, "ETH_TRANSFER_FAILED");
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }

        emit RewardsClaimed(msg.sender, asset, amount);
    }

    function entropyCallback(uint64 sequenceNumber, address, bytes32 randomNumber) internal override {
        uint256 sessionId = entropySequenceToSessionId[sequenceNumber];
        address player = entropySequenceToPlayer[sequenceNumber];
        if (sessionId == 0 || player == address(0)) {
            return;
        }

        PlayerGame storage game = playerGames[sessionId][player];
        if (!game.joined || game.boardReady) {
            return;
        }

        Session storage session = sessions[sessionId];
        (uint64 bombMask, uint64 prizeMask) = _deriveBoard(
            randomNumber,
            sessionId,
            player,
            session.difficulty,
            session.bombCount,
            session.prizeCount
        );

        game.bombMask = bombMask;
        game.prizeMask = prizeMask;
        game.boardReady = true;

        emit PlayerBoardReady(sessionId, player, bombMask, prizeMask);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function _deriveBoard(
        bytes32 randomNumber,
        uint256 sessionId,
        address player,
        Difficulty difficulty,
        uint8 bombCount,
        uint8 prizeCount
    ) internal pure returns (uint64 bombMask, uint64 prizeMask) {
        uint8 placedBombs = 0;
        uint256 nonce = 0;

        while (placedBombs < bombCount) {
            uint8 tile = uint8(uint256(keccak256(abi.encode(randomNumber, sessionId, player, difficulty, "BOMB", nonce))) % 64);
            uint64 bit = uint64(1) << tile;
            if (bombMask & bit == 0) {
                bombMask |= bit;
                placedBombs += 1;
            }
            nonce += 1;
        }

        uint8 placedPrizes = 0;
        nonce = 0;
        while (placedPrizes < prizeCount) {
            uint8 tile = uint8(uint256(keccak256(abi.encode(randomNumber, sessionId, player, difficulty, "PRIZE", nonce))) % 64);
            uint64 bit = uint64(1) << tile;
            if (bombMask & bit == 0 && prizeMask & bit == 0) {
                prizeMask |= bit;
                placedPrizes += 1;
            }
            nonce += 1;
        }
    }

    function _difficultyConfig(Difficulty difficulty) internal pure returns (uint8 bombCount, uint8 prizeCount) {
        if (difficulty == Difficulty.Easy) return (5, 3);
        if (difficulty == Difficulty.Normal) return (7, 2);
        return (10, 1);
    }
}
