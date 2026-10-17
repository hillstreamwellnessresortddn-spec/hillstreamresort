/* Hill Stream — the database.
 *
 * SQLite, through Node's built-in driver, so the property's record lives in a
 * file on disk instead of in whichever browser happened to write it. No
 * dependencies and no server process to install: the file is the database.
 *
 * WHY IT LOOKS LIKE THIS. The domain modules — rates.js, bookings.js,
 * guests.js, profiles.js, content.js — each keep one JSON document under one
 * key, and each reads and writes it synchronously. node:sqlite is synchronous
 * too, so `documents` below is a key/document table those modules can be
 * handed directly, in place of localStorage, and go on working unchanged.
 *
 * That is the whole trick of this migration: the rules those modules already
 * enforce now run on the server, against this file, where a visitor's console
 * cannot reach them.
 *
 * `revisions` keeps the previous version of every document that changes. A
 * prototype that can be edited by a tired person at 23:00 should be able to
 * say what it looked like at 22:00.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const FILE = process.env.HS_DB || path.join(__dirname, 'hillstream.db');

const db = new DatabaseSync(FILE);

/* WAL lets a read go on while a write is in flight, and survives an
   ungraceful exit better than the rollback journal. */
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    actor      TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS revisions_key_at ON revisions (key, at DESC);

  /* The account. One row today; a table because the day there are two, this
     should not be a rewrite. The password is a PBKDF2 digest and the salt is
     per-row — nothing here is reversible into a password. */
  CREATE TABLE IF NOT EXISTS accounts (
    email      TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    title      TEXT NOT NULL,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    changed_at INTEGER
  );

  /* Server-side sessions. The cookie carries a signed token, but the id is
     also recorded here so a session can be revoked — which a stateless JWT
     alone cannot do. */
  CREATE TABLE IF NOT EXISTS sessions (
    id      TEXT PRIMARY KEY,
    email   TEXT NOT NULL REFERENCES accounts(email) ON DELETE CASCADE,
    issued  INTEGER NOT NULL,
    seen    INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    agent   TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);

  /* Failed sign-ins and failed authorisation codes, so the backoff survives a
     browser restart instead of living in the attacker's own sessionStorage. */
  CREATE TABLE IF NOT EXISTS attempts (
    subject TEXT PRIMARY KEY,
    count   INTEGER NOT NULL,
    until   INTEGER NOT NULL
  );

  /* The signing key and the authorisation code live here rather than in any
     file the browser is served. Generated once, on first run. */
  CREATE TABLE IF NOT EXISTS secrets (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* ---- Documents ---------------------------------------------------------
   The shape the domain modules expect. getItem returns the stored text or
   null, exactly as localStorage does, so the modules cannot tell the
   difference. */
const selDoc = db.prepare('SELECT value FROM documents WHERE key = ?');
const putDoc = db.prepare(
  `INSERT INTO documents (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const delDoc = db.prepare('DELETE FROM documents WHERE key = ?');
const addRev = db.prepare('INSERT INTO revisions (key, value, actor, at) VALUES (?, ?, ?, ?)');
const trimRev = db.prepare(
  `DELETE FROM revisions WHERE key = ?1 AND id NOT IN
     (SELECT id FROM revisions WHERE key = ?1 ORDER BY at DESC LIMIT 50)`
);

/* A storage object with localStorage's shape, backed by the table above.
   `actor` is whoever the current request is, recorded against each revision;
   the server sets it per request. */
function documentStore() {
  let actor = null;
  return {
    setActor(who) { actor = who || null; },
    getItem(key) {
      const row = selDoc.get(String(key));
      return row ? row.value : null;
    },
    setItem(key, value) {
      const k = String(key), v = String(value), now = Date.now();
      const prev = selDoc.get(k);
      /* Keep what it was, but only when it actually moved. */
      if (prev && prev.value !== v) {
        addRev.run(k, prev.value, actor, now);
        trimRev.run(k);
      }
      putDoc.run(k, v, now);
    },
    removeItem(key) { delDoc.run(String(key)); },
    /* Present so a module that counts keys does not throw; nothing uses it. */
    get length() { return db.prepare('SELECT COUNT(*) n FROM documents').get().n; }
  };
}

function history(key, limit) {
  return db.prepare(
    'SELECT value, actor, at FROM revisions WHERE key = ? ORDER BY at DESC LIMIT ?'
  ).all(String(key), Math.max(1, Math.min(50, limit || 10)));
}

/* ---- Secrets ----------------------------------------------------------- */
function secret(name, make) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  if (row) return row.value;
  const value = make();
  db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?)').run(name, value);
  return value;
}

module.exports = {
  db, FILE,
  documentStore, history, secret,
  /* Raw statements the server needs for accounts, sessions and backoff. */
  q: {
    account: db.prepare('SELECT * FROM accounts WHERE email = ?'),
    anyAccount: db.prepare('SELECT * FROM accounts LIMIT 1'),
    addAccount: db.prepare(
      `INSERT INTO accounts (email, name, role, title, salt, hash, iterations, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    setPassword: db.prepare(
      'UPDATE accounts SET salt = ?, hash = ?, iterations = ?, changed_at = ? WHERE email = ?'
    ),

    session: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    addSession: db.prepare(
      'INSERT INTO sessions (id, email, issued, seen, expires, agent) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    touchSession: db.prepare('UPDATE sessions SET seen = ?, expires = ? WHERE id = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    dropSessionsFor: db.prepare('DELETE FROM sessions WHERE email = ?'),
    sweepSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),

    attempt: db.prepare('SELECT * FROM attempts WHERE subject = ?'),
    noteAttempt: db.prepare(
      `INSERT INTO attempts (subject, count, until) VALUES (?, ?, ?)
       ON CONFLICT(subject) DO UPDATE SET count = excluded.count, until = excluded.until`
    ),
    clearAttempt: db.prepare('DELETE FROM attempts WHERE subject = ?')
  }
};
