/**
 * SQLite persistence layer for Stabledesk Pay-per-Query backend.
 *
 * Two tables:
 *   challenges  — issued nonces, their on-chain queryId, and expiry
 *   redemptions — fully redeemed nonces (marked after successful Stabledesk call)
 *
 * Atomicity guarantee: markRedeemed() runs inside a BEGIN IMMEDIATE transaction
 * with an in-lock SELECT check. Two concurrent redemptions of the same nonce race
 * on the write-lock — only the first succeeds.
 *
 * An upstream (Stabledesk) error leaves the nonce in challenges (unredeemed),
 * so the payer can retry.
 *
 * DB_PATH resolution:
 *  - Explicit DB_PATH env var → always honoured (required in mainnet mode).
 *  - Testnet default → ./data/queries.db  (relative to cwd, i.e. the project root).
 *  - /tmp is never used: it is ephemeral on most hosts and would lose paid-but-unredeemed
 *    challenges across restarts, exactly the problem SQLite persistence is meant to prevent.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ChallengeRow {
  nonce: string;
  query_id_hex: string;
  query: string;
  params: string;
  expires_at: number;
}

export interface Store {
  saveChallenge(nonce: string, queryIdHex: string, query: string, params: string, expiresAt: number): void;
  getChallenge(nonce: string): ChallengeRow | null;
  isRedeemed(nonce: string): boolean;
  markRedeemed(nonce: string, queryIdHex: string): boolean;
  deleteChallenge(nonce: string): void;
  pruneExpired(): void;
  close(): void;
}

/**
 * Open (or create) a SQLite database at the given path and return a Store.
 * Exported so tests can pass a temporary path:
 *   const store = createStore('/tmp/test-xyz.db');
 */
export function createStore(dbPath: string): Store {
  const dir = dirname(dbPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for safe concurrent reads during write transactions.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS challenges (
      nonce        TEXT PRIMARY KEY,
      query_id_hex TEXT NOT NULL,
      query        TEXT NOT NULL,
      params       TEXT NOT NULL DEFAULT '',
      expires_at   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS redemptions (
      nonce        TEXT PRIMARY KEY,
      query_id_hex TEXT NOT NULL,
      redeemed_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires_at);
  `);

  const stmts = {
    insertChallenge: db.prepare(`
      INSERT INTO challenges (nonce, query_id_hex, query, params, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),

    getChallenge: db.prepare<ChallengeRow, [string]>(`
      SELECT nonce, query_id_hex, query, params, expires_at
      FROM challenges WHERE nonce = ?
    `),

    // NOTE: bun:sqlite .get() returns null (not undefined) when no row matches.
    // isRedeemed must check !== null, not !== undefined.
    isRedeemed: db.prepare<{ nonce: string }, [string]>(`
      SELECT nonce FROM redemptions WHERE nonce = ?
    `),

    deleteChallenge: db.prepare('DELETE FROM challenges WHERE nonce = ?'),

    pruneExpired: db.prepare('DELETE FROM challenges WHERE expires_at < ?'),
  };

  return {
    saveChallenge(nonce, queryIdHex, query, params, expiresAt) {
      stmts.insertChallenge.run(nonce, queryIdHex, query, params, expiresAt);
    },

    getChallenge(nonce) {
      return stmts.getChallenge.get(nonce) ?? null;
    },

    isRedeemed(nonce) {
      // bun:sqlite returns null (not undefined) on no-match — must use !== null.
      return stmts.isRedeemed.get(nonce) !== null;
    },

    /**
     * Atomically record a redemption inside a BEGIN IMMEDIATE write-lock.
     * Returns true if this call recorded it (first caller).
     * Returns false if already redeemed (concurrent or duplicate call).
     */
    markRedeemed(nonce, queryIdHex) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Re-check inside the write-lock to prevent TOCTOU races.
        const already = db.query<{ nonce: string }, [string]>(
          'SELECT nonce FROM redemptions WHERE nonce = ?'
        ).get(nonce);
        if (already !== null) {
          db.exec('ROLLBACK');
          return false;
        }
        db.query('INSERT INTO redemptions (nonce, query_id_hex) VALUES (?, ?)').run(nonce, queryIdHex);
        db.exec('COMMIT');
        return true;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
        throw e;
      }
    },

    deleteChallenge(nonce) {
      stmts.deleteChallenge.run(nonce);
    },

    pruneExpired() {
      stmts.pruneExpired.run(Date.now());
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton — used by the server process.
// ---------------------------------------------------------------------------

const IS_MAINNET_DB = process.env.NETWORK === 'mainnet';

let resolvedDbPath: string;
if (process.env.DB_PATH) {
  resolvedDbPath = process.env.DB_PATH;
} else if (IS_MAINNET_DB) {
  console.error('[db] FATAL: mainnet mode requires DB_PATH env var (must be a persistent volume path).');
  process.exit(1);
} else {
  resolvedDbPath = './data/queries.db';
}

const defaultStore = createStore(resolvedDbPath);

export const {
  saveChallenge,
  getChallenge,
  isRedeemed,
  markRedeemed,
  deleteChallenge,
  pruneExpired,
} = defaultStore;
