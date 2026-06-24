import React, { useCallback, useEffect, useMemo, useState } from 'react';
import chancyLogo from './assets/chancy-logo.svg';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const BASE_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SEPOLIA_USDC_ADDRESS = import.meta.env?.VITE_CHANCY_BASE_SEPOLIA_USDC_ADDRESS || '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

const BASE_CHAIN_ID = '0x2105';        // Base mainnet (8453)
const BASE_SEPOLIA_CHAIN_ID = '0x14a34'; // Base Sepolia (84532)
// Which Base network this build targets. Default Base Sepolia until mainnet cutover.
const TARGET_CHAIN_ID = (import.meta.env?.VITE_CHANCY_CHAIN_ID || BASE_SEPOLIA_CHAIN_ID).toLowerCase();

const USDC_DECIMALS = 1_000_000n;
const STAKE_UNITS = '50000'; // $0.05 session entry, debited from credits — no wallet tx.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// House/host for credit sessions. Configurable; falls back to the player so the
// engine always has a valid host without exposing protocol plumbing to players.
const GAME_HOST = import.meta.env?.VITE_CHANCY_GAME_HOST || '';

const CHAIN_PARAMS = {
  [BASE_CHAIN_ID]: {
    chainId: BASE_CHAIN_ID,
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    chainName: 'Base Sepolia',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://sepolia.base.org'],
    blockExplorerUrls: ['https://sepolia.basescan.org'],
  },
};

const MODES = {
  Easy: { bombs: 3, prizes: 5, multiplier: '2.5', copy: '3 bombs, 5 prizes. Find all 5 prizes to win.' },
  Normal: { bombs: 5, prizes: 3, multiplier: '5.3', copy: '5 bombs, 3 prizes. Balanced risk.' },
  Hardcore: { bombs: 9, prizes: 2, multiplier: '8.7', copy: '9 bombs, 2 prizes. Sharp teeth, big payout.' },
};

const TILES = Array.from({ length: 64 }, (_, i) => i + 1); // tiles are 1-indexed (1..64)

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
  if (!window.ethereum) throw new Error('No wallet found. Install a supported wallet first.');
  return window.ethereum;
}
function shortAddress(address) {
  return !address || /^0x0{40}$/i.test(address) ? '' : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function RulesModal({ onClose }) {
  // Lock body scroll while the modal is open (mobile fix).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title" onClick={onClose}>
    <section className="rules-modal" onClick={(event) => event.stopPropagation()}>
      <button className="icon-button close" type="button" aria-label="Close rules" onClick={onClose}>×</button>
      <img src={chancyLogo} alt="" />
      <p className="kicker">Chancy in 20 seconds</p>
      <h2 id="rules-title">Find the prizes before your third bomb.</h2>
      <div className="rule-list">
        <p><strong>Add credits once.</strong> Top up USDC and play as long as you like — no pop-ups mid-game.</p>
        <p><strong>Each round costs $0.05.</strong> Reveal tiles one at a time looking for prizes.</p>
        <p><strong>Easy</strong> has 3 bombs and 5 prizes. <strong>Normal</strong> 5 bombs, 3 prizes. <strong>Hardcore</strong> 9 bombs, 2 prizes.</p>
        <p><strong>Win the round</strong> by uncovering every prize. Three bombs ends the run. Cash out your credits any time.</p>
      </div>
      <button className="main-button full" type="button" onClick={onClose}>Got it</button>
    </section>
  </div>;
}

export default function App() {
  const [view, setView] = useState('landing'); // landing | play | round
  const [health, setHealth] = useState('checking');
  const [wallet, setWallet] = useState('');
  const [chainId, setChainId] = useState('');
  const [showRules, setShowRules] = useState(() => !localStorage.getItem('chancy_rules_seen'));

  const [mode, setMode] = useState('Normal');
  const [depositUsdc, setDepositUsdc] = useState('5');
  const [withdrawUsdc, setWithdrawUsdc] = useState('');

  const [balance, setBalance] = useState('0');       // total credits (6-dec USDC units)
  const [withdrawable, setWithdrawable] = useState('0');

  const [session, setSession] = useState(null); // { sessionId, mode }
  const [revealed, setRevealed] = useState({});  // { [tile]: 'empty'|'prize'|'bomb' }
  const [run, setRun] = useState({ bombsHit: 0, prizesCollected: 0, status: 'idle', payout: '0' });

  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState('Ready');
  const [error, setError] = useState('');

  const host = GAME_HOST || wallet || ZERO_ADDRESS;
  const targetLabel = CHAIN_PARAMS[TARGET_CHAIN_ID]?.chainName || 'Base';
  const onTargetChain = chainId.toLowerCase() === TARGET_CHAIN_ID;
  const modeConfig = MODES[mode];
  const potentialWin = (BigInt(STAKE_UNITS) * BigInt(Math.round(parseFloat(modeConfig.multiplier) * 10)) / 10n).toString();

  useEffect(() => {
    getJson('/health').then((data) => setHealth(data.ok ? 'online' : 'offline')).catch(() => setHealth('offline'));
  }, []);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const handleAccounts = (accounts) => setWallet(accounts?.[0] || '');
    const handleChain = (next) => setChainId(next || '');
    window.ethereum.request({ method: 'eth_accounts' }).then(handleAccounts).catch(() => {});
    window.ethereum.request({ method: 'eth_chainId' }).then(handleChain).catch(() => {});
    window.ethereum.on?.('accountsChanged', handleAccounts);
    window.ethereum.on?.('chainChanged', handleChain);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', handleAccounts);
      window.ethereum.removeListener?.('chainChanged', handleChain);
    };
  }, []);

  const refreshCredits = useCallback(async (address) => {
    const player = address || wallet;
    if (!player) return '0';
    try {
      const data = await getJson(`/v2/credits/${player}`);
      setBalance(data.balance || '0');
      setWithdrawable(data.withdrawable || '0');
      return data.balance || '0';
    } catch { return '0'; /* balance stays as-is on transient failure */ }
  }, [wallet]);

  useEffect(() => { if (wallet) refreshCredits(wallet); }, [wallet, refreshCredits]);

  function closeRules() { localStorage.setItem('chancy_rules_seen', '1'); setShowRules(false); }

  async function ensureTargetChain(provider) {
    const current = await provider.request({ method: 'eth_chainId' });
    if (current?.toLowerCase() === TARGET_CHAIN_ID) return;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_ID }] });
    } catch (err) {
      if (err?.code === 4902 && CHAIN_PARAMS[TARGET_CHAIN_ID]) {
        await provider.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[TARGET_CHAIN_ID]] });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_ID }] });
      } else {
        throw err;
      }
    }
    setChainId(TARGET_CHAIN_ID);
  }

  async function connectWallet() {
    setError('');
    try {
      const provider = getWalletProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const next = accounts[0] || '';
      setWallet(next);
      await ensureTargetChain(provider);
      setLastAction('Wallet connected');
      await refreshCredits(next);
      return next;
    } catch (err) {
      setError(err.message || String(err));
      return '';
    }
  }

  async function depositCredits() {
    setError('');
    const amount = usdcUnits(depositUsdc);
    if (BigInt(amount) <= 0n) { setError('Enter an amount to add.'); return; }
    setBusy(true);
    try {
      const provider = getWalletProvider();
      const player = wallet || await connectWallet();
      if (!player) return;
      await ensureTargetChain(provider);
      setLastAction('Approving USDC…');
      const approveTx = await postJson('/v2/tx/approve-usdc', { amount });
      await provider.request({ method: 'eth_sendTransaction', params: [{ from: player, to: approveTx.to, data: approveTx.data, value: approveTx.value || '0x0' }] });
      setLastAction('Depositing…');
      const depositTx = await postJson('/v2/tx/deposit', { amount });
      const txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: player, to: depositTx.to, data: depositTx.data, value: depositTx.value || '0x0' }] });
      setLastAction('Confirming credits…');
      // Server reads the on-chain receipt and credits the real net amount. We send only the txHash.
      const credit = await postJson('/v2/credits/deposit', { player, txHash });
      setBalance(credit.balance || '0');
      await refreshCredits(player);
      setLastAction(`Credits added — balance ${dollars(credit.balance || '0')}`);
    } catch (err) {
      setError(err.message || String(err));
      setLastAction('Deposit failed');
    } finally {
      setBusy(false);
    }
  }

  async function startRound() {
    setError('');
    const player = wallet || await connectWallet();
    if (!player) return;
    // Read fresh balance — local state may lag the async credit load after connect.
    const freshBalance = await refreshCredits(player);
    if (BigInt(freshBalance) < BigInt(STAKE_UNITS)) { setError('Not enough credits — add at least $0.05.'); return; }
    setBusy(true);
    try {
      // Server-side session. Debits $0.05 from credits. No wallet tx, no pop-up.
      const created = await postJson('/v2/sessions', {
        player,
        host: host === ZERO_ADDRESS ? player : host,
        mode,
        stake: STAKE_UNITS,
        entropy: randomEntropy(),
      });
      setSession({ sessionId: created.sessionId, mode });
      setRevealed({});
      setRun({ bombsHit: 0, prizesCollected: 0, status: 'active', payout: '0' });
      setView('round');
      setLastAction(`Round started — ${mode}`);
      await refreshCredits(player);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clickTile(tile) {
    if (!session || run.status !== 'active' || revealed[tile] || busy) return;
    setBusy(true);
    try {
      // No wallet tx. Pure server call.
      const result = await postJson(`/v2/sessions/${session.sessionId}/click`, { player: wallet, tile });
      setRevealed((prev) => ({ ...prev, [result.tile]: result.outcome }));
      setRun({ bombsHit: result.bombsHit, prizesCollected: result.prizesCollected, status: result.status, payout: result.payout });
      if (result.status === 'won') {
        setLastAction(`You win — ${dollars(result.payout)} credited!`);
        await refreshCredits(wallet);
      } else if (result.status === 'lost') {
        setLastAction('Three bombs — run over.');
      } else if (result.outcome === 'prize') {
        setLastAction('Prize found!');
      } else if (result.outcome === 'bomb') {
        setLastAction(`Bomb — ${result.bombsHit}/3.`);
      } else {
        setLastAction('Empty tile.');
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function endRound() {
    if (session) {
      try {
        const final = await postJson(`/v2/sessions/${session.sessionId}/exit`, { player: wallet });
        // Reveal the full board so the player sees what was where.
        if (final.board) {
          const full = {};
          (final.board.bombPositions || []).forEach((t) => { full[t] = 'bomb'; });
          (final.board.prizePositions || []).forEach((t) => { full[t] = 'prize'; });
          setRevealed((prev) => ({ ...full, ...prev }));
        }
      } catch { /* exit is best-effort */ }
    }
    await refreshCredits(wallet);
    setSession(null);
    setView('play');
    setLastAction('Ready');
  }

  async function requestWithdrawal() {
    setError('');
    const amount = usdcUnits(withdrawUsdc);
    if (BigInt(amount) <= 0n) { setError('Enter an amount to cash out.'); return; }
    if (BigInt(amount) > BigInt(withdrawable)) { setError('Amount exceeds your withdrawable credits.'); return; }
    setBusy(true);
    try {
      const player = wallet || await connectWallet();
      if (!player) return;
      const result = await postJson('/v2/withdrawals/request', { player, amount, destination: player });
      setWithdrawUsdc('');
      await refreshCredits(player);
      setLastAction(`Cash-out requested — ${dollars(result.payoutAmount)} to your wallet shortly.`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const walletLabel = wallet ? shortAddress(wallet) : 'Connect wallet';

  const TopBar = (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => setView('landing')}>
        <img src={chancyLogo} alt="" /> Chancy
      </button>
      <div className="top-actions">
        {wallet && <span className="text-link">{dollars(balance)} credits</span>}
        <button className="ghost-button" type="button" onClick={() => setShowRules(true)}>How Chancy works</button>
        <button className="main-button" type="button" onClick={connectWallet}>{walletLabel}</button>
      </div>
    </header>
  );

  return (
    <div className="product-shell">
      {TopBar}

      {error && <p className="error-text" role="alert">{error}</p>}

      {view === 'landing' && (
        <>
          <section className="landing-hero">
            <div className="hero-copy">
              <p className="kicker">Chancy live · {health}</p>
              <h1>Tap tiles. Dodge bombs. Bank the prizes.</h1>
              <p className="lede">Add credits once, then play instantly — every move is a single tap, no wallet pop-ups, no waiting. Cash out whenever you want.</p>
              <div className="hero-buttons">
                <button className="main-button large" type="button" onClick={() => setView('play')}>Play</button>
                <button className="ghost-button large" type="button" onClick={() => setShowRules(true)}>How it works</button>
              </div>
            </div>
            <div className="hero-visual">
              <img src={chancyLogo} alt="Chancy" />
              <span>$0.05 a round</span>
            </div>
          </section>

          <section className="mode-grid">
            {Object.entries(MODES).map(([name, cfg]) => (
              <article key={name}>
                <strong>{name}</strong>
                <span>{cfg.bombs} bombs · {cfg.prizes} {cfg.prizes === 1 ? 'prize' : 'prizes'}</span>
                <span>Win pays {cfg.multiplier}× your stake</span>
              </article>
            ))}
          </section>
        </>
      )}

      {view === 'play' && (
        <>
          <div className="page-head">
            <p className="kicker">Your wallet</p>
            <h2>{wallet ? 'Pick a mode and play.' : 'Connect to start playing.'}</h2>
          </div>

          <section className="sessions-layout">
            <div className="run-card">
              <p className="kicker">Choose your mode</p>
              <div className="mode-grid">
                {Object.entries(MODES).map(([name, cfg]) => (
                  <article
                    key={name}
                    onClick={() => setMode(name)}
                    style={{ cursor: 'pointer', outline: mode === name ? '2px solid #ffaa00' : 'none' }}
                  >
                    <strong>{name}</strong>
                    <span>{cfg.copy}</span>
                    <span>Win pays {cfg.multiplier}× · {dollars((BigInt(STAKE_UNITS) * BigInt(Math.round(parseFloat(cfg.multiplier) * 10)) / 10n).toString())}</span>
                  </article>
                ))}
              </div>
              <button className="main-button large full" type="button" disabled={busy} onClick={startRound}>
                Play {mode} — $0.05
              </button>
              <p className="status-line">{lastAction}</p>
              {!onTargetChain && wallet && <p className="note">You'll be switched to {targetLabel} when you play or add credits.</p>}
            </div>

            <aside className="stat-list">
              <div>
                <span>Credit balance</span>
                <strong>{dollars(balance)}</strong>
              </div>
              <div>
                <span>Withdrawable</span>
                <strong>{dollars(withdrawable)}</strong>
              </div>

              <div className="create-card">
                <label htmlFor="deposit">
                  Add credits (USDC)
                  <small>One deposit funds many rounds. 5% network fee applies.</small>
                </label>
                <input id="deposit" inputMode="decimal" value={depositUsdc} onChange={(e) => setDepositUsdc(e.target.value)} placeholder="5" />
                <button className="main-button full" type="button" disabled={busy} onClick={depositCredits}>Add credits</button>
              </div>

              <div className="create-card">
                <label htmlFor="withdraw">
                  Cash out (USDC)
                  <small>Sent to your wallet. 5% fee on withdrawals.</small>
                </label>
                <input id="withdraw" inputMode="decimal" value={withdrawUsdc} onChange={(e) => setWithdrawUsdc(e.target.value)} placeholder={formatUsdc(withdrawable)} />
                <button className="ghost-button full" type="button" disabled={busy || BigInt(withdrawable) <= 0n} onClick={requestWithdrawal}>Cash out</button>
              </div>
            </aside>
          </section>
        </>
      )}

      {view === 'round' && session && (
        <>
          <div className="room-header">
            <button className="ghost-button" type="button" onClick={endRound}>← Back</button>
            <h2>{session.mode} round</h2>
          </div>

          <section className="room-layout">
            <div className="board-card">
              <div className="meter-row">
                <div><span>Bombs</span><strong>{run.bombsHit}/3</strong></div>
                <div><span>Prizes</span><strong>{run.prizesCollected}/{modeConfig.prizes}</strong></div>
                <div><span>Win pays</span><strong>{dollars(potentialWin)}</strong></div>
              </div>
              <p className="status-line">{lastAction}</p>
              <div className="tile-board" aria-label="Chancy 8x8 board">
                {TILES.map((tile) => {
                  const state = revealed[tile];
                  const cls = state ? `tile ${state}` : 'tile';
                  const symbol = state === 'prize' ? '★' : state === 'bomb' ? '✺' : state === 'empty' ? '·' : '';
                  return (
                    <button
                      key={tile}
                      className={cls}
                      type="button"
                      aria-label={`tile ${tile}`}
                      disabled={!!state || run.status !== 'active' || busy}
                      onClick={() => clickTile(tile)}
                    >{symbol}</button>
                  );
                })}
              </div>
            </div>

            <aside className="stat-list">
              <div>
                <span>Status</span>
                <strong>{run.status === 'won' ? 'You won!' : run.status === 'lost' ? 'Run over' : 'Playing'}</strong>
              </div>
              <div>
                <span>Credit balance</span>
                <strong>{dollars(balance)}</strong>
              </div>
              {run.status === 'won' && <div><span>Payout</span><strong>{dollars(run.payout)}</strong></div>}
              {run.status !== 'active' && (
                <button className="main-button full" type="button" onClick={endRound}>
                  {run.status === 'won' ? 'Collect & continue' : 'Play again'}
                </button>
              )}
              {run.status === 'active' && (
                <button className="ghost-button full" type="button" disabled={busy} onClick={endRound}>Quit round</button>
              )}
            </aside>
          </section>
        </>
      )}

      <button className="help-button" type="button" aria-label="How Chancy works" onClick={() => setShowRules(true)}>?</button>
      {showRules && <RulesModal onClose={closeRules} />}
    </div>
  );
}
