import React, { useEffect, useMemo, useState } from 'react';

const API = import.meta.env?.VITE_CHANCY_API_URL || '';
const DEFAULT_RANDOM = '0x1111111111111111111111111111111111111111111111111111111111111111';

async function postJson(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function getJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export default function App() {
  const [health, setHealth] = useState('checking');
  const [difficulty, setDifficulty] = useState('Normal');
  const [sessionId, setSessionId] = useState('1');
  const [entryAmount, setEntryAmount] = useState('10000000000000000000');
  const [maxPlayers, setMaxPlayers] = useState('4');
  const [rewardPerPrize, setRewardPerPrize] = useState('2000000000000000000');
  const [entropyFee, setEntropyFee] = useState('0');
  const [player, setPlayer] = useState('0x2222222222222222222222222222222222222222');
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getJson('/health')
      .then((data) => setHealth(data.ok ? 'online' : 'offline'))
      .catch(() => setHealth('offline'));
  }, []);

  const tiles = useMemo(() => Array.from({ length: 64 }, (_, index) => index), []);

  async function run(label, fn) {
    setError('');
    try {
      const nextPayload = await fn();
      setPayload({ label, ...nextPayload });
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Base game terminal</p>
          <h1>Chancy</h1>
          <p className="subtitle">Pyth Entropy powered 8×8 risk grid. Build wallet-ready transaction payloads, then sign with your client.</p>
        </div>
        <div className={`status ${health}`}>API {health}</div>
      </section>

      <section className="layout">
        <aside className="panel controls">
          <h2>Session controls</h2>
          <label>
            Difficulty
            <select aria-label="difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
              <option>Easy</option>
              <option>Normal</option>
              <option>Hardcore</option>
            </select>
          </label>
          <label>Session ID<input value={sessionId} onChange={(event) => setSessionId(event.target.value)} /></label>
          <label>Entry amount<input value={entryAmount} onChange={(event) => setEntryAmount(event.target.value)} /></label>
          <label>Max players<input value={maxPlayers} onChange={(event) => setMaxPlayers(event.target.value)} /></label>
          <label>Reward per prize<input value={rewardPerPrize} onChange={(event) => setRewardPerPrize(event.target.value)} /></label>
          <label>Entropy fee<input value={entropyFee} onChange={(event) => setEntropyFee(event.target.value)} /></label>
          <label>Player address<input value={player} onChange={(event) => setPlayer(event.target.value)} /></label>

          <button onClick={() => run('/tx/create-session', () => postJson('/tx/create-session', { difficulty, entryAmount, maxPlayers, rewardPerPrize }))}>Build create session tx</button>
          <button onClick={() => run('/tx/fund-session-rewards', () => postJson('/tx/fund-session-rewards', { sessionId, amount: String(BigInt(rewardPerPrize || '0') * BigInt(maxPlayers || '0') * 2n) }))}>Build fund tx</button>
          <button onClick={() => run('/tx/join-session', () => postJson('/tx/join-session', { sessionId, userRandomNumber: DEFAULT_RANDOM, entropyFee }))}>Build join tx</button>
          <button onClick={() => run('/read/session', () => getJson(`/read/session/${sessionId}`))}>Build session read</button>
          <button onClick={() => run('/read/player-game', () => getJson(`/read/player-game/${sessionId}/${player}`))}>Build player read</button>
        </aside>

        <section className="panel board-panel">
          <div className="panel-head">
            <h2>64-block board</h2>
            <span>click a tile to build tx</span>
          </div>
          <div className="grid" aria-label="Chancy 8x8 board">
            {tiles.map((tile) => (
              <button key={tile} aria-label={`tile ${tile}`} className="tile" onClick={() => run('/tx/click-tile', () => postJson('/tx/click-tile', { sessionId, tileIndex: tile }))}>
                {tile}
              </button>
            ))}
          </div>
        </section>

        <section className="panel payload-panel">
          <h2>Payload</h2>
          {error && <pre className="error">{error}</pre>}
          {payload ? <pre>{JSON.stringify(payload, null, 2)}</pre> : <p className="muted">No payload yet. Build a transaction or read call.</p>}
        </section>
      </section>
    </main>
  );
}
