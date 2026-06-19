# Chancy V2 Credit Game Spec

## Goal

Remove wallet prompts from each tile reveal. Players deposit USDC once, receive in-game USD credits 1:1, play instantly, and withdraw later.

## V2 trust model

V2 is server-side gameplay with after-the-fact fairness verification. ZK is intentionally out of scope for V2, but the architecture keeps the core inputs needed for a future ZK proof engine.

## Core flow

1. Player deposits USDC.
2. Backend credits USD balance 1:1.
3. Player starts a session with a stake.
4. Session consumes Pyth Entropy randomness once.
5. Server deterministically derives a 64-tile board from entropy, session id, player, and mode.
6. Server stores board privately and publishes `boardCommitHash`.
7. Player clicks tiles instantly through the API.
8. Duplicate clicks are idempotent and never charged twice.
9. Session ends on 3 bombs, all prizes found, or player exit.
10. Server reveals entropy, full board, clicked history, and commit hash for verification.

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
- `POST /v2/sessions`
- `POST /v2/sessions/:sessionId/click`
- `POST /v2/sessions/:sessionId/exit`

Current implementation is an API/engine foundation using in-process storage for tests. Production must replace this with durable storage before real funds.

## Production requirements still open

- Durable DB storage for credits, sessions, board ciphertext, clicked history, and append-only ledger entries.
- USDC deposit verification from Base transaction logs.
- Withdrawal queue backed by hot wallet, manual/automated risk rules, and cold wallet reserve policy.
- Pyth Entropy request/callback integration for V2 session starts.
- Admin/reconciliation tooling: total credits liabilities must match deposits minus withdrawals plus game outcomes.
- Frontend redesign for deposit, play, exit, fairness receipt, and withdrawal.

## ZK later

Future ZK proofs can target:

- `boardCommitHash`
- deterministic `deriveBoard` inputs
- clicked tile history
- outcome correctness
- payout math

Do not build ZK in V2.
