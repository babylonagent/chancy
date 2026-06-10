# Chancy

Commit-reveal-style block game for Base, now using **Pyth Entropy** for per-player board generation.

## Current scope

This repo starts with the disposable full-test contract:

- `contracts/ChancyGameFixedTokenTestnet.sol`
- Hardcoded temporary token CA: `0x3E1A6D23303bE04403BAdC8bFF348027148Fef27`
- This contract is **test only** and must not be used as production deployment.

Production will use a fresh main contract deployed with the real project token.

## Randomness / board generation

Chancy does **not** use one shared hidden board per session.

Correct flow:

```text
host creates session with difficulty
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

`PlayerGame` tracks:

- joined
- boardReady
- gameOver
- Pyth Entropy sequence number
- bomb mask
- prize mask
- clicked mask
- bombs hit
- prizes found

## Rules

- 64 hidden blocks.
- Host chooses difficulty at session initialization.
- Difficulty presets:
  - Easy: 5 bombs / 3 prizes
  - Normal: 7 bombs / 2 prizes
  - Hardcore: 10 bombs / 1 prize
- Duplicate tile clicks are rejected.
- Player cannot click until their Pyth Entropy board is ready.
- Bomb clicks increment `bombsHit`.
- 3 bombs marks the player's game over and blocks further clicks.
- Prize clicks increment `prizesFound` and accrue `rewardPerPrize` into claimable rewards.
- Empty clicks only mark the tile as clicked.
- Token selection is not a host/session parameter.

## Pyth Entropy integration

Docs: https://docs.pyth.network/entropy/generate-random-numbers-evm

The contract uses:

- `IEntropyV2.getFeeV2(provider, gasLimit)`
- `IEntropyV2.requestV2(provider, userRandomNumber, gasLimit)`
- `IEntropyConsumer._entropyCallback(...)`
- internal `entropyCallback(...)` to derive the board

Tests use `contracts/test/MockEntropy.sol` to simulate the Pyth callback.

## Commands

```bash
npm install
npm test
npm run build
```
