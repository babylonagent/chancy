// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChancyGameBase} from "./ChancyGameBase.sol";

/// @notice Production Chancy game contract.
/// @dev Settles sessions in native ETH (always available) or an allow-listed
///      ERC20. Pass the Pyth Entropy address and the initial allow-listed asset
///      (USDC on Base) at deployment; manage more assets via setAssetAllowed.
contract ChancyGame is ChancyGameBase {
    constructor(address entropyAddress, address initialAllowedAsset)
        ChancyGameBase(entropyAddress, initialAllowedAsset)
    {}
}
