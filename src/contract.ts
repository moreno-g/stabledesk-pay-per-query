/**
 * QueryPayments contract configuration.
 * All values come from env — never hardcoded.
 *
 * Network mode is driven by VITE_NETWORK (set to "mainnet" for production).
 * In mainnet mode the build fails at Vite startup if any required variable is missing.
 */
// Committed copy of the ABI (forge inspect QueryPayments abi): contracts/out/ is a build
// directory, ignored by git, so it does not exist on a host that builds from the repo.
import abi from './abi/QueryPayments.json';
import { requireChain } from '@/onchain-facts';

const NETWORK = import.meta.env.VITE_NETWORK as string | undefined;
export const IS_MAINNET = NETWORK === 'mainnet';

// ---------------------------------------------------------------------------
// Mainnet guard: fail the build if any required variable is missing.
// ---------------------------------------------------------------------------
if (IS_MAINNET) {
  const required = ['VITE_MAINNET_CONTRACT_ADDRESS', 'VITE_MAINNET_CHAIN_ID'] as const;
  for (const key of required) {
    if (!import.meta.env[key]) {
      throw new Error(
        `[contract] FATAL: mainnet mode requires ${key} in .env. ` +
        `Set VITE_NETWORK=mainnet only when all mainnet variables are provided.`
      );
    }
  }
}

// Chain ID
export const CHAIN_ID: number = IS_MAINNET
  ? Number(import.meta.env.VITE_MAINNET_CHAIN_ID)
  : Number(import.meta.env.VITE_ARC_TESTNET_CHAIN_ID ?? 5042002);

// Chain facts (explorer base, etc.) — read from the generated registry.
export const CHAIN = requireChain(CHAIN_ID);

// Contract address — read from env, never hardcoded.
export const CONTRACT_ADDRESS: `0x${string}` = IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_CONTRACT_ADDRESS as `0x${string}`)
  : (import.meta.env.VITE_CONTRACT_ADDRESS as `0x${string}`);

// 0.01 USDC in Arc native 18-decimal units = 1e16 wei
export const QUERY_PRICE_NATIVE = BigInt('10000000000000000');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CONTRACT_ABI = abi as any[];
