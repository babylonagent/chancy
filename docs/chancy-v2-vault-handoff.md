# Chancy V2 Vault Deployment Handoff

Base Sepolia V2 vault is deployed and constructor state is verified.

## Base Sepolia deployment

```txt
ChancyVault        = 0x6fa1136097c6ECC6Dc5fE746c77B57684a938E39
USDC               = 0x036cbd53842c5426634e7929541ec2318f3dcf7e
Controller / owner = 0xca237adb637fc628d317f5f1c5e2522e1ea22ddd
Hot wallet         = 0xbcd9b0ba388608598f9eaab43bfc7ba44324f860
Cold wallet        = 0x51a17e6dae3d0d04174734b906bb201cc79a20ff
Deposit fee        = 500 bps
```

Verified on Base Sepolia: owner/controller, USDC, hot wallet, cold wallet, `depositFeeBps=500`, `MAX_DEPOSIT_FEE_BPS=500`.

## Final V2 custody shape

Chancy V2 uses **one vault contract plus three distinct wallets**:

| Role | Address | Purpose |
| --- | --- | --- |
| Controller / owner | `0xca237adb637fc628d317f5f1c5e2522e1ea22ddd` | Owns vault settings and receives protocol fees |
| Hot withdrawal wallet | `0xbcd9b0ba388608598f9eaab43bfc7ba44324f860` | Limited liquidity for normal backend-managed withdrawals |
| Cold treasury wallet | `0x51a17e6dae3d0d04174734b906bb201cc79a20ff` | Reserve destination for swept surplus funds |

The three wallet addresses must remain distinct. Zero addresses and duplicate role addresses are rejected by the constructor/setters.

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

## Deposit fee flow

`depositFeeBps = 500` and `MAX_DEPOSIT_FEE_BPS = 500`.

Example: player deposits `100 USDC`:

1. Player approves USDC to `ChancyVault`.
2. Player calls `deposit(100 USDC)`.
3. Vault pulls `100 USDC`.
4. Controller receives `5 USDC` immediately.
5. Vault retains `95 USDC` as credit backing.
6. Vault emits `Deposited(player, grossAmount, creditedAmount, feeAmount)`.
7. Backend credits the player from `creditedAmount`, not `grossAmount`.

Tracked counters:

- `totalDeposited` — gross deposits.
- `totalCredited` — net credit backing retained by vault.
- `totalFeesCollected` — deposit fees sent to controller.
- `totalSweptToCold` — surplus swept from vault to cold wallet.

## Withdrawal fee flow

Withdrawals are still backend/hot-wallet managed. The V2 API queue now records 5% fee accounting:

Example: player requests withdrawal of `100 credits`:

| Field | Amount |
| --- | ---: |
| `amount` | `100` credits burned/locked |
| `payoutAmount` | `95` USDC to player |
| `feeAmount` | `5` USDC protocol fee |

Pending withdrawals reduce `withdrawable` by the gross `amount`. Marking a withdrawal paid burns the gross `amount` from the player ledger and preserves `payoutAmount`/`feeAmount` for reconciliation.

## Separation rules

- Controller must not equal hot wallet.
- Controller must not equal cold wallet.
- Hot wallet must not equal cold wallet.
- Only controller can update hot/cold wallet addresses.
- Only controller can sweep vault funds to cold wallet.
- Hot wallet compromise should not drain cold wallet or controller ownership.

## Implemented and tested

- `ChancyVault.sol`
- Controller/hot/cold role separation.
- 5% deposit fee to controller.
- Net deposit credit backing in vault.
- Deposit event with gross/net/fee fields.
- Controller-only cold sweep.
- Controller-only hot/cold wallet updates.
- V2 withdrawal queue with `amount`, `payoutAmount`, and `feeAmount`.
- Updated `abi/ChancyVault.json` export.

## Still needed before production deployment

- Deployment script and no-broadcast gas estimate for `ChancyVault`.
- Base Sepolia deploy and on-chain smoke.
- Backend deposit indexer reading `Deposited(... creditedAmount ...)` events.
- Durable DB ledger and reconciliation.
- Admin auth/risk checks for `mark-paid`.
- Hot wallet payout executor and cold reserve refill policy.
