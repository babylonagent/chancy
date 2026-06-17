# Chancy Project Status

Updated: 2026-06-17T08:41:03Z

## Current state

Chancy V1 is live on Base mainnet and publicly deployed on the VPS domain with HTTPS enabled.

- Public apex: `https://chancy.cash`
- Public www: `https://www.chancy.cash`
- VPS: `167.233.22.140`
- Static web root: `/var/www/chancy.cash`
- API service: `chancy-api.service`
- API port: `8788`
- nginx routes: `/health`, `/data/*`, `/tx/*`, `/read/*`
- TLS: Let's Encrypt certificate issued for `chancy.cash` and `www.chancy.cash`, auto-renew scheduled by certbot.

## Production contract

- Network: Base mainnet (`8453`)
- ChancyGame: `0x2Cd96e21f3f3008ec6daFb464F12fa91C54DF36c`
- Controller owner: `0xebb5d4628dc10981432e7bc3a0ee336884701afe`
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Pyth Entropy: `0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb`
- Verified: code exists, owner matches, USDC allowed, ETH allowed, entropy matches, `nextSessionId = 1` at deploy verification.

## App/API status

- Vercel preview remains available: `https://chancy-preview.vercel.app`
- Primary production domain is now the VPS-hosted `https://chancy.cash` / `https://www.chancy.cash` deployment.
- Frontend loads real sessions from `/data/sessions`.
- `/data/sessions` queries the Base mainnet contract instead of showing fake rooms.
- Full API route surface is preserved on VPS deployment; do not reduce functionality to fit Vercel limits.

## Latest verification

- Public DNS:
  - `chancy.cash A -> 167.233.22.140`
  - `www.chancy.cash A -> 167.233.22.140` observed via public resolvers; local resolver may lag.
- HTTPS certificate: issued successfully for `chancy.cash` and `www.chancy.cash`.
- `https://chancy.cash/` returns `200 OK`.
- `https://www.chancy.cash/` verified with explicit resolve to VPS because local resolver still lagged at verification time.
- `https://chancy.cash/health` returns mainnet contract `0x2Cd96e21f3f3008ec6daFb464F12fa91C54DF36c`.
- `https://chancy.cash/data/sessions` returns contract-backed session data: `nextSessionId = 1`, no fake sessions.
- `https://chancy.cash/tx/create-session` builds a transaction to the mainnet contract.
- `https://chancy.cash/read/session/1` builds read payload.
- `https://chancy.cash/read/current-reveal-cost/1` builds read payload.
- Browser smoke: `https://chancy.cash` loads `Chancy`; sessions page shows live contract-backed empty state and room controls.

## Kanban state

Completed:

- C17 Rebuild web flow for corrected mechanics
- C18 Base Sepolia redeploy and smoke corrected game
- C19 Final V1 mainnet handoff refresh
- C20 DNS cutover + HTTPS verification

Open / future work:

- Optional mainnet gameplay smoke only after explicit approval because it spends real assets.
- Optional production polish: create real first room, add public room examples, improve wallet/approval UX, monitor uptime.

## Safety notes

- No private keys belong in Git, Vercel, docs, screenshots, or chats.
- Mainnet gameplay smoke was not run because it spends real assets; only run it after explicit approval.
