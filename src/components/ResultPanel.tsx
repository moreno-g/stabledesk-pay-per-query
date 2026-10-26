import { ExternalLink } from 'lucide-react';
import { buildTxExplorerUrl } from '@/onchain-facts';
import { CHAIN_ID } from '../contract';
import type { QueryResult } from '../types';

interface Props {
  result: QueryResult;
  txHash: string;
}

export function ResultPanel({ result, txHash }: Props) {
  const explorerUrl = buildTxExplorerUrl(CHAIN_ID, txHash);

  return (
    <div className="space-y-3 animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--ink-2)] uppercase tracking-wider">Result</h3>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          View tx <ExternalLink size={12} />
        </a>
      </div>
      <div className="rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] p-4 overflow-auto max-h-96">
        <pre className="mono text-xs text-[var(--ink-2)] whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(result.data, null, 2)}
        </pre>
      </div>
    </div>
  );
}
