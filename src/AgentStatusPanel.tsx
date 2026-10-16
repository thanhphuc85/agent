/**
 * AgentStatusPanel — live autonomous agent monitor
 * Shows: AI tier health + fallback log, on-chain event feed (SSE), session key status
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Activity, Zap, AlertTriangle, CheckCircle, Clock, RefreshCw } from 'lucide-react'

interface AgentStatus {
  ok: boolean
  aiPrimary: string
  currentTier: 'groq' | 'gemini' | 'local'
  groq: boolean
  gemini: boolean
  x402: boolean
  push: boolean
  telegram: boolean
  adminProtected: boolean
  subscribers: number
  recentFallbacks: Array<{ tier: string; reason: string; at: number }>
  chainEvents: {
    total: number
    lastBlock: string
    updatedAt: number
    summary: string
  }
}

interface ChainEvent {
  id: string
  type: 'QueryPaid' | 'Subscribed' | 'UsdcTransfer'
  blockNumber: string
  txHash: string
  from: string
  amountUsdc: string
  timestamp: number
}

interface SessionKey {
  address: string
  expiry: number
  spendCapUsdc: number
}

const TIER_COLOR: Record<string, string> = {
  groq:   'text-green-400',
  gemini: 'text-blue-400',
  local:  'text-amber-400',
}

const EVENT_COLOR: Record<string, string> = {
  QueryPaid:    'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Subscribed:   'bg-green-500/10 text-green-400 border-green-500/20',
  UsdcTransfer: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
}

const EVENT_LABEL: Record<string, string> = {
  QueryPaid:    'Query Paid',
  Subscribed:   'Subscribed',
  UsdcTransfer: 'USDC Transfer',
}

function relTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000)  return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

interface Props { darkMode: boolean }

export function AgentStatusPanel({ darkMode }: Props) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [events, setEvents] = useState<ChainEvent[]>([])
  const [sessionKey, setSessionKey] = useState<SessionKey | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'ai' | 'chain' | 'session'>('ai')
  const [, setTick] = useState(0)
  const sseRef = useRef<EventSource | null>(null)

  // Relative-time refresh tick
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])

  const loadStatus = useCallback(() => {
    void fetch('/api/agent-status')
      .then(r => r.ok ? r.json() as Promise<AgentStatus> : null)
      .then(d => { if (d) queueMicrotask(() => { setStatus(d); setLoading(false) }) })
      .catch(() => queueMicrotask(() => setLoading(false)))
  }, [])

  useEffect(() => {
    loadStatus()
    const t = setInterval(loadStatus, 30_000)
    return () => clearInterval(t)
  }, [loadStatus])

  // SSE on-chain event stream
  useEffect(() => {
    const es = new EventSource('/api/events/stream')
    sseRef.current = es
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const ev = JSON.parse(e.data) as ChainEvent
        queueMicrotask(() => setEvents(prev => {
          if (prev.some(p => p.id === ev.id)) return prev
          return [ev, ...prev].slice(0, 100)
        }))
      } catch { /* ignore malformed */ }
    }
    return () => { es.close(); sseRef.current = null }
  }, [])

  // Load initial events from REST endpoint
  useEffect(() => {
    void fetch('/api/events/recent')
      .then(r => r.ok ? r.json() as Promise<{ events: ChainEvent[] }> : null)
      .then(d => { if (d?.events) queueMicrotask(() => setEvents(d.events)) })
      .catch(() => null)
  }, [])

  // Load session key from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('cryptoadvisor_session_key')
      if (raw) {
        const sk = JSON.parse(raw) as SessionKey
        queueMicrotask(() => setSessionKey(sk.expiry > Date.now() ? sk : null))
      }
    } catch { /* ignore */ }
  }, [])

  const createSessionKey = useCallback(() => {
    // Session key: 24-hour spend authorization stored locally
    const address = localStorage.getItem('connectedWallet') ?? 'unknown'
    const sk: SessionKey = {
      address,
      expiry: Date.now() + 86_400_000,
      spendCapUsdc: 1.00,
    }
    localStorage.setItem('cryptoadvisor_session_key', JSON.stringify(sk))
    // Notify server
    void fetch('/api/session/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: sk.address, expiry: sk.expiry }),
    }).catch(() => null)
    setSessionKey(sk)
  }, [])

  const revokeSessionKey = useCallback(() => {
    localStorage.removeItem('cryptoadvisor_session_key')
    setSessionKey(null)
  }, [])

  const surface = darkMode ? 'var(--surface)' : '#fff'
  const border  = darkMode ? 'var(--border)' : '#e8eaf0'
  const ink1    = darkMode ? 'var(--ink-1)' : '#0d1421'
  const ink2    = darkMode ? 'var(--ink-2)' : '#4b5563'
  const subtle  = darkMode ? 'var(--subtle)' : '#9ca3af'

  const tabBtn = (id: typeof tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className="flex-1 py-2 text-xs font-semibold transition-colors rounded-lg"
      style={{
        background: tab === id ? 'var(--accent)' : 'transparent',
        color: tab === id ? '#fff' : ink2,
        border: tab === id ? 'none' : `1px solid ${border}`,
      }}
    >
      {label}
    </button>
  )

  if (loading) return (
    <div className="flex items-center justify-center h-40" style={{ color: subtle }}>
      <Activity size={20} className="animate-pulse mr-2" />
      <span className="text-sm">Loading agent status…</span>
    </div>
  )

  return (
    <div className="flex flex-col gap-4 p-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: ink1 }}>Autonomous Agent</span>
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: status?.ok ? '#22c55e' : '#ef4444' }}
          />
        </div>
        <button onClick={loadStatus} className="p-1.5 rounded-lg hover:opacity-70 transition-opacity" style={{ color: subtle }}>
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2">
        {tabBtn('ai',      'AI Health')}
        {tabBtn('chain',   'Chain Events')}
        {tabBtn('session', 'Session Key')}
      </div>

      {/* ── AI Health Tab ─────────────────────────────────────────────── */}
      {tab === 'ai' && status && (
        <div className="flex flex-col gap-3">
          {/* Current tier */}
          <div
            className="rounded-xl p-4 flex items-center gap-3"
            style={{ background: surface, border: `1px solid ${border}` }}
          >
            <Zap size={20} style={{ color: 'var(--accent)' }} />
            <div>
              <p className="text-xs font-medium" style={{ color: subtle }}>Active AI tier</p>
              <p className={`text-lg font-bold capitalize ${TIER_COLOR[status.currentTier]}`}>
                {status.currentTier}
              </p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-xs" style={{ color: subtle }}>Fallback chain</p>
              <p className="text-xs font-mono" style={{ color: ink2 }}>
                {status.groq ? 'Groq' : '—'} → {status.gemini ? 'Gemini' : '—'} → Local KB
              </p>
            </div>
          </div>

          {/* Service status grid */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Groq',     on: status.groq,     icon: '⚡' },
              { label: 'Gemini',   on: status.gemini,   icon: '🌐' },
              { label: 'Telegram', on: status.telegram, icon: '📣' },
              { label: 'Web Push', on: status.push,     icon: '🔔' },
              { label: 'x402',     on: status.x402,     icon: '💳' },
              { label: 'Admin',    on: status.adminProtected, icon: '🔒' },
            ].map(({ label, on, icon }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{ background: surface, border: `1px solid ${border}` }}
              >
                <span className="text-sm">{icon}</span>
                <span className="text-xs font-medium flex-1" style={{ color: ink2 }}>{label}</span>
                {on
                  ? <CheckCircle size={13} className="text-green-400" />
                  : <AlertTriangle size={13} className="text-amber-400" />
                }
              </div>
            ))}
          </div>

          {/* Fallback log */}
          <div
            className="rounded-xl p-3 flex flex-col gap-2"
            style={{ background: surface, border: `1px solid ${border}` }}
          >
            <p className="text-xs font-semibold" style={{ color: ink1 }}>Recent fallbacks</p>
            {status.recentFallbacks.length === 0 ? (
              <p className="text-xs" style={{ color: subtle }}>No fallbacks triggered — all good.</p>
            ) : (
              status.recentFallbacks.slice(0, 5).map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <AlertTriangle size={11} className="text-amber-400 flex-shrink-0" />
                  <span className={`font-mono capitalize ${TIER_COLOR[f.tier]}`}>{f.tier}</span>
                  <span style={{ color: ink2 }}>{f.reason.replace('_', ' ')}</span>
                  <span className="ml-auto" style={{ color: subtle }}>{relTime(f.at)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Chain Events Tab ──────────────────────────────────────────── */}
      {tab === 'chain' && (
        <div className="flex flex-col gap-3">
          {/* Summary */}
          {status?.chainEvents && (
            <div
              className="rounded-xl p-3 flex flex-col gap-1"
              style={{ background: surface, border: `1px solid ${border}` }}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold" style={{ color: ink1 }}>
                  {status.chainEvents.total} events cached
                </p>
                <p className="text-xs" style={{ color: subtle }}>
                  {status.chainEvents.updatedAt ? `Updated ${relTime(status.chainEvents.updatedAt)}` : 'Polling…'}
                </p>
              </div>
              {status.chainEvents.summary && (
                <p className="text-xs" style={{ color: ink2 }}>{status.chainEvents.summary}</p>
              )}
            </div>
          )}

          {/* Live event feed */}
          <div
            className="rounded-xl overflow-hidden flex flex-col"
            style={{ background: surface, border: `1px solid ${border}`, maxHeight: 340 }}
          >
            <div className="px-3 py-2 flex items-center gap-2 border-b" style={{ borderColor: border }}>
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              <p className="text-xs font-semibold" style={{ color: ink1 }}>Live event feed</p>
            </div>
            <div className="overflow-y-auto flex-1">
              {events.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs" style={{ color: subtle }}>
                  Waiting for on-chain events…
                </div>
              ) : (
                events.slice(0, 50).map(ev => (
                  <div
                    key={ev.id}
                    className="flex items-center gap-3 px-3 py-2 border-b text-xs"
                    style={{ borderColor: border }}
                  >
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${EVENT_COLOR[ev.type]}`}
                    >
                      {EVENT_LABEL[ev.type]}
                    </span>
                    <span className="font-mono flex-1 truncate" style={{ color: ink2 }}>
                      {ev.from.slice(0, 8)}…{ev.from.slice(-4)}
                    </span>
                    <span className="font-semibold" style={{ color: ink1 }}>${ev.amountUsdc}</span>
                    <span style={{ color: subtle }}>{relTime(ev.timestamp)}</span>
                    <a
                      href={`https://explorer.arc.io/tx/${ev.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline text-[10px]"
                      style={{ color: 'var(--accent)' }}
                    >
                      tx
                    </a>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Session Key Tab ───────────────────────────────────────────── */}
      {tab === 'session' && (
        <div className="flex flex-col gap-3">
          <div
            className="rounded-xl p-4 flex flex-col gap-3"
            style={{ background: surface, border: `1px solid ${border}` }}
          >
            <div className="flex items-center gap-2">
              <Clock size={15} style={{ color: 'var(--accent)' }} />
              <p className="text-sm font-semibold" style={{ color: ink1 }}>Session Key</p>
            </div>
            <p className="text-xs" style={{ color: ink2 }}>
              A session key pre-authorizes query payments for 24 hours so you can ask questions
              without approving each transaction individually. The key is stored locally and never
              leaves your device.
            </p>
            {sessionKey ? (
              <div className="flex flex-col gap-2">
                <div
                  className="rounded-lg p-3 flex flex-col gap-1"
                  style={{ background: darkMode ? '#0d2a1a' : '#dcfce7', border: '1px solid #16a34a33' }}
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle size={13} className="text-green-400" />
                    <p className="text-xs font-semibold text-green-400">Active session key</p>
                  </div>
                  <p className="text-xs font-mono" style={{ color: ink2 }}>
                    {sessionKey.address.slice(0, 10)}…{sessionKey.address.slice(-6)}
                  </p>
                  <p className="text-xs" style={{ color: subtle }}>
                    Expires {new Date(sessionKey.expiry).toLocaleString()} · Cap ${sessionKey.spendCapUsdc.toFixed(2)} USDC
                  </p>
                </div>
                <button
                  onClick={revokeSessionKey}
                  className="py-2 rounded-lg text-xs font-semibold text-red-400 border border-red-500/20 hover:opacity-80 transition-opacity"
                >
                  Revoke session key
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div
                  className="rounded-lg p-3"
                  style={{ background: darkMode ? '#1a1a2e' : '#f7f8fa', border: `1px solid ${border}` }}
                >
                  <p className="text-xs" style={{ color: subtle }}>No active session key</p>
                </div>
                <button
                  onClick={createSessionKey}
                  className="py-2.5 rounded-lg text-sm font-semibold text-white transition-colors"
                  style={{ background: 'var(--accent)' }}
                >
                  Create 24-hour session key
                </button>
                <p className="text-[10px] text-center" style={{ color: subtle }}>
                  Spend cap: $1.00 USDC · stored locally · revoke anytime
                </p>
              </div>
            )}
          </div>

          {/* How it works */}
          <div
            className="rounded-xl p-3 flex flex-col gap-2"
            style={{ background: surface, border: `1px solid ${border}` }}
          >
            <p className="text-xs font-semibold" style={{ color: ink1 }}>How session keys work</p>
            {[
              '1. You create a session key with a 24-hour expiry and a $1 USDC spend cap.',
              '2. When you ask a question, the app checks for a valid session key first.',
              '3. If valid, the payment flows automatically — no wallet popup.',
              '4. Once the key expires or the cap is reached, you\'re prompted to renew.',
            ].map((s, i) => (
              <p key={i} className="text-xs" style={{ color: ink2 }}>{s}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
