/**
 * Recent paid queries feed.
 * Polls /api/recent (served by the backend event scanner) every 15 s.
 * The backend scans from DEPLOY_BLOCK with a cursor, so all history is included.
 */
import { useEffect, useState, useCallback } from 'react';
import { ExternalLink, Clock } from 'lucide-react';
import { buildTxExplorerUrl } from '@/onchain-facts';
import { CHAIN_ID } from '../contract';
import { formatUnitsFixed } from '@/onchain-money';
import type { RecentQueryEvent } from '../types';

interface ApiEvent {
  queryId: string;
  payer: string;
  amount: string;
  blockNumber: string;
  txHash: string;
}

function formatAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAgo(blockNumber: string): string {
  // Arc has ~0.57s blocks; show block number instead of wall-clock age.
  return `block ${Number(blockNumber).toLocaleString()}`;
}

export function RecentFeed() {
  const [events, setEvents] = useState<RecentQueryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const resp = await fetch('/api/recent');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json() as { ok: boolean; events: ApiEvent[] };
      const parsed: RecentQueryEvent[] = (body.events ?? []).map((ev) => ({
        queryId: ev.queryId,
        payer: ev.payer,
        amount: BigInt(ev.amount),
        blockNumber: BigInt(ev.blockNumber),
        txHash: ev.txHash,
      }));
      setEvents(parsed);
      setError('');
    } catch (e) {
      setError('Could not load recent events.');
      console.error('[RecentFeed]', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    void load();
    const interval = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock size={14} className="text-[var(--muted)]" />
        <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Recent Paid Queries</h3>
      </div>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-12 rounded-lg bg-[var(--surface)] animate-pulse" />
          ))}
        </div>
      )}

      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}

      {!loading && events.length === 0 && !error && (
        <p className="text-xs text-[var(--subtle)] text-center py-4">
          No queries yet — be the first!
        </p>
      )}

      <div className="space-y-2">
        {events.map((ev) => {
          const explorerUrl = buildTxExplorerUrl(CHAIN_ID, ev.txHash);
          // Arc native USDC = 18 decimals
          const amountFormatted = formatUnitsFixed(ev.amount, 18, 4);
          return (
            <div
              key={ev.txHash + ev.queryId}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[var(--success)] font-medium tabular-nums shrink-0">
                  {amountFormatted} USDC
                </span>
                <span className="text-[var(--subtle)] mono shrink-0">{formatAddr(ev.payer)}</span>
                <span className="text-[var(--subtle)] hidden sm:inline">{formatAgo(ev.blockNumber.toString())}</span>
              </div>
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors shrink-0 ml-2"
              >
                <ExternalLink size={12} />
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
