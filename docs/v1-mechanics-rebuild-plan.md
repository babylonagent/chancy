# Chancy V1 Mechanics Rebuild Plan

## Product correction

The previous v1 candidate was structurally wrong. It treated a session as a multi-player room with fixed entry and fixed prize-per-tile. The intended game is a single-player-at-a-time host session with progressive block costs, host profit on failure/exit, and prize-pot-scaled outcomes.

## Correct v1 game model

### Session ownership
- A host creates one session with a prize pot.
- Only one player can occupy a session at a time.
- A host can view/manage their session but cannot play their own active run.
- If no player is active, the session is open.

### Player run lifecycle
- Player joins an open session.
- Player gets a fresh map and bomb counter for that run.
- Player pays per block reveal.
- Player can voluntarily quit.
- Player is automatically kicked after more than 1 minute idle.
- A kicked, quit, or game-over player can join again later as a fresh run.

### Cost model
Each block interaction costs a percentage of the prize pot. Costs increase monotonically as the run progresses.

| Mode | Start cost | Total cost cap |
| --- | ---: | ---: |
| Easy | 1.5% | 150% |
| Normal | 2.5% | 200% |
| Hardcore | 3.5% | 250% |

Rules:
- Percentages translate directly to dollar cost based on prize pot size.
- The sum of all 64 block costs cannot exceed the mode cap.
- The UI shows the next reveal cost on hidden blocks, not block numbers.
- After each reveal, remaining hidden blocks update to the next cost.
- Contract tests assert invariants, not a fragile display curve: first reveal cost equals the mode start cost, each later reveal cost is greater than or equal to the previous cost, and the 64-cost sum is less than or equal to the mode cap.

### Bomb system
- Easy has 5 bombs.
- Normal has 7 bombs.
- Hardcore has 10 bombs.
- Bomb hits are tracked per player run.
- Bombs accumulate during the run.
- A bomb hit does not immediately eliminate the player.
- All modes end at 3 bomb hits.

### Host incentives
The host earns the player's spent amount when:
1. Player hits 3 bombs and the run ends.
2. Player voluntarily exits.
3. Player is idle for more than 1 minute and is kicked.

### Prize mechanics
- Prize outcomes use on-chain randomness.
- Prize value scales with the prize pot.
- Finding a prize does not disable bomb mechanics.
- After a run ends, the map resets for the next player.

## Implementation strategy

This is a contract-breaking redesign. Do not patch the frontend only. The correct sequence is:

1. Rewrite Solidity session/run state around one active player and progressive costs.
2. Rewrite tests first around the correct lifecycle.
3. Update API builders to the new method names and arguments.
4. Update UI to show landing → sessions → session detail → active run only after join/create.
5. Replace placeholder sessions with real on-chain/indexed sessions or an honest empty state until sessions exist.
6. Update mainnet handoff after contract/API/UI are green.

## Proposed contract surface

The exact Solidity names may change during implementation, but the behavior should fit this API shape:

- `createSession(asset, difficulty, prizePot)` creates a host-owned session and funds the prize pot.
- `joinSession(sessionId, userRandomNumber)` starts the only active player run for that session.
- `clickTile(sessionId, tileIndex)` reveals one tile and charges the current reveal cost.
- `quitSession(sessionId)` ends the active run voluntarily and pays the player's spent amount to the host.
- `kickIdlePlayer(sessionId)` is callable after more than 1 minute idle and pays the player's spent amount to the host.
- `claimRewards(asset)` pays accrued player prize rewards.
- Read helpers expose session state, active run state, and current next reveal cost.

State implications:

- Session stores host, asset, prize pot, mode, active player, active run timestamps, and availability.
- Run stores bombs hit, prizes found, revealed mask, spent amount, and board-ready randomness state.
- Player spend is escrowed during the run, then routed to host on quit, idle kick, or game over.
- Prize rewards accrue to the player when prize tiles are found.

## Release gate

Before any mainnet deployment:
- `npx hardhat clean && npx hardhat compile`
- `node scripts/export-abi.js`
- `npx hardhat test`
- `npm run web:test`
- `npm run web:build`
- Base Sepolia deploy and real run smoke
- Secret scan
- Updated `docs/mainnet-handoff.md`

## Non-negotiable UI rules

- Landing page explains the game only.
- No board on landing.
- No placeholder active sessions in production.
- Sessions list shows empty state unless real sessions exist.
- No internal protocol rationale copy.
- No contract addresses in player UI.
- No block numbers on tiles.
- Hidden tiles show current next reveal cost.
- Board only appears after a player joins or a host creates a session.
