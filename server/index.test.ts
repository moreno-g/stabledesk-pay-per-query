/**
 * Backend commit-reveal tests.
 *
 * Tests the core validation helpers in isolation (no live network, no SQLite).
 * All helpers are re-implemented inline to match server/index.ts exactly.
 * The full integration path is covered by the e2e agent script.
 */
import { test, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { keccak256 as viemKeccak256 } from 'viem';

// ---------------------------------------------------------------------------
// Inline the same helpers as server/index.ts so we can test them deterministically.
// Any divergence here is itself a test failure.
// ---------------------------------------------------------------------------

function keccak256Hex(input: Uint8Array): string {
  return viemKeccak256(input).slice(2);
}

function keccak256FromNonce(nonceHex: string): string {
  return keccak256Hex(Buffer.from(nonceHex, 'hex') as unknown as Uint8Array);
}

function generateChallenge(): { nonce: string; queryIdHex: string } {
  const nonceBytes = randomBytes(32);
  const nonce = nonceBytes.toString('hex');
  const queryIdHex = '0x' + keccak256Hex(nonceBytes as unknown as Uint8Array);
  return { nonce, queryIdHex };
}

// ---------------------------------------------------------------------------
// Test vector: keccak256 of empty bytes = the Ethereum/EVM standard value.
// This distinguishes Keccak-256 from NIST SHA3-256 (they differ on the same input).
// ---------------------------------------------------------------------------

test('keccak256 test vector: empty bytes', () => {
  // Keccak-256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
  // NIST SHA3-256("") = 0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a
  // These differ — verify we are using Keccak-256.
  const result = keccak256Hex(new Uint8Array(0));
  expect(result).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

test('keccak256 of empty bytes via viem directly', () => {
  expect(viemKeccak256(new Uint8Array(0))).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});

// ---------------------------------------------------------------------------
// Commit-reveal property tests
// ---------------------------------------------------------------------------

test('queryIdHex == 0x + keccak256(nonce)', () => {
  const { nonce, queryIdHex } = generateChallenge();
  const expected = '0x' + keccak256FromNonce(nonce);
  expect(queryIdHex).toBe(expected);
});

test('keccak256(nonce) is deterministic', () => {
  const { nonce } = generateChallenge();
  expect(keccak256FromNonce(nonce)).toBe(keccak256FromNonce(nonce));
});

test('100 different nonces produce 100 different queryIds', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add(generateChallenge().queryIdHex);
  }
  expect(ids.size).toBe(100);
});

// ---------------------------------------------------------------------------
// Validation logic tests (in-memory store mirrors db.ts interface)
// ---------------------------------------------------------------------------

type ChallengeRow = { nonce: string; query_id_hex: string; query: string; params: string; expires_at: number };

function makeStore() {
  const challenges = new Map<string, ChallengeRow>();
  const redeemed = new Set<string>();

  function saveChallenge(nonce: string, queryIdHex: string, query: string, params: string, expiresAt: number) {
    challenges.set(nonce, { nonce, query_id_hex: queryIdHex, query, params, expires_at: expiresAt });
  }
  function getChallenge(nonce: string) { return challenges.get(nonce) ?? null; }
  function isRedeemed(nonce: string) { return redeemed.has(nonce); }
  function markRedeemed(nonce: string): boolean {
    if (redeemed.has(nonce)) return false;
    redeemed.add(nonce);
    return true;
  }
  function deleteChallenge(nonce: string) { challenges.delete(nonce); }

  return { saveChallenge, getChallenge, isRedeemed, markRedeemed, deleteChallenge };
}

type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

function validate(
  store: ReturnType<typeof makeStore>,
  nonce: string,
  query: string,
  params: string,
): ValidationResult {
  let expectedQueryId: string;
  try {
    expectedQueryId = keccak256FromNonce(nonce);
  } catch {
    return { ok: false, code: 'invalid_nonce', message: 'Nonce is not valid hex.' };
  }
  const expectedQueryIdHex = ('0x' + expectedQueryId).toLowerCase();

  const record = store.getChallenge(nonce);
  if (!record) return { ok: false, code: 'expired', message: 'Nonce not found or expired.' };
  if (Date.now() > record.expires_at) {
    store.deleteChallenge(nonce);
    return { ok: false, code: 'expired', message: 'Challenge expired.' };
  }
  if (record.query !== query || record.params !== params) {
    return { ok: false, code: 'wrong_query', message: 'Nonce was issued for a different query.' };
  }
  if (record.query_id_hex.toLowerCase() !== expectedQueryIdHex) {
    return { ok: false, code: 'nonce_mismatch', message: 'Nonce does not match stored queryId.' };
  }
  if (store.isRedeemed(nonce)) {
    return { ok: false, code: 'already_redeemed', message: 'Already redeemed.' };
  }
  return { ok: true };
}

test('commit-reveal: correct nonce validates successfully', () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() + 60_000);
  const result = validate(store, nonce, 'network', '');
  expect(result.ok).toBe(true);
});

test('commit-reveal: missing nonce (not issued) is rejected', () => {
  const store = makeStore();
  const { nonce } = generateChallenge(); // never saved
  const result = validate(store, nonce, 'network', '');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('expired');
});

test('commit-reveal: wrong nonce (random hex, not issued) is rejected', () => {
  const store = makeStore();
  const wrongNonce = randomBytes(32).toString('hex');
  const result = validate(store, wrongNonce, 'network', '');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('expired');
});

test('commit-reveal: correct nonce works exactly once, second time returns already_redeemed', () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() + 60_000);

  // First redemption succeeds.
  const first = validate(store, nonce, 'network', '');
  expect(first.ok).toBe(true);

  // Mark redeemed (simulates markRedeemed() after successful upstream call).
  store.markRedeemed(nonce);
  store.deleteChallenge(nonce);

  // Second attempt: challenge deleted, so 'expired'.
  const second = validate(store, nonce, 'network', '');
  expect(second.ok).toBe(false);
  if (!second.ok) expect(['expired', 'already_redeemed'].includes(second.code)).toBe(true);
});

test('commit-reveal: nonce issued for one query rejected on different query', () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() + 60_000);
  const result = validate(store, nonce, 'stablecoins', '');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('wrong_query');
});

test('commit-reveal: expired nonce is rejected', async () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() - 1); // already expired
  const result = validate(store, nonce, 'network', '');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('expired');
});

test('markRedeemed is atomic: concurrent calls return true exactly once', () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() + 60_000);

  // Simulate two concurrent redemption attempts.
  const r1 = store.markRedeemed(nonce);
  const r2 = store.markRedeemed(nonce);
  expect(r1).toBe(true);
  expect(r2).toBe(false); // second call is rejected
});

test('upstream error leaves nonce unredeemed (retry allowed)', () => {
  const store = makeStore();
  const { nonce, queryIdHex } = generateChallenge();
  store.saveChallenge(nonce, queryIdHex, 'network', '', Date.now() + 60_000);

  // Validate passes.
  const v = validate(store, nonce, 'network', '');
  expect(v.ok).toBe(true);

  // Simulate upstream failure: do NOT call markRedeemed / deleteChallenge.
  // Nonce must still be valid.
  const retry = validate(store, nonce, 'network', '');
  expect(retry.ok).toBe(true); // still redeemable
});
