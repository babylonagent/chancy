"use strict";

/**
 * Notifications system for Chancy V3.
 * Stores important player events: deposits, withdrawals, game wins/losses, host pot losses.
 *
 * Uses the same SQLite database as the main store.
 * Events are append-only (never mutated), with a read endpoint for the frontend.
 */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

let db = null;

function init(dbPath) {
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      player     TEXT NOT NULL,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT,
      amount     TEXT,
      tx_hash    TEXT,
      game_id    TEXT,
      read       INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_player ON notifications(player);
    CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(player, created_at DESC);
  `);
  console.log("[notifications] Initialized at", dbPath);
  return { recordNotification, getNotifications, markRead, getUnreadCount };
}

function recordNotification({ player, type, title, body, amount, txHash, gameId }) {
  if (!db) throw new Error("Notifications not initialized");
  if (!player || !type || !title) return;
  const stmt = db.prepare(`
    INSERT INTO notifications (player, type, title, body, amount, tx_hash, game_id, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `);
  stmt.run(
    player.toLowerCase(),
    type,
    title,
    body || null,
    amount || null,
    txHash || null,
    gameId || null,
  );
}

function getNotifications(player, limit = 50) {
  if (!db) throw new Error("Notifications not initialized");
  const stmt = db.prepare(`
    SELECT * FROM notifications
    WHERE player = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(player.toLowerCase(), limit).map(row => ({
    id: row.id,
    player: row.player,
    type: row.type,
    title: row.title,
    body: row.body,
    amount: row.amount,
    txHash: row.tx_hash,
    gameId: row.game_id,
    read: row.read === 1,
    createdAt: row.created_at,
  }));
}

function getUnreadCount(player) {
  if (!db) throw new Error("Notifications not initialized");
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM notifications
    WHERE player = ? AND read = 0
  `);
  return stmt.get(player.toLowerCase()).count;
}

function markRead(player, notifId) {
  if (!db) throw new Error("Notifications not initialized");
  if (notifId === 'all') {
    const stmt = db.prepare(`UPDATE notifications SET read = 1 WHERE player = ? AND read = 0`);
    stmt.run(player.toLowerCase());
  } else {
    const stmt = db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND player = ?`);
    stmt.run(notifId, player.toLowerCase());
  }
}

module.exports = { init, recordNotification, getNotifications, getUnreadCount, markRead };
