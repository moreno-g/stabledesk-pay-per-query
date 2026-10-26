# Stabledesk Pay-per-Query — Railway / Docker deployment
#
# Single long-running Bun process that:
#   1. Builds the Vite frontend (bun run build → dist/)
#   2. Serves the static frontend AND the HTTP 402 API from one Bun HTTP server
#
# Required env vars at runtime (set in Railway service variables):
#   NETWORK=mainnet
#   RPC_URL=https://rpc.mainnet.arc.io
#   DB_PATH=/data/queries.db            ← must be on a Railway persistent volume
#   STABLEDESK_API_KEY=<key>
#   MAINNET_RPC_URL=https://rpc.drpc.mainnet.arc.io   (second mainnet RPC, chain id checked at startup)
#   MAINNET_CHAIN_ID=5042
#   MAINNET_CONTRACT_ADDRESS=<deployed contract address>
#   MAINNET_TREASURY=<treasury address>
#   DEPLOY_BLOCK=<block the contract was deployed in>
#   VITE_NETWORK=mainnet
#   VITE_MAINNET_CHAIN_ID=5042
#   VITE_MAINNET_CONTRACT_ADDRESS=<deployed contract address>
#   PORT                                (Railway sets it; the server listens on it)
#
# Railway volume: mount a persistent volume at /data so DB_PATH=/data/queries.db
# survives deploys. Without a persistent volume every redeploy loses unredeemed challenges.

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build the Vite frontend. Railway passes service variables to a Dockerfile build only when
# they are declared as ARG: without these lines the frontend silently builds in testnet mode.
ARG VITE_NETWORK
ARG VITE_MAINNET_CHAIN_ID
ARG VITE_MAINNET_CONTRACT_ADDRESS
ARG VITE_ARC_TESTNET_CHAIN_ID
ARG VITE_CONTRACT_ADDRESS
RUN bun run build

# The backend serves /dist as static files in addition to /api routes.
# Runtime: use the PORT Railway injects (defaults to 3001).
EXPOSE 3001
CMD ["bun", "run", "server"]
