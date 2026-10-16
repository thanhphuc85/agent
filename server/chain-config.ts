/**
 * Runtime chain config for the server.
 * Reads USDC address and public RPC from the shared onchain-facts registry
 * so no literal addresses are duplicated in server code.
 */

// Arc Mainnet chain ID
export const ARC_CHAIN_ID = 5042

// Read the onchain-facts module at runtime
// We import the compiled TS via Bun's native TS support
import { getUsdc, requireChain } from '../src/onchain-facts.ts'

const arcChain = requireChain(ARC_CHAIN_ID)
const arcUsdc  = getUsdc(ARC_CHAIN_ID)

if (!arcUsdc) throw new Error(`USDC not found in onchain-facts for chain ${ARC_CHAIN_ID}`)

/** USDC contract address on Arc Mainnet (from onchain-facts registry) */
export const USDC_ADDRESS: string = arcUsdc.address

/** QueryPayment contract address (from .env — set via VITE_CONTRACT_ADDRESS) */
export const CONTRACT_ADDRESS: string = (() => {
  const addr = process.env.VITE_CONTRACT_ADDRESS
  if (!addr) throw new Error('VITE_CONTRACT_ADDRESS not set in .env')
  return addr
})()

/** Arc Mainnet RPC URL — prefers proxy, falls back to registry public RPC */
export function getArcRpc(): string {
  const base   = process.env.RPC_PROXY_BASE_URL
  const token  = process.env.RPC_PROXY_TOKEN
  const chains = process.env.RPC_PROXY_CHAINS ?? ''
  if (base && token && chains.includes(String(ARC_CHAIN_ID))) {
    return `${base}/api/rpc/${ARC_CHAIN_ID}?_rpc_token=${token}`
  }
  const publicRpc = arcChain.rpcUrls[0]
  if (!publicRpc) throw new Error('No public RPC available for Arc Mainnet in onchain-facts')
  console.warn('[chain] RPC proxy not covering Arc Mainnet — using public RPC from registry')
  return publicRpc
}
