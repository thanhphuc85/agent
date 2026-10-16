/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
// Arc Mainnet RPC — arc.rpcUrls.default.http may be empty in older viem builds
registerChain(arc.id, 'https://rpc.mainnet.arc.io')

export const config = createConfig({
  chains: [arc, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arc.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
