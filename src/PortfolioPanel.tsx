import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import {
  ShieldCheck, ShieldAlert, ShieldOff, Bell, BellOff, Plus, Trash2,
  RefreshCw, TrendingDown, TrendingUp, Zap, ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// ── Types (mirrors server/portfolio.ts) ────────────────────────────────────

interface ManualToken { symbol: string; amount: number }
interface PortfolioSnapshot {
  wallet: string; usdcBalance: string; contractUsdcBalance: string
  manualTokens: ManualToken[]; updatedAt: number
}
interface RiskScore {
  wallet: string; score: number; level: 'safe' | 'low' | 'medium' | 'high' | 'critical'
  factors: string[]
}
interface YieldOpp { protocol: string; asset: string; apy: number; riskLevel: string; description: string; url?: string }
interface AutomationRule {
  id: string; wallet: string; raw: string; asset: string
  condition: string; threshold: number; windowHours: number
  cooldownMinutes: number; lastFiredAt?: number; createdAt: number; enabled: boolean
}
interface Alert {
  id: string; wallet: string; ruleId: string; ruleRaw: string
  message: string; severity: 'info' | 'warning' | 'critical'; firedAt: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

function usdcFmt(raw: string): string {
  const n = Number(BigInt(raw || '0')) / 1e6
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function riskColor(level: RiskScore['level']): string {
  return level === 'safe' ? 'var(--success, #059669)'
    : level === 'low'    ? '#84cc16'
    : level === 'medium' ? '#f59e0b'
    : level === 'high'   ? '#ef4444'
    : '#dc2626'
}

function riskIcon(level: RiskScore['level']) {
  if (level === 'safe' || level === 'low') return <ShieldCheck size={16} style={{ color: riskColor(level) }} />
  if (level === 'medium') return <ShieldAlert size={16} style={{ color: riskColor(level) }} />
  return <ShieldOff size={16} style={{ color: riskColor(level) }} />
}

function severityStyle(s: Alert['severity']): React.CSSProperties {
  return s === 'critical' ? { color: '#dc2626', background: '#fee2e2' }
    : s === 'warning'     ? { color: '#92400e', background: '#fef3c7' }
    : { color: '#065f46', background: '#d1fae5' }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function RiskMeter({ score, level }: { score: number; level: RiskScore['level'] }) {
  const pct = Math.min(score, 100)
  const color = riskColor(level)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs" style={{ color: 'var(--ink-2)' }}>
        <span>Risk score</span>
        <span className="font-bold" style={{ color }}>{score}/100 — {level}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

function AlertBadge({ severity }: { severity: Alert['severity'] }) {
  const s = severityStyle(severity)
  return (
    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={s}>
      {severity}
    </span>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────

export default function PortfolioPanel(_props: { dark: boolean }) {
  const { address } = useAccount()
  const [tab, setTab] = useState<'overview' | 'rules' | 'alerts' | 'yields'>('overview')
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null)
  const [risk, setRisk] = useState<RiskScore | null>(null)
  const [yields, setYields] = useState<YieldOpp[]>([])
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [registered, setRegistered] = useState(false)

  // Manual tokens editor
  const [showTokenEditor, setShowTokenEditor] = useState(false)
  const [newSymbol, setNewSymbol] = useState('')
  const [newAmount, setNewAmount] = useState('')

  // Rules
  const [ruleText, setRuleText] = useState('')
  const [addingRule, setAddingRule] = useState(false)

  // Alert history chart data
  const [alertChart, setAlertChart] = useState<{ date: string; count: number }[]>([])

  const fetchPortfolio = useCallback(async (wallet: string) => {
    try {
      const r = await fetch(`/api/portfolio/${wallet}`)
      if (!r.ok) return
      const d = await r.json() as { portfolio: PortfolioSnapshot; risk: RiskScore; yields: YieldOpp[] }
      setPortfolio(d.portfolio)
      setRisk(d.risk)
      setYields(d.yields)
    } catch { /* silently fail */ }
  }, [])

  const fetchRules = useCallback(async (wallet: string) => {
    try {
      const r = await fetch(`/api/portfolio/rules/${wallet}`)
      if (!r.ok) return
      const d = await r.json() as { rules: AutomationRule[] }
      setRules(d.rules)
    } catch { /* silently fail */ }
  }, [])

  const fetchAlerts = useCallback(async (wallet: string) => {
    try {
      const r = await fetch(`/api/portfolio/alerts/${wallet}`)
      if (!r.ok) return
      const d = await r.json() as { alerts: Alert[] }
      setAlerts(d.alerts)
      // Build chart: alerts per day over last 7 days
      const now = Date.now()
      const days: Record<string, number> = {}
      for (let i = 6; i >= 0; i--) {
        const dt = new Date(now - i * 86_400_000)
        days[dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })] = 0
      }
      for (const a of d.alerts) {
        if (now - a.firedAt < 7 * 86_400_000) {
          const key = new Date(a.firedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          if (key in days) days[key]++
        }
      }
      setAlertChart(Object.entries(days).map(([date, count]) => ({ date, count })))
    } catch { /* silently fail */ }
  }, [])

  // Register wallet and fetch data
  const registerAndFetch = useCallback(async (wallet: string) => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/portfolio/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      })
      if (!r.ok) { setError('Registration failed'); return }
      setRegistered(true)
      await Promise.all([fetchPortfolio(wallet), fetchRules(wallet), fetchAlerts(wallet)])
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }, [fetchPortfolio, fetchRules, fetchAlerts])

  // Auto-register when wallet connects
  useEffect(() => {
    if (!address) return
    queueMicrotask(() => { void registerAndFetch(address) })
  }, [address, registerAndFetch])

  // Poll every 60s
  useEffect(() => {
    if (!address || !registered) return
    const t = setInterval(() => {
      void fetchPortfolio(address)
      void fetchAlerts(address)
    }, 60_000)
    return () => clearInterval(t)
  }, [address, registered, fetchPortfolio, fetchAlerts])

  // SSE: listen for real-time alerts
  useEffect(() => {
    if (!address) return
    const es = new EventSource('/api/events/stream')
    es.onmessage = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data as string) as { type?: string; alert?: Alert }
        if (d.type === 'alert' && d.alert?.wallet.toLowerCase() === address.toLowerCase()) {
          setAlerts(prev => [d.alert!, ...prev].slice(0, 50))
        }
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [address])

  const addManualToken = async () => {
    if (!address || !newSymbol || !newAmount) return
    const updated = [
      ...(portfolio?.manualTokens ?? []).filter(t => t.symbol !== newSymbol.toUpperCase()),
      { symbol: newSymbol.toUpperCase(), amount: parseFloat(newAmount) },
    ]
    await fetch(`/api/portfolio/${address}/tokens`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualTokens: updated }),
    })
    setNewSymbol(''); setNewAmount('')
    void fetchPortfolio(address)
  }

  const removeManualToken = async (symbol: string) => {
    if (!address || !portfolio) return
    const updated = portfolio.manualTokens.filter(t => t.symbol !== symbol)
    await fetch(`/api/portfolio/${address}/tokens`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualTokens: updated }),
    })
    void fetchPortfolio(address)
  }

  const addRule = async () => {
    if (!address || !ruleText.trim()) return
    setAddingRule(true)
    try {
      const r = await fetch('/api/portfolio/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address, text: ruleText.trim() }),
      })
      if (r.ok) { setRuleText(''); void fetchRules(address) }
    } finally { setAddingRule(false) }
  }

  const deleteRule = async (id: string) => {
    await fetch(`/api/portfolio/rules/${id}`, { method: 'DELETE' })
    void fetchRules(address!)
  }

  const toggleRule = async (id: string, enabled: boolean) => {
    await fetch(`/api/portfolio/rules/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    })
    void fetchRules(address!)
  }

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface-strong)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: 'none', transition: 'all 0.15s',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--ink-2)',
  })

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <ShieldCheck size={36} style={{ color: 'var(--subtle)' }} />
        <p style={{ color: 'var(--ink-2)', fontSize: 14 }}>
          Connect your wallet to monitor your portfolio and set up automated alerts.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2" style={{ color: 'var(--ink-2)' }}>
        <RefreshCw size={16} className="animate-spin" />
        <span className="text-sm">Fetching portfolio…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <AlertTriangle size={24} style={{ color: '#ef4444' }} />
        <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>{error}</p>
        <button
          onClick={() => void registerAndFetch(address)}
          className="px-4 py-2 rounded-lg text-xs font-semibold"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >Retry</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--surface)' }}>
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['overview', 'rules', 'alerts', 'yields'] as const).map(t => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'alerts' && alerts.length > 0 && (
              <span className="ml-1 w-4 h-4 rounded-full text-[9px] font-bold inline-flex items-center justify-center"
                style={{ background: '#ef4444', color: '#fff' }}>{Math.min(alerts.length, 9)}</span>
            )}
          </button>
        ))}
        <button
          onClick={() => { void fetchPortfolio(address); void fetchAlerts(address) }}
          className="ml-auto p-1.5 rounded-lg transition-colors hover:opacity-70"
          style={{ color: 'var(--subtle)' }}
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* Overview tab */}
        {tab === 'overview' && portfolio && (
          <>
            {/* Balances */}
            <div className="grid grid-cols-2 gap-3">
              <div style={cardStyle}>
                <div className="text-xs mb-1" style={{ color: 'var(--subtle)' }}>Wallet USDC</div>
                <div className="text-lg font-bold" style={{ color: 'var(--ink-1)' }}>{usdcFmt(portfolio.usdcBalance)}</div>
              </div>
              <div style={cardStyle}>
                <div className="text-xs mb-1" style={{ color: 'var(--subtle)' }}>Contract USDC</div>
                <div className="text-lg font-bold" style={{ color: 'var(--ink-1)' }}>{usdcFmt(portfolio.contractUsdcBalance)}</div>
              </div>
            </div>

            {/* Risk */}
            {risk && (
              <div style={cardStyle}>
                <div className="flex items-center gap-2 mb-3">
                  {riskIcon(risk.level)}
                  <span className="text-sm font-semibold" style={{ color: 'var(--ink-1)' }}>Risk Assessment</span>
                </div>
                <RiskMeter score={risk.score} level={risk.level} />
                {risk.factors.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {risk.factors.map((f, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--ink-2)' }}>
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" style={{ color: '#f59e0b' }} />
                        {f}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Manual tokens */}
            <div style={cardStyle}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold" style={{ color: 'var(--ink-1)' }}>Manual Tokens</span>
                <button onClick={() => setShowTokenEditor(s => !s)}
                  className="text-xs flex items-center gap-1" style={{ color: 'var(--accent)' }}>
                  {showTokenEditor ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {showTokenEditor ? 'Close' : 'Add token'}
                </button>
              </div>
              {portfolio.manualTokens.length === 0 && !showTokenEditor && (
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>No manual tokens. Add holdings for a complete risk picture.</p>
              )}
              {portfolio.manualTokens.map(t => (
                <div key={t.symbol} className="flex items-center justify-between py-1.5 text-sm" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span className="font-medium" style={{ color: 'var(--ink-1)' }}>{t.symbol}</span>
                  <div className="flex items-center gap-3">
                    <span style={{ color: 'var(--ink-2)' }}>{t.amount.toLocaleString()}</span>
                    <button onClick={() => void removeManualToken(t.symbol)} style={{ color: '#ef4444' }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {showTokenEditor && (
                <div className="flex gap-2 mt-2">
                  <input value={newSymbol} onChange={e => setNewSymbol(e.target.value)}
                    placeholder="BTC" className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-xs"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink-1)' }} />
                  <input value={newAmount} onChange={e => setNewAmount(e.target.value)}
                    placeholder="Amount" type="number" className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-xs"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink-1)' }} />
                  <button onClick={() => void addManualToken()}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0"
                    style={{ background: 'var(--accent)', color: '#fff' }}>
                    <Plus size={13} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Rules tab */}
        {tab === 'rules' && (
          <>
            <div style={cardStyle}>
              <p className="text-xs mb-3" style={{ color: 'var(--ink-2)' }}>
                Type a rule in plain English. Examples: "alert me if ETH drops 10% in a day" or "notify me when my USDC balance falls below $20".
              </p>
              <div className="flex gap-2">
                <input
                  value={ruleText} onChange={e => setRuleText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void addRule() }}
                  placeholder="e.g. alert if BTC drops 15%…"
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg text-xs"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink-1)' }}
                />
                <button onClick={() => void addRule()} disabled={addingRule || !ruleText.trim()}
                  className="px-3 py-2 rounded-lg text-xs font-semibold flex-shrink-0 flex items-center gap-1.5"
                  style={{ background: 'var(--accent)', color: '#fff', opacity: addingRule || !ruleText.trim() ? 0.5 : 1 }}>
                  {addingRule ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
                  {addingRule ? 'Parsing…' : 'Add'}
                </button>
              </div>
            </div>

            {rules.length === 0 && (
              <p className="text-center text-xs py-8" style={{ color: 'var(--subtle)' }}>No automation rules yet.</p>
            )}
            {rules.map(rule => (
              <div key={rule.id} style={{ ...cardStyle, opacity: rule.enabled ? 1 : 0.6 }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color: 'var(--ink-1)' }}>{rule.raw}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--subtle)' }}>
                      {rule.asset} · {rule.condition.replace(/_/g, ' ')} {rule.threshold}
                      {rule.condition.includes('pct') ? '%' : ''} · {rule.windowHours}h window
                    </p>
                    {rule.lastFiredAt && (
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--subtle)' }}>
                        Last fired: {new Date(rule.lastFiredAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => void toggleRule(rule.id, rule.enabled)}
                      title={rule.enabled ? 'Disable' : 'Enable'}>
                      {rule.enabled
                        ? <Bell size={14} style={{ color: 'var(--accent)' }} />
                        : <BellOff size={14} style={{ color: 'var(--subtle)' }} />}
                    </button>
                    <button onClick={() => void deleteRule(rule.id)}
                      style={{ color: '#ef4444' }}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Alerts tab */}
        {tab === 'alerts' && (
          <>
            {alertChart.some(d => d.count > 0) && (
              <div style={cardStyle}>
                <p className="text-xs font-semibold mb-2" style={{ color: 'var(--ink-2)' }}>Alerts last 7 days</p>
                <ResponsiveContainer width="100%" height={80}>
                  <AreaChart data={alertChart} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--subtle)' }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: 'var(--subtle)' }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                      formatter={(v) => { const n = typeof v === 'number' ? v : 0; return [`${n} alert${n !== 1 ? 's' : ''}`, ''] as [string, string] }}
                    />
                    <Area type="monotone" dataKey="count" stroke="#ef4444" fill="#fee2e2" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {alerts.length === 0 && (
              <p className="text-center text-xs py-8" style={{ color: 'var(--subtle)' }}>No alerts fired yet. Add rules to start monitoring.</p>
            )}
            {alerts.map(alert => (
              <div key={alert.id} style={cardStyle}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <AlertBadge severity={alert.severity} />
                  <span className="text-[10px]" style={{ color: 'var(--subtle)' }}>
                    {new Date(alert.firedAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--ink-1)' }}>{alert.message}</p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--subtle)' }}>Rule: {alert.ruleRaw}</p>
              </div>
            ))}
          </>
        )}

        {/* Yields tab */}
        {tab === 'yields' && (
          <>
            <p className="text-xs px-1" style={{ color: 'var(--subtle)' }}>
              Arc-native yield opportunities for your USDC. APYs are indicative and may vary.
            </p>
            {yields.map((y, i) => (
              <div key={i} style={cardStyle}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: 'var(--ink-1)' }}>{y.protocol}</p>
                    <p className="text-[11px]" style={{ color: 'var(--subtle)' }}>{y.asset} · {y.riskLevel} risk</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-lg font-bold" style={{ color: y.apy > 0 ? 'var(--success, #059669)' : 'var(--subtle)' }}>
                      {y.apy > 0 ? `${y.apy}%` : 'N/A'}
                    </p>
                    <p className="text-[10px]" style={{ color: 'var(--subtle)' }}>APY</p>
                  </div>
                </div>
                <p className="text-xs" style={{ color: 'var(--ink-2)' }}>{y.description}</p>
                {y.url && (
                  <a href={y.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium"
                    style={{ color: 'var(--accent)' }}>
                    {y.apy > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    Learn more →
                  </a>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Last updated */}
      {portfolio && (
        <div className="px-4 py-2 text-[10px] flex-shrink-0" style={{ color: 'var(--subtle)', borderTop: '1px solid var(--border)' }}>
          Last updated: {new Date(portfolio.updatedAt).toLocaleTimeString()} · auto-refreshes every 60s
        </div>
      )}
    </div>
  )
}
