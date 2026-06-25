import React, { useCallback, useEffect, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const USDC_DECIMALS = 1_000_000n;
const BOMB_LIVES = 3;
const TILES = Array.from({ length: 64 }, (_, i) => i + 1);

const MODES = {
  Easy:     { bombs: 5,  prizes: 3, copy: '5 bombs · 3 prizes' },
  Normal:   { bombs: 7,  prizes: 2, copy: '7 bombs · 2 prizes' },
  Hardcore: { bombs: 10, prizes: 1, copy: '10 bombs · 1 prize' },
};

const POT_PRESETS = ['5', '10', '25', '50'];

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
          <div className="rule-text"><strong>Add credits</strong><span>Send USDC to your deposit address. Credits appear in seconds.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon blue">◉</div>
          <div className="rule-text"><strong>Host or join</strong><span>Hosts lock a pot. Players pay $0.05 to join and reveal tiles.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon green">★</div>
          <div className="rule-text"><strong>Find all prizes</strong><span>Tiles cost more as you go. Collect every prize to sweep the pot.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon red">✺</div>
          <div className="rule-text"><strong>Dodge bombs</strong><span>Three bombs ends your run. Quit anytime to keep what you found.</span></div>
        </div>
        <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 16 }}>Got it</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────
export default function App({ wallet }) {
  const { open: openModal, isConnected, address } = wallet;

  // view: splash (pre-connect) | lobby (main hub) | host | deposit | round
  const [view, setView] = useState('splash');
  const [online, setOnline] = useState(null);
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));

  // Credits
  const [balance, setBalance] = useState('0');
  const [withdrawable, setWithdrawable] = useState('0');

  // Deposit
  const [vaultAddress, setVaultAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [pollingDeposit, setPollingDeposit] = useState(false);
  const [preDepositBalance, setPreDepositBalance] = useState('0');

  // Lobby
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Host
  const [hostMode, setHostMode] = useState('Normal');
  const [potAmt, setPotAmt] = useState('10');

  // Round
  const [session, setSession] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [run, setRun] = useState({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });

  // Withdraw
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmt, setWithdrawAmt] = useState('');

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  const addr = address || '';
  const modeCfg = session ? MODES[session.mode] : MODES.Normal;

  // ── Health + config ──
  useEffect(() => {
    getJson('/health').then(() => setOnline(true)).catch(() => setOnline(false));
    getJson('/v2/config').then((cfg) => {
      if (cfg.vaultAddress) setVaultAddress(cfg.vaultAddress);
    }).catch(() => {});
  }, []);

  // ── Auto-switch to lobby when connected ──
  useEffect(() => {
    if (isConnected && address) {
      setView((prev) => prev === 'splash' ? 'lobby' : prev);
    }
  }, [isConnected, address]);

  const refreshCredits = useCallback(async (a) => {
    const player = a || addr;
    if (!player) return '0';
    try {
      const d = await getJson(`/v2/credits/${player}`);
      setBalance(d.balance || '0');
      setWithdrawable(d.withdrawable || '0');
      return d.balance || '0';
    } catch { return '0'; }
  }, [addr]);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const d = await getJson('/v2/sessions');
      setSessions(d.sessions || []);
    } catch { /* silent */ }
    setSessionsLoading(false);
  }, []);

  useEffect(() => {
    if (view === 'lobby') refreshSessions();
  }, [view, refreshSessions]);

  useEffect(() => { if (addr) refreshCredits(addr); }, [addr, refreshCredits]);

  function closeRules() { localStorage.setItem('chancy_rules_seen', '1'); setShowRules(false); }

  function connectWallet() { openModal(); }

  // ── DEPOSIT ──
  async function copyVaultAddress() {
    try {
      await navigator.clipboard.writeText(vaultAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed — long-press to copy manually');
    }
  }

  async function openWalletSend() {
    if (!isConnected) { openModal(); return; }
    try {
      const provider = wallet.walletProvider;
      if (!provider) { await copyVaultAddress(); setPollingDeposit(true); return; }
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: addr, to: vaultAddress, value: '0x0' }],
      });
      setPollingDeposit(true);
    } catch (err) {
      if (err.code !== 4001) { await copyVaultAddress(); setStatusMsg('Address copied — send from your wallet'); setPollingDeposit(true); }
    }
  }

  useEffect(() => {
    if (!pollingDeposit || !addr) return;
    const interval = setInterval(async () => {
      const bal = await refreshCredits(addr);
      if (BigInt(bal) > BigInt(preDepositBalance)) {
        setPollingDeposit(false);
        setStatusMsg(`+${dollars((BigInt(bal) - BigInt(preDepositBalance)).toString())} added`);
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [pollingDeposit, addr, preDepositBalance, refreshCredits]);

  // ── HOST: CREATE ──
  async function hostCreateSession() {
    setError('');
    const pot = usdcUnits(potAmt);
    if (BigInt(pot) < 5_000_000n) { setError('Minimum pot is $5.'); return; }
    if (BigInt(pot) > BigInt(balance)) { setError('Not enough credits.'); return; }
    setBusy(true); setStatusMsg('Creating game…');
    try {
      const result = await postJson('/v2/sessions/create', { host: addr, mode: hostMode, prizePot: pot });
      await refreshCredits(addr);
      setStatusMsg(`Game #${result.sessionId} live`);
      setView('lobby');
      await refreshSessions();
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── HOST: CLOSE ──
  async function closeSession(sessionId) {
    if (!addr) return;
    setBusy(true);
    try {
      await postJson(`/v2/sessions/${sessionId}/close`, { host: addr });
      await refreshCredits(addr);
      await refreshSessions();
      setStatusMsg('Game closed — pot reclaimed');
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: JOIN + REVEAL ──
  async function joinSession(sess) {
    setError('');
    if (BigInt(balance) < BigInt(sess.entranceFee)) {
      setError(`Need ${dollars(sess.entranceFee)} to join.`); return;
    }
    setBusy(true); setStatusMsg('Joining…');
    try {
      const entropy = randomEntropy();
      const salt = randomEntropy();
      const commitment = await sha256Hex(entropy, salt);
      await postJson(`/v2/sessions/${sess.sessionId}/join`, { player: addr, commitment });
      setStatusMsg('Shuffling…');
      await postJson(`/v2/sessions/${sess.sessionId}/reveal`, { player: addr, entropy, salt });
      setSession({ sessionId: sess.sessionId, mode: sess.mode, prizePot: sess.prizePot });
      setRevealed({});
      setRun({ bombsHit: 0, prizesFound: 0, status: 'active', spentTotal: '0', prizeEarned: '0', nextTileCost: sess.firstTileCost || '0' });
      setView('round');
      setStatusMsg('');
      await refreshCredits(addr);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── PLAYER: CLICK ──
  async function clickTile(tile) {
    if (!session || run.status !== 'active' || revealed[tile] || busy) return;
    setBusy(true);
    try {
      const result = await postJson(`/v2/sessions/${session.sessionId}/click`, { player: addr, tile });
      setRevealed((prev) => ({ ...prev, [result.tile]: result.outcome }));
      setRun({
        bombsHit: result.bombsHit, prizesFound: result.prizesFound,
        status: result.status, spentTotal: result.spentTotal || '0',
        prizeEarned: result.prizeEarned || '0', nextTileCost: result.nextTileCost || '0',
      });
      if (result.status === 'won') { setStatusMsg(`Won ${dollars(result.prizeEarned)}!`); await refreshCredits(addr); }
      else if (result.status === 'lost') { setStatusMsg('Game over — 3 bombs'); }
      else if (result.outcome === 'prize') { setStatusMsg('Prize!'); }
      else if (result.outcome === 'bomb') { setStatusMsg(`Bomb — ${result.bombsHit}/3`); }
      else { setStatusMsg('Empty'); }
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: QUIT ──
  async function quitRound() {
    if (!session) { setView('lobby'); return; }
    setBusy(true);
    try {
      if (run.status === 'active') {
        const final = await postJson(`/v2/sessions/${session.sessionId}/quit`, { player: addr });
        if (final.board) {
          const full = {};
          (final.board.bombPositions || []).forEach((t) => { full[t] = 'bomb'; });
          (final.board.prizePositions || []).forEach((t) => { full[t] = 'prize'; });
          setRevealed((prev) => ({ ...full, ...prev }));
        }
      }
      await refreshCredits(addr);
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
    if (BigInt(amount) <= 0n) { setError('Enter an amount.'); return; }
    if (BigInt(amount) > BigInt(withdrawable)) { setError('Exceeds withdrawable.'); return; }
    setBusy(true); setStatusMsg('Requesting…');
    try {
      const result = await postJson('/v2/withdrawals/request', { player: addr, amount, destination: addr });
      setWithdrawAmt('');
      setShowWithdraw(false);
      await refreshCredits(addr);
      setStatusMsg(`${dollars(result.payoutAmount)} → your wallet`);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── Derived ──
  const lives = BOMB_LIVES - run.bombsHit;
  const isPlaying = view === 'round' && session && run.status === 'active';
  const gameEnded = run.status === 'won' || run.status === 'lost';

  function goHome() {
    if (!isPlaying) {
      setSession(null); setStatusMsg(''); setError('');
      setView('lobby');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="app">
      {view !== 'splash' && (
        <header className="header">
          <button className="brand" onClick={goHome}>
            <img src={chancyLogo} alt="" /> Chancy
          </button>
          <div className={`balance-pill ${online === false ? 'offline' : ''}`} onClick={addr ? goHome : undefined}>
            <span className="dot" />
            {addr ? dollars(balance) : '—'}
          </div>
        </header>
      )}

      {error && <div className="error-banner" style={{ marginBottom: 12 }} onClick={() => setError('')}>{error}</div>}

      {/* ═══ SPLASH ═══ */}
      {view === 'splash' && (
        <div className="splash">
          <img className="hero-logo" src={chancyLogo} alt="Chancy" />
          <h1>Host a game.<br/>Beat the board.<br/><span className="gold">Win the pot.</span></h1>
          <p className="tagline">Player-funded prize pots. Pay per tile, dodge bombs, collect every prize to sweep the pot.</p>
          <button className="btn btn-primary" onClick={connectWallet}>Connect wallet →</button>
          <button className="btn btn-ghost" onClick={() => setShowRules(true)}>How to play</button>
        </div>
      )}

      {/* ═══ LOBBY ═══ */}
      {view === 'lobby' && isConnected && (
        <div className="lobby-view">
          <div className="credit-card">
            <div className="credit-top">
              <div className="credit-big">
                <span className="label">Credits</span>
                <span className="value gold">{dollars(balance)}</span>
              </div>
              {BigInt(withdrawable) > 0n && (
                <div className="credit-side">
                  <span className="label">Withdrawable</span>
                  <span className="value green small">{dollars(withdrawable)}</span>
                </div>
              )}
            </div>
            <div className="credit-actions-simple">
              <button className="btn btn-primary btn-sm" onClick={() => { setPreDepositBalance(balance); setView('deposit'); }}>+ Add credits</button>
              {BigInt(withdrawable) > 0n && <button className="btn btn-ghost btn-sm" onClick={() => setShowWithdraw(true)}>Withdraw</button>}
            </div>
          </div>

          <div className="lobby-section-header">
            <span className="section-title">Open games</span>
            <button className="refresh-icon" onClick={refreshSessions} disabled={sessionsLoading}>{sessionsLoading ? '⋯' : '↻'}</button>
          </div>

          {sessions.length === 0 ? (
            <div className="empty-state">
              <p>No open games yet.</p>
              <button className="btn btn-primary btn-sm" onClick={() => setView('host')}>Host the first game</button>
            </div>
          ) : (
            <div className="game-list">
              {sessions.map((s) => (
                <div key={s.sessionId} className={`game-card mode-${s.mode.toLowerCase()}`}>
                  <div className="game-card-top">
                    <span className="game-mode-badge">{s.mode}</span>
                    <span className="game-pot">{dollars(s.prizePot)}</span>
                  </div>
                  <div className="game-card-mid">
                    <span>{MODES[s.mode]?.copy}</span>
                    <span className="dim">First tile {dollars(s.firstTileCost)} · Entry {dollars(s.entranceFee)}</span>
                  </div>
                  {s.host.toLowerCase() === addr.toLowerCase() ? (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => closeSession(s.sessionId)}>Close & refund</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => joinSession(s)}>Join · {dollars(s.entranceFee)}</button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="bottom-bar">
            <button className="btn btn-secondary" onClick={() => setView('host')}>+ Host a game</button>
          </div>
          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ HOST ═══ */}
      {view === 'host' && isConnected && (
        <div className="host-view">
          <div className="lobby-section-header">
            <button className="back-btn" onClick={() => setView('lobby')}>← Back</button>
            <span className="section-title" style={{ margin: 0 }}>Host a game</span>
          </div>
          <div className="host-balance">
            <span>You have</span>
            <span className="value gold">{dollars(balance)}</span>
          </div>
          <div className="section-title">Difficulty</div>
          <div className="mode-selector">
            {Object.entries(MODES).map(([name, cfg]) => (
              <button key={name} className={`mode-tab ${hostMode === name ? 'selected' : ''}`} onClick={() => setHostMode(name)}>
                <span className="tab-name">{name}</span>
                <span className="tab-sub">{cfg.copy}</span>
              </button>
            ))}
          </div>
          <div className="section-title">Prize pot</div>
          <div className="pot-input-group">
            <span className="pot-prefix">$</span>
            <input value={potAmt} onChange={(e) => setPotAmt(e.target.value)} placeholder="10" inputMode="decimal" />
          </div>
          <div className="pot-presets">
            {POT_PRESETS.map((p) => (
              <button key={p} className={`preset-chip ${potAmt === p ? 'selected' : ''}`} onClick={() => setPotAmt(p)}>${p}</button>
            ))}
          </div>
          <button className="btn btn-primary" disabled={busy || BigInt(usdcUnits(potAmt)) > BigInt(balance)} onClick={hostCreateSession}>
            {busy ? 'Creating…' : `Create game — ${dollars(usdcUnits(potAmt))}`}
          </button>
          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ DEPOSIT ═══ */}
      {view === 'deposit' && isConnected && (
        <div className="deposit-view">
          <div className="lobby-section-header">
            <button className="back-btn" onClick={() => { setPollingDeposit(false); setView('lobby'); }}>← Back</button>
            <span className="section-title" style={{ margin: 0 }}>Add credits</span>
          </div>
          <p className="view-sub">Send USDC (Base) to this address. Credits appear automatically. No approval needed.</p>
          {vaultAddress && (
            <div className="qr-section">
              <img className="qr-code" src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(vaultAddress)}`} alt="Deposit QR" />
            </div>
          )}
          <div className="vault-address-card" onClick={copyVaultAddress}>
            <div className="vault-label">Deposit address</div>
            <div className="vault-address">{vaultAddress || 'Loading…'}</div>
            <div className="vault-copy-hint">{copied ? '✓ Copied' : 'Tap to copy'}</div>
          </div>
          <div className="deposit-actions">
            {isConnected && <button className="btn btn-primary" onClick={openWalletSend}>Send from wallet</button>}
            <button className="btn btn-secondary" onClick={() => { copyVaultAddress(); setPollingDeposit(true); }}>{copied ? '✓ Copied' : 'Copy address'}</button>
          </div>
          {pollingDeposit ? (
            <div className="deposit-polling">
              <div className="pulse-dot" />
              <span>Waiting for deposit…</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPollingDeposit(false)}>Cancel</button>
            </div>
          ) : statusMsg ? (
            <div className="deposit-success">{statusMsg}</div>
          ) : null}
          <div className="deposit-balance">
            <span className="label">Balance</span>
            <span className="value gold">{dollars(balance)}</span>
          </div>
          <p className="fee-note">5% fee · 1:1 with USDC</p>
        </div>
      )}

      {/* ═══ ROUND ═══ */}
      {view === 'round' && session && (
        <div className="round-view">
          <div className="round-header">
            <button className="back-btn" onClick={quitRound}>← {gameEnded ? 'Done' : 'Quit'}</button>
            <span className="mode-badge">{session.mode}</span>
          </div>
          <div className="meters">
            <div className="meter pot"><span className="meter-label">Pot</span><span className="meter-value">{dollars(session.prizePot)}</span></div>
            <div className="meter prizes"><span className="meter-label">Prizes</span><span className="meter-value">{run.prizesFound}/{modeCfg.prizes}</span></div>
            <div className="meter spent"><span className="meter-label">Spent</span><span className="meter-value">{dollars(run.spentTotal)}</span></div>
          </div>
          <div className="bomb-lives">
            {Array.from({ length: BOMB_LIVES }).map((_, i) => (
              <div key={i} className={`bomb-life ${i >= lives ? 'lost' : ''}`} />
            ))}
          </div>
          {isPlaying && (
            <div className="next-cost-hint">Next tile: <strong className="gold">{dollars(run.nextTileCost)}</strong></div>
          )}
          <div className="board">
            {TILES.map((tile) => {
              const state = revealed[tile];
              const symbol = state === 'prize' ? '★' : state === 'bomb' ? '✺' : '';
              return (
                <button key={tile} className={`tile ${state || ''}`} disabled={!!state || run.status !== 'active' || busy} onClick={() => clickTile(tile)}>{symbol}</button>
              );
            })}
          </div>
          {statusMsg && !gameEnded && <p className="status-text">{statusMsg}</p>}
          {gameEnded && (
            <div className={`result-banner ${run.status === 'won' ? 'win' : 'lose'}`}>
              <span className="result-title">{run.status === 'won' ? 'Pot won!' : 'Game over'}</span>
              {run.status === 'won' ? (
                <>
                  <span className="result-amount">{dollars(run.prizeEarned)}</span>
                  <span className="result-sub">Credited to balance</span>
                </>
              ) : (
                <span className="result-sub">{dollars(run.spentTotal)} lost to host</span>
              )}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={quitRound}>Back to games →</button>
            </div>
          )}
        </div>
      )}

      {/* ── Withdraw modal ── */}
      {showWithdraw && (
        <div className="modal-backdrop" onClick={() => setShowWithdraw(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-handle" />
            <h2>Withdraw</h2>
            <p className="modal-sub">Send credits back to your wallet. 5% fee applies.</p>
            <div className="pot-input-group" style={{ marginBottom: 8 }}>
              <span className="pot-prefix">$</span>
              <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} placeholder={formatUsdc(withdrawable)} inputMode="decimal" />
            </div>
            <p className="hint-text">Withdrawable: {dollars(withdrawable)}</p>
            <button className="btn btn-primary" disabled={busy} onClick={requestWithdrawal}>{busy ? 'Processing…' : 'Withdraw'}</button>
            <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowWithdraw(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Help FAB ── */}
      {view !== 'splash' && <button className="help-fab" onClick={() => setShowRules(true)}>?</button>}
      {showRules && <RulesSheet onClose={closeRules} />}
    </div>
  );
}
