/**
 * Real bun:sqlite tests for server/db.ts.
 *
 * Each test creates an isolated temporary database file so tests are fully
 * independent. The file is removed after the test closes the store.
 *
 * These tests specifically cover:
 *  - The bun:sqlite null-vs-undefined bug (isRedeemed on an empty table must
 *    return false, not true — the bug was .get() returns null, not undefined,
 *    so a check !==undefined would always pass and mark every nonce "redeemed").
 *  - markRedeemed exactly-once semantics via the real DB write-lock.
 *  - Challenge persistence across a close/reopen cycle (simulates a restart).
 *  - pruneExpired removes only the correct rows.
 */
import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './db.ts';
import type { Store } from './db.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDb(): { store: Store; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sd-db-test-'));
  const path = join(dir, 'test.db');
  const store = createStore(path);
  return {
    store,
    path,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Track open handles so afterEach can ensure cleanup even on test failure.
const handles: Array<() => void> = [];
afterEach(() => {
  while (handles.length) handles.pop()!();
});

function open(): { store: Store; path: string } {
  const { store, path, cleanup } = tempDb();
  handles.push(cleanup);
  return { store, path };
}

// ---------------------------------------------------------------------------
// 1. isRedeemed on an empty database returns false (not true).
//    This guards against the bun:sqlite null-vs-undefined regression:
//    .get() returns null on no-match; checking !== undefined was always true.
// ---------------------------------------------------------------------------

test('isRedeemed: empty database returns false for any nonce', () => {
  const { store } = open();
  expect(store.isRedeemed('deadbeef')).toBe(false);
  expect(store.isRedeemed('0'.repeat(64))).toBe(false);
  expect(store.isRedeemed('')).toBe(false);
});

test('isRedeemed: returns false before redemption, true after', () => {
  const { store } = open();
  const nonce = 'aa'.repeat(32);
  const qid = '0x' + 'bb'.repeat(32);

  expect(store.isRedeemed(nonce)).toBe(false);
  const recorded = store.markRedeemed(nonce, qid);
  expect(recorded).toBe(true);
  expect(store.isRedeemed(nonce)).toBe(true);
});

// ---------------------------------------------------------------------------
// 2. markRedeemed returns true exactly once; second call returns false.
// ---------------------------------------------------------------------------

test('markRedeemed: returns true on first call, false on second', () => {
  const { store } = open();
  const nonce = 'cc'.repeat(32);
  const qid = '0x' + 'dd'.repeat(32);

  expect(store.markRedeemed(nonce, qid)).toBe(true);
  expect(store.markRedeemed(nonce, qid)).toBe(false);
  expect(store.markRedeemed(nonce, qid)).toBe(false); // third call also false
});

test('markRedeemed: two different nonces can both be marked', () => {
  const { store } = open();
  const n1 = '11'.repeat(32); const q1 = '0x' + 'aa'.repeat(32);
  const n2 = '22'.repeat(32); const q2 = '0x' + 'bb'.repeat(32);

  expect(store.markRedeemed(n1, q1)).toBe(true);
  expect(store.markRedeemed(n2, q2)).toBe(true);
  expect(store.markRedeemed(n1, q1)).toBe(false);
  expect(store.markRedeemed(n2, q2)).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. Challenge survives a close/reopen cycle (restart safety).
// ---------------------------------------------------------------------------

test('challenge saved before close is retrievable after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-reopen-'));
  const path = join(dir, 'test.db');

  const nonce = 'ff'.repeat(32);
  const qid = '0x' + 'ee'.repeat(32);
  const expiresAt = Date.now() + 60_000;

  // Write and close.
  {
    const s1 = createStore(path);
    s1.saveChallenge(nonce, qid, 'network', '', expiresAt);
    s1.close();
  }

  // Reopen and check.
  {
    const s2 = createStore(path);
    const row = s2.getChallenge(nonce);
    expect(row).not.toBeNull();
    expect(row!.nonce).toBe(nonce);
    expect(row!.query_id_hex).toBe(qid);
    expect(row!.query).toBe('network');
    expect(row!.expires_at).toBe(expiresAt);
    s2.close();
  }

  rmSync(dir, { recursive: true, force: true });
});

test('redemption marked before close is still redeemed after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-reopen2-'));
  const path = join(dir, 'test.db');

  const nonce = '12'.repeat(32);
  const qid = '0x' + '34'.repeat(32);

  {
    const s1 = createStore(path);
    s1.saveChallenge(nonce, qid, 'network', '', Date.now() + 60_000);
    s1.markRedeemed(nonce, qid);
    s1.close();
  }

  {
    const s2 = createStore(path);
    // Should be redeemed.
    expect(s2.isRedeemed(nonce)).toBe(true);
    // markRedeemed must return false (already recorded).
    expect(s2.markRedeemed(nonce, qid)).toBe(false);
    s2.close();
  }

  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. pruneExpired removes only expired challenges, leaves live ones intact.
// ---------------------------------------------------------------------------

test('pruneExpired removes expired rows and leaves valid ones', () => {
  const { store } = open();

  const expiredNonce = 'aa'.repeat(32);
  const liveNonce = 'bb'.repeat(32);
  const qid = '0x' + 'cc'.repeat(32);

  // Save one challenge already expired (expires_at in the past) and one live.
  store.saveChallenge(expiredNonce, qid, 'network', '', Date.now() - 1000);
  store.saveChallenge(liveNonce, qid, 'network', '', Date.now() + 60_000);

  // Confirm both are present before prune.
  expect(store.getChallenge(expiredNonce)).not.toBeNull();
  expect(store.getChallenge(liveNonce)).not.toBeNull();

  store.pruneExpired();

  // Expired row should be gone; live row should remain.
  expect(store.getChallenge(expiredNonce)).toBeNull();
  expect(store.getChallenge(liveNonce)).not.toBeNull();
});

test('pruneExpired does not touch redemptions table', () => {
  const { store } = open();
  const nonce = 'ab'.repeat(32);
  const qid = '0x' + 'cd'.repeat(32);

  store.saveChallenge(nonce, qid, 'network', '', Date.now() - 1000); // expired
  store.markRedeemed(nonce, qid);

  store.pruneExpired(); // removes the challenge row

  // Challenge gone, but redemption survives.
  expect(store.getChallenge(nonce)).toBeNull();
  expect(store.isRedeemed(nonce)).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. getChallenge: missing nonce returns null (not undefined or a row).
// ---------------------------------------------------------------------------

test('getChallenge returns null for unknown nonce', () => {
  const { store } = open();
  expect(store.getChallenge('unknown')).toBeNull();
  expect(store.getChallenge('')).toBeNull();
});

test('getChallenge returns the correct row after save', () => {
  const { store } = open();
  const nonce = '77'.repeat(32);
  const qid = '0x' + '88'.repeat(32);
  const exp = Date.now() + 30_000;

  store.saveChallenge(nonce, qid, 'stablecoin', 'USDC', exp);
  const row = store.getChallenge(nonce);

  expect(row).not.toBeNull();
  expect(row!.nonce).toBe(nonce);
  expect(row!.query_id_hex).toBe(qid);
  expect(row!.query).toBe('stablecoin');
  expect(row!.params).toBe('USDC');
  expect(row!.expires_at).toBe(exp);
});

// ---------------------------------------------------------------------------
// 6. deleteChallenge removes the row and leaves others intact.
// ---------------------------------------------------------------------------

test('deleteChallenge removes only the targeted row', () => {
  const { store } = open();
  const n1 = 'e1'.repeat(32); const q1 = '0x' + 'f1'.repeat(32);
  const n2 = 'e2'.repeat(32); const q2 = '0x' + 'f2'.repeat(32);

  store.saveChallenge(n1, q1, 'network', '', Date.now() + 60_000);
  store.saveChallenge(n2, q2, 'network', '', Date.now() + 60_000);

  store.deleteChallenge(n1);

  expect(store.getChallenge(n1)).toBeNull();
  expect(store.getChallenge(n2)).not.toBeNull();
});
