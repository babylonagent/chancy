// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChancyGameBase} from "./ChancyGameBase.sol";

/// @notice TEST CONTRACT ONLY.
/// @dev Hardcodes temporary game token for full gameplay testing. Do not use for production deployment.
contract ChancyGameFixedTokenTestnet is ChancyGameBase {
    address public constant GAME_TOKEN = 0x3E1A6D23303bE04403BAdC8bFF348027148Fef27;

    constructor(address entropyAddress) ChancyGameBase(GAME_TOKEN, entropyAddress) {}
}
