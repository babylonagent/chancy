import React, { useEffect, useMemo, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BASE_CHAIN_ID = '0x2105';
const USDC_DECIMALS = 1_000_000n;
const TILE_HIDDEN = 'hidden';

const CHAIN_CONFIG = { [BASE_CHAIN_ID]: { label: 'Base', usdc: BASE_USDC_ADDRESS } };
const DIFFICULTIES = {
  Easy: { bombs: 5, prizes: 3, startBps: 150, capBps: 15000, copy: 'Lower starting cost. More prize tiles.' },
  Normal: { bombs: 7, prizes: 2, startBps: 250, capBps: 20000, copy: 'Balanced risk for most rooms.' },
  Hardcore: { bombs: 10, prizes: 1, startBps: 350, capBps: 25000, copy: 'One prize. Ten bombs. Sharp teeth.' },
};

function usdcUnits(value) {
  const clean = String(value || '0').trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) return '0';
  const [whole, fraction = ''] = clean.split('.');
  return (BigInt(whole || '0') * USDC_DECIMALS + BigInt((fraction + '000000').slice(0, 6))).toString();
}

function formatUsdc(units) {
  const value = BigInt(units || '0');
  const whole = value / USDC_DECIMALS;
  const fraction = String(value % USDC_DECIMALS).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function revealCostUnits(prizePot, difficulty, revealIndex) {
  const config = DIFFICULTIES[difficulty];
  const board = 64n;
  const baseTotal = BigInt(config.startBps) * board;
  const cap = BigInt(config.capBps);
  const step = cap > baseTotal ? ((cap - baseTotal) * 2n) / (board * (board - 1n)) : 0n;
  const bps = BigInt(config.startBps) + step * BigInt(revealIndex);
  return ((BigInt(prizePot || '0') * bps) / 10000n).toString();
}

function makeBoard(difficulty, seed) {
  const config = DIFFICULTIES[difficulty];
  let state = Array.from(`${seed}:${difficulty}`).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  const used = new Set();
  const pick = () => { do { state = (state * 1664525 + 1013904223) >>> 0; } while (used.has(state % 64)); const tile = state % 64; used.add(tile); return tile; };
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
async function getJson(path) { const response = await fetch(`${API}${path}`); if (!response.ok) throw new Error(await response.text()); return response.json(); }
function getWalletProvider() { if (!window.ethereum) throw new Error('No wallet found. Install a supported wallet first.'); return window.ethereum; }
function shortAddress(address) { return !address || /^0x0{40}$/i.test(address) ? '' : `${address.slice(0, 6)}…${address.slice(-4)}`; }

function RulesModal({ onClose }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title">
    <section className="rules-modal">
      <button className="icon-button close" type="button" aria-label="Close rules" onClick={onClose}>×</button>
      <img src={chancyLogo} alt="" />
      <p className="kicker">Chancy in 20 seconds</p>
      <h2 id="rules-title">Find prizes before your third bomb.</h2>
      <div className="rule-list">
        <p><strong>Pick a host room.</strong> One player runs a session at a time.</p>
        <p><strong>Reveal tiles.</strong> Each hidden tile shows the next reveal cost before you click.</p>
        <p><strong>Exit on your terms.</strong> Prize tiles accrue rewards. Three bombs ends the run.</p>
      </div>
      <button className="main-button full" type="button" onClick={onClose}>Got it</button>
    </section>
  </div>;
}

export default function App() {
  const [view, setView] = useState('landing');
  const [health, setHealth] = useState('checking');
  const [difficulty, setDifficulty] = useState('Normal');
  const [prizePotUsdc, setPrizePotUsdc] = useState('25');
  const [sessionId, setSessionId] = useState('1');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));
  const [board, setBoard] = useState(() => makeBoard('Normal', 'chancy'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [run, setRun] = useState({ role: '', bombs: 0, prizes: 0, active: false, ended: false, message: 'Create or join a session to reveal a board.' });
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
  const selectedAsset = CHAIN_CONFIG[chainId]?.usdc || BASE_USDC_ADDRESS;
  const prizePot = usdcUnits(prizePotUsdc);
  const revealCount = revealed.filter((tile) => tile !== TILE_HIDDEN).length;
  const nextRevealCost = revealCostUnits(prizePot, difficulty, revealCount);
  const walletLabel = wallet ? shortAddress(wallet) : 'Connect wallet';

  function closeRules() { localStorage.setItem('chancy_rules_seen', '1'); setShowRules(false); }
  async function connectWallet() { setError(''); try { const provider = getWalletProvider(); const accounts = await provider.request({ method: 'eth_requestAccounts' }); const nextChainId = await provider.request({ method: 'eth_chainId' }); setWallet(accounts[0] || ''); setChainId(nextChainId); setLastAction('Wallet connected'); } catch (err) { setError(err.message || String(err)); } }
  function openSessions() { setError(''); setView('sessions'); setLastAction('Session console ready'); }

  async function createSession() {
    setError('');
    try {
      await postJson('/tx/create-session', { asset: selectedAsset, difficulty, prizePot });
      setBoard(makeBoard(difficulty, wallet || `host-${sessionId}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'host', bombs: 0, prizes: 0, active: false, ended: false, message: 'Room created. Host view only — hosts cannot play their own session.' });
      setView('room'); setLastAction('Create-session transaction ready');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function joinSession() {
    setError('');
    try {
      await postJson('/tx/join-session', { sessionId, userRandomNumber: DEFAULT_RANDOM, entropyFee: '0' });
      setBoard(makeBoard(difficulty, wallet || `player-${sessionId}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'player', bombs: 0, prizes: 0, active: true, ended: false, message: 'You joined. Reveal tiles carefully.' });
      setView('room'); setLastAction('Join-session transaction ready');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function claimRewards() { setError(''); try { await postJson('/tx/claim-rewards', { asset: selectedAsset }); setLastAction('Claim transaction ready'); } catch (err) { setError(err.message || String(err)); } }
  async function quitSession() { setError(''); try { await postJson('/tx/quit-session', { sessionId }); setRun({ ...run, active: false, ended: true, message: 'Quit transaction ready. Host receives your spent reveal costs.' }); setLastAction('Quit transaction ready'); } catch (err) { setError(err.message || String(err)); } }
  async function kickIdlePlayer() { setError(''); try { await postJson('/tx/kick-idle-player', { sessionId }); setLastAction('Idle-kick transaction ready'); } catch (err) { setError(err.message || String(err)); } }
  function revealTile(tile) {
    if (run.role !== 'player' || !run.active || run.ended || revealed[tile] !== TILE_HIDDEN) return;
    const outcome = board[tile];
    const nextRevealed = [...revealed]; nextRevealed[tile] = outcome;
    const bombs = run.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = run.prizes + (outcome === 'prize' ? 1 : 0);
    const ended = bombs >= 3;
    const message = ended ? 'Run ended. 3 bombs hit.' : outcome === 'prize' ? 'Prize found. Keep hunting or claim.' : outcome === 'bomb' ? 'Bomb hit. Stay sharp.' : 'Safe tile.';
    setRevealed(nextRevealed); setRun({ ...run, bombs, prizes, ended, active: !ended, message });
    postJson('/tx/click-tile', { sessionId, tileIndex: tile }).then(() => setLastAction('Click-tile transaction ready')).catch(() => {});
  }

  return <main className="product-shell">
    {showRules && <RulesModal onClose={closeRules} />}
    <button className="help-button" type="button" aria-label="How Chancy works" onClick={() => setShowRules(true)}>?</button>
    <header className="topbar"><button className="brand" type="button" onClick={() => setView('landing')}><img src={chancyLogo} alt="Chancy logo" /><span>Chancy</span></button><nav className="top-actions" aria-label="Main actions"><button className="text-link" type="button" onClick={openSessions}>Sessions</button><button className="text-link" type="button" onClick={() => setShowRules(true)}>Rules</button><button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button></nav></header>

    {view === 'landing' && <><section className="landing-hero"><div className="hero-copy"><p className="kicker">Prize rooms</p><h1>Pick a room. Reveal tiles. Dodge the third bomb.</h1><p className="lede">Chancy is a simple risk game: join one host-funded room, uncover your private board, and claim prizes before the bombs end your run.</p><div className="hero-buttons"><button className="main-button large" type="button" onClick={openSessions}>Browse sessions</button><button className="ghost-button large" type="button" onClick={() => setShowRules(true)}>How it works</button></div></div><div className="hero-visual" aria-label="Chancy game preview"><img src={chancyLogo} alt="" /><span>3 bombs ends the run</span></div></section><section className="info-grid" aria-label="Game guide"><div><strong>1. Choose a room</strong><span>Sessions are host-funded and accept one active player at a time.</span></div><div><strong>2. Reveal with USDC</strong><span>Every hidden tile shows its next reveal cost before you click.</span></div><div><strong>3. Claim prizes</strong><span>Prize tiles accrue rewards. Quit, claim, or risk the third bomb.</span></div></section><section className="landing-guide"><div><p className="kicker">Game aspects</p><h2>Fast decisions, clear math, private boards.</h2></div><div className="guide-list"><p><strong>No fake rooms.</strong> Mainnet shows real sessions only; use the console to create or enter a room ID.</p><p><strong>Hosts fund the pot.</strong> Hosts create rooms but cannot play their own room.</p><p><strong>Progressive cost.</strong> Reveal costs rise through the run, so waiting too long has teeth.</p></div></section></>}

    {view === 'sessions' && <section className="sessions-page"><div className="page-head"><p className="kicker">Session console</p><h1>Create or join a real room.</h1><p className="lede">No fake active sessions, fren. Until the indexer is connected, enter a known room ID or create a new host-funded room.</p></div><div className="sessions-layout"><div className="session-list"><article className="empty-state"><h2>No indexed sessions yet.</h2><p>After deployment, this area should be fed by a real indexer or contract reads. For now, use the controls beside it.</p><button className="ghost-button" type="button" onClick={kickIdlePlayer}>Kick idle player in entered room</button></article></div><aside className="create-card"><h2>Room controls</h2><div className="fields"><label>Difficulty<select aria-label="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option>Easy</option><option>Normal</option><option>Hardcore</option></select><small>{DIFFICULTIES[difficulty].copy}</small></label><label>Prize pot USDC<input aria-label="prize pot usdc" inputMode="decimal" value={prizePotUsdc} onChange={(event) => setPrizePotUsdc(event.target.value)} /></label><label>Room ID<input aria-label="session id" inputMode="numeric" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label></div><div className="stat-list"><div><span>First reveal</span><strong>{formatUsdc(revealCostUnits(prizePot, difficulty, 0))} USDC</strong></div><div><span>Mode</span><strong>{DIFFICULTIES[difficulty].bombs} bombs · {DIFFICULTIES[difficulty].prizes} prizes</strong></div></div><button className="main-button full" type="button" onClick={createSession}>Create room</button><button className="ghost-button full" type="button" onClick={joinSession}>Join entered room</button></aside></div></section>}

    {view === 'room' && <section className="room-page"><div className="room-header"><button className="ghost-button" type="button" onClick={openSessions}>Back to sessions</button><div><p className="kicker">Room #{sessionId}</p><h1>{run.role === 'host' ? 'Host view' : 'Your board'}</h1></div></div><div className="room-layout"><section className={`board-card ${run.role === 'host' ? 'locked' : ''}`}><div className="meter-row"><div><span>Bombs</span><strong>{run.bombs}/3</strong></div><div><span>Prizes</span><strong>{run.prizes}</strong></div><div><span>Next reveal</span><strong>{formatUsdc(nextRevealCost)} USDC</strong></div></div><p className="status-line">{run.message}</p><div className="tile-board" aria-label="Chancy 8x8 board">{tiles.map((tile) => <button key={tile} aria-label={`tile ${tile}`} className={`tile ${revealed[tile]}`} onClick={() => revealTile(tile)}>{revealed[tile] === 'hidden' ? formatUsdc(nextRevealCost) : revealed[tile] === 'bomb' ? '×' : revealed[tile] === 'prize' ? '$' : '·'}</button>)}</div></section><aside className="run-card"><h2>{run.role === 'host' ? 'Room is live' : 'Run details'}</h2><div className="stat-list"><div><span>Prize pot</span><strong>{prizePotUsdc} USDC</strong></div><div><span>Mode</span><strong>{difficulty}</strong></div><div><span>Active player</span><strong>{run.role === 'player' ? 'You' : 'Waiting'}</strong></div></div>{run.role === 'host' ? <p className="note">Host cannot play. Share the room ID after the create transaction lands.</p> : <><button className="main-button full" type="button" onClick={claimRewards}>Claim USDC</button><button className="ghost-button full" type="button" onClick={quitSession}>Quit run</button></>}</aside></div></section>}

    <footer className="app-footer"><span>{health === 'online' ? 'Game API online' : 'Game API offline'}</span><span>{CHAIN_CONFIG[chainId]?.label || 'Base'}</span><span>{lastAction}</span>{error && <strong className="error-text">{error}</strong>}</footer>
  </main>;
}
