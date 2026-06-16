import React, { useEffect, useMemo, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS || '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BASE_CHAIN_ID = '0x2105';
const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
const USDC_DECIMALS = 1_000_000n;
const TILE_HIDDEN = 'hidden';

const CHAIN_CONFIG = {
  [BASE_CHAIN_ID]: { label: 'Base', usdc: BASE_USDC_ADDRESS, swapUrl: 'https://app.uniswap.org/swap?chain=base&outputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  [BASE_SEPOLIA_CHAIN_ID]: { label: 'Base Sepolia', usdc: BASE_SEPOLIA_USDC_ADDRESS, swapUrl: 'https://faucet.circle.com/' },
};

const DIFFICULTIES = {
  Easy: { bombs: 5, prizes: 3, copy: 'More safe tiles for first runs.' },
  Normal: { bombs: 7, prizes: 2, copy: 'Balanced room for most players.' },
  Hardcore: { bombs: 10, prizes: 1, copy: 'One prize. Ten bombs.' },
};

const FEATURED_SESSIONS = [
  { id: '1', difficulty: 'Easy', entry: '1', prize: '0.25', players: '2/6', state: 'Open' },
  { id: '2', difficulty: 'Normal', entry: '2', prize: '0.75', players: '3/5', state: 'Open' },
  { id: '3', difficulty: 'Hardcore', entry: '5', prize: '3', players: '1/4', state: 'High risk' },
];

function usdcUnits(value) {
  const clean = String(value || '0').trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) return '0';
  const [whole, fraction = ''] = clean.split('.');
  return (BigInt(whole || '0') * USDC_DECIMALS + BigInt((fraction + '000000').slice(0, 6))).toString();
}

function makeBoard(difficulty, seed) {
  const config = DIFFICULTIES[difficulty];
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

function RulesModal({ onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title">
      <section className="rules-modal">
        <button className="icon-button close" type="button" aria-label="Close rules" onClick={onClose}>×</button>
        <img src={chancyLogo} alt="" />
        <p className="kicker">Chancy in 20 seconds</p>
        <h2 id="rules-title">Find prizes before your third bomb.</h2>
        <div className="rule-list">
          <p><strong>Browse rooms.</strong> Pick a session by entry, difficulty, and player count.</p>
          <p><strong>Join with USDC.</strong> Stable entries and rewards keep the math clear.</p>
          <p><strong>Reveal tiles.</strong> Prizes pay. Empty tiles are safe. Three bombs end the run.</p>
        </div>
        <button className="main-button full" type="button" onClick={onClose}>Got it</button>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('landing');
  const [health, setHealth] = useState('checking');
  const [difficulty, setDifficulty] = useState('Normal');
  const [entryUsdc, setEntryUsdc] = useState('1');
  const [rewardUsdc, setRewardUsdc] = useState('0.25');
  const [maxPlayers, setMaxPlayers] = useState('4');
  const [sessionId, setSessionId] = useState('1');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));
  const [board, setBoard] = useState(() => makeBoard('Normal', 'chancy'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [run, setRun] = useState({ role: '', bombs: 0, prizes: 0, active: false, ended: false, message: 'Join a session to reveal your board.' });
  const [lastAction, setLastAction] = useState('Ready');
  const [error, setError] = useState('');

  useEffect(() => { getJson('/health').then((data) => setHealth(data.ok ? 'online' : 'offline')).catch(() => setHealth('offline')); }, []);

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
  const selectedAsset = CHAIN_CONFIG[chainId]?.usdc || BASE_SEPOLIA_USDC_ADDRESS;
  const swapUrl = CHAIN_CONFIG[chainId]?.swapUrl || CHAIN_CONFIG[BASE_SEPOLIA_CHAIN_ID].swapUrl;
  const entryAmount = usdcUnits(entryUsdc);
  const rewardPerPrize = usdcUnits(rewardUsdc);
  const reserveAmount = String(BigInt(rewardPerPrize) * BigInt(maxPlayers || '0') * BigInt(DIFFICULTIES[difficulty].prizes));
  const walletLabel = wallet ? shortAddress(wallet) : 'Connect wallet';

  function closeRules() {
    localStorage.setItem('chancy_rules_seen', '1');
    setShowRules(false);
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const nextChainId = await provider.request({ method: 'eth_chainId' });
      setWallet(accounts[0] || '');
      setChainId(nextChainId);
      setLastAction('Wallet connected');
    } catch (err) { setError(err.message || String(err)); }
  }

  function openSessions() {
    setError('');
    setView('sessions');
    setLastAction('Sessions loaded');
  }

  async function createSession() {
    setError('');
    try {
      await postJson('/tx/create-session', { asset: selectedAsset, difficulty, entryAmount, maxPlayers, rewardPerPrize });
      await postJson('/tx/fund-session-rewards', { sessionId, asset: selectedAsset, amount: reserveAmount });
      setBoard(makeBoard(difficulty, wallet || `host-${sessionId}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'host', bombs: 0, prizes: 0, active: false, ended: false, message: 'You host this room. You can see it, but hosts cannot play their own room.' });
      setView('room');
      setLastAction('Room created');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function joinSession(session) {
    setError('');
    try {
      const nextDifficulty = session?.difficulty || difficulty;
      const nextEntry = session?.entry || entryUsdc;
      const nextPrize = session?.prize || rewardUsdc;
      const nextId = session?.id || sessionId;
      setDifficulty(nextDifficulty);
      setEntryUsdc(nextEntry);
      setRewardUsdc(nextPrize);
      setSessionId(nextId);
      await postJson('/tx/join-session', { sessionId: nextId, asset: selectedAsset, userRandomNumber: DEFAULT_RANDOM, entropyFee: '0', entryAmount: usdcUnits(nextEntry) });
      setBoard(makeBoard(nextDifficulty, wallet || `player-${nextId}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'player', bombs: 0, prizes: 0, active: true, ended: false, message: 'You joined. Reveal tiles carefully.' });
      setView('room');
      setLastAction('Joined session');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function claimRewards() {
    setError('');
    try {
      await postJson('/tx/claim-rewards', { asset: selectedAsset });
      setLastAction('Claim ready');
    } catch (err) { setError(err.message || String(err)); }
  }

  function revealTile(tile) {
    if (run.role !== 'player' || !run.active || run.ended || revealed[tile] !== TILE_HIDDEN) return;
    const outcome = board[tile];
    const nextRevealed = [...revealed];
    nextRevealed[tile] = outcome;
    const bombs = run.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = run.prizes + (outcome === 'prize' ? 1 : 0);
    const ended = bombs >= 3;
    const message = ended ? 'Run ended. 3 bombs hit.' : outcome === 'prize' ? 'Prize found. Keep hunting or claim.' : outcome === 'bomb' ? 'Bomb hit. Stay sharp.' : 'Safe tile.';
    setRevealed(nextRevealed);
    setRun({ ...run, bombs, prizes, ended, message });
    postJson('/tx/click-tile', { sessionId, tileIndex: tile }).then(() => setLastAction('Move ready')).catch(() => {});
  }

  return (
    <main className="product-shell">
      {showRules && <RulesModal onClose={closeRules} />}
      <button className="help-button" type="button" aria-label="How Chancy works" onClick={() => setShowRules(true)}>?</button>

      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView('landing')}><img src={chancyLogo} alt="Chancy logo" /><span>Chancy</span></button>
        <nav className="top-actions" aria-label="Main actions">
          <button className="text-link" type="button" onClick={openSessions}>Sessions</button>
          <button className="text-link" type="button" onClick={() => setShowRules(true)}>Rules</button>
          <a className="ghost-button" href={swapUrl} target="_blank" rel="noreferrer">Get USDC</a>
          <button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button>
        </nav>
      </header>

      {view === 'landing' && (
        <>
          <section className="landing-hero">
            <div className="hero-copy">
              <p className="kicker">USDC tile game on Base</p>
              <h1>Pick a room. Reveal tiles. Dodge the third bomb.</h1>
              <p className="lede">Chancy is a simple risk game: join a USDC room, uncover your private board, and claim prizes before the bombs end your run.</p>
              <div className="hero-buttons">
                <button className="main-button large" type="button" onClick={openSessions}>Browse sessions</button>
                <button className="ghost-button large" type="button" onClick={() => setShowRules(true)}>How it works</button>
              </div>
            </div>
            <div className="hero-visual" aria-label="Chancy game preview"><img src={chancyLogo} alt="" /><span>3 bombs ends the run</span></div>
          </section>

          <section className="info-grid" aria-label="Game guide">
            <div><strong>1. Choose a session</strong><span>Browse open rooms by difficulty, entry size, prize amount, and seats.</span></div>
            <div><strong>2. Join with USDC</strong><span>One stable asset keeps every number readable and every prize clear.</span></div>
            <div><strong>3. Reveal your board</strong><span>The board appears only after you join or create a room.</span></div>
          </section>

          <section className="landing-guide">
            <div><p className="kicker">Game aspects</p><h2>Fast decisions, clear math, private boards.</h2></div>
            <div className="guide-list">
              <p><strong>Hosts create rooms.</strong> Hosts set terms and fund rewards, but do not play their own room.</p>
              <p><strong>Players take the risk.</strong> Every tile is a decision. Prizes accrue, bombs pressure the run.</p>
              <p><strong>USDC keeps it readable.</strong> No ETH decimal noise on the game screen.</p>
            </div>
          </section>
        </>
      )}

      {view === 'sessions' && (
        <section className="sessions-page">
          <div className="page-head"><p className="kicker">Open rooms</p><h1>Choose where to play.</h1><p className="lede">Pick an existing session or create a fresh room for others.</p></div>
          <div className="sessions-layout">
            <div className="session-list">
              {FEATURED_SESSIONS.map((session) => (
                <article className="session-card" key={session.id}>
                  <div><strong>Room #{session.id}</strong><span>{session.state}</span></div>
                  <div><span>Difficulty</span><strong>{session.difficulty}</strong></div>
                  <div><span>Entry</span><strong>{session.entry} USDC</strong></div>
                  <div><span>Prize</span><strong>{session.prize} USDC</strong></div>
                  <div><span>Players</span><strong>{session.players}</strong></div>
                  <button className="main-button" type="button" onClick={() => joinSession(session)}>Join room</button>
                </article>
              ))}
            </div>
            <aside className="create-card">
              <h2>Create a room</h2>
              <div className="fields">
                <label>Difficulty<select aria-label="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option>Easy</option><option>Normal</option><option>Hardcore</option></select><small>{DIFFICULTIES[difficulty].copy}</small></label>
                <label>Entry USDC<input aria-label="entry amount usdc" inputMode="decimal" value={entryUsdc} onChange={(event) => setEntryUsdc(event.target.value)} /></label>
                <label>Prize per tile<input aria-label="reward per prize usdc" inputMode="decimal" value={rewardUsdc} onChange={(event) => setRewardUsdc(event.target.value)} /></label>
                <label>Max players<input aria-label="max players" inputMode="numeric" value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} /></label>
                <label>Room ID<input aria-label="session id" inputMode="numeric" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
              </div>
              <button className="main-button full" type="button" onClick={createSession}>Create room</button>
            </aside>
          </div>
        </section>
      )}

      {view === 'room' && (
        <section className="room-page">
          <div className="room-header">
            <button className="ghost-button" type="button" onClick={openSessions}>Back to sessions</button>
            <div><p className="kicker">Room #{sessionId}</p><h1>{run.role === 'host' ? 'Host view' : 'Your board'}</h1></div>
          </div>
          <div className="room-layout">
            <section className={`board-card ${run.role === 'host' ? 'locked' : ''}`}>
              <div className="meter-row">
                <div><span>Bombs</span><strong>{run.bombs}/3</strong></div>
                <div><span>Prizes</span><strong>{run.prizes}</strong></div>
                <div><span>Mode</span><strong>{difficulty}</strong></div>
              </div>
              <p className="status-line">{run.message}</p>
              <div className="tile-board" aria-label="Chancy 8x8 board">
                {tiles.map((tile) => <button key={tile} aria-label={`tile ${tile}`} className={`tile ${revealed[tile]}`} onClick={() => revealTile(tile)}>{revealed[tile] === 'hidden' ? '' : revealed[tile] === 'bomb' ? '×' : revealed[tile] === 'prize' ? '$' : '·'}</button>)}
              </div>
            </section>
            <aside className="run-card">
              <h2>{run.role === 'host' ? 'Room is live' : 'Run details'}</h2>
              <div className="stat-list"><div><span>Entry</span><strong>{entryUsdc} USDC</strong></div><div><span>Prize tile</span><strong>{rewardUsdc} USDC</strong></div><div><span>Seats</span><strong>{maxPlayers}</strong></div></div>
              {run.role === 'host' ? <p className="note">Hosts manage the session and rewards. Players join from the sessions list.</p> : <button className="main-button full" type="button" onClick={claimRewards}>Claim USDC</button>}
            </aside>
          </div>
        </section>
      )}

      <footer className="app-footer"><span>{health === 'online' ? 'Game API online' : 'Game API offline'}</span><span>{lastAction}</span>{error && <strong className="error-text">{error}</strong>}</footer>
    </main>
  );
}
