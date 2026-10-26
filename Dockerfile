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
#   MAINNET_RPC_URL=https://rpc.mainnet.arc.io
#   MAINNET_CHAIN_ID=<arc mainnet chain id>
#   MAINNET_CONTRACT_ADDRESS=<deployed contract address>
#   MAINNET_TREASURY=<treasury address>
#   VITE_NETWORK=mainnet
#   VITE_MAINNET_CHAIN_ID=<arc mainnet chain id>
#   VITE_MAINNET_CONTRACT_ADDRESS=<deployed contract address>
#   PORT=3001   (Railway sets this automatically)
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

# Build the Vite frontend (requires VITE_* env vars to be set at build time).
# In Railway, add them as build-time variables in the service settings.
RUN bun run build

# The backend serves /dist as static files in addition to /api routes.
# Runtime: use the PORT Railway injects (defaults to 3001).
EXPOSE 3001
CMD ["bun", "run", "server"]
