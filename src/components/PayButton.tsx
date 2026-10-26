/**
 * Orchestrates the full HTTP 402 pay-per-query flow:
 * 1. GET /api/q/<query> → 402 challenge
 * 2. pay(queryId) on contract with msg.value == price
 * 3. GET /api/q/<query> with X-Payment-Tx + X-Query-Id → data
 */
import { useState, useCallback } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi';
import { ConnectKitButton } from 'connectkit';
import { Zap, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { CONTRACT_ADDRESS, CONTRACT_ABI, QUERY_PRICE_NATIVE, CHAIN_ID, IS_MAINNET } from '../contract';
import type { QueryKey, PaymentChallenge, QueryResult } from '../types';

interface Props {
  query: QueryKey;
  symbol: string;
  onResult: (result: QueryResult, txHash: string) => void;
}

type Stage = 'idle' | 'challenge' | 'wallet' | 'confirming' | 'fetching' | 'done' | 'error';

export function PayButton({ query, symbol, onResult }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState('');
  const [currentChallenge, setCurrentChallenge] = useState<PaymentChallenge | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: txHash,
    onReplaced: () => {
      setStage('error');
      setError('Transaction was replaced. Please try again.');
    },
  });
  void isConfirming;

  const buildUrl = useCallback(() => {
    const base = `/api/q/${query}`;
    return symbol && query === 'stablecoin' ? `${base}?symbol=${encodeURIComponent(symbol)}` : base;
  }, [query, symbol]);

  const run = useCallback(async () => {
    if (!isConnected || !address) return;

    // Ensure correct chain
    if (chainId !== CHAIN_ID) {
      switchChain({ chainId: CHAIN_ID });
      return;
    }

    if (query === 'stablecoin' && !symbol.trim()) {
      toast.error('Enter a stablecoin symbol first.');
      return;
    }

    setError('');
    setStage('challenge');

    try {
      // Step 1: fetch challenge
      const url = buildUrl();
      const challengeResp = await fetch(url);
      if (challengeResp.status !== 402) {
        throw new Error(`Expected 402, got ${challengeResp.status}`);
      }
      const challengeBody = await challengeResp.json() as { payment: PaymentChallenge };
      const challenge = challengeBody.payment;
      setCurrentChallenge(challenge);

      // Step 2: call pay(queryId) on contract
      setStage('wallet');
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'pay',
        args: [challenge.queryIdHex],
        value: QUERY_PRICE_NATIVE,
        chainId: CHAIN_ID,
      });
      setTxHash(hash);
      setStage('confirming');

      // Step 3: wait for receipt via RPC
      // Poll until confirmed (Arc has sub-second blocks)
      // Use commit-reveal: send the secret nonce so the backend can verify keccak256(nonce) == queryId.
      // Without the nonce, a mempool observer cannot redeem even if they see the tx.
      let confirmed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const statusResp = await fetch(url, {
          headers: {
            'X-Payment-Tx': hash,
            'X-Payment-Nonce': challenge.nonce,
          },
        });
        if (statusResp.status === 202) continue; // tx_not_found_yet
        if (statusResp.ok) {
          const result = await statusResp.json() as QueryResult;
          setStage('done');
          onResult(result, hash);
          confirmed = true;
          break;
        }
        const body = await statusResp.json() as { error: string; message: string };
        if (body.error === 'tx_not_found_yet') continue;
        throw new Error(body.message ?? body.error);
      }
      if (!confirmed) throw new Error('Transaction not confirmed after 45 seconds. Check the explorer and retry.');

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user denied')) {
        setStage('idle');
        return;
      }
      setError(msg);
      setStage('error');
    }
  }, [isConnected, address, chainId, query, symbol, buildUrl, switchChain, writeContractAsync, onResult]);

  const reset = () => {
    setStage('idle');
    setError('');
    setCurrentChallenge(null);
    setTxHash(undefined);
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-[var(--muted)] text-center">Connect your wallet to pay for a query</p>
        <ConnectKitButton />
      </div>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => switchChain({ chainId: CHAIN_ID })}
          className="w-full py-3 px-6 rounded-xl font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 transition-colors"
        >
          Switch to {IS_MAINNET ? 'Arc Mainnet' : 'Arc Testnet'}
        </button>
        <p className="text-xs text-amber-400/80 text-center">
          Your wallet is on chain {chainId ?? 'unknown'}. The Pay button is disabled until you switch —
          paying from the wrong chain would send funds to an unrelated address.
        </p>
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[var(--success)]">
          <CheckCircle2 size={18} />
          <span className="text-sm font-medium">Query paid and delivered</span>
        </div>
        <button
          onClick={reset}
          className="w-full py-2.5 px-6 rounded-xl text-sm font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--ink-2)] hover:border-[var(--border-strong)] transition-colors"
        >
          Run another query
        </button>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-[var(--danger)]">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="text-xs leading-relaxed">{error}</span>
        </div>
        <button
          onClick={reset}
          className="w-full py-2.5 px-6 rounded-xl text-sm font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--ink-2)] hover:border-[var(--border-strong)] transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  const stageLabel: Record<Stage, string> = {
    idle: 'Pay 0.01 USDC and run query',
    challenge: 'Requesting challenge...',
    wallet: 'Confirm in wallet...',
    confirming: 'Confirming transaction...',
    fetching: 'Fetching data...',
    done: 'Done',
    error: 'Error',
  };

  const busy = stage !== 'idle';

  return (
    <div className="space-y-3">
      {currentChallenge && stage !== 'idle' && (
        <div className="rounded-lg bg-[var(--surface-muted)] p-3 space-y-1">
          <p className="text-xs text-[var(--muted)] uppercase tracking-wider">On-chain Query ID</p>
          <p className="mono text-xs text-[var(--ink-2)] break-all">{currentChallenge.queryIdHex}</p>
          <p className="text-xs text-[var(--subtle)] mt-1">Nonce (secret) held client-side — front-runners cannot redeem without it</p>
        </div>
      )}
      <button
        onClick={() => { void run(); }}
        disabled={busy}
        className="w-full py-3 px-6 rounded-xl font-semibold flex items-center justify-center gap-2
          bg-[var(--accent)] text-[#0d1b2f] hover:bg-[var(--accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed
          transition-all duration-150 text-sm"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
        {stageLabel[stage]}
      </button>
      <p className="text-xs text-[var(--subtle)] text-center">
        Price is charged in native USDC (Arc's gas token) — no approve step needed.
      </p>
    </div>
  );
}
