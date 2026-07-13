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

// ─── BLOCKS (game board tiles) ────────────────────────────────────────
import blockImg from './assets/pixel/block.png';
import blockPressedImg from './assets/pixel/block_pressed.png';

// ─── MISC BUTTON (3-slice: presets + back) ─────────────────────────────
import miscLeft from './assets/pixel/misc-left.png';
import miscBody from './assets/pixel/misc-body.png';
import miscRight from './assets/pixel/misc-right.png';

// ─── ICON BUTTONS (sound, power, help) ──────────────────────────────────────
import soundOnIcon from './assets/pixel/icons/sound-on.png';
import soundOffIcon from './assets/pixel/icons/sound-off.png';
import powerButtonIcon from './assets/pixel/icons/power-button.png';
import helpButtonIcon from './assets/pixel/icons/help-button.png';
import notifBellIcon from './assets/pixel/buttons/notif-bell.png';

// ─── V3 CONTRACT CONFIG ─────────────────────────────────────────────────────
const V3_SETTLEMENT = '0x3A202177b415b04c8adbfbC1a79f22b36a0C7102';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC native on Base mainnet
const CHAIN_ID = 8453;

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
        <div className="rule-item pixel-frame">
          <div className="rule-icon gold">$</div>
          <div className="rule-text"><strong>Add credits</strong><span>Send USDC to your deposit address. Credits appear in seconds.</span></div>
        </div>
        <div className="rule-item pixel-frame">
          <div className="rule-icon blue">◉</div>
          <div className="rule-text"><strong>Host or join</strong><span>Hosts lock a pot. Players pay $0.05 to join and reveal tiles.</span></div>
        </div>
        <div className="rule-item pixel-frame">
          <div className="rule-icon green">★</div>
          <div className="rule-text"><strong>Find all prizes</strong><span>Tiles cost more as you go. Collect every prize to sweep the pot.</span></div>
        </div>
        <div className="rule-item pixel-frame">
          <div className="rule-icon red">✺</div>
          <div className="rule-text"><strong>Dodge bombs</strong><span>Three bombs ends your run. Quit or bomb out and you lose everything. Sweep all prizes to win the pot.</span></div>
        </div>
        <button className="btn btn-primary" data-sfx-back onClick={onClose} style={{ marginTop: 16, margin: '16px auto 0', display: 'flex' }}>Got it</button>
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
          <h3 className="api-h3">Contract Addresses (Base Mainnet)</h3>
          <div className="api-contracts">
            <div className="api-contract"><span className="api-contract-label">Settlement V3</span><code>0x3A202177b415b04c8adbfbC1a79f22b36a0C7102</code></div>
            <div className="api-contract"><span className="api-contract-label">USDC</span><code>0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code></div>
            <div className="api-contract"><span className="api-contract-label">Treasury (5% fee)</span><code>0x1DDc99B09512EbD58f65B91DbaddCd252Bd2e58e</code></div>
          </div>
        </div>

        <div className="api-section">
          <h3 className="api-h3">Quick Start</h3>
          <pre className="api-code-block">{`# 1. Approve USDC for the settlement contract
# 2. Call createGame() or joinGame() on-chain
# 3. POST /v3/sessions/:gameId/click to reveal tiles
# 4. Settler bot settles on-chain — 5% fee auto-sent to treasury

# Full ABI: see Contract Addresses above
# Chain: Base Mainnet (8453)`}</pre>
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

  // Notifications
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);

  // Deposit
  const [vaultAddress] = useState(V3_SETTLEMENT);
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
  const [sessionToken, setSessionToken] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [run, setRun] = useState({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
  const [proof, setProof] = useState(null);
  const [showProof, setShowProof] = useState(false);

  // Withdraw
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [withdrawSuccess, setWithdrawSuccess] = useState('');

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [quitting, setQuitting] = useState(false);
  const [muted, setMuted] = useState(false); // matches sound.js default (unmuted)

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

  // ── Theme: dark only ──
  useEffect(() => { document.documentElement.setAttribute('data-theme', 'dark'); }, []);

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
      if (e.target.closest('button, .balance-pill, .preset-chip, .mode-tab, .your-address-card, .vault-address-card, .tile, .help-btn')) {
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
      const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
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

  // ── Auto-poll balance on lobby + deposit (deposit shows instantly) ──
  useEffect(() => {
    if (!addr) return;
    if (view !== 'lobby' && view !== 'deposit') return;
    const interval = setInterval(() => refreshCredits(addr), 5000);
    return () => clearInterval(interval);
  }, [view, addr, refreshCredits]);
  useEffect(() => {
    if (view !== 'lobby') return;
    const interval = setInterval(() => refreshSessions(), 8000);
    return () => clearInterval(interval);
  }, [view, refreshSessions]);

  useEffect(() => { if (addr) refreshCredits(addr); }, [addr, refreshCredits]);

  // ── Notifications: fetch + poll ──
  const refreshNotifications = useCallback(async () => {
    if (!addr) return;
    try {
      const [list, unread] = await Promise.all([
        getJson(`/v3/notifications/${addr}`),
        getJson(`/v3/notifications/${addr}/unread`),
      ]);
      setNotifications(list?.notifications || []);
      setUnreadCount(unread?.count || 0);
    } catch { /* engine may be down */ }
  }, [addr]);

  useEffect(() => {
    if (!addr || view === 'splash') return;
    refreshNotifications();
    const interval = setInterval(refreshNotifications, 15000);
    return () => clearInterval(interval);
  }, [addr, view, refreshNotifications]);

  // ── Auto-poll balance while on deposit page ── (single consolidated effect)
  useEffect(() => {
    if (view !== 'deposit' || !addr) return;
    setPreDepositBalance(balance);
    const interval = setInterval(async () => {
      const bal = await refreshCredits(addr);
      if (preDepositBalance && BigInt(bal) > BigInt(preDepositBalance)) {
        sfx.win();
        const gained = (BigInt(bal) - BigInt(preDepositBalance)).toString();
        setStatusMsg(`+${dollars(gained)} received!`);
        // Deposit notification handled by engine indexer — skip API POST
        refreshNotifications();
        setTimeout(() => { setView('lobby'); setStatusMsg(''); }, 2000);
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [view, addr, balance, refreshCredits, refreshNotifications]); // eslint-disable-line react-hooks/exhaustive-deps

  async function markNotifsRead() {
    if (!addr) return;
    try { await postJson(`/v3/notifications/${addr}/read`, {}); } catch {}
    setUnreadCount(0);
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }

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
      const ethers = await import('ethers');
      const browserProvider = await getEthersProvider(wallet.walletProvider);
      if (!browserProvider) { await copyVaultAddress(); setPollingDeposit(true); return; }
      const signer = await browserProvider.getSigner();
      const usdc = new ethers.Contract(USDC_ADDRESS, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
      // Prompt user for amount
      const amountStr = window.prompt('Enter USDC amount to deposit (e.g. 5):');
      if (!amountStr) return;
      const amount = ethers.parseUnits(amountStr, 6).toString();
      setStatusMsg('Sending USDC...');
      const tx = await usdc.transfer(V3_SETTLEMENT, amount);
      await tx.wait();
      setPollingDeposit(true);
      setStatusMsg('Deposit sent — waiting for confirmation...');
    } catch (err) {
      if (err.code !== 4001 && err.code !== 'ACTION_REJECTED') {
        await copyVaultAddress();
        setStatusMsg('Address copied — send USDC from your wallet');
        setPollingDeposit(true);
      }
    }
  }

  // (Deposit polling handled by consolidated effect above)

  // ── HOST: CREATE (V3 on-chain) ──
  async function hostCreateSession() {
    setError('');
    const pot = usdcUnits(potAmt);
    if (BigInt(pot) < 5_000_000n) { setError('Minimum pot is $5.'); return; }
    if (BigInt(pot) > BigInt(balance)) { setError('Not enough USDC in your balance.'); return; }
    setBusy(true); setStatusMsg('Creating game…');

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

      // Generate host secret + commitment
      const hostSecret = randomEntropy();
      const hostCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [hostSecret]));
      try { localStorage.setItem(`chancy_v3_host_secret_${addr}`, hostSecret); } catch {}

      // Create game on-chain — user signs directly
      sfx.click();
      setStatusMsg('Confirm in wallet…');
      const tx = await contract.createGame(difficultyEnum, pot, hostCommitment);
      const receipt = await tx.wait();

      // Parse GameCreated event for gameId
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

      // POST host secret to engine so settler bot can activate
      setStatusMsg('Registering host secret…');
      try {
        await postJson(`/v3/sessions/${gameId}/host-secret`, {
          hostSecret,
          host: addr,
          difficulty: difficultyEnum,
          prizePot: pot,
        });
      } catch (err) {
        console.warn('host-secret POST failed:', err);
      }

      setStatusMsg(`Game #${gameId} live`);
      sfx.win();
      setView('lobby');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
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
    setBusy(true); setStatusMsg('Joining game…');
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

      // Generate player commitment
      const playerRandom = randomEntropy();
      const playerCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32'], [playerRandom]));
      const gameId = sess.gameId || sess.sessionId;

      // Join game on-chain — user signs directly
      sfx.click();
      setStatusMsg('Confirm in wallet…');
      const tx = await contract.joinGame(gameId, playerCommitment, maxSpend);
      await tx.wait();

      // Store playerRandom in engine so settler bot can request Pyth randomness
      try {
        await postJson(`/v3/sessions/${gameId}/player-random`, { playerRandom });
      } catch (err) {
        console.warn('player-random POST failed:', err);
      }

      // Set up round state and switch to round view
      const mode = sess.mode || V3_DIFFICULTY_TO_MODE[Number(sess.difficulty)] || 'Normal';
      const prizePot = sess.prizePot;
      setSession({ sessionId: gameId, gameId, mode, prizePot, maxSpend });
      setRevealed({});
      setRun({ bombsHit: 0, prizesFound: 0, status: 'activating', spentTotal: '0', prizeEarned: '0', nextTileCost: v3RevealCostAt(prizePot, mode, 0).toString() });
      setView('round');
      setStatusMsg('Waiting for settler bot to activate…');
      sfx.win();

      // Poll for activation
      const pollActivation = async () => {
        for (let i = 0; i < 60; i++) {
          try {
            const state = await getJson(`/v3/sessions/${gameId}/state`);
            if (state && state.status === 'active') {
              // Fetch token from authenticated endpoint (not leaked in state)
              try {
                const tokenResp = await getJson(`/v3/sessions/${gameId}/token?player=${addr}`);
                setSessionToken(tokenResp.sessionToken);
              } catch { /* token fetch will retry */ }
              setRun((prev) => ({ ...prev, status: 'active' }));
              setStatusMsg('');
              return;
            }
          } catch { /* engine may not have it yet */ }
          await new Promise((r) => setTimeout(r, 2000));
        }
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
      const result = await postJson(`/v3/sessions/${session.sessionId}/click`, { player: addr, tile: tileIndex0, token: sessionToken });
      // V3 result shape: { tile, type: 'bomb'|'prize'|'empty', bombsHit, prizesFound, totalPrizes, spent, gameOver, outcome }
      const tileKey = tile; // keep 1-based for display
      const tileState = result.type === 'bomb' ? 'bomb' : result.type === 'prize' ? 'prize' : 'empty';
      setRevealed((prev) => ({ ...prev, [tileKey]: tileState }));

      const newSpent = result.spent || run.spentTotal;
      const newBombs = result.bombsHit ?? run.bombsHit;
      const newPrizes = result.prizesFound ?? run.prizesFound;
      // nextTileCost: use result.clickIndex (server's authoritative count) instead of stale revealed
      const nextIdx = result.clickIndex !== undefined ? result.clickIndex + 1 : (Object.keys(revealed).length + 1);
      const nextCost = v3RevealCostAt(session.prizePot, session.mode, nextIdx).toString();

      if (result.gameOver) {
        if (result.proof) setProof(result.proof);
        if (result.outcome === 'win') {
          setRun({ bombsHit: newBombs, prizesFound: newPrizes, status: 'won', spentTotal: newSpent, prizeEarned: session.prizePot, nextTileCost: '0' });
          setStatusMsg(`Won ${dollars(session.prizePot)}!`);
          sfx.win();
        } else if (result.outcome === 'loss') {
          setRun({ bombsHit: newBombs, prizesFound: newPrizes, status: 'lost', spentTotal: newSpent, prizeEarned: '0', nextTileCost: '0' });
          setStatusMsg('Game over — 3 bombs');
          sfx.bomb();
        } else if (result.outcome === 'quit' || result.type === 'budget_exhausted') {
          setRun({ bombsHit: newBombs, prizesFound: newPrizes, status: 'lost', spentTotal: newSpent, prizeEarned: '0', nextTileCost: '0' });
          setStatusMsg('Budget exhausted — game over');
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
        const final = await postJson(`/v3/sessions/${session.sessionId}/quit`, { player: addr, token: sessionToken });
        if (final.proof) setProof(final.proof);
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
      setSession(null); setSessionToken(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setProof(null);
      setShowProof(false);
      setView('lobby');
      setStatusMsg('');
      await refreshCredits(addr);
      await refreshSessions();
    } catch (err) {
      // Even on error, refresh — on-chain state is the source of truth
      await refreshCredits(addr);
      await refreshSessions();
      setSession(null); setSessionToken(null);
      setRun({ bombsHit: 0, prizesFound: 0, status: 'idle', spentTotal: '0', prizeEarned: '0', nextTileCost: '0' });
      setProof(null);
      setShowProof(false);
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
      setSession(null); setSessionToken(null); setStatusMsg(''); setError('');
      setView('lobby');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className={`app ${view === 'splash' ? 'landing-mode' : ''}`} style={{ '--frame-gold': `url(${frameGold})`, '--frame-dark': `url(${frameDark})`, '--frame-green': `url(${frameGreen})`, '--frame-red': `url(${frameRed})`, '--btn-gold-up': `url(${btnGoldRaised})`, '--btn-gold-down': `url(${btnGoldPressed})`, '--btn-dark-up': `url(${btnDarkRaised})`, '--btn-dark-down': `url(${btnDarkPressed})`, '--btn-green-up': `url(${btnGreenRaised})`, '--btn-green-down': `url(${btnGreenPressed})`, '--btn-red-up': `url(${btnRedRaised})`, '--btn-red-down': `url(${btnRedPressed})`, '--orange-left': `url(${orangeBtnLeft})`, '--orange-left-pressed': `url(${orangeBtnLeftPressed})`, '--orange-body': `url(${orangeBtnBody})`, '--orange-body-pressed': `url(${orangeBtnBodyPressed})`, '--orange-right': `url(${orangeBtnRight})`, '--orange-right-pressed': `url(${orangeBtnRightPressed})`, '--teal-left': `url(${tealBtnLeft})`, '--teal-left-pressed': `url(${tealBtnLeftPressed})`, '--teal-body': `url(${tealBtnBody})`, '--teal-body-pressed': `url(${tealBtnBodyPressed})`, '--teal-right': `url(${tealBtnRight})`, '--teal-right-pressed': `url(${tealBtnRightPressed})`, '--tf-9slice': `url(${tf9slice})`, '--tf-center': `url(${tfCenterTile})`, '--block-img': `url(${blockImg})`, '--block-pressed': `url(${blockPressedImg})`, '--misc-left': `url(${miscLeft})`, '--misc-body': `url(${miscBody})`, '--misc-right': `url(${miscRight})` }}>
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
            <button className="icon-btn sound-btn" data-no-sfx onClick={toggleMute} title={muted ? 'Unmute sound' : 'Mute sound'} aria-label="Toggle sound">
              <img src={muted ? soundOffIcon : soundOnIcon} alt={muted ? 'Sound off' : 'Sound on'} />
            </button>
            {view !== 'splash' && (
              <button className="icon-btn help-btn" onClick={() => setShowRules(true)} aria-label="Help"><img src={helpButtonIcon} alt="Help" /></button>
            )}
            {view !== 'splash' && isConnected && (
              <button className="icon-btn notif-btn" onClick={() => { setShowNotifs(true); if (unreadCount > 0) markNotifsRead(); }} aria-label="Notifications" title="Notifications">
                <img src={notifBellIcon} alt="Notifications" style={{ width: 40, height: 40, imageRendering: 'pixelated' }} />
                {unreadCount > 0 && (
                  <span style={{
                    position: 'absolute', top: 2, right: 2,
                    background: 'var(--red)', color: '#fff',
                    fontSize: '10px', fontWeight: 700, minWidth: '16px', height: '16px',
                    borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '0 4px', border: '1px solid var(--bg)',
                  }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
                )}
              </button>
            )}
            {isConnected && !isPlaying && !isFarcaster && (
              <button className="icon-btn power-btn" onClick={disconnect} title="Disconnect" aria-label="Disconnect wallet">
                <img src={powerButtonIcon} alt="Power" />
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
              <div className="how-step pixel-frame">
                <div className="step-num">1</div>
                <div className="step-body">
                  <strong>Host creates</strong>
                  <p>Lock a prize pot in USDC. Pick difficulty. Earn when players fail.</p>
                </div>
              </div>
              <div className="how-step pixel-frame">
                <div className="step-num">2</div>
                <div className="step-body">
                  <strong>Player joins</strong>
                  <p>Pay a small entry. Reveal tiles one by one. Each tile costs more than the last.</p>
                </div>
              </div>
              <div className="how-step pixel-frame">
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
              <div className="mode-info-card easy pixel-frame">
                <span className="mode-name">Easy</span>
                <span className="mode-stats">3 bombs · 3 prizes</span>
                <span className="mode-desc">More prizes, fewer bombs. Higher chance to sweep.</span>
              </div>
              <div className="mode-info-card normal pixel-frame">
                <span className="mode-name">Normal</span>
                <span className="mode-stats">4 bombs · 2 prizes</span>
                <span className="mode-desc">Balanced risk. Standard payouts.</span>
              </div>
              <div className="mode-info-card hardcore pixel-frame">
                <span className="mode-name">Hardcore</span>
                <span className="mode-stats">6 bombs · 1 prize</span>
                <span className="mode-desc">One prize, maximum bombs. Highest reward.</span>
              </div>
            </div>
          </div>

          {/* Trust signals */}
          <div className="landing-section">
            <div className="trust-row">
              <div className="trust-item pixel-frame">
                <img className="trust-icon" src={iconChain} alt="" />
                <span>Onchain randomness via Pyth Entropy</span>
              </div>
              <div className="trust-item pixel-frame">
                <img className="trust-icon" src={iconLock} alt="" />
                <span>Onchain settlement — send USDC, play on-chain</span>
              </div>
              <div className="trust-item pixel-frame">
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
              <div className="trust-item pixel-frame">
                <img className="trust-icon" src={iconRobot} alt="" />
                <span>REST API — Full game loop via /v3/ endpoints, agent-ready</span>
              </div>
              <div className="trust-item pixel-frame">
                <img className="trust-icon" src={iconBolt} alt="" />
                <span>On-chain escrow — Approve USDC, contract holds funds, trustless settlement</span>
              </div>
              <div className="trust-item pixel-frame">
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
              <button className="btn btn-primary btn-sm" onClick={() => { setPreDepositBalance(balance); setView('deposit'); }}>Add USDC</button>
              <button className="btn btn-secondary btn-sm" disabled={busy || BigInt(balance) <= 0n} onClick={() => { setWithdrawAmt(''); setShowWithdraw(true); }}>Withdraw</button>
            </div>
            <p className="hint-text">Send USDC to the contract — balance updates in 3-5 seconds</p>
          </div>

          <div className="lobby-section-header">
            <span className="section-title">Open games</span>
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
            <button className="btn btn-primary" style={{ width: 'auto', maxWidth: '70%' }} onClick={() => setView('host')}>Host a game</button>
          </div>
          {statusMsg && <p className="status-text">{statusMsg}</p>}
        </div>
      )}

      {/* ═══ HOST ═══ */}
      {view === 'host' && isConnected && (
        <div className="host-view pixel-frame">
          <div className="lobby-section-header">
            <button className="misc-btn back-btn" data-sfx-back onClick={() => setView('lobby')}>← Back</button>
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
              <button key={p} className={`misc-btn preset-chip ${potAmt === p ? 'selected' : ''}`} onClick={() => setPotAmt(p)}>${p}</button>
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
            <button className="misc-btn back-btn" data-sfx-back onClick={() => { setPollingDeposit(false); setView('lobby'); }}>← Back</button>
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
          <p className="fee-note">Base Mainnet · No deposit fees · 5% on withdrawals</p>
        </div>
      )}

      {/* ═══ ROUND ═══ */}
      {view === 'round' && session && (
        <div className="round-view pixel-frame">
          <div className="round-header">
            <button className="misc-btn back-btn" data-sfx-back onClick={quitRound} disabled={quitting}>
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
              {proof && (
                <button className="misc-btn" style={{ marginTop: 8, fontSize: 8 }} onClick={() => setShowProof(!showProof)}>
                  {showProof ? 'Hide' : 'Show'} Provably Fair Proof
                </button>
              )}
              {proof && showProof && (
                <div className="pixel-frame proof-panel" style={{ marginTop: 8, padding: 10, textAlign: 'left', fontSize: 8, fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: 1.6 }}>
                  <div><strong>Pyth Random:</strong></div>
                  <div style={{ opacity: 0.8 }}>{proof.pythRandom || proof.pythRandomNumber || '—'}</div>
                  {proof.hostSecret && (
                    <>
                      <div style={{ marginTop: 4 }}><strong>Host Secret:</strong></div>
                      <div style={{ opacity: 0.8 }}>{proof.hostSecret}</div>
                    </>
                  )}
                  <div style={{ marginTop: 4 }}><strong>Board Seed:</strong></div>
                  <div style={{ opacity: 0.8 }}>{proof.boardSeed || '—'}</div>
                  <div style={{ marginTop: 4 }}><strong>Game ID:</strong> {proof.gameId || proof.sessionId}</div>
                  <div><strong>Mode:</strong> {proof.difficulty || proof.mode}</div>
                  <div style={{ marginTop: 4 }}><strong>Bombs:</strong> [{proof.board?.bombPositions?.join(', ') || proof.board?.bombPositions?.join(', ')}]</div>
                  <div><strong>Prizes:</strong> [{proof.board?.prizePositions?.join(', ') || proof.board?.prizePositions?.join(', ')}]</div>
                  <div style={{ marginTop: 6, opacity: 0.6 }}>
                    Verify: re-derive board from seed via keccak256(encodePacked(seed, "BOMB"/"PRIZE", nonce)) % 64
                  </div>
                </div>
              )}
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

      {showRules && <RulesSheet onClose={closeRules} />}
      {showApiDocs && <ApiDocsSheet onClose={() => setShowApiDocs(false)} />}

      {/* ═══ NOTIFICATIONS PANEL ═══ */}
      {showNotifs && (
        <div className="modal-backdrop" onClick={() => setShowNotifs(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-handle" />
            <h2>Notifications</h2>
            {notifications.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 20px' }}>
                <p>No activity yet.<br/>Play a game to see events here.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
                {notifications.map(n => (
                  <div key={n.id} className="pixel-frame" style={{ padding: '12px 14px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                    <div style={{
                      width: '32px', height: '32px', borderRadius: '6px', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px',
                      background: n.type === 'game_won' ? 'var(--green-dim)' :
                                   n.type === 'game_lost' || n.type === 'pot_loss' ? 'var(--red-dim)' :
                                   n.type === 'deposit' ? 'var(--accent-dim)' :
                                   n.type === 'withdrawal' ? 'rgba(100,160,255,0.12)' : 'var(--bg-elevated)',
                      color: n.type === 'game_won' ? 'var(--green)' :
                             n.type === 'game_lost' || n.type === 'pot_loss' ? 'var(--red)' :
                             n.type === 'deposit' ? 'var(--accent)' :
                             n.type === 'withdrawal' ? '#64a0ff' : 'var(--text-dim)',
                    }}>
                      {n.type === 'game_won' ? '🏆' :
                       n.type === 'game_lost' ? '💥' :
                       n.type === 'game_quit' ? '🏳' :
                       n.type === 'deposit' ? '↓' :
                       n.type === 'withdrawal' ? '↑' :
                       n.type === 'pot_loss' ? '📉' :
                       n.type === 'pot_earned' ? '📈' : '•'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: '14px' }}>{n.title}</strong>
                        {!n.read && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />}
                      </div>
                      {n.body && <p style={{ color: 'var(--text-dim)', fontSize: '13px', lineHeight: 1.4, marginTop: 2 }}>{n.body}</p>}
                      <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                        {n.amount && <span className="stat-chip" style={{ fontSize: 11 }}>{dollars(n.amount)}</span>}
                        <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                          {new Date(n.createdAt + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => setShowNotifs(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
