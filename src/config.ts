/**
 * wagmi configuration — Arc Testnet or Arc Mainnet only.
 * Network mode is driven by VITE_NETWORK ("mainnet" | anything else = testnet).
 * Ethereum mainnet is NOT included: no ENS resolution, and no risk of a wallet
 * accidentally sending native ETH to our contract address on Ethereum.
 * Built with Arc Studio — https://studio.arc.io
 */
import { http, createConfig } from 'wagmi'
import { arcTestnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { IS_MAINNET, CHAIN_ID } from './contract'

const appChain = IS_MAINNET ? arc : arcTestnet

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(CHAIN_ID, appChain.rpcUrls.default.http[0])

// Build a typed transports map for the single app chain.
// Cast through unknown because the chain ID is only known at runtime,
// but wagmi's type requires a literal union key matching chains[].id.
type AppChainId = typeof appChain.id
const transports = { [appChain.id]: http() } as unknown as Record<AppChainId, ReturnType<typeof http>>

export const config = createConfig({
  chains: [appChain],
  connectors: [injected()],
  transports,
})
