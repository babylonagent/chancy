# Chancy

Commit-reveal-style block game for Base, using **Pyth Entropy** for per-player board generation.

## Contracts

- `contracts/ChancyGame.sol`
  - Production contract.
  - Constructor: `(entropyAddress, initialAllowedAsset, initialOwner)`.
  - Multi-asset by address: native ETH is `address(0)`; ERC20 settlement assets
    (e.g. USDC) are allow-listed by the owner via `setAssetAllowed`. New assets
    need no redeploy.

- `contracts/ChancyGameBase.sol`
  - Shared game logic.

## Randomness / board generation

Chancy does **not** use one shared hidden board per session.

Correct flow:

```text
host creates session with difficulty
→ host funds max prize exposure
→ player joins session
→ join transfers fixed game token entry amount
→ join requests Pyth Entropy randomness
→ Pyth Entropy callback returns random number
→ contract derives that player's 64-block board
→ player clicks tiles against their own board
→ bomb/prize/empty outcome is resolved
```

Storage shape:

```text
sessionId + player => PlayerGame
```

## Rules

- 64 hidden blocks.
- Host chooses difficulty at session initialization.
- Difficulty presets:
  - Easy: 5 bombs / 3 prizes
  - Normal: 7 bombs / 2 prizes
  - Hardcore: 10 bombs / 1 prize
- Duplicate tile clicks are rejected.
- Player cannot click until their Pyth Entropy board is ready.
- 3 bombs marks the player's game over and blocks further clicks.
- Prize clicks accrue a pro-rata share of the host-funded prize pot into claimable rewards.
- Settlement asset is a host/session parameter. Native ETH is `address(0)`; USDC is allow-listed.

## Host-funded prize pot

Hosts fund the full session prize pot during `createSession(asset, difficulty, prizePot)`.

Players reveal tiles with progressive per-tile costs based on the prize pot. If a player quits, hits 3 bombs, or becomes idle for more than one minute, the host receives the player's spent reveal costs.

## Pyth Entropy integration

Docs: https://docs.pyth.network/entropy/generate-random-numbers-evm

The contract uses:

- `IEntropyV2.getFeeV2(provider, gasLimit)`
- `IEntropyV2.requestV2(provider, userRandomNumber, gasLimit)`
- `IEntropyConsumer._entropyCallback(...)`
- internal `entropyCallback(...)` to derive the board

Tests use `contracts/test/MockEntropy.sol` to simulate the Pyth callback.

## Agent/API transaction builder

The API builds unsigned transaction payloads for wallets or agents.

```bash
npm run export:abi
CHANCY_CONTRACT_ADDRESS=0x... npm run api
```

Endpoints:

Transaction builders:

- `POST /tx/create-session`
- `POST /tx/join-session`
- `POST /tx/click-tile`
- `POST /tx/quit-session`
- `POST /tx/kick-idle-player`
- `POST /tx/claim-rewards`

Read/data endpoints:

- `GET /data/sessions`
- `GET /read/session/:sessionId`
- `GET /read/player-game/:sessionId/:player`
- `GET /read/claimable-rewards/:player/:asset`
- `GET /read/next-session-id`
- `GET /read/current-reveal-cost/:sessionId`

Each transaction endpoint returns:

```json
{
  "to": "0x...",
  "data": "0x...",
  "value": "0"
}
```

## Web client

The web client provides an 8×8 grid, API-backed payload builder controls, injected wallet execution, and a Vercel-ready preview deployment. The preview API is served by the same app through serverless `/tx/*`, `/read/*`, and `/health` routes.

```bash
npm run web:dev
npm run web:build
npm run web:test
```

Capabilities:

- Connect an injected Base-compatible wallet.
- Show API health and the configured Chancy contract address.
- Build create/join/click/quit/idle-kick/claim transaction payloads.
- Build session/player/claimable/next-session/reveal-cost read payloads.
- No private keys in UI.

## Preview deployment

The Vercel preview uses `vercel.json` to build the web app and expose the Express transaction builder as serverless routes. Store public contract/token addresses only; never deploy private keys or RPC API keys to Vercel.

Required preview environment variable:

```text
CHANCY_CONTRACT_ADDRESS=0x...
```

Optional public web config:

```text
VITE_CHANCY_API_URL=
VITE_CHANCY_BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS=0x036cbd53842c5426634e7929541ec2318f3dcf7e
```

Deploy preview:

```bash
vercel deploy --prod
```

Do not commit RPC URLs, API keys, private keys, or token launch secrets. The browser wallet supplies the active Base RPC for reads and sends.

## Deployment

Copy env template:

```bash
cp .env.example .env
```

Set runtime-only values:

```text
PRIVATE_KEY=
BASE_RPC_URL=
BASE_SEPOLIA_RPC_URL=
CHANCY_OWNER_ADDRESS=
CHANCY_USDC_ADDRESS=
PYTH_ENTROPY_ADDRESS=
CHANCY_CONTRACT_ADDRESS=
```

Deploy production-shaped contract:

```bash
npx hardhat run scripts/deploy-chancy-game.js --network baseSepolia
```

Local smoke deploy:

```bash
npx hardhat run scripts/smoke-local-deploy.js
```

For mainnet handoff, see [`docs/mainnet-handoff.md`](docs/mainnet-handoff.md).

## Commands

```bash
npm install
npm test
npm run build
npm run export:abi
npm run web:test
npm run web:build
```
