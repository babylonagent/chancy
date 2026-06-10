// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";

/// @notice TEST CONTRACT ONLY.
/// @dev Hardcodes temporary game token for full gameplay testing. Do not use for production deployment.
contract ChancyGameFixedTokenTestnet is IEntropyConsumer {
    using SafeERC20 for IERC20;

    address public constant GAME_TOKEN = 0x3E1A6D23303bE04403BAdC8bFF348027148Fef27;
    uint32 public constant ENTROPY_CALLBACK_GAS_LIMIT = 350000;

    IEntropyV2 public immutable entropy;

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
        Difficulty difficulty;
        uint8 bombCount;
        uint8 prizeCount;
        uint256 entryAmount;
        uint256 maxPlayers;
        uint256 joinedPlayers;
        uint256 rewardPerPrize;
        bool finalized;
    }

    struct PlayerGame {
        bool joined;
        bool boardReady;
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

    event SessionCreated(
        uint256 indexed sessionId,
        address indexed host,
        Difficulty difficulty,
        uint8 bombCount,
        uint8 prizeCount
    );
    event PlayerJoined(uint256 indexed sessionId, address indexed player);
    event EntropyRequested(uint256 indexed sessionId, address indexed player, address indexed provider, uint64 sequenceNumber);
    event PlayerBoardReady(uint256 indexed sessionId, address indexed player, uint64 bombMask, uint64 prizeMask);
    event TileClicked(uint256 indexed sessionId, address indexed player, uint8 tileIndex);
    event TileResolved(uint256 indexed sessionId, address indexed player, uint8 tileIndex, TileOutcome outcome);

    constructor(address entropyAddress) {
        require(entropyAddress != address(0), "INVALID_ENTROPY");
        entropy = IEntropyV2(entropyAddress);
    }

    function createSession(
        Difficulty difficulty,
        uint256 entryAmount,
        uint256 maxPlayers,
        uint256 rewardPerPrize
    ) external returns (uint256 sessionId) {
        require(entryAmount > 0, "INVALID_ENTRY_AMOUNT");
        require(maxPlayers > 0, "INVALID_MAX_PLAYERS");

        (uint8 bombCount, uint8 prizeCount) = _difficultyConfig(difficulty);

        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            host: msg.sender,
            difficulty: difficulty,
            bombCount: bombCount,
            prizeCount: prizeCount,
            entryAmount: entryAmount,
            maxPlayers: maxPlayers,
            joinedPlayers: 0,
            rewardPerPrize: rewardPerPrize,
            finalized: false
        });

        emit SessionCreated(sessionId, msg.sender, difficulty, bombCount, prizeCount);
    }

    function joinSession(uint256 sessionId, bytes32 userRandomNumber) external payable {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(!session.finalized, "SESSION_FINALIZED");

        PlayerGame storage game = playerGames[sessionId][msg.sender];
        require(!game.joined, "ALREADY_JOINED");
        require(session.joinedPlayers < session.maxPlayers, "SESSION_FULL");

        session.joinedPlayers += 1;
        game.joined = true;

        IERC20(GAME_TOKEN).safeTransferFrom(msg.sender, address(this), session.entryAmount);

        address provider = entropy.getDefaultProvider();
        uint128 fee = entropy.getFeeV2(provider, ENTROPY_CALLBACK_GAS_LIMIT);
        require(msg.value >= fee, "INSUFFICIENT_ENTROPY_FEE");

        uint64 sequenceNumber = entropy.requestV2{value: fee}(provider, userRandomNumber, ENTROPY_CALLBACK_GAS_LIMIT);
        game.entropySequenceNumber = sequenceNumber;
        entropySequenceToSessionId[sequenceNumber] = sessionId;
        entropySequenceToPlayer[sequenceNumber] = msg.sender;

        emit PlayerJoined(sessionId, msg.sender);
        emit EntropyRequested(sessionId, msg.sender, provider, sequenceNumber);
    }

    function clickTile(uint256 sessionId, uint8 tileIndex) external {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(!session.finalized, "SESSION_FINALIZED");
        require(tileIndex < 64, "INVALID_TILE");

        PlayerGame storage game = playerGames[sessionId][msg.sender];
        require(game.joined, "PLAYER_NOT_JOINED");
        require(game.boardReady, "BOARD_NOT_READY");

        uint64 tileBit = uint64(1) << tileIndex;
        require(game.clickedMask & tileBit == 0, "TILE_ALREADY_CLICKED");

        game.clickedMask |= tileBit;

        TileOutcome outcome = TileOutcome.Empty;
        if (game.bombMask & tileBit != 0) {
            game.bombsHit += 1;
            outcome = TileOutcome.Bomb;
        } else if (game.prizeMask & tileBit != 0) {
            game.prizesFound += 1;
            outcome = TileOutcome.Prize;
        }

        emit TileClicked(sessionId, msg.sender, tileIndex);
        emit TileResolved(sessionId, msg.sender, tileIndex, outcome);
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
