import React, { useEffect, useMemo, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS || '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BASE_CHAIN_ID = '0x2105';
const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
const CHAIN_CONFIG = {
  [BASE_CHAIN_ID]: { label: 'Base', usdc: BASE_USDC_ADDRESS, swapUrl: 'https://app.uniswap.org/swap?chain=base&outputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  [BASE_SEPOLIA_CHAIN_ID]: { label: 'Base Sepolia', usdc: BASE_SEPOLIA_USDC_ADDRESS, swapUrl: 'https://faucet.circle.com/' },
};
const DIFFICULTY_CONFIG = {
  Easy: { bombs: 5, prizes: 3, hint: 'More room to learn.' },
  Normal: { bombs: 7, prizes: 2, hint: 'Balanced risk.' },
  Hardcore: { bombs: 10, prizes: 1, hint: 'Sharp teeth.' },
};
const TILE_HIDDEN = 'hidden';
const USDC_DECIMALS = 1_000_000n;

function usdcUnits(value) {
  const clean = String(value || '0').trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) return '0';
  const [whole, fraction = ''] = clean.split('.');
  return (BigInt(whole || '0') * USDC_DECIMALS + BigInt((fraction + '000000').slice(0, 6))).toString();
}

function makeDemoBoard(difficulty, seed) {
  const config = DIFFICULTY_CONFIG[difficulty];
  let state = Array.from(`${seed}:${difficulty}`).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  const used = new Set();
  const pick = () => {
    do { state = (state * 1664525 + 1013904223) >>> 0; } while (used.has(state % 64));
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
  const response = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

function chainLabel(chainId) {
  return CHAIN_CONFIG[chainId]?.label || (chainId ? `Unsupported (${chainId})` : 'Not connected');
}

function InfoModal({ onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="how-chancy-works">
      <div className="modal-card">
        <button className="modal-close" type="button" aria-label="Close rules" onClick={onClose}>×</button>
        <p className="mini-label">How Chancy works</p>
        <h2 id="how-chancy-works">Find prizes before 3 bombs find you.</h2>
        <div className="rules-grid">
          <div><strong>1. Choose a room</strong><span>Pick difficulty, entry price, and the prize amount in USDC.</span></div>
          <div><strong>2. Join the board</strong><span>Each player gets their own hidden 8 by 8 board from Pyth Entropy.</span></div>
          <div><strong>3. Reveal tiles</strong><span>Prizes add rewards. Empty tiles are safe. Hit 3 bombs and the run ends.</span></div>
        </div>
        <button className="primary-action wide" type="button" onClick={onClose}>Play the demo</button>
      </div>
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState('checking');
  const [contractAddress, setContractAddress] = useState('');
  const [difficulty, setDifficulty] = useState('Normal');
  const [sessionId, setSessionId] = useState('1');
  const [entryUsdc, setEntryUsdc] = useState('1');
  const [maxPlayers, setMaxPlayers] = useState('4');
  const [rewardUsdc, setRewardUsdc] = useState('0.25');
  const [entropyFee, setEntropyFee] = useState('0');
  const [player, setPlayer] = useState('0x2222222222222222222222222222222222222222');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [payload, setPayload] = useState(null);
  const [execution, setExecution] = useState(null);
  const [walletTestMode, setWalletTestMode] = useState(true);
  const [error, setError] = useState('');
  const [showInfo, setShowInfo] = useState(() => !localStorage.getItem('chancy_intro_seen'));
  const [demoBoard, setDemoBoard] = useState(() => makeDemoBoard('Normal', 'demo-player'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [demoStatus, setDemoStatus] = useState({ joined: false, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Start a demo room, join, then reveal tiles.' });

  useEffect(() => { getJson('/health').then((data) => { setHealth(data.ok ? 'online' : 'offline'); setContractAddress(data.contractAddress || ''); }).catch(() => setHealth('offline')); }, []);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const handleAccounts = (accounts) => setWallet(accounts?.[0] || '');
    const handleChain = (nextChainId) => setChainId(nextChainId || '');
    window.ethereum.request({ method: 'eth_accounts' }).then(handleAccounts).catch(() => {});
    window.ethereum.request({ method: 'eth_chainId' }).then(handleChain).catch(() => {});
    window.ethereum.on?.('accountsChanged', handleAccounts);
    window.ethereum.on?.('chainChanged', handleChain);
    return () => { window.ethereum.removeListener?.('accountsChanged', handleAccounts); window.ethereum.removeListener?.('chainChanged', handleChain); };
  }, []);

  const tiles = useMemo(() => Array.from({ length: 64 }, (_, index) => index), []);
  const walletReady = Boolean(wallet);
  const onBase = chainId === BASE_CHAIN_ID || chainId === BASE_SEPOLIA_CHAIN_ID;
  const selectedAsset = CHAIN_CONFIG[chainId]?.usdc || BASE_SEPOLIA_USDC_ADDRESS;
  const networkName = chainLabel(chainId);
  const entryAmount = usdcUnits(entryUsdc);
  const rewardPerPrize = usdcUnits(rewardUsdc);
  const sessionReserve = String(BigInt(rewardPerPrize) * BigInt(maxPlayers || '0') * BigInt(DIFFICULTY_CONFIG[difficulty].prizes));
  const swapUrl = CHAIN_CONFIG[chainId]?.swapUrl || CHAIN_CONFIG[BASE_SEPOLIA_CHAIN_ID].swapUrl;

  function closeInfo() {
    localStorage.setItem('chancy_intro_seen', '1');
    setShowInfo(false);
  }

  async function run(label, fn) {
    setError(''); setExecution(null);
    try { setPayload({ label, ...(await fn()) }); } catch (err) { setError(err.message || String(err)); }
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const nextChainId = await provider.request({ method: 'eth_chainId' });
      setWallet(accounts[0] || ''); setPlayer(accounts[0] || player); setChainId(nextChainId);
    } catch (err) { setError(err.message || String(err)); }
  }

  async function switchToBase() {
    setError('');
    try {
      const provider = getWalletProvider();
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }] });
      setChainId(await provider.request({ method: 'eth_chainId' }));
    } catch (err) { setError(err.message || String(err)); }
  }

  async function executePayload() {
    setError(''); setExecution(null);
    try {
      if (!payload) throw new Error('Build a payload first.');
      const provider = getWalletProvider();
      const accounts = wallet ? [wallet] : await provider.request({ method: 'eth_requestAccounts' });
      const from = accounts[0];
      if (!from) throw new Error('Wallet is not connected.');
      setWallet(from); setPlayer(from);
      if (payload.decodeAs || walletTestMode) {
        const result = await provider.request({ method: 'eth_call', params: [{ from, to: payload.to, data: payload.data, value: `0x${BigInt(payload.value || '0').toString(16)}` }, 'latest'] });
        setExecution({ kind: payload.decodeAs ? 'read' : 'simulation', decodeAs: payload.decodeAs, result });
        return;
      }
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: payload.to, data: payload.data, value: `0x${BigInt(payload.value || '0').toString(16)}` }] });
      setExecution({ kind: 'transaction', hash });
    } catch (err) { setError(err.message || String(err)); }
  }

  function resetDemo(nextDifficulty = difficulty) {
    setDemoBoard(makeDemoBoard(nextDifficulty, player || wallet || 'demo-player'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setDemoStatus({ joined: false, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Demo room ready. Join to generate your player board.' });
  }

  function joinDemo() {
    setDemoBoard(makeDemoBoard(difficulty, player || wallet || 'demo-player'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setDemoStatus({ joined: true, bombs: 0, prizes: 0, clicks: 0, gameOver: false, message: 'Board generated. Reveal tiles until you find all prizes or hit 3 bombs.' });
  }

  function revealDemoTile(tile) {
    if (!demoStatus.joined || demoStatus.gameOver || revealed[tile] !== TILE_HIDDEN) return;
    const outcome = demoBoard[tile];
    const nextRevealed = [...revealed]; nextRevealed[tile] = outcome;
    const bombs = demoStatus.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = demoStatus.prizes + (outcome === 'prize' ? 1 : 0);
    const gameOver = bombs >= 3;
    const message = gameOver ? 'Game over. 3 bombs hit.' : outcome === 'prize' ? 'Prize found. Keep going or claim later.' : outcome === 'bomb' ? 'Bomb hit. Two more end the run.' : 'Safe tile. Nothing here.';
    setRevealed(nextRevealed); setDemoStatus({ joined: true, bombs, prizes, clicks: demoStatus.clicks + 1, gameOver, message });
  }

  return (
    <main className="app-shell">
      {showInfo && <InfoModal onClose={closeInfo} />}
      <button className="floating-info" aria-label="How Chancy works" type="button" onClick={() => setShowInfo(true)}>?</button>

      <header className="nav-bar">
        <a className="brand-mark" href="#top" aria-label="Chancy home">
          <img src={chancyLogo} alt="Chancy logo" />
          <span>Chancy</span>
        </a>
        <nav className="nav-actions" aria-label="Chancy actions">
          <span className={`pill ${health}`}>API {health}</span>
          <span className={`pill ${onBase ? 'contract' : 'offline'}`}>{networkName}</span>
          <a className="secondary-action" href={swapUrl} target="_blank" rel="noreferrer">Get USDC</a>
          <button className="primary-action" type="button" onClick={connectWallet}>{walletReady ? shortAddress(wallet) : 'Connect wallet'}</button>
        </nav>
      </header>

      <section id="top" className="hero-stage">
        <div className="hero-copy">
          <p className="mini-label">USDC-first game on Base</p>
          <h1>Pick tiles. Dodge bombs. Claim USDC.</h1>
          <p className="hero-subtitle">A light risk game where every player gets a private 8 by 8 board.</p>
          <div className="hero-actions">
            <button className="primary-action large" type="button" onClick={joinDemo}>Try demo board</button>
            <button className="secondary-action large" type="button" onClick={() => setShowInfo(true)}>How it works</button>
          </div>
        </div>
        <div className="hero-card" aria-label="Game summary">
          <div className="card-orbit"><img src={chancyLogo} alt="" /></div>
          <div className="quick-stats">
            <div><span>Entry</span><strong>{entryUsdc} USDC</strong></div>
            <div><span>Prize</span><strong>{rewardUsdc} USDC</strong></div>
            <div><span>Bomb limit</span><strong>3 hits</strong></div>
          </div>
          <p>Simple rule: reveal prizes before your third bomb.</p>
        </div>
      </section>

      <section className="play-layout">
        <section className="game-panel">
          <div className="section-head">
            <div>
              <p className="mini-label">Live demo</p>
              <h2>Reveal your board</h2>
            </div>
            <span className="round-badge">{DIFFICULTY_CONFIG[difficulty].bombs} bombs / {DIFFICULTY_CONFIG[difficulty].prizes} prizes</span>
          </div>

          <div className="score-board">
            <div><span>Bombs</span><strong>{demoStatus.bombs}/3</strong></div>
            <div><span>Prizes</span><strong>{demoStatus.prizes}</strong></div>
            <div><span>Clicks</span><strong>{demoStatus.clicks}</strong></div>
            <div><span>Status</span><strong>{demoStatus.joined ? demoStatus.gameOver ? 'Game over' : 'Playing' : 'Ready'}</strong></div>
          </div>

          <p className="game-message">{demoStatus.message}</p>

          <div className="tile-grid" aria-label="Chancy 8x8 board">
            {tiles.map((tile) => (
              <button key={tile} aria-label={`tile ${tile}`} className={`tile ${revealed[tile]}`} onClick={() => { revealDemoTile(tile); run('/tx/click-tile', () => postJson('/tx/click-tile', { sessionId, tileIndex: tile })); }}>
                {revealed[tile] === 'hidden' ? '' : revealed[tile] === 'bomb' ? '✕' : revealed[tile] === 'prize' ? '$' : '·'}
              </button>
            ))}
          </div>

          <div className="demo-buttons">
            <button type="button" className="secondary-action" onClick={() => resetDemo()}>Reset board</button>
            <button type="button" className="primary-action" onClick={joinDemo}>Join demo</button>
          </div>
        </section>

        <aside className="room-panel">
          <div className="section-head compact">
            <div>
              <p className="mini-label">Room setup</p>
              <h2>USDC only for v1</h2>
            </div>
          </div>

          <div className="field-stack">
            <label>Difficulty<select aria-label="difficulty" value={difficulty} onChange={(event) => { setDifficulty(event.target.value); resetDemo(event.target.value); }}><option>Easy</option><option>Normal</option><option>Hardcore</option></select><small>{DIFFICULTY_CONFIG[difficulty].hint}</small></label>
            <label>Entry amount (USDC)<input aria-label="entry amount usdc" value={entryUsdc} onChange={(event) => setEntryUsdc(event.target.value)} /></label>
            <label>Reward per prize (USDC)<input aria-label="reward per prize usdc" value={rewardUsdc} onChange={(event) => setRewardUsdc(event.target.value)} /></label>
            <label>Max players<input aria-label="max players" value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} /></label>
          </div>

          <div className="asset-card">
            <strong>Selected asset</strong>
            <span>{shortAddress(selectedAsset)} on {networkName}</span>
            {shortAddress(contractAddress) && <span>Contract {shortAddress(contractAddress)}</span>}
          </div>

          {walletReady && !onBase && <button className="secondary-action wide" type="button" onClick={switchToBase}>Switch to Base Sepolia</button>}

          <div className="tx-actions">
            <button type="button" onClick={() => run('/tx/create-session', () => postJson('/tx/create-session', { asset: selectedAsset, difficulty, entryAmount, maxPlayers, rewardPerPrize }))}>Build create session tx</button>
            <button type="button" onClick={() => run('/tx/fund-session-rewards', () => postJson('/tx/fund-session-rewards', { sessionId, asset: selectedAsset, amount: sessionReserve }))}>Build fund tx</button>
            <button type="button" onClick={() => run('/tx/join-session', () => postJson('/tx/join-session', { sessionId, asset: selectedAsset, userRandomNumber: DEFAULT_RANDOM, entropyFee, entryAmount }))}>Build join tx</button>
            <button type="button" onClick={() => run('/tx/claim-rewards', () => postJson('/tx/claim-rewards', { asset: selectedAsset }))}>Build claim tx</button>
          </div>
        </aside>
      </section>

      <section className="details-layout">
        <div className="guide-card">
          <h2>Mechanics in plain language</h2>
          <div className="mechanic-list">
            <div><strong>Private boards</strong><span>Every player gets a separate board generated from entropy.</span></div>
            <div><strong>Known risk</strong><span>Difficulty sets bombs and prizes before anyone joins.</span></div>
            <div><strong>USDC math</strong><span>Entries and rewards stay stable, readable, and easy to compare.</span></div>
          </div>
        </div>

        <div className="payload-panel">
          <div className="section-head compact">
            <div>
              <p className="mini-label">Transaction preview</p>
              <h2>Payload builder</h2>
            </div>
            <label className="test-mode"><input type="checkbox" checked={walletTestMode} onChange={(event) => setWalletTestMode(event.target.checked)} />Wallet test mode</label>
          </div>

          <div className="hidden-fields" aria-label="advanced transaction inputs">
            <label>Session ID<input value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
            <label>Entropy fee (wei)<input value={entropyFee} onChange={(event) => setEntropyFee(event.target.value)} /></label>
            <label>Player address<input value={player} onChange={(event) => setPlayer(event.target.value)} /></label>
          </div>

          <div className="read-actions">
            <button type="button" onClick={() => run('/read/session', () => getJson(`/read/session/${sessionId}`))}>Build session read</button>
            <button type="button" onClick={() => run('/read/player-game', () => getJson(`/read/player-game/${sessionId}/${player}`))}>Build player read</button>
            <button type="button" onClick={() => run('/read/claimable-rewards', () => getJson(`/read/claimable-rewards/${player}/${selectedAsset}`))}>Build claimable read</button>
            <button type="button" onClick={() => run('/read/next-session-id', () => getJson('/read/next-session-id'))}>Build next session read</button>
          </div>

          <button className="primary-action wide" disabled={!payload} type="button" onClick={executePayload}>{payload?.decodeAs ? 'Run wallet read' : walletTestMode ? 'Simulate with wallet' : 'Send with wallet'}</button>
          {error && <pre className="error">{error}</pre>}
          {payload ? <pre>{JSON.stringify(payload, null, 2)}</pre> : <p className="soft-copy">Build a transaction or read call to inspect the wallet payload.</p>}
          {execution && <pre className="execution">{JSON.stringify(execution, null, 2)}</pre>}
        </div>
      </section>
    </main>
  );
}
