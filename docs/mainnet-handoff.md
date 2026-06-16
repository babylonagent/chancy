# Chancy Mainnet Handoff

Babylon does **not** deploy Chancy mainnet. Alireza deploys mainnet manually with a fresh wallet.

## V1 production scope

- Product UI: player-facing only. No internal ETH/USDC rationale, no contract addresses, no faucet links, no testnet copy.
- V1 gameplay asset: Base USDC.
- Contract system: multi-asset capable underneath, but the v1 interface presents simple room entry/prize amounts to players.
- Host flow: create room, fund rewards, view locked host board.
- Player flow: browse sessions, join a room, reveal board, claim rewards.

## Verified testnet deployment

- Network: Base Sepolia (`84532`)
- ChancyGame: `0x2Cd96e21f3f3008ec6daFb464F12fa91C54DF36c`
- Constructor: `(entropyAddress, initialAllowedAsset)`
- Base Sepolia USDC: `0x036cbd53842c5426634e7929541ec2318f3dcf7e`
- Base Sepolia Pyth Entropy used: `0x41c9e39574f40ad34c79f1c99b66a45efb830d4c`
- Testnet result: USDC sessions created/joined, Entropy callbacks completed, board clicks succeeded.

## Verified Base mainnet inputs

These were checked on Base mainnet (`8453`) using the deployment RPC without printing the RPC URL:

- Base USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Base USDC code exists: yes
- Pyth Entropy: `0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb`
- Pyth Entropy code exists: yes
- Pyth default provider: `0x52DeaA1c84233F7bb8C8A45baeDE41091c616506`
- Observed `getFee(defaultProvider)`: `10000000000000` wei

## Runtime `.env` for manual mainnet deploy

Set these only on your deployment machine. Do not put real values in Git, Vercel, GitHub, screenshots, docs, or chats.

```text
PRIVATE_KEY=<fresh mainnet deployer wallet>
BASE_RPC_URL=<Base mainnet RPC URL>
CHANCY_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PYTH_ENTROPY_ADDRESS=0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb
```

## Pre-deploy verification

```bash
npx hardhat clean
npx hardhat compile
node scripts/export-abi.js
npx hardhat test
npm run web:test
npm run web:build
```

Optional sanity check against Base mainnet:

```bash
npx hardhat run scripts/check-base-sepolia-prereqs.js --network base
```

The script name is historical. It uses the active Hardhat network and env values.

## Deploy mainnet contract

```bash
npx hardhat run scripts/deploy-chancy-game.js --network base
```

Save the printed deployed address:

```text
CHANCY_CONTRACT_ADDRESS=<deployed mainnet ChancyGame>
```

## Verify constructor state

```bash
npx hardhat run scripts/verify-base-sepolia-deploy.js --network base
```

Expected:

- `hasCode: true`
- `entropyMatchesEnv: true`
- `usdcAllowed: true`
- `owner` equals your fresh deployer wallet

## Optional tiny-value smoke

This spends real gas and real funds. Use tiny values first.

```bash
SMOKE_USDC_ENTRY_UNITS=1000000 \
npx hardhat run scripts/smoke-base-sepolia-live.js --network base
```

If smoke creates sessions, copy returned session IDs and verify callback/click after Pyth fulfillment:

```bash
SMOKE_SESSION_IDS=<sessionId> \
npx hardhat run scripts/verify-base-sepolia-boards-and-click.js --network base
```

## V1 frontend/API env after deploy

Only public values go into hosting env:

```text
CHANCY_CONTRACT_ADDRESS=<deployed mainnet ChancyGame>
VITE_CHANCY_BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Do **not** add private keys or RPC API keys to Vercel/GitHub. User wallets sign transactions client-side.

## Secret gate before commit/push

```bash
git check-ignore -v .env
git ls-files --error-unmatch .env && exit 1 || true
git grep -n -I -E 'PRIVATE_KEY=.+|BASE_RPC_URL=https://|BASE_SEPOLIA_RPC_URL=https://|[A-Fa-f0-9]{64}' -- . ':(exclude)package-lock.json'
```

Expected: no real secrets. Placeholder variable names in `.env.example` are acceptable; real values are not.
