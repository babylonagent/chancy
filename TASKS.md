# Chancy — Build Tasks

Tile-reveal USDC game on Base. Deposit USDC once → 1:1 credits (net 95%) → play
instant server-side sessions (no per-move wallet tx) → withdraw later.

**Money core:** committed `5cb735f`, 9/9 integration tests green (`npm run api:test`).

---

## ✅ Done & test-proven (backend)

- [x] Trustless deposit verify — decodes on-chain `Deposited` event from our vault, credits real net (95%), idempotent by txHash. Client-claimed amounts ignored (kills "$1 vanished").
- [x] Anti-spoof — deposit log must be emitted by the vault address or it's rejected.
- [x] Payout-on-win — collect all prizes → pot = `stake × multiplier` (Easy 1.5× / Normal 2.5× / Hardcore 5×). Unified ledger: win credits = deposit credits = withdrawable.
- [x] Server-side session/click engine, `$0.05` stake debit, insufficient-credit guard.
- [x] Withdrawal accounting — request reserves withdrawable; `mark-paid` deducts balance (95% payout, 5% fee).
- [x] 9 vitest + supertest integration tests, incl. a guaranteed-win playthrough via `deriveBoard`.

## 🔨 In progress

- [ ] **#1 Frontend rewire to V2 credits** — remove per-click & per-join wallet popups; clicks resolve via `POST /v2/sessions/:id/click`.

## 📋 Pending

- [ ] **#3 Credit dashboard** — balance, session state, withdrawal section reading `GET /v2/credits/:player`.
- [ ] **#4 Session entry = $0.05 credit debit** as the UI default (engine already supports stake debit).
- [ ] **#5 Force Base network** on connect; auto-switch if wrong chain (fix Abstract default).
- [ ] **#6 Full game-shell UI rebuild** — clean modern mobile-game, cold-player copy, fix "Prizes: N" wording (collect all pieces to win pot).
- [ ] **#7 Mobile fixes** — modal scroll-lock body, layout/positioning.
- [ ] **#8 VPS deploy + real playthrough** — deposit → credits → join → click (no popup) → withdraw on Base Sepolia. Includes hot-wallet **auto-payout relayer** (withdrawals currently need manual `mark-paid`).

---

## Critical path

`#1 → #3..#7 (frontend) → #8 (deploy + relayer)`

## Open business call

- Withdrawal fee on **winnings**: currently 5% applies to every cashout incl. won credits. Decide whether winnings withdraw fee-free (only principal taxed). One-line tunable.

## Reference

- API: `apps/api/server.js` (verifier injection), `apps/api/v2.js` (credit engine).
- Tests: `apps/api/v2.test.js`, run `npm run api:test`.
- Chain: Base Sepolia. Vault `0x6fa1136097c6ECC6Dc5fE746c77B57684a938E39`.
- Hosting: stateful API → VPS with `CHANCY_V2_STORE_PATH` (never keys on Vercel).
