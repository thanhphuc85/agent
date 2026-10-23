/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig, custom } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { fallback } from 'viem'
import { registerChain } from './tracing'

const ARC_RPC = 'https://rpc.mainnet.arc.io'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arc.id, ARC_RPC)

// Use window.ethereum first (avoids CORS on eth_call when MetaMask is connected),
// then fall back to the public Arc Mainnet RPC.
const arcTransport =
  typeof window !== 'undefined' && window.ethereum
    ? fallback([custom(window.ethereum), http(ARC_RPC)])
    : http(ARC_RPC)

export const config = createConfig({
  chains: [arc, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arc.id]: arcTransport,
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
