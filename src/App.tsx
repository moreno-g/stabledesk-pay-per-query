import { useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import { Database, Bot } from 'lucide-react';
import { QueryPicker } from './components/QueryPicker';
import { PayButton } from './components/PayButton';
import { ResultPanel } from './components/ResultPanel';
import { RecentFeed } from './components/RecentFeed';
import { AgentGuide } from './components/AgentGuide';
import { CONTRACT_ADDRESS, CHAIN_ID, CHAIN, IS_MAINNET } from './contract';
import type { QueryKey, QueryResult } from './types';

export default function App() {
  const [query, setQuery] = useState<QueryKey>('stablecoins');
  const [symbol, setSymbol] = useState('USDC');
  const [result, setResult] = useState<{ data: QueryResult; txHash: string } | null>(null);
  const [tab, setTab] = useState<'query' | 'agents'>('query');

  const handleResult = (data: QueryResult, txHash: string) => {
    setResult({ data, txHash });
  };

  const networkLabel = IS_MAINNET ? 'Arc Mainnet' : 'Arc Testnet';
  const contractExplorerUrl = `${CHAIN.explorerBase}/address/${CONTRACT_ADDRESS}`;

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* Testnet banner — only shown when NOT mainnet */}
      {!IS_MAINNET && (
        <div className="w-full text-center py-1.5 bg-amber-500/20 border-b border-amber-500/30">
          <span className="text-xs font-semibold text-amber-300 tracking-widest uppercase">Testnet</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent)]/20 flex items-center justify-center">
              <Database size={14} className="text-[var(--accent)]" />
            </div>
            <div>
              <h1 className="display text-sm font-semibold text-[var(--ink)] leading-none">Stabledesk Pay-per-Query</h1>
              <p className="text-xs text-[var(--subtle)] leading-none mt-0.5">Arc stablecoin data · 0.01 USDC/call</p>
            </div>
          </div>
          <ConnectKitButton />
        </div>
      </header>

      {/* Main */}
      <main className="max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">

        {/* Left column */}
        <div className="space-y-5">
          {/* Tab bar */}
          <div className="flex gap-1 p-1 bg-[var(--surface)] rounded-xl border border-[var(--border)] w-fit">
            <button
              onClick={() => setTab('query')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
                ${tab === 'query'
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink-2)]'}`}
            >
              <Database size={12} />
              Query
            </button>
            <button
              onClick={() => setTab('agents')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors
                ${tab === 'agents'
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink-2)]'}`}
            >
              <Bot size={12} />
              For Agents
            </button>
          </div>

          {tab === 'query' && (
            <div className="space-y-5">
              {/* Query selector */}
              <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-4">
                <div>
                  <h2 className="display text-base font-semibold text-[var(--ink)]">Choose a query</h2>
                  <p className="text-xs text-[var(--muted)] mt-1">
                    Each query costs <span className="text-[var(--ink-2)] font-medium">0.01 USDC</span>. No account or API key needed.
                  </p>
                </div>
                <QueryPicker
                  selected={query}
                  symbol={symbol}
                  onSelect={(k) => { setQuery(k); setResult(null); }}
                  onSymbol={setSymbol}
                />
              </div>

              {/* Pay */}
              <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5">
                <h2 className="display text-base font-semibold text-[var(--ink)] mb-4">Pay &amp; run</h2>
                <PayButton
                  query={query}
                  symbol={symbol}
                  onResult={handleResult}
                />
              </div>

              {/* Result */}
              {result && (
                <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5">
                  <ResultPanel result={result.data} txHash={result.txHash} />
                </div>
              )}

              {/* How it works */}
              <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-3">
                <h2 className="display text-sm font-semibold text-[var(--ink)]">How it works</h2>
                <ol className="space-y-2 text-xs text-[var(--muted)]">
                  {[
                    { n: '1', t: 'No account needed', d: 'Connect any wallet and pick a query.' },
                    { n: '2', t: 'Pay on-chain', d: '0.01 USDC in native Arc gas — no ERC-20 approve step. Forwards instantly to treasury.' },
                    { n: '3', t: 'Get fresh data', d: 'Backend verifies your receipt via the QueryPaid event and returns live Stabledesk data.' },
                    { n: '4', t: 'Commit-reveal', d: 'The nonce is secret. A front-runner who copies your tx cannot redeem without it.' },
                  ].map((s) => (
                    <li key={s.n} className="flex gap-3">
                      <span className="w-5 h-5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-xs flex items-center justify-center shrink-0 font-bold">{s.n}</span>
                      <span><span className="text-[var(--ink-2)] font-medium">{s.t}</span> — {s.d}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {tab === 'agents' && (
            <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-4">
              <div>
                <h2 className="display text-base font-semibold text-[var(--ink)]">For AI agents &amp; scripts</h2>
                <p className="text-xs text-[var(--muted)] mt-1">
                  No account, no API key, no subscription. Just send a transaction and get data.
                </p>
              </div>
              <AgentGuide selectedQuery={query} symbol={symbol} />
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {/* Price card */}
          <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5">
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-1">Price per query</p>
            <p className="display text-3xl font-bold text-[var(--ink)] tabular-nums">$0.01</p>
            <p className="text-xs text-[var(--subtle)] mt-1">{networkLabel} · native USDC</p>
            <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1 text-xs text-[var(--muted)]">
              <div className="flex justify-between">
                <span>Contract</span>
                <a
                  href={contractExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  {CONTRACT_ADDRESS.slice(0, 8)}…
                </a>
              </div>
              <div className="flex justify-between">
                <span>Chain ID</span>
                <span className="mono text-[var(--ink-2)]">{CHAIN_ID}</span>
              </div>
              <div className="flex justify-between">
                <span>Queries available</span>
                <span className="text-[var(--ink-2)]">4</span>
              </div>
            </div>
          </div>

          {/* Recent feed */}
          <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5">
            <RecentFeed />
          </div>

          {/* Available queries mini list */}
          <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-5 space-y-3">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Available queries</p>
            {[
              { path: '/api/q/stablecoins', desc: 'All stablecoins' },
              { path: '/api/q/stablecoin?symbol=USDC', desc: 'Single stablecoin' },
              { path: '/api/q/network', desc: 'Network stats' },
              { path: '/api/q/transfers', desc: 'Largest transfers' },
            ].map((q) => (
              <div key={q.path} className="flex items-start justify-between gap-2">
                <span className="mono text-xs text-[var(--accent)] shrink-0">{q.path}</span>
                <span className="text-xs text-[var(--subtle)] text-right">{q.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
