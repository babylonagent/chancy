// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

abstract contract ChancyGameBase is IEntropyConsumer, Ownable {
    using SafeERC20 for IERC20;

    uint32 public constant ENTROPY_CALLBACK_GAS_LIMIT = 350000;
    uint8 public constant BOMBS_TO_GAME_OVER = 3;
    uint8 public constant BOARD_SIZE = 64;
    uint256 public constant BPS = 10000;
    uint256 public constant IDLE_TIMEOUT = 60;
    address public constant NATIVE_ASSET = address(0);

    IEntropyV2 public immutable entropy;
    mapping(address => bool) public allowedAssets;

    enum Difficulty { Easy, Normal, Hardcore }
    enum TileOutcome { Empty, Prize, Bomb }

    struct Session {
        address host;
        address asset;
        Difficulty difficulty;
        uint256 prizePot;
        address activePlayer;
        uint8 bombCount;
        uint8 prizeCount;
        bool open;
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
        uint256 spentAmount;
        uint256 lastActionAt;
    }

    uint256 public nextSessionId = 1;

    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => PlayerGame)) public playerGames;
    mapping(uint64 => uint256) public entropySequenceToSessionId;
    mapping(uint64 => address) public entropySequenceToPlayer;
    mapping(address => mapping(address => uint256)) public claimableRewards;

    event AssetAllowed(address indexed asset, bool allowed);
    event SessionCreated(
        uint256 indexed sessionId,
        address indexed host,
        address indexed asset,
        Difficulty difficulty,
        uint256 prizePot,
        uint8 bombCount,
        uint8 prizeCount
    );
    event PlayerJoined(uint256 indexed sessionId, address indexed player);
    event EntropyRequested(uint256 indexed sessionId, address indexed player, address indexed provider, uint64 sequenceNumber);
    event PlayerBoardReady(uint256 indexed sessionId, address indexed player, uint64 bombMask, uint64 prizeMask);
    event TileClicked(uint256 indexed sessionId, address indexed player, uint8 tileIndex, uint256 cost);
    event TileResolved(uint256 indexed sessionId, address indexed player, uint8 tileIndex, TileOutcome outcome, uint256 cost);
    event PlayerGameOver(uint256 indexed sessionId, address indexed player, uint256 hostPayout);
    event PlayerExited(uint256 indexed sessionId, address indexed player, uint256 hostPayout);
    event PlayerKickedIdle(uint256 indexed sessionId, address indexed player, uint256 hostPayout);
    event RewardsClaimed(address indexed player, address indexed asset, uint256 amount);

    constructor(address entropyAddress, address initialAllowedAsset, address initialOwner) Ownable(initialOwner) {
        require(entropyAddress != address(0), "INVALID_ENTROPY");
        require(initialOwner != address(0), "INVALID_OWNER");
        entropy = IEntropyV2(entropyAddress);
        if (initialAllowedAsset != NATIVE_ASSET) {
            allowedAssets[initialAllowedAsset] = true;
            emit AssetAllowed(initialAllowedAsset, true);
        }
    }

    function setAssetAllowed(address asset, bool allowed) external onlyOwner {
        require(asset != NATIVE_ASSET, "NATIVE_ALWAYS_ALLOWED");
        allowedAssets[asset] = allowed;
        emit AssetAllowed(asset, allowed);
    }

    function isAssetAllowed(address asset) public view returns (bool) {
        return asset == NATIVE_ASSET || allowedAssets[asset];
    }

    function createSession(address asset, Difficulty difficulty, uint256 prizePot) external payable returns (uint256 sessionId) {
        require(prizePot > 0, "INVALID_PRIZE_POT");
        require(isAssetAllowed(asset), "ASSET_NOT_ALLOWED");

        (uint8 bombCount, uint8 prizeCount) = _difficultyConfig(difficulty);
        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            host: msg.sender,
            asset: asset,
            difficulty: difficulty,
            prizePot: prizePot,
            activePlayer: address(0),
            bombCount: bombCount,
            prizeCount: prizeCount,
            open: true
        });

        if (asset == NATIVE_ASSET) {
            require(msg.value == prizePot, "INVALID_ETH_PRIZE_POT");
        } else {
            require(msg.value == 0, "UNEXPECTED_ETH");
            IERC20(asset).safeTransferFrom(msg.sender, address(this), prizePot);
        }

        emit SessionCreated(sessionId, msg.sender, asset, difficulty, prizePot, bombCount, prizeCount);
    }

    function joinSession(uint256 sessionId, bytes32 userRandomNumber) external payable {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(msg.sender != session.host, "HOST_CANNOT_PLAY");
        require(session.activePlayer == address(0), "ACTIVE_PLAYER_EXISTS");

        address provider = entropy.getDefaultProvider();
        uint128 fee = entropy.getFeeV2(provider, ENTROPY_CALLBACK_GAS_LIMIT);
        require(msg.value >= fee, "INSUFFICIENT_VALUE");

        session.activePlayer = msg.sender;
        PlayerGame storage game = playerGames[sessionId][msg.sender];
        _clearGame(game);
        game.joined = true;
        game.lastActionAt = block.timestamp;

        uint64 sequenceNumber = entropy.requestV2{value: fee}(provider, userRandomNumber, ENTROPY_CALLBACK_GAS_LIMIT);
        game.entropySequenceNumber = sequenceNumber;
        entropySequenceToSessionId[sequenceNumber] = sessionId;
        entropySequenceToPlayer[sequenceNumber] = msg.sender;

        uint256 refund = msg.value - fee;
        if (refund > 0) _sendNative(payable(msg.sender), refund);

        emit PlayerJoined(sessionId, msg.sender);
        emit EntropyRequested(sessionId, msg.sender, provider, sequenceNumber);
    }

    function clickTile(uint256 sessionId, uint8 tileIndex) external payable {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(session.activePlayer == msg.sender, "NOT_ACTIVE_PLAYER");
        require(tileIndex < BOARD_SIZE, "INVALID_TILE");

        PlayerGame storage game = playerGames[sessionId][msg.sender];
        require(game.joined, "PLAYER_NOT_JOINED");
        require(game.boardReady, "BOARD_NOT_READY");
        require(!game.gameOver, "PLAYER_GAME_OVER");

        uint64 tileBit = uint64(1) << tileIndex;
        require(game.clickedMask & tileBit == 0, "TILE_ALREADY_CLICKED");

        uint256 cost = currentRevealCost(sessionId);
        _collectRevealCost(session.asset, cost);
        game.spentAmount += cost;
        game.clickedMask |= tileBit;
        game.lastActionAt = block.timestamp;

        TileOutcome outcome = TileOutcome.Empty;
        if (game.bombMask & tileBit != 0) {
            game.bombsHit += 1;
            outcome = TileOutcome.Bomb;
            if (game.bombsHit >= BOMBS_TO_GAME_OVER) {
                game.gameOver = true;
                uint256 payout = _paySpentToHost(session, game);
                session.activePlayer = address(0);
                emit PlayerGameOver(sessionId, msg.sender, payout);
            }
        } else if (game.prizeMask & tileBit != 0) {
            game.prizesFound += 1;
            claimableRewards[msg.sender][session.asset] += session.prizePot / session.prizeCount;
            outcome = TileOutcome.Prize;
        }

        emit TileClicked(sessionId, msg.sender, tileIndex, cost);
        emit TileResolved(sessionId, msg.sender, tileIndex, outcome, cost);
    }

    function quitSession(uint256 sessionId) external {
        Session storage session = sessions[sessionId];
        require(session.activePlayer == msg.sender, "NOT_ACTIVE_PLAYER");
        PlayerGame storage game = playerGames[sessionId][msg.sender];
        uint256 payout = _paySpentToHost(session, game);
        game.gameOver = true;
        session.activePlayer = address(0);
        emit PlayerExited(sessionId, msg.sender, payout);
    }

    function kickIdlePlayer(uint256 sessionId) external {
        Session storage session = sessions[sessionId];
        address player = session.activePlayer;
        require(player != address(0), "NO_ACTIVE_PLAYER");
        PlayerGame storage game = playerGames[sessionId][player];
        require(block.timestamp > game.lastActionAt + IDLE_TIMEOUT, "PLAYER_NOT_IDLE");
        uint256 payout = _paySpentToHost(session, game);
        game.gameOver = true;
        session.activePlayer = address(0);
        emit PlayerKickedIdle(sessionId, player, payout);
    }

    function revealCostAt(uint256 sessionId, uint256 revealIndex) public view returns (uint256) {
        require(revealIndex < BOARD_SIZE, "INVALID_REVEAL_INDEX");
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        (uint256 startBps, uint256 capBps,) = _modeCostConfig(session.difficulty);
        uint256 baseTotalBps = startBps * BOARD_SIZE;
        uint256 board = uint256(BOARD_SIZE);
        uint256 stepBps = capBps > baseTotalBps ? ((capBps - baseTotalBps) * 2) / (board * (board - 1)) : 0;
        uint256 costBps = startBps + (stepBps * revealIndex);
        return (session.prizePot * costBps) / BPS;
    }

    function currentRevealCost(uint256 sessionId) public view returns (uint256) {
        Session storage session = sessions[sessionId];
        require(session.activePlayer != address(0), "NO_ACTIVE_PLAYER");
        PlayerGame storage game = playerGames[sessionId][session.activePlayer];
        return revealCostAt(sessionId, _popcount(game.clickedMask));
    }

    function claimRewards(address asset) external {
        uint256 amount = claimableRewards[msg.sender][asset];
        require(amount > 0, "NO_REWARDS");
        claimableRewards[msg.sender][asset] = 0;
        _transferAsset(asset, msg.sender, amount);
        emit RewardsClaimed(msg.sender, asset, amount);
    }

    function entropyCallback(uint64 sequenceNumber, address, bytes32 randomNumber) internal override {
        uint256 sessionId = entropySequenceToSessionId[sequenceNumber];
        address player = entropySequenceToPlayer[sequenceNumber];
        if (sessionId == 0 || player == address(0)) return;

        PlayerGame storage game = playerGames[sessionId][player];
        if (!game.joined || game.boardReady) return;

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
        game.lastActionAt = block.timestamp;
        emit PlayerBoardReady(sessionId, player, bombMask, prizeMask);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function _collectRevealCost(address asset, uint256 cost) internal {
        if (asset == NATIVE_ASSET) {
            require(msg.value == cost, "INVALID_REVEAL_VALUE");
        } else {
            require(msg.value == 0, "UNEXPECTED_ETH");
            IERC20(asset).safeTransferFrom(msg.sender, address(this), cost);
        }
    }

    function _paySpentToHost(Session storage session, PlayerGame storage game) internal returns (uint256 payout) {
        payout = game.spentAmount;
        if (payout == 0) return 0;
        game.spentAmount = 0;
        _transferAsset(session.asset, session.host, payout);
    }

    function _transferAsset(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == NATIVE_ASSET) _sendNative(payable(to), amount);
        else IERC20(asset).safeTransfer(to, amount);
    }

    function _sendNative(address payable to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    function _clearGame(PlayerGame storage game) internal {
        game.joined = false;
        game.boardReady = false;
        game.gameOver = false;
        game.entropySequenceNumber = 0;
        game.bombMask = 0;
        game.prizeMask = 0;
        game.clickedMask = 0;
        game.bombsHit = 0;
        game.prizesFound = 0;
        game.spentAmount = 0;
        game.lastActionAt = 0;
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

    function _modeCostConfig(Difficulty difficulty) internal pure returns (uint256 startBps, uint256 capBps, uint8 bombCount) {
        if (difficulty == Difficulty.Easy) return (150, 15000, 5);
        if (difficulty == Difficulty.Normal) return (250, 20000, 7);
        return (350, 25000, 10);
    }

    function _popcount(uint64 value) internal pure returns (uint256 count) {
        while (value != 0) {
            count += value & 1;
            value >>= 1;
        }
    }
}
