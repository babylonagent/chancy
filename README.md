# Chancy

Commit-reveal block game for Base.

## Current scope

This repo starts with the disposable full-test contract:

- `contracts/ChancyGameFixedTokenTestnet.sol`
- Hardcoded temporary token CA: `0x3E1A6D23303bE04403BAdC8bFF348027148Fef27`
- This contract is **test only** and must not be used as production deployment.

Production will use a fresh main contract deployed with the real project token.

## Rules

- 64 hidden blocks.
- Host chooses difficulty at session initialization.
- Difficulty presets:
  - Easy: 5 bombs / 3 prizes
  - Normal: 7 bombs / 2 prizes
  - Hardcore: 10 bombs / 1 prize
- Duplicate tile clicks are rejected.
- Token selection is not a host/session parameter.

## Commands

```bash
npm install
npm test
npm run build
```
