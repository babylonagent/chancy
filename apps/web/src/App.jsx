import React, { useCallback, useEffect, useState, useRef } from 'react';
import sfx from './sound';
import FloatingSprites from './FloatingSprites';
import chancyLogo from './assets/chancy-logo.svg';
import baseLogo from './assets/tech/base.svg';
import farcasterLogo from './assets/tech/farcaster.png';
import x402Logo from './assets/tech/x402.svg';
import pythLogo from './assets/tech/pyth.svg';
import usdcLogo from './assets/tech/usdc.svg';
import bombSprite from './assets/pixel/bomb-v1.png';
import gemSprite from './assets/pixel/gem-v1.png';
import questionSprite from './assets/pixel/question-v1.png';
import iconChain from './assets/pixel/icon-chain-v1.png';
import iconLock from './assets/pixel/icon-lock-v1.png';
import iconScroll from './assets/pixel/icon-scroll-v1.png';
import iconRobot from './assets/pixel/icon-robot-v1.png';
import iconBolt from './assets/pixel/icon-bolt-v1.png';
import iconPlug from './assets/pixel/icon-plug-v1.png';
import frameGold from './assets/pixel/frame-gold.png';
import frameDark from './assets/pixel/frame-dark.png';
import frameGreen from './assets/pixel/frame-green.png';
import frameRed from './assets/pixel/frame-red.png';
import btnGoldRaised from './assets/pixel/btn-gold-raised.png';
import btnGoldPressed from './assets/pixel/btn-gold-pressed.png';
import btnDarkRaised from './assets/pixel/btn-dark-raised.png';
import btnDarkPressed from './assets/pixel/btn-dark-pressed.png';
import btnGreenRaised from './assets/pixel/btn-green-raised.png';
import btnGreenPressed from './assets/pixel/btn-green-pressed.png';
import btnRedRaised from './assets/pixel/btn-red-raised.png';
import btnRedPressed from './assets/pixel/btn-red-pressed.png';

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

// ─── ERROR MAPPING ──────────────────────────────────────────────────────────
// Translate raw API error codes into player-friendly messages.
function friendlyError(err) {
  const msg = err?.message || String(err);
  const map = {
    INSUFFICIENT_CREDITS_FOR_REVEAL: 'Not enough credits for the next tile. Quit to keep what you found, or add more credits.',
    INSUFFICIENT_CREDITS: 'Not enough credits to do that.',
    SESSION_NOT_FOUND: 'This game no longer exists.',
    SESSION_NOT_OPEN: 'This game is already occupied or closed.',
    SESSION_NOT_ACTIVE: 'This game round has ended.',
    NOT_ACTIVE_PLAYER: 'You are not the active player in this game.',
    HOST_CANNOT_PLAY: 'You cannot play your own game.',
    ENTROPY_REQUEST_FAILED: 'Randomness service unavailable. Your credits were refunded — try again.',
    TOO_MANY_OPEN_SESSIONS: 'You have too many open games. Close one first.',
    PRIZE_POT_TOO_LOW: 'Minimum prize pot is $5.',
    PRIZE_POT_TOO_HIGH: 'Maximum prize pot is $1,000.',
    SESSION_NOT_COMMITTED: 'Game state mismatch. Please rejoin.',
    COMMITMENT_MISMATCH: 'Security check failed. Please rejoin.',
    INVALID_TILE: 'Invalid tile selection.',
  };
  for (const [code, friendly] of Object.entries(map)) {
    if (msg.includes(code)) return friendly;
  }
  return msg;
}

// ─── THEME ──────────────────────────────────────────────────────────────────
function getInitialTheme() {
  const saved = localStorage.getItem('chancy_theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}

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
        <button className="btn btn-primary" data-sfx-back onClick={onClose} style={{ marginTop: 16 }}>Got it</button>
      </div>
    </div>
  );
}

// ─── API DOCS MODAL ─────────────────────────────────────────────────────────
function ApiDocsSheet({ onClose }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal api-docs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-handle" />
        <h2>API &amp; Agents</h2>
        <p className="modal-sub">Chancy supports both human players (credit ledger) and AI agents (x402 pay-per-action).</p>

        <div className="api-section">
          <h3 className="api-h3">x402 Payment Flow</h3>
          <ol className="api-flow">
            <li>Agent calls an x402 endpoint &rarr; server returns HTTP 402 with payment requirements</li>
            <li>Agent signs EIP-3009 USDC transfer &rarr; retries with PAYMENT-SIGNATURE header</li>
            <li>Coinbase facilitator verifies &rarr; settles on-chain &rarr; game action executes</li>
            <li>No pre-funding, no API keys, no accounts</li>
          </ol>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Endpoints (x402 — pay per action)</h3>
          <div className="api-endpoints">
            <div className="api-endpoint"><span className="api-method free">GET</span><code>/v2/x402/sessions</code><span className="api-note">List open games (free)</span></div>
            <div className="api-endpoint"><span className="api-method paid">POST</span><code>/v2/x402/sessions/create</code><span className="api-note">Host a game (pays prize pot)</span></div>
            <div className="api-endpoint"><span className="api-method paid">POST</span><code>/v2/x402/sessions/:id/join</code><span className="api-note">Join a game (pays $0.05 entrance)</span></div>
            <div className="api-endpoint"><span className="api-method free">POST</span><code>/v2/x402/sessions/:id/reveal</code><span className="api-note">Reveal entropy (free)</span></div>
            <div className="api-endpoint"><span className="api-method paid">POST</span><code>/v2/x402/sessions/:id/click</code><span className="api-note">Reveal tile (pays tile cost)</span></div>
            <div className="api-endpoint"><span className="api-method free">POST</span><code>/v2/x402/sessions/:id/quit</code><span className="api-note">Quit game (free)</span></div>
          </div>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Contract Addresses (Base Mainnet)</h3>
          <div className="api-contracts">
            <div className="api-contract"><span className="api-contract-label">Vault</span><code>0xbE81cE9d9909A31184D1878075f60bbbf8571612</code></div>
            <div className="api-contract"><span className="api-contract-label">USDC</span><code>0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code></div>
            <div className="api-contract"><span className="api-contract-label">Randomness</span><code>0x705dF0f1667Ed82bB25E5a51273a9Ea6dE5C6e96</code></div>
          </div>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Quick Start (Python)</h3>
          <pre className="api-code-block">{`# Install: pip install eth-account web3 requests
# Run: python3 chancy_x402_client.py --key 0xYOUR_KEY --list
# Play: python3 chancy_x402_client.py --key 0xYOUR_KEY --play`}</pre>
        </div>

        <button className="btn btn-primary" data-sfx-back onClick={onClose} style={{ marginTop: 16 }}>Close</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────
export default function App({ wallet, farcaster }) {
  const { open: openModal, isConnected, address, disconnect } = wallet;
  const isFarcaster = !!farcaster;

  // view: splash (pre-connect) | lobby (main hub) | host | deposit | round
  const [view, setView] = useState('splash');
  const [online, setOnline] = useState(null);
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));
  const [showApiDocs, setShowApiDocs] = useState(false);

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
  const [withdrawSuccess, setWithdrawSuccess] = useState('');

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [quitting, setQuitting] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [muted, setMuted] = useState(true); // start muted

  const addr = address || '';
  const modeCfg = session ? MODES[session.mode] : MODES.Normal;

  // ── Theme management ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chancy_theme', theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => t === 'dark' ? 'light' : 'dark');
  }

  function toggleMute() {
    sfx.init();
    const newMuted = sfx.toggleMute();
    setMuted(newMuted);
    if (!newMuted) sfx.click();
  }

  // ── Global button click sound (excludes mute/theme toggles) ──
  useEffect(() => {
    function handleClick(e) {
      // Skip sound for mute/theme buttons — those are utility toggles, not game actions
      if (e.target.closest('[data-no-sfx]')) return;
      // Navigation/back/close buttons get a distinct descending sound
      if (e.target.closest('[data-sfx-back]')) {
        sfx.init();
        sfx.back();
        return;
      }
      if (e.target.closest('button, .balance-pill, .preset-chip, .mode-tab, .your-address-card, .vault-address-card, .tile, .help-fab')) {
        sfx.init();
        sfx.click();
      }
    }
    // Use capture phase so we fire BEFORE modal's stopPropagation blocks the event
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

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
    } else if (!isConnected) {
      // If user disconnects, return to splash (unless in active game)
      setView((prev) => prev === 'round' ? prev : 'splash');
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

  // ── Auto-poll sessions while in lobby (host sees player joins/finishes) ──
  useEffect(() => {
    if (view !== 'lobby') return;
    const interval = setInterval(() => refreshSessions(), 8000);
    return () => clearInterval(interval);
  }, [view, refreshSessions]);

  useEffect(() => { if (addr) refreshCredits(addr); }, [addr, refreshCredits]);

  // ── Auto-poll balance while on deposit page ──
  // Instead of only polling when user clicks "send", poll continuously on deposit view
  useEffect(() => {
    if (view !== 'deposit' || !addr) return;
    const interval = setInterval(async () => {
      const bal = await refreshCredits(addr);
      if (BigInt(bal) > BigInt(preDepositBalance)) {
        setPollingDeposit(false);
        setStatusMsg(`+${dollars((BigInt(bal) - BigInt(preDepositBalance)).toString())} added`);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [view, addr, preDepositBalance, refreshCredits]);

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
    // Optimistic: debit pot from balance immediately
    setBalance((prev) => {
      const newBal = BigInt(prev) - BigInt(pot);
      return newBal < 0n ? '0' : newBal.toString();
    });
    try {
      const result = await postJson('/v2/sessions/create', { host: addr, mode: hostMode, prizePot: pot });
      setStatusMsg(`Game #${result.sessionId} live`);
      setView('lobby');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Restore balance on failure
      setBalance((prev) => (BigInt(prev) + BigInt(pot)).toString());
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── HOST: CLOSE ──
  async function closeSession(sessionId) {
    if (!addr) return;
    setBusy(true);
    setStatusMsg('Closing game…');
    try {
      await postJson(`/v2/sessions/${sessionId}/close`, { host: addr });
      // Optimistic: refund the pot to balance immediately
      const sess = sessions.find((s) => s.sessionId === sessionId);
      if (sess) {
        setBalance((prev) => (BigInt(prev) + BigInt(sess.prizePot)).toString());
      }
      setStatusMsg('Game closed — pot reclaimed');
      setView('lobby');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Even on error, try to refresh — in-memory state may be correct
      await refreshCredits(addr);
      await refreshSessions();
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── PLAYER: JOIN + REVEAL ──
  async function joinSession(sess) {
    setError('');
    if (BigInt(balance) < BigInt(sess.entranceFee)) {
      setError(`Need ${dollars(sess.entranceFee)} to join.`); return;
    }
    setBusy(true); setStatusMsg('Joining…');
    // Optimistic: debit entrance fee immediately
    setBalance((prev) => {
      const newBal = BigInt(prev) - BigInt(sess.entranceFee);
      return newBal < 0n ? '0' : newBal.toString();
    });
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
      // Restore balance on failure
      setBalance((prev) => (BigInt(prev) + BigInt(sess.entranceFee)).toString());
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── PLAYER: CLICK ──
  async function clickTile(tile) {
    if (!session || run.status !== 'active' || revealed[tile] || busy) return;
    setBusy(true);
    // Haptic feedback in Farcaster Mini App
    if (isFarcaster && farcaster.sdk?.haptics) {
      farcaster.sdk.haptics.impact('light').catch(() => {});
    }
    // Optimistic: immediately show the tile as "revealing"
    setRevealed((prev) => ({ ...prev, [tile]: 'revealing' }));
    try {
      const result = await postJson(`/v2/sessions/${session.sessionId}/click`, { player: addr, tile });
      setRevealed((prev) => ({ ...prev, [result.tile]: result.outcome }));
      setRun({
        bombsHit: result.bombsHit, prizesFound: result.prizesFound,
        status: result.status, spentTotal: result.spentTotal || '0',
        prizeEarned: result.prizeEarned || '0', nextTileCost: result.nextTileCost || '0',
      });
      // Live credit update: optimistically debit the tile cost
      if (result.cost) {
        setBalance((prev) => {
          const newBal = BigInt(prev) - BigInt(result.cost);
          return newBal < 0n ? '0' : newBal.toString();
        });
      }
      // If player won a prize, credit it immediately
      if (result.prizeCredited && BigInt(result.prizeCredited) > 0n) {
        setBalance((prev) => (BigInt(prev) + BigInt(result.prizeCredited)).toString());
      }
      if (result.status === 'won') { setStatusMsg(`Won ${dollars(result.prizeEarned)}!`); sfx.win(); await refreshCredits(addr); }
      else if (result.status === 'lost') { setStatusMsg('Game over — 3 bombs'); sfx.bomb(); }
      else if (result.outcome === 'prize') { setStatusMsg('Prize!'); sfx.prize(); }
      else if (result.outcome === 'bomb') { setStatusMsg(`Bomb — ${result.bombsHit}/3`); sfx.bomb(); }
      else { setStatusMsg('Empty'); sfx.tileOpen(); }
    } catch (err) {
      // Remove the "revealing" state on error
      setRevealed((prev) => { const next = { ...prev }; delete next[tile]; return next; });
      setError(friendlyError(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: QUIT ──
  async function quitRound() {
    if (!session) { setView('lobby'); return; }
    setQuitting(true);
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
      // Optimistic: credit any prizeEarned back to balance immediately
      if (run.prizeEarned && BigInt(run.prizeEarned) > 0n) {
        setBalance((prev) => (BigInt(prev) + BigInt(run.prizeEarned)).toString());
      }
      setSession(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setView('lobby');
      setStatusMsg('');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Even on error, refresh — in-memory state may be correct already
      await refreshCredits(addr);
      await refreshSessions();
      setSession(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setView('lobby');
      setError(friendlyError(err));
    } finally {
      setBusy(false);
      setQuitting(false);
    }
  }

  // ── WITHDRAW ──
  async function requestWithdrawal() {
    setError('');
    const amount = usdcUnits(withdrawAmt);
    if (BigInt(amount) <= 0n) { setError('Enter an amount.'); return; }
    if (BigInt(amount) > BigInt(withdrawable)) { setError('Exceeds withdrawable.'); return; }
    setBusy(true); setStatusMsg('Processing withdrawal…');
    // Optimistic: debit withdrawn amount from balance + withdrawable immediately
    setBalance((prev) => {
      const newBal = BigInt(prev) - BigInt(amount);
      return newBal < 0n ? '0' : newBal.toString();
    });
    setWithdrawable((prev) => {
      const newW = BigInt(prev) - BigInt(amount);
      return newW < 0n ? '0' : newW.toString();
    });
    try {
      const result = await postJson('/v2/withdrawals/request', { player: addr, amount, destination: addr });
      setWithdrawAmt('');
      setShowWithdraw(false);
      // Show success banner in lobby
      setWithdrawSuccess(`${dollars(result.payoutAmount)} withdrawal submitted — check your wallet shortly`);
      await refreshCredits(addr);
    } catch (err) {
      // Restore balance on failure
      setBalance((prev) => (BigInt(prev) + BigInt(amount)).toString());
      setWithdrawable((prev) => (BigInt(prev) + BigInt(amount)).toString());
      setError(friendlyError(err));
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
    <div className="app" style={{ '--frame-gold': `url(${frameGold})`, '--frame-dark': `url(${frameDark})`, '--frame-green': `url(${frameGreen})`, '--frame-red': `url(${frameRed})`, '--btn-gold-up': `url(${btnGoldRaised})`, '--btn-gold-down': `url(${btnGoldPressed})`, '--btn-dark-up': `url(${btnDarkRaised})`, '--btn-dark-down': `url(${btnDarkPressed})`, '--btn-green-up': `url(${btnGreenRaised})`, '--btn-green-down': `url(${btnGreenPressed})`, '--btn-red-up': `url(${btnRedRaised})`, '--btn-red-down': `url(${btnRedPressed})` }}>
      <FloatingSprites />
      {view !== 'splash' && (
        <header className="header">
          <button className="brand" onClick={goHome}>
            <img src={chancyLogo} alt="" /> Chancy
          </button>
          <div className="header-right">
            {isFarcaster && farcaster.user?.pfpUrl && (
              <img className="fc-pfp" src={farcaster.user.pfpUrl} alt={farcaster.user.displayName || ''} title={farcaster.user.displayName || farcaster.user.username || ''} />
            )}
            <div className={`balance-pill ${online === false ? 'offline' : ''}`} onClick={addr ? goHome : undefined}>
              <span className="dot" />
              {addr ? dollars(balance) : '—'}
            </div>
            <button className="theme-toggle-btn" data-no-sfx onClick={toggleMute} title={muted ? 'Unmute sound' : 'Mute sound'} aria-label="Toggle sound">
              {muted ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              )}
            </button>
            <button className="theme-toggle-btn" data-no-sfx onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            {isConnected && !isPlaying && !isFarcaster && (
              <button className="disconnect-btn" onClick={disconnect} title="Disconnect" aria-label="Disconnect wallet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>
              </button>
            )}
          </div>
        </header>
      )}

      {error && <div className="error-banner" style={{ marginBottom: 12 }} onClick={() => setError('')}>{error}</div>}

      {/* ═══ LANDING ═══ */}
      {view === 'splash' && (
        <div className="landing-page">
          {/* Hero */}
          <div className="landing-hero">
            <img className="hero-logo" src={chancyLogo} alt="Chancy" />
            <h1>Host a game.<br/>Beat the board.<br/><span className="gold">Win the pot.</span></h1>
            <p className="tagline">Trustless P2P tile-reveal on Base. Hosts fund prize pots. Players pay per tile. Dodge bombs, collect prizes, sweep the pot.</p>
            {isFarcaster && !isConnected ? (
              <button className="btn btn-primary" onClick={connectWallet}>Connect Farcaster wallet →</button>
            ) : (
              <button className="btn btn-primary" onClick={connectWallet}>Connect wallet →</button>
            )}
            <button className="btn btn-secondary" onClick={() => setShowRules(true)}>How to play</button>
          </div>

          {/* How it works */}
          <div className="landing-section">
            <h2 className="landing-h2">How it works</h2>
            <div className="how-steps">
              <div className="how-step">
                <div className="step-num">1</div>
                <div className="step-body">
                  <strong>Host creates</strong>
                  <p>Lock a prize pot from your credits. Pick difficulty. Earn when players fail.</p>
                </div>
              </div>
              <div className="how-step">
                <div className="step-num">2</div>
                <div className="step-body">
                  <strong>Player joins</strong>
                  <p>Pay a small entry. Reveal tiles one by one. Each tile costs more than the last.</p>
                </div>
              </div>
              <div className="how-step">
                <div className="step-num">3</div>
                <div className="step-body">
                  <strong>Win or lose</strong>
                  <p>Find every prize → sweep the pot. Hit 3 bombs → game over. Quit anytime → keep what you found.</p>
                </div>
              </div>
            </div>
          </div>

          {/* Game modes preview */}
          <div className="landing-section">
            <h2 className="landing-h2">Game modes</h2>
            <div className="modes-preview">
              <div className="mode-info-card easy">
                <span className="mode-name">Easy</span>
                <span className="mode-stats">5 bombs · 3 prizes</span>
                <span className="mode-desc">More prizes, fewer bombs. Higher chance to sweep.</span>
              </div>
              <div className="mode-info-card normal">
                <span className="mode-name">Normal</span>
                <span className="mode-stats">7 bombs · 2 prizes</span>
                <span className="mode-desc">Balanced risk. Standard payouts.</span>
              </div>
              <div className="mode-info-card hardcore">
                <span className="mode-name">Hardcore</span>
                <span className="mode-stats">10 bombs · 1 prize</span>
                <span className="mode-desc">One prize, maximum bombs. Highest reward.</span>
              </div>
            </div>
          </div>

          {/* Trust signals */}
          <div className="landing-section">
            <div className="trust-row">
              <div className="trust-item">
                <img className="trust-icon" src={iconChain} alt="" />
                <span>Onchain randomness via Pyth Entropy</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconLock} alt="" />
                <span>No approval needed — raw USDC send</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconScroll} alt="" />
                <span>Open source · verifiable contracts</span>
              </div>
            </div>
          </div>

          {/* Agent-friendly */}
          <div className="landing-section">
            <h2 className="landing-h2">Agent-friendly</h2>
            <p className="landing-sub">Built for humans and AI agents. Pay per action with x402 — no pre-funding needed.</p>
            <div className="trust-row">
              <div className="trust-item">
                <img className="trust-icon" src={iconRobot} alt="" />
                <span>x402 pay-per-action — Agents pay USDC per tile, no deposit required</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconBolt} alt="" />
                <span>HTTP 402 protocol — Standard payment flow any agent can implement</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconPlug} alt="" />
                <span>REST API — Full game loop via /v2/x402/ endpoints</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="landing-footer">
            <div className="tech-logos">
              <a href="https://base.org" target="_blank" rel="noopener"><img src={baseLogo} alt="Base" title="Base L2" /></a>
              <a href="https://farcaster.xyz" target="_blank" rel="noopener"><img src={farcasterLogo} alt="Farcaster" title="Farcaster Mini App" /></a>
              <a href="https://x402.org" target="_blank" rel="noopener" className="x402-logo">x402</a>
              <a href="https://pyth.network" target="_blank" rel="noopener"><img src={pythLogo} alt="Pyth Entropy" title="Pyth Entropy randomness" /></a>
              <a href="https://www.circle.com/en/usdc" target="_blank" rel="noopener"><img src={usdcLogo} alt="USDC" title="USDC payments" /></a>
            </div>
            <div className="babylon-credit">
              Built by <a href="https://x.com/babylon_agent" target="_blank" rel="noopener">Babylon Agent</a>
            </div>
            <div className="footer-links">
              <a href="https://github.com/babylonagent/chancy" target="_blank" rel="noopener">GitHub</a>
              <button className="link-btn" onClick={() => setShowApiDocs(true)}>API &amp; Agents</button>
              <button className="link-btn" onClick={() => setShowRules(true)}>How to play</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ LOBBY ═══ */}
      {view === 'lobby' && isConnected && (
        <div className="lobby-view">
          {withdrawSuccess && (
            <div className="withdraw-success-banner" onClick={() => setWithdrawSuccess('')}>
              <span className="withdraw-success-icon">✓</span>
              <span>{withdrawSuccess}</span>
            </div>
          )}
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
              {sessions.map((s) => {
                const isMine = s.host.toLowerCase() === addr.toLowerCase();
                return (
                <div key={s.sessionId} className={`game-card mode-${s.mode.toLowerCase()} ${isMine ? 'my-game' : ''}`}>
                  <div className="game-card-top">
                    <div className="game-card-badges">
                      <span className="game-mode-badge">{s.mode}</span>
                      {isMine && <span className="my-game-badge">Your game</span>}
                    </div>
                    <span className="game-pot">{dollars(s.prizePot)}</span>
                  </div>
                  <div className="game-card-mid">
                    <span>{MODES[s.mode]?.copy}</span>
                    <span className="dim">First tile {dollars(s.firstTileCost)} · Entry {dollars(s.entranceFee)}</span>
                  </div>
                  {(s.earnings && BigInt(s.earnings) > 0n) || s.players > 0 ? (
                    <div className="game-card-stats">
                      <span className="stat-chip">#{s.sessionId}</span>
                      {s.earnings && BigInt(s.earnings) > 0n && <span className="stat-chip earnings">Earned {dollars(s.earnings)}</span>}
                      {s.players > 0 && <span className="stat-chip">{s.players} player{s.players > 1 ? 's' : ''}</span>}
                      {s.runs > 0 && <span className="stat-chip">{s.runs} run{s.runs > 1 ? 's' : ''}</span>}
                    </div>
                  ) : (
                    <div className="game-card-stats"><span className="stat-chip">#{s.sessionId}</span><span className="stat-chip">No plays yet</span></div>
                  )}
                  {isMine ? (
                    <button className="btn btn-ghost btn-sm" data-sfx-back disabled={busy} onClick={() => closeSession(s.sessionId)}>Close & refund</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => joinSession(s)}>Join · {dollars(s.entranceFee)}</button>
                  )}
                </div>
                );
              })}
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
            <button className="back-btn" data-sfx-back onClick={() => setView('lobby')}>← Back</button>
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
            <button className="back-btn" data-sfx-back onClick={() => { setPollingDeposit(false); setView('lobby'); }}>← Back</button>
            <span className="section-title" style={{ margin: 0 }}>Add credits</span>
          </div>

          {/* Step 1: Fund wallet (if empty) */}
          <div className="deposit-step">
            <div className="deposit-step-num">1</div>
            <div className="deposit-step-body">
              <strong>Get USDC into your wallet</strong>
              <p>Send USDC (on Base) to your wallet address below — from an exchange, another wallet, or anywhere.</p>
              <div className="your-address-card" onClick={() => {
                try { navigator.clipboard.writeText(addr); } catch {}
              }}>
                <div className="vault-label">Your wallet</div>
                <div className="vault-address">{addr ? `${addr.slice(0,10)}…${addr.slice(-8)}` : '—'}</div>
                <div className="vault-copy-hint">Tap to copy</div>
              </div>
            </div>
          </div>

          {/* Step 2: Send to vault */}
          <div className="deposit-step">
            <div className="deposit-step-num">2</div>
            <div className="deposit-step-body">
              <strong>Send USDC to the vault</strong>
              <p>Transfer from your wallet to this address. Credits appear automatically (~10 seconds). 5% fee applies.</p>
              {vaultAddress && (
                <div className="qr-section">
                  <img className="qr-code" src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(vaultAddress)}`} alt="Deposit QR" />
                </div>
              )}
              <div className="vault-address-card" onClick={copyVaultAddress}>
                <div className="vault-label">Vault address</div>
                <div className="vault-address">{vaultAddress || 'Loading…'}</div>
                <div className="vault-copy-hint">{copied ? '✓ Copied' : 'Tap to copy'}</div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="deposit-actions">
            {isConnected && <button className="btn btn-primary" onClick={openWalletSend}>Send from wallet</button>}
            <button className="btn btn-secondary" onClick={() => { copyVaultAddress(); setPollingDeposit(true); }}>{copied ? '✓ Copied' : 'Copy vault address'}</button>
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
          <p className="fee-note">5% fee · 1:1 with USDC · USDC must be on Base network</p>
        </div>
      )}

      {/* ═══ ROUND ═══ */}
      {view === 'round' && session && (
        <div className="round-view">
          <div className="round-header">
            <button className="back-btn" data-sfx-back onClick={quitRound} disabled={quitting}>
              {quitting ? 'Quitting…' : `← ${gameEnded ? 'Done' : 'Quit'}`}
            </button>
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
              return (
                <button key={tile} className={`tile ${state || ''}`} disabled={!!state || run.status !== 'active' || busy} onClick={() => clickTile(tile)}>
                  {state === 'prize' && <img src={gemSprite} alt="prize" />}
                  {state === 'bomb' && <img src={bombSprite} alt="bomb" />}
                </button>
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
              {isFarcaster && farcaster.sdk?.actions?.composeCast && (
                <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => {
                  const text = run.status === 'won'
                    ? `Just won ${dollars(run.prizeEarned)} on Chancy! 🏆 Host-vs-player tile reveal on Base. Play → chancy.cash`
                    : `Hit 3 bombs on Chancy 💣 Lost ${dollars(run.spentTotal)} but it was fun. Try your luck → chancy.cash`;
                  farcaster.sdk.actions.composeCast({ text, embeds: ['https://chancy.cash'] }).catch(() => {});
                }}>Share on Farcaster</button>
              )}
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
      {view === 'splash' && (
        <button className="theme-toggle-fab" data-no-sfx onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
          {theme === 'dark' ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </button>
      )}
      {showRules && <RulesSheet onClose={closeRules} />}
      {showApiDocs && <ApiDocsSheet onClose={() => setShowApiDocs(false)} />}
    </div>
  );
}
