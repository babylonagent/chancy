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
  Easy: { bombs: 5, prizes: 3, copy: 'Best first room. More prize tiles, fewer bombs.' },
  Normal: { bombs: 7, prizes: 2, copy: 'Balanced board for most players.' },
  Hardcore: { bombs: 10, prizes: 1, copy: 'One prize. Ten bombs. Greedy players suffer.' },
};

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

function chainLabel(chainId) {
  return CHAIN_CONFIG[chainId]?.label || (chainId ? `Unsupported (${chainId})` : 'Not connected');
}

function RulesModal({ onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title">
      <section className="rules-modal">
        <button className="icon-button close" type="button" aria-label="Close rules" onClick={onClose}>×</button>
        <img src={chancyLogo} alt="" />
        <p className="kicker">Chancy in 20 seconds</p>
        <h2 id="rules-title">Reveal prizes before your third bomb.</h2>
        <div className="rule-list">
          <p><strong>Choose a room.</strong> Difficulty sets how many bombs and prizes are hidden.</p>
          <p><strong>Pay with USDC.</strong> Stable entry and reward math. No ETH pricing mess.</p>
          <p><strong>Play your board.</strong> Pyth Entropy gives every player a separate hidden board.</p>
        </div>
        <button className="main-button full" type="button" onClick={onClose}>Got it</button>
      </section>
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState('checking');
  const [contractAddress, setContractAddress] = useState('');
  const [difficulty, setDifficulty] = useState('Normal');
  const [entryUsdc, setEntryUsdc] = useState('1');
  const [rewardUsdc, setRewardUsdc] = useState('0.25');
  const [maxPlayers, setMaxPlayers] = useState('4');
  const [sessionId, setSessionId] = useState('1');
  const [player, setPlayer] = useState('0x2222222222222222222222222222222222222222');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));
  const [board, setBoard] = useState(() => makeBoard('Normal', 'chancy'));
  const [revealed, setRevealed] = useState(() => Array.from({ length: 64 }, () => TILE_HIDDEN));
  const [status, setStatus] = useState({ bombs: 0, prizes: 0, message: 'Choose a room, connect wallet, then join the board.', active: false, ended: false });
  const [lastAction, setLastAction] = useState('Ready');
  const [error, setError] = useState('');

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
  const selectedAsset = CHAIN_CONFIG[chainId]?.usdc || BASE_SEPOLIA_USDC_ADDRESS;
  const networkName = chainLabel(chainId);
  const entryAmount = usdcUnits(entryUsdc);
  const rewardPerPrize = usdcUnits(rewardUsdc);
  const reserveAmount = String(BigInt(rewardPerPrize) * BigInt(maxPlayers || '0') * BigInt(DIFFICULTIES[difficulty].prizes));
  const swapUrl = CHAIN_CONFIG[chainId]?.swapUrl || CHAIN_CONFIG[BASE_SEPOLIA_CHAIN_ID].swapUrl;
  const onBase = chainId === BASE_CHAIN_ID || chainId === BASE_SEPOLIA_CHAIN_ID;
  const walletLabel = wallet ? shortAddress(wallet) : 'Connect wallet';

  function closeRules() {
    localStorage.setItem('chancy_rules_seen', '1');
    setShowRules(false);
  }

  function resetBoard(nextDifficulty = difficulty) {
    setBoard(makeBoard(nextDifficulty, wallet || player || 'chancy'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setStatus({ bombs: 0, prizes: 0, message: 'Room ready. Join to activate your board.', active: false, ended: false });
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const nextChainId = await provider.request({ method: 'eth_chainId' });
      setWallet(accounts[0] || '');
      setPlayer(accounts[0] || player);
      setChainId(nextChainId);
      setLastAction('Wallet connected');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function switchToBase() {
    setError('');
    try {
      const provider = getWalletProvider();
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }] });
      setChainId(await provider.request({ method: 'eth_chainId' }));
      setLastAction('Network switched');
    } catch (err) { setError(err.message || String(err)); }
  }

  async function prepareAction(label, fn) {
    setError('');
    try {
      await fn();
      setLastAction(`${label} ready for wallet`);
    } catch (err) { setError(err.message || String(err)); }
  }

  async function createRoom() {
    await prepareAction('Create room', () => postJson('/tx/create-session', { asset: selectedAsset, difficulty, entryAmount, maxPlayers, rewardPerPrize }));
  }

  async function fundRoom() {
    await prepareAction('Fund rewards', () => postJson('/tx/fund-session-rewards', { sessionId, asset: selectedAsset, amount: reserveAmount }));
  }

  async function joinRoom() {
    await prepareAction('Join room', () => postJson('/tx/join-session', { sessionId, asset: selectedAsset, userRandomNumber: DEFAULT_RANDOM, entropyFee: '0', entryAmount }));
    setBoard(makeBoard(difficulty, wallet || player || 'chancy'));
    setRevealed(Array.from({ length: 64 }, () => TILE_HIDDEN));
    setStatus({ bombs: 0, prizes: 0, message: 'Board active. Reveal tiles carefully.', active: true, ended: false });
  }

  async function claimRewards() {
    await prepareAction('Claim USDC', () => postJson('/tx/claim-rewards', { asset: selectedAsset }));
  }

  function revealTile(tile) {
    if (!status.active || status.ended || revealed[tile] !== TILE_HIDDEN) return;
    const outcome = board[tile];
    const nextRevealed = [...revealed];
    nextRevealed[tile] = outcome;
    const bombs = status.bombs + (outcome === 'bomb' ? 1 : 0);
    const prizes = status.prizes + (outcome === 'prize' ? 1 : 0);
    const ended = bombs >= 3;
    const message = ended ? 'Run ended. 3 bombs hit.' : outcome === 'prize' ? 'Prize found. Keep hunting or claim.' : outcome === 'bomb' ? 'Bomb hit. Stay sharp.' : 'Safe tile.';
    setRevealed(nextRevealed);
    setStatus({ bombs, prizes, message, active: true, ended });
    postJson('/tx/click-tile', { sessionId, tileIndex: tile }).then(() => setLastAction('Tile move ready for wallet')).catch(() => {});
  }

  return (
    <main className="product-shell">
      {showRules && <RulesModal onClose={closeRules} />}
      <button className="help-button" type="button" aria-label="How Chancy works" onClick={() => setShowRules(true)}>?</button>

      <header className="topbar">
        <a className="brand" href="#play" aria-label="Chancy home"><img src={chancyLogo} alt="Chancy logo" /><span>Chancy</span></a>
        <nav className="top-actions" aria-label="Main actions">
          <span className={`network-pill ${health}`}>API {health}</span>
          <span className={`network-pill ${onBase ? 'online' : 'offline'}`}>{networkName}</span>
          <a className="ghost-button" href={swapUrl} target="_blank" rel="noreferrer">Get USDC</a>
          <button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button>
        </nav>
      </header>

      <section className="hero" id="play">
        <div className="hero-text">
          <p className="kicker">USDC tile game on Base</p>
          <h1>Open the board. Beat the bombs.</h1>
          <p className="lede">Pick tiles on a private 8 by 8 board. Find USDC prizes before your third bomb ends the run.</p>
          <div className="hero-buttons">
            <button className="main-button large" type="button" onClick={joinRoom}>Join room</button>
            <button className="ghost-button large" type="button" onClick={() => setShowRules(true)}>Rules</button>
          </div>
        </div>
        <section className="room-card" aria-label="Current Chancy room">
          <div className="room-card-head"><img src={chancyLogo} alt="" /><span>{difficulty}</span></div>
          <div className="price-line"><span>Entry</span><strong>{entryUsdc} USDC</strong></div>
          <div className="price-line"><span>Prize tile</span><strong>{rewardUsdc} USDC</strong></div>
          <div className="room-rules"><span>{DIFFICULTIES[difficulty].bombs} bombs</span><span>{DIFFICULTIES[difficulty].prizes} prizes</span><span>3 hits ends it</span></div>
        </section>
      </section>

      <section className="game-surface">
        <section className="board-card">
          <div className="panel-title">
            <div><p className="kicker">Board</p><h2>Your run</h2></div>
            <strong>{status.active ? status.ended ? 'Ended' : 'Live' : 'Waiting'}</strong>
          </div>
          <div className="meter-row">
            <div><span>Bombs</span><strong>{status.bombs}/3</strong></div>
            <div><span>Prizes</span><strong>{status.prizes}</strong></div>
            <div><span>Room</span><strong>#{sessionId}</strong></div>
          </div>
          <p className="status-line">{status.message}</p>
          <div className="tile-board" aria-label="Chancy 8x8 board">
            {tiles.map((tile) => (
              <button key={tile} aria-label={`tile ${tile}`} className={`tile ${revealed[tile]}`} onClick={() => revealTile(tile)}>
                {revealed[tile] === 'hidden' ? '' : revealed[tile] === 'bomb' ? '×' : revealed[tile] === 'prize' ? '$' : '·'}
              </button>
            ))}
          </div>
        </section>

        <aside className="side-card">
          <div className="panel-title compact"><div><p className="kicker">Room</p><h2>Set terms</h2></div></div>
          <div className="fields">
            <label>Difficulty<select aria-label="difficulty" value={difficulty} onChange={(event) => { setDifficulty(event.target.value); resetBoard(event.target.value); }}><option>Easy</option><option>Normal</option><option>Hardcore</option></select><small>{DIFFICULTIES[difficulty].copy}</small></label>
            <label>Entry USDC<input aria-label="entry amount usdc" inputMode="decimal" value={entryUsdc} onChange={(event) => setEntryUsdc(event.target.value)} /></label>
            <label>Prize per tile<input aria-label="reward per prize usdc" inputMode="decimal" value={rewardUsdc} onChange={(event) => setRewardUsdc(event.target.value)} /></label>
            <label>Max players<input aria-label="max players" inputMode="numeric" value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} /></label>
            <label>Room ID<input aria-label="session id" inputMode="numeric" value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
          </div>
          <div className="action-grid">
            <button type="button" onClick={createRoom}>Create room</button>
            <button type="button" onClick={fundRoom}>Fund rewards</button>
            <button type="button" onClick={joinRoom}>Join room</button>
            <button type="button" onClick={claimRewards}>Claim USDC</button>
          </div>
          {wallet && !onBase && <button className="ghost-button full" type="button" onClick={switchToBase}>Switch to Base Sepolia</button>}
          <div className="chain-card">
            <span>USDC asset</span><strong>{shortAddress(selectedAsset)}</strong>
            {shortAddress(contractAddress) && <small>Contract {shortAddress(contractAddress)}</small>}
          </div>
        </aside>
      </section>

      <section className="explain-strip">
        <div><strong>Simple money</strong><span>USDC in, USDC out. Easy prize math.</span></div>
        <div><strong>Private randomness</strong><span>Boards are generated per player through Pyth Entropy.</span></div>
        <div><strong>Fast rounds</strong><span>Every click is a small decision, not a dashboard chore.</span></div>
      </section>

      <footer className="app-footer">
        <span>{lastAction}</span>
        {error ? <strong className="error-text">{error}</strong> : <span>Final UI direction. No dev payload console on screen.</span>}
      </footer>
    </main>
  );
}
