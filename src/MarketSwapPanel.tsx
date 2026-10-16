/**
 * MarketSwapPanel — combined real-time price tracker + token swap
 * Markets: CoinGecko public API (no key), auto-refreshes every 30s
 * Swap: Circle App Kit keyless swap via SwapPanel
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TokenBTC, TokenETH, TokenSOL, TokenBNB, TokenXRP,
  TokenADA, TokenAVAX, TokenDOT, TokenLINK, TokenUNI,
  TokenUSDC, TokenUSDT,
} from '@web3icons/react'
import {
  Area, ResponsiveContainer, Tooltip as RTooltip, AreaChart,
} from 'recharts'
import { TrendingUp, TrendingDown, RefreshCw, ArrowRightLeft, BarChart2 } from 'lucide-react'
import { SwapPanel } from './SwapPanel'

// Icon lookup map — named exports from @web3icons/react
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = React.ComponentType<any>
const COIN_ICONS: Partial<Record<string, IconComponent>> = {
  BTC: TokenBTC, ETH: TokenETH, SOL: TokenSOL, BNB: TokenBNB, XRP: TokenXRP,
  ADA: TokenADA, AVAX: TokenAVAX, DOT: TokenDOT, LINK: TokenLINK, UNI: TokenUNI,
  USDC: TokenUSDC, USDT: TokenUSDT,
}

function CoinIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const Icon = COIN_ICONS[symbol]
  if (Icon) return <Icon size={size} variant="branded" />
  // Fallback: colored circle with symbol initials
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.36, background: '#1652f0' }}
    >
      {symbol.slice(0, 2)}
    </div>
  )
}

// CoinGecko IDs → symbol mapping for top 12 coins
const COINS = [
  { id: 'bitcoin',       symbol: 'BTC',  name: 'Bitcoin' },
  { id: 'ethereum',      symbol: 'ETH',  name: 'Ethereum' },
  { id: 'solana',        symbol: 'SOL',  name: 'Solana' },
  { id: 'binancecoin',   symbol: 'BNB',  name: 'BNB' },
  { id: 'ripple',        symbol: 'XRP',  name: 'XRP' },
  { id: 'cardano',       symbol: 'ADA',  name: 'Cardano' },
  { id: 'avalanche-2',   symbol: 'AVAX', name: 'Avalanche' },
  { id: 'polkadot',      symbol: 'DOT',  name: 'Polkadot' },
  { id: 'chainlink',     symbol: 'LINK', name: 'Chainlink' },
  { id: 'uniswap',       symbol: 'UNI',  name: 'Uniswap' },
  { id: 'usd-coin',      symbol: 'USDC', name: 'USD Coin' },
  { id: 'tether',        symbol: 'USDT', name: 'Tether' },
] as const

type CoinSymbol = typeof COINS[number]['symbol']

interface CoinData {
  id: string
  symbol: CoinSymbol
  name: string
  price: number
  change24h: number
  marketCap: number
  volume24h: number
  sparkline: number[] // 7-day hourly prices
}

interface MarketSwapPanelProps {
  darkMode: boolean
  /** Pre-select a token in the swap panel (called from Chat via "Swap X" quick action) */
  preselectedSwapToken?: CoinSymbol | null
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (n >= 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(6)}`
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

// Minimal sparkline using recharts AreaChart
function Sparkline({ data, positive, dark }: { data: number[]; positive: boolean; dark: boolean }) {
  const chartData = data.map((v, i) => ({ i, v }))
  const color = positive ? '#22c55e' : '#ef4444'
  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sg-${positive ? 'up' : 'dn'}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#sg-${positive ? 'up' : 'dn'})`}
          dot={false}
          isAnimationActive={false}
        />
        <RTooltip
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null
            return (
              <div className={`text-xs px-2 py-1 rounded shadow ${dark ? 'bg-[#1a1f2e] text-white border border-[#2a3044]' : 'bg-white text-[#0d1421] border border-[#e8eaf0]'}`}>
                {fmt(payload[0].value as number)}
              </div>
            )
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  if (active) return <span className="ml-1 text-[10px]">{dir === 'desc' ? '↓' : '↑'}</span>
  return <span className="ml-1 text-[10px] opacity-30">↕</span>
}

export function MarketSwapPanel({ darkMode, preselectedSwapToken }: MarketSwapPanelProps) {
  const [tab, setTab] = useState<'markets' | 'swap'>(preselectedSwapToken ? 'swap' : 'markets')
  const [coins, setCoins] = useState<CoinData[]>([])
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<'marketCap' | 'change24h' | 'price' | 'volume24h'>('marketCap')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [search, setSearch] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchPrices = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const ids = COINS.map(c => c.id).join(',')
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
      const data = await res.json() as Array<{
        id: string; symbol: string; name: string
        current_price: number; price_change_percentage_24h: number
        market_cap: number; total_volume: number
        sparkline_in_7d?: { price: number[] }
      }>
      const mapped: CoinData[] = data.map(d => {
        const coin = COINS.find(c => c.id === d.id)
        return {
          id: d.id,
          symbol: (coin?.symbol ?? d.symbol.toUpperCase()) as CoinSymbol,
          name: d.name,
          price: d.current_price,
          change24h: d.price_change_percentage_24h ?? 0,
          marketCap: d.market_cap,
          volume24h: d.total_volume,
          sparkline: d.sparkline_in_7d?.price?.slice(-48) ?? [],
        }
      })
      setCoins(mapped)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch prices')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + 30s auto-refresh
  useEffect(() => {
    queueMicrotask(() => { void fetchPrices() })
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => { void fetchPrices() }, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchPrices])

  // Switch to swap tab if preselected token arrives
  useEffect(() => {
    if (preselectedSwapToken) queueMicrotask(() => setTab('swap'))
  }, [preselectedSwapToken])

  const sorted = [...coins]
    .filter(c =>
      search === '' ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.symbol.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const mul = sortDir === 'desc' ? -1 : 1
      return (a[sortKey] - b[sortKey]) * mul
    })

  const toggleSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  // Styles
  const bg      = darkMode ? 'bg-[#0d1421]' : 'bg-[#f5f7fc]'
  const card    = darkMode ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-2xl' : 'bg-white border border-[#e8eaf0] rounded-2xl shadow-sm'
  const text    = darkMode ? 'text-white' : 'text-[#0d1421]'
  const muted   = darkMode ? 'text-[#8b9cc6]' : 'text-[#6b7280]'
  const divider = darkMode ? 'border-[#2a3044]' : 'border-[#f0f2f5]'
  const hoverRow = darkMode ? 'hover:bg-[#242938]' : 'hover:bg-[#f7f8fa]'
  const inputCls = darkMode
    ? 'bg-[#242938] border border-[#2a3044] text-white placeholder-[#4a5580] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1652f0]'
    : 'bg-[#f7f8fa] border border-[#e8eaf0] text-[#0d1421] placeholder-[#9ca3af] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#1652f0]'
  const tabActive = darkMode
    ? 'bg-[#1652f0] text-white'
    : 'bg-[#1652f0] text-white'
  const tabInactive = darkMode
    ? 'text-[#8b9cc6] hover:text-white'
    : 'text-[#6b7280] hover:text-[#0d1421]'

  return (
    <div className={`flex flex-col gap-3 ${bg} min-h-full p-4`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className={`${text} font-semibold text-base font-['Space_Grotesk']`}>Swap &amp; Market</h2>
          {lastUpdated && (
            <p className={`${muted} text-xs`}>
              Updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </p>
          )}
        </div>
        <button
          onClick={() => void fetchPrices()}
          disabled={loading}
          className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-[#242938]' : 'hover:bg-[#f0f2f5]'}`}
          title="Refresh prices"
        >
          <RefreshCw size={14} className={`${muted} ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Sub-tab selector */}
      <div className={`${card} p-1 flex gap-1`}>
        <button
          onClick={() => setTab('markets')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-semibold transition-all ${tab === 'markets' ? tabActive : tabInactive}`}
        >
          <BarChart2 size={14} />
          Markets
        </button>
        <button
          onClick={() => setTab('swap')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-semibold transition-all ${tab === 'swap' ? tabActive : tabInactive}`}
        >
          <ArrowRightLeft size={14} />
          Swap
        </button>
      </div>

      {tab === 'markets' && (
        <>
          {/* Search */}
          <input
            type="text"
            placeholder="Search coins…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className={`w-full ${inputCls}`}
          />

          {/* Summary bar — top movers */}
          {coins.length > 0 && (
            <div className={`${card} p-3 flex gap-2 overflow-x-auto`}>
              {[...coins]
                .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
                .slice(0, 5)
                .map(c => (
                  <div key={c.id} className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${darkMode ? 'bg-[#242938]' : 'bg-[#f7f8fa]'}`}>
                    <CoinIcon symbol={c.symbol} size={16} />
                    <span className={`${text} text-xs font-semibold tabular-nums`}>{c.symbol}</span>
                    <span className={`text-xs font-semibold tabular-nums ${c.change24h >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                      {pct(c.change24h)}
                    </span>
                  </div>
                ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className={`${darkMode ? 'bg-[#2a1a1a] border border-[#5a2a2a] text-[#f87171]' : 'bg-[#fef2f2] border border-[#fecaca] text-[#dc2626]'} rounded-xl p-3 text-sm`}>
              {error} — prices may be stale.
            </div>
          )}

          {/* Table header */}
          <div className={`${card} overflow-hidden`}>
            <div className={`grid grid-cols-[2fr_1fr_1fr_1fr_2fr] gap-2 px-4 py-2.5 border-b ${divider}`}>
              <span className={`${muted} text-xs font-semibold uppercase tracking-wide`}>Asset</span>
              <button onClick={() => toggleSort('price')} className={`${muted} text-xs font-semibold uppercase tracking-wide text-right flex items-center justify-end`}>
                Price<SortIcon active={sortKey === 'price'} dir={sortDir} />
              </button>
              <button onClick={() => toggleSort('change24h')} className={`${muted} text-xs font-semibold uppercase tracking-wide text-right flex items-center justify-end`}>
                24h<SortIcon active={sortKey === 'change24h'} dir={sortDir} />
              </button>
              <button onClick={() => toggleSort('volume24h')} className={`${muted} text-xs font-semibold uppercase tracking-wide text-right flex items-center justify-end hidden sm:flex`}>
                Vol<SortIcon active={sortKey === 'volume24h'} dir={sortDir} />
              </button>
              <span className={`${muted} text-xs font-semibold uppercase tracking-wide text-right`}>7d</span>
            </div>

            {/* Rows */}
            {loading && coins.length === 0 ? (
              <div className="py-12 text-center">
                <RefreshCw size={20} className={`${muted} animate-spin mx-auto mb-2`} />
                <p className={`${muted} text-sm`}>Loading prices…</p>
              </div>
            ) : sorted.length === 0 ? (
              <div className="py-12 text-center">
                <p className={`${muted} text-sm`}>No coins match "{search}"</p>
              </div>
            ) : (
              sorted.map((coin, idx) => (
                <div
                  key={coin.id}
                  className={`grid grid-cols-[2fr_1fr_1fr_1fr_2fr] gap-2 px-4 py-3 items-center cursor-pointer transition-colors ${hoverRow} ${idx < sorted.length - 1 ? `border-b ${divider}` : ''}`}
                  onClick={() => setTab('swap')}
                  title={`Swap ${coin.symbol}`}
                >
                  {/* Asset */}
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex-shrink-0">
                      <CoinIcon symbol={coin.symbol} size={28} />
                    </div>
                    <div className="min-w-0">
                      <p className={`${text} text-sm font-semibold leading-none truncate`}>{coin.symbol}</p>
                      <p className={`${muted} text-xs truncate`}>{coin.name}</p>
                    </div>
                  </div>

                  {/* Price */}
                  <p className={`${text} text-sm font-semibold tabular-nums text-right`}>
                    {fmt(coin.price)}
                  </p>

                  {/* 24h % */}
                  <div className={`flex items-center justify-end gap-0.5 ${coin.change24h >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                    {coin.change24h >= 0
                      ? <TrendingUp size={12} />
                      : <TrendingDown size={12} />}
                    <span className="text-xs font-semibold tabular-nums">{pct(coin.change24h)}</span>
                  </div>

                  {/* Volume */}
                  <p className={`${muted} text-xs tabular-nums text-right hidden sm:block`}>
                    {fmt(coin.volume24h)}
                  </p>

                  {/* Sparkline */}
                  <div className="w-full">
                    {coin.sparkline.length > 0
                      ? <Sparkline data={coin.sparkline} positive={coin.change24h >= 0} dark={darkMode} />
                      : <div className={`h-10 flex items-center justify-center`}><span className={`${muted} text-xs`}>—</span></div>
                    }
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <p className={`${muted} text-xs text-center`}>
            Data from CoinGecko. Auto-refreshes every 30s. Click any row to swap.
          </p>
        </>
      )}

      {tab === 'swap' && (
        <SwapPanel darkMode={darkMode} />
      )}
    </div>
  )
}
