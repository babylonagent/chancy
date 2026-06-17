# Chancy Project Status

Updated: 2026-06-17T02:02:38Z

## Current state

Chancy V1 is deployed on Base mainnet and the live app/API are deployed on the VPS for `www.chancy.cash`. DNS is not yet pointed, so public HTTPS cannot be issued or verified until the domain resolves to the VPS.

## Production contract

- Network: Base mainnet (`8453`)
- ChancyGame: `0x2Cd96e21f3f3008ec6daFb464F12fa91C54DF36c`
- Controller owner: `0xebb5d4628dc10981432e7bc3a0ee336884701afe`
- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Pyth Entropy: `0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb`
- Verified: code exists, owner matches, USDC allowed, ETH allowed, entropy matches, `nextSessionId = 1` at deploy verification.

## App/API status

- Vercel preview remains available: `https://chancy-preview.vercel.app`
- VPS deployment target: `www.chancy.cash`
- VPS IP for DNS: `167.233.22.140`
- Static web root: `/var/www/chancy.cash`
- API service: `chancy-api.service`
- API port: `8788`
- nginx routes configured: `/health`, `/data/*`, `/tx/*`, `/read/*`

## Implemented after mainnet deploy

- Restored full API route surface removed during Vercel Hobby workaround:
  - `/api/read/[...path]`
  - `/api/tx/[...path]`
- Added real live session discovery:
  - `/data/sessions` queries the Base mainnet contract instead of showing fake rooms.
  - Frontend loads real sessions and displays empty state when none exist.
- Verified with local and VPS Host-header checks.

## Latest verification

- Contract/API tests: `16 passing`
- Web tests: `6 passing`
- Web build: passed
- Secret scan: clean
- VPS Host-header checks:
  - UI includes `Chancy`
  - `/health` returns mainnet contract
  - `/data/sessions` returns contract-backed session data

## Kanban state

Completed:

- C17 Rebuild web flow for corrected mechanics
- C18 Base Sepolia redeploy and smoke corrected game
- C19 Final V1 mainnet handoff refresh

Open:

- C20 DNS cutover + HTTPS verification

## Next steps when DNS is set

1. Point DNS for `chancy.cash` and `www.chancy.cash` to `167.233.22.140`.
2. Issue HTTPS certificate on the VPS.
3. Verify live public domain:
   - `https://www.chancy.cash`
   - `/health`
   - `/data/sessions`
   - `/tx/create-session`
   - `/read/session/:id`
   - `/read/current-reveal-cost/:id`
4. Commit any final docs/config deltas.

## Safety notes

- No private keys belong in Git, Vercel, docs, screenshots, or chats.
- Do not reduce functionality to satisfy Vercel limits. If hosting limits block deployment, use the VPS/main domain path instead.
- Mainnet gameplay smoke was not run because it spends real assets; only run it after explicit approval.
