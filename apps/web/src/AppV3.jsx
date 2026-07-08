import React, { useCallback, useEffect, useState, useRef } from 'react';
import sfx from './sound';
import chancyLogo from './assets/chancy-logo.svg';
import baseLogo from './assets/tech/base-basemark.svg';
import pythLogo from './assets/tech/pyth.svg';
import usdcLogo from './assets/tech/usdc.svg';
import bombSprite from './assets/pixel/bomb-v1.png';
import gemSprite from './assets/pixel/gem-v1.png';
import questionSprite from './assets/pixel/question-v1.png';
import frameGold from './assets/pixel/frame-gold.png';
import btnGoldRaised from './assets/pixel/btn-gold-raised.png';
import btnGoldPressed from './assets/pixel/btn-gold-pressed.png';
import btnDarkRaised from './assets/pixel/btn-dark-raised.png';
import btnDarkPressed from './assets/pixel/btn-dark-pressed.png';
import btnGreenRaised from './assets/pixel/btn-green-raised.png';
import btnGreenPressed from './assets/pixel/btn-green-pressed.png';
import btnRedRaised from './assets/pixel/btn-red-raised.png';
import btnRedPressed from './assets/pixel/btn-red-pressed.png';
import './styles.css';

// ── V3 Contract Config ──────────────────────────────────────────────────────
const V3_SETTLEMENT = '0x6F13FDf2C3F50dFfceB824292B86fe9ddf63748B';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHAIN_ID = 84532; // Base Sepolia
const API_BASE = '/v3';

// ── ABIs (minimal) ──────────────────────────────────────────────────────────
const SETTLEMENT_ABI = [
  {
    name: 'createGame',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'difficulty', type: 'uint8' },
      { name: 'prizePot', type: 'uint256' },
      { name: 'hostCommitment', type: 'bytes32' },
    ],
    outputs: [{ name: 'gameId', type: 'uint256' }],
  },
  {
    name: 'joinGame',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'uint256' },
      { name: 'playerCommitment', type: 'bytes32' },
      { name: 'maxSpend', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'getGame',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'host', type: 'address' },
        { name: 'player', type: 'address' },
        { name: 'difficulty', type: 'uint8' },
        { name: 'prizePot', type: 'uint256' },
        { name: 'maxSpend', type: 'uint256' },
        { name: 'hostCommitment', type: 'bytes32' },
        { name: 'playerCommitment', type: 'bytes32' },
        { name: 'pythRandomNumber', type: 'bytes32' },
        { name: 'status', type: 'uint8' },
        { name: 'createdAt', type: 'uint64' },
        { name: 'activatedAt', type: 'uint64' },
        { name: 'settledAt', type: 'uint64' },
      ],
    }],
  },
  {
    name: 'GameCreated',
    type: 'event',
    inputs: [
      { name: 'gameId', type: 'uint256', indexed: true },
      { name: 'host', type: 'address', indexed: true },
      { name: 'difficulty', type: 'uint8', indexed: false },
      { name: 'prizePot', type: 'uint256', indexed: false },
      { name: 'hostCommitment', type: 'bytes32', indexed: false },
    ],
  },
  {
    name: 'GameSettled',
    type: 'event',
    inputs: [
      { name: 'gameId', type: 'uint256', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'hostPayout', type: 'uint256', indexed: false },
      { name: 'playerPayout', type: 'uint256', indexed: false },
    ],
  },
];

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

const DIFFICULTIES = [
  { name: 'Easy', bombs: 3, prizes: 3, enum: 0 },
  { name: 'Normal', bombs: 4, prizes: 2, enum: 1 },
  { name: 'Hardcore', bombs: 6, prizes: 1, enum: 2 },
];

const GAME_STATUS = ['Created', 'Active', 'Settled', 'Challenged', 'Refunded'];
const OUTCOME = ['Pending', 'Win', 'Loss', 'Quit'];

// ── Helpers ─────────────────────────────────────────────────────────────────
function randomBytes32() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return '0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatUSDC(wei) {
  if (!wei) return '0';
  return (Number(wei) / 1e6).toFixed(2);
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// ── Component ───────────────────────────────────────────────────────────────
export default function AppV3({ wallet }) {
  const [view, setView] = useState('lobby'); // lobby, create, play, result
  const [games, setGames] = useState([]);
  const [activeGameId, setActiveGameId] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [tileStates, setTileStates] = useState(Array(36).fill('hidden'));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);
  const pollRef = useRef(null);

  // Form state for create game
  const [createDifficulty, setCreateDifficulty] = useState(0);
  const [createPot, setCreatePot] = useState('10');

  // Form state for join game
  const [joinMaxSpend, setJoinMaxSpend] = useState('5');

  const account = wallet?.address;
  const provider = wallet?.provider;

  // ── Load open games from contract events ──────────────────────────────────
  const loadGames = useCallback(async () => {
    if (!provider) return;
    try {
      // Read GameCreated events from the contract
      const ethers = await import('ethers');
      const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, provider);

      // Get recent events
      const filter = contract.filters.GameCreated();
      const events = await contract.queryFilter(filter, -10000);

      const gameList = [];
      for (const event of events) {
        const gameId = event.args.gameId.toString();
        const game = await contract.getGame(gameId);
        // Only show games that are in Created status (waiting for player)
        if (Number(game.status) === 0) {
          gameList.push({
            gameId,
            host: game.host,
            difficulty: Number(game.difficulty),
            prizePot: game.prizePot.toString(),
            difficultyName: DIFFICULTIES[Number(game.difficulty)].name,
          });
        }
      }
      setGames(gameList);
    } catch (err) {
      console.error('loadGames error:', err);
    }
  }, [provider]);

  useEffect(() => {
    if (provider && view === 'lobby') {
      loadGames();
      const interval = setInterval(loadGames, 5000);
      return () => clearInterval(interval);
    }
  }, [provider, view, loadGames]);

  // ── Create Game ───────────────────────────────────────────────────────────
  const handleCreateGame = async () => {
    if (!account || !provider) return;
    setLoading(true);
    setError(null);
    try {
      const ethers = await import('ethers');
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, signer);
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);

      const potAmount = ethers.parseUnits(createPot, 6);

      // 1. Approve USDC
      const currentAllowance = await usdc.allowance(account, V3_SETTLEMENT);
      if (currentAllowance < potAmount) {
        sfx.click();
        const approveTx = await usdc.approve(V3_SETTLEMENT, potAmount);
        await approveTx.wait();
      }

      // 2. Generate host secret + commitment
      const hostSecret = randomBytes32();
      const hostCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [hostSecret]));

      // Store host secret in localStorage for settlement recovery
      localStorage.setItem(`chancy_v3_host_secret_${account}`, hostSecret);

      // 3. Create game on-chain
      sfx.click();
      const tx = await contract.createGame(createDifficulty, potAmount, hostCommitment);
      setTxHash(tx.hash);
      const receipt = await tx.wait();

      // Find gameId from events
      let gameId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed && parsed.name === 'GameCreated') {
            gameId = parsed.args.gameId.toString();
            break;
          }
        } catch {}
      }

      if (gameId) {
        // 4. Send host secret to engine so settler bot can use it at activation
        await postJson(`${API_BASE}/sessions/${gameId}/host-secret`, {
          hostSecret,
          host: account,
          difficulty: createDifficulty,
          prizePot: potAmount.toString(),
        });

        setActiveGameId(gameId);
        setView('waiting');
        sfx.success();
      }
    } catch (err) {
      setError(err.message?.slice(0, 200));
      sfx.error();
    } finally {
      setLoading(false);
    }
  };

  // ── Join Game ─────────────────────────────────────────────────────────────
  const handleJoinGame = async (gameId) => {
    if (!account || !provider) return;
    setLoading(true);
    setError(null);
    try {
      const ethers = await import('ethers');
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, signer);
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);

      const maxSpendAmount = ethers.parseUnits(joinMaxSpend, 6);

      // 1. Approve USDC
      const currentAllowance = await usdc.allowance(account, V3_SETTLEMENT);
      if (currentAllowance < maxSpendAmount) {
        sfx.click();
        const approveTx = await usdc.approve(V3_SETTLEMENT, maxSpendAmount);
        await approveTx.wait();
      }

      // 2. Generate player commitment
      const playerRandom = randomBytes32();
      const playerCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [playerRandom]));

      // 3. Join game on-chain
      sfx.click();
      const tx = await contract.joinGame(gameId, playerCommitment, maxSpendAmount);
      setTxHash(tx.hash);
      await tx.wait();

      setActiveGameId(gameId);
      setView('waitingActivation');
      sfx.success();
    } catch (err) {
      setError(err.message?.slice(0, 200));
      sfx.error();
    } finally {
      setLoading(false);
    }
  };

  // ── Poll game state from engine ───────────────────────────────────────────
  useEffect(() => {
    if (view === 'play' && activeGameId) {
      const poll = async () => {
        try {
          const resp = await fetch(`${API_BASE}/sessions/${activeGameId}/state`);
          if (resp.ok) {
            const state = await resp.json();
            setGameState(state);

            // Update tile states
            const newTiles = Array(36).fill('hidden');
            for (let i = 0; i < state.clicks.length; i++) {
              const tile = state.clicks[i];
              // We don't know if it was bomb/prize/empty from state alone
              // The engine returns bombPositions/prizePositions only when finished
              if (state.status === 'finished') {
                if (state.bombPositions?.includes(tile)) newTiles[tile] = 'bomb';
                else if (state.prizePositions?.includes(tile)) newTiles[tile] = 'prize';
                else newTiles[tile] = 'empty';
              } else {
                // During active play, tiles are just "clicked" (unknown content)
                newTiles[tile] = 'clicked';
              }
            }
            setTileStates(newTiles);

            if (state.status === 'finished') {
              setView('result');
              if (state.outcome === 'win') sfx.success();
              else if (state.outcome === 'loss') sfx.error();
            }
          }
        } catch (err) {
          console.error('Poll error:', err);
        }
      };

      poll();
      pollRef.current = setInterval(poll, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [view, activeGameId]);

  // ── Click a tile ──────────────────────────────────────────────────────────
  const handleTileClick = async (tileIndex) => {
    if (!account || view !== 'play' || loading) return;
    setLoading(true);
    try {
      sfx.click();
      const result = await postJson(`${API_BASE}/sessions/${activeGameId}/click`, {
        player: account,
        tile: tileIndex,
      });

      if (result.error) {
        setError(result.error);
      } else {
        // Update tile visual
        const newTiles = [...tileStates];
        if (result.type === 'bomb') newTiles[tileIndex] = 'bomb';
        else if (result.type === 'prize') newTiles[tileIndex] = 'prize';
        else newTiles[tileIndex] = 'empty';
        setTileStates(newTiles);

        if (result.gameOver) {
          setTimeout(() => {
            setView('result');
            if (result.outcome === 'win') sfx.success();
            else sfx.error();
          }, 1500);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Quit game ─────────────────────────────────────────────────────────────
  const handleQuit = async () => {
    if (!account) return;
    try {
      sfx.click();
      await postJson(`${API_BASE}/sessions/${activeGameId}/quit`, { player: account });
      setView('result');
    } catch (err) {
      setError(err.message);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (!account) {
    return (
      <div className="app-container">
        <div className="connect-prompt">
          <img src={chancyLogo} alt="Chancy" className="logo" />
          <h1>Chancy V3</h1>
          <p>Connect your wallet to play</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <div className="header">
        <img src={chancyLogo} alt="Chancy" className="logo" />
        <div className="tech-logos">
          <img src={baseLogo} alt="Base" />
          <img src={pythLogo} alt="Pyth" />
          <img src={usdcLogo} alt="USDC" />
        </div>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>{error}</div>}
      {txHash && <div className="tx-banner">Tx: {txHash.slice(0, 10)}...</div>}

      {/* Lobby View */}
      {view === 'lobby' && (
        <div className="lobby">
          <h2>Open Games</h2>
          {games.length === 0 ? (
            <p className="empty-state">No open games. Create one!</p>
          ) : (
            <div className="game-list">
              {games.map(g => (
                <div key={g.gameId} className="game-card">
                  <div className="game-info">
                    <span className="difficulty-badge">{g.difficultyName}</span>
                    <span className="pot-amount">{formatUSDC(g.prizePot)} USDC</span>
                    <span className="host-addr">Host: {g.host.slice(0, 6)}...{g.host.slice(-4)}</span>
                  </div>
                  <div className="join-controls">
                    <input
                      type="number"
                      value={joinMaxSpend}
                      onChange={e => setJoinMaxSpend(e.target.value)}
                      placeholder="Max spend (USDC)"
                      className="input-field"
                    />
                    <button
                      className="btn-green"
                      onClick={() => handleJoinGame(g.gameId)}
                      disabled={loading}
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="create-section">
            <h3>Create New Game</h3>
            <div className="create-controls">
              <select
                value={createDifficulty}
                onChange={e => setCreateDifficulty(Number(e.target.value))}
                className="input-field"
              >
                {DIFFICULTIES.map(d => (
                  <option key={d.enum} value={d.enum}>{d.name} ({d.bombs} bombs, {d.prizes} prizes)</option>
                ))}
              </select>
              <input
                type="number"
                value={createPot}
                onChange={e => setCreatePot(e.target.value)}
                placeholder="Prize pot (USDC)"
                className="input-field"
              />
              <button
                className="btn-gold"
                onClick={handleCreateGame}
                disabled={loading}
              >
                {loading ? 'Creating...' : 'Create Game'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Waiting View */}
      {(view === 'waiting' || view === 'waitingActivation') && (
        <div className="waiting">
          <h2>{view === 'waiting' ? 'Waiting for player...' : 'Waiting for activation...'}</h2>
          <p>Game ID: {activeGameId}</p>
          <div className="loading-spinner" />
          <button className="btn-dark" onClick={() => { setView('lobby'); setActiveGameId(null); }}>
            Back to Lobby
          </button>
        </div>
      )}

      {/* Play View */}
      {view === 'play' && (
        <div className="play-view">
          <div className="game-header">
            <h2>Game #{activeGameId}</h2>
            {gameState && (
              <div className="game-stats">
                <span>Spent: {formatUSDC(gameState.spent)} USDC</span>
                <span>Bombs: {gameState.bombsHit}/3</span>
                <span>Prizes: {gameState.prizesFound}</span>
              </div>
            )}
          </div>

          <div className="board-grid">
            {Array(36).fill(0).map((_, i) => (
              <button
                key={i}
                className={`tile tile-${tileStates[i]}`}
                onClick={() => handleTileClick(i)}
                disabled={tileStates[i] !== 'hidden' || loading}
              >
                {tileStates[i] === 'bomb' && <img src={bombSprite} alt="Bomb" />}
                {tileStates[i] === 'prize' && <img src={gemSprite} alt="Prize" />}
                {tileStates[i] === 'hidden' && <img src={questionSprite} alt="?" />}
              </button>
            ))}
          </div>

          <button className="btn-red" onClick={handleQuit} disabled={loading}>
            Quit
          </button>
        </div>
      )}

      {/* Result View */}
      {view === 'result' && (
        <div className="result-view">
          <h2>
            {gameState?.outcome === 'win' && '🎉 You Won!'}
            {gameState?.outcome === 'loss' && '💀 You Hit 3 Bombs'}
            {gameState?.outcome === 'quit' && '🚪 You Quit'}
          </h2>
          {gameState && (
            <div className="result-stats">
              <p>Spent: {formatUSDC(gameState.spent)} USDC</p>
              <p>Clicks: {gameState.clicks.length}</p>
            </div>
          )}
          <div className="board-grid result-grid">
            {Array(36).fill(0).map((_, i) => (
              <div key={i} className={`tile tile-${tileStates[i]}`}>
                {tileStates[i] === 'bomb' && <img src={bombSprite} alt="Bomb" />}
                {tileStates[i] === 'prize' && <img src={gemSprite} alt="Prize" />}
                {tileStates[i] === 'empty' && <span>·</span>}
                {tileStates[i] === 'hidden' && <span></span>}
              </div>
            ))}
          </div>
          <button className="btn-gold" onClick={() => {
            setView('lobby');
            setActiveGameId(null);
            setTileStates(Array(36).fill('hidden'));
            setGameState(null);
          }}>
            Back to Lobby
          </button>
        </div>
      )}
    </div>
  );
}