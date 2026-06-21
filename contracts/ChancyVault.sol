// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Chancy V2 USDC custody vault.
/// @dev Receives player deposits for offchain USD credits. Controller ownership,
///      hot withdrawal liquidity, and cold treasury reserve are separate roles.
contract ChancyVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_DEPOSIT_FEE_BPS = 500;

    IERC20 public immutable usdc;
    address public hotWallet;
    address public coldWallet;
    uint16 public immutable depositFeeBps;
    uint256 public totalDeposited;
    uint256 public totalCredited;
    uint256 public totalFeesCollected;
    uint256 public totalSweptToCold;

    event Deposited(address indexed player, uint256 grossAmount, uint256 creditedAmount, uint256 feeAmount);
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
        depositFeeBps = MAX_DEPOSIT_FEE_BPS;
    }

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        uint256 feeAmount = amount * depositFeeBps / BPS_DENOMINATOR;
        uint256 creditedAmount = amount - feeAmount;
        totalDeposited += amount;
        totalCredited += creditedAmount;
        totalFeesCollected += feeAmount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (feeAmount > 0) {
            usdc.safeTransfer(owner(), feeAmount);
        }
        emit Deposited(msg.sender, amount, creditedAmount, feeAmount);
    }

    function sweepToCold(uint256 amount) external onlyOwner nonReentrant {
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
