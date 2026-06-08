'use strict';
// Session metadata cache — supplements the live ~/.claude/projects/ data
// with user-set names, notes, and starred state.

const path = require('path');
const { app } = require('electron');

let db = null;

function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(app.getPath('userData'), 'sessions.db');
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        custom_name TEXT,
        starred INTEGER DEFAULT 0,
        notes TEXT,
        last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  } catch (e) {
    console.warn('better-sqlite3 unavailable, running without DB:', e.message);
    db = { get: () => null, run: () => {}, all: () => [], exec: () => {} };
  }
  return db;
}

function getMeta(sessionId) {
  return getDb().prepare?.('SELECT * FROM session_meta WHERE session_id = ?').get(sessionId) || null;
}

function setMeta(sessionId, fields) {
  const d = getDb();
  if (!d.prepare) return;
  const existing = getMeta(sessionId);
  if (existing) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    d.prepare(`UPDATE session_meta SET ${sets} WHERE session_id = ?`)
     .run(...Object.values(fields), sessionId);
  } else {
    d.prepare('INSERT INTO session_meta (session_id, custom_name, starred, notes, last_seen) VALUES (?, ?, ?, ?, ?)')
     .run(sessionId, fields.custom_name || null, fields.starred || 0, fields.notes || null, fields.last_seen || Date.now());
  }
}

function getSetting(key) {
  const row = getDb().prepare?.('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare?.('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = { getMeta, setMeta, getSetting, setSetting };
