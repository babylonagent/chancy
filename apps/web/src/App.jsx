import React, { useCallback, useEffect, useState, useRef } from 'react';
import sfx from './sound';
import FloatingSprites from './FloatingSprites';
import chancyLogo from './assets/chancy-logo.svg';
import baseLogo from './assets/tech/base-basemark.svg';
import farcasterLogo from './assets/tech/farcaster.svg';
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

// ─── CUSTOM PIXEL BUTTONS (3-slice: left + body + right) ──────────────────────
import orangeBtnLeft from './assets/pixel/buttons/OrangeButtonLeft.png';
import orangeBtnLeftPressed from './assets/pixel/buttons/OrangeButtonLeftPressed.png';
import orangeBtnBody from './assets/pixel/buttons/OrangeButtonBody.png';
import orangeBtnBodyPressed from './assets/pixel/buttons/OrangeButtonBodyPressed.png';
import orangeBtnRight from './assets/pixel/buttons/OrangeButtonRight.png';
import orangeBtnRightPressed from './assets/pixel/buttons/OrangeButtonRightPressed.png';
import tealBtnLeft from './assets/pixel/buttons/TealButtonLeft.png';
import tealBtnLeftPressed from './assets/pixel/buttons/TealButtonLeftPressed.png';
import tealBtnBody from './assets/pixel/buttons/TealButtonBody.png';
import tealBtnBodyPressed from './assets/pixel/buttons/TealButtonBodyPressed.png';
import tealBtnRight from './assets/pixel/buttons/TealButtonRight.png';
import tealBtnRightPressed from './assets/pixel/buttons/TealButtonRightPressed.png';

// ─── CUSTOM TEXTFIELD (9-slice) ───────────────────────────────────────────────
import tfTopleft from './assets/pixel/textfield/topleft.gif';
import tfTop from './assets/pixel/textfield/top.gif';
import tfTopright from './assets/pixel/textfield/topright.gif';
import tfLeft from './assets/pixel/textfield/left.gif';
import tfCenter from './assets/pixel/textfield/center.png';
import tfRight from './assets/pixel/textfield/right.gif';
import tfBottomleft from './assets/pixel/textfield/bottomleft.gif';
import tfBottom from './assets/pixel/textfield/bottom.gif';
import tfBottomright from './assets/pixel/textfield/bottomright.gif';
import tf9slice from './assets/pixel/textfield/textfield-9slice.png';
import tfCenterTile from './assets/pixel/textfield/center-tile.png';

// ─── V3 CONTRACT CONFIG ─────────────────────────────────────────────────────
const V3_SETTLEMENT = '0x46ae2f3f80d9021066a126a94b4700B17f3cB218';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // USDC on Base Sepolia
const CHAIN_ID = 84532;

// Minimal ABIs (subset of the on-chain ChancySettlementV3 + ERC20)
const SETTLEMENT_ABI = [
  {
    name: 'deposit', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'withdraw', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'balances', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'createGame', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'difficulty', type: 'uint8' },
      { name: 'prizePot', type: 'uint256' },
      { name: 'hostCommitment', type: 'bytes32' },
    ],
    outputs: [{ name: 'gameId', type: 'uint256' }],
  },
  {
    name: 'joinGame', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'uint256' },
      { name: 'playerCommitment', type: 'bytes32' },
      { name: 'maxSpend', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'getGame', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
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
    name: 'GameCreated', type: 'event',
    inputs: [
      { name: 'gameId', type: 'uint256', indexed: true },
      { name: 'host', type: 'address', indexed: true },
      { name: 'difficulty', type: 'uint8', indexed: false },
      { name: 'prizePot', type: 'uint256', indexed: false },
      { name: 'hostCommitment', type: 'bytes32', indexed: false },
    ],
  },
  {
    name: 'GameSettled', type: 'event',
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
    name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
];

// V3 difficulty enum → mode name. (0=Easy, 1=Normal, 2=Hardcore)
const V3_DIFFICULTY_TO_MODE = ['Easy', 'Normal', 'Hardcore'];
const MODE_TO_V3_DIFFICULTY = { Easy: 0, Normal: 1, Hardcore: 2 };

// V3 progressive cost config (mirrors v3-board.js modeConfig).
// Used to display estimated next-tile cost in the round view.
const V3_MODE_COST = {
  Easy:     { startBps: 150, capBps: 15000 },
  Normal:   { startBps: 250, capBps: 20000 },
  Hardcore: { startBps: 350, capBps: 25000 },
};
function v3RevealCostAt(prizePot, mode, revealIndex) {
  const cfg = V3_MODE_COST[mode];
  if (!cfg) return 0n;
  const baseTotalBps = cfg.startBps * 36;
  const stepBps = cfg.capBps > baseTotalBps
    ? Math.floor((cfg.capBps - baseTotalBps) * 2 / (36 * 35))
    : 0;
  const costBps = cfg.startBps + stepBps * revealIndex;
  return BigInt(prizePot) * BigInt(costBps) / 10000n;
}

// Browser-side Ethers v6 BrowserProvider cache (one per wallet provider).
let _ethersProvider = null;
let _ethersProviderFor = null;
async function getEthersProvider(walletProvider) {
  // Prefer the wallet provider from Reown/Farcaster; fall back to window.ethereum (MetaMask)
  const provider = walletProvider || (typeof window !== 'undefined' ? window.ethereum : null);
  if (!provider) return null;
  if (_ethersProvider && _ethersProviderFor === provider) return _ethersProvider;
  const { BrowserProvider } = await import('ethers');
  _ethersProvider = new BrowserProvider(provider);
  _ethersProviderFor = provider;
  return _ethersProvider;
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const USDC_DECIMALS = 1_000_000n;
const BOMB_LIVES = 3;
const TILES = Array.from({ length: 36 }, (_, i) => i + 1);

const MODES = {
  Easy:     { bombs: 3,  prizes: 3, copy: '3 bombs · 3 prizes' },
  Normal:   { bombs: 4,  prizes: 2, copy: '4 bombs · 2 prizes' },
  Hardcore: { bombs: 6,  prizes: 1, copy: '6 bombs · 1 prize' },
};

const POT_PRESETS = ['5', '10', '25', '50'];

// ─── WALLET SIGNING ─────────────────────────────────────────────────────────
// Module-level reference set by App on mount — lets postJson auto-sign.
let _walletProvider = null;
let _signerAddr = '';
function setWalletForSigning(provider, addr) {
  _walletProvider = provider || null;
  _signerAddr = addr || '';
}

// Canonical JSON stringify — stable key order for body hashing.
// MUST be byte-identical to the server's canonicalStringify in sig-auth.js.
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',') + '}';
}

// SHA-256 hex hash of canonical JSON body (browser crypto.subtle).
async function computeBodyHash(body) {
  const bytes = new TextEncoder().encode(canonicalStringify(body || {}));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── ERROR MAPPING ──────────────────────────────────────────────────────────
// Translate raw API error codes into player-friendly messages.
function friendlyError(err) {
  const msg = err?.message || String(err);
  const map = {
    INSUFFICIENT_CREDITS_FOR_REVEAL: 'Not enough credits for the next tile. Add more credits or quit.',
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
  const headers = { 'Content-Type': 'application/json' };

  // Auto-sign if we have a wallet provider
  if (_walletProvider && _signerAddr) {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bHash = await computeBodyHash(body || {});
    const message = `chancy:${path}:${bHash}:${nonce}:${timestamp}`;
    const signature = await _walletProvider.request({
      method: 'personal_sign',
      params: [message, _signerAddr],
    });
    headers['x-chancy-signer'] = _signerAddr;
    headers['x-chancy-signature'] = signature;
    headers['x-chancy-nonce'] = nonce;
    headers['x-chancy-timestamp'] = timestamp;
    headers['x-chancy-body-hash'] = bHash;
  }

  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers,
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
          <div className="rule-text"><strong>Dodge bombs</strong><span>Three bombs ends your run. Quit or bomb out and you lose everything. Sweep all prizes to win the pot.</span></div>
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
        <p className="modal-sub">Send USDC to the contract — no approvals needed. The indexer credits your on-chain balance automatically. Play unlimited games, withdraw anytime (5% fee to treasury).</p>

        <div className="api-section">
          <h3 className="api-h3">On-chain Flow</h3>
          <ol className="api-flow">
            <li>Send USDC to contract address (raw transfer, no signing)</li>
            <li>Indexer detects transfer &rarr; calls <code>adminCredit(user, amount)</code> on-chain</li>
            <li>Host calls <code>createGame(difficulty, prizePot, hostCommitment)</code> — pulls from balance</li>
            <li>Player calls <code>joinGame(gameId, playerCommitment, maxSpend)</code> — pulls from balance</li>
            <li>Game settles on-chain on win/loss/quit &rarr; winnings credited to balance</li>
            <li><code>withdraw(amount)</code> anytime — 5% fee auto-sent to treasury</li>
          </ol>
        </div>

        <div className="api-section">
          <h3 className="api-h3">V3 Engine Endpoints</h3>
          <div className="api-endpoints">
            <div className="api-endpoint"><span className="api-method free">POST</span><code>/v3/sessions/:gameId/host-secret</code><span className="api-note">Host stores secret (after createGame tx)</span></div>
            <div className="api-endpoint"><span className="api-method paid">POST</span><code>/v3/sessions/:gameId/click</code><span className="api-note">Reveal tile {`{ player, tile }`}</span></div>
            <div className="api-endpoint"><span className="api-method free">POST</span><code>/v3/sessions/:gameId/quit</code><span className="api-note">Quit game {`{ player }`}</span></div>
            <div className="api-endpoint"><span className="api-method free">GET</span><code>/v3/sessions/:gameId/state</code><span className="api-note">Poll full game state</span></div>
            <div className="api-endpoint"><span className="api-method free">GET</span><code>/v3/sessions</code><span className="api-note">List active games</span></div>
          </div>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Contract Addresses (Base Sepolia)</h3>
          <div className="api-contracts">
            <div className="api-contract"><span className="api-contract-label">Settlement V3</span><code>0x46ae2f3f80d9021066a126a94b4700B17f3cB218</code></div>
            <div className="api-contract"><span className="api-contract-label">USDC</span><code>0x036CbD53842c5426634e7929541eC2318f3dCF7e</code></div>
            <div className="api-contract"><span className="api-contract-label">Treasury (5% fee)</span><code>0x51a17E6DaE3d0D04174734b906BB201Cc79a20ff</code></div>
          </div>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Quick Start</h3>
          <pre className="api-code-block">{`# 1. Approve USDC for the settlement contract
# 2. Call createGame() or joinGame() on-chain
# 3. POST /v3/sessions/:gameId/click to reveal tiles
# 4. Settler bot settles on-chain — 5% fee auto-sent to treasury

# Full ABI: see Contract Addresses above
# Chain: Base Sepolia (84532)`}</pre>
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

  // V3 Player: max spend (USDC) the player is willing to risk on a single game
  const [joinMaxSpend, setJoinMaxSpend] = useState('5');

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

  // ── Wallet signing setup — clear cache on disconnect ──
  useEffect(() => {
    setWalletForSigning(wallet.walletProvider || null, addr);
    if (!wallet.walletProvider) {
      _ethersProvider = null;
      _ethersProviderFor = null;
    }
  }, [wallet.walletProvider, addr]);

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

  // ── On-chain balance (V3: deposits into settlement contract) ──
  const refreshCredits = useCallback(async (a) => {
    const player = a || addr;
    if (!player) return '0';
    try {
      const ethers = await import('ethers');
      // Use plain RPC for reads — BrowserProvider requires wallet session and can fail silently
      const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
      const settlement = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, provider);
      const bal = await settlement.balances(player);
      const balStr = bal.toString();
      setBalance(balStr);
      setWithdrawable(balStr);
      return balStr;
    } catch (e) {
      console.error('refreshCredits failed:', e?.message?.slice(0, 200));
      return '0';
    }
  }, [addr]);

  // ── Load V3 sessions ──
  // V3: open games (waiting for player) come from on-chain GameCreated events,
  // and active games come from the off-chain /v3/sessions endpoint.
  // We merge both into the same shape the lobby expects.
  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      let openGames = [];

      // 1. Read open games from on-chain GameCreated events
      try {
        const ethers = await import('ethers');
        const provider = await getEthersProvider(wallet.walletProvider);
        if (provider) {
          const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, provider);
          const filter = contract.filters.GameCreated();
          // Scan the last ~10k blocks for GameCreated events
          const events = await contract.queryFilter(filter, -10000);
          for (const event of events) {
            const gameId = event.args.gameId.toString();
            try {
              const game = await contract.getGame(gameId);
              // status === 0 means "Created" (open, waiting for player)
              if (Number(game.status) === 0) {
                const mode = V3_DIFFICULTY_TO_MODE[Number(game.difficulty)] || 'Normal';
                const firstTileCost = v3RevealCostAt(game.prizePot.toString(), mode, 0).toString();
                openGames.push({
                  sessionId: gameId, // reused by lobby render (s.sessionId)
                  gameId,
                  host: game.host,
                  mode,                       // lobby renders s.mode
                  prizePot: game.prizePot.toString(),
                  entranceFee: '0',           // V3: no separate entrance; player approves maxSpend
                  firstTileCost,
                  earnings: '0',
                  players: 0,
                  runs: 0,
                  _v3: true,
                  _v3State: 'open',
                });
              }
            } catch {}
          }
        }
      } catch (err) {
        console.error('V3 loadGames error:', err);
      }

      // 2. Get active sessions from the V3 engine (these don't appear in the lobby join list
      //    but surface as "in progress" markers). We only show open (joinable) games in the
      //    list to match V2 behavior, so we ignore active ones for the join list.
      try {
        await getJson('/v3/sessions');
      } catch { /* engine may be unreachable; on-chain events are the source of truth */ }

      setSessions(openGames);
    } catch { /* silent */ }
    setSessionsLoading(false);
  }, [wallet.walletProvider]);

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
      await navigator.clipboard.writeText(addr || vaultAddress || '');
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

  // ── Auto-poll balance while on deposit page ──
  useEffect(() => {
    if (view !== 'deposit' || !addr) return;
    setPreDepositBalance(balance);
    const interval = setInterval(async () => {
      const bal = await refreshCredits(addr);
      if (preDepositBalance && BigInt(bal) > BigInt(preDepositBalance)) {
        sfx.win();
        setStatusMsg(`+${dollars((BigInt(bal) - BigInt(preDepositBalance)).toString())} received!`);
        setTimeout(() => { setView('lobby'); setStatusMsg(''); }, 2000);
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [view, addr, refreshCredits]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── HOST: CREATE (V3 on-chain) ──
  async function hostCreateSession() {
    setError('');
    const pot = usdcUnits(potAmt);
    if (BigInt(pot) < 5_000_000n) { setError('Minimum pot is $5.'); return; }
    if (BigInt(pot) > BigInt(balance)) { setError('Not enough USDC in your wallet.'); return; }
    setBusy(true); setStatusMsg('Approving USDC…');

    // Optimistic: debit pot from displayed balance immediately (will be re-synced from chain)
    setBalance((prev) => {
      const newBal = BigInt(prev) - BigInt(pot);
      return newBal < 0n ? '0' : newBal.toString();
    });

    try {
      const ethers = await import('ethers');
      const browserProvider = await getEthersProvider(wallet.walletProvider);
      if (!browserProvider) {
        _ethersProvider = null;
        _ethersProviderFor = null;
        throw new Error('Wallet not connected. Try reconnecting.');
      }
      const signer = await browserProvider.getSigner();
      const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, signer);

      const difficultyEnum = MODE_TO_V3_DIFFICULTY[hostMode];
      if (difficultyEnum === undefined) throw new Error('Invalid difficulty');

      // 1. Generate host secret + commitment (keccak256(secret))
      const hostSecret = randomEntropy();
      const hostCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [hostSecret]));

      // Store host secret locally for settlement recovery
      try { localStorage.setItem(`chancy_v3_host_secret_${addr}`, hostSecret); } catch {}

      // 2. createGame on-chain (pulls from your deposit balance)
      sfx.click();
      setStatusMsg('Creating game on-chain…');
      const tx = await contract.createGame(difficultyEnum, pot, hostCommitment);
      const receipt = await tx.wait();

      // 4. Parse GameCreated event for gameId
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

      if (!gameId) throw new Error('GameCreated event not found in transaction receipt');

      // 5. POST host secret to the V3 engine so the settler bot can activate later
      setStatusMsg('Registering host secret…');
      try {
        await postJson(`/v3/sessions/${gameId}/host-secret`, {
          hostSecret,
          host: addr,
          difficulty: difficultyEnum,
          prizePot: pot,
        });
      } catch (err) {
        // Non-fatal: game is on-chain; host secret can be re-submitted.
        console.warn('host-secret POST failed:', err);
      }

      setStatusMsg(`Game #${gameId} live on-chain`);
      sfx.win();
      setView('lobby');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Restore displayed balance on failure
      setBalance((prev) => (BigInt(prev) + BigInt(pot)).toString());
      await refreshCredits(addr);
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── HOST: CLOSE (V3: no-op — games auto-expire on-chain via timeout refund) ──
  // We keep the function so the lobby button stays wired, but it just refreshes state.
  async function closeSession(sessionId) {
    if (!addr) return;
    setBusy(true);
    setStatusMsg('V3 games auto-expire on-chain — refreshing…');
    try {
      await refreshSessions();
      setStatusMsg('');
    } catch (err) {
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }
  // ── PLAYER: JOIN (V3 on-chain) ──
  // V3: deposit already done — joinGame pulls from balance. No per-game approval.
  async function joinSession(sess) {
    setError('');
    const maxSpend = usdcUnits(joinMaxSpend);
    if (BigInt(maxSpend) <= 0n) { setError('Enter a max spend amount.'); return; }
    if (BigInt(maxSpend) > BigInt(balance)) { setError('Not enough balance. Deposit more USDC.'); return; }
    setBusy(true); setStatusMsg('Joining on-chain…');
    try {
      const ethers = await import('ethers');
      const browserProvider = await getEthersProvider(wallet.walletProvider);
      if (!browserProvider) {
        _ethersProvider = null;
        _ethersProviderFor = null;
        throw new Error('Wallet not connected. Try reconnecting.');
      }
      const signer = await browserProvider.getSigner();
      const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, signer);

      // 1. Generate player commitment (random bytes32 → keccak256)
      const playerRandom = randomEntropy();
      const playerCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [playerRandom]));

      // 2. joinGame on-chain (pulls from your deposit balance)
      sfx.click();
      setStatusMsg('Joining on-chain…');
      const gameId = sess.gameId || sess.sessionId;
      const tx = await contract.joinGame(gameId, playerCommitment, maxSpend);
      await tx.wait();

      // 4. Set up round state and switch to round view.
      //    The settler bot will activate the game async; we poll the V3 engine.
      const mode = sess.mode || V3_DIFFICULTY_TO_MODE[Number(sess.difficulty)] || 'Normal';
      const prizePot = sess.prizePot;
      setSession({ sessionId: gameId, gameId, mode, prizePot, maxSpend });
      setRevealed({});
      setRun({ bombsHit: 0, prizesFound: 0, status: 'activating', spentTotal: '0', prizeEarned: '0', nextTileCost: v3RevealCostAt(prizePot, mode, 0).toString() });
      setView('round');
      setStatusMsg('Waiting for settler bot to activate…');
      sfx.win();

      // 5. Poll /v3/sessions/:gameId/state until status becomes 'active'
      //    (Runs in background without blocking the UI; round view handles its own polling too.)
      const pollActivation = async () => {
        for (let i = 0; i < 60; i++) {
          try {
            const state = await getJson(`/v3/sessions/${gameId}/state`);
            if (state && state.status === 'active') {
              setRun((prev) => ({ ...prev, status: 'active' }));
              setStatusMsg('');
              return;
            }
          } catch { /* engine may not have it yet */ }
          await new Promise((r) => setTimeout(r, 2000));
        }
        // Timeout: show a message but don't error out — player can still quit.
        setStatusMsg('Activation taking longer than expected — you can quit to reclaim unused funds.');
      };
      pollActivation();

      await refreshCredits(addr);
    } catch (err) {
      await refreshCredits(addr);
      setError(friendlyError(err));
      setStatusMsg('');
    } finally { setBusy(false); }
  }

  // ── PLAYER: CLICK (V3) ──
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
      // V3 tiles are 0-indexed in the engine; TILES is 1-based. Map to 0-based.
      const tileIndex0 = tile - 1;
      const result = await postJson(`/v3/sessions/${session.sessionId}/click`, { player: addr, tile: tileIndex0 });
      // V3 result shape: { tile, type: 'bomb'|'prize'|'empty', bombsHit, prizesFound, totalPrizes, spent, gameOver, outcome }
      const tileKey = tile; // keep 1-based for display
      const tileState = result.type === 'bomb' ? 'bomb' : result.type === 'prize' ? 'prize' : 'empty';
      setRevealed((prev) => ({ ...prev, [tileKey]: tileState }));

      const newSpent = result.spent || run.spentTotal;
      const newBombs = result.bombsHit ?? run.bombsHit;
      const newPrizes = result.prizesFound ?? run.prizesFound;
      const nextIdx = (Object.keys(revealed).length + 1);
      const nextCost = v3RevealCostAt(session.prizePot, session.mode, nextIdx).toString();

      if (result.gameOver) {
        if (result.outcome === 'win') {
          setRun({ bombsHit: newBombs, prizesFound: newPrizes, status: 'won', spentTotal: newSpent, prizeEarned: session.prizePot, nextTileCost: '0' });
          setStatusMsg(`Won ${dollars(session.prizePot)}!`);
          sfx.win();
        } else if (result.outcome === 'loss') {
          setRun({ bombsHit: newBombs, prizesFound: newPrizes, status: 'lost', spentTotal: newSpent, prizeEarned: '0', nextTileCost: '0' });
          setStatusMsg('Game over — 3 bombs');
          sfx.bomb();
        }
        await refreshCredits(addr);
      } else {
        setRun((prev) => ({ ...prev, bombsHit: newBombs, prizesFound: newPrizes, spentTotal: newSpent, nextTileCost: nextCost }));
        if (result.type === 'prize') { setStatusMsg('Prize!'); sfx.prize(); }
        else if (result.type === 'bomb') { setStatusMsg(`Bomb — ${newBombs}/${BOMB_LIVES}`); sfx.bomb(); }
        else { setStatusMsg('Empty'); sfx.tileOpen(); }
      }
    } catch (err) {
      // Remove the "revealing" state on error
      setRevealed((prev) => { const next = { ...prev }; delete next[tile]; return next; });
      setError(friendlyError(err));
    } finally { setBusy(false); }
  }

  // ── PLAYER: QUIT (V3) ──
  async function quitRound() {
    if (!session) { setView('lobby'); return; }
    setQuitting(true);
    setBusy(true);
    try {
      if (run.status === 'active') {
        const final = await postJson(`/v3/sessions/${session.sessionId}/quit`, { player: addr });
        // V3 quit returns { outcome: 'quit', spent }. Reveal full board by polling state.
        try {
          const state = await getJson(`/v3/sessions/${session.sessionId}/state`);
          if (state && state.bombPositions && state.prizePositions) {
            const full = {};
            (state.bombPositions || []).forEach((t) => { full[t + 1] = 'bomb'; }); // +1 to 1-based
            (state.prizePositions || []).forEach((t) => { full[t + 1] = 'prize'; });
            setRevealed((prev) => ({ ...full, ...prev }));
          }
        } catch {}
      }
      setSession(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setView('lobby');
      setStatusMsg('');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Even on error, refresh — on-chain state is the source of truth
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

  // ── WITHDRAW (V3: no-op — USDC is direct on-chain, no vault to withdraw from) ──
  // V3 doesn't have a credit ledger or vault; your USDC is already in your wallet.
  // We keep the function so the modal wiring doesn't break, but it just closes the modal.
  async function requestWithdrawal() {
    setError('');
    setWithdrawAmt('');
    setShowWithdraw(false);
    setStatusMsg('Your USDC is already in your wallet — no withdrawal needed.');
    setTimeout(() => setStatusMsg(''), 4000);
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
    <div className={`app ${view === 'splash' ? 'landing-mode' : ''}`} style={{ '--frame-gold': `url(${frameGold})`, '--frame-dark': `url(${frameDark})`, '--frame-green': `url(${frameGreen})`, '--frame-red': `url(${frameRed})`, '--btn-gold-up': `url(${btnGoldRaised})`, '--btn-gold-down': `url(${btnGoldPressed})`, '--btn-dark-up': `url(${btnDarkRaised})`, '--btn-dark-down': `url(${btnDarkPressed})`, '--btn-green-up': `url(${btnGreenRaised})`, '--btn-green-down': `url(${btnGreenPressed})`, '--btn-red-up': `url(${btnRedRaised})`, '--btn-red-down': `url(${btnRedPressed})`, '--orange-left': `url(${orangeBtnLeft})`, '--orange-left-pressed': `url(${orangeBtnLeftPressed})`, '--orange-body': `url(${orangeBtnBody})`, '--orange-body-pressed': `url(${orangeBtnBodyPressed})`, '--orange-right': `url(${orangeBtnRight})`, '--orange-right-pressed': `url(${orangeBtnRightPressed})`, '--teal-left': `url(${tealBtnLeft})`, '--teal-left-pressed': `url(${tealBtnLeftPressed})`, '--teal-body': `url(${tealBtnBody})`, '--teal-body-pressed': `url(${tealBtnBodyPressed})`, '--teal-right': `url(${tealBtnRight})`, '--teal-right-pressed': `url(${tealBtnRightPressed})`, '--tf-9slice': `url(${tf9slice})`, '--tf-center': `url(${tfCenterTile})` }}>
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
                  <p>Lock a prize pot in USDC. Pick difficulty. Earn when players fail.</p>
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
                  <p>Find every prize → sweep the pot. Hit 3 bombs → lose it all. Quit → lose it all.</p>
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
                <span className="mode-stats">3 bombs · 3 prizes</span>
                <span className="mode-desc">More prizes, fewer bombs. Higher chance to sweep.</span>
              </div>
              <div className="mode-info-card normal">
                <span className="mode-name">Normal</span>
                <span className="mode-stats">4 bombs · 2 prizes</span>
                <span className="mode-desc">Balanced risk. Standard payouts.</span>
              </div>
              <div className="mode-info-card hardcore">
                <span className="mode-name">Hardcore</span>
                <span className="mode-stats">6 bombs · 1 prize</span>
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
                <span>Onchain settlement — send USDC, play on-chain</span>
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
            <p className="landing-sub">Built for humans and AI agents. REST API for on-chain gameplay — any agent can host, join, and play programmatically.</p>
            <div className="trust-row">
              <div className="trust-item">
                <img className="trust-icon" src={iconRobot} alt="" />
                <span>REST API — Full game loop via /v3/ endpoints, agent-ready</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconBolt} alt="" />
                <span>On-chain escrow — Approve USDC, contract holds funds, trustless settlement</span>
              </div>
              <div className="trust-item">
                <img className="trust-icon" src={iconPlug} alt="" />
                <span>x402 compatible — Pay-per-action HTTP 402 protocol support</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="landing-footer">
            <div className="tech-logos">
              <a href="https://farcaster.xyz" target="_blank" rel="noopener"><img src={farcasterLogo} alt="Farcaster" title="Farcaster Mini App" /></a>
              <a href="https://x402.org" target="_blank" rel="noopener" className="x402-logo">x402</a>
              <a href="https://base.org" target="_blank" rel="noopener"><img src={baseLogo} alt="Base" title="Base L2" /></a>
              <a href="https://pyth.network" target="_blank" rel="noopener"><img src={pythLogo} alt="Pyth Entropy" title="Pyth Entropy randomness" /></a>
              <a href="https://www.circle.com/en/usdc" target="_blank" rel="noopener"><img src={usdcLogo} alt="USDC" title="USDC payments" /></a>
            </div>
            <div className="footer-links">
              <a href="https://github.com/babylonagent/chancy" target="_blank" rel="noopener">GitHub</a>
              <button className="link-btn" onClick={() => setShowApiDocs(true)}>API &amp; Agents</button>
            </div>
            <div className="babylon-credit">
              Built by <a href="https://x.com/babylon_agent" target="_blank" rel="noopener">Babylon Agent</a>
            </div>
          </div>
        </div>
      )}

      {/* ═══ LOBBY ═══ */}
      {view === 'lobby' && isConnected && (
        <div className="lobby-view">
          <div className="credit-card pixel-frame">
            <div className="credit-top">
              <div className="credit-big">
                <span className="label">USDC</span>
                <span className="value gold">{dollars(balance)}</span>
              </div>
            </div>
            <div className="credit-actions-simple">
              <button className="btn btn-primary btn-sm" onClick={() => { setPreDepositBalance(balance); setView('deposit'); }}>+ Add USDC</button>
              <button className="btn btn-secondary btn-sm" disabled={busy || BigInt(balance) <= 0n} onClick={() => { setWithdrawAmt(''); setShowWithdraw(true); }}>Withdraw</button>
            </div>
            <p className="hint-text">Send USDC to the contract — balance updates in 3-5 seconds</p>
          </div>

          <div className="lobby-section-header">
            <span className="section-title">Open games</span>
            <button className="refresh-icon" onClick={refreshSessions} disabled={sessionsLoading}>{sessionsLoading ? '⋯' : '↻'}</button>
          </div>

          {sessions.length === 0 ? (
            <div className="empty-state pixel-frame">
              <p>No open games yet.</p>
            </div>
          ) : (
            <div className="game-list">
              {sessions.map((s) => {
                const isMine = s.host.toLowerCase() === addr.toLowerCase();
                return (
                <div key={s.sessionId} className={`game-card mode-${s.mode.toLowerCase()} ${isMine ? 'my-game' : ''} pixel-frame`}>
                  <div className="game-card-top">
                    <div className="game-card-badges">
                      <span className="game-mode-badge">{s.mode}</span>
                      {isMine && <span className="my-game-badge">Your game</span>}
                    </div>
                    <span className="game-pot">{dollars(s.prizePot)}</span>
                  </div>
                  <div className="game-card-mid">
                    <span>{MODES[s.mode]?.copy}</span>
                    <span className="dim">First tile {dollars(s.firstTileCost)}</span>
                  </div>
                  <div className="game-card-stats"><span className="stat-chip">#{s.sessionId}</span><span className="stat-chip">Open · on-chain</span></div>
                  {isMine ? (
                    <span className="stat-chip">Waiting for player…</span>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => joinSession(s)}>Join game</button>
                  )}
                </div>
                );
              })}
            </div>
          )}

          <div className="bottom-bar">
            <button className="btn btn-primary" style={{ width: 'auto', alignSelf: 'center', padding: '0 32px' }} onClick={() => setView('host')}>+ Host a game</button>
          </div>
          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ HOST ═══ */}
      {view === 'host' && isConnected && (
        <div className="host-view pixel-frame">
          <div className="lobby-section-header">
            <button className="back-btn" data-sfx-back onClick={() => setView('lobby')}>← Back</button>
            <span className="section-title" style={{ margin: 0 }}>Host a game</span>
          </div>
          <div className="host-balance pixel-frame">
            <span>You have</span>
            <span className="value gold">{dollars(balance)}</span>
          </div>
          <div className="section-title">Difficulty</div>
          <div className="mode-selector">
            {Object.entries(MODES).map(([name, cfg]) => (
              <button key={name} className={`mode-tab pixel-frame ${hostMode === name ? 'selected' : ''}`} onClick={() => setHostMode(name)}>
                <span className="tab-name">{name}</span>
                <span className="tab-sub">{cfg.copy}</span>
              </button>
            ))}
          </div>
          <div className="section-title">Prize pot</div>
          <div className="pot-input-group pixel-frame">
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

      {/* ═══ DEPOSIT (raw send — indexer credits on-chain) ═══ */}
      {view === 'deposit' && isConnected && (
        <div className="deposit-view">
          <div className="lobby-section-header">
            <button className="back-btn" data-sfx-back onClick={() => { setPollingDeposit(false); setView('lobby'); }}>← Back</button>
            <span className="section-title" style={{ margin: 0 }}>Add USDC</span>
          </div>

          {/* Contract address + QR */}
          <div className="deposit-card pixel-frame">
            <strong>Send USDC to play</strong>
            <p>Send USDC from your wallet to the contract address below. No approvals, no signing — just a raw transfer.</p>
            {V3_SETTLEMENT && (
              <div className="qr-section">
                <img className="qr-code" src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(V3_SETTLEMENT)}`} alt="Contract QR" />
              </div>
            )}
            <div className="vault-address-card pixel-frame" onClick={() => { navigator.clipboard.writeText(V3_SETTLEMENT).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); }}>
              <div className="vault-label">Contract address</div>
              <div className="vault-address">{V3_SETTLEMENT}</div>
              <div className="vault-copy-hint">{copied ? '✓ Copied' : 'Tap to copy'}</div>
            </div>
          </div>

          {/* Auto-polling indicator — shows the system is watching for your deposit */}
          <div className="deposit-polling">
            <div className="pulse-dot" />
            <span>Watching for your deposit — balance updates in 3-5 seconds</span>
          </div>

          <div className="deposit-balance pixel-frame">
            <span className="label">Balance</span>
            <span className="value gold">{dollars(balance)}</span>
          </div>
          <p className="fee-note">Base Sepolia testnet · No deposit fees · 5% on withdrawals</p>
        </div>
      )}

      {/* ═══ ROUND ═══ */}
      {view === 'round' && session && (
        <div className="round-view pixel-frame">
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
          <div className="board" aria-label="Chancy 6x6 board" role="grid">
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
                  <span className="result-sub">Sent to your wallet on-chain</span>
                </>
              ) : (
                <span className="result-sub">{dollars(run.spentTotal)} spent</span>
              )}
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setView('lobby')}>Back to games →</button>
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

      {/* ── Withdraw modal (on-chain) ── */}
      {showWithdraw && (
        <div className="modal-backdrop" onClick={() => setShowWithdraw(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-handle" />
            <h2>Withdraw</h2>
            <p className="modal-sub">Withdraw USDC from your on-chain balance. 5% fee auto-sent to treasury.</p>
            <div className="pot-input-group" style={{ marginBottom: 8 }}>
              <span className="pot-prefix">$</span>
              <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} placeholder={dollars(withdrawable)} inputMode="decimal" />
            </div>
            <p className="hint-text">Available: {dollars(withdrawable)}</p>
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              setError(''); setBusy(true);
              try {
                const ethers = await import('ethers');
                const p = await getEthersProvider(wallet.walletProvider);
                const signer = await p.getSigner();
                const contract = new ethers.Contract(V3_SETTLEMENT, SETTLEMENT_ABI, signer);
                const amount = usdcUnits(withdrawAmt || withdrawable);
                sfx.click();
                const tx = await contract.withdraw(amount);
                await tx.wait();
                sfx.win();
                setShowWithdraw(false);
                refreshCredits(addr);
                setStatusMsg(`Withdrew ${dollars(amount)} (5% fee applied)`);
              } catch (e) { setError(e.message?.slice(0, 200) || 'Withdraw failed'); }
              finally { setBusy(false); }
            }}>{busy ? 'Processing…' : 'Withdraw'}</button>
            <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowWithdraw(false)}>Cancel</button>
            {error && <p className="status-text" style={{ color: '#ff6b6b' }}>{error}</p>}
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
