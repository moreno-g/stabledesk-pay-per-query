# Stabledesk Pay-per-Query

A pay-per-request stablecoin data API on Arc where anyone — human or AI agent — pays 0.01 USDC per call. No account, no API key, no subscription. Backed by the [Stabledesk API](https://stabledesk.xyz/v1) for live stablecoin data on Arc mainnet.

Built with [Arc Studio](https://studio.arc.io)

## Tech Stack

- **Frontend:** React 18, Vite, TypeScript, Tailwind CSS
- **Web3:** wagmi v2, viem v2, ConnectKit
- **Contract:** Solidity 0.8.28 (Foundry), deployed on Arc Testnet
- **Backend:** Bun HTTP server (long-running process, not serverless) implementing the HTTP 402 pay-per-request flow, with bun:sqlite persistence for challenges and redemptions

## Development

### Prerequisites

- [Bun](https://bun.sh) v1+
- [Foundry](https://getfoundry.sh) (for contract work)

### Install

```bash
bun install
```

### Environment Variables

| Variable | Purpose |
|---|---|
| `VITE_CONTRACT_ADDRESS` | QueryPayments contract address — testnet |
| `VITE_ARC_TESTNET_CHAIN_ID` | Arc Testnet chain ID (`5042002`) |
| `FALLBACK_RPC_URL` | Public Arc Testnet RPC (fallback when RPC proxy unavailable) |
| `BACKEND_PORT` | Backend port (default `3001`) |
| `STABLEDESK_API_KEY` | Server-side key for Stabledesk API — never sent to the browser |
| `DEPLOY_BLOCK` | Contract deploy block for the event scanner (set to `69168253` for testnet) |
| `NETWORK` | Backend network mode: `mainnet` for production, unset = testnet |
| `VITE_NETWORK` | Frontend network mode: `mainnet` for production, unset = testnet |
| `RPC_URL` | Explicit RPC endpoint (recommended for Railway/Docker; overrides the Studio proxy) |
| `DB_PATH` | SQLite file path — required in mainnet mode (must be on a persistent volume); testnet default is `./data/queries.db` |

For mainnet, also set: `MAINNET_RPC_URL`, `MAINNET_CHAIN_ID`, `MAINNET_CONTRACT_ADDRESS`, `MAINNET_TREASURY` (backend), and `VITE_MAINNET_CONTRACT_ADDRESS`, `VITE_MAINNET_CHAIN_ID` (frontend). Backend exits and frontend build fails if any required mainnet var is missing. No testnet fallback.

**Important:** The backend is a long-running process (not serverless). The SQLite database (`DB_PATH`) must live on a **persistent volume** so that paid-but-unredeemed challenges survive redeploys. On Railway, mount a volume at `/data` and set `DB_PATH=/data/queries.db`.

### Run

Start the backend (port 3001):

```bash
bun run server
```

Start the Vite dev server (port 5173, proxies `/api` to the backend):

```bash
bun run dev
```

### Build and Test Contracts

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test (25 unit tests)
```

### Lint and Typecheck

```bash
bun run check
```

## How the HTTP 402 Flow Works (Commit-Reveal)

A commit-reveal scheme prevents front-running: an observer who sees the on-chain transaction cannot redeem the data without the secret nonce.

1. `GET /api/q/<query>` without payment headers → `402` with `{ queryIdHex, nonce, price, contractAddress }` valid for 10 minutes. The `queryIdHex = keccak256(nonce)`. The `nonce` is a random 32-byte secret held only by the client.
2. Client calls `pay(queryIdHex)` on the `QueryPayments` contract with `value = 0.01 USDC`. The nonce never goes on-chain.
3. Client re-requests with `X-Payment-Tx: <txHash>` and `X-Payment-Nonce: <nonce>`. Backend checks `keccak256(nonce) == queryId` in the `QueryPaid` event, validates all fields, and returns the data. Without the nonce, the request is rejected — a front-runner who copies the tx gets nothing.

## Available Queries

| Endpoint | Data |
|---|---|
| `GET /api/q/stablecoins` | All stablecoins on Arc |
| `GET /api/q/stablecoin?symbol=USDC` | One stablecoin by symbol |
| `GET /api/q/network` | Arc network stats |
| `GET /api/q/transfers` | Largest recent transfers |

## Deployed Contract

- **QueryPayments** on Arc Testnet: `0xd4271deb42a7ee4465b50e1616a3f14a331e3c87`
- Initial price: 0.01 USDC (1e16 native wei)
- Owner/treasury: platform deployer wallet (Circle-managed for testnet)

## For AI Agents

No credentials needed. Implement the 402 loop in any language:

```javascript
// 1. Request challenge
const c = await fetch('/api/q/stablecoins');
const { payment } = await c.json(); // 402

// 2. Pay on-chain
const txHash = await walletClient.writeContract({
  address: payment.contractAddress,
  abi: [{ name: 'pay', type: 'function', inputs: [{ name: 'queryId', type: 'bytes32' }], stateMutability: 'payable', outputs: [] }],
  functionName: 'pay',
  args: [payment.queryIdHex],
  value: BigInt(payment.price),
});

// 3. Redeem — nonce is the commit-reveal secret, never sent on-chain
const result = await fetch('/api/q/stablecoins', {
  headers: { 'X-Payment-Tx': txHash, 'X-Payment-Nonce': payment.nonce },
});
```

A full Node.js agent script is available in the app's "For Agents" tab.
