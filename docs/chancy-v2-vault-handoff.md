# Chancy V2 Vault Deployment Handoff

No V2 contract has been deployed from this session.

## Provided role addresses

| Role | Address |
| --- | --- |
| Controller / owner | `0xca237adb637fc628d317f5f1c5e2522e1ea22ddd` |
| Hot withdrawal wallet | `0xbcd9b0ba388608598f9eaab43bfc7ba44324f860` |
| Cold treasury wallet | `0x51a17e6dae3d0d04174734b906bb201cc79a20ff` |

## Constructor

```solidity
ChancyVault(address usdcAddress, address controller, address initialHotWallet, address initialColdWallet)
```

## Base mainnet constructor args

```txt
usdcAddress        = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
controller         = 0xca237adb637fc628d317f5f1c5e2522e1ea22ddd
initialHotWallet   = 0xbcd9b0ba388608598f9eaab43bfc7ba44324f860
initialColdWallet  = 0x51a17e6dae3d0d04174734b906bb201cc79a20ff
```

## Money flow

1. Player approves USDC to `ChancyVault`.
2. Player calls `deposit(amount)`.
3. Vault holds the USDC and emits `Deposited(player, amount)`.
4. Backend credits in-game USD after confirmed deposit event.
5. Controller can sweep surplus vault USDC to the cold wallet using `sweepToCold(amount)`.
6. Hot wallet is separate liquidity for backend-managed withdrawals; the current vault does not automatically fund or spend from hot wallet.

## Separation rules

- Controller must not equal hot wallet.
- Controller must not equal cold wallet.
- Hot wallet must not equal cold wallet.
- Zero addresses are rejected.
- Only controller can update hot/cold wallet addresses or sweep vault funds to cold wallet.

## Current implementation status

Implemented and tested:

- `ChancyVault.sol`
- role separation
- USDC deposits
- deposit event for backend crediting
- controller-only cold sweep
- controller-only hot/cold wallet updates

Still needed before production deployment:

- withdrawal execution model from hot wallet
- backend deposit indexer reading `Deposited` events
- durable ledger reconciliation
- deployment script + no-broadcast gas estimate
- Base Sepolia deploy/smoke before mainnet
