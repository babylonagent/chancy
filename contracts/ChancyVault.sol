// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Chancy V2 USDC custody vault.
/// @dev Receives player deposits for offchain USD credits. Controller ownership,
///      hot withdrawal liquidity, and cold treasury reserve are separate roles.
contract ChancyVault is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public hotWallet;
    address public coldWallet;
    uint256 public totalDeposited;
    uint256 public totalSweptToCold;

    event Deposited(address indexed player, uint256 amount);
    event SweptToCold(address indexed coldWallet, uint256 amount);
    event HotWalletUpdated(address indexed previousHotWallet, address indexed newHotWallet);
    event ColdWalletUpdated(address indexed previousColdWallet, address indexed newColdWallet);

    constructor(address usdcAddress, address controller, address initialHotWallet, address initialColdWallet)
        Ownable(controller)
    {
        require(usdcAddress != address(0), "INVALID_USDC");
        require(controller != address(0), "INVALID_CONTROLLER");
        require(initialHotWallet != address(0), "INVALID_HOT_WALLET");
        require(initialColdWallet != address(0), "INVALID_COLD_WALLET");
        require(controller != initialHotWallet && controller != initialColdWallet && initialHotWallet != initialColdWallet, "DUPLICATE_ROLE");
        usdc = IERC20(usdcAddress);
        hotWallet = initialHotWallet;
        coldWallet = initialColdWallet;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "INVALID_AMOUNT");
        totalDeposited += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function sweepToCold(uint256 amount) external onlyOwner {
        require(amount > 0, "INVALID_AMOUNT");
        totalSweptToCold += amount;
        usdc.safeTransfer(coldWallet, amount);
        emit SweptToCold(coldWallet, amount);
    }

    function setHotWallet(address newHotWallet) external onlyOwner {
        require(newHotWallet != address(0), "INVALID_HOT_WALLET");
        require(newHotWallet != owner() && newHotWallet != coldWallet, "DUPLICATE_ROLE");
        address previous = hotWallet;
        hotWallet = newHotWallet;
        emit HotWalletUpdated(previous, newHotWallet);
    }

    function setColdWallet(address newColdWallet) external onlyOwner {
        require(newColdWallet != address(0), "INVALID_COLD_WALLET");
        require(newColdWallet != owner() && newColdWallet != hotWallet, "DUPLICATE_ROLE");
        address previous = coldWallet;
        coldWallet = newColdWallet;
        emit ColdWalletUpdated(previous, newColdWallet);
    }
}
