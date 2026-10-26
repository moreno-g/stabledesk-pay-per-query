# Stabledesk Pay-per-Query — Project Memory

> Built with Arc Studio — https://studio.arc.io

## What This App Does

A pay-per-request data API on Arc Testnet where anyone (human or AI agent) pays 0.01 USDC per call — no account, API key, or subscription needed. Backed by the Stabledesk API for stablecoin data on Arc mainnet.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS (Arc Dark theme)
- Web3: wagmi v2, viem v2, ConnectKit. Network driven by `VITE_NETWORK` ("mainnet" | testnet default)
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/`
- Backend: Bun HTTP server (`server/index.ts`), port 3001, proxied via Vite at `/api`
- Persistence: bun:sqlite (`./data/queries.db` testnet default, `DB_PATH` env for mainnet) for challenges and redemptions
- Chain: Arc Testnet (Chain ID: 5042002) / Arc Mainnet when `NETWORK=mainnet`
- Token: Native USDC (Arc gas token, 18 decimals for msg.value; 6 decimals ERC-20 view)

## Deployed Contracts

| Contract        | Network      | Address                                      | Explorer |
|----------------|--------------|----------------------------------------------|---------|
| QueryPayments  | Arc Testnet  | 0xd4271deb42a7ee4465b50e1616a3f14a331e3c87  | https://explorer.testnet.arc.io/address/0xd4271deb42a7ee4465b50e1616a3f14a331e3c87 |

**Deployer wallet:** 0x5B12Ce46C7194aD57d143bC22847224047b1Ef42 (platform wallet = treasury)
**Initial price:** 0.01 USDC = 1e16 wei (native 18-dec Arc USDC)
**Deploy block:** 69168253

## Key Files

- `contracts/QueryPayments.sol` — payment gate contract
- `contracts/test/QueryPayments.t.sol` — 25 Foundry unit tests (all pass)
- `server/index.ts` — HTTP 402 backend (commit-reveal challenge + receipt validation + Stabledesk proxy + background scanner)
- `server/db.ts` — bun:sqlite persistence layer for challenges and redemptions
- `server/index.test.ts` — 13 backend unit tests (all pass)
- `src/contract.ts` — contract address, ABI, and chain config for the frontend
- `src/config.ts` — wagmi config (testnet/mainnet driven by VITE_NETWORK)
- `src/components/PayButton.tsx` — full 402 flow orchestration
- `src/components/RecentFeed.tsx` — polls /api/recent every 15 s
- `src/components/AgentGuide.tsx` — curl/JS/Node agent examples

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `VITE_CONTRACT_ADDRESS` | `.env` | QueryPayments contract address (testnet) |
| `VITE_ARC_TESTNET_CHAIN_ID` | `.env` | Arc Testnet chain ID (5042002) |
| `FALLBACK_RPC_URL` | `.env` | Public Arc Testnet RPC (used if RPC proxy unavailable) |
| `BACKEND_PORT` | `.env` | Backend port (default 3001) |
| `STABLEDESK_API_KEY` | `.env` | Server-side key for Stabledesk API (never exposed to browser) |
| `DEPLOY_BLOCK` | `.env` | Contract deploy block for the event scanner (69168253 on testnet) |
| `VITE_NETWORK` | `.env` | Frontend network mode: `mainnet` for production, unset = testnet |
| `NETWORK` | `.env` | Backend network mode: `mainnet` for production, unset = testnet |
| `MAINNET_RPC_URL` | `.env` | Arc mainnet RPC URL (required in mainnet mode) |
| `MAINNET_CHAIN_ID` | `.env` | Arc mainnet chain ID (required in mainnet mode) |
| `MAINNET_CONTRACT_ADDRESS` | `.env` | QueryPayments on mainnet (required in mainnet mode) |
| `VITE_MAINNET_CONTRACT_ADDRESS` | `.env` | Same as above for frontend (VITE_ prefix for Vite) |
| `VITE_MAINNET_CHAIN_ID` | `.env` | Same as MAINNET_CHAIN_ID for frontend |

## HTTP 402 Flow (Commit-Reveal)

1. `GET /api/q/<query>` without payment → 402 with `{ payment: { queryIdHex, nonce, contractAddress, price } }`
   - `queryIdHex = keccak256(nonce)` using Ethereum Keccak-256 (viem). The nonce never goes on-chain.
2. Client calls `pay(queryIdHex)` on QueryPayments with `value = price` (native USDC).
3. Client re-requests with `X-Payment-Tx: <txHash>` and `X-Payment-Nonce: <nonce>` → data.
   - Backend recomputes `keccak256(nonce)` and checks it against the `QueryPaid` event topic.
   - A front-runner who copies the tx cannot redeem without the nonce.
   - The nonce is marked redeemed ONLY after a successful Stabledesk call (atomic SQLite transaction).

## Event Scanner

- Background scan from `DEPLOY_BLOCK` in 2000-block chunks on startup; cursor advances to head+1.
- Every 15 s: fetches new blocks from the cursor forward.
- Serves last 100 events via `GET /api/recent`.
- Frontend polls `/api/recent` every 15 s (no direct RPC from browser).

## Available Queries

| Endpoint | Stabledesk route |
|---|---|
| `/api/q/stablecoins` | `/v1/stablecoins` |
| `/api/q/stablecoin?symbol=USDC` | `/v1/stablecoins/{symbol}` |
| `/api/q/network` | `/v1/network` |
| `/api/q/transfers` | `/v1/transfers/largest` |

## Mainnet Mode

Set `NETWORK=mainnet` (backend) and `VITE_NETWORK=mainnet` (frontend).
- Backend exits at startup if `MAINNET_RPC_URL`, `MAINNET_CHAIN_ID`, `MAINNET_CONTRACT_ADDRESS`, `MAINNET_TREASURY` are missing.
- Frontend build fails if `VITE_MAINNET_CONTRACT_ADDRESS` or `VITE_MAINNET_CHAIN_ID` are missing.
- No testnet fallback — mainnet mode always uses mainnet values.
- Frontend shows "Arc Mainnet" label and no testnet banner.
- Explorer links use the Arc mainnet explorer.

## Security Notes

- keccak256: uses viem's `keccak256` (Ethereum Keccak-256, NOT NIST SHA3-256). Test vector: keccak256("") = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
- Commit-reveal: nonce is server-generated random 32 bytes. `queryIdHex = keccak256(nonce)`. The nonce never goes on-chain. A front-runner who observes the tx cannot redeem without the nonce.
- Atomicity: `markRedeemed` uses `BEGIN IMMEDIATE` + explicit SELECT-then-INSERT to prevent two concurrent redemptions from both succeeding. Note: bun:sqlite's `.get()` returns `null` (not `undefined`) when no row matches.
- Upstream safety: the nonce is marked redeemed only after Stabledesk responds successfully. An upstream error leaves it redeemable.
- No hardcoded RPC URLs in source code. Startup validates both primary (proxy) and fallback RPC chain IDs against the expected chain.
- No private keys in any file. `agent-test.mjs` reads `AGENT_PRIVATE_KEY` from environment only.

## E2E Test Payments (Arc Testnet)

| Tx hash | Block | Query |
|---|---|---|
| 0x5c2859db01684c7c638e16ecfd6f0a7669270a2283e7626bd5de8fef7debb3fa | 69170096 | network |
| 0xac723d9aac8770c9fadd943c8589587165b18287f7312441b9f255dea9777b62 | 69171074 | network |
