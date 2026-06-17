import React, { useEffect, useMemo, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BASE_CHAIN_ID = '0x2105';
const USDC_DECIMALS = 1_000_000n;
const TILE_HIDDEN = 'hidden';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const CHAIN_CONFIG = { [BASE_CHAIN_ID]: { label: 'Base', usdc: BASE_USDC_ADDRESS } };
const DIFFICULTIES = {
  Easy: { bombs: 5, prizes: 3, startBps: 150, capBps: 15000, copy: '5 bombs on the board, 3 prize tiles. Third bomb still ends the run.' },
  Normal: { bombs: 7, prizes: 2, startBps: 250, capBps: 20000, copy: '7 bombs on the board, 2 prize tiles. Balanced risk.' },
  Hardcore: { bombs: 10, prizes: 1, startBps: 350, capBps: 25000, copy: '10 bombs on the board, 1 prize tile. Sharp teeth.' },
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
        <p><strong>Difficulty changes the board.</strong> Easy has 5 bombs and 3 prizes. Normal has 7 bombs and 2 prizes. Hardcore has 10 bombs and 1 prize.</p>
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
  const [sessionId, setSessionId] = useState('');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));
  const [board, setBoard] = useState(() => makeBoard('Normal', 'chancy'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [run, setRun] = useState({ role: '', bombs: 0, prizes: 0, active: false, ended: false, message: 'Choose player or host to begin.' });
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
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
  const mode = DIFFICULTIES[difficulty];

  function closeRules() { localStorage.setItem('chancy_rules_seen', '1'); setShowRules(false); }
  async function connectWallet() { setError(''); try { const provider = getWalletProvider(); const accounts = await provider.request({ method: 'eth_requestAccounts' }); const nextChainId = await provider.request({ method: 'eth_chainId' }); setWallet(accounts[0] || ''); setChainId(nextChainId); setLastAction('Wallet connected'); return accounts[0] || ''; } catch (err) { setError(err.message || String(err)); return ''; } }
  async function sendBuiltTransaction(payload) {
    const provider = getWalletProvider();
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const from = accounts[0];
    const txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: payload.to, data: payload.data, value: `0x${BigInt(payload.value || '0').toString(16)}` }] });
    setWallet(from || '');
    return txHash;
  }
  async function openPlayerSessions() {
    setError('');
    setView('player');
    setSessionsLoading(true);
    try {
      const data = await getJson('/data/sessions?limit=24');
      setSessions(data.sessions || []);
      setLastAction(data.sessions?.length ? 'Rooms loaded' : 'No rooms open');
    } catch (err) {
      setError(err.message || String(err));
      setLastAction('Session discovery failed');
    } finally {
      setSessionsLoading(false);
    }
  }

  async function createSession() {
    setError('');
    try {
      setLastAction('Opening wallet approval');
      await sendBuiltTransaction(await postJson('/tx/approve-usdc', { asset: selectedAsset, amount: prizePot }));
      setLastAction('Opening wallet to create room');
      await sendBuiltTransaction(await postJson('/tx/create-session', { asset: selectedAsset, difficulty, prizePot }));
      setSessionId('pending');
      setBoard(makeBoard(difficulty, wallet || `host-${Date.now()}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'host', bombs: 0, prizes: 0, active: false, ended: false, message: 'Room creation sent. It will appear in the lobby after confirmation.' });
      setView('room'); setLastAction('Room creation sent');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function joinSession(session) {
    if (!session) return;
    setError('');
    try {
      const nextId = session.sessionId;
      const nextDifficulty = session.difficulty || difficulty;
      const nextPrizePot = session.asset?.toLowerCase() === selectedAsset.toLowerCase() ? formatUsdc(session.prizePot) : prizePotUsdc;
      setSessionId(nextId);
      setDifficulty(nextDifficulty);
      setPrizePotUsdc(nextPrizePot);
      const fee = await getJson('/data/entropy-fee');
      await sendBuiltTransaction(await postJson('/tx/join-session', { sessionId: nextId, userRandomNumber: DEFAULT_RANDOM, entropyFee: fee.fee }));
      setBoard(makeBoard(nextDifficulty, wallet || `player-${nextId}`));
      setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
      setRun({ role: 'player', bombs: 0, prizes: 0, active: true, ended: false, message: 'You joined. Reveal tiles carefully.' });
      setView('room'); setLastAction('Join sent');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function claimRewards() { setError(''); try { await sendBuiltTransaction(await postJson('/tx/claim-rewards', { asset: selectedAsset })); setLastAction('Claim sent'); } catch (err) { setError(err.message || String(err)); } }
  async function quitSession() { setError(''); try { await sendBuiltTransaction(await postJson('/tx/quit-session', { sessionId })); setRun({ ...run, active: false, ended: true, message: 'Quit sent. Your run is ending.' }); setLastAction('Quit sent'); } catch (err) { setError(err.message || String(err)); } }
  function revealTile(tile) {
    if (run.role !== 'player' || !run.active || run.ended || revealed[tile] !== TILE_HIDDEN) return;
    const outcome = board[tile];
    const nextRevealed = [...revealed]; nextRevealed[tile] = outcome;
    const bombs = run.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = run.prizes + (outcome === 'prize' ? 1 : 0);
    const ended = bombs >= 3;
    const message = ended ? 'Run ended. 3 bombs hit.' : outcome === 'prize' ? 'Prize found. Keep hunting or claim.' : outcome === 'bomb' ? 'Bomb hit. Stay sharp.' : 'Safe tile.';
    setRevealed(nextRevealed); setRun({ ...run, bombs, prizes, ended, active: !ended, message });
    postJson('/tx/approve-usdc', { asset: selectedAsset, amount: nextRevealCost })
      .then((approve) => sendBuiltTransaction(approve))
      .then(() => postJson('/tx/click-tile', { sessionId, tileIndex: tile }))
      .then((click) => sendBuiltTransaction(click))
      .then(() => setLastAction('Reveal sent'))
      .catch((err) => setError(err.message || String(err)));
  }

  const WalletPanel = () => <aside className="wallet-panel">
    <div>
      <h2>Connect wallet</h2>
      <p>Connect wallet to manage your rooms.</p>
    </div>
    <button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button>
  </aside>;

  return <main className="product-shell">
    {showRules && <RulesModal onClose={closeRules} />}
    <button className="help-button" type="button" aria-label="How Chancy works" onClick={() => setShowRules(true)}>?</button>
    <header className="topbar">
      <button className="brand" type="button" onClick={() => setView('landing')}><img src={chancyLogo} alt="Chancy logo" /><span>Chancy</span></button>
      <nav className="top-actions" aria-label="Main actions">
        <button className="text-link" type="button" onClick={() => setView('role')}>Play</button>
        <button className="text-link" type="button" onClick={() => setShowRules(true)}>Rules</button>
        <button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button>
      </nav>
    </header>

    {view === 'landing' && <>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="kicker">Onchain risk rooms</p>
          <h1>One game. Two paths: play or host.</h1>
          <p className="lede">Chancy is a simple Base game: hosts fund prize rooms, players reveal private boards, and the third bomb ends the run.</p>
          <div className="hero-buttons">
            <button className="main-button large" type="button" onClick={() => setView('role')}>Play</button>
            <button className="ghost-button large" type="button" onClick={() => setShowRules(true)}>How it works</button>
          </div>
        </div>
        <div className="hero-visual" aria-label="Chancy game preview"><img src={chancyLogo} alt="" /><span>3 bombs ends the run</span></div>
      </section>
      <section className="mode-grid" aria-label="Difficulty modes">
        {Object.entries(DIFFICULTIES).map(([name, config]) => <article key={name}>
          <strong>{name}</strong>
          <span>{config.bombs} bombs · {config.prizes} prize{config.prizes === 1 ? '' : 's'}</span>
        </article>)}
      </section>
      <section className="landing-guide">
        <div><p className="kicker">Game flow</p><h2>Clear roles before any room action.</h2></div>
        <div className="guide-list">
          <p><strong>Players browse rooms.</strong> Pick an open room, connect wallet, and reveal tiles.</p>
          <p><strong>Hosts create rooms.</strong> Choose difficulty and prize pot. The contract assigns the room ID automatically.</p>
          <p><strong>Difficulty matters.</strong> Easy has fewer bombs and more prizes. Hardcore has more bombs and one prize.</p>
        </div>
      </section>
    </>}

    {view === 'role' && <section className="role-page">
      <div className="page-head"><p className="kicker">Choose your side</p><h1>Play a room or host one.</h1><p className="lede">Join an open room to hunt prizes, or host one and put up the prize pot.</p></div>
      <div className="role-grid">
        <article className="choice-card"><span>As player</span><h2>Browse open rooms.</h2><p>Join a host-funded room, reveal your private board, and claim before the third bomb.</p><button className="main-button full" type="button" onClick={openPlayerSessions}>Continue as player</button></article>
        <article className="choice-card"><span>As host</span><h2>Create a prize room.</h2><p>Pick difficulty, set the USDC prize pot, and open the room for players.</p><button className="ghost-button full" type="button" onClick={() => setView('host')}>Continue as host</button></article>
        <WalletPanel />
      </div>
    </section>}

    {view === 'player' && <section className="sessions-page">
      <div className="page-head"><p className="kicker">Player lobby</p><h1>Choose an open room.</h1><p className="lede">Pick a room, reveal tiles, and cash out before the third bomb ends your run.</p></div>
      <div className="session-list">
        {sessionsLoading && <article className="empty-state"><h2>Loading sessions…</h2><p>Reading the latest Chancy rooms from Base.</p></article>}
        {!sessionsLoading && sessions.length === 0 && <article className="empty-state"><h2>No open rooms yet.</h2><p>There are no host-funded rooms to join right now. Come back later or switch to host mode and create one.</p><button className="ghost-button" type="button" onClick={() => setView('host')}>Create a room as host</button></article>}
        {!sessionsLoading && sessions.map((session) => <article className="session-card" key={session.sessionId}>
          <div><strong>Room #{session.sessionId}</strong><span>{session.open ? session.activePlayer === ZERO_ADDRESS ? 'Open' : 'Occupied' : 'Closed'}</span></div>
          <div><span>Difficulty</span><strong>{session.difficulty}</strong></div>
          <div><span>Prize pot</span><strong>{formatUsdc(session.prizePot)} USDC</strong></div>
          <div><span>Bombs</span><strong>{session.bombCount}</strong></div>
          <div><span>Prizes</span><strong>{session.prizeCount}</strong></div>
          <button className="main-button" type="button" disabled={!session.open || session.activePlayer !== ZERO_ADDRESS} onClick={() => joinSession(session)}>Join room</button>
        </article>)}
      </div>
    </section>}

    {view === 'host' && <section className="host-page">
      <div className="page-head"><p className="kicker">Host room</p><h1>Create a prize room.</h1><p className="lede">Choose the difficulty, set the prize pot, and open the room for the next player.</p></div>
      <div className="host-layout">
        <aside className="create-card"><h2>Room setup</h2><div className="fields"><label>Difficulty<select aria-label="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option>Easy</option><option>Normal</option><option>Hardcore</option></select><small>{mode.copy}</small></label><label>Prize pot USDC<input aria-label="prize pot usdc" inputMode="decimal" value={prizePotUsdc} onChange={(event) => setPrizePotUsdc(event.target.value)} /></label></div><button className="main-button full" type="button" onClick={createSession}>Create room</button><p className="note">Players will see the room in the lobby after it opens.</p></aside>
        <WalletPanel />
      </div>
    </section>}

    {view === 'room' && <section className="room-page">
      <div className="room-header"><button className="ghost-button" type="button" onClick={run.role === 'host' ? () => setView('host') : openPlayerSessions}>Back</button><div><p className="kicker">{sessionId === 'pending' ? 'Room pending' : `Room #${sessionId}`}</p><h1>{run.role === 'host' ? 'Host view' : 'Your board'}</h1></div></div>
      <div className="room-layout"><section className={`board-card ${run.role === 'host' ? 'locked' : ''}`}><div className="meter-row"><div><span>Bombs hit</span><strong>{run.bombs}/3</strong></div><div><span>Bombs hidden</span><strong>{mode.bombs}</strong></div><div><span>Next reveal</span><strong>{formatUsdc(nextRevealCost)} USDC</strong></div></div><p className="status-line">{run.message}</p><div className="tile-board" aria-label="Chancy 8x8 board">{tiles.map((tile) => <button key={tile} aria-label={`tile ${tile}`} className={`tile ${revealed[tile]}`} onClick={() => revealTile(tile)}>{revealed[tile] === 'hidden' ? formatUsdc(nextRevealCost) : revealed[tile] === 'bomb' ? '×' : revealed[tile] === 'prize' ? '$' : '·'}</button>)}</div></section><aside className="run-card"><h2>{run.role === 'host' ? 'Room is waiting' : 'Run details'}</h2><div className="stat-list"><div><span>Prize pot</span><strong>{prizePotUsdc} USDC</strong></div><div><span>Mode</span><strong>{difficulty}: {mode.bombs} bombs / {mode.prizes} prize{mode.prizes === 1 ? '' : 's'}</strong></div><div><span>Player</span><strong>{run.role === 'player' ? 'You' : 'Waiting'}</strong></div></div>{run.role === 'host' ? <p className="note">Host cannot play this room. Wait for a player to join.</p> : <><button className="main-button full" type="button" onClick={claimRewards}>Claim USDC</button><button className="ghost-button full" type="button" onClick={quitSession}>Quit run</button></>}</aside></div>
    </section>}

    <footer className="app-footer"><span>{health === 'online' ? 'Chancy live' : 'Chancy unavailable'}</span><span>{CHAIN_CONFIG[chainId]?.label || 'Base'}</span><span>{lastAction}</span>{error && <strong className="error-text">{error}</strong>}</footer>
  </main>;
}
