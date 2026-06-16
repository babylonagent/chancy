# Chancy Mainnet Handoff

Babylon does **not** deploy Chancy mainnet. The user/co-founder deploys mainnet manually with a fresh wallet.

## Current verified testnet deployment

- Network: Base Sepolia (`84532`)
- ChancyGame: `0x2Cd96e21f3f3008ec6daFb464F12fa91C54DF36c`
- Constructor: `(entropyAddress, initialAllowedAsset)`
- Base Sepolia USDC: `0x036cbd53842c5426634e7929541ec2318f3dcf7e`
- Base Sepolia Pyth Entropy: `0x41c9e39574f40ad34c79f1c99b66a45efb830d4c`
- Pyth testnet default provider observed: `0x6CC14824Ea2918f5De5C2f75A9Da968ad4BD6344`
- Testnet result: ETH + USDC sessions created/joined, Entropy callbacks completed, board clicks succeeded.

## Mainnet deployment inputs

Set these only on the deployment machine runtime `.env`. Do not put real values in Git, Vercel, issue trackers, chat exports, or docs.

```text
PRIVATE_KEY=<fresh mainnet deployer wallet>
BASE_RPC_URL=<mainnet RPC URL>
CHANCY_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
PYTH_ENTROPY_ADDRESS=<verified Base mainnet Pyth Entropy contract>
```

Before deploying, verify the mainnet Pyth Entropy address on Base mainnet:

```bash
npx hardhat run scripts/check-base-sepolia-prereqs.js --network base
```

The script name says `base-sepolia` because it was born during testnet work; it reads the active Hardhat network and env values. Rename later if desired.

## Deploy

```bash
npx hardhat clean
npx hardhat compile
node scripts/export-abi.js
npx hardhat test
npm run web:test
npx hardhat run scripts/deploy-chancy-game.js --network base
```

Save the deployed `ChancyGame` address into runtime env:

```text
CHANCY_CONTRACT_ADDRESS=<deployed mainnet ChancyGame>
```

Then verify constructor state:

```bash
npx hardhat run scripts/verify-base-sepolia-deploy.js --network base
```

Expected:

- `hasCode: true`
- `entropyMatchesEnv: true`
- `usdcAllowed: true`
- `ethAllowed: true`
- `owner` equals the fresh deployer wallet

## Optional mainnet smoke

Use tiny values first. This sends real transactions and spends real ETH/USDC.

```bash
SMOKE_ETH_ENTRY_WEI=100000000000000 \
SMOKE_USDC_ENTRY_UNITS=1000000 \
npx hardhat run scripts/smoke-base-sepolia-live.js --network base
```

If smoke creates sessions, copy the returned session IDs and verify callback/click after Pyth fulfillment:

```bash
SMOKE_SESSION_IDS=<ethSessionId>,<usdcSessionId> \
npx hardhat run scripts/verify-base-sepolia-boards-and-click.js --network base
```

## Web/API deployment

Only public addresses go into Vercel/env hosting:

```text
CHANCY_CONTRACT_ADDRESS=<deployed ChancyGame>
VITE_CHANCY_BASE_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS=0x036cbd53842c5426634e7929541ec2318f3dcf7e
```

Do **not** add private keys or RPC API keys to Vercel. The UI uses the user's wallet provider for reads/sends.

## Secret gate before commit/push

```bash
git check-ignore -v .env
git ls-files --error-unmatch .env && exit 1 || true
git grep -n -I -E 'PRIVATE_KEY=.+|BASE_RPC_URL=https://|BASE_SEPOLIA_RPC_URL=https://|[A-Fa-f0-9]{64}' -- . ':(exclude)package-lock.json'
```

The grep should return no real secrets. Placeholder variable names in `.env.example` are acceptable; real values are not.
