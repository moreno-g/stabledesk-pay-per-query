/**
 * End-to-end 402 flow test — uses the funded platform deployer wallet.
 * Run: AGENT_PRIVATE_KEY=<key> bun run agent-test.mjs
 * Or fund a fresh wallet and set AGENT_PRIVATE_KEY.
 */
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { arcTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('Set AGENT_PRIVATE_KEY'); process.exit(1); }

const QUERY = process.env.QUERY ?? 'network';
const SYMBOL = process.env.SYMBOL ?? '';
const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const CONTRACT = process.env.VITE_CONTRACT_ADDRESS;
if (!CONTRACT) { console.error('Set VITE_CONTRACT_ADDRESS'); process.exit(1); }

const ABI = parseAbi(['function pay(bytes32 queryId) external payable']);
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http() });
const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

const url = `${API_BASE}/api/q/${QUERY}${SYMBOL ? '?symbol=' + SYMBOL : ''}`;
console.log('[agent] requesting challenge from', url);

// Step 1: challenge
const c402 = await fetch(url);
if (c402.status !== 402) throw new Error(`Expected 402, got ${c402.status}: ${await c402.text()}`);
const body402 = await c402.json();
const { payment } = body402;
console.log('[agent] challenge received');
console.log('[agent]   queryIdHex :', payment.queryIdHex);
console.log('[agent]   nonce      : (secret, not shown)');
console.log('[agent]   price      :', payment.priceUsdc, 'USDC');

// Step 2: pay on-chain
console.log('[agent] submitting pay() to contract', CONTRACT);
const txHash = await walletClient.writeContract({
  address: CONTRACT,
  abi: ABI,
  functionName: 'pay',
  args: [payment.queryIdHex],
  value: BigInt(payment.price),
});
console.log('[agent] tx hash:', txHash);

// Wait for receipt confirmation
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
console.log('[agent] confirmed at block', receipt.blockNumber.toString());

// Step 3: redeem with nonce (commit-reveal)
console.log('[agent] redeeming with nonce...');
for (let i = 0; i < 20; i++) {
  let r, data;
  try {
    r = await fetch(url, {
      headers: { 'X-Payment-Tx': txHash, 'X-Payment-Nonce': payment.nonce },
    });
    data = await r.json();
  } catch {
    // Network error or connection dropped — retry
    process.stdout.write('!');
    await new Promise(x => setTimeout(x, 1500));
    continue;
  }
  if (r.status === 202 || data?.error === 'tx_not_found_yet') {
    process.stdout.write('.');
    await new Promise(x => setTimeout(x, 1500));
    continue;
  }
  if (r.ok) {
    console.log('\n[agent] SUCCESS');
    console.log('[agent] tx hash:', txHash);
    console.log('[agent] response:');
    console.log(JSON.stringify(data.data, null, 2));
    process.exit(0);
  }
  throw new Error(`Redemption failed: ${data.error} — ${data.message}`);
}
throw new Error('Timed out waiting for redemption.');
