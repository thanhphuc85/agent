/**
 * QueryAnalytics — reads QueryPaid + Subscribed events directly from
 * the QueryPayment contract on Arc Mainnet. Batches block-timestamp
 * lookups, supports 7d / 30d / All time ranges, auto-refreshes every 30s.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { createPublicClient, http, parseAbiItem } from 'viem'
import { arc } from 'viem/chains'
import {
  Area, ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Line,
} from 'recharts'
import { RefreshCw, TrendingUp, Users, DollarSign, Zap } from 'lucide-react'

const ARC_RPC = 'https://rpc.mainnet.arc.io'
const USDC_DECIMALS = 6

const QUERY_PAID_ABI  = parseAbiItem('event QueryPaid(address indexed user, uint256 fee, uint256 userQueryCount)')
const SUBSCRIBED_ABI  = parseAbiItem('event Subscribed(address indexed user, uint256 expiry, uint256 fee)')

const client = createPublicClient({ chain: arc, transport: http(ARC_RPC) })

// Approx Arc Mainnet blocks per day at ~2s block time
const BLOCKS_PER_DAY = 43_200n

type Range = '7d' | '30d' | 'all'

interface DailyData {
  date: string
  queries: number
  subscriptions: number
  revenue: number      // daily USDC
  cumRevenue: number   // running total USDC
}

interface Summary {
  totalRevenue: number
  uniqueUsers: number
  totalQueries: number
  totalSubs: number
  avgDailyRevenue: number
}

interface Props {
  contractAddress: `0x${string}`
  dark: boolean
}

// Fetch block timestamps in batches to avoid hammering the RPC
async function fetchBlockTimestamps(blockNums: bigint[]): Promise<Map<bigint, number>> {
  const map = new Map<bigint, number>()
  const unique = [...new Set(blockNums)]
  // Process in chunks of 50 concurrent requests
  const CHUNK = 50
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    const results = await Promise.allSettled(
      chunk.map(bn => client.getBlock({ blockNumber: bn }))
    )
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') map.set(chunk[idx], Number(r.value.timestamp) * 1000)
    })
  }
  return map
}

function formatDate(ts: number, range: Range): string {
  const d = new Date(ts)
  if (range === 'all') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function groupKey(ts: number, range: Range): string {
  const d = new Date(ts)
  if (range === 'all') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function QueryAnalytics({ contractAddress, dark }: Props) {
  const [range, setRange]         = useState<Range>('7d')
  const [dailyData, setDailyData] = useState<DailyData[]>([])
  const [summary, setSummary]     = useState<Summary | null>(null)
  const [loading, setLoading]     = useState(false)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchEvents = useCallback(async (r: Range) => {
    setLoading(true)
    setError(null)
    try {
      const latest = await client.getBlockNumber()
      const fromBlock = r === 'all' ? 0n
        : r === '30d' ? (latest > BLOCKS_PER_DAY * 30n ? latest - BLOCKS_PER_DAY * 30n : 0n)
        : (latest > BLOCKS_PER_DAY * 7n ? latest - BLOCKS_PER_DAY * 7n : 0n)

      const [queryLogs, subLogs] = await Promise.all([
        client.getLogs({ address: contractAddress, event: QUERY_PAID_ABI, fromBlock, toBlock: latest }),
        client.getLogs({ address: contractAddress, event: SUBSCRIBED_ABI,  fromBlock, toBlock: latest }),
      ])

      // Limit block timestamp lookups to 300 unique blocks max
      const allBlocks = [
        ...queryLogs.map(l => l.blockNumber).filter((b): b is bigint => b !== null),
        ...subLogs.map(l => l.blockNumber).filter((b): b is bigint => b !== null),
      ]
      const uniqueBlocks = [...new Set(allBlocks)].slice(0, 300)
      const blockTsMap = await fetchBlockTimestamps(uniqueBlocks)

      const getTs = (bn: bigint | null | undefined): number => {
        if (!bn) return Date.now()
        return blockTsMap.get(bn) ?? Date.now()
      }

      const dayMap = new Map<string, Omit<DailyData, 'cumRevenue'>>()
      const userSet = new Set<string>()
      let totalRevenue = 0

      for (const log of queryLogs) {
        const args = log.args as { user?: string; fee?: bigint } | undefined
        const ts   = getTs(log.blockNumber)
        const key  = groupKey(ts, r)
        const fee  = Number(args?.fee ?? 0n) / 10 ** USDC_DECIMALS
        if (args?.user) userSet.add(args.user.toLowerCase())
        totalRevenue += fee
        const e = dayMap.get(key) ?? { date: formatDate(ts, r), queries: 0, subscriptions: 0, revenue: 0 }
        dayMap.set(key, { ...e, queries: e.queries + 1, revenue: Math.round((e.revenue + fee) * 1e6) / 1e6 })
      }

      for (const log of subLogs) {
        const args = log.args as { user?: string; fee?: bigint } | undefined
        const ts   = getTs(log.blockNumber)
        const key  = groupKey(ts, r)
        const fee  = Number(args?.fee ?? 0n) / 10 ** USDC_DECIMALS
        if (args?.user) userSet.add(args.user.toLowerCase())
        totalRevenue += fee
        const e = dayMap.get(key) ?? { date: formatDate(ts, r), queries: 0, subscriptions: 0, revenue: 0 }
        dayMap.set(key, { ...e, subscriptions: e.subscriptions + 1, revenue: Math.round((e.revenue + fee) * 1e6) / 1e6 })
      }

      // Sort chronologically and compute cumulative revenue
      const sorted = Array.from(dayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => v)

      let cum = 0
      const withCum: DailyData[] = sorted.map(d => {
        cum += d.revenue
        return { ...d, cumRevenue: Math.round(cum * 1e6) / 1e6 }
      })

      const totalQueries = sorted.reduce((s, d) => s + d.queries, 0)
      const totalSubs    = sorted.reduce((s, d) => s + d.subscriptions, 0)
      const days         = sorted.length || 1

      setDailyData(withCum)
      setSummary({
        totalRevenue: Math.round(totalRevenue * 1e6) / 1e6,
        uniqueUsers: userSet.size,
        totalQueries,
        totalSubs,
        avgDailyRevenue: Math.round((totalRevenue / days) * 1e6) / 1e6,
      })
      setLastFetched(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch analytics')
    } finally {
      setLoading(false)
    }
  }, [contractAddress])

  // Fetch on mount + when range changes, and auto-refresh every 30s
  useEffect(() => {
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') return
    queueMicrotask(() => { void fetchEvents(range) })
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => { void fetchEvents(range) }, 30_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [contractAddress, range, fetchEvents])

  // Styles
  const card       = dark ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-2xl p-4' : 'bg-white border border-[#e8eaf0] rounded-2xl p-4 shadow-sm'
  const textCls    = dark ? 'text-white' : 'text-[#0d1421]'
  const mutedCls   = dark ? 'text-[#8b9cc6]' : 'text-[#6b7280]'
  const gridColor  = dark ? '#2a3044' : '#f0f2f5'
  const tooltipBg  = dark ? '#1a1f2e' : '#fff'
  const tooltipBdr = dark ? '#2a3044' : '#e8eaf0'
  const tickColor  = dark ? '#8b9cc6' : '#9ca3af'

  const rangeBtn = (r: Range, label: string) => (
    <button
      key={r}
      onClick={() => setRange(r)}
      className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
        range === r
          ? 'bg-[#1652f0] text-white'
          : dark ? 'text-[#8b9cc6] hover:bg-[#2a3044]' : 'text-[#6b7280] hover:bg-[#f0f2f5]'
      }`}
    >
      {label}
    </button>
  )

  if (loading && !summary) {
    return (
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map(i => <div key={i} className={`${card} animate-pulse h-24`} />)}
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div className={`${card} text-red-400 text-sm`}>
        <p className="font-semibold mb-1">Failed to load analytics</p>
        <p className={`${mutedCls} text-xs`}>{error}</p>
        <button onClick={() => void fetchEvents(range)} className="mt-2 text-xs underline text-blue-400">Retry</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row: range selector + refresh */}
      <div className="flex items-center justify-between">
        <div className={`flex gap-1 p-1 rounded-xl ${dark ? 'bg-[#242938]' : 'bg-[#f0f2f5]'}`}>
          {rangeBtn('7d', '7d')}
          {rangeBtn('30d', '30d')}
          {rangeBtn('all', 'All')}
        </div>
        <div className="flex items-center gap-2">
          {lastFetched && <span className={`text-xs ${mutedCls}`}>{lastFetched.toLocaleTimeString()}</span>}
          <button
            onClick={() => void fetchEvents(range)}
            disabled={loading}
            className={`${mutedCls} hover:opacity-70`}
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Summary stat cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: <DollarSign size={13} />, label: 'Total USDC earned',     value: `$${summary.totalRevenue.toFixed(4)}` },
            { icon: <TrendingUp size={13} />, label: 'Avg daily revenue',     value: `$${summary.avgDailyRevenue.toFixed(4)}` },
            { icon: <Zap size={13} />,        label: 'Queries paid',          value: summary.totalQueries.toLocaleString() },
            { icon: <Users size={13} />,      label: 'Unique users',          value: summary.uniqueUsers.toLocaleString() },
          ].map(({ icon, label, value }) => (
            <div key={label} className={card}>
              <div className={`flex items-center gap-1.5 mb-1 ${mutedCls} text-xs`}>{icon} {label}</div>
              <p className={`text-lg font-bold ${textCls}`}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 text-center">{error} — showing last known data</div>
      )}

      {dailyData.length === 0 ? (
        <div className={`${card} text-center py-8`}>
          <p className={`${mutedCls} text-sm`}>No on-chain activity in this range</p>
          <p className={`${mutedCls} text-xs mt-1`}>Events will appear here as users pay for queries or subscribe.</p>
        </div>
      ) : (
        <>
          {/* Cumulative + daily revenue chart */}
          <div className={card}>
            <p className={`text-sm font-semibold ${textCls} mb-3`}>Revenue — daily + cumulative (USDC)</p>
            <ResponsiveContainer width="100%" height={180}>
              <ComposedChart data={dailyData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: tickColor }} />
                <YAxis yAxisId="daily" tick={{ fontSize: 10, fill: tickColor }} />
                <YAxis yAxisId="cum" orientation="right" tick={{ fontSize: 10, fill: tickColor }} />
                <Tooltip
                  contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBdr}`, borderRadius: 8, fontSize: 12 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(v: any, name?: string | number) => [`$${Number(v ?? 0).toFixed(4)}`, String(name ?? '')] as [string, string]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="daily" dataKey="revenue" name="Daily" fill="#10b981" radius={[3, 3, 0, 0]} opacity={0.85} />
                <Area yAxisId="cum" type="monotone" dataKey="cumRevenue" name="Cumulative" stroke="#6366f1" fill="url(#cumGrad)" strokeWidth={2} dot={false} />
                <Line yAxisId="cum" type="monotone" dataKey="cumRevenue" stroke="#6366f1" strokeWidth={2} dot={false} legendType="none" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Queries vs subscriptions bar chart */}
          <div className={card}>
            <p className={`text-sm font-semibold ${textCls} mb-3`}>Queries vs Subscriptions</p>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={dailyData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: tickColor }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: tickColor }} />
                <Tooltip
                  contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBdr}`, borderRadius: 8, fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="queries"       name="Queries"       fill="#6366f1" radius={[3, 3, 0, 0]} />
                <Bar dataKey="subscriptions" name="Subscriptions" fill="#10b981" radius={[3, 3, 0, 0]} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Per-day revenue table (top 10 days by revenue) */}
          <div className={card}>
            <p className={`text-sm font-semibold ${textCls} mb-3`}>Top days by revenue</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className={mutedCls}>
                    <th className="text-left pb-2">Date</th>
                    <th className="text-right pb-2">Queries</th>
                    <th className="text-right pb-2">Subs</th>
                    <th className="text-right pb-2">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {[...dailyData]
                    .sort((a, b) => b.revenue - a.revenue)
                    .slice(0, 10)
                    .map(d => (
                      <tr key={d.date} className={`border-t ${dark ? 'border-[#2a3044]' : 'border-[#f0f2f5]'}`}>
                        <td className={`py-1.5 ${textCls}`}>{d.date}</td>
                        <td className={`text-right py-1.5 ${mutedCls}`}>{d.queries}</td>
                        <td className={`text-right py-1.5 ${mutedCls}`}>{d.subscriptions}</td>
                        <td className={`text-right py-1.5 font-semibold ${textCls}`}>${d.revenue.toFixed(4)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
