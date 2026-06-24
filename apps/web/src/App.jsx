import React, { useCallback, useEffect, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const API = import.meta.env?.VITE_CHANCY_API_URL || '';

// Base mainnet (VPS is configured for mainnet)
const BASE_CHAIN_ID = '0x2105';
const TARGET_CHAIN_ID = BASE_CHAIN_ID;

const USDC_DECIMALS = 1_000_000n;
const BOMB_LIVES = 3;
const TILES = Array.from({ length: 64 }, (_, i) => i + 1);

const CHAIN_PARAMS = {
  [BASE_CHAIN_ID]: {
    chainId: BASE_CHAIN_ID, chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
};

// Modes — must match backend modeConfig exactly
const MODES = {
  Easy:     { bombs: 5,  prizes: 3, copy: '5 bombs · 3 prizes' },
  Normal:   { bombs: 7,  prizes: 2, copy: '7 bombs · 2 prizes' },
  Hardcore: { bombs: 10, prizes: 1, copy: '10 bombs · 1 prize' },
};

// ─── UTILS ──────────────────────────────────────────────────────────────────
function formatUsdc(units) {
  const value = BigInt(units || '0');
  const whole = value / USDC_DECIMALS;
  const fraction = String(value % USDC_DECIMALS).padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function usdcUnits(value) {
  const clean = String(value || '0').trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) return '0';
  const [whole, fraction = ''] = clean.split('.');
  return (BigInt(whole || '0') * USDC_DECIMALS + BigInt((fraction + '000000').slice(0, 6))).toString();
}
function dollars(units) { return `$${formatUsdc(units)}`; }

function randomEntropy() {
  const bytes = new Uint8Array(32);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(entropy, salt) {
  const data = `${entropy}:${salt}`;
  const bytes = new TextEncoder().encode(data);
  return crypto.subtle.digest('SHA-256', bytes).then((buf) =>
    '0x' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data;
}
async function getJson(path) {
  const res = await fetch(`${API}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
  return data;
}

function getWalletProvider() {
  if (!window.ethereum) throw new Error('No wallet found. Install a supported wallet first.');
  return window.ethereum;
}
function shortAddr(a) { return !a || /^0x0{40}$/i.test(a) ? '—' : `${a.slice(0, 6)}…${a.slice(-4)}`; }

// ─── RULES MODAL ────────────────────────────────────────────────────────────
function RulesSheet({ onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-handle" />
        <h2>How to play</h2>
        <p className="modal-sub">Hosts fund prize pots. Players pay per tile. Find all prizes to win the pot.</p>
        <div className="rule-item">
          <div className="rule-icon gold">$</div>
          <div className="rule-text"><strong>Add credits</strong><span>Deposit once → play instantly. No pop-ups mid-game.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon blue">◉</div>
          <div className="rule-text"><strong>Host a game</strong><span>Lock a prize pot. Earn when players fail. Close anytime to reclaim.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon green">★</div>
          <div className="rule-text"><strong>Play & reveal</strong><span>Pay $0.05 to join. Tiles cost more as you reveal more. Find all prizes → win the pot.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon red">✺</div>
          <div className="rule-text"><strong>Dodge bombs</strong><span>Three bombs ends your run. Quit anytime to keep prizes earned.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon gold">↗</div>
          <div className="rule-text"><strong>Cash out</strong><span>Withdraw credits to your wallet whenever you want.</span></div>
        </div>
        <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 16 }}>Got it</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('landing'); // landing | lobby | round | host
  const [online, setOnline] = useState(null);
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));

  // Wallet / credits
  const [balance, setBalance] = useState('0');
  const [withdrawable, setWithdrawable] = useState('0');
  const [depositAmt, setDepositAmt] = useState('10');
  const [withdrawAmt, setWithdrawAmt] = useState('');

  // Lobby state
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState('Normal');

  // Host state
  const [hostMode, setHostMode] = useState('Normal');
  const [potAmt, setPotAmt] = useState('10');

  // Active round state
  const [session, setSession] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [run, setRun] = useState({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  const modeCfg = MODES[mode] || MODES.Normal;

  // ── Health check ──
  useEffect(() => {
    getJson('/health').then(() => setOnline(true)).catch(() => setOnline(false));
  }, []);

  // ── Wallet events ──
  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccts = (a) => setWallet(a?.[0] || '');
    const onChain = (c) => setChainId(c || '');
    window.ethereum.request({ method: 'eth_accounts' }).then(onAccts).catch(() => {});
    window.ethereum.request({ method: 'eth_chainId' }).then(onChain).catch(() => {});
    window.ethereum.on?.('accountsChanged', onAccts);
    window.ethereum.on?.('chainChanged', onChain);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', onAccts);
      window.ethereum.removeListener?.('chainChanged', onChain);
    };
  }, []);

  const refreshCredits = useCallback(async (addr) => {
    const player = addr || wallet;
    if (!player) return '0';
    try {
      const d = await getJson(`/v2/credits/${player}`);
      setBalance(d.balance || '0');
      setWithdrawable(d.withdrawable || '0');
      return d.balance || '0';
    } catch { return '0'; }
  }, [wallet]);

  const refreshSessions = useCallback(async () => {
    try {
      const d = await getJson('/v2/sessions');
      setSessions(d.sessions || []);
      return d.sessions || [];
    } catch { return []; }
  }, []);

  useEffect(() => { if (wallet) refreshCredits(wallet); }, [wallet, refreshCredits]);

  function closeRules() { localStorage.setItem('chancy_rules_seen', '1'); setShowRules(false); }

  async function ensureChain(provider) {
    const current = await provider.request({ method: 'eth_chainId' });
    if (current?.toLowerCase() === TARGET_CHAIN_ID) return;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_ID }] });
    } catch (err) {
      if (err?.code === 4902 && CHAIN_PARAMS[TARGET_CHAIN_ID]) {
        await provider.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[TARGET_CHAIN_ID]] });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_ID }] });
      } else throw err;
    }
    setChainId(TARGET_CHAIN_ID);
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accts = await provider.request({ method: 'eth_requestAccounts' });
      const next = accts[0] || '';
      setWallet(next);
      await ensureChain(provider);
      return next;
    } catch (err) {
      setError(err.message || String(err));
      return '';
    }
  }

  // ── DEPOSIT ──
  async function depositCredits() {
    setError('');
    const amount = usdcUnits(depositAmt);
    if (BigInt(amount) <= 0n) { setError('Enter an amount to add.'); return; }
    setBusy(true); setStatusMsg('Adding credits…');
    try {
      const provider = getWalletProvider();
      const player = wallet || await connectWallet();
      if (!player) return;
      await ensureChain(provider);
      setStatusMsg('Approving…');
      const approveTx = await postJson('/v2/tx/approve-usdc', { amount });
      await provider.request({ method: 'eth_sendTransaction', params: [{ from: player, to: approveTx.to, data: approveTx.data, value: approveTx.value || '0x0' }] });
      setStatusMsg('Depositing…');
      const depositTx = await postJson('/v2/tx/deposit', { amount });
      const txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: player, to: depositTx.to, data: depositTx.data, value: depositTx.value || '0x0' }] });
      setStatusMsg('Confirming…');
      const credit = await postJson('/v2/credits/deposit', { player, txHash });
      setBalance(credit.balance || '0');
      await refreshCredits(player);
      setStatusMsg(`Credits added — ${dollars(credit.balance || '0')}`);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── HOST: CREATE SESSION ──
  async function hostCreateSession() {
    setError('');
    const player = wallet || await connectWallet();
    if (!player) return;
    const pot = usdcUnits(potAmt);
    if (BigInt(pot) < 5_000_000n) { setError('Prize pot must be at least $5.'); return; }
    setBusy(true); setStatusMsg('Creating game…');
    try {
      const result = await postJson('/v2/sessions/create', { host: player, mode: hostMode, prizePot: pot });
      await refreshCredits(player);
      setStatusMsg(`Game #${result.sessionId} live — ${dollars(result.prizePot)} pot`);
      setView('lobby');
      await refreshSessions();
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── HOST: CLOSE SESSION ──
  async function closeSession(sessionId) {
    setError('');
    if (!wallet) return;
    setBusy(true);
    try {
      await postJson(`/v2/sessions/${sessionId}/close`, { host: wallet });
      await refreshCredits(wallet);
      await refreshSessions();
      setStatusMsg('Game closed — pot reclaimed');
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: JOIN + REVEAL ──
  async function joinSession(sess) {
    setError('');
    const player = wallet || await connectWallet();
    if (!player) return;
    if (BigInt(balance) < BigInt(sess.entranceFee)) {
      setError(`Need at least ${dollars(sess.entranceFee)} to join. Add credits first.`);
      return;
    }
    setBusy(true); setStatusMsg('Joining game…');
    try {
      const entropy = randomEntropy();
      const salt = randomEntropy();
      const commitment = await sha256Hex(entropy, salt);
      await postJson(`/v2/sessions/${sess.sessionId}/join`, { player, commitment });
      setStatusMsg('Shuffling tiles…');
      const revealed = await postJson(`/v2/sessions/${sess.sessionId}/reveal`, { player, entropy, salt });
      setSession({ sessionId: sess.sessionId, mode: sess.mode, prizePot: sess.prizePot });
      setRevealed({});
      setRun({ bombsHit: 0, prizesFound: 0, status: 'active', spentTotal: '0', prizeEarned: '0', nextTileCost: sess.firstTileCost || '0' });
      setView('round');
      setStatusMsg('');
      await refreshCredits(player);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── PLAYER: CLICK TILE ──
  async function clickTile(tile) {
    if (!session || run.status !== 'active' || revealed[tile] || busy) return;
    setBusy(true);
    try {
      const result = await postJson(`/v2/sessions/${session.sessionId}/click`, { player: wallet, tile });
      setRevealed((prev) => ({ ...prev, [result.tile]: result.outcome }));
      setRun({
        bombsHit: result.bombsHit, prizesFound: result.prizesFound,
        status: result.status, spentTotal: result.spentTotal || '0',
        prizeEarned: result.prizeEarned || '0', nextTileCost: result.nextTileCost || '0',
      });
      if (result.status === 'won') { setStatusMsg(`Won ${dollars(result.prizeEarned)}!`); await refreshCredits(wallet); }
      else if (result.status === 'lost') { setStatusMsg('Game over — 3 bombs'); }
      else if (result.outcome === 'prize') { setStatusMsg('Prize found!'); }
      else if (result.outcome === 'bomb') { setStatusMsg(`Bomb — ${result.bombsHit}/3`); }
      else { setStatusMsg('Empty tile'); }
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: QUIT ROUND ──
  async function quitRound() {
    if (!session) { setView('lobby'); return; }
    setError('');
    setBusy(true);
    try {
      if (run.status === 'active') {
        const final = await postJson(`/v2/sessions/${session.sessionId}/quit`, { player: wallet });
        if (final.board) {
          const full = {};
          (final.board.bombPositions || []).forEach((t) => { full[t] = 'bomb'; });
          (final.board.prizePositions || []).forEach((t) => { full[t] = 'prize'; });
          setRevealed((prev) => ({ ...full, ...prev }));
        }
      }
      await refreshCredits(wallet);
      setSession(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setView('lobby');
      setStatusMsg('');
      await refreshSessions();
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  // ── WITHDRAW ──
  async function requestWithdrawal() {
    setError('');
    const amount = usdcUnits(withdrawAmt);
    if (BigInt(amount) <= 0n) { setError('Enter an amount to cash out.'); return; }
    if (BigInt(amount) > BigInt(withdrawable)) { setError('Amount exceeds withdrawable credits.'); return; }
    setBusy(true); setStatusMsg('Cashing out…');
    try {
      const player = wallet || await connectWallet();
      if (!player) return;
      const result = await postJson('/v2/withdrawals/request', { player, amount, destination: player });
      setWithdrawAmt('');
      await refreshCredits(player);
      setStatusMsg(`Cash-out requested — ${dollars(result.payoutAmount)} heading to your wallet.`);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── Derived ──
  const lives = BOMB_LIVES - run.bombsHit;
  const isPlaying = view === 'round' && session && run.status === 'active';
  const gameEnded = run.status === 'won' || run.status === 'lost';
  const wrongChain = chainId && chainId.toLowerCase() !== TARGET_CHAIN_ID;

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <button className="brand" onClick={() => { if (!isPlaying) setView('landing'); }}>
          <img src={chancyLogo} alt="" /> Chancy
        </button>
        <div className={`balance-pill ${online === false ? 'offline' : ''}`}>
          <span className="dot" />
          {wallet ? dollars(balance) : 'Not connected'}
        </div>
      </header>

      {/* ── Wrong chain banner ── */}
      {wrongChain && (
        <div className="error-banner" style={{ marginBottom: 12 }} onClick={() => wallet && connectWallet()}>
          ⚠ Wrong network — tap to switch to Base
        </div>
      )}

      {/* ── Error ── */}
      {error && <div className="error-banner" style={{ marginBottom: 12 }} onClick={() => setError('')}>{error}</div>}

      {/* ═══ LANDING ═══ */}
      {view === 'landing' && (
        <div className="landing">
          <img className="hero-logo" src={chancyLogo} alt="Chancy" />
          <h1>Host a game.<br/>Beat the board.<br/><span className="gold">Win the pot.</span></h1>
          <p className="tagline">Player-funded prize pots. Pay per tile, dodge bombs, collect every prize to sweep the pot. Cash out anytime.</p>

          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setView('lobby')}>
              {wallet ? 'Browse games' : 'Connect & play'} →
            </button>
            <button className="btn btn-secondary" onClick={() => setView('host')}>
              Host a game
            </button>
          </div>

          <div className="mode-preview">
            {Object.entries(MODES).map(([name, cfg]) => (
              <div key={name} className="mode-card">
                <div className="info">
                  <span className="name">{name}</span>
                  <span className="desc">{cfg.copy}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ LOBBY (browse + play) ═══ */}
      {view === 'lobby' && (
        <div className="lobby-view">
          <div className="lobby-header">
            <button className="back-btn" onClick={() => setView('landing')}>← Back</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setView('host')}>+ Host</button>
          </div>

          {/* Wallet / Credits */}
          {!wallet && (
            <div className="wallet-bar">
              <div className="wallet-info">
                <span className="wallet-label">Wallet</span>
                <span className="wallet-addr">Not connected</span>
              </div>
              <button className="btn btn-primary btn-sm" onClick={connectWallet}>Connect</button>
            </div>
          )}

          {wallet && (
            <div className="credit-card">
              <div className="credit-top">
                <div className="credit-big">
                  <span className="label">Credits</span>
                  <span className="value gold">{dollars(balance)}</span>
                </div>
                <div className="credit-side">
                  <span className="label">Withdrawable</span>
                  <span className="value green small">{dollars(withdrawable)}</span>
                </div>
              </div>
              <div className="credit-actions">
                <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} placeholder="10" inputMode="decimal" className="credit-input" />
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={depositCredits}>Add</button>
                <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} placeholder={formatUsdc(withdrawable)} inputMode="decimal" className="credit-input" />
                <button className="btn btn-ghost btn-sm" disabled={busy || BigInt(withdrawable) <= 0n} onClick={requestWithdrawal}>Withdraw</button>
              </div>
            </div>
          )}

          {/* Open games list */}
          <div className="section-title">Open games</div>
          <button className="refresh-btn" onClick={refreshSessions}>↻ Refresh</button>
          {sessions.length === 0 ? (
            <div className="empty-state">
              <p>No open games right now.</p>
              <button className="btn btn-secondary btn-sm" onClick={() => setView('host')}>Host the first game</button>
            </div>
          ) : (
            <div className="game-list">
              {sessions.map((s) => (
                <div key={s.sessionId} className={`game-card mode-${s.mode.toLowerCase()}`}>
                  <div className="game-card-top">
                    <span className="game-mode-badge">{s.mode}</span>
                    <span className="game-pot">{dollars(s.prizePot)} pot</span>
                  </div>
                  <div className="game-card-info">
                    <span>{MODES[s.mode]?.copy || s.mode}</span>
                    <span className="dim">First tile {dollars(s.firstTileCost)}</span>
                    <span className="dim">Entry {dollars(s.entranceFee)}</span>
                  </div>
                  {s.host.toLowerCase() === wallet?.toLowerCase() ? (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => closeSession(s.sessionId)}>Close & refund</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={busy || !wallet} onClick={() => joinSession(s)}>Join — {dollars(s.entranceFee)}</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ HOST VIEW ═══ */}
      {view === 'host' && (
        <div className="host-view">
          <div className="lobby-header">
            <button className="back-btn" onClick={() => setView('lobby')}>← Back</button>
          </div>

          <h2 className="view-title">Host a game</h2>
          <p className="view-sub">Lock a prize pot from your credits. Players pay to reveal tiles. You earn when they fail. Close anytime to reclaim.</p>

          {/* Mode selector */}
          <div className="section-title">Difficulty</div>
          <div className="mode-selector">
            {Object.entries(MODES).map(([name, cfg]) => (
              <button key={name} className={`mode-tab ${hostMode === name ? 'selected' : ''}`} onClick={() => setHostMode(name)}>
                <span className="tab-name">{name}</span>
                <span className="tab-sub">{cfg.copy}</span>
              </button>
            ))}
          </div>

          {/* Pot input */}
          <div className="section-title">Prize pot</div>
          <div className="pot-input-group">
            <span className="pot-prefix">$</span>
            <input value={potAmt} onChange={(e) => setPotAmt(e.target.value)} placeholder="10" inputMode="decimal" />
          </div>
          <p className="hint-text">Minimum $5 · {wallet ? `You have ${dollars(balance)}` : 'Connect wallet first'}</p>

          <button className="btn btn-primary" disabled={busy || !wallet || BigInt(usdcUnits(potAmt)) > BigInt(balance)} onClick={hostCreateSession}>
            {wallet ? `Create game — ${dollars(usdcUnits(potAmt))}` : 'Connect wallet'}
          </button>

          {!wallet && (
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={connectWallet}>Connect wallet</button>
          )}

          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ ROUND (active game) ═══ */}
      {view === 'round' && session && (
        <div className="round-view">
          <div className="round-header">
            <button className="back-btn" onClick={quitRound}>← {gameEnded ? 'Done' : 'Quit'}</button>
            <span className="mode-badge">{session.mode}</span>
          </div>

          {/* Pot + cost meters */}
          <div className="meters">
            <div className="meter pot">
              <span className="meter-label">Pot</span>
              <span className="meter-value">{dollars(session.prizePot)}</span>
            </div>
            <div className="meter prizes">
              <span className="meter-label">Prizes</span>
              <span className="meter-value">{run.prizesFound}/{modeCfg.prizes}</span>
            </div>
            <div className="meter spent">
              <span className="meter-label">Spent</span>
              <span className="meter-value">{dollars(run.spentTotal)}</span>
            </div>
          </div>

          {/* Bomb lives */}
          <div className="bomb-lives">
            {Array.from({ length: BOMB_LIVES }).map((_, i) => (
              <div key={i} className={`bomb-life ${i >= lives ? 'lost' : ''}`} />
            ))}
          </div>

          {/* Next tile cost hint */}
          {isPlaying && (
            <div className="next-cost-hint">
              Next tile: <strong className="gold">{dollars(run.nextTileCost)}</strong>
            </div>
          )}

          {/* Board */}
          <div className="board">
            {TILES.map((tile) => {
              const state = revealed[tile];
              const symbol = state === 'prize' ? '★' : state === 'bomb' ? '✺' : '';
              return (
                <button
                  key={tile}
                  className={`tile ${state || ''}`}
                  disabled={!!state || run.status !== 'active' || busy}
                  onClick={() => clickTile(tile)}
                >{symbol}</button>
              );
            })}
          </div>

          {/* Status */}
          {statusMsg && !gameEnded && <p className="status-text">{statusMsg}</p>}

          {/* Result banner */}
          {gameEnded && (
            <div className={`result-banner ${run.status === 'won' ? 'win' : 'lose'}`}>
              <span className="result-title">{run.status === 'won' ? 'Pot won!' : 'Game over'}</span>
              {run.status === 'won' ? (
                <>
                  <span className="result-amount">{dollars(run.prizeEarned)}</span>
                  <span className="result-sub">Credited to your balance</span>
                </>
              ) : (
                <span className="result-sub">Three bombs. {dollars(run.spentTotal)} lost to the host.</span>
              )}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={quitRound}>
                Back to lobby →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Help FAB ── */}
      <button className="help-fab" onClick={() => setShowRules(true)}>?</button>

      {/* ── Rules sheet ── */}
      {showRules && <RulesSheet onClose={closeRules} />}
    </div>
  );
}
