# Chancy

**Trustless P2P tile-reveal game on Base.** Hosts fund prize pots. Players pay per tile. Find all prizes to win the pot. Dodge bombs to survive.

```
chancy.cash
```

## How it works

```
Host creates game → locks prize pot ($5+)
   ↓
Player browses open games → joins (pays $0.05 entrance)
   ↓
Player reveals tiles → progressive cost per tile
   ↓
Find ALL prizes → win the pot
3 bombs → game over (host earns player's spent)
Quit anytime → keep prizes earned
```

## Trustless architecture

| Component | Mechanism | Verification |
|---|---|---|
| **Deposits** | Raw USDC transfer to vault → indexer credits sender | [Indexer watches on-chain Transfer events](apps/api/deposit-indexer.js) |
| **Board fairness** | Commit-reveal + Pyth Entropy on-chain randomness | [Server can't grind boards](apps/api/v2.js#L92) |
| **Prize pots** | Locked in credit ledger from host's deposited balance | Server-side ledger, backed by SQLite |
| **Payouts** | Hot wallet relayer auto-pays pending withdrawals | [Payout relayer](scripts/payout-relayer.js) |
| **Fund safety** | 5% fees to controller, rebalance sweeps vault↔hot | [Rebalance service](scripts/rebalance.js) |

### No approve needed — single-tx deposits

Players send USDC directly to the vault address. An indexer watches the USDC `Transfer` event and auto-credits the sender (95% net, 5% fee stays in vault). **Zero spending cap approvals, works with any wallet.**

```
Player sends USDC → Vault address
         ↓
Indexer detects Transfer(from=player, to=vault, amount)
         ↓
Credits player: amount × 95% (idempotent by txHash)
```

### Commit-reveal fairness

Players commit `hash(entropy:salt)` before joining. The server requests Pyth Entropy on-chain randomness only after the commitment is locked — preventing board grinding by selectively aborting.

```
Player generates entropy + salt locally
         ↓
Commits hash(entropy:salt) at join
         ↓
Server requests Pyth Entropy (on-chain, verifiable)
         ↓
Board = f(pythRandom, sessionId, player, mode)
```

## Game modes

| Mode | Bombs | Prizes | First tile cost |
|---|---|---|---|
| **Easy** | 5 | 3 | 1.5% of pot |
| **Normal** | 7 | 2 | 2.5% of pot |
| **Hardcore** | 10 | 1 | 3.5% of pot |

Tile costs increase progressively. 3 bombs = game over.

## Tech stack

- **Chain:** Base L2 (mainnet)
- **Contracts:** Solidity, Hardhat
- **Randomness:** [Pyth Entropy](https://docs.pyth.network/entropy)
- **Backend:** Node.js, Express, SQLite
- **Frontend:** React, Vite
- **Indexer:** viem, polls USDC Transfer events

## Contract addresses (Base mainnet)

| Contract | Address |
|---|---|
| ChancyVault | `0xbE81cE9d9909A31184D1878075f60bbbf8571612` |
| ChancyRandomness | `0x705dF0f1667Ed82bB25E5a51273a9Ea6dE5C6e96` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Pyth Entropy | `0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb` |

All verifiable on [Basescan](https://basescan.org).

## Project structure

```
contracts/          Solidity contracts (vault, game, randomness)
abi/                Exported ABIs
apps/api/           V2 API server + indexer
  ├── v2.js           Game engine (sessions, credits, P2P mechanics)
  ├── deposit-indexer.js  Watches USDC transfers, auto-credits
  ├── server.js       Express app, security middleware, entropy
  ├── sqlite-store.js Persistent ledger
  ├── entropy.js      Pyth Entropy requester
  └── security.js     Rate limiting, CORS, headers
apps/web/           React frontend
scripts/            Deploy, verify, relayer, rebalance, monitor
test/               Hardhat contract tests
docs/               Specs and handoff docs
```

## Agent-Friendly / x402 Payments

Chancy supports both **human players** (credit ledger) and **AI agents** (x402 pay-per-action). Agents can play the full game loop via REST API without pre-funding, API keys, or accounts.

### How x402 works

The [x402 protocol](https://github.com/coinbase/x402) turns HTTP 402 (Payment Required) into a standard machine-to-machine payment flow:

```
Agent calls an x402 endpoint
         ↓
Server returns HTTP 402 + payment requirements (amount, USDC, facilitator)
         ↓
Agent signs EIP-3009 USDC transferAuthorization
         ↓
Agent retries request with PAYMENT-SIGNATURE header
         ↓
Coinbase facilitator verifies signature → settles on-chain
         ↓
Game action executes (join, click, etc.)
```

No deposits, no wallets connected in a UI, no spending-cap approvals — agents sign a single USDC transfer per action.

### x402 Endpoints

All agent endpoints live under `/v2/x402/`. Free endpoints never return 402; paid endpoints return 402 until payment is attached.

| Method | Endpoint | Cost | Description |
|---|---|---|---|
| `GET` | `/v2/x402/sessions` | Free | List open games |
| `POST` | `/v2/x402/sessions/create` | Pays prize pot | Host a new game |
| `POST` | `/v2/x402/sessions/:id/join` | $0.05 entrance | Join a game |
| `POST` | `/v2/x402/sessions/:id/reveal` | Free | Reveal board entropy |
| `POST` | `/v2/x402/sessions/:id/click` | Pays tile cost | Reveal a tile |
| `POST` | `/v2/x402/sessions/:id/quit` | Free | Quit and settle |

### Credit-based Endpoints (human players)

The credit ledger endpoints (used by the web frontend) live under `/v2/`:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v2/config` | Server config (vault address) |
| `GET` | `/v2/credits/:address` | Get credit balance |
| `GET` | `/v2/sessions` | List open games |
| `POST` | `/v2/sessions/create` | Host a game (debits credit) |
| `POST` | `/v2/sessions/:id/join` | Join a game (debits credit) |
| `POST` | `/v2/sessions/:id/reveal` | Reveal entropy |
| `POST` | `/v2/sessions/:id/click` | Reveal a tile (debits credit) |
| `POST` | `/v2/sessions/:id/quit` | Quit and settle |
| `POST` | `/v2/sessions/:id/close` | Host closes game (refunds pot) |
| `POST` | `/v2/withdrawals/request` | Withdraw credits to wallet |

## How agents can play (Quick Start)

The reference Python client (`chancy_x402_client.py`) implements the full x402 game loop:

```bash
# Install dependencies
pip install eth-account web3 requests

# List open games
python3 chancy_x402_client.py --key 0xYOUR_PRIVATE_KEY --list

# Play automatically (joins, reveals tiles, quits on low odds)
python3 chancy_x402_client.py --key 0xYOUR_PRIVATE_KEY --play
```

The agent needs:
- A funded EOA on Base with USDC
- The private key (for signing EIP-3009 transfers)
- No on-chain approvals — x402 uses `transferWithAuthorization`

### Hermes agent integration

Chancy ships a [Hermes Agent skill](https://hermes-agent.nousresearch.com/docs) for playing via x402 directly from an AI agent. See the skill under `skills/` to let Hermes host, join, and play Chancy games autonomously.

## Fee model

| Fee | Rate | Destination |
|---|---|---|
| Deposit | 5% | Stays in vault → swept to controller |
| Withdrawal | 5% | Controller |
| Session | $0.05 entrance | Host |

Credits are 1:1 with USDC. Win payouts are fee-free.

## Security

- **No secrets in frontend or public repo** — private keys live only on the VPS
- **Exact-amount deposits** — no unlimited approvals, ever
- **Idempotent indexer** — txHash deduplication prevents double-credits
- **Rate limiting** — per-endpoint limits on API
- **Commit-reveal** — server cannot selectively abort to grind boards

## License

MIT
