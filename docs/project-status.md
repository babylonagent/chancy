# Chancy Project Status

Updated: 2026-06-26

## Current state

Chancy V2 is live on Base mainnet at chancy.cash. P2P host-vs-player tile-reveal game with credit-ledger deposits, x402 agent payments, Farcaster Mini App support, and Bankr skill integration.

- Public apex: `https://chancy.cash`
- Public www: `https://www.chancy.cash`
- VPS: `167.233.22.140`
- API service: `chancy-api.service` (port 8788)
- nginx routes: `/health`, `/v2/*`, `/data/*`, `/tx/*`, `/read/*`
- TLS: Let's Encrypt, auto-renew via certbot

## Production contracts (Base mainnet)

- Network: Base mainnet (`8453`)
- ChancyVault: `0xbE81cE9d` (credit ledger, 5% deposit/withdraw fee)
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Pyth Entropy: `0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb`

## Architecture

| Component | Mechanism |
|---|---|
| Deposits | Raw USDC to vault → indexer credits sender 95% net (no approve needed) |
| Board fairness | Commit-reveal + Pyth Entropy on-chain randomness |
| Prize pots | Host deposits credits → locks pot → player joins for $0.05 |
| Payouts | Hot wallet relayer auto-pays pending withdrawals |
| Fund safety | 5% fees to controller, rebalance sweeps vault↔hot (cap $500) |
| Agent payments | x402 pay-per-action on /v2/x402/* endpoints (Coinbase CDP facilitator) |
| Agent integration | Bankr skill (PR #503), x402 client script |
| Social | Farcaster Mini App SDK with dual-context wallet |

## Recent work shipped (C46–C53)

| Task | What | Commits |
|---|---|---|
| C46 | P2P host-vs-player game mechanics + frontend rewrite | 617c2f0, aab22c0 |
| C47 | Indexer-based deposits — no approve, raw USDC transfer | 5e56051 |
| C48 | Reown AppKit (530+ wallets), landing page, favicon, manifest | 5ba417f, 132809b, 25ed10c, 9c2e90e, 9fd64ab |
| C49 | Deposit flow polish — wallet display, auto-poll, disconnect | 52a2ce0, fbf0976 |
| C50 | Player UX — error mapping, live credits, themes, optimistic updates | 2b709bb, 643cc7b, 1a6a96c |
| C51 | Bankr skill for x402 agent play (PR #503 to BankrBot/skills) | 6f08153 |
| C52 | Farcaster Mini App SDK + dual-context wallet | d59025f |
| C53 | Babylon branding + tech logos + README x402/API docs | 75c074d, b340d62, ede3d5f |

HEAD: `ede3d5f` — clean tree, 78 tracked files, zero secrets.

## Kanban state

- **Done:** C1–C53 (53 tasks completed)
- **Blocked:** C11 (optional mainnet deploy support), C12 (swap-to-USDC integration)

## Open / next-up work

1. **Swap-to-USDC integration (C12)** — replace external "Get USDC" link with embedded one-click swap (Uniswap widget / 0x / Coinbase). Blocked on prioritization.
2. **Live playthrough verification** — full deposit→play→win→withdraw cycle on mainnet with real assets. Requires explicit approval (spends real USDC).
3. **Farcaster launch** — Mini App SDK integrated but not yet published to Farcaster catalog. Needs Farcaster account/app configuration.
4. **Bankr skill adoption** — PR #503 submitted, awaiting merge. Promote to Bankr agent ecosystem.
5. **VPS redeploy** — latest commits (C46–C53) need VPS deploy to push changes live to chancy.cash. Local repo is ahead of production.

## Safety notes

- No private keys in Git, Vercel, docs, frontend bundles, or chats.
- Mainnet gameplay smoke not run — spends real assets, requires explicit approval.
- Hot wallet key on VPS filesystem — acceptable for small float, plan HSM/multisig for scale.
- Admin token is static bearer — rotation mechanism documented but not yet implemented (C43).
