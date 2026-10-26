/**
 * Stabledesk Pay-per-Query backend.
 *
 * This is a LONG-RUNNING process (not serverless). Run with: bun run server
 *
 * HTTP 402 flow with commit-reveal to prevent front-running:
 *   1. GET /api/q/<query>  → 402 { queryIdHex = keccak256(nonce), nonce, price, ... }
 *      The nonce is a random 32-byte secret held only by the client.
 *   2. Client calls pay(queryIdHex) on the QueryPayments contract.
 *   3. Client re-requests with X-Payment-Tx + X-Payment-Nonce.
 *      Backend checks keccak256(nonce) == queryId in the QueryPaid event.
 *      A front-runner who sees the tx cannot redeem without the nonce.
 *
 * Persistence: challenges and redemptions are stored in SQLite (bun:sqlite).
 * A process restart or redeploy between step 2 and 3 leaves the nonce in the
 * database so the payer can still redeem.
 *
 * Atomicity: markRedeemed() runs inside a BEGIN IMMEDIATE transaction with a
 * UNIQUE constraint check. Two concurrent redemptions of the same nonce race
 * on the constraint — only the first succeeds, the second gets already_redeemed.
 *
 * Upstream safety: the nonce is only marked redeemed AFTER the Stabledesk call
 * succeeds. An upstream error leaves it redeemable.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createPublicClient, http, keccak256 as viemKeccak256, type Hex } from 'viem';
import { saveChallenge, getChallenge, isRedeemed, markRedeemed, deleteChallenge, pruneExpired } from './db.ts';

// ---------------------------------------------------------------------------
// keccak256 — viem's keccak256 is the Ethereum-standard Keccak-256 (NOT SHA3-256)
// ---------------------------------------------------------------------------

/** keccak256 of a Uint8Array/Buffer, returns lowercase 64-char hex without 0x. */
function keccak256Hex(input: Uint8Array): string {
  // viemKeccak256 requires a 0x-prefixed hex string or Uint8Array; returns 0x-prefixed hex.
  return viemKeccak256(input).slice(2);
}

/** keccak256 of a 64-char hex nonce string, returns 64-char hex without 0x. */
function keccak256FromNonce(nonceHex: string): string {
  return keccak256Hex(Buffer.from(nonceHex, 'hex') as unknown as Uint8Array);
}

// ---------------------------------------------------------------------------
// Configuration + startup validation
// ---------------------------------------------------------------------------

const IS_MAINNET = process.env.NETWORK === 'mainnet';

if (IS_MAINNET) {
  const required = ['MAINNET_RPC_URL', 'MAINNET_CHAIN_ID', 'MAINNET_CONTRACT_ADDRESS', 'MAINNET_TREASURY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('[startup] FATAL: mainnet mode requires env vars:', missing.join(', '));
    process.exit(1);
  }
}

const CHAIN_ID: number = IS_MAINNET
  ? Number(process.env.MAINNET_CHAIN_ID)
  : Number(process.env.VITE_ARC_TESTNET_CHAIN_ID ?? 5042002);

const CONTRACT_ADDRESS: Hex = IS_MAINNET
  ? (process.env.MAINNET_CONTRACT_ADDRESS as Hex)
  : (process.env.VITE_CONTRACT_ADDRESS as Hex);

if (!CONTRACT_ADDRESS) {
  console.error('[startup] FATAL: no contract address configured.');
  process.exit(1);
}

// RPC selection priority (first match wins):
//   1. RPC_URL env var — explicit override, works in any environment (Railway, Docker, etc.)
//   2. Studio RPC proxy (RPC_PROXY_BASE_URL) — injected automatically inside Arc Studio
//   3. MAINNET_RPC_URL (mainnet only) / FALLBACK_RPC_URL (testnet only)
//
// In mainnet mode the only accepted fallback is MAINNET_RPC_URL — testnet RPCs are never
// used, even as a fallback, so a misconfiguration fails loudly instead of silently routing
// mainnet traffic to the wrong chain.
const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',').filter(Boolean);
const compassChain = IS_MAINNET ? 'Arc' : 'Arc_Testnet';

const EXPLICIT_RPC: string | null = process.env.RPC_URL ?? null;

const PROXY_RPC: string | null =
  process.env.RPC_PROXY_BASE_URL && proxyChains.includes(compassChain)
    ? `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${compassChain}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
    : null;

const ENV_FALLBACK_RPC: string | null = IS_MAINNET
  ? (process.env.MAINNET_RPC_URL ?? null)
  : (process.env.FALLBACK_RPC_URL ?? null);

// PRIMARY_RPC is the URL we actually use. ENV_FALLBACK_RPC is validated separately at startup.
const PRIMARY_RPC: string | null = EXPLICIT_RPC ?? PROXY_RPC ?? null;

const RPC_URL: string = (() => {
  if (PRIMARY_RPC) return PRIMARY_RPC;
  if (ENV_FALLBACK_RPC) return ENV_FALLBACK_RPC;
  console.error(
    '[startup] FATAL: no RPC configured. ' +
    'Set RPC_URL (recommended for Railway/Docker), ' +
    'or RPC_PROXY_BASE_URL (Arc Studio sandbox), ' +
    (IS_MAINNET ? 'or MAINNET_RPC_URL.' : 'or FALLBACK_RPC_URL.'),
  );
  process.exit(1);
})();

/**
 * Validate every configured RPC URL against the expected chain ID.
 * Both PRIMARY_RPC and FALLBACK_RPC are checked when present.
 * A mainnet RPC on a testnet deployment (or vice versa) causes an immediate exit.
 */
async function validateAllRpcs(): Promise<void> {
  // Validate all distinct RPC URLs we might use.
  const seen = new Set<string>();
  const toCheck: Array<{ label: string; url: string; required: boolean }> = [];

  const add = (label: string, url: string | null, required: boolean) => {
    if (url && !seen.has(url)) { seen.add(url); toCheck.push({ label, url, required }); }
  };

  add('RPC_URL', EXPLICIT_RPC, true);
  add('proxy', PROXY_RPC, false);        // proxy failure is non-fatal if another RPC is present
  add('fallback', ENV_FALLBACK_RPC, true);

  for (const { label, url, required } of toCheck) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
      });
      const body = await resp.json() as { result?: string };
      const actual = parseInt(body.result ?? '0x0', 16);
      if (actual !== CHAIN_ID) {
        console.error(
          `[startup] FATAL: RPC [${label}] chain ID mismatch. ` +
          `Expected ${CHAIN_ID} (${IS_MAINNET ? 'mainnet' : 'testnet'}), got ${actual}.`,
        );
        process.exit(1);
      }
      console.log(`[startup] RPC [${label}] chain ID confirmed: ${actual}`);
    } catch (e) {
      if (required) {
        console.error(`[startup] FATAL: RPC [${label}] unreachable:`, e);
        process.exit(1);
      }
      console.warn(`[startup] WARNING: RPC [${label}] unreachable (${e}); will use primary RPC`);
    }
  }
}

// Price: 0.01 USDC in Arc native 18-decimal units = 1e16 wei
const PRICE_NATIVE = BigInt('10000000000000000'); // arc-studio-allow-onchain-literal

const STABLEDESK_API_KEY = process.env.STABLEDESK_API_KEY ?? '';
const STABLEDESK_BASE = 'https://stabledesk.xyz';

// Railway (and most hosts) inject PORT and route traffic to it; BACKEND_PORT is the Studio sandbox name.
const PORT = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001);
const QUERY_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Deployment block for full-history event scan
const DEPLOY_BLOCK = BigInt(process.env.DEPLOY_BLOCK ?? process.env.VITE_DEPLOY_BLOCK ?? '0');
// Max blocks per getLogs call
const CHUNK_SIZE = BigInt(2000);

// ---------------------------------------------------------------------------
// viem client
// ---------------------------------------------------------------------------

const publicClient = createPublicClient({ transport: http(RPC_URL) });

// ---------------------------------------------------------------------------
// Commit-reveal: generate challenge
// ---------------------------------------------------------------------------

/** Returns 64-char hex nonce (32 bytes) and its keccak256 as the on-chain queryId. */
function generateChallenge(): { nonce: string; queryIdHex: Hex } {
  const nonceBytes = randomBytes(32);
  const nonce = nonceBytes.toString('hex');
  const queryIdHex = ('0x' + keccak256Hex(nonceBytes as unknown as Uint8Array)) as Hex;
  return { nonce, queryIdHex };
}

// ---------------------------------------------------------------------------
// Valid queries
// ---------------------------------------------------------------------------

const QUERIES: Record<string, { path: string }> = {
  stablecoins: { path: '/v1/stablecoins' },
  stablecoin:  { path: '/v1/stablecoins/{symbol}' },
  network:     { path: '/v1/network' },
  transfers:   { path: '/v1/transfers/largest' },
};

function buildStabledeskUrl(query: string, params: string): string | null {
  if (query === 'stablecoins') return `${STABLEDESK_BASE}/v1/stablecoins`;
  if (query === 'stablecoin') return params ? `${STABLEDESK_BASE}/v1/stablecoins/${encodeURIComponent(params)}` : null;
  if (query === 'network') return `${STABLEDESK_BASE}/v1/network`;
  if (query === 'transfers') return `${STABLEDESK_BASE}/v1/transfers/largest`;
  return null;
}

// ---------------------------------------------------------------------------
// Stabledesk proxy
// ---------------------------------------------------------------------------

async function fetchStabledesk(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await fetch(url, {
    headers: { 'X-API-Key': STABLEDESK_API_KEY, Accept: 'application/json' },
  });
  const data = await resp.json().catch(() => ({ error: 'non-json response' }));
  return { ok: resp.ok, status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Receipt validation (commit-reveal + SQLite atomicity)
// ---------------------------------------------------------------------------

type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

async function validatePayment(
  txHashRaw: string,
  nonce: string,
  query: string,
  params: string,
): Promise<ValidationResult> {
  // 1. Derive the expected on-chain queryId from the nonce.
  let expectedQueryId: string;
  try {
    expectedQueryId = keccak256FromNonce(nonce);
  } catch {
    return { ok: false, code: 'invalid_nonce', message: 'Nonce is not valid hex.' };
  }
  const expectedQueryIdHex = ('0x' + expectedQueryId).toLowerCase();

  // 2. Check nonce is in the DB (issued by us, not expired).
  const record = getChallenge(nonce);
  if (!record) {
    return { ok: false, code: 'expired', message: 'Nonce not found or expired (10 minute window elapsed).' };
  }
  if (Date.now() > record.expires_at) {
    deleteChallenge(nonce);
    return { ok: false, code: 'expired', message: 'Challenge expired (10 minute window elapsed).' };
  }
  if (record.query !== query || record.params !== params) {
    return {
      ok: false,
      code: 'wrong_query',
      message: `Nonce was issued for query "${record.query}/${record.params}", not "${query}/${params}".`,
    };
  }

  // 3. Check keccak256(nonce) matches stored queryIdHex.
  if (record.query_id_hex.toLowerCase() !== expectedQueryIdHex) {
    return { ok: false, code: 'nonce_mismatch', message: 'Nonce does not match the issued queryId.' };
  }

  // 4. Check not already redeemed (fast DB check before hitting RPC).
  if (isRedeemed(nonce)) {
    return { ok: false, code: 'already_redeemed', message: 'This nonce has already been redeemed.' };
  }

  // 5. Fetch tx receipt.
  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | null = null;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHashRaw as Hex });
  } catch {
    return { ok: false, code: 'tx_not_found_yet', message: 'Transaction receipt not found. It may still be pending.' };
  }
  if (!receipt || receipt.status !== 'success') {
    return { ok: false, code: 'tx_failed', message: 'Transaction failed or not yet confirmed.' };
  }
  if (receipt.to?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    return { ok: false, code: 'wrong_contract', message: 'Transaction was not sent to the QueryPayments contract.' };
  }

  // 6. Find QueryPaid event matching keccak256(nonce).
  let found = false;
  let paidAmount = BigInt(0);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
    if (!log.topics[1]) continue;
    if (log.topics[1].toLowerCase() !== expectedQueryIdHex) continue;
    paidAmount = BigInt(log.data);
    found = true;
    break;
  }
  if (!found) {
    return { ok: false, code: 'event_not_found', message: 'QueryPaid event not found for keccak256(nonce).' };
  }
  if (paidAmount < PRICE_NATIVE) {
    return { ok: false, code: 'underpaid', message: 'Paid amount is less than current price.' };
  }

  // 7. Atomically mark redeemed (inside a DB transaction with UNIQUE guard).
  //    NOTE: do NOT mark redeemed yet — that happens AFTER the upstream call succeeds.
  //    Return ok here; the caller will markRedeemed + deleteChallenge after Stabledesk responds.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Event log scanner — polled by the backend, served via /api/recent
// ---------------------------------------------------------------------------

// keccak256("QueryPaid(bytes32,address,uint256)") computed at startup.
const QUERY_PAID_TOPIC0 = ('0x' + keccak256Hex(
  new TextEncoder().encode('QueryPaid(bytes32,address,uint256)') as unknown as Uint8Array
)) as Hex;

interface RecentEvent {
  queryId: string;
  payer: string;
  amount: string;
  blockNumber: string;
  txHash: string;
}

// In-memory cache for the recent-events feed.
// Updated by the background scanner every 15 s.
let cachedRecentEvents: RecentEvent[] = [];
let scanCursor: bigint = DEPLOY_BLOCK > 0n ? DEPLOY_BLOCK : 0n;
let scanInitialized = false;

async function scanNewEvents(): Promise<void> {
  const head = await publicClient.getBlockNumber();

  // On first run: scan from deploy block (or head - 5000 if deploy block is 0).
  if (!scanInitialized) {
    scanCursor = DEPLOY_BLOCK > 0n ? DEPLOY_BLOCK : (head > 5000n ? head - 5000n : 0n);
    scanInitialized = true;
  }

  if (scanCursor > head) return;

  const results: RecentEvent[] = [];
  let chunkEnd = head;
  const scanFrom = scanCursor;

  while (chunkEnd >= scanFrom) {
    const chunkStart = chunkEnd > scanFrom + CHUNK_SIZE - 1n ? chunkEnd - CHUNK_SIZE + 1n : scanFrom;
    try {
      const logs = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        topics: [QUERY_PAID_TOPIC0],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        results.push({
          queryId: log.topics[1] ?? '0x',
          payer: log.topics[2] ? ('0x' + log.topics[2].slice(26)) : '0x',
          amount: BigInt(log.data).toString(),
          blockNumber: (log.blockNumber ?? 0n).toString(),
          txHash: log.transactionHash ?? '',
        });
      }
    } catch (e) {
      console.warn('[scanner] getLogs error for chunk', chunkStart, '-', chunkEnd, ':', e);
    }
    if (chunkStart <= scanFrom) break;
    chunkEnd = chunkStart - 1n;
  }

  // Update cursor to head + 1 so next run only fetches new blocks.
  scanCursor = head + 1n;

  // Merge: prepend new results, keep most recent 100 events.
  const seen = new Set(cachedRecentEvents.map((e) => e.txHash));
  const newEvents = results.filter((e) => !seen.has(e.txHash));
  cachedRecentEvents = [...newEvents, ...cachedRecentEvents]
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))
    .slice(0, 100);

  if (newEvents.length > 0) {
    console.log(`[scanner] found ${newEvents.length} new events (cursor now ${scanCursor})`);
  }
}

// ---------------------------------------------------------------------------
// Static file serving (production: dist/ built by `bun run build`)
// ---------------------------------------------------------------------------

const DIST_DIR = resolve(import.meta.dir, '..', 'dist');
const DIST_EXISTS = existsSync(DIST_DIR);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
};

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!DIST_EXISTS) return false;
  const abs = join(DIST_DIR, filePath);
  // Prevent path traversal
  if (!abs.startsWith(DIST_DIR)) return false;
  if (!existsSync(abs) || statSync(abs).isDirectory()) return false;
  const ext = extname(abs).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const body = readFileSync(abs);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  res.writeHead(200);
  res.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment-Tx, X-Payment-Nonce');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { pathname } = url;

  if (pathname === '/health') {
    json(res, 200, { ok: true, network: IS_MAINNET ? 'mainnet' : 'testnet', chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS });
    return;
  }

  // GET /api/recent — recent QueryPaid events from background scanner
  if (pathname === '/api/recent') {
    json(res, 200, { ok: true, events: cachedRecentEvents });
    return;
  }

  const match = pathname.match(/^\/api\/q\/([a-z]+)$/);
  if (!match) {
    // Try static file (production build), then fall back to index.html for SPA routing.
    if (DIST_EXISTS) {
      if (serveStatic(res, pathname)) return;
      // SPA fallback: serve index.html for any unknown path that looks like a page route.
      if (!pathname.startsWith('/api/') && serveStatic(res, 'index.html')) return;
    }
    json(res, 404, { error: 'not_found', message: 'Unknown endpoint.' });
    return;
  }

  const query = match[1];
  const params = url.searchParams.get('symbol') ?? '';

  if (!QUERIES[query]) {
    json(res, 404, { error: 'not_found', message: `Unknown query "${query}". Valid: ${Object.keys(QUERIES).join(', ')}` });
    return;
  }
  if (query === 'stablecoin' && !params) {
    json(res, 400, { error: 'missing_param', message: 'Provide ?symbol=USDC' });
    return;
  }

  const paymentTx = (req.headers['x-payment-tx'] as string | undefined) ?? '';
  const paymentNonce = (req.headers['x-payment-nonce'] as string | undefined) ?? '';

  // ---- No payment: issue 402 challenge ----
  if (!paymentTx) {
    const { nonce, queryIdHex } = generateChallenge();
    saveChallenge(nonce, queryIdHex, query, params, Date.now() + QUERY_TTL_MS);
    json(res, 402, {
      error: 'payment_required',
      message: 'Pay and re-request with X-Payment-Tx and X-Payment-Nonce headers.',
      payment: {
        chainId: CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        price: PRICE_NATIVE.toString(),
        priceUsdc: '0.01',
        queryIdHex,
        nonce,
        validFor: '10 minutes',
        instructions: {
          step1: `Call pay(queryIdHex) on contract ${CONTRACT_ADDRESS} with value=${PRICE_NATIVE} (0.01 USDC native wei)`,
          step2: 'Re-request with: X-Payment-Tx: <txHash>  X-Payment-Nonce: <nonce>',
        },
      },
    });
    return;
  }

  // ---- Payment present: validate and serve ----
  if (!paymentNonce) {
    json(res, 400, { error: 'missing_nonce', message: 'Provide X-Payment-Nonce header (the secret from the 402 response).' });
    return;
  }

  const validation = await validatePayment(paymentTx, paymentNonce, query, params);
  if (!validation.ok) {
    const statusMap: Record<string, number> = {
      tx_not_found_yet: 202,
      tx_failed: 400,
      wrong_contract: 400,
      event_not_found: 400,
      underpaid: 402,
      expired: 410,
      already_redeemed: 409,
      wrong_query: 400,
      nonce_mismatch: 400,
      invalid_nonce: 400,
    };
    json(res, statusMap[validation.code] ?? 400, { error: validation.code, message: validation.message });
    return;
  }

  // Build upstream URL.
  const sdUrl = buildStabledeskUrl(query, params);
  if (!sdUrl) {
    json(res, 400, { error: 'invalid_query', message: 'Query parameters are invalid.' });
    return;
  }

  // Call Stabledesk. Only mark redeemed AFTER a successful response.
  const sdResult = await fetchStabledesk(sdUrl).catch((e: unknown) => ({
    ok: false as const,
    status: 502,
    data: { error: 'upstream_error', message: String(e) },
  }));

  if (!sdResult.ok) {
    // Upstream failed — leave nonce unredeemed so the payer can retry.
    json(res, 502, { error: 'upstream_error', message: 'Stabledesk API returned an error.', upstream: sdResult.data });
    return;
  }

  // Atomically mark redeemed — if two concurrent requests race, only one succeeds.
  const derivedQueryIdHex = '0x' + keccak256FromNonce(paymentNonce);
  let recorded = false;
  try {
    recorded = markRedeemed(paymentNonce, derivedQueryIdHex);
  } catch (e) {
    console.error('[handler] markRedeemed threw:', e);
    json(res, 500, { error: 'internal_error', message: 'Failed to record redemption.' });
    return;
  }
  if (!recorded) {
    json(res, 409, { error: 'already_redeemed', message: 'This nonce has already been redeemed.' });
    return;
  }

  // Clean up the challenge row now that it's fully committed.
  deleteChallenge(paymentNonce);

  json(res, 200, { ok: true, query, params, data: sdResult.data });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

validateAllRpcs().then(async () => {
  // Initial scan before starting the server so the feed has data immediately.
  await scanNewEvents().catch((e) => console.warn('[scanner] initial scan error:', e));

  const server = createServer(handler);
  server.listen(PORT, () => {
    console.log(`[stabledesk-backend] listening on :${PORT} | network=${IS_MAINNET ? 'mainnet' : 'testnet'} | chain=${CHAIN_ID}`);
    console.log(`[stabledesk-backend] contract=${CONTRACT_ADDRESS}`);
    console.log(`[stabledesk-backend] deploy_block=${DEPLOY_BLOCK} | chunk_size=${CHUNK_SIZE}`);
  });

  // Background scanner: poll for new events every 15 s.
  setInterval(() => { scanNewEvents().catch((e) => console.warn('[scanner] poll error:', e)); }, 15_000);

  // Prune expired DB rows every 5 min.
  setInterval(pruneExpired, 5 * 60_000);
}).catch((e) => {
  console.error('[startup] failed:', e);
  process.exit(1);
});
