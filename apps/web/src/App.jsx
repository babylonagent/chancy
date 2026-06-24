import React, { useCallback, useEffect, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS || '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

const BASE_CHAIN_ID = '0x2105';
const BASE_SEPOLIA_CHAIN_ID = '0x14a34';
const TARGET_CHAIN_ID = (import.meta.env?.VITE_CHANCY_CHAIN_ID || BASE_SEPOLIA_CHAIN_ID).toLowerCase();

const USDC_DECIMALS = 1_000_000n;
const STAKE_UNITS = '50000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const GAME_HOST = import.meta.env?.VITE_CHANCY_GAME_HOST || '';

const CHAIN_PARAMS = {
  [BASE_CHAIN_ID]: { chainId: BASE_CHAIN_ID, chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  [BASE_SEPOLIA_CHAIN_ID]: { chainId: BASE_SEPOLIA_CHAIN_ID, chainName: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
};

const MODES = {
  Easy:     { bombs: 3, prizes: 5, multiplier: '2.5', copy: '3 bombs · 5 prizes' },
  Normal:   { bombs: 5, prizes: 3, multiplier: '5.3', copy: '5 bombs · 3 prizes' },
  Hardcore: { bombs: 9, prizes: 2, multiplier: '8.7', copy: '9 bombs · 2 prizes' },
};

const TILES = Array.from({ length: 64 }, (_, i) => i + 1);
const BOMB_LIVES = 3;

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
function sha256Hex(entropy, salt) {
  const data = `${entropy}:${salt}`;
  const bytes = new TextEncoder().encode(data);
  return crypto.subtle.digest('SHA-256', bytes).then((buf) => '0x' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function getJson(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function getWalletProvider() {
  if (!window.ethereum) throw new Error('No wallet found. Install a supported wallet first.');
  return window.ethereum;
}
function shortAddr(a) { return !a || /^0x0{40}$/i.test(a) ? '' : `${a.slice(0, 6)}…${a.slice(-4)}`; }

// ─── Rules Modal (bottom sheet) ─────────────────────────────────────────────
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
        <p className="modal-sub">Tap tiles, dodge bombs, collect all prizes to win.</p>
        <div className="rule-item">
          <div className="rule-icon gold">$</div>
          <div className="rule-text"><strong>Add credits once</strong><span>Top up and play as many rounds as you want — no pop-ups mid-game.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon green">★</div>
          <div className="rule-text"><strong>Find the prizes</strong><span>Each round is $0.05. Reveal tiles one at a time. Collect every prize to win.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon red">✺</div>
          <div className="rule-text"><strong>Dodge the bombs</strong><span>Three bombs ends the round. Choose your risk — bigger bombs, bigger payouts.</span></div>
        </div>
        <div className="rule-item">
          <div className="rule-icon gold">↗</div>
          <div className="rule-text"><strong>Cash out anytime</strong><span>Withdraw your credits to your wallet whenever you want.</span></div>
        </div>
        <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 16 }}>Got it</button>
      </div>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState('landing');
  const [online, setOnline] = useState(null);
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));

  const [mode, setMode] = useState('Normal');
  const [depositAmt, setDepositAmt] = useState('5');
  const [withdrawAmt, setWithdrawAmt] = useState('');

  const [balance, setBalance] = useState('0');
  const [withdrawable, setWithdrawable] = useState('0');

  const [session, setSession] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [run, setRun] = useState({ bombsHit: 0, prizesCollected: 0, status: 'idle', payout: '0' });

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');

  const host = GAME_HOST || wallet || ZERO_ADDRESS;
  const modeCfg = MODES[mode];
  const potentialWin = (BigInt(STAKE_UNITS) * BigInt(Math.round(parseFloat(modeCfg.multiplier) * 10)) / 10n).toString();

  // ── Health check (silent) ──
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

  async function startRound() {
    setError('');
    const player = wallet || await connectWallet();
    if (!player) return;
    const freshBal = await refreshCredits(player);
    if (BigInt(freshBal) < BigInt(STAKE_UNITS)) { setError('Not enough credits — add at least $0.05.'); return; }
    setBusy(true); setStatusMsg('Starting round…');
    try {
      const entropy = randomEntropy();
      const salt = randomEntropy();
      const commitment = await sha256Hex(entropy, salt);
      const created = await postJson('/v2/sessions', { player, host: host === ZERO_ADDRESS ? player : host, mode, stake: STAKE_UNITS, commitment });
      await postJson(`/v2/sessions/${created.sessionId}/reveal`, { player, entropy, salt });
      setSession({ sessionId: created.sessionId, mode });
      setRevealed({});
      setRun({ bombsHit: 0, prizesCollected: 0, status: 'active', payout: '0' });
      setView('round');
      setStatusMsg('');
      await refreshCredits(player);
    } catch (err) {
      setError(err.message || String(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  async function clickTile(tile) {
    if (!session || run.status !== 'active' || revealed[tile] || busy) return;
    setBusy(true);
    try {
      const result = await postJson(`/v2/sessions/${session.sessionId}/click`, { player: wallet, tile });
      setRevealed((prev) => ({ ...prev, [result.tile]: result.outcome }));
      setRun({ bombsHit: result.bombsHit, prizesCollected: result.prizesCollected, status: result.status, payout: result.payout });
      if (result.status === 'won') { setStatusMsg(`Won ${dollars(result.payout)}!`); await refreshCredits(wallet); }
      else if (result.status === 'lost') { setStatusMsg('Round over — 3 bombs'); }
      else if (result.outcome === 'prize') { setStatusMsg('Prize found!'); }
      else if (result.outcome === 'bomb') { setStatusMsg(`Bomb — ${result.bombsHit}/3`); }
      else { setStatusMsg('Empty tile'); }
    } catch (err) {
      setError(err.message || String(err));
    } finally { setBusy(false); }
  }

  async function endRound() {
    if (session) {
      try {
        const final = await postJson(`/v2/sessions/${session.sessionId}/exit`, { player: wallet });
        if (final.board) {
          const full = {};
          (final.board.bombPositions || []).forEach((t) => { full[t] = 'bomb'; });
          (final.board.prizePositions || []).forEach((t) => { full[t] = 'prize'; });
          setRevealed((prev) => ({ ...full, ...prev }));
        }
      } catch { /* best-effort */ }
    }
    await refreshCredits(wallet);
    setSession(null);
    setView('play');
    setStatusMsg('');
  }

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

      {/* ── Error ── */}
      {error && <div className="error-banner" style={{ marginBottom: 16 }} onClick={() => setError('')}>{error}</div>}

      {/* ═══ LANDING ═══ */}
      {view === 'landing' && (
        <div className="landing">
          <img className="hero-logo" src={chancyLogo} alt="Chancy" />
          <h1>Tap tiles.<br/>Dodge bombs.<br/><span className="gold">Bank the prizes.</span></h1>
          <p className="tagline">Add credits once, play instantly. Every move is a single tap — no pop-ups, no waiting. Cash out whenever.</p>

          <div className="mode-preview">
            {Object.entries(MODES).map(([name, cfg]) => (
              <div key={name} className="mode-card" onClick={() => { setMode(name); setView('play'); }}>
                <div className="info">
                  <span className="name">{name}</span>
                  <span className="desc">{cfg.copy} · Win pays {cfg.multiplier}×</span>
                </div>
                <span className="mult">{cfg.multiplier}×</span>
              </div>
            ))}
          </div>

          <button className="btn btn-primary" onClick={() => setView('play')}>
            {wallet ? 'Play now' : 'Connect & play'} →
          </button>
        </div>
      )}

      {/* ═══ PLAY ═══ */}
      {view === 'play' && (
        <div className="play-view">
          {/* Mode selector */}
          <div className="section-title">Difficulty</div>
          <div className="mode-selector">
            {Object.entries(MODES).map(([name, cfg]) => (
              <button key={name} className={`mode-tab ${mode === name ? 'selected' : ''}`} onClick={() => setMode(name)}>
                <span className="tab-name">{name}</span>
                <span className="tab-mult">{cfg.multiplier}×</span>
              </button>
            ))}
          </div>

          {/* Mode detail */}
          <div className="mode-detail">
            <div className="left">
              <span className="bombs-prizes">{modeCfg.copy}</span>
              <span className="bombs-prizes">Win pays {modeCfg.multiplier}× your $0.05 stake</span>
            </div>
            <span className="payout-amount">{dollars(potentialWin)}</span>
          </div>

          {/* Wallet / Credits */}
          {!wallet && (
            <div className="wallet-bar">
              <div className="wallet-info">
                <span className="wallet-label">Wallet</span>
                <span className="wallet-addr">Not connected</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={connectWallet}>Connect</button>
            </div>
          )}

          {wallet && (
            <>
              <div className="credit-display">
                <div className="credit-row">
                  <span className="label">Credits</span>
                  <span className="value gold">{dollars(balance)}</span>
                </div>
                <div className="credit-row">
                  <span className="label">Withdrawable</span>
                  <span className="value green">{dollars(withdrawable)}</span>
                </div>
              </div>

              <div className="deposit-section">
                <div className="section-title">Add credits</div>
                <div className="input-group">
                  <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} placeholder="5" inputMode="decimal" />
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={depositCredits}>Add</button>
                </div>

                <div className="section-title" style={{ marginTop: 8 }}>Cash out</div>
                <div className="input-group">
                  <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} placeholder={formatUsdc(withdrawable)} inputMode="decimal" />
                  <button className="btn btn-ghost btn-sm" disabled={busy || BigInt(withdrawable) <= 0n} onClick={requestWithdrawal}>Withdraw</button>
                </div>
              </div>
            </>
          )}

          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ ROUND ═══ */}
      {view === 'round' && session && (
        <div className="round-view">
          <div className="round-header">
            <button className="back-btn" onClick={endRound}>← Exit</button>
            <span className="mode-badge">{session.mode}</span>
          </div>

          {/* Meters */}
          <div className="meters">
            <div className="meter prizes">
              <span className="meter-label">Prizes</span>
              <span className="meter-value">{run.prizesCollected}/{modeCfg.prizes}</span>
            </div>
            <div className="meter payout">
              <span className="meter-label">Win pays</span>
              <span className="meter-value">{dollars(potentialWin)}</span>
            </div>
          </div>

          {/* Bomb lives */}
          <div className="bomb-lives">
            {Array.from({ length: BOMB_LIVES }).map((_, i) => (
              <div key={i} className={`bomb-life ${i >= lives ? 'lost' : ''}`} />
            ))}
          </div>

          {/* Board */}
          <div className="board">
            {TILES.map((tile) => {
              const state = revealed[tile];
              const symbol = state === 'prize' ? '★' : state === 'bomb' ? '✺' : state === 'empty' ? '' : '';
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
              <span className="result-title">{run.status === 'won' ? 'You won!' : 'Round over'}</span>
              {run.status === 'won' ? (
                <>
                  <span className="result-amount">{dollars(run.payout)}</span>
                  <span className="result-sub">Credited to your balance</span>
                </>
              ) : (
                <span className="result-sub">Three bombs. Better luck next round.</span>
              )}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={endRound}>
                {run.status === 'won' ? 'Collect & play again' : 'Try again'} →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Bottom bar ── */}
      {view === 'play' && (
        <div className="bottom-bar">
          <button className="btn btn-primary" disabled={busy} onClick={startRound}>
            Play {mode} — $0.05
          </button>
        </div>
      )}

      {/* ── Help FAB ── */}
      <button className="help-fab" onClick={() => setShowRules(true)}>?</button>

      {/* ── Rules sheet ── */}
      {showRules && <RulesSheet onClose={closeRules} />}
    </div>
  );
}
