"use strict";

/**
 * SQLite persistence layer for Chancy V2 store.
 *
 * Replaces the JSON file store with an ACID SQLite database while keeping
 * the same in-memory Map interface used by v2.js route handlers.
 *
 * Design:
 *   - On load: read all rows into in-memory Maps (same shape as createV2Store)
 *   - On persist: upsert all Maps into SQLite inside a transaction
 *   - WAL mode for concurrent reader/writer safety
 *   - BigInts stored as TEXT (SQLite has no native BigInt)
 *   - Session clicked Map and board stored as JSON TEXT columns
 *
 * Migration: `migrateJsonToSqlite(jsonPath, dbPath)` imports existing JSON store.
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  player TEXT PRIMARY KEY,
  amount TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits (
  tx_hash         TEXT PRIMARY KEY,
  player          TEXT NOT NULL,
  gross_amount    TEXT NOT NULL,
  credited_amount TEXT NOT NULL,
  fee_amount      TEXT NOT NULL,
  at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS withdrawals (
  withdrawal_id  TEXT PRIMARY KEY,
  player         TEXT NOT NULL,
  amount         TEXT NOT NULL,
  payout_amount  TEXT NOT NULL,
  fee_amount     TEXT NOT NULL,
  destination    TEXT NOT NULL,
  status         TEXT NOT NULL,
  tx_hash        TEXT,
  created_at     TEXT NOT NULL,
  paid_at        TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  player            TEXT NOT NULL,
  host              TEXT NOT NULL,
  mode              TEXT NOT NULL,
  stake             TEXT NOT NULL,
  commitment        TEXT,
  commit_expires_at INTEGER,
  board             TEXT,
  board_commit_hash TEXT,
  entropy           TEXT,
  salt              TEXT,
  clicked           TEXT NOT NULL DEFAULT '[]',
  bombs_hit         INTEGER NOT NULL DEFAULT 0,
  prizes_collected  INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  payout            TEXT NOT NULL DEFAULT '0'
);

CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_player ON withdrawals(player);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_deposits_player ON deposits(player);
`;

/**
 * Open (or create) the SQLite database and ensure schema exists.
 * @param {string} dbPath — path to .sqlite file, or ":memory:"
 * @returns {DatabaseSync}
 */
function initDatabase(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Load the entire store from SQLite into the in-memory Maps shape.
 * Returns the same object shape as createV2Store().
 */
function loadSqliteStore(db) {
  const store = {
    balances: new Map(),
    sessions: new Map(),
    withdrawals: new Map(),
    deposits: new Map(),
    nextSessionId: 1,
    nextWithdrawalId: 1,
  };

  // Meta
  const metaRows = db.prepare("SELECT key, value FROM meta").all();
  for (const row of metaRows) {
    if (row.key === "nextSessionId") store.nextSessionId = Number(row.value);
    if (row.key === "nextWithdrawalId") store.nextWithdrawalId = Number(row.value);
  }

  // Balances
  for (const row of db.prepare("SELECT player, amount FROM balances").all()) {
    store.balances.set(row.player, BigInt(row.amount));
  }

  // Deposits
  for (const row of db.prepare("SELECT * FROM deposits").all()) {
    store.deposits.set(row.tx_hash, {
      player: row.player,
      grossAmount: row.gross_amount,
      creditedAmount: row.credited_amount,
      feeAmount: row.fee_amount,
      at: row.at,
    });
  }

  // Withdrawals
  for (const row of db.prepare("SELECT * FROM withdrawals").all()) {
    store.withdrawals.set(row.withdrawal_id, {
      withdrawalId: row.withdrawal_id,
      player: row.player,
      amount: row.amount,
      payoutAmount: row.payout_amount,
      feeAmount: row.fee_amount,
      destination: row.destination,
      status: row.status,
      txHash: row.tx_hash || undefined,
      createdAt: row.created_at,
      paidAt: row.paid_at || undefined,
    });
  }

  // Sessions
  for (const row of db.prepare("SELECT * FROM sessions").all()) {
    const clickedArr = JSON.parse(row.clicked || "[]");
    store.sessions.set(row.session_id, {
      sessionId: row.session_id,
      player: row.player,
      host: row.host,
      mode: row.mode,
      stake: row.stake,
      commitment: row.commitment || undefined,
      commitExpiresAt: row.commit_expires_at || undefined,
      board: row.board ? JSON.parse(row.board) : null,
      boardCommitHash: row.board_commit_hash || null,
      entropy: row.entropy || null,
      salt: row.salt || null,
      clicked: new Map(clickedArr),
      bombsHit: row.bombs_hit,
      prizesCollected: row.prizes_collected,
      status: row.status,
      payout: row.payout || "0",
    });
  }

  return store;
}

/**
 * Persist the entire in-memory store to SQLite inside a single transaction.
 * Uses INSERT OR REPLACE (upsert) for every row. Fast enough at our scale
 * (hundreds of sessions, thousands of clicks) — sub-millisecond with WAL.
 */
function persistSqliteStore(db, store) {
  const tx = db.exec.bind(db, "BEGIN IMMEDIATE");
  const commit = db.exec.bind(db, "COMMIT");
  const rollback = db.exec.bind(db, "ROLLBACK");

  try {
    tx();

    // Meta
    const upsertMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    upsertMeta.run("nextSessionId", String(store.nextSessionId));
    upsertMeta.run("nextWithdrawalId", String(store.nextWithdrawalId));

    // Balances — wipe + bulk insert (small table)
    db.exec("DELETE FROM balances");
    const insBalance = db.prepare("INSERT INTO balances (player, amount) VALUES (?, ?)");
    for (const [player, amount] of store.balances) {
      insBalance.run(player.toLowerCase(), amount.toString());
    }

    // Deposits — wipe + bulk insert
    db.exec("DELETE FROM deposits");
    const insDeposit = db.prepare(
      "INSERT INTO deposits (tx_hash, player, gross_amount, credited_amount, fee_amount, at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const [txHash, rec] of store.deposits) {
      insDeposit.run(txHash, rec.player, rec.grossAmount, rec.creditedAmount, rec.feeAmount, rec.at);
    }

    // Withdrawals — wipe + bulk insert
    db.exec("DELETE FROM withdrawals");
    const insWithdrawal = db.prepare(
      "INSERT INTO withdrawals (withdrawal_id, player, amount, payout_amount, fee_amount, destination, status, tx_hash, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const [id, w] of store.withdrawals) {
      insWithdrawal.run(
        id, w.player, w.amount, w.payoutAmount, w.feeAmount,
        w.destination, w.status, w.txHash || null, w.createdAt, w.paidAt || null
      );
    }

    // Sessions — wipe + bulk insert
    db.exec("DELETE FROM sessions");
    const insSession = db.prepare(
      `INSERT INTO sessions (session_id, player, host, mode, stake, commitment, commit_expires_at,
        board, board_commit_hash, entropy, salt, clicked, bombs_hit, prizes_collected, status, payout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [id, s] of store.sessions) {
      const clickedArr = [...s.clicked.entries()];
      insSession.run(
        id, s.player, s.host, s.mode, s.stake,
        s.commitment || null, s.commitExpiresAt || null,
        s.board ? JSON.stringify(s.board) : null,
        s.boardCommitHash || null,
        s.entropy || null,
        s.salt || null,
        JSON.stringify(clickedArr),
        s.bombsHit || 0, s.prizesCollected || 0, s.status, s.payout || "0"
      );
    }

    commit();
  } catch (err) {
    try { rollback(); } catch {}
    throw err;
  }
}

/**
 * One-time migration: import existing JSON store into SQLite.
 * If the SQLite DB already has data, this is a no-op.
 */
function migrateJsonToSqlite(jsonPath, dbPath) {
  if (!fs.existsSync(jsonPath)) {
    return { migrated: false, reason: "JSON file not found" };
  }
  const db = initDatabase(dbPath);
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get();
  if (existing.cnt > 0) {
    db.close();
    return { migrated: false, reason: "SQLite already has data" };
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const store = {
    balances: new Map(),
    sessions: new Map(),
    withdrawals: new Map(),
    deposits: new Map(),
    nextSessionId: Number(raw?.nextSessionId || 1),
    nextWithdrawalId: Number(raw?.nextWithdrawalId || 1),
  };
  for (const [key, value] of Object.entries(raw?.balances || {})) {
    store.balances.set(key, BigInt(value));
  }
  for (const [id, session] of Object.entries(raw?.sessions || {})) {
    store.sessions.set(id, { ...session, clicked: new Map(session.clicked || []) });
  }
  for (const [id, withdrawal] of Object.entries(raw?.withdrawals || {})) {
    store.withdrawals.set(id, withdrawal);
  }
  for (const [txHash, record] of Object.entries(raw?.deposits || {})) {
    store.deposits.set(txHash, record);
  }

  persistSqliteStore(db, store);
  db.close();
  return {
    migrated: true,
    balances: store.balances.size,
    sessions: store.sessions.size,
    withdrawals: store.withdrawals.size,
    deposits: store.deposits.size,
  };
}

module.exports = {
  initDatabase,
  loadSqliteStore,
  persistSqliteStore,
  migrateJsonToSqlite,
  SCHEMA_SQL,
};
