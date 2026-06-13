import React, { useEffect, useMemo, useState } from 'react';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BASE_CHAIN_ID = '0x2105';
const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
const DIFFICULTY_CONFIG = {
  Easy: { bombs: 5, prizes: 3 },
  Normal: { bombs: 7, prizes: 2 },
  Hardcore: { bombs: 10, prizes: 1 },
};
const TILE_HIDDEN = 'hidden';

function makeDemoBoard(difficulty, seed) {
  const config = DIFFICULTY_CONFIG[difficulty];
  let state = Array.from(`${seed}:${difficulty}`).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  const used = new Set();
  const pick = () => {
    do {
      state = (state * 1664525 + 1013904223) >>> 0;
    } while (used.has(state % 64));
    const tile = state % 64;
    used.add(tile);
    return tile;
  };
  const board = Array.from({ length: 64 }, () => 'empty');
  for (let i = 0; i < config.bombs; i += 1) board[pick()] = 'bomb';
  for (let i = 0; i < config.prizes; i += 1) board[pick()] = 'prize';
  return board;
}

async function postJson(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function getWalletProvider() {
  if (!window.ethereum) throw new Error('No injected wallet found. Install a Base-compatible wallet first.');
  return window.ethereum;
}

function shortAddress(address) {
  if (!address || /^0x0{40}$/i.test(address)) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function App() {
  const [health, setHealth] = useState('checking');
  const [contractAddress, setContractAddress] = useState('');
  const [difficulty, setDifficulty] = useState('Normal');
  const [currency, setCurrency] = useState('ETH');
  const [sessionId, setSessionId] = useState('1');
  const [entryAmount, setEntryAmount] = useState('10000000000000000000');
  const [maxPlayers, setMaxPlayers] = useState('4');
  const [rewardPerPrize, setRewardPerPrize] = useState('2000000000000000000');
  const [entropyFee, setEntropyFee] = useState('0');
  const [player, setPlayer] = useState('0x2222222222222222222222222222222222222222');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [payload, setPayload] = useState(null);
  const [execution, setExecution] = useState(null);
  const [walletTestMode, setWalletTestMode] = useState(true);
  const [error, setError] = useState('');
  const [demoBoard, setDemoBoard] = useState(() => makeDemoBoard('Normal', 'demo-player'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [demoStatus, setDemoStatus] = useState({ joined: false, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Start demo session, then join and reveal tiles.' });

  useEffect(() => {
    getJson('/health')
      .then((data) => {
        setHealth(data.ok ? 'online' : 'offline');
        setContractAddress(data.contractAddress || '');
      })
      .catch(() => setHealth('offline'));
  }, []);

  useEffect(() => {
    if (!window.ethereum) return undefined;

    const handleAccounts = (accounts) => setWallet(accounts?.[0] || '');
    const handleChain = (nextChainId) => setChainId(nextChainId || '');

    window.ethereum.request({ method: 'eth_accounts' }).then(handleAccounts).catch(() => {});
    window.ethereum.request({ method: 'eth_chainId' }).then(handleChain).catch(() => {});
    window.ethereum.on?.('accountsChanged', handleAccounts);
    window.ethereum.on?.('chainChanged', handleChain);

    return () => {
      window.ethereum.removeListener?.('accountsChanged', handleAccounts);
      window.ethereum.removeListener?.('chainChanged', handleChain);
    };
  }, []);

  const tiles = useMemo(() => Array.from({ length: 64 }, (_, index) => index), []);
  const walletReady = Boolean(wallet);
  const onBase = chainId === BASE_CHAIN_ID || chainId === BASE_SEPOLIA_CHAIN_ID;

  async function run(label, fn) {
    setError('');
    setExecution(null);
    try {
      const nextPayload = await fn();
      setPayload({ label, ...nextPayload });
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const nextChainId = await provider.request({ method: 'eth_chainId' });
      setWallet(accounts[0] || '');
      setPlayer(accounts[0] || player);
      setChainId(nextChainId);
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function switchToBase() {
    setError('');
    try {
      const provider = getWalletProvider();
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID }] });
      setChainId(await provider.request({ method: 'eth_chainId' }));
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function executePayload() {
    setError('');
    setExecution(null);
    try {
      if (!payload) throw new Error('Build a payload first.');
      const provider = getWalletProvider();
      const accounts = wallet ? [wallet] : await provider.request({ method: 'eth_requestAccounts' });
      const from = accounts[0];
      if (!from) throw new Error('Wallet is not connected.');
      setWallet(from);
      setPlayer(from);

      if (payload.decodeAs || walletTestMode) {
        const result = await provider.request({
          method: 'eth_call',
          params: [{ from, to: payload.to, data: payload.data, value: `0x${BigInt(payload.value || '0').toString(16)}` }, 'latest'],
        });
        setExecution({ kind: payload.decodeAs ? 'read' : 'simulation', decodeAs: payload.decodeAs, result });
        return;
      }

      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: payload.to, data: payload.data, value: `0x${BigInt(payload.value || '0').toString(16)}` }],
      });
      setExecution({ kind: 'transaction', hash });
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  function resetDemo(nextDifficulty = difficulty) {
    setDemoBoard(makeDemoBoard(nextDifficulty, player || wallet || 'demo-player'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setDemoStatus({ joined: false, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Demo session ready. Join to generate your player board.' });
  }

  function joinDemo() {
    setDemoBoard(makeDemoBoard(difficulty, player || wallet || 'demo-player'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setDemoStatus({ joined: true, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Player board generated. Pick tiles until 3 bombs or all prizes found.' });
  }

  function revealDemoTile(tile) {
    if (!demoStatus.joined || demoStatus.gameOver) return;
    if (revealed[tile] !== TILE_HIDDEN) return;
    const outcome = demoBoard[tile];
    const nextRevealed = [...revealed];
    nextRevealed[tile] = outcome;
    const bombs = demoStatus.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = demoStatus.prizes + (outcome === 'prize' ? 1 : 0);
    const gameOver = bombs >= 3;
    const message = gameOver ? 'Game over: 3 bombs hit.' : outcome === 'prize' ? 'Prize found.' : outcome === 'bomb' ? 'Bomb hit.' : 'Empty tile.';
    setRevealed(nextRevealed);
    setDemoStatus({ joined: true, bombs, prizes, clicks: demoStatus.clicks + 1, gameOver, message });
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Base game terminal</p>
          <h1>Chancy</h1>
          <p className="subtitle">Pyth Entropy powered 8×8 risk grid. Build, sign, send, and read Chancy payloads from a Base wallet.</p>
        </div>
        <div className="top-actions">
          <div className={`status ${health}`}>API {health}</div>
          {shortAddress(contractAddress) && <div className="status contract">Contract {shortAddress(contractAddress)}</div>}
          <button className="wallet-button" onClick={connectWallet}>{walletReady ? shortAddress(wallet) : 'Connect wallet'}</button>
          {walletReady && !onBase && <button className="wallet-button warning" onClick={switchToBase}>Switch to Base</button>}
        </div>
      </section>

      <section className="layout">
        <aside className="panel controls">
          <h2>Session controls</h2>
          <label>
            Difficulty
            <select aria-label="difficulty" value={difficulty} onChange={(event) => { setDifficulty(event.target.value); resetDemo(event.target.value); }}>
              <option>Easy</option>
              <option>Normal</option>
              <option>Hardcore</option>
            </select>
          </label>
          <label>
            Currency
            <select aria-label="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
              <option>ETH</option>
              <option>USDC</option>
            </select>
          </label>
          <label>Session ID<input value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
          <label>Entry amount<input value={entryAmount} onChange={(event) => setEntryAmount(event.target.value)} /></label>
          <label>Max players<input value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} /></label>
          <label>Reward per prize<input value={rewardPerPrize} onChange={(event) => setRewardPerPrize(event.target.value)} /></label>
          <label>Entropy fee<input value={entropyFee} onChange={(event) => setEntropyFee(event.target.value)} /></label>
          <label>Player address<input value={player} onChange={(event) => setPlayer(event.target.value)} /></label>

          <button onClick={() => run('/tx/create-session', () => postJson('/tx/create-session', { currency, difficulty, entryAmount, maxPlayers, rewardPerPrize }))}>Build create session tx</button>
          <button onClick={() => run('/tx/fund-session-rewards', () => postJson('/tx/fund-session-rewards', { sessionId, currency, amount: String(BigInt(rewardPerPrize || '0') * BigInt(maxPlayers || '0') * 2n) }))}>Build fund tx</button>
          <button onClick={() => run('/tx/join-session', () => postJson('/tx/join-session', { sessionId, currency, userRandomNumber: DEFAULT_RANDOM, entropyFee, entryAmount }))}>Build join tx</button>
          <button onClick={() => run('/tx/claim-rewards', () => postJson('/tx/claim-rewards', { currency }))}>Build claim tx</button>
          <button onClick={() => run('/read/session', () => getJson(`/read/session/${sessionId}`))}>Build session read</button>
          <button onClick={() => run('/read/player-game', () => getJson(`/read/player-game/${sessionId}/${player}`))}>Build player read</button>
          <button onClick={() => run('/read/claimable-rewards', () => getJson(`/read/claimable-rewards/${currency}/${player}`))}>Build claimable read</button>
          <button onClick={() => run('/read/next-session-id', () => getJson('/read/next-session-id'))}>Build next session read</button>
        </aside>

        <section className="panel board-panel">
          <div className="panel-head">
            <h2>Playable demo board</h2>
            <span>{DIFFICULTY_CONFIG[difficulty].bombs} bombs / {DIFFICULTY_CONFIG[difficulty].prizes} prizes</span>
          </div>
          <div className="demo-actions">
            <button onClick={() => resetDemo()}>Start demo session</button>
            <button onClick={joinDemo}>Join as player</button>
          </div>
          <div className="score-strip">
            <span>Bombs {demoStatus.bombs}/3</span>
            <span>Prizes {demoStatus.prizes}</span>
            <span>Clicks {demoStatus.clicks}</span>
            <span>{demoStatus.joined ? demoStatus.gameOver ? 'Game over' : 'Playing' : 'Not joined'}</span>
          </div>
          <p className="muted">{demoStatus.message}</p>
          <div className="grid" aria-label="Chancy 8x8 board">
            {tiles.map((tile) => (
              <button
                key={tile}
                aria-label={`tile ${tile}`}
                className={`tile ${revealed[tile]}`}
                onClick={() => { revealDemoTile(tile); run('/tx/click-tile', () => postJson('/tx/click-tile', { sessionId, tileIndex: tile })); }}
              >
                {revealed[tile] === 'hidden' ? tile : revealed[tile] === 'bomb' ? '✹' : revealed[tile] === 'prize' ? '◆' : '·'}
              </button>
            ))}
          </div>
        </section>

        <section className="panel payload-panel">
          <div className="panel-head">
            <h2>Payload</h2>
            <label className="test-mode">
              <input type="checkbox" checked={walletTestMode} onChange={(event) => setWalletTestMode(event.target.checked)} />
              Wallet test mode: simulate writes with eth_call
            </label>
            <button className="execute-button" disabled={!payload} onClick={executePayload}>{payload?.decodeAs ? 'Run wallet read' : walletTestMode ? 'Simulate with wallet' : 'Send with wallet'}</button>
          </div>
          {error && <pre className="error">{error}</pre>}
          {payload ? <pre>{JSON.stringify(payload, null, 2)}</pre> : <p className="muted">No payload yet. Build a transaction or read call.</p>}
          {execution && <pre className="execution">{JSON.stringify(execution, null, 2)}</pre>}
        </section>
      </section>
    </main>
  );
}
