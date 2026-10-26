export type QueryKey = 'stablecoins' | 'stablecoin' | 'network' | 'transfers';

export interface QueryDef {
  key: QueryKey;
  label: string;
  description: string;
  paramLabel?: string;
  paramPlaceholder?: string;
}

export const QUERY_DEFS: QueryDef[] = [
  {
    key: 'stablecoins',
    label: 'Stablecoins Overview',
    description: 'All stablecoins on Arc mainnet with supply and metadata.',
  },
  {
    key: 'stablecoin',
    label: 'Single Stablecoin',
    description: 'Supply and details for one stablecoin by symbol.',
    paramLabel: 'Symbol',
    paramPlaceholder: 'e.g. USDC',
  },
  {
    key: 'network',
    label: 'Network Stats',
    description: 'Arc network stats: transaction volume, fee metrics, active accounts.',
  },
  {
    key: 'transfers',
    label: 'Largest Transfers',
    description: 'Most recent largest USDC/stablecoin transfers on Arc.',
  },
];

export interface PaymentChallenge {
  chainId: number;
  contractAddress: string;
  price: string;
  priceUsdc: string;
  /** keccak256(nonce) — pass this to pay() on-chain as the queryId argument. */
  queryIdHex: `0x${string}`;
  /** Secret nonce. Never goes on-chain. Send back in X-Payment-Nonce to redeem. */
  nonce: string;
  validFor: string;
}

export interface QueryResult {
  ok: boolean;
  query: string;
  params?: string;
  data: unknown;
}

export interface RecentQueryEvent {
  queryId: string;
  payer: string;
  amount: bigint;
  blockNumber: bigint;
  txHash: string;
  timestamp?: number;
}
