/**
 * "For Agents" section: curl + JS examples + Node agent script.
 */
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { CONTRACT_ADDRESS, CHAIN_ID } from '../contract';
import type { QueryKey } from '../types';

interface Props {
  selectedQuery: QueryKey;
  symbol: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      onClick={copy}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-[var(--surface-muted)] text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Code({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="mono text-xs text-[var(--ink-2)] bg-[var(--surface-muted)] rounded-xl p-4 pr-10 overflow-x-auto whitespace-pre leading-relaxed border border-[var(--border)]">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

export function AgentGuide({ selectedQuery, symbol }: Props) {
  const queryPath = selectedQuery === 'stablecoin'
    ? `/api/q/stablecoin?symbol=${symbol || 'USDC'}`
    : `/api/q/${selectedQuery}`;

  const baseUrl = 'https://your-deployed-app.com'; // Replace with getShareBase() in a real deploy

  const curlExample = `# Commit-reveal: the nonce is secret — a front-runner who sees the tx
# on-chain still cannot redeem without it.

# Step 1: Request challenge (returns 402 with queryIdHex + nonce)
curl -i ${baseUrl}${queryPath}
# Save payment.queryIdHex and payment.nonce from the response.

# Step 2: Pay on-chain — call pay(queryIdHex) with value = 10000000000000000
# The nonce never goes on-chain. Using cast (Foundry):
cast send ${CONTRACT_ADDRESS} \\
  "pay(bytes32)" <QUERY_ID_HEX> \\
  --value 10000000000000000 \\
  --rpc-url https://rpc.testnet.arc.io \\
  --private-key $PRIVATE_KEY

# Step 3: Redeem with tx hash + secret nonce
curl ${baseUrl}${queryPath} \\
  -H "X-Payment-Tx: <TX_HASH>" \\
  -H "X-Payment-Nonce: <NONCE>"`;

  const jsExample = `// JavaScript / TypeScript — browser or Node
// Commit-reveal: nonce is kept client-side, never sent on-chain.
const API = '${baseUrl}';

async function paidQuery(query, symbol) {
  const url = \`\${API}/api/q/\${query}\${symbol ? '?symbol=' + symbol : ''}\`;

  // Step 1: Get challenge
  const c = await fetch(url);
  const { payment } = await c.json();
  // payment.queryIdHex = keccak256(nonce) — pass to pay()
  // payment.nonce      = secret, held client-side for redemption

  // Step 2: Pay on-chain (wagmi / viem)
  // contract.pay(payment.queryIdHex, { value: BigInt(payment.price) })
  const txHash = await payOnChain(payment.queryIdHex, BigInt(payment.price));

  // Step 3: Redeem — send tx hash + secret nonce (not the queryId itself)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const r = await fetch(url, {
      headers: {
        'X-Payment-Tx': txHash,
        'X-Payment-Nonce': payment.nonce,   // <- commit-reveal secret
      },
    });
    if (r.status === 202) continue; // tx_not_found_yet, keep polling
    return r.json();
  }
  throw new Error('Timed out');
}`;

  const nodeAgentScript = `#!/usr/bin/env node
/**
 * Stabledesk Pay-per-Query — autonomous Node.js agent (commit-reveal)
 * The nonce never goes on-chain — only keccak256(nonce) is used as the
 * on-chain queryId. A mempool observer cannot redeem without the nonce.
 *
 * Prerequisites: bun or Node 22+ (native fetch)
 * Usage:
 *   AGENT_PRIVATE_KEY=0x... QUERY=stablecoins node agent.mjs
 *   AGENT_PRIVATE_KEY=0x... QUERY=stablecoin SYMBOL=USDC node agent.mjs
 */
import { createWalletClient, http, parseAbi } from 'viem';
import { arcTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error('Set AGENT_PRIVATE_KEY env var');

const QUERY = process.env.QUERY ?? 'stablecoins';
const SYMBOL = process.env.SYMBOL ?? '';
const API_BASE = process.env.API_BASE ?? 'http://localhost:3001';
const CONTRACT = '${CONTRACT_ADDRESS}';

const ABI = parseAbi(['function pay(bytes32 queryId) external payable']);
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
  account, chain: arcTestnet, transport: http(),
});

const url = \`\${API_BASE}/api/q/\${QUERY}\${SYMBOL ? '?symbol=' + SYMBOL : ''}\`;
console.log('[agent] requesting', url);

// Step 1: Get challenge
const challengeResp = await fetch(url);
if (challengeResp.status !== 402) throw new Error('Expected 402, got ' + challengeResp.status);
const { payment } = await challengeResp.json();
console.log('[agent] queryIdHex:', payment.queryIdHex, '— price:', payment.priceUsdc, 'USDC');
// payment.nonce is secret — hold it; it enables redemption without front-running risk.

// Step 2: Pay on-chain (pass queryIdHex = keccak256(nonce), nonce never on-chain)
const txHash = await walletClient.writeContract({
  address: CONTRACT,
  abi: ABI,
  functionName: 'pay',
  args: [payment.queryIdHex],
  value: BigInt(payment.price),
});
console.log('[agent] tx sent:', txHash);

// Step 3: Redeem — poll with tx hash + secret nonce
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const r = await fetch(url, {
    headers: {
      'X-Payment-Tx': txHash,
      'X-Payment-Nonce': payment.nonce,   // <- secret nonce (commit-reveal)
    },
  });
  if (r.status === 202) { process.stdout.write('.'); continue; }
  const data = await r.json();
  if (r.ok) {
    console.log('\\n[agent] result:', JSON.stringify(data.data, null, 2));
    process.exit(0);
  }
  throw new Error(data.message ?? data.error);
}
throw new Error('Timed out waiting for confirmation.');
`;

  const tabs = [
    { id: 'curl', label: 'curl', code: curlExample },
    { id: 'js', label: 'JavaScript', code: jsExample },
    { id: 'node', label: 'Node Agent', code: nodeAgentScript },
  ];

  const [active, setActive] = useState('curl');

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
              ${active === t.id
                ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
                : 'bg-[var(--surface)] text-[var(--muted)] border border-[var(--border)] hover:text-[var(--ink-2)]'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tabs.filter((t) => t.id === active).map((t) => (
        <Code key={t.id} code={t.code} />
      ))}

      <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] p-4 space-y-2">
        <p className="text-xs font-semibold text-[var(--ink-2)]">Contract details</p>
        <div className="space-y-1 text-xs text-[var(--muted)]">
          <div className="flex gap-2"><span className="text-[var(--subtle)] shrink-0">Address:</span><span className="mono text-[var(--ink-2)] break-all">{CONTRACT_ADDRESS}</span></div>
          <div className="flex gap-2"><span className="text-[var(--subtle)] shrink-0">Chain ID:</span><span className="mono text-[var(--ink-2)]">{CHAIN_ID}</span></div>
          <div className="flex gap-2"><span className="text-[var(--subtle)] shrink-0">Price:</span><span className="mono text-[var(--ink-2)]">10000000000000000 wei (0.01 USDC)</span></div>
          <div className="flex gap-2"><span className="text-[var(--subtle)] shrink-0">Function:</span><span className="mono text-[var(--ink-2)]">pay(bytes32 queryId) payable</span></div>
        </div>
      </div>
    </div>
  );
}
