# Chancy V3 — On-Chain Settlement Specification

**Status:** Draft
**Date:** 2026-07-08
**Author:** Babylon
**Prior versions:** V1 (fully on-chain, 64-tile, gas-per-click), V2 (off-chain credit ledger, 36-tile, 7 security bugs)

---

## 1. Problem Statement

V2 moved all game economics off-chain into a Node.js SQLite ledger. This created
7 vulnerabilities — all stemming from one root cause: **money state lives in a
mutable off-chain database**.

| Bug | Severity | Root Cause |
|-----|----------|------------|
| Deposit double-credit race | CRITICAL | Off-chain balance Map + async gap |
| x402 prize inflation | CRITICAL | Credits minted from nothing |
| Signature doesn't bind body | HIGH | Off-chain auth instead of msg.sender |
| Nonce replay TOCTOU | HIGH | In-memory nonce Map + async gap |
| Relayer crash double-pay | HIGH | Off-chain state tracking for on-chain tx |
| x402 no wallet auth | MEDIUM | Trusted body field instead of msg.sender |
| SQLite crash window | MEDIUM | Money in disk file, not chain state |

**V3 eliminates all 7 by moving money state on-chain.** Not patched — structurally
impossible.

---

## 2. Design Principles

1. **Money on-chain, gameplay off-chain.** Pot escrow, payouts, and settlement
   are on-chain. Click resolution and UX stay off-chain for instant gameplay.

2. **Board secrecy via commit-reveal.** Board seed = hash(pythRandomness,
   hostSecret, playerCommitment). Host secret is revealed at settlement, not
   before. Nobody can derive the board until the game is over.

3. **Optimistic settlement with challenge.** API submits the game result. Player
   can challenge within a window. Fraudulent operator loses a bond.

4. **Minimal new contract surface.** One new contract (ChancySettlementV3).
   ChancyVault and ChancyRandomness are unchanged.

5. **x402 still works.** Pay-per-click stays off-chain. Pot is on-chain.

---

## 3. Architecture

```
ON-CHAIN (trustless money + verification)
  ChancyVault (existing)         USDC custody, deposit/withdraw, unchanged
  ChancyRandomness (existing)   Pyth Entropy V2 bridge, unchanged
  ChancySettlementV3 (NEW)       Per-game escrow, board verify, payout, disputes

OFF-CHAIN (instant gameplay, ZERO money authority)
  v3-engine.js                   Click resolution, session listing, board derivation
  SQLite                         Session metadata ONLY (no balances, no deposits)
  sig-auth.js                    Demoted to API spam protection (not money auth)
  payout-relayer.js              DELETED
  in-flight deposits Set         DELETED
  nonce Map                      DELETED
```

### What the off-chain engine does NOT do anymore:
- ~~Hold player balances~~
- ~~Credit deposits~~
- ~~Process withdrawals~~
- ~~Track in-flight deposits~~
- ~~Mint prize credits~~
- ~~Run payout relayer~~

### What it still does:
- Derive boards (from Pyth randomness + host secret)
- Resolve tile clicks (bomb/prize/empty)
- Track session metadata (active player, clicks, timing)
- Serve the frontend with game state
- x402 payment per click (off-chain, pot is on-chain)

---

## 4. ChancySettlementV3 Contract

### 4.1 Constants

```solidity
contract ChancySettlementV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant BOARD_SIZE = 36;
    uint8 public constant BOMBS_TO_GAME_OVER = 3;
    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SETTLEMENT_WINDOW = 1 hours;
    uint256 public constant REFUND_TIMEOUT = 24 hours;
    uint256 public constant OPERATOR_BOND = 0.01 ether;  // slashable

    IERC20 public immutable usdc;  // hardcoded USDC, no multi-asset
    address public settler;  // platform settlement bot (zero money authority)
```

### 4.2 Data Structures

```solidity
enum GameStatus { Created, Joined, Active, Settled, Challenged, Refunded }
enum Difficulty { Easy, Normal, Hardcore }

struct Game {
    address host;            // any player who locked the pot
    address player;           // the joined player
    Difficulty difficulty;
    uint256 prizePot;        // locked by host
    uint256 maxSpend;        // locked by player (budget for reveals)
    bytes32 hostCommitment;   // hash(hostSecret)
    bytes32 playerCommitment; // hash(playerRandom)
    bytes32 pythSequence;     // Pyth Entropy sequence number
    GameStatus status;
    uint64 createdAt;
    uint64 activatedAt;       // when board is ready (Pyth resolved)
    uint64 settledAt;        // when settlement submitted
}
```

### 4.3 Core Functions

#### createGame

Host locks the prize pot and commits their secret. Any player can be a host.

```
createGame(difficulty, prizePot, hostCommitment)
  → transfers USDC(prizePot) from host to contract
  → stores Game with status=Created
  → emits GameCreated(gameId, host, difficulty, prizePot, hostCommitment)
```

#### joinGame

Player locks max spend budget and commits their randomness.

```
joinGame(gameId, playerCommitment, maxSpend)
  → requires status == Created
  → transfers maxSpend from player to contract
  → stores playerCommitment
  → status = Joined
  → triggers Pyth Entropy request (playerCommitment as userRandomNumber)
  → emits GameJoined(gameId, player, maxSpend, playerCommitment)
```

The Pyth callback (via ChancyRandomness) resolves the randomness. The contract
records the Pyth sequence number and sets status = Active once the callback fires.

The off-chain engine reads the Pyth randomness + host secret (revealed privately
to the engine at game start) to derive the board for instant gameplay.

#### settleGame

API (operator) submits the game result after gameplay ends.

```
settleGame(gameId, hostSecret, uint8[] clickSequence, GameOutcome outcome)
  → requires status == Active
  → requires block.timestamp < activatedAt + SETTLEMENT_WINDOW
  → verifies hash(hostSecret) == game.hostCommitment
  → computes boardSeed = keccak256(pythRandomness, hostSecret, playerCommitment, gameId)
  → replays clicks through derived board
  → verifies outcome matches submitted result
  → pays out per outcome:
      - WIN: player gets prizePot + remaining maxSpend back
      - LOSS: host gets prizePot + player's spent reveal costs
      - QUIT: host gets prizePot + spent; player gets unspent budget
  → status = Settled
  → emits GameSettled(gameId, outcome, hostPayout, playerPayout)
```

**Critical:** the contract re-derives the board from on-chain inputs and replays
every click. If the operator lies about outcome, the replay won't match and the
tx reverts. The operator cannot cheat.

#### challengeSettlement

If the operator submits a wrong settlement (or doesn't settle at all), the
player can challenge.

```
challengeSettlement(gameId, hostSecret, uint8[] correctClicks, GameOutcome correctOutcome)
  → requires status == Settled (contest submitted settlement)
  → requires block.timestamp < settledAt + SETTLEMENT_WINDOW
  → re-derives board + replays clicks
  → if correct: slash operator bond to player, pay correct outcome
  → if wrong: slash challenger's bond to operator
```

#### refundTimeout

Anyone can trigger a refund if the game was never settled.

```
refundTimeout(gameId)
  → requires status in (Created, Joined, Active)
  → requires block.timestamp > createdAt + REFUND_TIMEOUT
  → refunds prizePot to host, maxSpend to player
  → status = Refunded
```

### 4.4 Board Derivation (Solidity)

Mirrors the JS `deriveBoard()` but runs on-chain for verification:

```solidity
function _deriveBoard(
    bytes32 boardSeed,
    Difficulty difficulty
) internal pure returns (uint64 bombMask, uint64 prizeMask) {
    (uint8 bombCount, uint8 prizeCount) = _difficultyConfig(difficulty);
    uint8 placed = 0;
    uint256 nonce = 0;
    while (placed < bombCount) {
        uint8 tile = uint8(uint256(keccak256(abi.encode(boardSeed, "BOMB", nonce))) % 36);
        uint64 bit = uint64(1) << tile;
        if (bombMask & bit == 0) { bombMask |= bit; placed++; }
        nonce++;
    }
    placed = 0;
    nonce = 0;
    while (placed < prizeCount) {
        uint8 tile = uint8(uint256(keccak256(abi.encode(boardSeed, "PRIZE", nonce))) % 36);
        uint64 bit = uint64(1) << tile;
        if (bombMask & bit == 0 && prizeMask & bit == 0) {
            prizeMask |= bit; placed++;
        }
        nonce++;
    }
}
```

### 4.5 Click Replay (Solidity)

```solidity
function _replayClicks(
    uint64 bombMask,
    uint64 prizeMask,
    uint8[] calldata clicks,
    uint256 prizePot,
    Difficulty difficulty
) internal pure returns (GameOutcome outcome, uint256 spent) {
    uint8 bombsHit = 0;
    uint8 prizesFound = 0;
    uint64 clickedMask = 0;

    for (uint256 i = 0; i < clicks.length; i++) {
        uint8 tile = clicks[i];
        require(tile < 36, "INVALID_TILE");
        uint64 bit = uint64(1) << tile;
        require(clickedMask & bit == 0, "TILE_ALREADY_CLICKED");

        clickedMask |= bit;
        uint256 cost = _revealCostAt(prizePot, difficulty, i);
        spent += cost;

        if (bombMask & bit != 0) {
            bombsHit++;
            if (bombsHit >= BOMBS_TO_GAME_OVER) {
                return (GameOutcome.Loss, spent);
            }
        } else if (prizeMask & bit != 0) {
            prizesFound++;
            if (prizesFound >= _prizeCount(difficulty)) {
                return (GameOutcome.Win, spent);
            }
        }
    }
    // Player ended without win or loss = quit (host gets spent, player gets rest)
    return (GameOutcome.Quit, spent);
}
```

### 4.6 Progressive Reveal Cost (Solidity)

Same formula as V2 off-chain, now enforced on-chain:

```solidity
function _revealCostAt(uint256 prizePot, Difficulty difficulty, uint256 revealIndex)
    internal pure returns (uint256)
{
    (uint256 startBps, uint256 capBps,) = _modeCostConfig(difficulty);
    uint256 baseTotalBps = startBps * BOARD_SIZE;
    uint256 stepBps = capBps > baseTotalBps
        ? ((capBps - baseTotalBps) * 2) / (BOARD_SIZE * (BOARD_SIZE - 1))
        : 0;
    uint256 costBps = startBps + (stepBps * revealIndex);
    return (prizePot * costBps) / BPS_DENOMINATOR;
}
```

### 4.7 Difficulty Config

Unchanged from V2:

```
Easy:     3 bombs, 3 prizes, start 150bps,  cap 15000bps
Normal:   4 bombs, 2 prizes, start 250bps,  cap 20000bps
Hardcore: 6 bombs, 1 prize,  start 350bps,  cap 25000bps
```

---

## 5. Game Flow (End to End)

### 5.1 Setup

```
Host                    API/Engine              Player                  Chain
 |                         |                      |                      |
 |--approve USDC--------->|                      |                      |
 |                         |--approve USDC------->|                      |
 |                         |                      |                      |
```

### 5.2 Create Game

```
Host                    Chain
 |                      |
 |--createGame---------->|
 |  (prizePot,           |  escrow funds
 |   hostCommitment)     |  status=Created
 |                      |
```

### 5.3 Join + Randomness

```
Player                  Chain                   Pyth
 |                      |                       |
 |--joinGame----------->|                       |
 |  (maxSpend,          |  escrow maxSpend       |
 |   playerCommitment)  |  requestEntropy------->|
 |                      |                       |
 |                      |<--entropyCallback------|
 |                      |  status=Active         |
```

### 5.4 Gameplay (Off-Chain, Instant)

```
Player                  API/Engine
 |                      |
 |--click tile 1------->|
 |                      |--resolve bomb/prize/empty
 |<--result-------------|
 |                      |
 |--click tile 2------->|
 |<--result-------------|
 |                      |
 |   (repeats until game ends)
```

No on-chain tx per click. Board derived from:
- Pyth randomNumber (on-chain, public)
- hostSecret (revealed privately to engine, not on-chain yet)
- playerCommitment (on-chain)

Board is secret because hostSecret is unknown on-chain.

### 5.5 Settlement

```
API/Engine              Chain
 |                      |
 |--settleGame--------->|
 |  (hostSecret,         |  verify commitment
 |   clickSequence,     |  re-derive board
 |   outcome)           |  replay clicks
 |                      |  verify outcome
 |                      |  pay out
 |                      |  status=Settled
```

### 5.6 Challenge (If Needed)

```
Player                  Chain
 |                      |
 |--challengeSettlement->|
 |  (hostSecret,          |  re-derive board
 |   correctClicks,      |  replay correct clicks
 |   correctOutcome)     |  compare vs settled
 |                      |  slash fraudster
```

### 5.7 Timeout Refund

```
Anyone                 Chain
 |                      |
 |--refundTimeout------->|
 |                      |  >24h since created
 |                      |  refund both parties
 |                      |  status=Refunded
```

---

## 6. Board Secrecy Deep Dive

### The Problem

On-chain data is public. If the board is derived solely from Pyth randomness
(which is public after resolution), anyone can derive the board before the
player clicks and front-run them.

### The Solution: Host Commit-Reveal

```
boardSeed = keccak256(
    abi.encode(
        pythRandomNumber,   // on-chain, public (after Pyth callback)
        hostSecret,          // off-chain, known to host + engine only
        playerCommitment,    // on-chain, public (hash, not preimage)
        gameId               // on-chain, public
    )
)
```

**Timeline:**
1. Host picks `hostSecret` (random 32 bytes), commits `hash(hostSecret)` on-chain
2. Player joins with `playerCommitment` (hash of their randomness)
3. Pyth resolves — `pythRandomNumber` is now on-chain
4. Board is derivable IF you know `hostSecret`. Nobody on-chain knows it.
5. Host reveals `hostSecret` to the engine privately (off-chain)
6. Engine derives board, resolves clicks for the player
7. At settlement, host reveals `hostSecret` on-chain — contract verifies the
   commitment hash, then derives the board and replays clicks

**Why this is safe:**
- Host can't change `hostSecret` after committing (hash is on-chain)
- Player can't derive the board (doesn't know `hostSecret`)
- Pyth can't bias the board (host secret mixes in)
- Engine can't forge outcomes (contract replays all clicks)
- If engine lies at settlement, challenge mechanism catches it

### What If Host Reveals Secret Early?

If the host reveals `hostSecret` to the player before the game, the player
can derive the board and cheat. This is a **design constraint, not a bug**:
- In V1, the host is the session operator (the platform itself).
- The host has no incentive to help a player cheat (host loses money).
- For P2P hosts (future), the host bond at risk prevents collusion.

### Commitment Scheme

```javascript
// Host
hostSecret = crypto.randomBytes(32);
hostCommitment = keccak256(hostSecret);

// Player
playerRandom = crypto.randomBytes(32);
playerCommitment = keccak256(playerRandom);

// Board seed (at settlement, all revealed)
boardSeed = keccak256(abi.encode(pythRandom, hostSecret, playerCommitment, gameId));
```

Note: `playerCommitment` (the hash) is used as input to the board seed, not the
preimage. This means the board can be derived after `hostSecret` is revealed,
without needing the player to reveal their preimage. The player's preimage is
used as the `userRandomNumber` for the Pyth request (so Pyth mixes it in
separately).

Actually — simpler: we use `playerCommitment` as the Pyth `userRandomNumber`
input. This way:
- Pyth randomness already incorporates the player's contribution
- Board seed = keccak256(pythRandom, hostSecret, gameId)
- Player doesn't need to reveal a separate preimage

**Final board seed formula:**
```
boardSeed = keccak256(abi.encodePacked(pythRandomNumber, hostSecret, gameId))
```

---

## 7. x402 Integration

x402 pay-per-click stays for the off-chain engine. But money flows change:

### V2 (broken):
- x402 payment goes to receiving wallet (off-chain)
- Server mints internal credits (inflation bug)
- Player withdraws from internal balance (relayer crash bug)

### V3 (fixed):
- x402 payment goes to the ChancySettlement contract (on-chain)
- No internal credits minted
- Settlement pays out from contract escrow
- No relayer needed

x402 click payments can be batched: the engine accumulates x402 payments during
gameplay, then submits them in the settlement tx. Players who pay via x402 have
their spend recorded by the engine and verified against the contract replay.

### x402 + Credit Hybrid

Both payment paths feed into the same on-chain escrow:
- **Credit players:** deposited USDC in Vault → locked in ChancySettlement
- **x402 players:** pay per click via x402 → engine tracks in session metadata →
  settlement verifies total spend matches click sequence

The settlement contract doesn't care HOW the player paid. It only cares:
- Host locked `prizePot`
- Player locked `maxSpend` (or x402 payments cover it)
- Click sequence + outcome match the derived board

---

## 8. What Gets Deleted

| Component | V2 Purpose | V3 Action |
|-----------|-----------|-----------|
| payout-relayer.js | Send USDC for withdrawals | **DELETE** — contract pays directly |
| in-flight deposits Set | Race condition guard | **DELETE** — `transferFrom` is atomic |
| usedNonces Map | Nonce replay prevention | **DELETE** — Ethereum tx nonce |
| computeBodyHash | Signature body binding | **DELETE** — `msg.sender` is auth |
| sig-auth (for money) | Wallet auth for balance ops | **DEMOTE** — spam filter only |
| SQLite balances table | Off-chain balance tracking | **DELETE** — no balances off-chain |
| SQLite deposits table | Off-chain deposit tracking | **DELETE** — indexer writes to chain |
| SQLite withdrawals table | Off-chain withdrawal tracking | **DELETE** — no withdrawals, contract pays |
| deposit-indexer.js | Watch Transfer events → credit | **KEEP** but simpler — just track for display |
| `/v2/credits/deposit` | Credit player balance | **DELETE** — deposit goes to Vault on-chain |
| `/v2/withdrawals/request` | Create pending withdrawal | **DELETE** — contract pays on settle |
| `/v2/withdrawals/:id/mark-paid` | Mark withdrawal as paid | **DELETE** |
| `/v2/withdrawals/:id/pending-tx` | Crash recovery for relayer | **DELETE** |

**~500 lines of off-chain money code eliminated.**

---

## 9. What Stays the Same

| Component | V3 Role |
|-----------|---------|
| ChancyVault.sol | USDC custody, deposits, sweeps — unchanged |
| ChancyRandomness.sol | Pyth Entropy bridge — unchanged |
| deriveBoard() JS | Instant board derivation for gameplay — same algorithm |
| revealCostAt() JS | Progressive tile cost — same formula |
| modeConfig | Easy/Normal/Hardcore config — unchanged |
| 36-tile board | 6x6 grid — unchanged |
| Entrance fee | $0.05 — now enforced on-chain via maxSpend min |
| Commit-reveal fairness | Same commit-reveal structure as V2 |
| sig-auth.js | Stays for API spam protection (not money auth) |
| x402-routes.js | Stays for per-click payments (feeds into settlement) |

---

## 10. Contract Interactions

```
                    ┌──────────────────┐
                    │  ChancyVault     │
                    │  (USDC custody)  │
                    └────────┬─────────┘
                             │
                     deposit/withdraw
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼────┐  ┌──────▼───────┐  ┌──▼──────────────┐
    │  Host        │  │  ChancySet   │  │  Player         │
    │  (locks pot) │  │  tlementV3   │  │  (locks budget) │
    └──────────────┘  │  (escrow)    │  └─────────────────┘
                      └──────┬───────┘
                             │
                    ┌────────┼────────┐
                    │        │        │
              settle │  challenge  │ refund
          (settler   │  (player    │ (anyone
           bot calls)│  disputes)  │  24h)
                    │        │        │
               ┌────▼───┐ ┌──▼───┐ ┌──▼───┐
               │ Host   │ │ Player│ │ Both │
               │ payout │ │ payout│ │refund│
               └────────┘ └──────┘ └──────┘

  ChancyRandomness (Pyth Entropy) feeds into ChancySettlementV3
  for the randomness used in board derivation.

  Settler = platform bot. Zero money authority.
  Contract re-derives board + replays clicks. Settler can't lie.
  If settler doesn't call settleGame(), 24h timeout → refund.
```

---

## 11. Security Analysis

### 11.1 Eliminated V2 Bugs

| V2 Bug | V3 Elimination |
|--------|---------------|
| Deposit race | `transferFrom` is atomic — no async gap |
| x402 inflation | No off-chain credit minting — escrow only |
| Sig body binding | `msg.sender` is auth — no signature scheme |
| Nonce replay | Ethereum tx nonce — protocol-level |
| Relayer double-pay | `settle()` is atomic — no relayer exists |
| x402 no auth | Player must call `joinGame()` on-chain |
| SQLite crash | Money is chain state — no disk file |

### 11.2 New Attack Surface (and mitigations)

| Risk | Mitigation |
|------|-----------|
| Operator doesn't settle (griefing) | 24h timeout → auto refund |
| Operator submits wrong result | Challenge window (1h) → slash bond |
| Player false challenge | Challenger must match incorrect outcome proof → slash challenger |
| Host reveals secret early | Host loses money to cheating player — no incentive |
| Pyth randomness manipulation | Pyth is decentralized + host secret mixes in |
| Front-running settlement | Settlement is deterministic — front-running just settles correctly |
| Reentrancy in payout | ReentrancyGuard + checks-effects-interactions |

### 11.3 Board Derivation Parity

The JS `deriveBoard()` and Solidity `_deriveBoard()` MUST produce identical
output for the same inputs. This is verified by:
1. Unit test: derive 1000 random boards in both JS and Solidity, compare masks
2. Fuzz test: random inputs, assert JS === Solidity

**Critical**: V2 uses SHA-256 for board derivation. V3 Solidity uses keccak256.
The JS engine MUST be updated to use keccak256 for V3 parity. This is a
breaking change from V2 but V3 is a clean break.

### 11.4 Bond Mechanics

- **Operator bond:** 0.01 ETH (slashable). Operator must deposit bond before
  settling games. If a challenge proves fraud, bond goes to challenger.
- **Challenge deposit:** Challenger must also post a bond. If challenge fails,
  their bond goes to the operator.

---

## 12. Off-Chain Engine Changes

### What v3-engine.js does:

```javascript
// Session metadata ONLY — no balances
{
  gameId: "1",
  host: "0x...",
  status: "active",        // read from chain
  board: { bombPositions, prizePositions },  // derived off-chain
  clicks: [3, 7, 12, ...], // recorded for settlement
  spentTotal: "50000",
  prizeEarned: "0",
  hostSecret: "0x...",     // known to engine, not on-chain yet
}
```

### Endpoints removed:
- `POST /v2/credits/deposit` — deposit goes to Vault on-chain
- `POST /v2/withdrawals/request` — no withdrawals, contract pays
- `POST /v2/withdrawals/:id/mark-paid` — no relayer
- `POST /v2/withdrawals/:id/pending-tx` — no relayer
- `GET /v2/credits/:player` — read from chain, not off-chain
- `GET /v2/withdrawals/:player` — no withdrawals

### Endpoints kept/modified:
- `POST /v2/sessions/create` — calls `createGame()` on-chain, returns tx
- `POST /v2/sessions/:id/join` — calls `joinGame()` on-chain
- `POST /v2/sessions/:id/click` — off-chain instant, records click in session
- `POST /v2/sessions/:id/quit` — off-chain, marks game as quit
- `POST /v2/sessions/:id/settle` — calls `settleGame()` on-chain with clicks
- `GET /v2/sessions` — lists open games from chain events
- `GET /v2/sessions/:id` — reads game state from chain + engine metadata

---

## 13. Deployment Plan

### Phase 1: Contract (2 days)
- Write ChancySettlementV3.sol
- Unit tests for board derivation, click replay, settlement, challenge, refund
- Fuzz test: JS deriveBoard vs Solidity _deriveBoard parity

### Phase 2: Engine Refactor (1 day)
- Remove all money code from v2.js
- Add on-chain settlement calls (via viem contract writes)
- Keep click resolution + x402 + session listing

### Phase 3: Frontend (1 day)
- Add contract interaction (createGame, joinGame, settleGame)
- Show settlement status + challenge UI
- Remove deposit/withdrawal UI (replaced by on-chain)

### Phase 4: Tests (1.5 days)
- Integration: full game flow create → join → click → settle
- Challenge: operator submits wrong result, player challenges, bond slashed
- Timeout: no settlement in 24h, auto refund
- x402 + on-chain hybrid: player pays per click, settled correctly

### Phase 5: Deploy (0.5 day)
- Deploy ChancySettlementV3 to Base Sepolia
- Verify on Sourcify
- Sepolia staging: run 10 games end to end
- Mainnet deploy with disposable deployer wallet
- Transfer ownership to user wallet

---

## 14. Migration from V2

V3 is a clean break. V2 sessions remain functional until they naturally expire
(idle timeout). No migration of V2 sessions to V3 — they operate in parallel
until V2 is sunset.

V2 funds (player balances in SQLite) must be manually withdrawn before V2
shutdown. The `/v2/withdrawals/request` endpoint stays available in V2-only
mode until all balances are cleared.

**Sunset timeline:**
- V3 deployed to Sepolia: Week 1
- V3 on mainnet: Week 2
- V2 withdrawals discouraged: Week 2 (display "V3 now available" banner)
- V2 sunset (API stops accepting new sessions): Week 3
- V2 withdrawal-only mode: Weeks 3-4
- V2 API shut down: Week 4

---

## 15. Gas Cost Analysis

| Transaction | Gas Est. | Cost on Base ($0.0001/gas) |
|-------------|---------|--------------------------|
| createGame | ~120k | $0.012 |
| joinGame (incl Pyth) | ~180k | $0.018 |
| settleGame | ~200k (36 clicks max) | $0.020 |
| challengeSettlement | ~220k | $0.022 |
| refundTimeout | ~80k | $0.008 |

**Per game (3 txs): ~$0.05** — negligible for $5-$1000 pots.

Clicks remain free (off-chain). x402 click cost unchanged.

---

## 16. Resolved Design Decisions

### Decision 1: P2P Hosting — Any Player Can Host (No Bond)

Chancy is P2P. Any player deposits USDC and creates a game = becomes a host.
Other players join and click tiles. Host profits from player losses.

**Three roles in V3:**

| Role | Who | What they do | Needs bond? |
|------|-----|-------------|-------------|
| Host | Any player | Locks pot in escrow, creates game | Pot IS the bond |
| Player | Any other player | Locks max spend, clicks tiles | maxSpend locked |
| Settler | Platform bot | Calls settleGame() after game ends | Operator bond (slashable) |

**The settler is NOT a host.** The settler is a dumb bot with zero money
authority. It submits the click sequence to the contract. The contract
re-derives the board from on-chain inputs and replays every click. If the
settler submits wrong data, the tx reverts. If the settler refuses, the 24h
timeout kicks in and both parties get refunded.

Host doesn't need a separate bond — the locked pot IS the skin in the game.
If host colludes with a player to cheat, host loses their own pot. No
incentive to cheat.

### Decision 2: x402 Batch Settlement

x402 payments accrue off-chain during gameplay. At settlement, the engine
submits the full click sequence and total x402 spend. The contract verifies
the total matches the click replay. One settlement tx covers the entire game.

```
Game: 15 clicks at $0.02 each = $0.30 total x402
  → 15 x402 payments happen off-chain during gameplay (instant)
  → 1 settleGame() tx on-chain submits click sequence
  → contract verifies 15 clicks, checks $0.30 matches
  → payout from contract escrow
```

3 on-chain txs per game total (create, join, settle). Cheapest option.
Player experience: instant clicks, one settlement at the end.

### Decision 3: USDC Only

Contract hardcodes USDC address. No `asset` field, no allowlist mapping.
Simpler, fewer attack vectors.

### Decision 4: On-Chain Events for Session Listing

Frontend reads `GameCreated` events directly from the contract via viem.
No off-chain indexer or session cache needed. New games appear after 1 block
(~2s on Base). Trustless — can't censor or fake sessions.

The frontend uses `watchEvent` or `getLogs` to list open games. At Chancy's
scale (hundreds of games, not millions) this is trivial.

---

## Appendix A: Board Derivation Parity Test

```javascript
// JS (v3-engine.js) — must use keccak256, not SHA-256
const { keccak256, encodePacked } = require("viem");

function deriveBoardV3({ boardSeed, mode }) {
  const cfg = modeConfig[mode];
  const taken = new Set();
  let nonce = 0;
  while (taken.size < cfg.bombs + cfg.prizes) {
    const hash = keccak256(encodePacked(["bytes32", "string", "uint256"], [boardSeed, nonce < cfg.bombs ? "BOMB" : "PRIZE", nonce]));
    // ...
  }
}
```

```solidity
// Solidity — must match JS exactly
function _deriveBoard(bytes32 boardSeed, Difficulty difficulty) internal pure {
    // Same algorithm, same inputs, same ordering
}
```

The fuzz test generates 1000 random `boardSeed` values and asserts
`jsBoard.bombMask == solBoard.bombMask && jsBoard.prizeMask == solBoard.prizeMask`.
