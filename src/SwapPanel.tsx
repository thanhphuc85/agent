/**
 * SwapPanel — convert USDT (or other tokens) to USDC on Arc Mainnet
 * Uses Circle App Kit + viem browser wallet adapter (keyless, no kitKey).
 * Swaps move real funds on mainnet — user must explicitly click "Execute Swap"
 * after reviewing the estimate.
 */
import { useState } from 'react'
import { AppKit, type SwapEstimate } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { EIP1193Provider } from 'viem'
import { arc } from 'viem/chains'
import { useAccount, useChainId, useSwitchChain, useConnectorClient } from 'wagmi'
import { toast } from 'sonner'

const kit = new AppKit()

// Tokens that can be swapped INTO USDC on Arc Mainnet
const SWAP_TOKENS = ['USDT', 'EURC', 'DAI', 'USDE', 'WETH', 'WBTC', 'NATIVE'] as const
type SwapToken = (typeof SWAP_TOKENS)[number]

type ReviewedSwap = {
  estimate: SwapEstimate
  tokenIn: SwapToken
  amountIn: string
  address: string
}

interface SwapPanelProps {
  darkMode: boolean
}

export function SwapPanel({ darkMode }: SwapPanelProps) {
  const { address, connector } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { data: connectorClient } = useConnectorClient()

  const [tokenIn, setTokenIn] = useState<SwapToken>('USDT')
  const [amountIn, setAmountIn] = useState('')
  const [reviewed, setReviewed] = useState<ReviewedSwap | null>(null)
  const [loading, setLoading] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [error, setError] = useState('')

  const card = darkMode
    ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-xl p-5'
    : 'bg-white border border-[#e8eaf0] rounded-xl p-5 shadow-sm'
  const input = darkMode
    ? 'w-full bg-[#242938] border border-[#2a3044] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#1652f0]'
    : 'w-full bg-[#f7f8fa] border border-[#e8eaf0] rounded-lg px-3 py-2 text-[#0d1421] text-sm focus:outline-none focus:border-[#1652f0]'
  const label = darkMode ? 'text-[#8b9cc6] text-xs mb-1 block' : 'text-[#6b7280] text-xs mb-1 block'
  const text = darkMode ? 'text-white' : 'text-[#0d1421]'
  const subtext = darkMode ? 'text-[#8b9cc6] text-xs' : 'text-[#6b7280] text-xs'

  const getAdapter = async () => {
    if (!connector) throw new Error('No wallet connected')
    if (chainId !== arc.id) await switchChainAsync({ chainId: arc.id })
    if (!connectorClient) throw new Error('Connector client unavailable')
    const provider = (await connector.getProvider()) as EIP1193Provider
    return createViemAdapterFromProvider({ provider })
  }

  const handleReview = async () => {
    if (!address) { toast.error('Connect a wallet first'); return }
    const amt = parseFloat(amountIn)
    if (!amountIn || isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount'); return }
    // Arc: USDC and NATIVE are the same asset — block that swap
    if (tokenIn === 'NATIVE') { toast.error('On Arc, NATIVE is USDC — no swap needed'); return }

    setLoading(true)
    setError('')
    setReviewed(null)
    try {
      const adapter = await getAdapter()
      const estimate = await kit.estimateSwap({
        from: { adapter, chain: 'Arc' },
        tokenIn,
        tokenOut: 'USDC',
        amountIn,
      })
      setReviewed({ estimate, tokenIn, amountIn, address })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Estimation failed'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const handleSwap = async () => {
    if (!reviewed) return
    if (address !== reviewed.address) {
      toast.error('Wallet account changed — get a new quote first')
      setReviewed(null)
      return
    }

    setLoading(true)
    setError('')
    try {
      toast.warning('⚠️ This swap moves real USDC on Arc Mainnet. Starting with the reviewed amount.')
      const adapter = await getAdapter()
      const result = await kit.swap({
        from: { adapter, chain: 'Arc' },
        tokenIn: reviewed.tokenIn,
        tokenOut: 'USDC',
        amountIn: reviewed.amountIn,
        config: { slippageBps: 100 },
      })
      setTxHash(result.txHash ?? '')
      setReviewed(null)
      setAmountIn('')
      toast.success(`Swap complete! Got ${result.amountOut ?? '?'} USDC`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Swap failed'
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Info banner */}
      <div className={`${darkMode ? 'bg-[#1a2340] border border-[#2a3a6e]' : 'bg-[#eef2ff] border border-[#c7d2fe]'} rounded-xl p-4`}>
        <p className={`${darkMode ? 'text-[#8baaf0]' : 'text-[#3730a3]'} text-sm font-medium mb-1`}>Convert tokens to USDC</p>
        <p className={subtext}>Swap USDT or other tokens into USDC so you can pay for crypto queries on Arc Mainnet. Routed via LiFi DEX aggregator. Real funds — start small.</p>
      </div>

      <div className={card}>
        <p className={`${text} font-semibold mb-4`}>Token → USDC Swap</p>

        {/* Token + Amount */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <span className={label}>From token</span>
            <select
              value={tokenIn}
              onChange={e => { setTokenIn(e.target.value as SwapToken); setReviewed(null) }}
              className={input}
            >
              {SWAP_TOKENS.filter(t => t !== 'NATIVE').map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <span className={label}>Amount</span>
            <input
              type="number"
              min="0"
              step="any"
              placeholder="0.00"
              value={amountIn}
              onChange={e => { setAmountIn(e.target.value); setReviewed(null) }}
              className={input}
            />
          </div>
        </div>

        {/* To */}
        <div className={`${darkMode ? 'bg-[#0f1623] border border-[#2a3044]' : 'bg-[#f7f8fa] border border-[#e8eaf0]'} rounded-lg p-3 mb-4 flex items-center justify-between`}>
          <span className={subtext}>You receive (estimated)</span>
          <span className={`${text} font-semibold`}>
            {reviewed ? `${reviewed.estimate.estimatedOutput.amount} USDC` : '—'}
          </span>
        </div>

        {/* Reviewed estimate detail */}
        {reviewed && (
          <div className={`${darkMode ? 'bg-[#0f2a1a] border border-[#1a4a2a]' : 'bg-[#f0fdf4] border border-[#bbf7d0]'} rounded-lg p-3 mb-4`}>
            <p className={`${darkMode ? 'text-[#4ade80]' : 'text-[#166534]'} text-xs font-semibold mb-2`}>Quote details</p>
            <div className="grid grid-cols-2 gap-y-1">
              <span className={subtext}>In</span>
              <span className={`${text} text-xs text-right`}>{reviewed.amountIn} {reviewed.tokenIn}</span>
              <span className={subtext}>Out</span>
              <span className={`${text} text-xs text-right`}>{reviewed.estimate.estimatedOutput.amount} {reviewed.estimate.estimatedOutput.token}</span>
              {reviewed.estimate.fees?.map((f, i) => (
                <>
                  <span key={`fl-${i}`} className={subtext}>{f.type} fee</span>
                  <span key={`fv-${i}`} className={`${text} text-xs text-right`}>{f.amount} {f.token}</span>
                </>
              ))}
              <span className={subtext}>Route</span>
              <span className={`${text} text-xs text-right`}>LiFi aggregator</span>
            </div>
            <p className={`${darkMode ? 'text-[#f97316]' : 'text-[#c2410c]'} text-xs mt-2`}>⚠️ Mainnet swap — real funds. Slippage: 1%.</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className={`${darkMode ? 'text-[#f87171]' : 'text-[#dc2626]'} text-xs mb-3`}>{error}</p>
        )}

        {/* Actions */}
        {!address ? (
          <p className={`${subtext} text-center py-2`}>Connect a wallet to swap</p>
        ) : !reviewed ? (
          <button
            onClick={() => void handleReview()}
            disabled={loading || !amountIn}
            className="w-full py-2.5 rounded-lg bg-[#1652f0] text-white text-sm font-semibold hover:bg-[#1245d4] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Getting quote…' : 'Get Quote'}
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setReviewed(null)}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-colors ${darkMode ? 'border-[#2a3044] text-[#8b9cc6] hover:border-[#4a5580]' : 'border-[#e8eaf0] text-[#6b7280] hover:border-[#c0c8d8]'}`}
            >
              New quote
            </button>
            <button
              onClick={() => void handleSwap()}
              disabled={loading}
              className="flex-1 py-2.5 rounded-lg bg-[#059669] text-white text-sm font-semibold hover:bg-[#047857] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Swapping…' : `Swap ${reviewed.amountIn} ${reviewed.tokenIn} → USDC`}
            </button>
          </div>
        )}

        {/* Success tx */}
        {txHash && (
          <a
            href={`https://explorer.arc.io/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`block mt-3 text-center text-xs underline ${darkMode ? 'text-[#4ade80]' : 'text-[#059669]'}`}
          >
            View swap on explorer ↗
          </a>
        )}
      </div>
    </div>
  )
}
