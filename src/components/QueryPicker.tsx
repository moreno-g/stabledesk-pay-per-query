import { QUERY_DEFS, type QueryDef, type QueryKey } from '../types';
import { Database, BarChart3, ArrowUpDown, CircleDot } from 'lucide-react';

const ICONS: Record<QueryKey, React.ReactNode> = {
  stablecoins: <Database size={16} />,
  stablecoin:  <CircleDot size={16} />,
  network:     <BarChart3 size={16} />,
  transfers:   <ArrowUpDown size={16} />,
};

interface Props {
  selected: QueryKey;
  symbol: string;
  onSelect: (key: QueryKey) => void;
  onSymbol: (s: string) => void;
}

export function QueryPicker({ selected, symbol, onSelect, onSymbol }: Props) {
  return (
    <div className="space-y-2">
      {QUERY_DEFS.map((q: QueryDef) => {
        const active = q.key === selected;
        return (
          <button
            key={q.key}
            onClick={() => onSelect(q.key)}
            className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-150 group
              ${active
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--ink)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--ink-2)]'
              }`}
          >
            <div className="flex items-center gap-2">
              <span className={active ? 'text-[var(--accent)]' : 'text-[var(--subtle)]'}>
                {ICONS[q.key]}
              </span>
              <span className="font-medium text-sm">{q.label}</span>
            </div>
            {active && (
              <p className="text-xs text-[var(--muted)] mt-1 ml-6">{q.description}</p>
            )}
          </button>
        );
      })}

      {/* Symbol param input when stablecoin is selected */}
      {selected === 'stablecoin' && (
        <div className="mt-2 ml-2">
          <label className="block text-xs text-[var(--muted)] mb-1 uppercase tracking-wider">Symbol</label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => onSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. USDC"
            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none focus:border-[var(--accent)] mono"
          />
        </div>
      )}
    </div>
  );
}
