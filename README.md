# Chancy

Commit-reveal-style block game for Base, using **Pyth Entropy** for per-player board generation.

## Contracts

- `contracts/ChancyGameFixedTokenTestnet.sol`
  - Disposable full-test contract.
  - Hardcoded temporary token CA: `0x3E1A6D23303bE04403BAdC8bFF348027148Fef27`.
  - Not for production deployment.

- `contracts/ChancyGame.sol`
  - Production-shaped contract.
  - Accepts `gameTokenAddress` and `entropyAddress` in the constructor.
  - Deploy fresh with the real project token when ready.

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
- Prize clicks accrue `rewardPerPrize` into claimable rewards.
- Token selection is not a host/session parameter.

## Reward funding

Sessions calculate maximum reward exposure at creation:

```text
totalRewardReserve = rewardPerPrize × prizeCount × maxPlayers
```

Players cannot join until the host funds that reserve with `fundSessionRewards(...)`.

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
- `POST /tx/fund-session-rewards`
- `POST /tx/join-session`
- `POST /tx/click-tile`
- `POST /tx/claim-rewards`

Read-call builders:

- `GET /read/session/:sessionId`
- `GET /read/player-game/:sessionId/:player`
- `GET /read/claimable-rewards/:player`
- `GET /read/next-session-id`

Each transaction endpoint returns:

```json
{
  "to": "0x...",
  "data": "0x...",
  "value": "0"
}
```

## Deployment

Copy env template:

```bash
cp .env.example .env
```

Set:

```text
PRIVATE_KEY=
BASE_RPC_URL=
BASE_SEPOLIA_RPC_URL=
CHANCY_GAME_TOKEN_ADDRESS=
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

## Commands

```bash
npm install
npm test
npm run build
npm run export:abi
```
