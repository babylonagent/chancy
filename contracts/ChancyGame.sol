// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChancyGameBase} from "./ChancyGameBase.sol";

/// @notice Production-shaped Chancy game contract.
/// @dev Deploy fresh with the real project token when ready.
contract ChancyGame is ChancyGameBase {
    constructor(address gameTokenAddress, address entropyAddress) ChancyGameBase(gameTokenAddress, entropyAddress) {}
}
