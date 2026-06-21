# Chancy V2 Credit Game Spec

## Goal

Remove wallet prompts from each tile reveal. Players deposit USDC once, receive in-game USD credits 1:1, play instantly, and withdraw later.

## V2 trust model

V2 is server-side gameplay with after-the-fact fairness verification. ZK is intentionally out of scope for V2, but the architecture keeps the core inputs needed for a future ZK proof engine.

## Core flow

1. Player deposits USDC into `ChancyVault`.
2. Vault sends a 5% deposit fee to the controller and emits gross/net/fee amounts.
3. Backend credits USD balance from the net `creditedAmount`.
4. Player starts a session with a stake.
5. Session consumes Pyth Entropy randomness once.
6. Server deterministically derives a 64-tile board from entropy, session id, player, and mode.
7. Server stores board privately and publishes `boardCommitHash`.
8. Player clicks tiles instantly through the API.
9. Duplicate clicks are idempotent and never charged twice.
10. Session ends on 3 bombs, all prizes found, or player exit.
11. Server reveals entropy, full board, clicked history, and commit hash for verification.

## Mode config

| Mode | Bombs | Prizes |
| --- | ---: | ---: |
| Easy | 5 | 3 |
| Normal | 7 | 2 |
| Hardcore | 10 | 1 |

## Board generation

Board generation must be deterministic:

```txt
board = deriveBoard(entropy, sessionId, player, mode)
boardCommitHash = sha256(entropy, sessionId, player, mode, board)
```

The API never returns bomb/prize positions while the session is active.

## API foundation implemented

Current V2 foundation endpoints:

- `POST /v2/credits/deposit`
- `GET /v2/credits/:player`
- `POST /v2/withdrawals/request`
- `GET /v2/withdrawals/:player`
- `POST /v2/withdrawals/:withdrawalId/mark-paid`
- `POST /v2/sessions`
- `POST /v2/sessions/:sessionId/click`
- `POST /v2/sessions/:sessionId/exit`

Withdrawal queue behavior:

- Requesting a withdrawal creates a `pending` withdrawal and reduces `withdrawable` credits by the gross requested `amount`, but does not immediately change the total credit balance.
- Each withdrawal records `amount`, `payoutAmount`, and `feeAmount` using 5% fee accounting: `payoutAmount = amount * 95%`, `feeAmount = amount * 5%`.
- Marking a withdrawal `paid` requires a hot-wallet transaction hash and then deducts the gross `amount` from the player credit balance.
- Production must restrict `mark-paid` behind admin auth before live use.

Current implementation is an API/engine foundation using file-backed JSON storage when `CHANCY_V2_STORE_PATH` is configured. Production should replace this with a real database before serious funds.

## Production requirements still open

- Durable DB storage for credits, sessions, board ciphertext, clicked history, and append-only ledger entries.
- USDC deposit verification from Base transaction logs.
- Withdrawal queue backed by hot wallet, manual/automated risk rules, and cold wallet reserve policy.
- Pyth Entropy request/callback integration for V2 session starts.
- Admin/reconciliation tooling: total credits liabilities must match deposits minus withdrawals plus game outcomes.
- Frontend redesign for deposit, play, exit, fairness receipt, and withdrawal.

## Wallet and money-flow model before contract deployment

No V2 contract should be deployed until these addresses are provided explicitly:

- `CHANCY_CONTROLLER_ADDRESS` — owner/admin/controller. Separate from hot and cold wallets.
- `CHANCY_HOT_WALLET_ADDRESS` — limited withdrawal liquidity only.
- `CHANCY_COLD_WALLET_ADDRESS` — treasury/reserve wallet for most funds.
- `CHANCY_USDC_ADDRESS` — Base USDC.

Recommended V2 custody flow:

1. Player deposits USDC into a `ChancyVault` contract, not directly into the hot wallet.
2. The vault emits a deposit event.
3. Backend waits for confirmation and credits the player in-game USD 1:1.
4. Vault/controller treasury policy keeps only operating liquidity in the hot wallet.
5. Surplus funds are swept to the cold wallet.
6. Player withdrawals are queued in the backend ledger.
7. Normal withdrawals are paid from the hot wallet.
8. Large/suspicious withdrawals pause for manual review or cold-wallet refill.
9. Controller wallet owns contract settings and emergency controls, but does not act as hot withdrawal liquidity.

This separates roles:

| Role | Holds funds? | Purpose |
| --- | --- | --- |
| Controller wallet | No routine funds | Owns contract/admin settings, pause, treasury policies |
| Vault contract | Yes, initially | Receives player deposits and emits auditable deposit events |
| Hot wallet | Limited | Pays normal withdrawals only |
| Cold wallet | Majority | Long-term treasury/reserve |

Security rule: hot wallet compromise should not drain cold wallet or controller ownership. Controller compromise should be protected by multisig/timelock later, but V2 should already keep it separate from day-to-day withdrawal funds.

## ZK later

Future ZK proofs can target:

- `boardCommitHash`
- deterministic `deriveBoard` inputs
- clicked tile history
- outcome correctness
- payout math

Do not build ZK in V2.
