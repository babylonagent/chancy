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
    uint256 public totalSweptToHot;

    event Deposited(address indexed player, uint256 grossAmount, uint256 creditedAmount, uint256 feeAmount);
    event SweptToCold(address indexed coldWallet, uint256 amount);
    event SweptToHot(address indexed hotWallet, uint256 amount);
    event HotWalletUpdated(address indexed previousHotWallet, address indexed newHotWallet);
    event ColdWalletUpdated(address indexed previousColdWallet, address indexed newColdWallet);

    /// @dev Only the controller (owner) or the hot wallet (automated rebalancer)
    ///      can trigger vault→hot sweeps. The hot wallet key lives on the server
    ///      so the rebalance loop runs autonomously.
    modifier onlyHotOrOwner() {
        require(msg.sender == hotWallet || msg.sender == owner(), "NOT_HOT_OR_OWNER");
        _;
    }

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

    /// @notice Sweep USDC from the vault to the cold wallet (treasury reserve).
    /// @dev Controller-only. Used to move excess deposits to long-term storage.
    function sweepToCold(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        totalSweptToCold += amount;
        usdc.safeTransfer(coldWallet, amount);
        emit SweptToCold(coldWallet, amount);
    }

    /// @notice Sweep USDC from the vault to the hot wallet (withdrawal liquidity).
    /// @dev Callable by the hot wallet or owner. The automated rebalancer calls
    ///      this to top up the hot wallet when it runs low on payout funds.
    function sweepToHot(uint256 amount) external onlyHotOrOwner nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        totalSweptToHot += amount;
        usdc.safeTransfer(hotWallet, amount);
        emit SweptToHot(hotWallet, amount);
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
