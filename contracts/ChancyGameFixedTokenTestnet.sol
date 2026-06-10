// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice TEST CONTRACT ONLY.
/// @dev Hardcodes temporary game token for full gameplay testing. Do not use for production deployment.
contract ChancyGameFixedTokenTestnet {
    using SafeERC20 for IERC20;

    address public constant GAME_TOKEN = 0x3E1A6D23303bE04403BAdC8bFF348027148Fef27;

    enum Difficulty {
        Easy,
        Normal,
        Hardcore
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
        bytes32 boardCommitment;
        bool revealSubmitted;
        bool finalized;
    }

    uint256 public nextSessionId = 1;

    mapping(uint256 => Session) public sessions;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => uint64)) public clickedTiles;

    event SessionCreated(
        uint256 indexed sessionId,
        address indexed host,
        Difficulty difficulty,
        uint8 bombCount,
        uint8 prizeCount
    );
    event PlayerJoined(uint256 indexed sessionId, address indexed player);
    event TileClicked(uint256 indexed sessionId, address indexed player, uint8 tileIndex);

    function createSession(
        Difficulty difficulty,
        uint256 entryAmount,
        uint256 maxPlayers,
        uint256 rewardPerPrize,
        bytes32 boardCommitment
    ) external returns (uint256 sessionId) {
        require(entryAmount > 0, "INVALID_ENTRY_AMOUNT");
        require(maxPlayers > 0, "INVALID_MAX_PLAYERS");
        require(boardCommitment != bytes32(0), "INVALID_COMMITMENT");

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
            boardCommitment: boardCommitment,
            revealSubmitted: false,
            finalized: false
        });

        emit SessionCreated(sessionId, msg.sender, difficulty, bombCount, prizeCount);
    }

    function joinSession(uint256 sessionId) external {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(!session.finalized, "SESSION_FINALIZED");
        require(!joined[sessionId][msg.sender], "ALREADY_JOINED");
        require(session.joinedPlayers < session.maxPlayers, "SESSION_FULL");

        joined[sessionId][msg.sender] = true;
        session.joinedPlayers += 1;

        IERC20(GAME_TOKEN).safeTransferFrom(msg.sender, address(this), session.entryAmount);

        emit PlayerJoined(sessionId, msg.sender);
    }

    function clickTile(uint256 sessionId, uint8 tileIndex) external {
        Session storage session = sessions[sessionId];
        require(session.host != address(0), "SESSION_NOT_FOUND");
        require(!session.finalized, "SESSION_FINALIZED");
        require(joined[sessionId][msg.sender], "PLAYER_NOT_JOINED");
        require(tileIndex < 64, "INVALID_TILE");

        uint64 tileBit = uint64(1) << tileIndex;
        uint64 previousClicks = clickedTiles[sessionId][msg.sender];
        require(previousClicks & tileBit == 0, "TILE_ALREADY_CLICKED");

        clickedTiles[sessionId][msg.sender] = previousClicks | tileBit;

        emit TileClicked(sessionId, msg.sender, tileIndex);
    }

    function _difficultyConfig(Difficulty difficulty) internal pure returns (uint8 bombCount, uint8 prizeCount) {
        if (difficulty == Difficulty.Easy) return (5, 3);
        if (difficulty == Difficulty.Normal) return (7, 2);
        return (10, 1);
    }
}
