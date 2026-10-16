import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Send, Bot, User, TrendingUp, Shield, Coins, RefreshCw,
  ChevronRight, Moon, Sun, Copy, Check, Bookmark, BookmarkCheck,
  BookOpen, History, Search, X, Hash, ChevronDown, ChevronUp,
  Layers, Zap, Globe, Lock, DollarSign, Wallet, AlertCircle, Loader2,
  ArrowLeftRight, KeyRound, LayoutDashboard, Link, MoreHorizontal,
  Bell, BellOff, Cpu, Activity, ShieldCheck,
} from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { MarketSwapPanel } from './MarketSwapPanel'
import { PasskeyWalletPanel } from './PasskeyWallet'
import { OwnerDashboard } from './OwnerDashboard'
import { AgentStatusPanel } from './AgentStatusPanel'
import PortfolioPanel from './PortfolioPanel'
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain
} from 'wagmi'
import { erc20Abi } from 'viem'
import { getUsdc, buildTxExplorerUrl } from '@/onchain-facts'
import { Amount, usdcDecimalsFor } from '@/onchain-money'
import { toast } from 'sonner'

// ── Contract config ────────────────────────────────────────────────────────
const ARC_CHAIN_ID = 5042 // Arc Mainnet
// TODO: Replace with your QueryPayment contract address deployed on Arc Mainnet
const QUERY_PAYMENT_ADDRESS = '0x0a83a718D6d8cBE850B986c025dE287bc3fe5a29' as const
const QUERY_FEE_RAW = 10000n // $0.01 USDC (6 decimals)
const QUERY_PAYMENT_ABI = [
  { name: 'payForQuery',       type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'subscribe',         type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'isSubscribed',      type: 'function', stateMutability: 'view',       inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'queryFee',          type: 'function', stateMutability: 'view',       inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'subscriptionFee',   type: 'function', stateMutability: 'view',       inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'queriesByUser',     type: 'function', stateMutability: 'view',       inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'subscriptionExpiry', type: 'function', stateMutability: 'view',      inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalQueriesPaid',  type: 'function', stateMutability: 'view',       inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSubscriptions', type: 'function', stateMutability: 'view',      inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const usdcFact = getUsdc(ARC_CHAIN_ID)!
const USDC_ADDRESS = usdcFact.address as `0x${string}`

// ── Payment gate component ─────────────────────────────────────────────────
type PayStep = 'idle' | 'approving' | 'approved' | 'paying' | 'done' | 'error'

// ── Session key helpers ────────────────────────────────────────────────────
const SESSION_KEY_PREFIX = 'cryptoadvisor_session_'

function sessionKey(address: string) { return `${SESSION_KEY_PREFIX}${address.toLowerCase()}` }

interface SessionState {
  totalApproved: number   // total queries approved this session
  remaining: number       // queries left before re-approve needed
  approvedAt: number      // unix ms — expires after 24h
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

function loadSession(address: string): SessionState | null {
  try {
    const raw = localStorage.getItem(sessionKey(address))
    if (!raw) return null
    const s = JSON.parse(raw) as SessionState
    if (Date.now() - s.approvedAt > SESSION_TTL_MS) { localStorage.removeItem(sessionKey(address)); return null }
    return s
  } catch { return null }
}

function saveSession(address: string, s: SessionState) {
  localStorage.setItem(sessionKey(address), JSON.stringify(s))
}

function clearSession(address: string) {
  localStorage.removeItem(sessionKey(address))
}

// ── SessionBadge ──────────────────────────────────────────────────────────
interface SessionBadgeProps {
  address: string | undefined
  onSetup: () => void
}

function SessionBadge({ address, onSetup }: SessionBadgeProps) {
  const [session, setSession] = useState<SessionState | null>(null)

  useLayoutEffect(() => {
    if (!address) { setSession(null); return }
    setSession(loadSession(address))
    const id = setInterval(() => setSession(loadSession(address)), 5_000)
    return () => clearInterval(id)
  }, [address])

  if (!address) return null

  if (!session || session.remaining <= 0) {
    return (
      <button
        onClick={onSetup}
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all"
        style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
        title="Approve a session allowance to skip wallet pop-ups"
      >
        <KeyRound size={11} />
        <span className="hidden sm:inline">Session key</span>
      </button>
    )
  }

  const low = session.remaining <= 2
  return (
    <button
      onClick={onSetup}
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all"
      style={{ background: low ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', color: low ? '#ef4444' : '#10b981' }}
      title="Click to top up session allowance"
    >
      <KeyRound size={11} />
      <span>{session.remaining} left</span>
    </button>
  )
}

// ── SessionSetupModal ─────────────────────────────────────────────────────
const SESSION_TIERS = [
  { label: '5 queries',  n: 5  },
  { label: '10 queries', n: 10 },
  { label: '20 queries', n: 20 },
  { label: '50 queries', n: 50 },
]

interface SessionSetupModalProps {
  dark: boolean
  address: string
  queryFeeRaw: bigint
  onClose: () => void
  onActivated: () => void
}

function SessionSetupModal({ dark, address, queryFeeRaw, onClose, onActivated }: SessionSetupModalProps) {
  const { chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [selected, setSelected] = useState(10)
  const [step, setStep] = useState<'choose' | 'approving' | 'confirming' | 'done' | 'error'>('choose')
  const [errorMsg, setErrorMsg] = useState('')
  const isWrongChain = chainId !== ARC_CHAIN_ID

  const totalRaw = queryFeeRaw * BigInt(selected)
  const totalFmt = (Number(totalRaw) / 1e6).toFixed(2)

  const { writeContract: approve, data: approveTxHash, isPending: isApprovePending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash })

  const doneHandled = useRef(false)
  useLayoutEffect(() => {
    if (isApproveSuccess && !doneHandled.current) {
      doneHandled.current = true
      const s: SessionState = { totalApproved: selected, remaining: selected, approvedAt: Date.now() }
      saveSession(address, s)
      queueMicrotask(() => {
        setStep('done')
        toast.success(`Session key active — ${selected} queries pre-approved`)
        setTimeout(onActivated, 600)
      })
    }
  })

  const handleApprove = () => {
    if (isWrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    setStep('approving')
    setErrorMsg('')
    try {
      approve({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [QUERY_PAYMENT_ADDRESS, totalRaw],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e) {
      setStep('error')
      setErrorMsg(e instanceof Error ? e.message : 'Approval failed')
    }
  }

  const isWorking = step === 'approving' || isApprovePending || isConfirming

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="w-full max-w-sm rounded-2xl overflow-hidden border"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}>
          <KeyRound size={15} style={{ color: 'var(--accent)' }} />
          <span className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>Session Key Authorization</span>
          <button onClick={onClose} className="ml-auto" style={{ color: 'var(--subtle)' }}><X size={15} /></button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
            Approve a bulk USDC allowance once — then pay for queries instantly with no wallet pop-up until the allowance runs out.
          </p>

          {/* Tier picker */}
          <div>
            <p className="text-xs font-medium mb-2" style={{ color: 'var(--muted)' }}>Choose session size</p>
            <div className="grid grid-cols-4 gap-2">
              {SESSION_TIERS.map(t => (
                <button
                  key={t.n}
                  onClick={() => setSelected(t.n)}
                  className="py-2 rounded-xl text-sm font-semibold border transition-all"
                  style={{
                    borderColor: selected === t.n ? 'var(--accent)' : 'var(--border)',
                    background: selected === t.n ? 'rgba(37,99,235,0.1)' : 'var(--surface-muted)',
                    color: selected === t.n ? 'var(--accent)' : 'var(--ink-2)',
                  }}
                >
                  {t.n}
                </button>
              ))}
            </div>
            <p className="text-xs mt-2 text-center" style={{ color: 'var(--subtle)' }}>
              Approves ${totalFmt} USDC total · ${(Number(queryFeeRaw) / 1e6).toFixed(2)}/query
            </p>
          </div>

          {/* What this does */}
          <div className="rounded-xl px-3 py-2.5 space-y-1" style={{ background: 'var(--surface-muted)' }}>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-2)' }}>
              <span className="text-green-500">✓</span> One wallet signature now
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-2)' }}>
              <span className="text-green-500">✓</span> {selected} instant queries — no pop-ups
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-2)' }}>
              <span className="text-green-500">✓</span> Session expires after 24 hours or when used up
            </div>
          </div>

          {step === 'error' && (
            <div className="flex items-center gap-2 text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(186,43,76,0.08)', color: 'var(--danger)' }}>
              <AlertCircle size={12} /><span>{errorMsg}</span>
            </div>
          )}

          <button
            onClick={isWrongChain ? () => switchChain({ chainId: ARC_CHAIN_ID }) : handleApprove}
            disabled={isWorking || step === 'done'}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
          >
            {isWorking && <Loader2 size={14} className="animate-spin" />}
            {isWrongChain ? 'Switch to Arc Mainnet' : isApprovePending ? 'Confirm in wallet…' : isConfirming ? 'Approving…' : step === 'done' ? 'Session active!' : `Approve ${selected} queries`}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

interface PaymentGateProps {
  dark: boolean
  pendingQuery: string
  onPaid: (query: string) => void
  onCancel: () => void
}

function PaymentGate({ dark, pendingQuery, onPaid, onCancel }: PaymentGateProps) {
  const { address, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [step, setStep] = useState<PayStep>('idle')
  const [subStep, setSubStep] = useState<PayStep>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  // Session: derive from localStorage on each render via a counter-bump trick
  const [sessionTick, setSessionTick] = useState(0)
  const sessionRef = useRef<SessionState | null>(address ? loadSession(address) : null)
  // re-read when address changes
  const addrRef = useRef(address)
  if (addrRef.current !== address) {
    addrRef.current = address
    sessionRef.current = address ? loadSession(address) : null
  }
  const session = sessionRef.current
  const setSession = (s: SessionState | null) => {
    sessionRef.current = s
    setSessionTick(t => t + 1)  // force re-render
  }
  void sessionTick  // consumed to satisfy linter unused-var

  const isWrongChain = chainId !== ARC_CHAIN_ID

  const hasActiveSession = session !== null && session.remaining > 0

  // Subscription fee read
  const { data: subFeeRaw } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'subscriptionFee',
    chainId: ARC_CHAIN_ID,
  })

  // USDC balance
  const { data: balance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address },
  })

  // Current allowance (skip when session is active — we already approved in bulk)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, QUERY_PAYMENT_ADDRESS] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address && !hasActiveSession },
  })

  const hasEnoughAllowance = hasActiveSession || (allowance !== undefined && allowance >= QUERY_FEE_RAW)
  const hasEnoughBalance = balance !== undefined && balance >= QUERY_FEE_RAW

  // Approve tx (single-query fallback path)
  const { writeContract: approve, data: approveTxHash, isPending: isApprovePending } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash })

  // Pay tx
  const { writeContract: pay, data: payTxHash, isPending: isPayPending } = useWriteContract()
  const { isLoading: isPayConfirming, isSuccess: isPaySuccess } = useWaitForTransactionReceipt({ hash: payTxHash })

  // Subscribe tx
  const { writeContract: approveSub, data: approveSubHash, isPending: isApproveSubPending } = useWriteContract()
  const { isLoading: isApproveSubConfirming, isSuccess: isApproveSubSuccess } = useWaitForTransactionReceipt({ hash: approveSubHash })
  const { writeContract: subscribeTx, data: subTxHash, isPending: isSubPending } = useWriteContract()
  const { isLoading: isSubConfirming, isSuccess: isSubSuccess } = useWaitForTransactionReceipt({ hash: subTxHash })

  // Approve confirmation (single-query path)
  const approveHandled = useRef(false)
  useLayoutEffect(() => {
    if (isApproveSuccess && !approveHandled.current) {
      approveHandled.current = true
      queueMicrotask(() => { void refetchAllowance().then(() => setStep('approved')) })
    }
  })

  // Payment confirmation — decrement session counter
  const payHandled = useRef(false)
  useLayoutEffect(() => {
    if (isPaySuccess && !payHandled.current) {
      payHandled.current = true
      queueMicrotask(() => {
        if (address && session) {
          const updated: SessionState = { ...session, remaining: Math.max(0, session.remaining - 1) }
          saveSession(address, updated)
          setSession(updated)
        }
        toast.success('Payment confirmed — unlocking answer')
        setTimeout(() => { setStep('done'); onPaid(pendingQuery) }, 400)
      })
    }
  })

  const handleApprove = () => {
    if (isWrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    setStep('approving')
    setErrorMsg('')
    try {
      approve({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [QUERY_PAYMENT_ADDRESS, QUERY_FEE_RAW],
        chainId: ARC_CHAIN_ID,
      })
    } catch (e: unknown) {
      setStep('error')
      setErrorMsg(e instanceof Error ? e.message : 'Approve failed')
    }
  }

  const handlePay = () => {
    if (isWrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    setStep('paying')
    setErrorMsg('')
    try {
      pay({
        address: QUERY_PAYMENT_ADDRESS,
        abi: QUERY_PAYMENT_ABI,
        functionName: 'payForQuery',
        chainId: ARC_CHAIN_ID,
      })
    } catch (e: unknown) {
      setStep('error')
      setErrorMsg(e instanceof Error ? e.message : 'Payment failed')
    }
  }

  const balanceFmt = balance !== undefined
    ? Amount.fromRaw(balance, usdcDecimalsFor(ARC_CHAIN_ID)).toFixed(2)
    : '…'

  const isWorking = step === 'approving' || isApprovePending || isApproveConfirming ||
                    step === 'paying' || isPayPending || isPayConfirming

  // Subscribe flow
  const [subApproveTriggered, setSubApproveTriggered] = useState(false)
  const [subSuccessTriggered, setSubSuccessTriggered] = useState(false)
  if (isApproveSubSuccess && !subApproveTriggered) {
    setSubApproveTriggered(true)
    setSubStep('paying')
    subscribeTx({
      address: QUERY_PAYMENT_ADDRESS,
      abi: QUERY_PAYMENT_ABI,
      functionName: 'subscribe',
      chainId: ARC_CHAIN_ID,
    })
  }
  if (isSubSuccess && !subSuccessTriggered) {
    setSubSuccessTriggered(true)
    toast.success('Subscription activated — unlimited questions for 30 days!')
    setTimeout(() => { setSubStep('done'); onPaid(pendingQuery) }, 400)
  }

  const isSubWorking = subStep === 'approving' || isApproveSubPending || isApproveSubConfirming ||
                       subStep === 'paying' || isSubPending || isSubConfirming

  const handleSubscribe = () => {
    if (isWrongChain) { switchChain({ chainId: ARC_CHAIN_ID }); return }
    if (!subFeeRaw) return
    setSubStep('approving')
    approveSub({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'approve',
      args: [QUERY_PAYMENT_ADDRESS, subFeeRaw],
      chainId: ARC_CHAIN_ID,
    })
  }

  const subFmtLabel = subFeeRaw ? `$${(Number(subFeeRaw) / 1e6).toFixed(2)}/mo` : '…'

  const ctaLabel = () => {
    if (isWrongChain) return 'Switch to Arc Mainnet'
    if (step === 'approving' || isApprovePending) return 'Confirm in wallet…'
    if (isApproveConfirming) return 'Approving…'
    if (step === 'paying' || isPayPending) return 'Confirm in wallet…'
    if (isPayConfirming) return 'Paying…'
    if (hasEnoughAllowance || step === 'approved') return hasActiveSession ? `Pay $0.01 USDC (${session.remaining} left)` : 'Pay $0.01 USDC'
    return 'Approve $0.01 USDC'
  }

  const ctaAction = isWrongChain
    ? () => switchChain({ chainId: ARC_CHAIN_ID })
    : (hasEnoughAllowance || step === 'approved') ? handlePay : handleApprove

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="mx-2 mb-3 rounded-2xl overflow-hidden border"
      style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
    >
      {/* Header strip */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}>
        <DollarSign size={14} style={{ color: 'var(--muted)' }} />
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--muted)', letterSpacing: '0.08em' }}>
          Pay to unlock answer
        </span>
        {hasActiveSession && (
          <span className="ml-1 px-1.5 py-0.5 rounded text-xs font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}>
            Session active
          </span>
        )}
        <button onClick={onCancel} className="ml-auto" style={{ color: 'var(--subtle)' }} aria-label="Cancel">
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Session key status */}
        {hasActiveSession && (
          <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(16,185,129,0.08)' }}>
            <KeyRound size={13} className="flex-shrink-0" style={{ color: '#10b981' }} />
            <span className="text-xs" style={{ color: '#10b981' }}>
              Session key active — {session.remaining} quer{session.remaining === 1 ? 'y' : 'ies'} pre-approved, no wallet pop-up needed
            </span>
          </div>
        )}

        {/* Question preview */}
        <div className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'var(--surface-muted)', color: 'var(--ink-2)' }}>
          <span className="text-xs font-medium block mb-1" style={{ color: 'var(--muted)' }}>Your question</span>
          <span className="line-clamp-2">{pendingQuery}</span>
        </div>

        {/* Fee row */}
        <div className="flex items-center justify-between text-sm">
          <span style={{ color: 'var(--muted)' }}>Query fee</span>
          <span className="font-semibold tabular-nums display" style={{ color: 'var(--ink)' }}>$0.01 USDC</span>
        </div>

        {address && (
          <div className="flex items-center justify-between text-xs" style={{ color: 'var(--subtle)' }}>
            <span>Your balance</span>
            <span className="tabular-nums">{balanceFmt} USDC</span>
          </div>
        )}

        {/* Step indicator — only show when no session and no allowance */}
        {!hasEnoughAllowance && step !== 'approved' && !hasActiveSession && (
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--subtle)' }}>
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1.5px solid var(--border)' }}>1</span>
            <span>Approve USDC spend</span>
            <span className="mx-1">→</span>
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1.5px solid var(--border)' }}>2</span>
            <span>Pay &amp; unlock</span>
          </div>
        )}

        {/* Error */}
        {(step === 'error' || !hasEnoughBalance) && (
          <div className="flex items-center gap-2 text-xs rounded-lg px-3 py-2" style={{ background: 'rgba(186,43,76,0.08)', color: 'var(--danger)' }}>
            <AlertCircle size={12} />
            <span>{!hasEnoughBalance ? 'Insufficient USDC balance. Use the faucet to get test USDC.' : errorMsg || 'Transaction failed. Please try again.'}</span>
          </div>
        )}

        {/* CTA */}
        <button
          onClick={ctaAction}
          disabled={isWorking || (!hasEnoughBalance && !isWrongChain)}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
          style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
        >
          {isWorking && <Loader2 size={14} className="animate-spin" />}
          {ctaLabel()}
        </button>

        {payTxHash && (
          <a href={buildTxExplorerUrl(ARC_CHAIN_ID, payTxHash)} target="_blank" rel="noopener noreferrer" className="block text-center text-xs underline" style={{ color: 'var(--subtle)' }}>
            View on explorer
          </a>
        )}

        {/* Subscription option */}
        <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <p className="text-xs mb-2 text-center" style={{ color: 'var(--subtle)' }}>Or subscribe for unlimited questions</p>
          <button
            onClick={handleSubscribe}
            disabled={isSubWorking || isWorking}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all border disabled:opacity-40"
            style={{ borderColor: '#10b981', color: '#10b981', background: 'rgba(16,185,129,0.08)' }}
          >
            {isSubWorking && <Loader2 size={14} className="animate-spin" />}
            {isApproveSubPending || isApproveSubConfirming ? 'Approving…' : isSubPending || isSubConfirming ? 'Subscribing…' : `Subscribe ${subFmtLabel} — 30 days unlimited`}
          </button>
          {subTxHash && (
            <a href={buildTxExplorerUrl(ARC_CHAIN_ID, subTxHash)} target="_blank" rel="noopener noreferrer" className="block text-center text-xs underline mt-1" style={{ color: 'var(--subtle)' }}>
              View subscription tx
            </a>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// ── Types ──────────────────────────────────────────────────────────────────
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  bookmarked?: boolean
  aiPowered?: boolean
  streaming?: boolean
}

type Panel = 'chat' | 'topics' | 'bookmarks' | 'history' | 'glossary' | 'swap' | 'wallet' | 'owner' | 'agent' | 'portfolio'

interface GlossaryEntry {
  term: string
  definition: string
}

// ── Knowledge base ─────────────────────────────────────────────────────────
const CRYPTO_KNOWLEDGE: Record<string, string> = {
  bitcoin: `**Bitcoin (BTC)** is the first and largest cryptocurrency by market cap, created in 2009 by the pseudonymous Satoshi Nakamoto. It operates on a proof-of-work blockchain with a fixed supply of 21 million coins. Bitcoin is widely considered "digital gold" and a store of value. Its block time is ~10 minutes and halvings occur every ~4 years.\n\n**Key stats:**\n- Supply cap: 21 million BTC\n- Block time: ~10 minutes\n- Consensus: Proof-of-Work (SHA-256)\n- Halving: every 210,000 blocks (~4 years)`,

  ethereum: `**Ethereum (ETH)** is a programmable blockchain platform that introduced smart contracts and decentralized applications (dApps). It transitioned to proof-of-stake in 2022 (The Merge), dramatically reducing energy consumption. Ethereum supports ERC-20 tokens, ERC-721 NFTs, and hosts the majority of DeFi and NFT activity.\n\n**Key stats:**\n- Consensus: Proof-of-Stake (since Sep 2022)\n- Block time: ~12 seconds\n- Smart contract language: Solidity\n- EIP-1559: burns a portion of each transaction fee`,

  usdc: `**USDC** is a fully-backed USD stablecoin issued by Circle. Each USDC is redeemable 1:1 for US dollars and backed by cash and short-term US Treasuries. USDC is natively available on Ethereum, Base, Arbitrum, Polygon, Solana, Arc, and more. Circle publishes monthly attestation reports verifying reserves.\n\n**Key facts:**\n- Issuer: Circle\n- Backing: Cash + US Treasuries\n- Decimals: 6 (on EVM chains)\n- Bridging: CCTP (native burn/mint, no wrapped tokens)`,

  defi: `**DeFi (Decentralized Finance)** refers to financial services built on public blockchains — lending, borrowing, trading, and yield generation — without intermediaries.\n\n**Key protocols:**\n- **Uniswap** — largest DEX, automated market maker\n- **Aave** — overcollateralized lending\n- **Compound** — algorithmic money markets\n- **Curve** — stablecoin swaps with low slippage\n- **MakerDAO** — DAI stablecoin issuer\n\n**Risks:** Smart contract bugs, liquidity risk, oracle manipulation, rug pulls.`,

  // ── DEX topics ──────────────────────────────────────────────────────────────
  dex_overview: `A **DEX (Decentralized Exchange)** is a peer-to-peer trading platform that runs entirely on smart contracts, with no central operator holding custody of funds.\n\n**How it differs from a CEX:**\n- You connect your own wallet — no account or KYC required\n- Funds never leave your custody\n- Trading happens on-chain; the smart contract is the counterparty\n- Open 24/7 with no withdrawal limits\n\n**Trade-offs:**\n- Slower, more expensive than CEX (on Ethereum)\n- No fiat onramp\n- Responsible for your own key security\n- Front-running and MEV (Maximal Extractable Value) attacks are possible\n\n**Major DEXs by chain:**\n- **Ethereum/L2:** Uniswap, Curve, Balancer, Velodrome\n- **Solana:** Jupiter (aggregator), Raydium, Orca, Phoenix\n- **BNB Chain:** PancakeSwap\n- **Base:** Aerodrome, BaseSwap`,

  dex_amm: `**Automated Market Makers (AMMs)** are the core pricing engine behind most DEXs. Instead of an order book, they use a liquidity pool and a mathematical formula to price trades.\n\n**Constant product formula (x × y = k):**\n- Pool holds two assets (e.g. ETH and USDC)\n- As one side is bought, it becomes scarcer and more expensive\n- Price is always determined by the ratio of assets in the pool\n- Pioneered by Uniswap v1/v2\n\n**AMM variants:**\n- **Uniswap v3** — concentrated liquidity: LPs choose a price range; capital efficiency up to 4000x vs v2\n- **Uniswap v4** — hooks architecture; customisable pool logic\n- **Curve StableSwap** — optimised for like-kind assets (USDC/USDT); minimal slippage\n- **Balancer** — weighted pools with up to 8 assets and custom weights\n- **CLMM (Concentrated Liquidity MM)** — used by Raydium, Orca on Solana\n\n**MEV and AMMs:** Sandwiching, front-running, and arbitrage bots extract value from AMM pools. Slippage tolerance settings mitigate exposure.`,

  dex_aggregators: `**DEX aggregators** route your swap across multiple liquidity sources to find the best price, splitting orders when beneficial.\n\n**How they work:**\n1. Query liquidity across many DEXs simultaneously\n2. Run path-finding algorithms (split routes, multi-hop)\n3. Execute via a smart contract in one transaction\n\n**Major aggregators:**\n- **1inch** — largest EVM aggregator; Fusion mode uses resolvers for gasless swaps\n- **Paraswap** — focuses on large trades; Delta feature for gasless intent-based swaps\n- **CoW Protocol** — batch auction model; protects against MEV by matching orders off-chain\n- **Jupiter** — dominant Solana aggregator; routes through Raydium, Orca, Phoenix and more\n- **Odos** — multi-chain aggregator with multi-token input routing\n\n**Intent-based trading (emerging):** Users sign an intent (e.g. "sell 1 ETH for best USDC") and solvers compete to fill it. CoW, UniswapX, and 1inch Fusion use this model. Eliminates front-running because the order is filled off-chain then settled on-chain.`,

  dex_perps: `**Perpetual DEXs** (onchain perps) let traders open leveraged long or short positions directly from their wallet, without a centralised counterparty.\n\n**How they work:**\n- Use a virtual AMM (vAMM) or oracle-based pricing rather than a spot AMM\n- Funding rates balance longs vs shorts: if longs dominate, they pay shorts\n- No expiry date — positions can be held indefinitely\n- Liquidations are automated by smart contracts\n\n**Major protocols:**\n- **dYdX** — oldest onchain perps; moved from Ethereum L2 to its own Cosmos appchain; up to 20x leverage\n- **GMX** — Arbitrum and Avalanche; GLP liquidity pool acts as counterparty; zero price impact on entry\n- **Hyperliquid** — purpose-built L1 with an onchain order book; fastest onchain perp experience; HYPE token\n- **Synthetix Perps** — Optimism; powers many perp frontends (Kwenta, Polynomial)\n- **Jupiter Perps** — Solana; SOL/BTC/ETH perps using JLP liquidity pool\n\n**Risks:** Smart contract exploits, oracle manipulation, liquidation cascades.`,

  // ── CEX topics ──────────────────────────────────────────────────────────────
  // ── DEX deep-dive topics ────────────────────────────────────────────────────
  dex_uniswap: `**Uniswap — the dominant EVM DEX** has processed over $2 trillion in cumulative volume and sits at the centre of EVM-chain liquidity.\n\n**Version history:**\n- **v1 (2018)** — proof of concept; ETH-only pairs; constant product AMM\n- **v2 (2020)** — any ERC-20/ERC-20 pair; flash swaps; TWAP oracle; became the reference implementation\n- **v3 (2021)** — concentrated liquidity; LPs choose price ranges; capital efficiency up to 4000× vs v2; multiple fee tiers (0.01%, 0.05%, 0.3%, 1%)\n- **v4 (2024)** — "hooks" architecture: custom logic before/after swaps, LP actions, and donations. Enables limit orders, TWAMM, dynamic fees, MEV mitigation, all within Uniswap pools\n\n**UNI token:**\n- Governance token; UNI holders vote on fee switch, treasury, and protocol upgrades\n- Fee switch (ability to redirect a % of LP fees to UNI stakers) was a major governance debate\n\n**UniswapX (intent-based):**\n- Users sign an off-chain order ("intent"); off-chain fillers (resolvers) compete to fill it\n- Fillers can route through any liquidity source, including CEX; user gets best price\n- Gasless for the user (filler pays gas); cross-chain swaps possible\n- Eliminates front-running and sandwiching by bypassing the public mempool\n\n**Uniswap Wallet & Interface:** Uniswap Labs also ships a consumer wallet app (iOS/Android) and swap interface at app.uniswap.org — the most used DeFi frontend.`,

  dex_curve_balancer: `**Curve Finance and Balancer** — two specialised AMMs that dominate their niches.\n\n**Curve Finance:**\n- Designed for like-kind asset swaps (stablecoins, liquid staking derivatives)\n- Uses StableSwap invariant: near-zero slippage near the peg, falls back to constant product at extremes\n- Flagship pools: 3pool (USDC/USDT/DAI), stETH/ETH, FRAX/USDC\n- **CRV token + veTokenomics:** Lock CRV for 1–4 years → receive veCRV; veCRV holders boost pool rewards and vote on gauge weights (which pools receive CRV emissions)\n- **Curve Wars:** Protocols (Convex, Frax, Yearn) accumulated veCRV to direct emissions to their pools\n- **Convex Finance:** Aggregated $10B+ of CRV to vote and boost yields; cvxCRV lets you trade locked CRV positions\n- **Curve v2:** Added concentrated liquidity for volatile asset pairs (WBTC/ETH, LINK/ETH)\n- **crvUSD:** Curve's own stablecoin using a novel "LLAMMA" AMM as liquidation mechanism — continuously rebalances collateral as price moves\n\n**Balancer:**\n- Weighted pools: customise asset weights (e.g. 80/20 ETH/BAL) rather than 50/50\n- Up to 8 assets in a single pool\n- **Boosted pools:** idle LP capital deposited into Aave to earn extra yield\n- **veBAL tokenomics:** same ve model as Curve; BAL locked for veBAL; gauge voting\n- **CoW-Balancer integration:** Balancer pools used as liquidity sources for CoW Protocol batch auctions\n- Primary use: treasury diversification pools, 80/20 protocol-owned liquidity`,

  dex_solana: `**Solana DEX ecosystem** — high-throughput, sub-cent fees, and a distinct AMM architecture.\n\n**Why Solana DEXs differ:**\n- Solana's account model and Sealevel parallel execution change how AMMs are built\n- Concentrated Liquidity MM (CLMM) — Solana's dominant AMM type — lets LPs pick ranges like Uniswap v3\n- Ultra-low fees (<$0.001) make on-chain limit orders and HFT viable for the first time\n\n**Major DEXs:**\n- **Jupiter** — the dominant aggregator and the "Uniswap of Solana"; routes through Raydium, Orca, Phoenix, and more; also offers DCA (dollar-cost averaging) and limit order features; JUP airdrop was the largest in Solana history\n- **Raydium** — oldest major Solana AMM; CLMM and standard pools; RAY token; integrated OpenBook order book\n- **Orca** — user-friendly CLMM DEX; Whirlpools (CLMM pools); ORCA token; popular with retail users\n- **Phoenix** — fully onchain central limit order book (CLOB) on Solana; maker-taker model; zero fees for makers\n- **Drift Protocol** — perps and spot DEX; also offers vaults and insurance fund staking\n- **Zeta Markets** — options and perps on Solana\n\n**Pump.fun and token launches:** Solana's ultra-low fees make it the dominant chain for meme coin launches via bonding curve launchpads; Jupiter aggregates their liquidity post-graduation.\n\n**Solana DEX stats (2026):** ~50% of all DEX volume on non-EVM chains flows through Solana protocols; Raydium and Orca combined TVL rivals many EVM L2 DEXs.`,

  dex_liquidity_mining: `**Liquidity mining and DEX incentive programmes** — how protocols bootstrap and direct liquidity.\n\n**What is liquidity mining?**\nProtocols distribute their governance or reward tokens to LPs in exchange for providing liquidity. This temporarily inflates APYs to attract capital.\n\n**Classic liquidity mining (2020 model):**\n- Deposit ETH/USDC in Uniswap v2 → stake LP tokens in a farm contract → earn project tokens daily\n- Sustainable only if the project token holds value; most programs collapsed as tokens were farmed and dumped\n\n**veTokenomics model (Curve/Balancer style):**\n- Lock tokens for up to 4 years → receive "ve" (vote-escrow) tokens\n- veToken holders vote on which pools receive emissions\n- "Bribes" — protocols pay veToken holders to vote for their pool; creates a market for votes\n- Platforms: Votium (Curve bribes), Hidden Hand (Balancer/Aura/Frax bribes)\n\n**ve(3,3) model (Velodrome/Aerodrome style):**\n- Combines Olympus DAO's (3,3) game theory with Curve's veTokenomics\n- VELO/AERO emissions go to pools based on weekly veVELO votes\n- Traders pay fees; fees go to voters of that pool — aligning voters with productive pools\n- Velodrome on Optimism and Aerodrome on Base have both become their chain's dominant DEX using this model\n\n**Gauge voting:** The mechanism by which emission direction is decided. Projects continuously "bribe" gauge voters to direct emissions to their token's pool — this is the "Curve Wars", "Balancer Wars", and "Velodrome Wars" narrative.\n\n**Risks:** Emission-inflated APYs are unsustainable; token dumps from farmers; audit risk on farm contracts.`,

  dex_mev: `**MEV (Maximal Extractable Value)** is profit extracted by block producers and searchers by reordering, inserting, or censoring transactions within a block.\n\n**MEV on DEXs — the main attacks:**\n- **Sandwich attack:** Searcher spots a large pending DEX swap, inserts a buy before it and a sell after, profiting from the price movement the victim's trade caused\n- **Front-running:** Copying a profitable pending transaction (e.g. an arbitrage) and submitting it with higher gas\n- **Back-running / arbitrage:** After a large DEX trade moves price, bots trade on other DEXs to re-equalise prices and pocket the difference — this is actually beneficial for price efficiency\n- **Liquidation MEV:** Bots race to trigger protocol liquidations (Aave, Compound) for the liquidation bonus\n\n**MEV scale:** Flashbots estimated $1.3B+ in MEV extracted on Ethereum in 2023 alone; includes sandwich attacks, arbitrage, and liquidations.\n\n**MEV infrastructure:**\n- **MEV-Boost (Ethereum):** separates block building from block proposing; professional builders (Flashbots, BloXroute, Titan) build the most profitable blocks\n- **Flashbots Protect RPC:** users route txs through Flashbots to avoid the public mempool and prevent sandwiching\n- **Private mempools:** Wintermute, 1inch Fusion, CoW Protocol all route orders privately\n\n**User protections:**\n- Use a DEX aggregator with MEV protection (CoW Protocol, 1inch Fusion, UniswapX)\n- Set slippage tolerance to 0.5% or less\n- Use Flashbots Protect or MEV Blocker RPC endpoint\n- Avoid sending large swaps during high-congestion periods\n\n**Solana MEV:** Jito Labs built MEV infrastructure for Solana; Jito-Solana client dominates validator share; jitoSOL liquid staking token earns MEV rewards`,

  dex_onchain_orderbooks: `**Onchain order books** are the technical evolution beyond AMMs — matching buyers and sellers on-chain using a traditional limit order model.\n\n**Why order books on-chain are hard:**\n- Every order placement, cancellation, and fill costs gas — on Ethereum mainnet this is prohibitively expensive\n- Requires high throughput and low latency — a full order book cycle needs sub-100ms on the chain layer\n- Early attempts (EtherDelta, IDEX) were too slow and expensive\n\n**How they became viable:**\n- Solana (400ms blocks, ~$0.00025/tx) made fully onchain CLOB feasible\n- Application-specific chains (dYdX Cosmos appchain) process orders off-chain with onchain settlement\n- L2s with fast finality (StarkEx, Loopring) settled batch orders onchain affordably\n\n**Live onchain order books:**\n- **dYdX v4** — migrated from StarkEx L2 to its own Cosmos appchain; validator set runs the matching engine; perpetual futures only; up to 20x leverage\n- **Hyperliquid** — purpose-built L1 with a native onchain CLOB; 100,000 TPS; sub-second finality; most popular onchain perp platform in 2025–2026; HYPE token valued at $10B+\n- **Phoenix (Solana)** — fully onchain spot CLOB; zero maker fees; deterministic matching; used by market makers and HFT bots\n- **Serum / OpenBook (Solana)** — original Solana CLOB; OpenBook is the decentralised fork post-FTX collapse\n- **Vertex Protocol (Arbitrum)** — hybrid: off-chain sequencer for speed + on-chain settlement; spot + perps + money market in one\n\n**AMM vs Order Book:**\n| Factor | AMM | Order Book |\n|---|---|---|\n| Price discovery | Continuous, any amount | Discrete, limit orders |\n| Liquidity provision | Passive, anyone | Active, market makers |\n| Slippage | Always present | Zero at market if liquid |\n| MEV exposure | High (sandwich) | Low (private matching) |\n| Complexity | Low | High |`,

  cex_overview: `A **CEX (Centralized Exchange)** is a company-run trading platform that holds custody of user funds and matches orders using an internal order book.\n\n**How a CEX works:**\n- You deposit funds into the exchange's custodial wallets\n- Trading happens off-chain in the CEX's internal database (no gas, instant)\n- Withdrawals move funds on-chain to your wallet\n\n**Advantages over DEX:**\n- Higher liquidity and tighter spreads\n- Fiat on/off ramps (bank transfer, card)\n- Advanced order types (limit, stop-loss, OCO)\n- Margin and futures trading\n- Customer support\n\n**Risks:**\n- Custodial — "not your keys, not your coins"\n- Exchange insolvency or fraud (FTX collapsed in 2022 losing ~$8B in user funds)\n- Regulatory shutdowns and withdrawal freezes\n- KYC/AML requirements and data privacy\n\n**Major CEXs:** Coinbase, Binance, Kraken, OKX, Bybit, Bitget, KuCoin`,

  cex_platforms: `**Major CEX platforms compared** — each has different strengths, fees, and regulatory standing.\n\n**Coinbase**\n- Most regulated US exchange; publicly listed (NASDAQ: COIN)\n- Coinbase Advanced for pro traders; Coinbase Prime for institutions\n- Maker/taker fees from 0%/0.05% (high volume); higher on basic interface\n- Supports USDC natively (co-issuer with Circle)\n\n**Binance**\n- World's largest exchange by volume; BNB token gives fee discounts\n- Binance.US operates separately under US regulation\n- Futures, options, launchpad, copy trading, P2P\n- Spot maker fee: 0.1% (0.075% with BNB)\n\n**Kraken**\n- Founded 2011; strong security track record; never been hacked\n- Regulated in US, EU, UK, Australia; Kraken Pro for advanced trading\n- Staking, margin, futures, OTC desk\n\n**Bybit / OKX / Bitget**\n- Offshore exchanges; dominant in derivatives\n- Lower KYC tiers available; higher leverage options\n- Popular with professional and institutional traders\n\n**KuCoin**\n- Wide altcoin selection; "People's Exchange"\n- Lending, bot trading, P2P fiat markets`,

  // ── New broad crypto topics ─────────────────────────────────────────────────
  stablecoins: `**Stablecoins** are cryptocurrencies designed to maintain a stable value, usually pegged to the US dollar. They are the backbone of DeFi and crypto commerce.\n\n**Types:**\n- **Fiat-backed** (USDC, USDT, BUSD) — fully backed 1:1 by cash/Treasuries held by a company; most stable but centralised\n- **Crypto-backed** (DAI, LUSD) — overcollateralised with crypto assets; decentralised but capital-inefficient\n- **Algorithmic** (UST, AMPL) — use code and incentives to maintain peg; highly risky; UST lost its peg in May 2022 wiping out $40B\n- **Yield-bearing** (sUSDS, sUSDe, stUSDT) — stablecoins that automatically accrue yield from underlying reserves or DeFi strategies\n\n**Market share (2026):** USDT (~62%) > USDC (~25%) > DAI, USDe, and others.\n\n**Key differences — USDC vs USDT:**\n- USDC: US-regulated, fully attested, co-issued by Circle and Coinbase, natively multi-chain via CCTP\n- USDT: issued by Tether (offshore), largest supply, less transparent historically, dominant on CEXs`,

  // ── Stablecoin deep dives ──────────────────────────────────────────────────
  stable_usdc_deep: `**USDC — Deep Dive** is Circle's fully-reserved, regulated US dollar stablecoin and the gold standard for on-chain USD.\n\n**Reserves & attestation:**\n- 100% backed by cash and short-duration US Treasury bills held in segregated accounts\n- Monthly third-party attestation reports published by Deloitte/Grant Thornton\n- Reserves held at regulated US financial institutions; not commingled with Circle operating funds\n\n**Multi-chain architecture:**\n- Native on 15+ chains including Ethereum, Base, Arbitrum, Polygon, Solana, Arc, Avalanche, OP Mainnet, Noble (Cosmos)\n- Cross-chain movement via **CCTP** — burn on source, mint natively on destination; no wrapped tokens, no bridge risk\n\n**Regulatory standing:**\n- Circle holds money transmission licences across US states and a NY BitLicense\n- MiCA-compliant for EU operations (EMT licence)\n- USDC is the preferred stablecoin for institutional DeFi and payments\n\n**Use cases:**\n- DeFi collateral, lending, trading pairs\n- Cross-border payments and remittances\n- Agent and API micropayments (x402 protocol)\n- Corporate treasury management\n\n**Key differentiators vs USDT:** regulatory transparency, native burn-mint bridging, US-regulated issuer`,

  stable_usdt: `**USDT (Tether)** is the world's largest stablecoin by market cap (~$120B+ in 2026) and the dominant trading pair on centralised exchanges globally.\n\n**Backing:**\n- Tether claims 100%+ backing: ~80% US Treasury bills, ~10% repo agreements, remainder cash/other assets\n- Quarterly attestations by BDO Italia; not a full audit\n- Historically opaque; faced scepticism over whether full 1:1 backing existed prior to 2021\n\n**Market role:**\n- Pairs with nearly every token on every CEX; the default "cash" layer in crypto\n- Dominant on Tron network (extremely cheap USDT transfers, popular in emerging markets)\n- Also on Ethereum, BSC, Solana, TON, and 12+ other chains\n\n**Key risks:**\n- Tether Limited is incorporated in the British Virgin Islands; offshore and less regulated than Circle\n- CFTC fined Tether $41M in 2021 for misrepresenting reserves\n- A Tether depeg would be the largest systemic risk in crypto\n\n**USDT vs USDC at a glance:**\n| Factor | USDT | USDC |\n|---|---|---|\n| Issuer | Tether (BVI) | Circle (US) |\n| Audit | Quarterly attestation | Monthly attestation |\n| Regulation | Minimal | US + MiCA |\n| Supply | ~$120B | ~$55B |\n| Bridge | 3rd-party | CCTP (native) |`,

  stable_dai_sky: `**DAI / USDS — MakerDAO / Sky Protocol** is the oldest and most battle-tested decentralised stablecoin.\n\n**History:**\n- DAI launched 2017; originally backed only by ETH (single-collateral DAI)\n- Multi-collateral DAI (MCD) launched 2019; supports ETH, WBTC, stETH, RWAs, USDC\n- 2024: MakerDAO rebranded to **Sky Protocol**; DAI became **USDS**, MKR became **SKY**\n\n**How it works:**\n- Users open a "vault" (formerly CDP) and lock collateral\n- Mint DAI/USDS up to a collateralisation ratio (e.g. 150% minimum for ETH)\n- Pay a stability fee (interest) to maintain the position\n- Below the liquidation ratio: keepers liquidate the vault at a penalty\n\n**Peg mechanism:**\n- **PSM (Peg Stability Module)** — swap USDC 1:1 for DAI with no slippage; keeps DAI tightly pegged\n- **Surplus buffer** — protocol surplus absorbs bad debt before MKR/SKY dilution\n\n**USDS yield:** Sky's official savings rate (SSR) automatically accrues yield to USDS holders\n\n**Risks:** heavy USDC exposure through PSM (centralisation risk), smart contract risk, governance attacks`,

  stable_algo: `**Algorithmic stablecoins** attempt to maintain a peg purely through code and incentives rather than collateral — a category with a catastrophic failure rate.\n\n**The UST/LUNA collapse (May 2022):**\n- TerraUSD (UST) used LUNA as a counterpart: mint $1 of UST by burning $1 of LUNA\n- At peak: UST had $18B market cap; LUNA had $40B\n- A coordinated de-peg attack drained liquidity from the Curve 3pool\n- As UST lost its peg, LUNA was hyper-inflated to absorb redemptions — supply went from 350M to 6.5T in days\n- ~$60B in combined market cap erased in 72 hours; cascaded into Three Arrows Capital, Celsius, BlockFi bankruptcies\n\n**Pure algo designs and their failures:**\n- **Basis Cash, Empty Set Dollar, Frax v1** — all failed to sustain the peg under sell pressure\n- **AMPL / RAI** — "rebasing" and "reflexer" designs; technically survived but never achieved mass adoption\n\n**Partially collateralised approaches:**\n- **Frax v2+** — moved to over-collateralised model backed by USDC + ETH; added frxETH liquid staking\n- **USDe (Ethena)** — delta-neutral: mint USDe by depositing ETH, hedge with short ETH perpetuals; yields from funding rates; NOT algorithmic but novel\n\n**Lesson:** algorithmic stablecoins without hard collateral are inherently fragile under adversarial conditions.`,

  stable_yield: `**Yield-bearing stablecoins** are stablecoins that automatically accrue interest for holders, removing the need to manually deposit into a protocol.\n\n**How they work:**\n- User deposits base stablecoin (USDC, DAI) → receives a yield-bearing wrapper\n- Underlying capital is deployed to a yield source (T-bills, DeFi, funding rates)\n- Holder's balance grows over time (rebasing) or the token appreciates vs the base (like stETH vs ETH)\n\n**Major yield-bearing stablecoins:**\n- **sUSDS** (Sky/MakerDAO) — USDS earning the Sky Savings Rate; backed by T-bills and USDC PSM\n- **sUSDe** (Ethena) — earns ETH perpetual funding rates; higher yield but carries funding rate risk (can go negative)\n- **OUSD** (Origin Protocol) — auto-compounds Aave/Compound/Curve yield\n- **stUSDT** — Tether's yield-bearing product on Tron and ETH\n- **aUSDC** (Aave) — interest-bearing USDC from Aave supply; most liquid DeFi yield stablecoin\n- **USYC, BUIDL, ONDO** — tokenised US Treasury yield products targeting institutions\n\n**Risks:**\n- Smart contract risk on the yield strategy\n- Funding rates can go negative (USDe holders would receive lower or negative yield)\n- Regulatory uncertainty: yield-bearing stablecoins may be classified as securities in some jurisdictions`,

  stable_regulation: `**Stablecoin regulation** is among the most actively legislated areas of crypto globally.\n\n**United States:**\n- No federal stablecoin law as of mid-2026; multiple bills debated\n- **GENIUS Act** (proposed) — would require 1:1 reserve backing, monthly audits, and federal or state licensing for stablecoin issuers\n- USDC already complies with most proposed requirements; Tether may need restructuring\n- State-level: NY BitLicense covers USDC; many states have money transmitter laws\n\n**European Union — MiCA:**\n- **EMT (E-Money Token)** category covers fiat-referenced stablecoins\n- Requires 1:1 backing, redemption at par, EU-licensed issuer\n- USDC received EMT licence via Circle Ireland; Tether obtained a licence but faced scrutiny\n- "Significant" EMTs (>€5B daily transaction volume) face additional requirements\n\n**Other jurisdictions:**\n- **UAE (VARA):** AED-pegged stablecoin frameworks; AE Coin\n- **Singapore (MAS):** Single-currency stablecoins (SCS) regulatory framework, 2024\n- **Japan (FSA):** Only registered banks/trust companies can issue yen-pegged stablecoins\n- **Hong Kong (HKMA):** Stablecoin licensing regime consultation 2024\n\n**Implication for USDC:** Circle's proactive regulatory strategy positions USDC as the compliant-by-default stablecoin for institutional and global use.`,

  stable_payments: `**Stablecoins as a payment rail** are increasingly displacing traditional wire transfers, SWIFT, and remittance networks for speed and cost.\n\n**Why stablecoins win in payments:**\n- **Settlement speed:** seconds vs 1–5 business days for SWIFT\n- **Cost:** cents vs $25–50 per international wire; <1% vs 5–7% for remittances\n- **Availability:** 24/7/365 with no banking hours or holiday delays\n- **Programmability:** smart contracts can hold, release, split, and route funds automatically\n\n**Key corridors:**\n- USD → LatAm, Africa, SEA: USDT on Tron is dominant for low-fee retail transfers\n- Business-to-business cross-border: USDC on Base/Arbitrum via CCTP\n- Freelancer payments: direct wallet-to-wallet USDC avoids PayPal/Wise fees\n- AI agent micropayments: x402 protocol enables per-request USDC payments\n\n**Adoption:**\n- Stripe reintegrated USDC payments (2024) after years away\n- PayPal launched PYUSD stablecoin\n- Visa and Mastercard settle some transactions in USDC on Ethereum/Solana\n- Several central banks pilot stablecoin corridors as alternatives to slow CBDCs\n\n**Limitations:** regulatory compliance (KYC/AML), wallet UX for non-crypto users, tax reporting complexity`,

  stable_frax_ethena: `**Frax and Ethena — next-gen stablecoin designs** bridging the gap between pure collateral and pure algorithm.\n\n**Frax Protocol:**\n- Founded 2020 by Sam Kazemian; pioneered the fractional-algorithmic model (originally partially backed by USDC + FXS)\n- **Frax v3 (2024):** fully over-collateralised; backed by RWAs (T-bills via FinresPBC), ETH, frxETH, and USDC\n- **frxETH / sfrxETH** — Frax liquid staking token; sfrxETH earns all ETH staking yield, making it one of the highest-yield liquid staking options\n- **FRAX the stablecoin:** pegged to $1; collateral ratio now >100%; earned the "crypto-native stablecoin with real-world backing" positioning\n- **FXS → FRAX token** — governance + value accrual; stakers receive protocol revenue\n- **Fraxlend / Fraxswap** — native lending market and AMM within the Frax ecosystem\n- Key risk: governance centralisation; Kazemian holds significant influence\n\n**Ethena (USDe):**\n- Founded 2023; launched publicly 2024; grew to $3B+ supply within months\n- **The delta-neutral design:** user deposits ETH/stETH → Ethena opens equal short ETH-PERP on a CEX → net exposure is zero regardless of ETH price\n- **USDe peg:** maintained because $1 of collateral always backs $1 of USDe regardless of ETH movement\n- **sUSDe yield:** derives from perpetual funding rates (paid by longs to shorts); historically 15–30% APY; goes to 0 or negative during bear markets\n- **Risks:** funding rate risk (yield disappears or inverts), CEX custodial risk (Copper, Ceffu, Cobo custody), peg stress under extreme short-squeeze\n- **ENA token** — governance + staking\n- **2025–2026:** USDe expanded to Bitcoin-backed positions; iUSDe for institutional access; Ethena became the 3rd largest stablecoin protocol`,

  stable_pyusd_others: `**PYUSD, FDUSD, and emerging stablecoins** — the next wave of fiat-backed entrants.\n\n**PYUSD (PayPal USD):**\n- Issued by Paxos Trust Company on behalf of PayPal; launched August 2023\n- Initially on Ethereum; expanded to Solana (2024) for low fees and instant finality\n- Target: PayPal's 430M+ user base — first fiat stablecoin backed by a mainstream consumer fintech\n- Backed 100% by USD deposits, short-term US Treasuries, and equivalent assets\n- Monthly attestation by BDO; Paxos publishes reserve breakdown\n- Used for PayPal checkout, P2P payments within the app, and crypto transfers\n- Challenge: adoption outside the PayPal ecosystem has been limited vs USDC\n\n**FDUSD (First Digital USD):**\n- Issued by First Digital Labs (Hong Kong); launched 2023\n- Rose to $4B+ supply rapidly — heavily used on Binance as a BUSD replacement after Binance was ordered to delist BUSD\n- Backed by US Treasuries and cash; BDO attestations\n- Primarily a Binance ecosystem stablecoin; also on ETH/BNB Chain/Tron\n\n**GHO (Aave):**\n- DeFi-native stablecoin minted against Aave collateral\n- Borrowers receive GHO instead of USDC; pay a fixed borrow rate\n- stkAAVE holders get a discount; protocol earns the borrow rate as revenue\n- Designed to generate yield for Aave DAO without selling tokens\n\n**LUSD / BOLD (Liquity):**\n- LUSD: immutable, governance-free stablecoin; only ETH collateral; 110% minimum CR\n- BOLD (Liquity v2): multi-collateral (ETH, LSTs); user-set interest rates; earns yield via Stability Pool\n\n**Stablecoin landscape 2026:** the market is consolidating around 4–5 dominant stablecoins while niche designs capture specific use cases (DeFi-native, high-yield, privacy).`,

  stable_multichain: `**Multi-chain stablecoin landscape** — where each stablecoin lives and how it moves.\n\n**Native issuance vs bridged:**\n- **Native:** the issuer mints directly on each chain (USDC via CCTP, USDT via Tether directly)\n- **Bridged:** third-party bridge locks on chain A and mints a wrapped version on chain B — carries bridge risk\n- Prefer native where possible; bridged stablecoins have been the source of $2B+ in bridge exploits\n\n**Chain-by-chain overview:**\n| Chain | Dominant stable | Notes |\n|---|---|---|\n| Ethereum | USDC, USDT, DAI/USDS | Most DeFi TVL; highest gas |\n| Base | USDC | Coinbase-native; CCTP; fast growth |\n| Arbitrum | USDC, USDT | Largest DeFi L2; low fees |\n| Optimism/Superchain | USDC | RetroPGF funded; OP stack |\n| Polygon | USDC, USDT | Used by enterprises (Stripe, Visa) |\n| Solana | USDC, USDT | Sub-cent fees; fast; major DeFi |\n| Tron | USDT | Largest USDT supply by chain; cheap |\n| BNB Chain | FDUSD, USDT, USDC | Binance ecosystem |\n| Arc | USDC | Native gas token; agent payments |\n| TON | USDT | Telegram integration; 900M users |\n| Avalanche | USDC, USDT | Subnets; institutional |\n\n**CCTP (Cross-Chain Transfer Protocol):**\n- Circle's native bridge for USDC; burn on source chain, mint on destination\n- Zero wrapped token risk; supported on 10+ chains in 2026\n- Used by Coinbase, Across, Celer, and many others as their USDC bridge\n\n**Liquidity fragmentation:**\n- Same stablecoin can trade at slight discounts across chains due to liquidity depth differences\n- Aggregators (Li.Fi, Socket) route through the most efficient bridge/swap path`,

  stable_yield_strategies: `**Stablecoin yield strategies** — how to earn on USD-denominated assets without price risk.\n\n**Yield source taxonomy:**\n- **Lending yield** — supplying to Aave, Compound, Morpho, Kamino; rate follows utilisation\n- **LP yield** — providing liquidity to Curve, Uniswap stable pools; earns trading fees ± impermanent loss (minimal for stable/stable pairs)\n- **RWA yield** — tokenised T-bills (BUIDL, OUSG, USYC); currently 4–5% US risk-free rate\n- **Funding rate yield** — sUSDe, basis trade on CEX; 10–25% but variable; goes negative in bear markets\n- **Money market funds** — BUIDL (BlackRock), BENJI (Franklin); permissioned; for qualified buyers\n\n**Risk tiers:**\n- **Tier 1 (lowest risk):** RWA T-bill tokens on regulated platforms; smart contract risk only\n- **Tier 2:** aUSDC on Aave; sUSDS; established lending markets with audited code\n- **Tier 3:** Curve/Convex LP; reasonable IL risk; CRV/CVX emission rewards\n- **Tier 4:** sUSDe (Ethena); higher yield but funding rate can flip negative\n- **Tier 5:** DeFi yield aggregators (Yearn, Beefy); stack multiple protocols; compounding smart contract risk\n\n**Yield comparison (mid-2026 approximate):**\n- RWA T-bills: 4.5–5.2%\n- Aave USDC supply: 3–8% (utilisation-dependent)\n- sUSDS: 5–6%\n- sUSDe: 8–18% (funding-rate dependent)\n- Curve 3pool: 2–5% + CRV/CVX rewards\n- Yearn USDC vault: 5–12% (auto-optimised)\n\n**Tax note:** stablecoin yield is typically taxed as ordinary income in most jurisdictions — not as capital gains.`,

  stable_enterprise: `**Enterprise and B2B stablecoin adoption** — how corporations, fintechs, and banks are using stablecoins.\n\n**Payment infrastructure:**\n- **Stripe:** Reintegrated stablecoin payments (2024); processes USDC on Base and Polygon for merchants globally; acquired Bridge (stablecoin API company) for $1.1B\n- **PayPal / Braintree:** PYUSD in PayPal checkout; USDC support in Braintree developer APIs\n- **Visa:** Settles select acquiring relationships in USDC on Ethereum and Solana\n- **Mastercard:** Multi-token network (MTN); stablecoin settlement pilots in 2024–2025\n- **Shopify:** Stablecoin payment plugins via Coinbase Commerce and third parties\n\n**Banking and TradFi:**\n- **JPMorgan Onyx:** JPM Coin for intraday repo settlement between institutional clients (~$2B/day); expanding to USDC\n- **Citi Treasury & Trade Solutions:** tokenised trade finance; USDC-based margin calls\n- **ANZ, Standard Chartered, BBVA:** pilot stablecoin cross-border settlements for SMB exporters\n- **BNY Mellon:** custodies BUIDL reserves; exploring stablecoin custody for institutional clients\n\n**Remittances and FX:**\n- **MoneyGram:** integration with Stellar (USDC); recipients can cash out in local currency at MoneyGram kiosks\n- **Bitso (Mexico/LatAm):** processes >$10B/year in USDC corridor transfers\n- **Yellow Card (Africa):** USDC-based last-mile payouts across 20+ African countries\n\n**Treasury management:**\n- Public companies holding USDC on-chain as working capital (e.g. GameFi studios, Circle partners)\n- Yield-bearing stablecoins (OUSG, BUIDL) as alternatives to money market funds\n- Multi-sig treasury wallets (Safe) managed by finance teams\n\n**The B2B pitch:** faster settlement, 24/7 access, programmable compliance, lower fees on corridors that SWIFT handles poorly (EM-to-EM, micro-SMB).`,

  stable_risks: `**Stablecoin risk management** — understanding and mitigating the unique risks of each stablecoin type.\n\n**Risk taxonomy:**\n\n**1. Counterparty / issuer risk:**\n- Fiat-backed stablecoins depend entirely on the issuer's solvency and reserve integrity\n- USDC (SVB 2023): 8% reserves at a failed bank → $0.87 depeg for 36 hours\n- USDT: historical opacity; CFTC fine; offshore issuer; "too big to fail" dynamics\n- Mitigation: prefer regulated issuers with monthly attestations; diversify\n\n**2. Smart contract risk:**\n- DeFi stablecoins (DAI, LUSD, GHO) carry smart contract exploit risk\n- A bug in the Maker vault system could allow undercollateralised DAI minting\n- Mitigation: stick to audited, battle-tested protocols; check Immunefi bug bounty coverage\n\n**3. Collateral / de-peg risk:**\n- Crypto-backed stablecoins (DAI/USDS) can fail if collateral drops faster than liquidations can process\n- Black Thursday (March 2020): ETH -50% in hours; Maker liquidation auction bug; $8M bad debt\n- Mitigation: monitor collateral ratios; diversified collateral basket\n\n**4. Algorithmic / mechanism risk:**\n- Terra/LUNA: reflexive death spiral from dual-token design\n- Any system relying on market confidence to maintain peg is vulnerable to bank-run dynamics\n- Mitigation: avoid high-yield algostables; if yield seems too good to be true, it is\n\n**5. Regulatory risk:**\n- BUSD: Paxos ordered to stop minting in Feb 2023; supply has since declined from $16B to near-zero\n- Tornado Cash sanctions show protocols can be targeted even without KYC\n- Mitigation: use regulated issuers; monitor OFAC SDN list; avoid privacy-mixed stablecoins for large amounts\n\n**6. Concentration risk:**\n- Holding a single stablecoin in a single protocol\n- Mitigation: split across USDC + USDT + USDS; spread across Aave/Compound/Morpho\n\n**Stablecoin safety checklist:**\n- Is the issuer regulated and audited?\n- Where are reserves held? Are they segregated?\n- How quickly can you redeem 1:1?\n- What is the de-peg history?\n- Is the smart contract audited and bug-bounty covered?`,

  stable_cbdc_comparison: `**Stablecoins vs CBDCs** — comparing private stablecoins to government-issued digital currencies.\n\n**What are CBDCs?**\nCentral Bank Digital Currencies are digital money issued directly by a central bank — legal tender, programmable, but controlled by governments.\n\n**Key CBDC projects (2026):**\n- **e-CNY (China)** — most advanced; 260M+ wallets; used for transport, retail; programmable expiry dates on money; offline NFC payments\n- **Digital Euro** — ECB moved to preparation phase 2023; pilot with banks; privacy-preserving design but not blockchain-based\n- **FedNow (US)** — not a CBDC but a real-time payment rail; CBDC still politically divisive in US\n- **Drex (Brazil)** — wholesale CBDC on a permissioned blockchain; DeFi-like programmable settlement for financial institutions\n- **mBridge** — multi-CBDC corridor between China, UAE, Thailand, HK for cross-border settlement\n\n**Stablecoins vs CBDCs:**\n| Factor | Stablecoin (USDC) | CBDC (e-CNY) |\n|---|---|---|\n| Issuer | Private company | Central bank |\n| Programmability | Full DeFi composability | Government-controlled |\n| Privacy | Pseudonymous | Government-visible |\n| Censorship resistance | Moderate | None |\n| Interoperability | Open protocols (CCTP) | Permissioned corridors |\n| Yield | Yes (sUSDC, etc.) | Rarely |\n| Adoption | Global, permissionless | Jurisdiction-specific |\n\n**The political dimension:** CBDCs raise significant civil liberties concerns — programmable money can be frozen, have expiry dates, or restrict purchases. Stablecoins, while regulated, preserve more financial autonomy.`,

  stable_depegs: `**Historical stablecoin de-pegs** — understanding what breaks a peg is essential for risk management.\n\n**Major de-peg events:**\n\n**UST/LUNA (May 2022)** — the largest stablecoin collapse\n- Algorithmic design with no hard collateral\n- Coordinated attack drained Curve 3pool, triggering bank-run dynamics\n- UST hit $0.006; LUNA hyperinflated to near-zero\n- Contagion: Three Arrows Capital, Celsius, BlockFi, Voyager all collapsed within weeks\n\n**USDC (March 2023)** — temporary de-peg from banking crisis\n- Silicon Valley Bank (SVB) held ~$3.3B of USDC reserves (8% of total)\n- SVB failed on March 10; USDC briefly traded at $0.87 on Coinbase\n- Circle confirmed full access to reserves after Fed backstop; peg restored Monday\n- DAI also de-pegged briefly due to its heavy USDC PSM exposure\n\n**USDT mini de-pegs** — occurred during FTX collapse (Nov 2022) and multiple 2019 events; USDT touched $0.96–$0.98 but recovered\n\n**Smaller events:**\n- FRAX, LUSD, sUSD — brief deviations under high redemption pressure\n- Iron Finance (TITAN) — partial collateral algo design; collapsed in hours (June 2021)\n\n**Key lesson:** Even "safe" stablecoins have systemic dependencies. Diversify stablecoin exposure and understand each peg mechanism before committing large capital.`,

  // ── DeFi deep dives ────────────────────────────────────────────────────────
  defi_overview_deep: `**DeFi (Decentralized Finance) — deep dive** is a global, permissionless financial system running 24/7 on public blockchains with ~$120B+ in Total Value Locked (TVL) as of 2026.\n\n**The DeFi stack:**\n- **Layer 1/2 base** — Ethereum, Arbitrum, Base, Solana (settlement + security)\n- **Stablecoins** — USDC, USDT, DAI (the unit of account)\n- **Oracles** — Chainlink, Pyth (price feeds for liquidations and derivatives)\n- **DEXs** — Uniswap, Curve, Balancer (price discovery + token exchange)\n- **Lending** — Aave, Compound, Morpho (capital efficiency)\n- **Derivatives** — GMX, dYdX, Synthetix (hedging + leverage)\n- **Yield** — Yearn, Convex, Pendle (yield optimisation)\n\n**TVL leaders (2026):** Lido (~$30B), Aave (~$20B), Uniswap (~$8B), Ethena (~$6B), Morpho (~$4B)\n\n**DeFi vs TradFi:**\n| Factor | DeFi | TradFi |\n|---|---|---|\n| Hours | 24/7/365 | Business hours |\n| Access | Anyone with a wallet | KYC + geography gated |\n| Custody | Self-custody | Bank holds funds |\n| Transparency | Fully on-chain | Opaque |\n| Speed | Seconds | Days (settlement) |\n| Risk | Smart contracts, liquidation | Counterparty, regulatory |`,

  defi_liquidity: `**Liquidity provision in DeFi** means depositing assets into a protocol to enable trading, lending, or stability — and earning fees or rewards in return.\n\n**DEX liquidity provision (AMMs):**\n- Deposit a token pair (e.g. ETH + USDC) into a Uniswap pool\n- Earn a % of every swap that uses your liquidity (typically 0.01–0.3%)\n- Receive an LP token representing your share of the pool\n- Risks: impermanent loss (price divergence), smart contract bugs\n\n**Concentrated liquidity (Uniswap v3+):**\n- Set a custom price range for your capital (e.g. ETH between $2,000–$3,000)\n- Earn far more fees when price is in range; earn zero when outside\n- Requires active management or auto-compounding vaults (Arrakis, Gamma)\n\n**Stable pools:**\n- Curve Finance's StableSwap pools (USDC/USDT/DAI) generate fees with minimal IL\n- Popular for low-risk yield on stablecoins\n\n**Lending liquidity:**\n- Supply USDC to Aave: earn variable APY (~3–8%)\n- Supply ETH: earn interest when borrowed by leveraged traders\n\n**Liquidity mining:**\n- Protocols distribute their governance tokens as extra rewards to liquidity providers\n- Often boosts short-term APY but inflates token supply — evaluate sustainability`,

  defi_yield_strategies: `**DeFi yield strategies** range from basic stablecoin deposits to complex multi-protocol loops. Risk scales with complexity.\n\n**Conservative (3–8% APY):**\n- Supply USDC to Aave or Compound\n- Hold sUSDS or sUSDe (yield-bearing stablecoins)\n- Provide liquidity to Curve stable pools (USDC/USDT/DAI)\n\n**Moderate (8–20% APY):**\n- Curve + Convex: deposit Curve LP tokens into Convex to earn boosted CRV + CVX rewards\n- Pendle: split yield-bearing tokens into principal and yield components; buy discounted yield\n- Provide ETH/USDC liquidity on Uniswap v3 with active range management\n\n**Aggressive (20–100%+ APY, high risk):**\n- Recursive lending: supply ETH → borrow USDC → supply USDC → borrow more ETH; amplified yield AND liquidation risk\n- New protocol launches with high incentive emissions\n- Leveraged LP positions using DeFi margin protocols\n\n**Yield aggregators:**\n- **Yearn Finance** — automatically moves capital between strategies to maximise yield\n- **Convex Finance** — optimises Curve LP positions for boosted CRV rewards\n- **Beefy Finance** — multi-chain auto-compounder\n\n**Key risks at each tier:** liquidation (aggressive), smart contract exploit (all), governance attack, token inflation diluting rewards`,

  defi_money_markets: `**DeFi money markets** are the backbone of the DeFi lending ecosystem — algorithmic interest rate protocols where supply and demand determine rates in real time.\n\n**How interest rates work:**\n- Utilisation rate = borrowed / supplied\n- As utilisation rises, rates rise exponentially (to incentivise more supply and less borrowing)\n- "Kink" models have a sharp rate increase above ~80% utilisation\n\n**Protocol deep dives:**\n\n**Aave v3:**\n- Supports 30+ assets across 10+ chains\n- Isolation mode: new/risky assets have a debt ceiling\n- Efficiency mode (eMode): higher LTVs for correlated assets (e.g. stETH/ETH at 93% LTV)\n- Cross-chain portal: supply on Ethereum, borrow on Polygon\n- GHO stablecoin minted against Aave collateral\n\n**Compound v3 (Comet):**\n- Simplified single-base-asset model (borrow only USDC or ETH)\n- More gas-efficient than v2; COMP token rewards\n\n**Morpho:**\n- Peer-to-peer matching on top of Aave/Compound\n- When matched P2P: both borrower and supplier get better rates\n- Morpho Blue: permissionless vaults with custom risk parameters\n\n**Euler v2:**\n- Permissionless market creation\n- Transient storage for single-tx flash loans\n\n**Solana lending:** Kamino, MarginFi, Solend (now Save)`,

  defi_liquid_staking: `**Liquid staking** lets you stake ETH (or other PoS assets) and receive a liquid, yield-bearing token in return — without locking up capital for an indeterminate withdrawal queue.\n\n**How it works:**\n1. Deposit ETH into Lido/Rocket Pool\n2. Receive stETH/rETH (1:1 value + accruing staking rewards)\n3. Use stETH/rETH in DeFi while earning staking APY\n4. Redeem for ETH at any time (instant via DEX or via protocol withdrawal queue)\n\n**Major protocols:**\n- **Lido (stETH)** — largest; ~30% of all staked ETH; controlled by LDO governance\n- **Rocket Pool (rETH)** — more decentralised; node operators run mini-pools with 8 ETH minimum + RPL bond\n- **Frax (sfrxETH)** — highest yield via dual-token system (frxETH + sfrxETH)\n- **Coinbase (cbETH)** — custodial; used by institutions\n- **Binance (wBETH)** — similar custodial product\n\n**Solana liquid staking:** Marinade (mSOL), Jito (jitoSOL, includes MEV rewards), Blazestake\n\n**DeFi integration:** stETH is accepted as collateral on Aave, Spark, MakerDAO — creating a "stacked yield" loop\n\n**Risk:** Lido's market share (~30% of staked ETH) raises Ethereum decentralisation concerns; smart contract risk on liquid staking protocols`,

  defi_protocols_by_chain: `**DeFi ecosystems by chain** — each chain has a distinct set of native protocols and culture.\n\n**Ethereum mainnet:**\n- Uniswap v3/v4, Curve, Balancer (DEXs)\n- Aave v3, Compound v3, Morpho Blue (lending)\n- Lido, Rocket Pool (liquid staking)\n- Yearn, Convex, Pendle (yield)\n- MakerDAO/Sky, Ethena (stablecoins)\n\n**Base (Coinbase L2):**\n- Aerodrome — the dominant DEX; ve(3,3) tokenomics; highest volume Base DEX\n- Moonwell — main lending protocol on Base\n- Uniswap v3, Curve — also present\n\n**Arbitrum:**\n- GMX v2 — perpetual DEX, top TVL protocol on Arbitrum\n- Camelot — native DEX with launchpad\n- Radiant — cross-chain lending\n- Pendle — yield trading\n- Balancer — weighted pools\n\n**Optimism:**\n- Velodrome — dominant DEX, ve(3,3) model (Aerodrome's parent)\n- Synthetix — derivatives and perps backend\n- Exactly Protocol — fixed-rate lending\n\n**Solana:**\n- Jupiter — DEX aggregator + perps\n- Raydium, Orca — DEXs (CLMM)\n- Kamino, MarginFi — lending\n- Marinade, Jito — liquid staking\n\n**Polygon:**\n- Quickswap, DODO, Beefy — DeFi mainstays\n- Aave v3 on Polygon has multi-billion TVL`,

  defi_hacks: `**DeFi hacks and exploits** have resulted in over $8B in losses since 2020. Understanding common attack vectors is essential for safe DeFi participation.\n\n**Top exploits by value:**\n- **Ronin Bridge (2022)** — $625M; Lazarus Group compromised 5-of-9 validator keys; multi-sig with too few signers\n- **Poly Network (2021)** — $611M; cross-chain contract logic flaw; funds returned\n- **Wormhole (2022)** — $320M; signature verification bypass on Solana contract\n- **Nomad Bridge (2022)** — $190M; any address could drain funds after a config bug; "crowd hack"\n- **Euler Finance (2023)** — $197M; flash loan + liquidation logic flaw; funds returned after negotiation\n- **Mango Markets (2022)** — $116M; price oracle manipulation via the protocol's own governance token\n- **Cream Finance (2021)** — $130M; reentrancy and flash loan oracle attacks\n\n**Common attack categories:**\n- **Reentrancy** — contract calls external address before settling its own state (The DAO hack, 2016)\n- **Flash loan attacks** — borrow huge sums to manipulate prices, drain protocols, repay in one tx\n- **Oracle manipulation** — use low-liquidity pools as price oracles; manipulate via flash loan\n- **Access control flaws** — admin functions left unguarded or compromised private keys\n- **Bridge vulnerabilities** — cross-chain message verification is extremely hard to get right\n\n**Protection:** use protocols with multiple audits, time-locks, bug bounties, and insurance covers (Nexus Mutual, InsurAce).`,

  defi_pendle_yield: `**Yield tokenisation (Pendle)** is a DeFi primitive that separates a yield-bearing asset into its principal and future yield components — allowing yield to be traded and hedged like bonds.\n\n**How Pendle works:**\n1. Deposit a yield-bearing token (e.g. stETH, aUSDC, sUSDe) into Pendle\n2. Pendle splits it into:\n   - **PT (Principal Token)** — redeemable for 1 unit of the base asset at maturity\n   - **YT (Yield Token)** — receives all yield generated until maturity\n3. Trade PT and YT on Pendle's AMM\n\n**Strategies:**\n- **Buy PT at a discount** — guaranteed fixed yield at maturity (like a zero-coupon bond)\n- **Buy YT** — leveraged exposure to yield; if rates rise, YT value rises; if rates fall, YT decays to zero\n- **Provide liquidity** — earn swap fees + PENDLE rewards\n\n**Why it matters:**\n- Enables fixed-rate DeFi lending for the first time\n- Lets sophisticated traders speculate on yield curves\n- Creates a more efficient yield market\n\n**Pendle on Arbitrum and Ethereum:** Most activity on Arbitrum; supports stETH, aUSDC, sUSDe, rETH, and more maturity dates`,

  defi_rwa: `**Real-World Assets (RWA) in DeFi** bring off-chain assets like T-bills, private credit, and real estate into decentralised protocols — one of the fastest growing DeFi segments in 2024–2026.\n\n**Why RWAs matter:**\n- Traditional DeFi yields are cyclical (depend on speculative leverage demand)\n- T-bill yields (~4–5% in 2024–2025) are stable and real\n- RWAs diversify DeFi's yield base and attract institutional capital\n\n**Tokenised Treasuries:**\n- **Ondo Finance (OUSG, USDY)** — tokenised short-term US Treasuries; accessible to accredited investors globally\n- **Franklin Templeton (BENJI)** — a regulated US money market fund on Stellar and Polygon\n- **BlackRock BUIDL** — institutional tokenised Treasury fund on Ethereum\n- **Superstate** — on-chain Treasury fund for institutional DeFi\n\n**Private Credit:**\n- **Maple Finance** — institutional undercollateralised loans to crypto firms and RWAs\n- **Centrifuge** — invoice financing, trade finance, real estate loans as NFTs; integrates with MakerDAO\n- **Goldfinch** — emerging market loans; real-world borrowers\n\n**In MakerDAO/Sky:** ~40% of DAI/USDS backing comes from RWAs (T-bills via third-party custodians)\n\n**Risks:** Legal/regulatory complexity, custody and counterparty risk, oracle dependency for off-chain valuations`,

  defi_portfolio: `**Managing a DeFi portfolio** requires understanding risk tiers, position sizing, and the unique failure modes of on-chain finance.\n\n**Risk tiers:**\n- **Tier 1 (lowest risk):** USDC in regulated custody, sUSDS/sUSDe in established protocols, stETH on Lido\n- **Tier 2:** Lending to Aave/Morpho with blue-chip collateral, Curve stable pools\n- **Tier 3:** Uniswap v3 concentrated liquidity, cross-protocol loops, new protocol incentives\n- **Tier 4 (highest risk):** Leveraged positions, new unaudited protocols, meme/governance token exposure\n\n**Key metrics to track:**\n- Health factor (Aave): stay above 1.5 to avoid liquidation\n- LTV ratio: how much you've borrowed vs collateral\n- APY vs APR: APY includes compounding; compare fairly\n- Real yield vs inflationary yield: is the APY paid in a token that's inflating?\n\n**Tools:**\n- **DeBank** — cross-chain DeFi portfolio tracker\n- **Zerion** — wallet and DeFi position tracker\n- **APY.Vision** — LP position tracker with IL calculations\n- **Zapper** — DeFi dashboard and portfolio management\n- **Nansen** — on-chain analytics, smart money tracking\n\n**Best practices:**\n- Never put more than 20–25% of your portfolio in any single protocol\n- Maintain a buffer above your liquidation threshold\n- Regularly audit your approvals (revoke.cash)\n- Keep emergency exit liquidity in a stable asset`,

  defi_bridges_deep: `**Cross-chain DeFi and bridging infrastructure** is how capital moves across the fragmented blockchain landscape.\n\n**Why bridging matters for DeFi:**\n- Capital on Ethereum mainnet can't natively interact with Arbitrum, Solana, or Base protocols\n- ~$30B in bridged TVL across all chains\n- Bridge choice affects security, speed, and fees\n\n**Bridge types for DeFi users:**\n- **Native bridges** (Arbitrum Bridge, Optimism Bridge) — most secure; 7-day withdrawal on Optimistic rollups\n- **CCTP** (Circle) — native USDC only; burn/mint; ~20 min; no third-party risk\n- **Stargate (LayerZero)** — liquidity pool bridge; fast; STG token; cross-chain unified liquidity pools\n- **Across Protocol** — fastest EVM bridge; relayers front capital for instant receipt; re-balanced later\n- **Hop Protocol** — AMM-based bridge for Ethereum L2s\n- **Wormhole** — Solana/EVM; broad chain support; suffered $320M hack 2022\n\n**Canonical vs third-party:**\n- Canonical bridges (official rollup bridges) have the highest security but are slowest\n- Third-party bridges are faster but add smart contract and counterparty risk\n\n**Chain abstraction (emerging):** dApps built on Particle Network, Near Chain Abstraction, or Circle Gateway can abstract away the bridge entirely — users interact from any chain seamlessly`,

  bridges: `**Crypto bridges** move tokens between blockchains. Because chains have no native awareness of each other, bridging requires a trusted mechanism.\n\n**Types:**\n- **Lock-and-mint** — tokens locked on chain A, wrapped copy minted on chain B (e.g. WBTC, old WETH bridges). Risk: if the lock contract is hacked, the minted copy becomes worthless\n- **Burn-and-mint (native)** — CCTP for USDC; tokens burned on source, natively minted on destination; no wrapped asset\n- **Liquidity pools** — bridge holds a pool of real tokens on both sides; faster but carries liquidity risk (Stargate, Across, Hop)\n- **Message-passing** — arbitrary data + tokens move via cross-chain messaging (LayerZero, Wormhole, CCIP)\n\n**Security:** Bridges have been the biggest hack vectors in crypto — Ronin ($625M), Wormhole ($320M), Nomad ($190M), Harmony ($100M). Multi-sig custody and lack of audits are common failure points.\n\n**Best practice:** Use native bridges (CCTP for USDC) or well-audited protocols. Avoid obscure bridges for large amounts.`,

  crypto_security: `**Crypto security** — protecting your assets is your own responsibility; there is no bank reversing a transaction.\n\n**Common attack vectors:**\n- **Phishing** — fake websites mimicking MetaMask, Uniswap, NFT marketplaces; always check the URL\n- **Approval scams** — malicious dApps request unlimited token approvals; use revoke.cash to audit\n- **Social engineering** — Discord DMs offering "whitelist spots" or "admin support"; ignore all unsolicited messages\n- **Drainer contracts** — one "Sign" click drains your entire wallet via Permit2 or setApprovalForAll\n- **Private key theft** — malware, clipboard hijacking, fake browser extensions\n- **SIM-swap** — attacker ports your phone number to steal SMS 2FA\n\n**Best practices:**\n- Hardware wallet (Ledger, Trezor) for holdings > $1,000\n- Separate hot wallet for DeFi; never connect your main wallet\n- Always verify contract addresses on a block explorer before signing\n- Audit your approvals monthly at revoke.cash or etherscan.io/tokenapprovalchecker\n- Use a password manager + hardware 2FA (YubiKey)`,

  mkt_onchain_analysis: `**On-chain market analysis** — reading the blockchain itself as a market signal.\n\n**Why on-chain data matters:**\n- Blockchain is fully transparent — wallet flows, exchange balances, whale moves, miner/validator selling are all public\n- On-chain data leads price action in many cases; predicts trends before they show in charts\n\n**Key metrics:**\n- **Exchange netflows** — more BTC/ETH flowing TO exchanges = selling pressure; outflows = accumulation/self-custody\n- **SOPR (Spent Output Profit Ratio)** — measures if coins moving on-chain are in profit; SOPR < 1 = capitulation\n- **MVRV (Market Value / Realised Value)** — compares market cap to "realised" cap (cost basis of all coins); MVRV > 3.5 historically = overvalued; < 1 = undervalued\n- **Realised cap** — values each UTXO at its last moved price; smoother measure of true value stored in BTC\n- **NVT (Network Value to Transactions)** — P/E ratio for blockchains; high NVT = overvalued vs usage\n- **Active addresses** — daily unique on-chain addresses; correlates with adoption growth\n- **Whale wallets** — addresses holding 1000+ BTC; tracked for accumulation/distribution signals\n- **Long-Term vs Short-Term Holder supply** — LTH holding = conviction; STH selling = market weakness\n- **Funding rates (on-chain perps)** — positive = longs paying shorts (leveraged market); negative = shorts paying longs\n- **Open Interest** — total outstanding derivative contracts; high OI + price drop = potential long squeeze\n\n**Tools:**\n- Glassnode — premium on-chain analytics; best BTC/ETH metrics\n- Nansen — EVM wallet labelling; smart money tracking\n- CryptoQuant — exchange flows, miner data, Korean premium\n- Santiment — social + on-chain combo; NVT, MVRV, sentiment\n- Token Terminal — protocol revenue, P/S ratios for DeFi\n- DefiLlama — TVL, protocol revenue, stablecoin flows`,

  mkt_technical_analysis: `**Technical analysis (TA) for crypto** — using price charts and volume to identify trends and entry/exit points.\n\n**Disclaimer:** TA is a probabilistic tool, not a guarantee. Crypto markets are more volatile and manipulable than traditional markets.\n\n**Core concepts:**\n- **Support & resistance** — price levels where buying or selling has historically concentrated\n- **Trend lines** — connecting swing lows (uptrend) or swing highs (downtrend)\n- **Higher highs/higher lows (HH/HL)** — definition of an uptrend\n- **Lower highs/lower lows (LH/LL)** — definition of a downtrend\n\n**Moving averages:**\n- 50 MA / 200 MA — the "golden cross" (50 crosses above 200) is a bullish signal; "death cross" is bearish\n- EMA (Exponential MA) — more responsive to recent price; 21 EMA common for short-term trend\n\n**Key indicators:**\n- **RSI (Relative Strength Index)** — momentum oscillator 0–100; above 70 = overbought; below 30 = oversold; divergences are strong signals\n- **MACD** — trend-following momentum; crossovers and histogram flips signal trend changes\n- **Bollinger Bands** — price bands ±2 standard deviations from MA; squeezes precede big moves\n- **Volume** — confirms moves; breakout on low volume = weak; high volume = conviction\n- **Fibonacci retracements** — 0.618 ("golden ratio") is the most-watched retracement level\n\n**Chart patterns:**\n- Accumulation/distribution (Wyckoff): Spring → markup → distribution → markdown\n- Head & shoulders: bearish reversal; inverse H&S: bullish reversal\n- Cup and handle: bullish continuation\n- Ascending/descending triangles\n\n**Crypto-specific considerations:**\n- Weekend volatility — thinner order books amplify moves\n- Liquidation cascades — leveraged longs/shorts wiped on quick moves create self-reinforcing candles\n- BTC dominance chart — rising dominance = risk-off; falling = alt-season signal\n- Funding rate as sentiment indicator`,

  mkt_cycles_macro: `**Crypto market cycles and macro** — the 4-year Bitcoin halving cycle and broader macro influences.\n\n**The Bitcoin halving cycle:**\n- Every ~4 years (every 210,000 blocks) Bitcoin's block reward halves\n- Historical pattern: halving → supply shock → bull market 12–18 months later → blow-off top → 70–80% bear market → accumulation\n- Halvings: 2012, 2016, 2020, 2024; each cycle's peak has been higher than the last\n- 2024 halving: block reward dropped from 6.25 to 3.125 BTC; post-halving bull cycle ran 2024–2025\n\n**Cycle phases:**\n1. **Accumulation** — price flat/down; experienced buyers accumulate quietly; low media attention\n2. **Re-accumulation / markup** — price begins trending up; ETFs, institutional buying\n3. **Bull market** — retail FOMO, altcoin season, meme coins, NFT mania; media coverage peaks\n4. **Distribution** — smart money sells into retail demand; price choppy near highs\n5. **Bear market** — leverage unwound; projects fail; 70–80% drawdowns; capitulation\n\n**Macro influences (post-2020):**\n- Federal Reserve interest rates — low rates push risk assets higher (2020–2021 crypto bull); high rates crush them (2022)\n- US dollar strength (DXY) — inverse correlation with Bitcoin; DXY rising = BTC under pressure\n- Equity markets — BTC/ETH correlation with Nasdaq increased post-2020; risk-on/risk-off dynamics\n- Global liquidity (M2) — global central bank money supply expansion historically precedes crypto bull markets\n- US Spot ETF flows — IBIT, FBTC etc. daily flow data is a leading institutional sentiment indicator\n\n**The 4-year cycle debate:**\n- Some argue diminishing returns make each cycle's gain smaller as market matures\n- Others argue macro decoupling is happening as BTC becomes "digital gold"\n- 2024–2025 cycle was notable for institutional participation front-running the halving via ETFs`,

  mkt_futures_deep: `**Crypto futures — deep dive** — the mechanics, venues, and strategies for trading futures contracts.\n\n**What crypto futures are:**\n- Agreement to buy/sell a crypto asset at a set price on a future date (or no date = perpetual)\n- Two types: **Quarterly futures** (CME, Binance) — expire every 3 months; **Perpetual futures** — no expiry, use funding rate to stay near spot\n\n**Funding rate:**\n- Paid between longs and shorts every 8 hours (varies by exchange)\n- Positive funding: longs pay shorts (market leans bullish/overleveraged long)\n- Negative funding: shorts pay longs (market leans bearish/overleveraged short)\n- Extreme positive funding = crowded long = contrarian short signal\n- Traders use funding arbitrage: long spot + short perp = earn funding\n\n**Basis:**\n- Quarterly futures trade at a premium/discount to spot = "basis"\n- Positive basis (contango) = bullish sentiment\n- Negative basis (backwardation) = bearish/stress\n- Basis trade: long spot + short quarterly future = risk-free yield (the basis)\n\n**Leverage and liquidations:**\n- Most retail exchanges allow 10–125x leverage\n- A 1% adverse move with 100x leverage = full liquidation\n- Exchange liquidation engines sell/buy at market — cascades amplify volatility\n- Open Interest (OI) is the key metric: high OI + price drop = potential long squeeze\n\n**Key venues:**\n- **CME** — regulated; institutional; cash-settled; BTC and ETH contracts; micro contracts ($1k notional)\n- **Binance Futures** — largest by volume; USDT-margined and coin-margined\n- **Bybit, OKX** — large offshore venues\n- **Hyperliquid** — leading onchain perp DEX\n- **dYdX v4** — onchain perp on its own Cosmos appchain\n\n**Metrics to watch:**\n- Coinglass — aggregates OI, funding, liquidations, long/short ratios across exchanges`,

  mkt_options_deep: `**Crypto options — deep dive** — puts, calls, and the volatility market.\n\n**Options basics:**\n- **Call option** — right to BUY the underlying at the strike price; profitable when price rises\n- **Put option** — right to SELL the underlying at the strike price; profitable when price falls\n- **Premium** — price paid for the option; determined by intrinsic + time value\n- **Strike price** — the agreed buy/sell price\n- **Expiry** — date the option expires; weekly, monthly, quarterly in crypto\n\n**Greeks:**\n- **Delta** — how much option price moves per $1 move in underlying; 0.5 delta call = $0.50 gain per $1 BTC rise\n- **Gamma** — rate of delta change; high near expiry\n- **Theta** — time decay; options lose value daily as expiry approaches\n- **Vega** — sensitivity to implied volatility; long options benefit from vol rising\n- **IV (Implied Volatility)** — market's expectation of future volatility; high IV = expensive options\n\n**Crypto options strategies:**\n- **Covered call** — hold BTC, sell a call above current price; income strategy\n- **Protective put** — hold BTC, buy a put below current price; insurance against crash\n- **Straddle** — buy call and put at same strike; profits from big moves in either direction\n- **Strangle** — buy OTM call and OTM put; cheaper than straddle; needs bigger move to profit\n- **Iron condor** — sell OTM call spread + sell OTM put spread; profits from low volatility\n\n**Venues:**\n- **Deribit** — dominant crypto options exchange; 90%+ of BTC/ETH options OI; DVOL index\n- **CME** — regulated options on BTC and ETH futures\n- **Coinbase Advanced / Robinhood** — emerging retail options\n- **Lyra Finance** (Derive) — onchain options protocol on Arbitrum/Base\n- **Premia Finance** — DeFi options protocol\n\n**Volatility indicators:**\n- DVOL (Deribit Volatility Index) — BTC implied vol index; similar to VIX for crypto\n- Vol term structure — forward vol curve; inverted = near-term fear\n- Put/Call ratio — high put buying = bearish sentiment or hedging`,

  mkt_market_making: `**Market making and liquidity in crypto** — how prices stay tight and what happens when they don't.\n\n**What market makers do:**\n- Continuously post both bid and ask orders at a spread around fair value\n- Profit from the spread: buy at $99.90, sell at $100.10 = $0.20 per round trip\n- Provide liquidity that enables large orders to fill without massive slippage\n- Manage inventory risk by hedging cross-exchange or in derivatives\n\n**CEX market making:**\n- Designated market makers (Wintermute, GSR, Jump Trading, Cumberland DRW) run algorithmic bots\n- Co-location — servers physically next to exchange matching engines for microsecond advantage\n- Token projects pay market makers to ensure liquidity for their token at launch\n- Typical deal: market maker borrows tokens from project, runs for 12 months, returns tokens\n\n**DEX liquidity provision vs market making:**\n- AMM LPs are passive market makers — they earn fees but take impermanent loss\n- Active market making on CLOBs (Hyperliquid, Phoenix) requires sophisticated risk management\n- Concentrated liquidity (Uni v3) lets LPs act like a range order — more capital efficient\n\n**Slippage and market impact:**\n- Slippage = difference between expected and executed price\n- Larger orders on thin DEXs = more price impact\n- DEX aggregators (1inch, Jupiter) route to minimise slippage\n\n**2024–2025 market structure events:**\n- Jump Crypto's wind-down of retail crypto activities impacted BTC options liquidity\n- Hyperliquid's $200M+ protocol-owned liquidity vault became a major market-making force\n- HLP (Hyperliquid Liquidity Pool) earns from funding and liquidations`,

  mkt_funding_basis: `**Funding rates and the basis trade** — crypto's unique arbitrage opportunity.\n\n**Funding rate recap:**\n- Perpetual futures stay near spot via funding payments between longs and shorts\n- Positive funding: longs pay shorts (common in bull markets; sometimes 50–100%+ annualised)\n- Negative funding: shorts pay longs (common in bear markets or after crashes)\n\n**The basis trade (cash-and-carry):**\n- Strategy: buy spot BTC/ETH + sell equal amount in perpetual futures\n- Result: price-neutral (delta zero); earns funding payments from perp longs\n- Annualised yield in bull markets: 20–60%+ vs holding spot\n- Risk: exchange counterparty risk; liquidation if perpetual margin gets called; negative funding periods\n\n**Quarterly futures basis trade:**\n- Buy spot + sell quarterly futures at a premium\n- Profit = premium decay as futures converge to spot at expiry\n- Lower counterparty risk than perpetual (no liquidation); yield known at entry\n- CME basis trade popular with institutional desks; annualised yields ranged 10–30% in 2024–2025\n\n**Ethena USDe — institutionalised basis trade:**\n- Ethena holds stETH as collateral, shorts ETH perpetuals\n- Passes funding yield to sUSDe holders as a "stablecoin" yield\n- When funding turns negative, Ethena relies on an insurance fund\n\n**Carry trade risks:**\n- Black swan events (exchange hack, sudden regulatory action) can cause correlated loss\n- Funding can turn negative (paying yield out instead of receiving)\n- Forced liquidation during high-volatility periods if margin miscalculated`,

  mkt_onchain_data_tools: `**On-chain data analytics tools** — the professional's toolkit for market intelligence.\n\n**Portfolio tracking:**\n- **DeBank** — cross-chain DeFi portfolio; tracks all positions, LP shares, lending health across 30+ chains\n- **Zapper** — DeFi portfolio + history; gas rebate program; activity feed\n- **Zerion** — clean UI; iOS/Android; good for NFTs + DeFi combined view\n- **Nansen Portfolio** — institutional-grade; wallet labels + on-chain activity\n\n**On-chain analytics:**\n- **Glassnode** — gold standard for Bitcoin/Ethereum metrics; SOPR, MVRV, exchange flows\n- **CryptoQuant** — exchange flow data, BTC miner metrics, Korean premium\n- **Santiment** — social sentiment + on-chain; NVT, MVRV, dev activity, holder distribution\n- **Token Terminal** — DeFi P&L; protocol revenue, fees, P/S ratios; best for DeFi fundamental analysis\n- **DefiLlama** — open-source TVL tracker; chain breakdowns, stablecoin data, yields\n- **Dune Analytics** — custom SQL queries on indexed blockchain data; community-built dashboards\n- **Flipside Crypto** — similar to Dune; bounty programme for analysts\n\n**Trading / market intelligence:**\n- **Coinglass** — futures OI, funding, liquidations, long/short ratios; essential for derivatives traders\n- **TradingView** — charting platform used by 90%+ of crypto traders; Pine Script for custom indicators\n- **Kaiko** — institutional-grade market data; order book depth, OHLCV across 100+ exchanges\n- **Messari** — research + data; governance tracker; protocol profiles\n- **The Block** — research + news; on-chain data dashboard\n\n**Alerting and monitoring:**\n- **Nansen Smart Alerts** — notify when labelled smart money wallets move\n- **Etherscan/Solscan alerts** — wallet activity notifications\n- **Telegram bots** (Maestro, Banana Gun) — DEX sniping + wallet tracking combined`,

  mkt_portfolio_management: `**Crypto portfolio management** — constructing and managing a crypto portfolio systematically.\n\n**Portfolio frameworks:**\n\n**Core-Satellite (most common):**\n- Core (60–80%): BTC + ETH — highest conviction, most liquid, lowest beta risk\n- Satellite (20–40%): Altcoins, DeFi tokens, emerging themes (AI, RWA, gaming)\n- Tactical (0–10%): Memes, high-risk plays, new launches\n\n**Factor-based approach:**\n- L1/L2 infrastructure: Solana, Arbitrum, Optimism, Avalanche\n- DeFi blue chips: AAVE, UNI, CRV, PENDLE\n- Liquid staking: LDO, RPL, JITO\n- RWA: ONDO, CREAL\n- AI/agents: TAO, RNDR, FET\n\n**Position sizing:**\n- Kelly Criterion: bet size = edge / odds (mathematically optimal but aggressive)\n- Fixed %: never risk more than 1–5% of portfolio on a single position\n- Conviction tiers: 10–25% per tier; 3 tiers max\n\n**Risk management:**\n- Drawdown limits: if portfolio drops 20% from ATH, reduce risk; 30% = stop all new positions\n- Correlation: BTC and ETH move together (~0.85 correlation); diversification requires uncorrelated bets\n- Stablecoin allocation: 10–30% in USDC/USDS earns yield and provides dry powder\n- Rebalancing: monthly or threshold-based (±20% drift from target weights)\n\n**Tools:**\n- CoinStats, Delta, Koinly (tax-aware portfolio tracking)\n- Rotki (open-source, self-hosted, privacy-preserving)\n- Messari Governor (governance tracking across holdings)\n\n**Common mistakes:**\n- Overtrading: transaction costs + taxes erode alpha\n- FOMO chasing: buying tops after narratives are already priced in\n- No stop-losses on high-leverage plays\n- Neglecting gas / fee costs for small positions`,

  tokenomics: `**Tokenomics** describes the economic design of a cryptocurrency — supply, distribution, emission schedule, and demand drivers.\n\n**Supply mechanics:**\n- **Fixed supply** — Bitcoin (21M cap); scarcity is built-in\n- **Inflationary** — new tokens minted each block (ETH post-Merge is near-deflationary due to EIP-1559 burns)\n- **Deflationary / burning** — tokens permanently removed from supply (BNB quarterly burns, ETH fee burns)\n\n**Distribution:**\n- Team & investors: typically 15–30% with 1–4 year vesting\n- Treasury / DAO: 20–40% for protocol grants and operations\n- Community / airdrop / mining: 30–50%\n\n**Red flags:**\n- >50% to team/insiders with short vesting or no lock\n- No utility for the token beyond speculation\n- Inflationary reward tokens with no burn mechanic (most P2E failures)\n\n**Demand drivers:** fees paid in the token, governance power, staking yield, required for protocol access, deflationary pressure from burns`,

  regulation: `**Crypto regulation** varies dramatically by jurisdiction and remains one of the sector's biggest uncertainties.\n\n**United States:**\n- SEC claims most tokens are securities under the Howey Test; has sued Coinbase, Ripple, Binance\n- CFTC claims Bitcoin and Ether are commodities\n- FIT21 Act (2024) attempted to clarify SEC/CFTC jurisdiction\n- SAB 121 reversal (2025) allowed banks to custody crypto\n\n**European Union:**\n- **MiCA (Markets in Crypto-Assets)** — comprehensive framework covering stablecoins, exchanges, and token issuers; fully in force 2025\n- Most regulated major jurisdiction; USDC is MiCA-compliant\n\n**Other key jurisdictions:**\n- **Dubai / UAE** — proactive licensing via VARA; major exchange hub\n- **Singapore** — MAS licensing; strict but clear\n- **Hong Kong** — VASP licensing regime; crypto-friendly\n- **China** — banned; CBDC (e-CNY) pushed instead\n\n**Key issues:** stablecoin regulation, DeFi compliance, NFT classification, tax treatment of crypto gains`,

  ai_crypto: `**AI x Crypto** is one of the fastest-growing intersections in the space. Blockchain provides infrastructure for AI agents, data ownership, and decentralised compute.\n\n**Key areas:**\n- **AI agent payments** — autonomous agents need to pay for APIs, compute, and services. USDC micropayments (x402 protocol, Circle Gateway) enable agents to transact without a bank account\n- **Decentralised AI inference** — projects like Bittensor (TAO), Akash Network, Gensyn provide decentralised GPU compute\n- **Verifiable AI** — ZK proofs can verify that an AI ran a specific model on specific inputs without revealing the model weights\n- **Data marketplaces** — Ocean Protocol, Vana allow individuals to sell their data as tokenised assets\n- **AI-generated NFTs** — generative models produce unique digital art; provenance recorded on-chain\n\n**AI coin sector:**\n- FET (Fetch.ai), AGIX (SingularityNET), TAO (Bittensor), NEAR, ICP gained attention as AI narratives grew\n- Most are speculative; evaluate the actual product, not just the narrative\n\n**Arc + AI:** Arc's USDC-native gas and sub-second finality make it ideal for AI agent economies where agents pay per API call`,

  defi_lending: `**DeFi lending protocols** allow users to earn yield by supplying assets and borrow against crypto collateral, all without a credit check or identity.\n\n**How it works:**\n- Suppliers deposit assets (ETH, USDC, wBTC) into a pool\n- Borrowers post collateral (usually 120–150% of loan value) and borrow up to a limit\n- Interest rates adjust algorithmically: high demand → high rate\n- If collateral drops below the liquidation threshold, liquidators repay the loan and receive the collateral at a discount\n\n**Major protocols:**\n- **Aave** — largest multi-chain lending protocol; supports 20+ assets; has "isolation mode" and efficiency mode for correlated assets\n- **Compound** — pioneered algorithmic money markets; simpler design\n- **Morpho** — peer-to-peer matching layer on top of Aave/Compound for better rates\n- **Euler** — permissionless lending vaults\n- **Kamino** (Solana) — leading Solana lending protocol\n\n**Risks:** liquidation cascade (price drops wipe collateral), bad debt (collateral drops faster than liquidation), oracle manipulation`,

  ind_ai_agents: `**AI agents and onchain payments** — autonomous software agents are becoming first-class economic actors, and blockchain is their native financial layer.\n\n**Why agents need crypto:**\n- AI agents execute tasks autonomously (book services, purchase compute, pay APIs) 24/7\n- Traditional banking requires KYC, account approvals, and human operators — impossible for software agents\n- Crypto wallets can be created programmatically, funded instantly, and used without human intervention\n\n**x402 protocol:**\n- HTTP 402 "Payment Required" — long-dormant status code repurposed for machine-to-machine micropayments\n- Agent requests a resource → server returns 402 with payment details → agent pays in USDC → server fulfils the request\n- Circle's implementation: EVM-compatible, USDC on Base/Arc, sub-cent transactions\n- Enables: pay-per-API-call, pay-per-inference, pay-per-tool-use\n\n**Circle Agent Ecosystem:**\n- **Arc** — USDC is the native gas token; stable, predictable costs for agent loops\n- **Circle Developer-Controlled Wallets** — create wallets for each agent programmatically; Circle manages key custody\n- **Modular Wallets + ERC-4337** — smart accounts with session keys; an agent can be given a limited budget to spend without signing every transaction\n\n**MCP (Model Context Protocol):**\n- Anthropic's open standard for connecting AI models to tools and services\n- Circle MCP tools allow Claude (and other AI models) to check USDC balances, send payments, and create wallets from within an AI conversation\n\n**ERC-8004 Agent Identity:**\n- An EVM standard for registering AI agents with an onchain identity, agent card (name, description, services), and associated wallet\n- Enables agents to discover and pay each other; forms the basis of the Arc agent marketplace\n\n**Real-world examples:**\n- Autonomous research agents paying for premium data feeds per query\n- AI coding agents purchasing cloud compute on demand\n- Multi-agent pipelines where each step pays the next for its service`,

  ind_decentral_ai: `**Decentralised AI compute and inference** — a blockchain-native alternative to AWS, Google Cloud, and Azure for AI workloads.\n\n**The centralisation problem:**\n- AI training and inference is dominated by a handful of hyperscalers\n- Costs are high, access is restricted, and output is monitored/censored\n- Idle GPU capacity (gaming rigs, enterprise servers) is massively underutilised globally\n\n**Key networks:**\n- **Bittensor (TAO)** — a decentralised network of AI "subnets" where validators compete to produce the best ML output; TAO token rewards best performers; largest AI-native L1 by market cap\n- **Akash Network (AKT)** — decentralised cloud compute marketplace; GPU and CPU spot auctions; cheaper than AWS for many workloads\n- **io.net** — GPU cluster marketplace aggregating idle RTX cards; focuses on parallelised ML inference\n- **Gensyn** — verifiable distributed ML training using cryptographic proofs; solve the "did the training actually happen?" problem\n- **Hyperbolic** — democratised AI inference; rent GPU inference capacity at market rates\n- **Render Network (RNDR)** — originally GPU rendering for 3D; expanded to AI inference on Solana\n\n**Storage layer:**\n- **Filecoin (FIL)** — decentralised storage with cryptographic proofs of replication; used for AI model and dataset storage\n- **Arweave (AR)** — permanent, pay-once storage; NFT metadata and AI training sets\n- **IPFS** — content-addressed storage; not incentivised but widely used\n\n**Challenges:**\n- Verifying compute is actually performed (Gensyn solving this)\n- Latency vs centralised providers (not solved)\n- Model weight IP protection on public networks`,

  ind_verifiable_ai: `**Verifiable AI and zkML** — using cryptographic proofs to verify AI model execution without revealing model internals.\n\n**The trust problem in AI:**\n- When an AI provider says "I ran GPT-X on your input", how do you verify it?\n- In DeFi and agent payments, you pay per inference — but only if the inference was genuine\n- AI content moderation and compliance require proof that a specific approved model ran (not a jailbroken version)\n\n**Zero-Knowledge ML (zkML):**\n- A ZK proof proves that a specific model (committed to at deployment) produced a specific output from a specific input\n- Nobody needs to see the model weights or the input — just the proof\n- Projects: **EZKL** (open-source zkML library), **Modulus Labs**, **Giza Tech**, **Risc Zero** (zkVM for any computation)\n\n**Optimistic ML:**\n- Run inference off-chain, post the result on-chain, with a challenge window\n- Anyone can challenge a claimed output; challenger submits a proof if the result was wrong\n- Faster and cheaper than ZK; used by **OpML** (on-chain ML oracle)\n\n**Trusted Execution Environments (TEE) for AI:**\n- Run inference inside an Intel SGX or AMD SEV enclave; hardware attestation proves the model ran correctly\n- Used by **Phala Network**, **Marlin Protocol**, **Gensyn** (hybrid ZK+TEE)\n- Trade-off: requires trusting the hardware manufacturer\n\n**On-chain AI oracles:**\n- Smart contracts that query AI models; output posted on-chain with a cryptographic attestation\n- Chainlink Functions can call off-chain AI APIs and post results on-chain with DON consensus\n\n**Applications:**\n- Verifiable credit scoring (prove your score without revealing financial data)\n- Proof of personhood (prove you are human, not a bot, without revealing identity)\n- Compliant content moderation (prove a specific approved model filtered content)\n- Trustless AI agent payments (only pay if provably correct inference occurred)`,

  ind_ai_tokens: `**The AI token sector** — a deep-dive into AI-adjacent crypto projects and their investment thesis.\n\n**Sector overview (2026):**\n- AI x Crypto narrative peaked Q1 2024, cooled, re-emerged 2025–2026 with agent economy growth\n- Market cap of AI sector tokens: $30–50B collectively\n- Three distinct sub-sectors: infrastructure (compute/storage), AI L1s, agent frameworks\n\n**Infrastructure tokens:**\n- **TAO (Bittensor)** — AI L1 with subnet architecture; validators earn TAO for best AI outputs; most decentralised AI network; $5–15B market cap range\n- **RNDR (Render)** — GPU compute on Solana; one of the most used real utility tokens; actual revenue from compute jobs\n- **AKT (Akash)** — decentralised compute marketplace; real usage from AI developers seeking cheap GPU access\n- **FIL (Filecoin)** — decentralised storage; used for model and dataset archival\n- **AR (Arweave)** — permanent storage; NFT + AI data preservation\n\n**AI agent / platform tokens:**\n- **NEAR** — chain with a focus on AI-readable smart contracts; NEAR AI assistant; chain abstraction\n- **ICP (Internet Computer)** — Dfinity's "world computer"; on-chain AI model execution claimed; controversial\n- **AGIX (SingularityNET)** — AI services marketplace; merged into Artificial Superintelligence Alliance (ASI) with FET and OCEAN\n- **FET (Fetch.ai)** — autonomous economic agents; merged into ASI Alliance\n- **OCEAN (Ocean Protocol)** — decentralised data marketplace for AI training sets\n- **VANA** — personal data DAOs; users tokenise and monetise their own data for AI training\n\n**Agent-specific tokens (2025–2026):**\n- **Virtuals Protocol (VIRTUAL)** — launchpad for tokenised AI agents on Base; LUNA, AIXBT agents\n- **ai16z (ELIZAOS)** — largest AI agent framework by GitHub stars; ElizaOS; on Solana\n- **ZEREBRO** — autonomous creative AI agent posting art and music on social media\n\n**Investment considerations:**\n- Distinguish "AI washing" (crypto project that added "AI" to marketing) from genuine compute/model projects\n- Revenue metrics matter: actual compute jobs, API calls, data purchases\n- Most AI tokens are highly correlated with BTC; AI narrative is a beta amplifier, not alpha source\n- TAO and RNDR have demonstrated real utility; most agent tokens are speculative`,

  ind_us_regulation: `**US crypto regulation — deep dive** — the most complex regulatory environment for crypto globally.\n\n**The agencies and their claims:**\n- **SEC (Securities and Exchange Commission):** Gary Gensler claimed almost all tokens are securities under the Howey Test. Under new leadership (2025+) the SEC shifted to a more crypto-friendly stance; dismissed several lawsuits.\n- **CFTC (Commodity Futures Trading Commission):** Considers Bitcoin and Ether commodities; has jurisdiction over derivatives and spot commodity markets\n- **FinCEN / Treasury:** AML/KYC rules; Bank Secrecy Act applies to exchanges (MSBs)\n- **OCC / Federal Reserve:** National bank crypto custody guidance; SAB 121 reversal (2025) allowed banks to custody crypto on behalf of clients\n\n**Key legislation and milestones:**\n- **FIT21 (Financial Innovation and Technology for the 21st Century Act):** Passed House 2024; clarifies SEC vs CFTC jurisdiction based on whether a blockchain is decentralised; most significant crypto legislation in US history\n- **GENIUS Act (Stablecoin Bill):** Proposed federal framework for stablecoin issuers; 1:1 reserves, monthly audits, federal or state licensing\n- **Bitcoin ETF (Jan 2024):** BlackRock IBIT, Fidelity FBTC, and others approved by SEC; watershed moment for institutional access; $60B+ AUM within a year\n- **Ethereum ETF (May 2024):** Spot ETH ETFs approved; smaller AUM than BTC ETFs initially\n\n**Major enforcement actions:**\n- Ripple (XRP) — partial win; programmatic secondary sales not securities\n- Coinbase — SEC suit dismissed 2025 under new leadership\n- Binance — $4.3B DOJ settlement (2023); CZ sentenced to 4 months\n- FTX — SBF convicted of fraud on all counts; sentenced to 25 years\n- Kraken — settled staking-as-a-service charges; paid $30M\n\n**State-level:**\n- New York: BitLicense (most stringent); required for any crypto business serving NY residents\n- Wyoming: DAO LLC, Special Purpose Depository Institution (SPDI) for crypto banks\n- Texas, Florida: crypto-friendly; no additional licensing beyond federal MSB`,

  ind_global_regulation: `**Global crypto regulation — 2026 landscape** — how the world outside the US regulates crypto.\n\n**European Union — MiCA (Markets in Crypto-Assets):**\n- Fully in force 2025; the world's most comprehensive crypto regulatory framework\n- **CASPs (Crypto Asset Service Providers):** exchanges, brokers, custodians need EU authorisation\n- **EMT (E-Money Tokens):** stablecoins referencing a single fiat currency; 1:1 backing, redemption at par\n- **ART (Asset-Referenced Tokens):** backed by multiple assets or commodities\n- MiCA does NOT cover DeFi, NFTs (mostly), or CBDCs\n- Impact: large stablecoins (>€5B daily tx volume) face extra restrictions\n\n**United Arab Emirates:**\n- **VARA (Virtual Assets Regulatory Authority)** in Dubai — full licensing framework\n- Binance, OKX, Kraken, Bybit all obtained VARA licences; Dubai became a crypto hub post-FTX\n- ADGM (Abu Dhabi) has a separate framework for institutional/professional investors\n\n**Singapore:**\n- **MAS (Monetary Authority of Singapore):** Major Payment Institution (MPI) licence required for crypto businesses\n- Strict AML/KYC; retail leverage limits; generally pro-crypto for institutions\n- Coinbase, Kraken, Circle all licenced; Binance exited Singapore market\n\n**Hong Kong:**\n- VASP licensing for centralised exchanges; OSL, HashKey first to receive\n- Retail trading permitted (2023 policy shift); Bitcoin/ETH spot ETFs launched on HKEX\n- Aiming to compete with Singapore as the Asia crypto hub\n\n**Japan:**\n- FSA regulates; exchanges must register; strict segregation of user funds\n- Only registered trust companies/banks can issue yen stablecoins (JFSA law 2023)\n- One of the strictest but most compliant markets; strong consumer protections\n\n**El Salvador:**\n- First country to adopt Bitcoin as legal tender (2021); backed off mandatory acceptance in 2025 under IMF pressure but retained Bitcoin as legal tender\n\n**China:**\n- All crypto trading and mining banned (2021); e-CNY CBDC heavily promoted`,

  ind_crypto_taxes: `**Crypto taxes** — obligations vary by jurisdiction; non-compliance is a leading source of regulatory risk for crypto holders.\n\n**United States (IRS):**\n- Crypto is treated as **property**, not currency — every disposal is a taxable event\n- **Taxable events:** selling for fiat, trading one token for another, spending crypto on goods/services, receiving staking/mining/airdrop rewards as ordinary income\n- **NOT taxable:** buying crypto with fiat, transferring between your own wallets, holding\n- **Capital gains rates:**\n  - Short-term (held under 1 year): taxed as ordinary income (up to 37%)\n  - Long-term (held over 1 year): 0%, 15%, or 20% depending on income\n  - NFTs may be taxed at the 28% collectibles rate\n- **Reporting:** Form 8949 for capital gains, Schedule 1/Schedule C for income; exchanges issue 1099-DA (2025+)\n- **Wash sale rule:** Currently does NOT apply to crypto (applies to securities); proposed legislation may change this\n\n**United Kingdom (HMRC):**\n- Crypto is a capital asset; CGT applies (10% basic rate, 20% higher rate)\n- Annual CGT allowance (£3,000 in 2026) applies\n- DeFi yield, staking, and mining may be income or capital depending on facts\n\n**Germany:**\n- Tax-free if held over 1 year (no CGT on long-term crypto gains for individuals)\n- Short-term gains taxed as income if over €600 per year\n- NFTs and DeFi income more complex; consult a Steuerberater\n\n**Australia (ATO):**\n- CGT applies; 50% discount for assets held over 1 year\n- Personal use asset exemption for small transactions (<$10,000)\n\n**Key tools:** Koinly, TaxBit, CoinTracker, CryptoTaxCalculator, TokenTax — all integrate with major exchanges and wallets to calculate gains/losses\n\n**Best practice:** Track cost basis from the first purchase; use FIFO (default) or specific identification; don't wait until April`,

  ind_institutional: `**Institutional crypto adoption — 2026 landscape** — how banks, asset managers, and corporations are embracing crypto.\n\n**Bitcoin ETFs — the watershed moment:**\n- BlackRock IBIT: $50B+ AUM within 6 months of launch — fastest ETF to $10B in history\n- Fidelity FBTC, Ark 21Shares ARKB, Bitwise BITB, Franklin BBTC — competing products\n- Spot ETH ETFs (May 2024): smaller but growing; enabled institutions to access ETH yield via staking\n- Institutional AUM in crypto ETFs: $100B+ by mid-2026\n\n**Corporate treasuries:**\n- **MicroStrategy (Strategy):** 568,840+ BTC as of 2026 (~$50B+ at various prices); pioneered "Bitcoin Standard" treasury strategy\n- **Marathon Digital, Riot Platforms, CleanSpark** — Bitcoin mining companies with large BTC holdings\n- **Tesla:** 10,000 BTC (after partial sale); accepts DOGE for merchandise\n- **Coinbase:** holds BTC/ETH on balance sheet\n- Dozens of smaller public companies followed the MicroStrategy playbook\n\n**Prime brokerage:**\n- **Coinbase Prime:** custody, OTC trading, lending, staking for institutional clients; holds 12%+ of all BTC\n- **FalconX:** $1T+ cumulative volume; focuses on trading desks\n- **Hidden Road (acquired by Ripple 2025):** credit intermediary for institutional crypto trades\n\n**Bank involvement:**\n- JPMorgan Onyx: permissioned blockchain for repo and settlement; JPM Coin for intraday liquidity\n- Goldman Sachs: Digital Asset Platform; tokenised bond issuance; crypto trading desk\n- BNY Mellon, State Street: qualified crypto custody for institutional clients (post-SAB 121 reversal)\n- Société Générale: issued OFH covered bonds as security tokens on Ethereum\n\n**Regulatory catalysts for institutions:**\n- SAB 121 reversal (2025): allowed banks to hold crypto as custodians without burdensome balance sheet treatment\n- Bitcoin ETF approval: enabled pension funds, endowments, and RIAs to access BTC\n- FIT21: cleared jurisdictional uncertainty for institutional traders`,

  ind_privacy_deep: `**Privacy in crypto — deep dive** — a comprehensive look at privacy technologies, tools, and regulatory pressures.\n\n**Why privacy matters:**\n- Public blockchains are fully transparent — every transaction is permanently visible\n- Pseudonymity is not anonymity; one link (CEX KYC, ENS name, public address disclosure) deanonymises an address permanently\n- Business privacy: companies don't want competitors seeing treasury movements, supplier payments, or payroll\n- Personal safety: high-value wallets are targets for physical attack ($5 wrench problem)\n\n**Privacy coins:**\n- **Monero (XMR):** Gold standard for privacy; stealth addresses hide recipient, ring signatures hide sender, RingCT hides amount — all transactions private by default. Delisted from Binance, Kraken (EU), Coinbase. Accepted by some dark web markets; primary regulatory concern\n- **Zcash (ZEC):** zk-SNARKs enable shielded "z-addresses"; transparent by default, private opt-in. Controversial: only ~20% of transactions are shielded. Electric Coin Company behind development\n- **Dash (DASH):** CoinJoin-based PrivateSend mixing; weakest privacy of the three; focus shifted to payments\n- **Secret Network (SCRT):** Programmable privacy; smart contracts run in TEEs with encrypted state; "privacy as a service" for other chains\n\n**Ethereum privacy tools:**\n- **Tornado Cash:** ZK-based ETH/ERC-20 mixer; OFAC sanctioned August 2022 (first protocol-level sanction); developer Roman Storm arrested; ongoing legal battle over software as speech\n- **Railgun:** Privacy-preserving DeFi; shielded USDC/ETH balances interact with Uniswap/Aave via relayers; not yet sanctioned; supported by Vitalik\n- **Aztec Network:** ZK rollup with programmable privacy; private DeFi (private Uniswap, private Aave) — the most technically ambitious privacy project\n\n**Chain analytics industry:**\n- **Chainalysis:** The dominant tool; used by FBI, DEA, IRS-CI, OFAC; Reactor investigation platform; Kryptos transaction screening\n- **Elliptic:** Used by global banks for compliance; acquired by Ripple's affiliate\n- **TRM Labs:** Blockchain intelligence used by 60+ law enforcement agencies\n- **Arkham Intelligence:** Public deanonymisation platform; entity labelling with crowd-sourced bounties; controversial\n- **Nansen:** Wallet labelling and flow analysis; focuses on DeFi and whale tracking\n\n**Regulatory pressure:**\n- Travel Rule (FATF): crypto exchanges must share sender/recipient info for transfers over thresholds\n- EU TFR (Transfer of Funds Regulation): even unhosted wallet transfers require identity data — among the world's strictest\n- Most privacy coins delisted from regulated CEXs in EU, Japan, South Korea\n- ZK identity emerging as the compliant privacy path: prove you are KYC-verified without revealing who you are`,

  priv_zk_identity: `**ZK identity and compliant privacy** — proving facts about yourself without revealing who you are.\n\n**The problem:**\n- KYC data is stored in centralised databases; breaches expose millions (e.g. Equifax, OPM)\n- Onchain KYC forces users to link real identity to every wallet — destroying pseudonymity\n- Regulators want compliance; users want privacy; ZK identity bridges both\n\n**How ZK identity works:**\n- A trusted issuer (government, KYC provider) attests to a fact: "this person is over 18 and is not on a sanctions list"\n- The user generates a ZK proof that reveals ONLY the required fact, not their identity\n- The smart contract or service verifies the proof without ever seeing name, passport, or address\n\n**Key projects:**\n- **Polygon ID / iden3** — decentralised identity using ZK credentials; W3C Verifiable Credentials standard; used for DeFi KYC gates\n- **Worldcoin / World ID** — biometric iris scan → proof of unique humanity; privacy-preserving Sybil resistance; World App (500M+ users by 2026)\n- **Coinbase Verifications** — onchain attestation that an address passed Coinbase KYC; used by Base ecosystem projects\n- **Quadrata** — passport-style NFT encoding KYC/AML status for DeFi whitelisting without revealing identity\n- **Verax / EAS (Ethereum Attestation Service)** — general-purpose onchain attestation registries\n- **Semaphore** — ZK membership proofs; prove you are in a group without revealing which member\n- **anon.aadhaar** — ZK proofs from India's Aadhaar biometric system; 1.4B people\n\n**Regulatory alignment:**\n- Travel Rule: ZK proofs can prove counterparty compliance without sharing raw PII\n- MiCA: Article 68 allows pseudonymous transactions below thresholds; ZK proofs used for threshold attestation\n- FATF: exploring ZK identity as a privacy-preserving compliance path\n\n**The vision:** "Privacy by default, compliance by proof" — users maintain full pseudonymity but can prove regulatory requirements on demand`,

  priv_monero_deep: `**Monero (XMR) — deep dive** — the gold standard for financial privacy.\n\n**Core privacy technology:**\n- **Stealth addresses** — every transaction uses a one-time address derived from the recipient's public key; no observer can link transactions to a public address\n- **Ring signatures** — each spend includes decoy inputs (ring size = 16 by default); an observer cannot determine which input was actually spent\n- **RingCT (Ring Confidential Transactions)** — hides transaction amounts using Pedersen commitments; introduced 2017, mandatory since 2018\n- **Dandelion++** — transaction propagation protocol that obscures the originating IP address\n- All transactions are private by default — there is no transparent mode\n\n**Monero vs Zcash:**\n| Feature | Monero | Zcash |\n|---|---|---|\n| Default privacy | Always | Transparent by default |\n| Technology | Ring sigs + stealth | zk-SNARKs (Sapling/Orchard) |\n| Shielded usage | 100% | ~20% of txs |\n| Trusted setup | No | Yes (Zcash ceremony) |\n| Exchange listings | Delisted widely | Still listed on Gemini, Kraken |\n\n**Regulatory status:**\n- Delisted from Binance (2024), Kraken (EU), Huobi, OKX, Bittrex, ShapeShift\n- Still traded on Bisq (P2P), Haveno, LocalMonero (closed 2024), Cake Wallet\n- Accepted by some dark web markets; primary target of FATF guidance on privacy coins\n- IRS paid $1.25M to CipherTrace for XMR tracing research; results inconclusive\n\n**Use cases (legitimate):**\n- Business privacy: hiding payroll, supplier payments, treasury movements from competitors\n- Personal privacy: medical payments, salary protection, security against physical threats\n- Remittances in high-surveillance jurisdictions\n\n**Mining:** CPU-mineable (RandomX algorithm designed to resist ASICs and GPUs); still community-mined`,

  priv_tornado_legal: `**Tornado Cash legal saga** — the first time a neutral privacy protocol was sanctioned, and the fight back.\n\n**What Tornado Cash is:**\n- ZK-based ETH and ERC-20 mixer deployed on Ethereum in 2019\n- Users deposit a fixed amount (0.1 / 1 / 10 / 100 ETH), receive a ZK proof note\n- Later, withdraw the same amount to a fresh address with no on-chain link to the deposit\n- Smart contracts are immutable — no owner, no admin key, no off switch\n\n**The OFAC sanction (August 2022):**\n- US Treasury's OFAC added Tornado Cash smart contract addresses to the SDN (Specially Designated Nationals) list\n- First time immutable open-source smart contracts were sanctioned\n- Immediate effects: GitHub removed repos, Circle blacklisted TC USDC, Infura/Alchemy blocked RPC calls to the contracts, dYdX banned wallets that had used TC\n- Tornado Cash developer Alexey Pertsev arrested in Netherlands (August 2022); convicted May 2024, sentenced to 5 years 4 months\n- Tornado Cash developer Roman Storm arrested in US (August 2023); charged with money laundering conspiracy\n\n**Legal battle:**\n- **Van Loon v Treasury (5th Circuit, November 2024)** — court ruled OFAC overstepped: immutable smart contracts are not "property" that can be owned or controlled; sanction partially vacated\n- Roman Storm trial: ongoing; first criminal trial of a crypto developer for writing privacy software\n- Core legal question: does writing and deploying neutral open-source code make you liable for third-party criminal use?\n\n**Broader implications:**\n- Chilling effect on privacy tools — developers of Railgun, Aztec, Privado moved slowly or added geofencing\n- "Code is speech" argument strengthened by 5th Circuit ruling\n- OFAC revised the sanction to target individuals, not the contracts\n- Railgun and Aztec used the legal uncertainty as motivation to build stronger compliance features (ZK proofs of non-sanctioned status)`,

  priv_railgun_aztec: `**Railgun and Aztec — privacy-preserving DeFi**\n\n**Railgun:**\n- EVM-compatible shielded balance system; currently on Ethereum, Polygon, Arbitrum, BNB Chain\n- Users deposit ETH/USDC/tokens into a shielded pool; receive encrypted "UTXO" representation\n- Private transactions: send shielded balances without revealing sender, receiver, or amount\n- Private DeFi: Relayer network submits transactions to Uniswap, Aave on your behalf — smart contract sees the relayer, not your wallet\n- "Proof of Innocence" feature: users can prove their funds do NOT come from sanctioned sources (using ZK exclusion proofs) — addresses Tornado Cash compliance problem\n- Endorsed by Vitalik Buterin; used by some institutional desks for competitive privacy\n- RAIL governance token; no OFAC sanction as of 2026\n\n**Aztec Network:**\n- ZK rollup with programmable privacy — the most technically ambitious privacy project in crypto\n- "Noir" — Aztec's ZK domain-specific language; developers write private smart contracts\n- Private functions can read/write to private state; public functions visible on-chain\n- Private Uniswap: swap tokens without revealing which tokens, amounts, or wallet\n- Private Aave: borrow/lend without revealing collateral position\n- Aztec Connect (deprecated); Aztec v3 "Sandbox" live for developers; mainnet gradual rollout 2025–2026\n- Key innovation: ZK-ZK recursion — private user transactions are batched into a ZK proof, then rolled up into Ethereum calldata`,

  priv_confidential_compute: `**Confidential compute and FHE in crypto** — computing on encrypted data without decrypting it.\n\n**TEE (Trusted Execution Environment):**\n- Isolated hardware enclave (Intel SGX, AMD SEV, ARM TrustZone) where code runs encrypted even from the OS and cloud provider\n- Remote attestation: cryptographic proof that a specific code is running inside a genuine TEE\n- **Phala Network** — Substrate-based; 50,000+ TEE worker nodes; private smart contracts (phat contracts); off-chain computation\n- **Marlin (Oyster)** — TEE-based serverless compute for Web3; used for private AI inference and private oracles\n- **Secret Network** — every node runs in Intel SGX; encrypted contract state; "privacy as a service" for IBC chains\n- Limitation: SGX has had exploits (Spectre, side-channel); hardware trust assumption is a single point of failure\n\n**MPC (Multi-Party Computation):**\n- Multiple parties jointly compute a function without any party learning others' inputs\n- Used in wallet key management (Fireblocks, ZenGo, Circle Modular Wallets) — no single party holds the full key\n- Used in dark pool trading — multiple venues match orders without revealing order book\n\n**FHE (Fully Homomorphic Encryption):**\n- Perform arbitrary computations on encrypted data; the result decrypts to the correct answer\n- "Holy grail" of cryptography — finally practical for blockchain in 2025–2026\n- **Zama (fhEVM)** — FHE-enabled EVM; confidential smart contracts with encrypted state on standard Ethereum tooling; partnered with LVMH, Decentraland\n- **Fhenix** — FHE-enabled L2 rollup on Ethereum; confidential DeFi\n- **Inco Network** — FHE L1; "universal confidentiality layer" for EVM chains\n- Use cases: private voting, sealed-bid auctions, confidential payroll, private AI inference`,

  priv_ux_tools: `**Privacy UX tools** — practical tools for maintaining onchain privacy.\n\n**Transaction privacy:**\n- **Flashbots Protect** — submit transactions directly to block builders, bypassing the public mempool; prevents MEV sandwich attacks and front-running; free to use\n- **MEV Blocker** — Cowswap's RPC endpoint; rebates MEV to users; adds privacy from sandwiching\n- **Private transactions (Ethereum)** — any private mempool RPC (Alchemy Private, Infura ITX, Blocknative) prevents front-running\n\n**Wallet hygiene:**\n- **New address per interaction** — HD wallets (BIP-44) make this free; use a new derived address per dApp\n- **Burner wallets** — separate disposable wallets for public airdrops, governance voting, NFT minting\n- **ENS caution** — linking ENS to an address makes it permanently public; use ENS only for your "public identity" wallet\n\n**UTXO coin mixing (Bitcoin):**\n- **Wasabi Wallet** — desktop; coordinator-based CoinJoin; privacy scoring; free mixing (Zero Link protocol)\n- **JoinMarket** — decentralised CoinJoin marketplace; no central coordinator; pay market makers for liquidity\n- **Whirlpool (Sparrow Wallet)** — Samourai Wallet's CoinJoin protocol (Samourai founders arrested April 2024 by DOJ); Sparrow continues the protocol independently\n\n**Network layer privacy:**\n- **Tor / I2P** — route wallet RPC calls through anonymisation networks; Wasabi and Cake Wallet have built-in Tor\n- **VPN** — hides IP from exchange/RPC provider; weaker than Tor for real privacy\n- **Custom RPC nodes** — self-hosted Ethereum node eliminates data leakage to Alchemy/Infura\n\n**Traceability limits:**\n- CEX withdrawals to "private" addresses are permanently linked to your KYC identity at the exchange\n- Chain analytics firms track "peel chains", address clusters, timing analysis\n- True privacy requires: private coin OR ZK mixer + network-layer privacy + no CEX linkage`,

  priv_future: `**The future of onchain privacy** — where privacy technology is heading in 2026–2030.\n\n**Current state (2026):**\n- Public blockchains are fully transparent; chain analytics has caught up to most mixing techniques\n- ZK technology has matured enough to make privacy practical (proof times < 1 second on modern hardware)\n- Regulatory pressure at peak — Travel Rule, FATF guidance, EU TFR, Tornado Cash sanction\n- Privacy tools are bifurcating: compliant (ZK identity + KYC attestations) vs non-compliant (Monero, mixers)\n\n**Near-term developments (2026–2027):**\n- **Aztec mainnet** — full-featured private smart contracts; private DeFi at scale\n- **fhEVM adoption** — Zama's FHE toolkit integrated into more EVM chains; confidential ERC-20s\n- **ZK identity standard** — W3C DID + ZK proof as the default "compliant privacy" stack; Travel Rule compliance without data sharing\n- **Private AI agents** — agents executing trades with TEE-isolated strategies; no front-running from strategy disclosure\n\n**Medium-term (2027–2030):**\n- **Account abstraction + privacy** — ERC-4337 smart accounts with built-in Railgun/Aztec shielding; "private by default" wallets\n- **Private L2s** — privacy-preserving rollups as app-specific chains; Aleo, Aztec, Fhenix competing for market\n- **ZK coprocessors** — apps query historical on-chain data with ZK proofs, generating private analytics\n- **FHE-based dark pools** — institutional trading where order size and identity never revealed, even to the exchange\n\n**Open questions:**\n- Will regulators accept ZK identity as Travel Rule compliance? (FATF guidance expected 2026)\n- Can FHE reach the performance needed for high-frequency DeFi? (Current latency: 100ms–10s per op)\n- Will privacy become a feature of all wallets (like HTTPS became default) or remain a niche concern?`,

  privacy_crypto: `**Privacy in crypto** — public blockchains are pseudonymous, not anonymous. Every transaction is permanently recorded and traceable.\n\n**Privacy coins:**\n- **Monero (XMR)** — stealth addresses, ring signatures, RingCT hide sender, receiver, and amount by default\n- **Zcash (ZEC)** — zk-SNARKs enable shielded transactions; transparent by default, private opt-in\n- **Dash** — CoinJoin-based mixing (PrivateSend); less private than XMR\n\n**Privacy on Ethereum:**\n- **Tornado Cash** — USDC/ETH mixer using ZK proofs; sanctioned by OFAC in 2022\n- **Railgun** — privacy-preserving DeFi; shielded balances interact with Uniswap/Aave\n- **Aztec** — ZK rollup with programmable privacy\n\n**Chain analysis:** Companies like Chainalysis, TRM Labs, and Elliptic de-anonymise on-chain activity using heuristics, exchange KYC data, and cluster analysis. CEX withdrawals and fiat onramps are the main de-anonymisation points.\n\n**Regulatory pressure:** Privacy coins are delisted from major CEXs in many jurisdictions. OFAC sanctions on Tornado Cash set precedent for protocol-level sanctions.`,

  crypto_derivatives: `**Crypto derivatives** are financial instruments whose value derives from an underlying cryptocurrency price.\n\n**Types:**\n- **Futures** — agreement to buy/sell at a future date and price; BTC/ETH CME futures are used by institutions\n- **Perpetual swaps** — no expiry; the dominant product in crypto; funded by the funding rate mechanism\n- **Options** — right (not obligation) to buy/sell at a strike price; Deribit dominates institutional options\n- **Structured products** — dual-investment (sell volatility for yield), principal-protected notes\n\n**Market size:** crypto derivatives dwarf spot; ~70–80% of total crypto trading volume\n\n**Platforms:**\n- **Centralised:** Bybit, OKX, Binance Futures, Deribit (options), CME (regulated)\n- **Decentralised:** Hyperliquid, dYdX, GMX, Synthetix Perps, Lyra (options)\n\n**Key concepts:** open interest (OI), long/short ratio, funding rate, basis (futures premium/discount to spot), gamma squeeze, max pain (options)`,

  sec_hardware_wallets: `**Hardware wallets** — the gold standard for cold storage of crypto assets.\n\n**How they work:**\n- A hardware wallet is a dedicated signing device; the private key is generated and stored on the device and never exposed to the internet-connected computer\n- When you sign a transaction, it is sent to the device, signed inside the secure chip, and the signed transaction is returned — the key never leaves\n- Even if your PC is fully compromised with malware, your funds are safe as long as you verify the transaction on the device screen\n\n**Top hardware wallets (2026):**\n- **Ledger Nano X / Ledger Flex** — most popular; Bluetooth; supports 5,500+ tokens; Ledger Live app; secure element chip (CC EAL5+); had a data breach (customer data only) in 2020\n- **Trezor Model T / Safe 3** — fully open-source firmware; no secure element; USB; Trezor Suite; the open-source community prefers Trezor\n- **Coldcard** — Bitcoin-only; air-gapped PSBT signing; most popular among Bitcoin maximalists\n- **Foundation Passport** — open-source Bitcoin hardware wallet; completely air-gapped\n- **GridPlus Lattice1** — large screen for full transaction inspection; supports MetaMask integration\n\n**Setup best practices:**\n1. Buy only from the official manufacturer website — never secondhand\n2. Verify the tamper-evident seal before opening\n3. Generate seed phrase on the device itself — never on a computer\n4. Write seed phrase on paper (or stamp into metal); never photograph it or store digitally\n5. Store the seed phrase backup in a separate physical location from the device\n6. Test recovery before storing large amounts\n\n**Multi-hardware setup:** Power users hold two hardware wallets from different manufacturers, both derived from the same seed phrase, as backup.`,

  sec_seed_keys: `**Seed phrases, private keys, and key management** — the single most critical security concept in self-custody crypto.\n\n**How BIP-39 seed phrases work:**\n- A 12 or 24-word mnemonic phrase is a human-readable encoding of 128 or 256 bits of entropy\n- The phrase derives a master private key (BIP-32), which derives child keys for every chain and account (BIP-44)\n- Lose the phrase: lose all funds permanently. Share the phrase: lose all funds immediately\n- Same phrase on a different hardware wallet or software = same wallet\n\n**Private keys:**\n- A 256-bit random number is your private key; the public key is computed from it using ECDSA (secp256k1 curve)\n- Your Ethereum address is the last 20 bytes of the Keccak-256 hash of your public key\n- Never import a private key into MetaMask or any browser wallet — use the seed phrase only, and only on the hardware device\n\n**Backup methods (best to worst):**\n1. **Metal seed backup** (Cryptosteel, Bilodeau) — fireproof, waterproof, physically durable; store in a safe\n2. **Paper written by hand** — works but vulnerable to fire, flood, fading\n3. **Encrypted digital file** — Veracrypt-encrypted USB; only if you're confident in encryption\n4. **Brain wallet / memorised** — extremely high risk of permanent loss; not recommended\n\n**Passphrase (25th word):** An optional BIP-39 extension passphrase creates a completely separate set of wallets. Even if your 24 words are compromised, funds are safe behind the passphrase. Store passphrase separately from the seed words.\n\n**Multi-location strategy:** 2-of-3 or 3-of-5 Shamir's Secret Sharing splits the seed into pieces; any N pieces reconstruct the full seed; single pieces are useless alone. Unchained Capital and Casa offer multi-key custody services.`,

  sec_defi_security: `**DeFi security — protecting yourself in decentralised finance.**\n\n**The approval attack surface:**\n- Every token approval is a permission slip you give to a contract\n- An unlimited ERC-20 approval lets a contract drain all of that token at any future time\n- Drainer contracts use Permit2 (gasless approvals) or setApprovalForAll (NFTs) to drain entire wallets in one transaction\n- **Action:** Audit and revoke at revoke.cash, etherscan.io/tokenapprovalchecker, or Debank monthly\n\n**Transaction simulation:**\n- Use wallets with built-in simulation (Rabby, Frame, MetaMask updated) that show you exactly what will leave your wallet before you sign\n- Browser extensions: Fire (shows token flow), Pocket Universe, Revoke.cash browser extension\n- Never sign a blind transaction — if your wallet shows a hex blob with no decoded state, reject it\n\n**Smart contract risk tiers:**\n1. **Battle-tested** — Uniswap v3, Aave v3, MakerDAO: billions locked, years of use, multiple audits\n2. **Audited new** — new protocol with top-tier audit (Trail of Bits, Spearbit, Sherlock); use cautiously\n3. **Unaudited** — meme launches, fork-of-fork; treat as gambling\n\n**Protocol risk checklist:**\n- Is the contract verified on Etherscan?\n- Has it been audited by a reputable firm?\n- Is there a timelock on admin functions?\n- Is the team doxxed or does it have a legal entity?\n- Is there an active bug bounty?\n- Check Immunefi for active bounties\n\n**On-chain emergencies:**\n- If you suspect compromise: move funds to a fresh wallet immediately\n- Use a private mempool (Flashbots Protect, MEV Blocker) to prevent sandwich attacks on large swaps\n- Monitor wallets with Webacy, Sentio, or Forta for suspicious approvals`,

  sec_attack_patterns: `**Smart contract attack patterns** — the most common ways DeFi protocols get exploited.\n\n**Reentrancy:**\n- A malicious contract calls back into the victim contract before state is updated\n- Stole $60M from The DAO (2016); led to the Ethereum hard fork\n- Prevention: checks-effects-interactions pattern; ReentrancyGuard\n\n**Oracle manipulation:**\n- Attacker uses a flash loan to temporarily move a pool price, tricking a protocol that uses spot price as an oracle\n- Mango Markets ($114M, 2022); Euler Finance exploited oracle edge cases ($197M, 2023)\n- Prevention: use Chainlink/Pyth oracles, TWAPs, multiple price sources\n\n**Flash loan attacks:**\n- Uncollateralized instant capital allows amplified manipulation in a single transaction\n- Most flash loan exploits combine with oracle manipulation or governance attacks\n\n**Access control failures:**\n- Unprotected initialise functions, missing onlyOwner modifiers\n- Ronin bridge ($625M, 2022) — compromised validator keys\n- Prevention: OpenZeppelin AccessControl; thorough audit of privileged functions\n\n**Integer overflow/underflow:**\n- Mostly eliminated by Solidity 0.8+ built-in overflow checks; still a risk in older contracts or assembly\n\n**Logic errors:**\n- Algorithmic mistakes not caught by automated tools; require manual review\n- Euler Finance ($197M), Compound double-liquidation bug\n\n**Signature replay:**\n- Signed messages reused across chains or transactions\n- Prevention: EIP-712 typed data with chainId and nonce\n\n**Largest exploits by value (2020–2026):**\n| Protocol | Year | Amount | Vector |\n|---|---|---|---|\n| Poly Network | 2021 | $611M | Access control |\n| Ronin Bridge | 2022 | $625M | Compromised keys |\n| Wormhole | 2022 | $320M | Signature bypass |\n| Nomad Bridge | 2022 | $190M | Initialisation bug |\n| Euler Finance | 2023 | $197M | Logic error |\n| Multichain | 2023 | $126M | Compromised keys |`,

  sec_opsec: `**OPSEC (operational security) for high-value crypto holders.**\n\n**Wallet architecture — the holy trinity:**\n1. **Cold vault** — hardware wallet, never connected online; only for long-term storage. Receives funds but rarely sends.\n2. **Hot signing wallet** — software wallet (Rabby, MetaMask) with a small allowance for DeFi interaction. Funded from cold vault as needed.\n3. **Burner wallet** — fresh wallet per dApp or NFT mint; discarded after use. Zero approval surface.\n\n**Digital hygiene:**\n- Separate browser profile (or browser) exclusively for crypto — no social media, no unrelated extensions\n- Disable clipboard manager; malware swaps wallet addresses in clipboard\n- Never install wallet extensions via links in Discord or Twitter — only from official browser stores\n- Check for lookalike domains: uniswwap.io vs uniswap.io; bookmark every legitimate URL\n- Hardware 2FA (YubiKey) on email, exchanges, and ENS registrar\n\n**Network security:**\n- Never use public Wi-Fi for crypto transactions\n- VPN masks your IP from RPC providers and block explorers who log your address\n- Consider a dedicated device (cheap laptop or tablet) for all crypto activity\n\n**Physical security:**\n- Do not disclose your holdings publicly ("don't be the $5 wrench attack target")\n- Use PO Box or registered agent for hardware wallet delivery\n- Avoid photos of hardware devices posted online\n\n**$5 wrench attack:** Physical coercion to hand over keys — a real threat for known large holders. Multi-sig + duress wallets (holds a small decoy amount) mitigate this.\n\n**Estate planning:**\n- Document recovery information for heirs in a notarised legal letter stored with an estate attorney\n- Dead Man's Switch services (Vault12, Casa) send access instructions to designated people if you don't check in`,

  sec_wallet_recovery: `**Wallet recovery and what to do when things go wrong.**\n\n**Lost seed phrase:**\n- If you lose the seed phrase and the device: funds are permanently lost — there is no customer support\n- If you lose the seed phrase but still have the device: you can still transact as long as the device is functional; do NOT reset the device; back up the seed phrase immediately\n- Partial recovery: Seedsaver and Entropy Toolkit can brute-force a seed phrase with 1–3 missing words if you remember the rest\n\n**Lost hardware wallet (seed phrase intact):**\n- Buy a new device; restore from seed phrase; funds are safe\n- Someone else finding the physical device cannot access funds without the PIN (and the PIN wipes the device after 3 wrong attempts on Ledger/Trezor)\n\n**Compromised wallet (suspect breach):**\n1. Do NOT import the compromised seed into any new device — assume it is fully compromised\n2. Create a completely fresh seed phrase on a new device\n3. Move all assets to the new wallet immediately using a private RPC (Flashbots Protect) to prevent front-running\n4. If ETH/gas is also compromised, use a different wallet for gas (Flashbots has a free gas sponsorship for rescue transactions)\n5. Revoke all approvals from the compromised wallet after assets are moved\n\n**Social recovery (ERC-4337 smart accounts):**\n- Guardians (trusted friends, a hardware device, an institution) can collectively reset the signing key\n- No seed phrase to lose; losing one guardian device does not lose funds\n- Safe{Wallet}, Circle Modular Wallets, Argent support social recovery\n\n**Rescue services:**\n- Flashbots Rescuer: submit recovery transactions to a private mempool to prevent MEV bots from front-running asset moves from a compromised wallet`,

  sec_phishing: `**Phishing and social engineering — the most common way crypto is stolen.**\n\n**Phishing vectors:**\n- **Fake websites** — identical clones of Uniswap, OpenSea, MetaMask; spread via Google Ads (pay to rank above legit site), Twitter/X promoted posts, Discord announcements\n- **Malicious NFT airdrops** — ERC-721 with a token URI that shows a message like "Claim your prize at claim-uniswap.xyz"; interacting with it triggers a drainer\n- **Fake support** — searching "MetaMask support" or "Ledger support" shows SEO-optimised fake pages; MetaMask has no live support; no one from any project will DM you first\n- **Fake browser extensions** — MetaMask, Phantom lookalikes on Chrome Web Store; always install from the official URL\n- **Discord/Telegram compromise** — attacker takes over a project's Discord (via a compromised admin account) and posts a "mint is live" link to a drainer\n- **Clipboard hijacking** — malware silently replaces copied wallet addresses with the attacker's address; always verify the destination address after pasting\n\n**Drainer mechanics:**\n- **Permit/Permit2 drain** — you sign an off-chain EIP-712 message (no gas, looks harmless); the drainer submits it on-chain to transfer tokens without another approval\n- **setApprovalForAll drain** — one signature grants unlimited access to all NFTs in your wallet\n- **ETH transfer drain** — the "Connect Wallet" button on some sites triggers a transaction disguised as a gas fee\n\n**How to verify a site is legitimate:**\n1. Check the URL character by character — no homoglyphs (е vs e)\n2. Cross-reference on the project's official Twitter/Discord link-in-bio\n3. Use a simulation extension (Pocket Universe, Fire) that previews token flows before signing\n4. If it feels urgent (countdown timer, "limited mint"), that is the manipulation — slow down\n\n**Recovery after drainer:** If you were drained, report to Chainabuse.com and Twitter; trace the attacker address on Etherscan; contact the project team; recovery is rarely possible but blockchain forensics can trace funds.`,

  sec_onchain_forensics: `**Onchain forensics and blockchain analytics** — tracing funds and investigating wallets.\n\n**Why blockchains are traceable:**\n- All transactions are permanently public; addresses are pseudonymous (not anonymous)\n- Linking an address to a real identity via an exchange KYC, ENS name, public disclosure, or IP leak breaks pseudonymity permanently\n\n**Key analytics tools:**\n- **Chainalysis** — used by law enforcement worldwide; Reactor investigation platform; tracks stolen funds across hops and mixers; Chainalysis KYT for exchange compliance\n- **Elliptic** — competitor to Chainalysis; specialises in DeFi tracing and sanctions screening\n- **TRM Labs** — compliance tool for on-ramps and financial institutions\n- **Bubblemaps** — visual wallet clustering; shows token holder connections graphically; free tier; popular for meme coin investigation\n- **Nansen** — labels 250M+ wallets (exchange, whale, smart money, DEX trader); tracks portfolio movements; flow-of-funds analysis\n- **Arkham Intelligence** — public entity deanonymisation platform; ARKM token; "bounty" system for deanonymising wallets\n- **Breadcrumbs** — free visual transaction graph\n\n**Tracing methodology:**\n1. Start from the exploit/theft transaction\n2. Follow fund flows through hops (Tornado Cash, bridges, CEX deposits)\n3. Look for CEX deposit addresses (off-ramp points where KYC links to identity)\n4. Use cross-chain bridge tracing to follow funds across networks\n\n**Privacy tools (and their limits):**\n- Tornado Cash — sanctioned by OFAC (2022); effective mixer but fully traceable inflows/outflows via timing analysis in many cases\n- Railgun — ZK-based shielded pools; more privacy than Tornado Cash; used by "Ethereum's largest whale" according to Arkham\n- Monero (XMR) — ring signatures, stealth addresses, RingCT make tracing extremely difficult; most privacy-preserving major blockchain\n- Chain-hopping through multiple bridges with intermediate wallets significantly raises tracing difficulty`,

  wallet_advanced: `**Advanced wallet concepts** — beyond basic seed phrase wallets.\n\n**ERC-4337 Smart Accounts:**\n- Wallets are smart contracts; logic is programmable\n- Features: social recovery (replace lost keys via trusted parties), session keys (approve a dApp for X minutes), batched transactions, gas sponsorship (paymaster pays gas)\n- Implementations: Safe, Biconomy, Alchemy Account Kit, ZeroDev, Circle Modular Wallets\n\n**Multi-sig wallets:**\n- Require M-of-N key signatures to execute a transaction (e.g. 2-of-3)\n- Gold standard for DAO treasuries and protocol admin keys\n- Safe (formerly Gnosis Safe) holds $100B+ in assets\n\n**MPC wallets:**\n- Private key never exists as a whole; split between parties using threshold signatures\n- No seed phrase to lose; key shares refreshed periodically\n- Used by Circle Developer-Controlled Wallets, Fireblocks, Privy\n\n**Hardware security:**\n- Ledger / Trezor: private key stays on the device, never exposed to the PC\n- Passkeys (WebAuthn): device-based biometric authentication stored in a TEE; used by Circle Modular Wallets\n\n**Passphrase (25th word):** adds an extra layer to BIP-39 seed phrases; creates a completely different wallet set`,

  bridge_cctp_deep: `**CCTP (Cross-Chain Transfer Protocol) — deep dive** — Circle's canonical USDC bridging standard.\n\n**How burn-and-mint works:**\n1. User calls depositForBurn() on source chain — USDC is burned\n2. Circle's off-chain Attestation Service detects the burn and signs a message\n3. User (or relayer) submits the signed attestation to the destination chain\n4. receiveMessage() on the destination MessageTransmitter mints native USDC to the recipient\n\n**CCTP v1 vs v2:**\n- v1: Standard (~20 min); must manually relay attestation\n- v2 (2024): Fast Transfer mode (~2 sec) via Circle-operated "Fast Transfer" gateway; Hook support for composable actions\n\n**Supported chains (2026):** Ethereum, Base, Arbitrum, OP Mainnet, Polygon, Avalanche, Solana, Arc, Sui, Aptos, Near, Linea, zkSync — and more added regularly\n\n**Key contracts:**\n- TokenMessenger — initiates burns and mints\n- MessageTransmitter — handles cross-chain message passing\n- TokenMinter — mints native USDC on destination\n\n**Why CCTP is preferred for USDC:**\n- No wrapped or synthetic tokens — always native USDC on both ends\n- No liquidity pool risk — Circle backs the mint\n- No third-party bridge smart contract risk\n- Used by Stargate, Across, Uniswap, deBridge as their USDC routing layer\n\n**Circle's developer SDKs:** Bridge Kit, Gateway, and CCTP v2 SDK abstract away manual attestation relay`,

  bridge_layerzero_deep: `**LayerZero — deep dive** — the leading omnichain messaging protocol by volume.\n\n**Core architecture:**\n- Ultra Light Node (ULN) — a minimal on-chain endpoint on every chain; stores only block header hashes, not full state\n- DVN (Decentralised Verifier Network) — off-chain oracles that verify cross-chain messages; configurable per pathway\n- Executor — relayer service that delivers messages and pays destination gas\n- Endpoint contract deployed on 70+ chains\n\n**Message lifecycle:**\n1. Source app calls endpoint.send() with payload and destination\n2. DVNs observe the event and independently verify it\n3. Once DVN threshold is met, the Executor calls endpoint.lzReceive() on destination\n4. Destination app receives the verified payload\n\n**OFT (Omnichain Fungible Token):**\n- Single token supply managed across all chains via LayerZero messaging\n- Burns on source, mints on destination — true unified supply\n- Used by: STG (Stargate), USDC OFT wrapper, JOE, many DeFi protocols\n\n**Security model:**\n- DVNs are configurable per app — apps choose their own security providers\n- Default DVN set includes Google Cloud, Horizen Labs, and others\n- Criticism: security quality depends entirely on DVN selection; default may be weak for some paths\n\n**ZRO token:** governance + fee payment; launched June 2024; one of the most anticipated airdrops in crypto history\n\n**Notable integrations:** Stargate Finance, Radiant Capital, Angle Protocol, USDC OFT, Sushi cross-chain`,

  bridge_wormhole_deep: `**Wormhole — deep dive** — the dominant cross-chain bridge for Solana and multi-ecosystem assets.\n\n**Guardian network:**\n- 19 guardians (validators) including Jump Crypto, Staked, and other institutions\n- Each guardian independently observes source chains and signs Verified Action Approvals (VAAs)\n- 13-of-19 threshold required to produce a valid VAA\n- Guardians run full nodes on all supported chains\n\n**Message flow:**\n1. Source contract emits a cross-chain message\n2. Guardian network observes, signs, and aggregates signatures into a VAA\n3. Relayer submits the VAA to the destination chain\n4. Destination contract verifies the signature threshold and executes\n\n**NTT (Native Token Transfers):**\n- Wormhole's answer to LayerZero OFT\n- Tokens burn on source, mint on destination via attestation\n- Rate limiting, access control, and pause functionality built-in\n- Used by: W token itself, and growing list of protocols\n\n**The $320M hack (Feb 2022):**\n- Attacker exploited a signature verification bug on Solana side\n- Allowed minting 120,000 wETH without depositing collateral\n- Jump Crypto replenished the funds the same day — extraordinary backstop\n- Led to full security overhaul and Guardian network expansion\n\n**W token (2024):** governance token; 617M token airdrop to Solana and EVM users was one of the largest in history\n\n**Supported ecosystems:** Ethereum, Solana, BNB Chain, Polygon, Avalanche, Arbitrum, Base, Sui, Aptos, Cosmos (via IBC Gateway), Near`,

  bridge_ibc_cosmos: `**IBC and the Cosmos ecosystem** — the most mature trust-minimised cross-chain messaging system.\n\n**IBC (Inter-Blockchain Communication):**\n- Developed by Cosmos; first deployed 2021\n- Trust-minimised: uses light client verification instead of external validators\n- Each chain runs a light client of the counterparty; proves headers cryptographically\n- No oracle, no multi-sig — security is inherited from the chains themselves\n- Handles both token transfers and arbitrary message passing\n\n**IBC packet lifecycle:**\n1. Source chain commits an IBC packet with a timeout\n2. Relayer (off-chain, permissionless) submits the packet and a proof to destination\n3. Destination's ICS-23 light client verifies the proof against the source header\n4. Application logic executes; acknowledgement sent back\n\n**Cosmos Hub and ATOM:**\n- Hub-and-spoke model: Hub connects to many zones\n- ATOM stakers secure the Hub and earn staking rewards\n- ATOM staking: ~6-10% APR; 21-day unbonding period\n- Interchain Security (ICS): new chains can rent Hub security in exchange for revenue\n\n**Key Cosmos chains:** Osmosis (DEX), dYdX v4, Celestia, Neutron (smart contracts on ICS), Sei, Kujira, Secret Network, Injective, Evmos\n\n**IBC expanding beyond Cosmos:**\n- Polymer Protocol — IBC on Ethereum mainnet via ZK light clients\n- Picasso — IBC on Polkadot and Kusama\n- Near IBC — IBC connection to Near Protocol\n\n**Cosmos SDK:** The Go framework used to build IBC-compatible sovereign chains; powers Binance Chain, dYdX, Celestia, many others`,

  bridge_polkadot: `**Polkadot and the parachain model** — shared security through a relay chain architecture.\n\n**Architecture:**\n- Relay chain — the central security hub; validators secure it via NPoS (Nominated Proof of Stake)\n- Parachains — sovereign Layer 1 chains that lease a parachain slot and get shared security\n- Parathreads — pay-per-block model for chains that don't need constant block production\n- XCM (Cross-Consensus Messaging) — native message format between parachains\n\n**Parachain slot auctions:**\n- Slots auctioned via candle auction mechanism; typically 2-year leases\n- DOT tokens locked by crowdloan participants to fund a parachain's bid\n- Winners include Moonbeam (EVM), Acala (DeFi hub), Astar (dApps), Parallel Finance\n- Kusama — Polkadot's canary network; faster governance, real funds, experimental\n\n**Shared security model:**\n- Parachain validators are randomly assigned from the relay chain validator set\n- Guarantees each parachain has the same security as Polkadot itself\n- Eliminates the "bootstrap security" problem for new chains\n\n**DOT token:**\n- Governance (OpenGov — fully on-chain, referendum-based)\n- Validator staking and nominating\n- Parachain slot bonding\n- ~14% APY for nominators (varies)\n\n**Polkadot 2.0 (Agile Coretime):**\n- Replaces fixed parachain slot auctions with flexible "coretime" purchased monthly\n- Any project can buy bulk or on-demand core time\n- More accessible for small teams and experimental chains\n\n**Key parachains:** Moonbeam, Acala, Hydration (DeFi), Bifrost, Interlay (BTC DeFi), Nodle`,

  bridge_intent: `**Intent-based bridging and chain abstraction** — the next evolution beyond manual bridges.\n\n**What are intents?**\n- A user expresses a desired outcome ("I want 100 USDC on Arbitrum from my ETH on Mainnet") without specifying the execution path\n- Solvers compete to fill the intent optimally — they front the capital and are reimbursed atomically\n- Eliminates the multi-step manual bridge UX: approve, send, wait, receive\n\n**How intent-based bridges work:**\n1. User signs an intent (desired state transition) with a deadline and maximum slippage\n2. Solvers (specialized arbitrageurs) compete to fill the intent as fast as possible\n3. Winning solver fronts the destination funds from their own inventory\n4. Solver is reimbursed from the source chain atomically via an optimistic proof or ZK proof\n\n**Key protocols:**\n- **Across Protocol** — fastest EVM bridge; relayer-based; UMA optimistic oracle verifies fills; consistently ranks #1 on speed and fees\n- **UniswapX** — intent-based order routing for swaps + bridges; fillers compete to give best execution\n- **1inch Fusion** — Dutch auction order routing; gradually improves price if no filler fills immediately\n- **CoW Protocol** — Coincidence of Wants; matches orders peer-to-peer before routing to AMMs\n- **Relay Protocol** — gas-abstracted cross-chain execution; any token as gas on any chain\n\n**Chain abstraction:**\n- Next level: users interact from any chain with any app as if chains didn't exist\n- Near CHAIN Abstraction — sign one transaction, execute on any chain\n- Particle Network — Universal Account holds assets across all chains; single balance view\n- Circle Gateway — unified USDC balance across chains via Gateway Minter\n- ERC-7683 standard — cross-chain intent standard co-authored by Across and Uniswap; being adopted broadly\n\n**Why it matters:** Removes the single biggest UX friction in crypto — normal users should never think about which chain their money is on`,

  bridge_hacks: `**Bridge hacks and security history** — bridges have lost more funds than any other DeFi category.\n\n**The biggest bridge hacks (2021–2024):**\n| Bridge | Amount | Year | Attack type |\n|---|---|---|---|\n| Ronin (Axie) | $625M | 2022 | Validator key compromise (5/9 signers) |\n| Wormhole | $320M | 2022 | Signature verification bug on Solana |\n| Nomad | $190M | 2022 | Merkle proof misconfiguration — copy-paste hack |\n| Harmony Horizon | $100M | 2022 | 2-of-5 multi-sig compromise |\n| Poly Network | $611M | 2021 | Logic bug in cross-chain contract |\n| deBridge | $0 | 2022 | Phishing attempt (caught) |\n| BNB Bridge | $570M | 2022 | BSC Token Hub forge proof bug |\n\n**Root causes:**\n- **Multi-sig key compromise** — most common; weak operational security for bridge signers\n- **Smart contract bugs** — signature verification, Merkle proof, and access control flaws\n- **Oracle manipulation** — feeding false price/state data to bridge contracts\n- **Insufficient auditing** — many bridges deployed with minimal security review\n\n**Why bridges are high-value targets:**\n- Lock contracts hold billions in TVL — single target for massive theft\n- Complex cross-chain state is hard to formally verify\n- Bridge teams under pressure to ship fast\n\n**Security improvements since 2022:**\n- Trust-minimised designs (IBC, CCTP) eliminate multi-sig entirely\n- ZK light clients — mathematically verifiable without trusting a committee\n- Formal verification of bridge contracts growing\n- Insurance protocols (Nexus Mutual, UnoRe) cover bridge risk\n\n**User checklist:** Use CCTP for USDC; use canonical bridges for ETH/L2; check audits; limit bridge size to what you can afford to lose on third-party bridges`,

  bridge_chain_abstraction: `**Chain abstraction — the endgame for multi-chain UX** — making blockchain complexity invisible to users.\n\n**The problem:**\n- 100+ blockchains, each with separate wallets, gas tokens, addresses, bridges\n- A user wanting to buy an NFT on Base with funds on Solana needs: bridge to Base, acquire ETH for gas, approve, then buy — 4+ transactions across 2 chains\n- This is the #1 UX barrier for mainstream crypto adoption\n\n**Chain abstraction solutions (2026):**\n\n**Circle Gateway:**\n- Unified USDC balance across 11 EVM chains + Solana\n- depositFor() moves USDC from any chain into a unified Gateway balance\n- burn/mint via CCTP for instant cross-chain spending\n- No bridge UI — balances feel like a single pool\n\n**Particle Network:**\n- Universal Account — one address on all chains; single balance view\n- Universal Gas — pay gas in any token on any chain (USDC, USDT, ETH)\n- Universal Liquidity — unifies balances for cross-chain execution\n- L1 settlement layer coordinates cross-chain state\n\n**Near Protocol Chain Abstraction:**\n- Chain Signatures — Near validators sign transactions for any chain\n- A Near account can own and control ETH, BTC, Solana wallets without bridges\n- NEAR intent relayers execute multi-chain transactions atomically\n\n**ERC-7683 Cross-Chain Intent Standard:**\n- Proposed standard by Across + Uniswap Labs\n- Unified intent format; any solver can fill any chain-abstraction intent\n- Prevents fragmentation of the intent-filler market\n\n**Agoric Orchestration:**\n- IBC-based orchestration; a single smart contract call triggers actions across multiple Cosmos chains\n\n**Where we are in 2026:** Early infrastructure phase — chain abstraction works but UX is still being refined; mainnet products live from Particle, Near, and Circle Gateway`,

  layer0: `**Layer 0 (L0)** refers to infrastructure that sits beneath Layer 1 blockchains — providing cross-chain communication, shared security, or interoperability.\n\n**Key projects:**\n- **Polkadot** — relay chain provides shared security for parachains; XCM messaging between parachains\n- **Cosmos** — IBC (Inter-Blockchain Communication) protocol; hub-and-spoke model with sovereign chains; ATOM staking secures the hub\n- **LayerZero** — omnichain messaging protocol; connects 70+ chains via ultra-light nodes and oracles; ZRO token\n- **Wormhole** — cross-chain messaging; large TVL bridged; suffered $320M hack in 2022\n- **Chainlink CCIP** — Cross-Chain Interoperability Protocol; enterprise-grade messaging with defense-in-depth\n- **Avail** — data availability layer that any chain can use to publish block data cheaply\n\n**Why it matters:** As chains proliferate, L0 infrastructure determines how capital and data flow between ecosystems. Fragmentation is the cost; composability across chains is the goal.`,

  evm_ecosystem: `**The EVM (Ethereum Virtual Machine) ecosystem** encompasses all chains that run the same bytecode as Ethereum, enabling code portability and tooling reuse.\n\n**Major EVM chains:**\n- **Ethereum** — the original; highest security, TVL, and developer activity\n- **Base** — Coinbase's OP Stack L2; fastest growing ecosystem in 2024–2025; home to Aerodrome DEX, Clanker memes, Farcaster apps\n- **Arbitrum** — largest L2 by TVL; GMX, Camelot, Radiant, Pendle\n- **Optimism** — OP Stack parent; Superchain vision; Velodrome, Synthetix\n- **Polygon PoS** — EVM sidechain; major brands (Starbucks, Reddit) used it for NFTs\n- **zkSync Era** — ZK rollup; native account abstraction\n- **Scroll** — ZK rollup; bytecode-equivalent; privacy-focused community\n- **BNB Smart Chain** — Binance's EVM chain; low fees; PancakeSwap; popular with retail\n- **Avalanche C-Chain** — EVM subnet; fast finality; Trader Joe, GMX\n- **Arc** — USDC-native gas, sub-second finality, EVM-compatible\n\n**Tooling:** all EVM chains share Solidity/Vyper, Hardhat/Foundry, Ethers.js/viem, MetaMask — write once, deploy anywhere with minor config changes.`,

  // ── CEX deep-dive topics ─────────────────────────────────────────────────────
  cex_security_hacks: `**CEX security and major hacks** — the custodial model's biggest risk is catastrophic loss of user funds.\n\n**Major hacks and collapses:**\n- **Mt. Gox (2014)** — handled 70% of all Bitcoin trading; 850,000 BTC stolen over years; $450M loss at 2014 prices; bankruptcy; creditors repaid in 2024 after a decade-long legal battle\n- **Bitfinex (2016)** — 120,000 BTC stolen ($72M at the time; ~$8B at peak); repaid via UNUS SED LEO token buybacks; hackers Ilya Lichtenstein and Heather Morgan arrested 2022\n- **Coincheck (2018)** — $534M in NEM stolen from a hot wallet; largest crypto hack at the time; Monex acquired Coincheck\n- **KuCoin (2020)** — $281M stolen; most recovered via project contract upgrades; "world's most secure crypto exchange" reputation tested\n- **FTX (2022)** — not a hack but fraud; $8B+ in user funds misappropriated; SBF convicted 2023; sentenced to 25 years\n- **HTX/Heco (2023)** — Justin Sun-linked exchange; $115M drained\n- **DMM Bitcoin (2024)** — Japanese CEX; $305M in BTC stolen from hot wallet\n\n**What good security looks like:**\n- 95–98% of funds in cold storage (Coinbase holds 98%)\n- Multi-sig cold wallets with geographically distributed key holders\n- Real-time transaction monitoring and anomaly detection\n- Bug bounty programs and regular third-party penetration tests\n- Proof of Reserves (PoR) audits with Merkle tree verification\n- Insurance funds (Binance SAFU: $1B+)\n\n**Red flags:** No PoR, offshore registration with no regulation, unknown team, history of withdrawal freezes.`,

  cex_trading_features: `**CEX trading features** — modern exchanges offer far more than simple spot trading.\n\n**Order types:**\n- **Market order** — execute immediately at best available price; guaranteed fill, not price\n- **Limit order** — execute only at your specified price or better; can sit in the book for days\n- **Stop-loss** — triggers a market or limit sell when price drops to a threshold\n- **Stop-limit** — triggers a limit order (not market) at the stop price; can miss fills in fast markets\n- **OCO (One-Cancels-Other)** — pair of orders; if one fills, the other is cancelled automatically\n- **TWAP/VWAP** — algorithmic orders that split large trades over time to minimise market impact\n- **Trailing stop** — stop price moves with the market; locks in profit on a rally\n\n**Spot vs margin vs futures:**\n- **Spot** — immediate settlement; you own the underlying asset\n- **Margin** — borrowed capital to increase position size; 2–10x; liquidation risk; interest charged\n- **Perpetual futures** — no expiry; funding rate mechanism; up to 125x on some exchanges; most popular derivative\n- **Quarterly futures** — expire on a fixed date; basis trade opportunity (futures premium vs spot)\n\n**Copy trading:** Follow top traders and mirror their positions automatically; popular on Bybit, OKX, Bitget.\n\n**Bot trading:** Grid bots, DCA bots, and arbitrage bots available natively on KuCoin, Binance, OKX. No coding required; runs 24/7.\n\n**OTC desks:** For trades >$50K–$1M; negotiate price off the order book; no slippage; used by institutions.`,

  cex_fiat_onramps: `**CEX fiat on/off ramps** — how real-world money enters and exits the crypto ecosystem through centralised exchanges.\n\n**Deposit methods:**\n- **Bank transfer (ACH/SEPA/SWIFT)** — lowest fees (0–0.5%); ACH free in US; SEPA free in EU; SWIFT can cost $15–50\n- **Credit/debit card** — instant but expensive (1.5–3.99%); some banks block crypto purchases\n- **PayPal/Apple Pay/Google Pay** — available on select exchanges (Coinbase, eToro); convenience premium\n- **Cash (ATMs)** — Bitcoin ATMs in 80+ countries; fees typically 8–15%; high but accessible\n- **P2P markets** — user-to-user trades (Binance P2P, KuCoin P2P); pay any method the seller accepts; popular in countries without banking access\n\n**Withdrawal methods:**\n- **Bank transfer** — most reliable; 1–5 business days in US; same-day in SEPA zone\n- **PayPal/Venmo** — Coinbase supports this for US users; instant\n- **Debit card** — instant settlement in local currency; Coinbase Card, Binance Card, Crypto.com Visa\n- **Stablecoin to a payment app** — some users prefer USDC → Stripe → bank\n\n**Fiat availability by region:**\n- **US:** ACH (Coinbase, Kraken), wire; many payment methods restricted by state\n- **Europe:** SEPA widely available on all major exchanges; fastest region for fiat flow\n- **LatAm/Africa/SEA:** P2P markets dominant; USDT on Tron is a de facto parallel banking system\n- **Restricted regions:** sanctions-blocked countries have no official access; VPN use violates ToS\n\n**KYC tiers:** Most exchanges have tiered KYC — Tier 0 (email only) limited to small withdrawals; Tier 1 (ID) unlocks higher limits; Tier 2 (address proof) for large withdrawals and fiat.`,

  cex_regulation: `**CEX regulation and licensing** — the global patchwork of rules governing centralised exchanges.\n\n**United States:**\n- No single federal crypto exchange licence; exchanges register with FinCEN as MSBs (Money Service Businesses)\n- Must obtain a **Money Transmitter Licence (MTL)** in each state (50 states = 50 licences)\n- **New York BitLicence** — most stringent state licence; few exchanges hold it (Coinbase, Gemini, Kraken, Bitstamp)\n- SEC vs CFTC jurisdiction debate: securities (SEC) vs commodities (CFTC)\n- **FIT21 (2024)** — Financial Innovation and Technology for the 21st Century Act; attempted to clarify SEC/CFTC jurisdiction; still contested\n\n**European Union:**\n- **MiCA (Markets in Crypto-Assets Regulation)** — fully in force 2024; EU-wide licence replaces 27 national regimes\n- CASPs (Crypto Asset Service Providers) need MiCA licence to operate in the EU\n- Stablecoin issuers > €200M daily volume face caps under MiCA\n\n**United Kingdom:**\n- FCA registration required; AML/KYC rules strictly enforced\n- Binance UK effectively shut down; Bybit UK withdrew; Coinbase, Kraken fully registered\n\n**Singapore (MAS):**\n- Major Payment Institution (MPI) licence under PSA; Singapore is crypto-friendly but strict\n- Coinbase, Crypto.com, OKX, Gemini licensed; Binance SG shut down\n\n**Dubai (VARA):**\n- Virtual Asset Regulatory Authority licence; Dubai actively courts crypto firms\n- Binance, OKX, Bybit have Dubai licences\n\n**Offshore (Seychelles, BVI, Cayman):**\n- Minimal regulation; used by Binance, OKX, Bybit historically\n- Trend: regulatory pressure forcing offshore exchanges to onshore or exit\n\n**KYC/AML requirements:** All regulated CEXs must verify identity, screen against sanctions lists (OFAC, UN), and report suspicious transactions to regulators (SARs).`,

  cex_exchange_tokens: `**Exchange tokens** — CEX-issued native tokens that give fee discounts, governance rights, and ecosystem utility.\n\n**BNB (Binance Coin)**\n- Market cap: top 5 overall; one of the most successful exchange tokens\n- Originally an ERC-20; migrated to BNB Chain (Binance's own EVM-compatible blockchain)\n- 25% fee discount on Binance when paying fees in BNB\n- Quarterly token burns based on trading volume → deflationary\n- Powers the BNB Smart Chain ecosystem (PancakeSwap, Venus, etc.)\n\n**OKB (OKX)**\n- Native token of OKX; fee discounts, staking, OKX Jumpstart (launchpad)\n- OKX Chain (now OKX X1 L2) uses OKB\n\n**BGB (Bitget)**\n- Fee discounts, copy trading perks, Bitget Launchpad access\n- Part of a regular buyback and burn programme\n\n**KCS (KuCoin Shares)**\n- Holders receive a daily KCS dividend — 50% of trading fee revenue distributed to KCS holders\n- Fee discounts and KuCoin Spotlight (launchpad) access\n\n**GT (Gate.io Token)**\n- Fee discounts, launchpad, lending; Gate.io is one of the widest-selection exchanges\n\n**CRO (Crypto.com)**\n- Stake CRO to unlock higher tiers of the Crypto.com Visa card (up to 5% cashback, Spotify/Netflix rebates)\n- Powers the Cronos EVM chain\n\n**Why exchange tokens matter:**\n- Fee savings can be significant for active traders\n- Buyback-and-burn models create deflationary pressure\n- Exchange tokens often correlate with exchange trading volumes — a proxy for exchange health\n- Risk: if the exchange collapses (e.g. FTT/FTX), the token goes to near-zero`,

  cex_derivatives: `**CEX derivatives trading** — the dominant product category by volume in centralised crypto markets.\n\n**Market size:** Crypto derivatives account for ~70–80% of total CEX volume; Binance alone does $50B+ in daily derivatives volume.\n\n**Perpetual futures (perps):**\n- No expiry; most popular derivative globally; can be long or short\n- **Funding rate** mechanism keeps perp price anchored to spot: if longs dominate, longs pay shorts; if shorts dominate, shorts pay longs\n- Common funding intervals: every 8 hours; annualised rate shown as APR\n- Maximum leverage: Binance 125x, Bybit 100x, OKX 100x, Kraken 50x\n- Major pairs: BTC/USDT perp (highest volume); ETH/USDT; SOL, BNB, XRP, DOGE perps\n\n**Quarterly futures:**\n- Expire on a fixed date (end of quarter); settle to spot index price at expiry\n- **Basis trade:** when futures trade at a premium to spot, buy spot + short futures to lock in risk-free yield (popular with institutions)\n\n**Options:**\n- **Deribit** — dominates institutional crypto options; BTC and ETH options; 80%+ market share\n- **CME** — regulated futures and options; used by US institutions and ETF hedgers\n- **Binance, OKX, Bybit** — offer options but with lower liquidity vs Deribit\n- Key terms: strike price, expiry, call/put, implied volatility (IV), delta, gamma, max pain\n\n**Liquidations:**\n- Leveraged positions are liquidated when margin falls below maintenance level\n- Mass liquidations ("liquidation cascades") can cause sharp price moves\n- Track live liquidations on Coinglass.com — a key sentiment indicator\n\n**Funding rate as a market signal:** Persistently high positive funding = overleveraged longs = potential crash; negative funding = shorts piling in = potential short squeeze.`,

  cex_institutional: `**Institutional crypto services** — how banks, hedge funds, and corporates access crypto through CEXs.\n\n**Prime brokerage:**\n- **Coinbase Prime** — most US institutions; custody, OTC trading, staking, portfolio reporting\n- **Binance Institutional / VIP** — volume-based fee tiers, dedicated account managers, OTC desk\n- **Kraken OTC** — for block trades; settlement directly into Kraken account or to external wallet\n- **FalconX, Hidden Road, Nonco** — specialist crypto prime brokers\n\n**Custody solutions:**\n- Exchanges offer institutional custody as a separate product\n- **Coinbase Custody** — SOC 2 Type II certified; holds $100B+ in assets; used by BlackRock IBIT Bitcoin ETF\n- **Fidelity Digital Assets, BitGo, Anchorage Digital** — regulated custodians\n- **Qualified custodian** status required for US registered investment advisers (RIA) under SEC rules\n\n**Regulated products:**\n- **CME Bitcoin and Ether futures** — most institutionally used; regulated by CFTC; cash-settled\n- **Spot Bitcoin ETFs (US, 2024)** — BlackRock IBIT, Fidelity FBTC, ARK 21Shares; $50B+ AUM quickly\n- **Spot Ether ETFs (US, 2024)** — smaller AUM; include staking yield debate\n- **MicroStrategy (MSTR)** — public company holding 200,000+ BTC; a leveraged Bitcoin proxy for TradFi\n\n**Corporate treasury adoption:**\n- MicroStrategy, Block, Tesla (partial), Metaplanet, Semler Scientific hold BTC on balance sheet\n- Bitcoin seen as a treasury reserve asset vs dollar inflation\n\n**Reporting and compliance:** Institutions use Chainalysis, TRM Labs, or Elliptic for on-chain transaction monitoring; CoinTracker, Lukka, TaxBit for regulatory reporting.`,

  cex_vs_dex: `**CEX vs DEX: which to use and when**\n\n| Factor | CEX | DEX |\n|---|---|---|\n| Custody | Exchange holds funds | You hold funds |\n| KYC | Required | Not required |\n| Fiat | Yes (card, bank) | No (crypto only) |\n| Fees | Low (0.02–0.1%) | Medium (0.01–0.3% + gas) |\n| Speed | Instant (off-chain) | Seconds–minutes (on-chain) |\n| Token selection | Curated list | Any token with liquidity |\n| Leverage | Up to 125x | Up to 50x (perp DEXs) |\n| Transparency | Opaque | Fully auditable on-chain |\n| Risk | Counterparty, regulatory | Smart contract, MEV |\n\n**Use a CEX when:** you need fiat rails, high-volume trading at low cost, or margin/futures.\n\n**Use a DEX when:** trading new tokens before CEX listing, avoiding KYC, moving large onchain positions, or using protocols not available on CEX.\n\n**Hybrid (CeDeFi) trend:** Some protocols bridge the gap — Coinbase's Base chain, Binance's BNB Chain, and dYdX's appchain blur the line between centralised infrastructure and onchain settlement.`,

  nft: `**NFTs (Non-Fungible Tokens)** are unique digital assets verified on a blockchain. Unlike fungible tokens, each NFT has a distinct identity. ERC-721 is the standard on Ethereum; ERC-1155 supports both fungible and non-fungible tokens in one contract.\n\n**Use cases:**\n- Digital art and collectibles\n- Gaming items and skins\n- Music and IP rights\n- Event tickets and memberships\n- Real-world asset tokenization\n\n**Markets:** OpenSea, Blur, Zora, Magic Eden`,

  wallet: `A **crypto wallet** stores private keys that give you control over your onchain assets.\n\n**Types:**\n- **Hot wallets** — browser extensions (MetaMask, Rabby) or mobile apps; convenient but online\n- **Hardware wallets** — Ledger, Trezor; offline and highly secure\n- **Smart Account wallets** — ERC-4337 programmable accounts; support gasless transactions, social recovery, batch transactions\n- **MPC wallets** — key split across multiple parties; enterprise-grade security\n\nNever share your private key or seed phrase with anyone.`,

  gas: `**Gas** is the fee paid to network validators to execute transactions on EVM-compatible chains. Gas is priced in Gwei (1 Gwei = 10⁻⁹ ETH). Fees = gas used × gas price.\n\n**EIP-1559** (Ethereum) split fees into a burned base fee and an optional priority tip.\n\n**On Arc**, the native gas token IS USDC — fees are paid directly in USDC, making costs stable and predictable with no separate native token needed.\n\n**Layer 2s** (Arbitrum, Base, Optimism) offer fees 10–100x cheaper than Ethereum mainnet.`,

  staking: `**Staking** involves locking tokens to help secure a proof-of-stake network, earning rewards in return.\n\n**Options:**\n- **Solo staking** — 32 ETH minimum, run your own validator\n- **Liquid staking** — Lido (stETH), Rocket Pool (rETH); stake any amount, receive a liquid receipt token\n- **Centralized staking** — via exchanges; easier but less decentralized\n\nAPYs typically range from 3–6% for ETH, varying by network activity. Staking rewards come from transaction fees and new token issuance.`,

  blockchain: `A **blockchain** is a distributed ledger — a chain of blocks, each containing a batch of transactions, cryptographically linked to the previous block. This structure makes data tamper-evident without requiring a central authority.\n\n**Types:**\n- **Public** — permissionless, anyone can participate (Bitcoin, Ethereum)\n- **Private** — permissioned, enterprise use cases\n- **Consortium** — semi-decentralized, multiple organizations\n\n**Consensus mechanisms:** Proof-of-Work, Proof-of-Stake, Delegated PoS, Proof-of-History, BFT variants.`,

  mining: `**Mining** is the process of validating transactions on a proof-of-work blockchain (like Bitcoin) by solving computational puzzles. Miners compete to add the next block and earn block rewards plus transaction fees.\n\n**Key concepts:**\n- **Hash rate** — total computational power securing the network\n- **Difficulty** — adjusts every 2016 blocks to keep block time ~10 min\n- **ASIC** — specialized mining hardware\n- **Mining pool** — miners combine hash power to share rewards\n\nEthereum no longer uses mining — it uses proof-of-stake since The Merge (2022).`,

  solana: `**Solana (SOL)** is a high-performance proof-of-stake blockchain known for fast speeds and very low fees.\n\n**Key stats:**\n- TPS: ~65,000 theoretical, ~2,000–3,000 in practice\n- Block time: ~400ms\n- Fees: fractions of a cent\n- Consensus: Proof-of-History + Tower BFT\n\n**Ecosystem:** Popular for gaming, DeFi, high-frequency trading, and NFTs. Key programs: Jupiter (DEX aggregator), Marinade (liquid staking), Magic Eden (NFTs).`,

  arc: `**Arc** is Circle's blockchain where USDC is the native gas token. All transaction fees are paid directly in USDC — no need to hold a separate native token.\n\n**Key advantages:**\n- Sub-second finality\n- Predictable, stable gas costs (denominated in USDC)\n- EVM-compatible — all Ethereum tooling works\n- Ideal for payment apps, DeFi, and AI agent applications\n\nArc Testnet is available for development. USDC bridging via CCTP is natively supported.`,

  layer2: `**Layer 2 (L2)** networks are scaling solutions built on top of Ethereum. They process transactions off-chain and post proofs or data back to L1.\n\n**Types:**\n- **Optimistic Rollups** (Arbitrum, Optimism, Base) — assume transactions are valid, 7-day fraud proof window\n- **ZK Rollups** (zkSync Era, Starknet, Scroll) — cryptographic validity proofs, faster finality\n\n**Benefits:** 10–100x cheaper fees, faster throughput, inherit Ethereum security.\n\n**Tradeoffs:** Withdrawal delays (Optimistic), higher prover costs (ZK).`,

  cctp: `**CCTP (Cross-Chain Transfer Protocol)** is Circle's native USDC bridging protocol.\n\n**How it works:**\n1. USDC is burned on the source chain\n2. Circle's attestation service signs the burn event\n3. Native USDC is minted on the destination chain\n\n**Benefits:** No wrapped tokens, no liquidity pool risk, native USDC on both ends.\n\n**Supported chains:** Ethereum, Base, Arbitrum, Polygon, Solana, Arc, Avalanche, OP Mainnet, and more.`,

  seed: `A **seed phrase** (mnemonic/recovery phrase) is a 12- or 24-word sequence that encodes your wallet's master private key using BIP-39 standard words.\n\n**Security rules:**\n- Never share it with anyone — ever\n- Store offline (paper, metal backup)\n- Never enter it on any website or app\n- Use a hardware wallet for large holdings\n- Consider a passphrase (25th word) for extra security\n\nAnyone with your seed phrase has full control of all wallets derived from it.`,

  smart_contract: `A **smart contract** is self-executing code deployed on a blockchain. Once deployed, it runs exactly as programmed.\n\n**Properties:**\n- Immutable (unless upgradeable proxy pattern is used)\n- Deterministic — same inputs always produce same outputs\n- Transparent — code is publicly readable on-chain\n- Trustless — no intermediary needed\n\n**Languages:** Solidity (Ethereum/EVM), Rust (Solana), Cairo (Starknet)\n\n**Security:** Audits are critical — bugs are irreversible. Major exploit types: reentrancy, integer overflow, access control flaws.`,

  gov_dao_mechanics: `**DAO mechanics and lifecycle** — how decentralised autonomous organisations actually function.\n\n**What is a DAO?**\nA DAO is an internet-native organisation whose rules are encoded in smart contracts. Membership and voting power are typically represented by a token. There is no CEO — governance decisions are made by token holders voting on-chain or off-chain.\n\n**DAO lifecycle:**\n1. **Bootstrap** — core team writes contracts, distributes tokens via airdrop/sale/mining, seeds treasury\n2. **Launch governance** — deploy Governor contract (Compound Governor Bravo, OpenZeppelin Governor, Aragon), set quorum and voting period\n3. **Active governance** — community submits proposals; forums (Discourse, Commonwealth, Snapshot) for discussion; Snapshot for signalling; on-chain vote for execution\n4. **Treasury management** — DAO allocates capital to grants, protocol incentives, investments, operations\n5. **Maturation or failure** — successful DAOs build contributor ecosystems; failed DAOs suffer from voter apathy, treasury drain, or governance attacks\n\n**Governance lifecycle of a proposal:**\n1. Idea posted to forum for community discussion (1–2 weeks)\n2. Temperature check vote (Snapshot, off-chain, no cost)\n3. Formal on-chain proposal submitted (requires token threshold)\n4. Voting period (typically 3–7 days)\n5. If passed: timelock delay (1–48 hours) before execution\n6. Automatic smart contract execution or multi-sig execution\n\n**Timelock:** A mandatory delay between passing a vote and execution. Gives users time to exit if they disagree. Standard for all major DAOs.`,

  gov_voting_systems: `**On-chain and off-chain voting systems** — how DAOs collect and count votes.\n\n**Off-chain voting:**\n- **Snapshot** — the dominant tool; gasless EIP-712 signed votes; supports token-weighted, quadratic, ranked choice, conviction; not directly executable — requires a multi-sig to implement\n- **Tally** — aggregates on-chain governance data; shows voting history, delegate profiles, and live proposal state\n- **Commonwealth** — discussion + polling platform; used by Osmosis, Juno, and many Cosmos chains\n\n**On-chain voting frameworks:**\n- **Compound Governor Bravo** — the original; 1 token = 1 vote; proposals execute automatically after timelock; used by Compound, Uniswap\n- **OpenZeppelin Governor** — modular, audited, extensible; most new protocols use this\n- **Aragon OSx** — plugin architecture; supports multisig, token-voting, and custom plugins; used by 6,000+ DAOs\n- **Tally Governor** — forks of OZ Governor with enhanced UI\n\n**Voting mechanisms:**\n- **Token-weighted (plutocratic)** — 1 token = 1 vote; most common; criticised for whale dominance\n- **Quadratic voting** — cost of N votes = N squared tokens; more egalitarian; vulnerable to Sybil attacks\n- **Conviction voting** — vote weight grows over time as you hold a position; rewards patient participants; used by Gardens/1Hive\n- **Dual-token / bicameral** — two chambers with different powers; Optimism's Token House (OP token) + Citizens House (Soulbound attestations)\n- **Delegated voting** — token holders assign votes to experts/delegates who vote on their behalf; used by Uniswap, ENS, Gitcoin\n\n**Quorum:** Minimum % of total supply that must vote for a proposal to be valid. Too high = nothing passes. Too low = small groups decide.`,

  gov_tooling: `**DAO tooling and infrastructure** — the software stack powering decentralised governance.\n\n**Treasury management:**\n- **Safe (formerly Gnosis Safe)** — the standard DAO multi-sig; M-of-N signers; used by 99% of DAO treasuries for operational funds\n- **Llama** — treasury management platform for on-chain entities; spending policies, streams, and permissions\n- **Enzyme Finance** — on-chain fund management with permissioned strategies\n- **Karpatkey** — treasury management DAO managing Gnosis, Balancer, ENS, CoW Protocol treasuries\n\n**Payments and payroll:**\n- **Superfluid** — real-time token streaming; DAOs pay contributors by the second\n- **Sablier** — token vesting and streaming\n- **Request Finance** — crypto invoicing and payroll for DAOs\n\n**Contributor management:**\n- **Coordinape** — peer-to-peer compensation; team members allocate GIVE tokens to each other; converts to token rewards\n- **Dework** — task management with on-chain bounties; replaces Jira/Trello for DAOs\n- **Charmverse** — all-in-one DAO workspace (docs, bounties, proposals, forums)\n\n**Communication:**\n- **Discord** — dominant for community chat; bot-gated token-holder roles\n- **Discourse** — long-form proposal discussion; most major protocols run a forum.protocol.xyz subdomain\n- **Farcaster / Lens** — decentralised social layers used by some governance communities\n\n**Analytics:**\n- **DeepDAO** — DAO analytics; tracks treasury size, members, proposals, activity\n- **Messari Governor** — governance analytics for major protocols`,

  gov_major_daos: `**Major DAO profiles — 2026** — the most significant decentralised governance structures.\n\n**Uniswap DAO:**\n- Governs the world's largest DEX; $1B+ treasury in UNI tokens\n- Key decisions: fee switch (direct LP fees to UNI stakers), Foundation funding, new chain deployments\n- Governance participation notoriously low (~5% quorum); dominated by a16z and Paradigm delegation\n- 2024 fee switch finally activated on select pools\n\n**MakerDAO / Sky:**\n- Governs DAI/USDS issuance; manages $5B+ in RWA collateral\n- MKR holders vote on collateral types, stability fees, DAI Savings Rate\n- 2023 "Endgame" rebrand to Sky Protocol; MKR → SKY, DAI → USDS migration\n- Pioneer of sustainable DAO treasury management\n\n**Arbitrum DAO:**\n- ARB token governs $3B+ treasury and Arbitrum One/Nova/Orbit protocol\n- Security Council: 12-of-19 multi-sig with power to emergency-patch without vote\n- Controversial 1B ARB "AIP-1" treasury allocation caused community backlash in 2023\n- Active delegate ecosystem; Tally + Snapshot combination\n\n**Optimism Collective:**\n- Bicameral: Token House (OP token holders) + Citizens House (Soulbound attestation holders)\n- Retroactive Public Goods Funding (RetroPGF) — most innovative governance experiment; distributes millions to open-source builders\n- Governs Superchain protocol upgrades and treasury\n\n**ENS DAO:**\n- Governs .eth domain registrar and ENS Protocol\n- Active constitutional governance; elected stewards per working group\n- Model for well-run protocol DAO with clear mandates and accountability\n\n**Nouns DAO:**\n- One Noun NFT auctioned daily; each NFT = one vote; infinite DAO\n- On-chain proposals execute automatically; treasury funded entirely by daily auction proceeds\n- Inspired dozens of "Nounish" derivative DAOs`,

  gov_attacks: `**Governance attacks and vulnerabilities** — how DAOs can be exploited or manipulated.\n\n**Flash loan governance attacks:**\n- Attacker borrows a large amount of governance tokens, votes on a malicious proposal, repays in the same transaction\n- Famous example: Beanstalk Protocol (2022) — attacker flash-loaned enough BEAN tokens to pass a malicious proposal donating all $182M in treasury to themselves, then repaid the loan\n- Prevention: vote snapshot at proposal creation block (not at voting time), timelock flash-loan restrictions\n\n**Low quorum manipulation:**\n- Proposals pass with tiny % of supply voting; attacker accumulates enough tokens to reach quorum and pass a favourable proposal\n- Common when governance participation is low (common in all DAOs)\n- Prevention: raise quorum requirements, guardian veto period\n\n**Governance takeover via token accumulation:**\n- Slowly accumulate governance tokens over time; control enough to pass or block any proposal\n- Curve Wars: Convex accumulated enough veCRV to effectively control Curve gauge emissions\n- This is technically legal — it is how the protocol was designed\n\n**Proposal spam:**\n- Flood governance with low-quality proposals to waste delegate attention\n- Prevention: proposal threshold (must hold minimum tokens to submit)\n\n**Time pressure attacks:**\n- Submit proposal during holiday periods or conference weekends when voter attention is low\n- Prevention: standard voting periods with predictable schedules\n\n**Malicious upgrades:**\n- Pass a proposal that upgrades a contract to a malicious implementation\n- Prevention: 48h+ timelocks, security council veto power, code review requirements in proposal templates`,

  gov_legal: `**DAO legal structures and real-world compliance** — how DAOs deal with the real world.\n\n**The problem:**\n- DAOs by default are unincorporated general partnerships — every token holder could technically be personally liable for DAO actions\n- Many jurisdictions treat DAO tokens as securities; operating an unstructured DAO may trigger securities laws\n\n**Legal wrapper options:**\n- **Wyoming DAO LLC** — first US state to recognise DAOs as LLCs (2021); limited liability; Compound, CityDAO used this structure\n- **Marshall Islands LLC** — offshore DAO LLC; used by Uniswap Foundation\n- **Foundation (Cayman Islands, Panama, BVI)** — non-profit foundation holds protocol IP; used by many DeFi protocols (Uniswap Foundation, Ethereum Foundation)\n- **Swiss Association/Foundation** — common for European DAOs; Cardano Foundation, Ethereum Foundation\n- **Delaware LLC with governance overlay** — traditional LLC with token-based governance rights layered on top\n\n**LAO model:**\n- LAOs (Limited Liability Autonomous Organizations) combine smart contract governance with a Delaware LLC\n- Members have limited liability; investments can be made in both crypto and traditional assets\n\n**Tax implications:**\n- DAO treasury income may be taxable depending on jurisdiction and structure\n- Token distributions to contributors are typically taxable as income\n- US: DAO LLCs pass through income to members proportionally\n\n**OFAC sanctions risk:**\n- Tornado Cash DAO governance token holders were initially included in OFAC sanctions (2022); later narrowed\n- DAOs operating infrastructure subject to sanctions are at risk even if decentralised`,

  gov_contributor_model: `**Sub-DAOs, working groups, and contributor models** — how large DAOs organise human work.\n\n**The contributor problem:**\n- Token-weighted voting is inefficient for day-to-day operations\n- Large DAOs cannot run everything by vote — decisions need to be delegated\n- Solution: elected working groups with mandates and budgets\n\n**Working groups / guilds:**\n- Bounded sub-organisations with a specific mandate (engineering, treasury, grants, marketing)\n- Funded by DAO vote; operate semi-autonomously within their mandate\n- Examples: ENS DAO working groups (Ecosystem, MetaGovernance, Public Goods), Gitcoin workstreams\n\n**Sub-DAOs:**\n- Autonomous child DAOs spun off from a parent DAO\n- Parent DAO funds + has veto; child DAO operates independently\n- Allows experimentation without risking the whole protocol\n- Example: MakerDAO's SubDAOs (Spark, Aligned Delegate Ecosystem)\n\n**Contributor compensation:**\n- **Streaming** (Superfluid/Sablier) — real-time token salary per second\n- **Retroactive** (RetroPGF, Coordinape) — pay for value already delivered\n- **Bounties** (Dework, Layer3) — task-based one-time payments\n- **Full-time core contributor** — hired by a foundation legal entity, paid in stable + token\n\n**Delegate ecosystem:**\n- Active community members accept delegated votes; publish delegate platforms\n- Major delegates: Gauntlet (risk management), Llama (treasury), a16z, Coinbase, Jump\n- Delegation improves participation rates and quality of decisions\n\n**Pitfalls:**\n- Contributor churn when token prices drop and compensation value collapses\n- Working group scope creep and accountability gaps\n- "Governance minimisation" movement: encode rules in code, reduce human governance surface`,

  gov_case_studies: `**Protocol governance case studies** — real examples of governance working and failing.\n\n**Compound "Bug" (2021):**\n- A governance proposal accidentally distributed $80M in extra COMP rewards due to a bug\n- DAO voted to fix but the fix required a 7-day timelock — during which another $65M was distributed\n- Lesson: timelocks protect users but slow emergency response; need a Security Council\n\n**Uniswap Fee Switch (2022–2024):**\n- Years of debate about turning on LP fees to UNI stakers\n- a16z blocked activation multiple times citing regulatory concerns (staking rewards = securities?)\n- Finally activated on select pools in 2024 after FIT21 passage gave regulatory clarity\n- Lesson: large token holder blocs can veto majority sentiment for years\n\n**Arbitrum AIP-1 (2023):**\n- Foundation submitted a proposal asking for 750M ARB ($1B) — after already moving the funds\n- Community revolt: "ratification after action" was not acceptable DAO governance\n- Foundation walked it back; published a new proposal; relationship repaired\n- Lesson: DAOs must trust building process — act first, ask later destroys legitimacy\n\n**Optimism RetroPGF (2023–2025):**\n- Rounds 2 and 3 distributed $40M+ to 500+ open-source builders\n- Citizens House (Soulbound badge holders) allocated funds by voting\n- Widely praised as the most legitimate public goods funding mechanism in crypto\n- Lesson: retroactive funding removes speculation and funds real impact\n\n**MakerDAO Endgame (2024):**\n- Massive governance overhaul splitting MakerDAO into SubDAOs\n- MKR holders voted to rebrand to Sky, create USDS and SKY tokens\n- Controversial but executed with proper governance votes and community discussion\n- Lesson: large protocol pivots are possible through governance if trust is maintained`,

  dao: `A **DAO (Decentralized Autonomous Organization)** is an organization governed by smart contracts and token-holder votes.\n\n**How it works:**\n- Token holders submit and vote on proposals\n- Voting power proportional to token holdings (or delegated)\n- Approved proposals execute automatically via smart contracts\n\n**Examples:** Uniswap DAO, Compound DAO, MakerDAO, ENS DAO, Gitcoin DAO\n\n**Challenges:** Voter apathy, whale dominance, governance attacks, speed of decision-making.`,

  yield: `**Yield farming** involves moving crypto assets across DeFi protocols to maximize returns.\n\n**Strategies:**\n- Provide liquidity to DEX pools (earn trading fees)\n- Lend on money markets (earn interest)\n- Stake LP tokens for bonus token rewards\n- Loop: borrow and re-deposit to amplify yield\n\n**Risks:**\n- **Impermanent loss** — LP value drops vs. just holding\n- Smart contract exploits\n- Token inflation diluting rewards\n- Liquidation risk on leveraged positions`,

  // ── Tokens & Standards deep-dive topics ────────────────────────────────────
  std_erc20_deep: `**ERC-20 deep dive** — the most important smart contract standard in crypto.\n\n**The interface (6 required functions + 2 events):**\n- totalSupply() — returns circulating supply\n- balanceOf(address) — token balance of any address\n- transfer(to, amount) — direct transfer\n- approve(spender, amount) — grant spending allowance\n- transferFrom(from, to, amount) — spend on behalf of another\n- allowance(owner, spender) — check remaining allowance\n- Events: Transfer, Approval\n\n**ERC-2612 (permit extension):**\n- Sign an approval off-chain (EIP-712 signature)\n- No on-chain approval transaction needed\n- Saves gas; enables single-transaction approve+swap flows\n- Supported by USDC v2, DAI, and most modern DeFi tokens\n\n**Decimal conventions:**\n- Most ERC-20s use 18 decimals (1 token = 10^18 units)\n- USDC uses 6 decimals (1 USDC = 1,000,000 units)\n- Always read decimals() on-chain rather than hardcoding\n\n**Common pitfalls:**\n- Approve race condition: set allowance to 0 first, then to new value\n- Fee-on-transfer tokens break protocols that assume amounts are preserved\n- Non-standard returns: some tokens return nothing on transfer (USDT v1)\n- SafeERC20 (OpenZeppelin) wraps calls to handle all edge cases\n\n**Major ERC-20 tokens:** USDC, USDT, WETH, UNI, AAVE, LINK, MKR, CRV, ARB, OP`,

  std_nft_standards: `**NFT standards (ERC-721 and ERC-1155)** define how unique and multi-token assets work onchain.\n\n**ERC-721 (Non-Fungible Token):**\n- Each token has a unique tokenId\n- ownerOf(tokenId) — returns the owner\n- safeTransferFrom(from, to, tokenId) — safe transfer with receiver check\n- tokenURI(tokenId) — returns metadata URI (JSON with name, image, attributes)\n- approve / getApproved — single-token approval\n- setApprovalForAll / isApprovedForAll — operator approval for all tokens\n- Events: Transfer, Approval, ApprovalForAll\n\n**ERC-1155 (Multi-Token Standard):**\n- A single contract holds multiple token types (both fungible and non-fungible)\n- balanceOf(account, id) — balance of a specific token type\n- balanceOfBatch — check multiple accounts and ids in one call\n- safeTransferFrom / safeBatchTransferFrom\n- Gas-efficient for batch mints — ideal for gaming items\n- Used by OpenSea Shared Storefront, game loot contracts\n\n**ERC-2981 (Royalty Standard):**\n- On-chain royalty info: royaltyInfo(tokenId, salePrice) returns (receiver, amount)\n- Supported by OpenSea, Blur, Zora, Magic Eden\n- Does NOT enforce royalties — marketplaces choose to respect it\n\n**Metadata standards:**\n- tokenURI points to JSON with: name, description, image, attributes array\n- Stored on IPFS, Arweave, or centralised server (risk: link rot)\n- Fully on-chain SVG metadata (Nouns, Loot) — most durable\n\n**ERC-6551 (Token Bound Accounts):**\n- Each NFT gets a smart contract wallet at a deterministic address\n- NFTs can own assets, sign transactions, interact with DeFi`,

  std_account_abstraction: `**Account Abstraction (ERC-4337)** replaces the EOA model with programmable smart contract wallets.\n\n**The problem with EOAs:**\n- Lose seed phrase = lose funds permanently\n- Every transaction needs ETH for gas\n- No native multi-factor authentication\n- Cannot batch multiple operations\n\n**How ERC-4337 works:**\n- Introduces UserOperation (a new pseudo-transaction type)\n- Bundlers collect UserOps and submit them on-chain\n- EntryPoint contract validates and executes\n- Your wallet is a smart contract — logic is programmable\n\n**What smart contract wallets enable:**\n- **Paymasters** — sponsor gas (users pay in USDC or nothing at all)\n- **Session keys** — pre-approve a dApp to sign transactions within limits\n- **Social recovery** — recover wallet via trusted contacts instead of seed phrase\n- **Batched transactions** — approve + swap + stake in one UserOperation\n- **Spending limits** — enforce daily caps at the wallet level\n\n**ERC-6900 (modular smart accounts):**\n- Extends 4337 with a plugin architecture\n- Install/uninstall modules: multisig, subscriptions, session keys\n- Circle Modular Wallets implement ERC-6900\n\n**Key players:**\n- Safe (formerly Gnosis Safe) — most battle-tested smart contract wallet\n- Biconomy, Stackup, Pimlico — bundler/paymaster infrastructure\n- Circle Modular Wallets — passkey-based with Gas Station paymaster\n- Coinbase Smart Wallet — ERC-4337 wallet integrated into Coinbase app\n- ZeroDev — developer toolkit for smart accounts`,

  std_vault_tokens: `**ERC-4626 (tokenised vaults)** is the standard for yield-bearing tokens across DeFi.\n\n**The problem it solves:**\n- Before ERC-4626, every yield protocol had custom deposit/withdraw interfaces\n- Aggregators (Yearn, Beefy) had to write custom adapters for every protocol\n- ERC-4626 creates a universal vault interface — any protocol can plug into any aggregator\n\n**Core interface:**\n- deposit(assets, receiver) — deposit underlying, receive shares\n- withdraw(assets, receiver, owner) — burn shares, receive underlying\n- redeem(shares, receiver, owner) — burn exact shares, receive variable underlying\n- convertToShares(assets) / convertToAssets(shares) — price discovery\n- totalAssets() — total underlying held by the vault\n- asset() — the underlying token address\n\n**How share price works:**\n- 1 share = totalAssets / totalSupply of shares\n- As yield accrues, totalAssets grows; same shares = more underlying\n- This is how sUSDe, sUSDS, aUSDC, and sDAI appreciate\n\n**Examples:**\n- **aUSDC (Aave)** — deposit USDC, receive aUSDC; redeemable for more USDC as interest accrues\n- **sUSDS (Sky)** — staked USDS; Sky Savings Rate\n- **sUSDe (Ethena)** — staked USDe; backed by delta-neutral strategy yield\n- **yvUSDC (Yearn)** — auto-compounding vault\n- **USYC (Hashnote)** — tokenised short-duration treasury vault\n\n**Composability benefit:** A single yield aggregator UI can display, deposit, and redeem any ERC-4626 vault without custom code.`,

  std_solana_tokens: `**Solana token standards** differ fundamentally from EVM in architecture and capability.\n\n**SPL Token (original standard):**\n- Programs (contracts) on Solana are stateless; token balances live in account data\n- Every holder needs an Associated Token Account (ATA) — a PDA tied to their wallet + mint\n- Mint authority — can create more tokens; typically revoked for fixed-supply tokens\n- Freeze authority — can freeze token accounts; used by USDC for compliance\n- Token Program: spl-token CLI or @solana/spl-token SDK\n\n**Token Extensions (Token-2022):**\n- New token program with optional extensions per mint\n- **Transfer fee** — take a % on every transfer (protocol revenue)\n- **Confidential transfers** — encrypted balances using ZK proofs\n- **Permanent delegate** — address that can always transfer/burn tokens\n- **Transfer hook** — call a custom program on every transfer\n- **Interest-bearing** — accumulate interest recorded in token account\n- **Non-transferable** — soulbound tokens (credentials, licenses)\n- USDC on Solana moved to Token-2022 for confidential transfer capability\n\n**Metaplex (NFT metadata):**\n- Token Metadata program adds name, symbol, URI, creators, royalties to any SPL mint\n- Master Edition / Edition — limited-run prints\n- Compressed NFTs (cNFTs) — store NFT state in a Merkle tree; mint millions for near-zero cost\n\n**Solana Token Registry:**\n- Jupiter Token List — the de facto registry for verified Solana tokens\n- Strict list: audited, known teams; community list: broader but less vetted`,

  std_governance_tokens: `**Governance tokens** give holders the right to vote on protocol decisions — a core mechanism of decentralised autonomous organisations (DAOs).\n\n**What governance tokens control:**\n- Protocol parameter changes (fee levels, collateral ratios, interest rates)\n- Treasury spending and grants\n- Smart contract upgrades\n- New chain/market listings\n- Emergency shutdowns and pauses\n\n**Voting mechanisms:**\n- **Token-weighted voting** — 1 token = 1 vote; whales dominate\n- **Quadratic voting** — cost of votes scales quadratically; reduces whale power\n- **Conviction voting** — longer you hold a position, more weight it accumulates\n- **Delegation** — token holders delegate votes to active community members\n\n**veTokenomics (vote-escrowed):**\n- Lock tokens for 1–4 years to receive veTOKEN\n- Longer lock = more voting power + higher yield share\n- Reduces sell pressure; aligns long-term incentives\n- Pioneered by Curve (veCRV); adopted by Balancer (veBAL), Frax (veFXS), many others\n\n**Major governance tokens:**\n- **UNI** (Uniswap) — $1B+ treasury; fee switch debate ongoing\n- **AAVE** (Aave) — safety module staking; governance of $15B+ in lending markets\n- **MKR/SKY** (MakerDAO/Sky) — governs DAI/USDS issuance and $5B+ RWA collateral\n- **ARB** (Arbitrum) — DAO controls $3B+ treasury; L2 governance\n- **OP** (Optimism) — bicameral governance (Token House + Citizens House)\n- **CRV** (Curve) — gauge weights control billions in liquidity incentives\n\n**Governance attack vectors:**\n- Flash loan governance attacks (borrow tokens, vote, repay in one tx)\n- Low quorum manipulation on quiet proposals\n- Timelock bypasses on emergency admin keys`,

  std_utility_tokens: `**Utility tokens** derive value from access to a specific product, service, or network — distinct from governance or speculative tokens.\n\n**Types of utility:**\n- **Gas tokens** — pay for computation (ETH on Ethereum, SOL on Solana, USDC on Arc)\n- **Fee discounts** — holding the token reduces trading fees (BNB on Binance, OKB on OKX)\n- **Access tokens** — required to use a service or network (FIL for Filecoin storage, LINK for Chainlink oracle feeds)\n- **Work tokens** — staked by service providers; slashed for misbehaviour (Chainlink node operators staking LINK)\n- **Network tokens** — validators/miners secure the network in exchange for token rewards (ETH PoS, SOL)\n\n**Examples:**\n- **ETH** — gas for Ethereum; staking collateral; ultra sound money (post-EIP-1559 burn)\n- **SOL** — gas for Solana; staking rewards\n- **LINK** — Chainlink oracle payment; node operator stake\n- **FIL** — Filecoin storage payment and miner collateral\n- **HNT** — Helium network; hotspot operators earn by providing coverage\n- **RNDR** — Render Network; GPU compute marketplace\n- **GRT** — The Graph; indexers stake GRT to serve data queries\n\n**Utility vs security:**\n- Regulators look at whether a token primarily offers investment returns vs utility\n- Pure utility tokens face less regulatory scrutiny under the Howey test\n- In practice, most utility tokens also trade speculatively`,

  std_wrapped_tokens: `**Wrapped tokens** represent an asset from one chain on another chain, or convert between different token standards.\n\n**How wrapping works:**\n1. User deposits the native asset into a custodian or smart contract\n2. An equivalent wrapped token is minted on the target chain\n3. To unwrap: burn the wrapped token, receive the native asset back\n\n**WETH (Wrapped Ether):**\n- ETH is not ERC-20 compliant (predates the standard)\n- WETH wraps ETH 1:1 into an ERC-20 so it can be used in DeFi pools\n- Uniswap, Aave, Compound all use WETH internally\n\n**WBTC (Wrapped Bitcoin):**\n- Bitcoin on Ethereum; custodied by BitGo\n- 1 WBTC = 1 BTC; ERC-20 standard\n- $10B+ market cap; used as DeFi collateral\n- Centralisation risk: BitGo controls the BTC reserves\n- Competitors: tBTC (decentralised, Threshold Network), cbBTC (Coinbase)\n\n**Cross-chain wrapped assets:**\n- Portal (Wormhole) — bridge wrapped assets across EVM + Solana\n- Multichain (defunct after hack) — wrapped assets on many EVM chains\n- LayerZero OFT (Omnichain Fungible Token) — single token deployable across chains with unified supply\n\n**Liquid staking tokens (a form of wrapped staking):**\n- stETH (Lido) — stake ETH, receive stETH that appreciates as staking rewards accrue\n- cbETH (Coinbase) — Coinbase's staked ETH token\n- mSOL (Marinade) — Solana liquid staking token\n\n**Risks of wrapped tokens:**\n- Custodian risk (WBTC): BitGo could be hacked or go insolvent\n- Bridge risk: bridge contracts holding backing assets are prime hack targets\n- De-peg risk: wrapped token can trade at discount if users lose confidence`,

  std_token_launches: `**Token launch mechanisms** determine how a new token is distributed — and who profits.\n\n**Fair launch:**\n- No pre-mine, no team allocation, no VC round\n- Token available to anyone from day one (mining, farming, or bonding curve)\n- Examples: Bitcoin (mining), BONK (community airdrop), most pump.fun tokens\n- Advantage: community trust; Disadvantage: no funding for development\n\n**ICO (Initial Coin Offering, 2017-era):**\n- Team sells tokens directly to public in exchange for ETH/BTC\n- No regulatory oversight; many were outright scams\n- EOS raised $4B; Tron, Telegram TON cancelled by SEC\n- Largely replaced by more compliant mechanisms\n\n**IEO (Initial Exchange Offering):**\n- Exchange (Binance Launchpad, KuCoin Spotlight) vets and hosts the sale\n- Users buy with exchange native token (BNB) — drives token demand\n- More credibility than ICO; still speculative\n\n**IDO (Initial DEX Offering):**\n- Token sale on a DEX launchpad (Polkastarter, Fjord Foundry, Camelot)\n- Immediate liquidity on launch\n- Fairness mechanisms: lottery, whitelist, first-come-first-served\n\n**LBP (Liquidity Bootstrapping Pool):**\n- Balancer-based pool starts heavily weighted toward the new token\n- Price starts high and decreases over time unless buying pressure sustains it\n- Discourages bots; rewards patient buyers\n- Used by Maple Finance, Radiant Capital, others\n\n**Airdrop:**\n- Free token distribution to existing community or protocol users\n- Retroactive airdrops reward past users (Uniswap, Arbitrum, Optimism, Jito)\n- Criteria: trading volume, LP provision, governance participation, NFT holding\n- Largest: ARB airdrop ($1B+ value distributed to Arbitrum users)\n\n**Points programs:**\n- Protocols award off-chain points before token launch (Eigenlayer, Hyperliquid)\n- Points later convert to token allocation\n- Risk: protocol may not launch a token or may disappoint on conversion ratio`,

  erc20: `**ERC-20** is the token standard on Ethereum and EVM-compatible chains. It defines a common interface that allows tokens to interact seamlessly with wallets, DEXs, and smart contracts.\n\n**Key functions:**\n- \`transfer(to, amount)\` — send tokens\n- \`approve(spender, amount)\` — authorize a contract to spend tokens\n- \`transferFrom(from, to, amount)\` — move approved tokens\n- \`balanceOf(address)\` — check balance\n- \`totalSupply()\` — total token supply\n\nERC-20 is the foundation for USDC, USDT, WETH, UNI, AAVE, and thousands of other tokens.`,

  metamask: `**MetaMask** is the most popular EVM browser wallet extension, available for Chrome, Firefox, and as a mobile app.\n\n**Key features:**\n- Connect to any EVM-compatible network\n- Sign transactions and messages\n- Manage ERC-20 tokens and NFTs\n- Built-in token swap (via aggregators)\n- Hardware wallet integration (Ledger, Trezor)\n\n**Security tips:**\n- Download only from metamask.io\n- Never enter your seed phrase on any website\n- Review transaction details carefully before signing\n- Use a hardware wallet for large holdings`,

  halving: `**Bitcoin Halving** is a scheduled event that cuts the block reward paid to miners in half, occurring every 210,000 blocks (~4 years).\n\n**History:**\n- 2009: 50 BTC per block (genesis)\n- 2012: 25 BTC\n- 2016: 12.5 BTC\n- 2020: 6.25 BTC\n- 2024: 3.125 BTC\n- Next: ~2028 → 1.5625 BTC\n\n**Effect:** Reduces new supply issuance. Historically associated with bull market cycles, though past performance doesn't guarantee future results. All 21 million BTC will be mined by ~2140.`,

  cbdc: `A **CBDC (Central Bank Digital Currency)** is a digital form of a country's fiat currency, issued and controlled by the central bank.\n\n**Types:**\n- **Retail CBDC** — for consumers and businesses\n- **Wholesale CBDC** — for interbank settlement\n\n**Examples:**\n- China's e-CNY (digital yuan) — most advanced rollout\n- EU's digital euro — in research phase\n- US digital dollar — under exploration by Federal Reserve\n\n**Differences from crypto:** CBDCs are centralized, permissioned, and controlled by governments — not decentralized or censorship-resistant.`,

  impermanent_loss: `**Impermanent Loss (IL)** is the temporary loss of value experienced by liquidity providers (LPs) in automated market makers (AMMs) compared to simply holding the assets.\n\n**How it happens:**\nWhen you provide liquidity to a BTC/USDC pool and BTC price rises, arbitrageurs buy cheap BTC from your pool until the ratio rebalances. You end up with less BTC and more USDC than if you had just held.\n\n**Rule of thumb:**\n- 2x price move → ~5.7% IL\n- 5x price move → ~25% IL\n- 10x price move → ~42% IL\n\nIL is "impermanent" because it reverses if prices return to their original ratio. Trading fees can offset IL.`,

  // ── Infrastructure deep-dive topics ─────────────────────────────────────
  infra_ethereum_deep: `**Ethereum — deep dive** into the world's leading programmable blockchain.\n\n**Architecture:**\n- Execution layer (EL): processes transactions and smart contracts; clients include Geth, Nethermind, Besu, Reth\n- Consensus layer (CL): manages validators and finality; clients include Prysm, Lighthouse, Teku, Nimbus\n- Two-client architecture since The Merge (Sep 2022) makes Ethereum more resilient\n\n**The Merge (September 15, 2022):**\n- Switched from Proof of Work to Proof of Stake\n- Energy usage dropped 99.95%\n- Issuance dropped ~90%; combined with EIP-1559 burns, ETH became net deflationary in high-activity periods\n\n**EIP-1559 (August 2021):**\n- Replaced first-price auction fees with a base fee (burned) + priority tip (to validators)\n- Base fee adjusts algorithmically to target 50% block fullness\n- Made fee estimation predictable; ETH burned = ultra sound money narrative\n\n**The Roadmap (post-Merge):**\n- Surge: EIP-4844 (proto-danksharding, blobs) shipped March 2024 — reduced L2 fees 90%+\n- Scourge: MEV mitigation via ePBS (enshrined Proposer-Builder Separation)\n- Verge: Verkle trees for stateless clients; enable light-client ecosystem\n- Purge: remove historical data; reduce node requirements\n- Splurge: final miscellaneous improvements\n\n**Validator economics:**\n- 32 ETH minimum stake to run a validator\n- Validators earn: consensus rewards (new ETH issuance) + execution rewards (EIP-1559 tips + MEV)\n- ~4M validators; ~130M ETH staked as of 2026\n- Slashing: major penalty for double-voting or signing conflicting blocks`,

  infra_bitcoin_network: `**Bitcoin network — deep dive** into how the original blockchain actually works.\n\n**The UTXO model:**\n- Bitcoin doesn't have "accounts" — it has Unspent Transaction Outputs (UTXOs)\n- Each UTXO is a discrete chunk of bitcoin locked to a script\n- Spending: create a transaction that unlocks existing UTXOs (inputs) and creates new UTXOs (outputs)\n- Privacy advantage: wallets can generate fresh addresses per transaction\n\n**Script and opcodes:**\n- Bitcoin transactions are locked/unlocked by a simple stack-based scripting language\n- P2PKH (Pay-to-Public-Key-Hash) — classic; P2SH (Pay-to-Script-Hash) — multi-sig\n- P2WPKH / P2WSH (SegWit) — weight discounts for witness data, enabling Lightning\n- P2TR (Taproot) — Schnorr signatures + Merklised scripts; enables Ordinals inscriptions\n\n**Mining and the difficulty adjustment:**\n- SHA-256 proof-of-work; difficulty recalibrates every 2016 blocks (~2 weeks)\n- Block reward halves every 210,000 blocks (~4 years); 2024 halving: 3.125 BTC/block\n- Hash rate is at all-time highs in 2026 despite lower block subsidy — fee revenue growing\n\n**The Lightning Network:**\n- Layer 2 payment channel network; bi-directional channels, instant settlement, near-zero fees\n- Nodes: LND, CLN (Core Lightning), Eclair\n- Payment routing: source routing using HTLC contracts\n- Used by Strike, Cash App (sending), El Salvador Chivo wallet\n- Limitations: inbound liquidity management, channel management complexity\n\n**Bitcoin node types:**\n- Full node (Bitcoin Core): validates every transaction and block; ~600GB chain data\n- Pruned node: validates but discards old blocks (reduces storage)\n- Archival node: stores full history — required for blockchain explorers`,

  infra_zk_tech: `**ZK (Zero-Knowledge) technology** — the most important cryptographic primitive in crypto infrastructure today.\n\n**What is a ZK proof?**\n- Prove a statement is true without revealing any information beyond the truth of the statement\n- e.g. "I know a secret password" without revealing the password\n- Completeness: if true, an honest prover can always convince a verifier\n- Soundness: a dishonest prover cannot convince a verifier of a false statement\n- Zero-knowledge: the verifier learns nothing except that the statement is true\n\n**ZK-SNARKs:**\n- Succinct Non-interactive ARguments of Knowledge\n- Very small proof size (a few hundred bytes); fast to verify\n- Requires a trusted setup ceremony (toxic waste); circuits are fixed per application\n- Used by: Groth16 (Zcash, early zkSync), Plonk (zkSync Era, Aztec)\n\n**ZK-STARKs:**\n- Scalable Transparent ARguments of Knowledge\n- No trusted setup; post-quantum secure; larger proofs but scales better\n- Used by: StarkNet (Cairo), Polygon Miden, Risc Zero\n\n**ZK rollups:**\n- Batch transactions off-chain, generate a ZK validity proof, post proof + state diff to L1\n- Finality on L1 as soon as proof is verified (no 7-day fraud window)\n- Leading ZK rollups: zkSync Era, StarkNet, Scroll, Polygon zkEVM, Linea\n- Trade-off vs optimistic: faster finality, but proving is computationally expensive\n\n**ZK applications beyond rollups:**\n- **ZK identity** — prove age/nationality without revealing your ID (zkPass, Reclaim)\n- **ZK coprocessors** — Axiom, Lagrange; run complex queries over historical onchain data and return ZK-verified results to contracts\n- **ZK gaming** — Dark Forest uses ZK to keep player positions private while verifying moves are valid\n- **ZK-ML** — prove a machine learning inference ran correctly (ZKML; early stage)`,

  infra_appchains: `**Appchains (application-specific chains)** — blockchains built for a single protocol or application rather than general use.\n\n**Why appchains?**\n- Shared blockchains have congestion; a successful app (like Axie) can fill blocks and price others out\n- Custom execution environment, consensus, and gas token for the application\n- Control over sequencing, block times, and fee structure\n- Sovereign governance over upgrades\n\n**Technologies for building appchains:**\n- **Cosmos SDK** — the OG appchain framework; IBC for cross-chain communication; Cosmos hub (ATOM)\n- **Polkadot parachains** — pay for blockspace on the Polkadot relay chain; shared security via DOT\n- **Avalanche Subnets** — EVM-compatible custom chains with configurable consensus; DeFi Kingdoms, Shrapnel\n- **Arbitrum Orbit** — L3 chains settling to Arbitrum L2; Xai, ApeChain, Degen Chain\n- **OP Stack** — Optimism's open-source stack; Base (Coinbase), Worldchain, Zora Chain, Mode\n- **Polygon CDK** — ZK-based chains with optional AggLayer interoperability\n- **ZK Stack (zkSync)** — ZK-based sovereign chains\n\n**Notable appchains:**\n- **dYdX v4** — Cosmos SDK appchain for perps; custom order book; DYDX token for fees and governance\n- **Hyperliquid** — custom L1 with HLP market maker; ~70% of onchain perp volume in 2025–2026\n- **Ronin** — Sky Mavis gaming chain; Axie Infinity\n- **Injective** — Cosmos-based DeFi appchain; orderbook, derivatives, prediction markets\n- **ApeChain** — Yuga Labs' Arbitrum Orbit chain for the APE ecosystem`,

  infra_data_availability: `**Data Availability (DA)** — ensuring rollup transaction data is publicly accessible for anyone to verify or reconstruct state.\n\n**Why DA matters:**\n- ZK and optimistic rollups post state roots on Ethereum, but they also need to post the underlying transaction data\n- Without data availability, users can't reconstruct rollup state or verify fraud proofs\n- DA is the biggest cost driver for rollups — Ethereum blob space is expensive\n\n**Ethereum as DA (EIP-4844, March 2024):**\n- Introduced "blobs" — temporary data attachments to blocks (~18 days retention)\n- Base, Arbitrum, Optimism, zkSync post blobs instead of calldata — 90%+ cost reduction\n- Danksharding (future): expand to 64+ blobs per block via data availability sampling (DAS)\n\n**Alternative DA layers:**\n- **Celestia** — purpose-built DA layer; modular blockchain design; TIA token; roll-ups post data to Celestia instead of Ethereum\n- **EigenDA** — EigenLayer restaking-backed DA; used by Mantle, Celo (migrating)\n- **Avail** — Polygon-spun DA layer; Avail DA + Avail Nexus for interoperability\n- **NEAR DA** — NEAR Protocol offering DA services to rollups at very low cost\n\n**The Modular Blockchain thesis:**\n- Ethereum originally did everything: execution + consensus + DA\n- Modular: separate execution (rollups), consensus (Ethereum/Tendermint), DA (Celestia/EigenDA)\n- Rollups mix-and-match layers for optimal cost/security tradeoff\n\n**Security implications:**\n- Ethereum DA: most secure (settled directly on Ethereum L1)\n- External DA: cheaper but introduces additional trust assumptions on the DA committee`,

  infra_node_rpc: `**Running nodes, RPCs, and indexers** — the infrastructure layer that makes dApps work.\n\n**Types of nodes:**\n- **Full node** — downloads and validates every block; serves RPC queries; requires 600GB–4TB storage depending on chain\n- **Archive node** — stores all historical state; required for querying old balances; can reach 10TB+ for Ethereum\n- **Light node** — downloads only block headers; trusts full nodes for data; fast sync\n- **Validator / miner node** — participates in consensus; requires uptime and bonded stake or hash rate\n\n**RPC providers (managed node infrastructure):**\n- **Alchemy** — most popular; Ethereum, Polygon, Arbitrum, Base, etc.; enhanced APIs for NFTs/tokens\n- **Infura (Consensys)** — the original managed node service; used by MetaMask as default RPC\n- **QuickNode** — broad chain support; WebSocket support; add-ons marketplace\n- **Ankr, Blast, Llamanodes, dRPC** — lower-cost or free-tier alternatives\n- **Circle RPC Proxy** — Circle-managed RPC for Arc Testnet and supported chains\n\n**Running your own node advantages:**\n- No rate limits; full privacy; reduces dependence on centralised providers\n- Required for: exchange/CEX operations, validator setups, high-volume dApps\n\n**Indexers and data APIs:**\n- **The Graph** — decentralised indexing protocol; subgraphs index smart contract events; GRT token\n- **Dune Analytics** — SQL queries over indexed blockchain data; dashboards shared publicly\n- **Nansen, Chainalysis, Arkham** — commercial analytics platforms with entity labelling\n- **Etherscan / Basescan / Arbiscan** — block explorers with API for tx data\n- **Alloy / Viem / Ethers.js** — developer libraries for interacting with nodes via RPC`,

  infra_cross_chain_messaging: `**Cross-chain messaging protocols** enable smart contracts on one chain to trigger actions on another — beyond just moving tokens.\n\n**Why messaging matters:**\n- Token bridges move assets; messaging moves arbitrary data + assets\n- Enables: cross-chain governance votes, cross-chain liquidations, unified liquidity pools across chains\n\n**Chainlink CCIP (Cross-Chain Interoperability Protocol):**\n- Enterprise-grade messaging + token transfer; risk management network (separate oracle network validates)\n- Used by: SWIFT CBDC pilot, ANZ bank, Synthetix cross-chain liquidity\n- Conservative design; prioritises security over speed\n\n**LayerZero:**\n- Lightweight: uses ultra-light nodes and DVN (Decentralised Verifier Networks) instead of full relayers\n- OFT (Omnichain Fungible Token) standard: single token supply across chains\n- Used by: Stargate bridge, USDC OFT, STG, many protocols\n- ZRO token; has faced criticism for security model relying on configurable DVNs\n\n**Wormhole:**\n- Guardian network of 19 validators; supports 30+ chains including Solana, Sui, Aptos\n- NTT (Native Token Transfers) — similar to OFT for multi-chain tokens\n- Suffered $320M exploit in 2022; relaunched with upgraded security\n- W token airdrop was one of the largest in Solana history\n\n**Axelar:**\n- Cosmos-based cross-chain gateway; PoS security; General Message Passing\n- Used by institutional chains; integrates with Cosmos IBC\n\n**Hyperlane:**\n- Permissionless deployment; any chain can integrate without permission\n- Modular security: deployers choose their own Interchain Security Module (ISM)\n\n**IBC (Inter-Blockchain Communication):**\n- Cosmos native; trust-minimised; light client verification; 100+ Cosmos chains connected\n- Expanding beyond Cosmos: IBC on Ethereum via Polymer Protocol`,

  infra_chainlink_pyth: `**Oracles deep dive — Chainlink and Pyth** are the two dominant onchain data providers.\n\n**Chainlink:**\n- Founded 2017; the largest decentralised oracle network\n- Architecture: node operators run off-chain; aggregate data; post to on-chain aggregator contracts\n- LINK token: paid to node operators for data delivery; staked in Chainlink Staking for security\n- Products:\n  - **Price Feeds** — battle-tested; 1000+ feeds across 20+ chains; used by Aave, Compound, Synthetix\n  - **VRF (Verifiable Random Function)** — tamper-proof randomness for NFT mints, gaming\n  - **Automation** — trigger smart contracts automatically (price thresholds, time-based)\n  - **CCIP** — cross-chain messaging and token transfers\n  - **Data Streams** — low-latency pull-based prices for perp DEXs\n  - **Functions** — connect smart contracts to any API\n- Chainlink Build: protocols that integrate Chainlink get LINK fee allocation and dedicated support\n\n**Pyth Network:**\n- Pull-based architecture: price publishers post data to Pyth's price aggregation network; dApps pull data on-demand and pay per call\n- First-party data: directly from trading firms (Jane Street, Jump, Binance, Bybit, OKX) — not aggregated from secondary sources\n- Ultra low latency: updates every ~400ms; 100ms Solana-native updates\n- Dominant on Solana; used by Jupiter, Drift, MarginFi; also on EVM chains\n- Confidence intervals: each price includes a confidence band, not just a point price — novel for DeFi\n- PYTH token: governance and incentive alignment\n\n**Oracle security risks:**\n- Spot price manipulation via flash loans (AMM-based oracles)\n- Low-liquidity tokens have unreliable oracle prices\n- Circuit breakers and TWAP (time-weighted average price) used to mitigate manipulation`,

  infra_evm_deep: `**The EVM ecosystem — 2026 landscape** of EVM-compatible chains and how they relate.\n\n**Ethereum L1:**\n- The settlement layer and security root; 130M+ ETH staked\n- Highest decentralisation and security; most expensive execution\n- Major protocols live here; rollups inherit security\n\n**The Superchain (OP Stack):**\n- Base (Coinbase), Worldchain, Zora, Mode, Cyber, Redstone — all built on OP Stack\n- Base is the fastest-growing L2 by TVL and users; ~1B daily transactions\n- Optimism Governance: bicameral (Token House + Citizens House)\n\n**Arbitrum ecosystem:**\n- Arbitrum One — flagship L2; largest EVM L2 by TVL for much of 2022–2024\n- Arbitrum Nova — separate chain for gaming/social with lower security assumptions\n- Arbitrum Orbit — L3 framework; ApeChain, Xai, Degen Chain\n- ARB governance DAO controls $3B+ treasury\n\n**BNB Chain:**\n- BSC (BNB Smart Chain) — Binance's EVM chain; DPoS with 21 validators\n- Highest number of daily active users in 2022; PancakeSwap, Venus, Alpaca Finance\n- More centralised than Ethereum L2s; lower fees\n\n**Polygon:**\n- Polygon PoS — sidechain used by Reddit, Starbucks, Nike; migrating to AggLayer\n- Polygon zkEVM — ZK rollup settling to Ethereum\n- Polygon CDK — build your own ZK chain with AggLayer liquidity aggregation\n\n**Other notable EVM chains:**\n- **Avalanche C-Chain** — fast EVM; subnet ecosystem for appchains\n- **Fantom / Sonic** — high-speed EVM; Sonic relaunched 2024 with 10,000 TPS\n- **Cronos** — Crypto.com chain; CRO token\n- **Linea** — Consensys ZK rollup; growing DeFi ecosystem\n- **Scroll** — ZK rollup; EVM-equivalent (bytecode compatible)`,

  infra_private_compute: `**Privacy and confidential compute in crypto infrastructure** — the frontier of private onchain operations.\n\n**The transparency paradox:**\n- Public blockchains are fully transparent — every address, balance, and transaction is visible\n- This is good for auditability but incompatible with enterprise, medical, or financial privacy needs\n\n**ZK-based privacy:**\n- **Aztec** — ZK rollup with programmable privacy; private DeFi (private Uniswap, private Aave)\n- **Railgun** — privacy-preserving DeFi on Ethereum; shielded balances interact with existing protocols\n- **ZK identity** — prove attributes (KYC status, age, credit score) without revealing underlying data\n\n**Trusted Execution Environments (TEEs):**\n- Hardware-based secure enclaves (Intel SGX, AMD SEV, ARM TrustZone)\n- Smart contracts run inside a TEE with provable attestation\n- Used by: Oasis Network, Secret Network, Phala Network\n- Trade-off: hardware manufacturer trust assumption\n\n**Fully Homomorphic Encryption (FHE):**\n- Perform computations on encrypted data without decrypting\n- Still computationally expensive; 1000–10,000x overhead vs plaintext\n- Projects: fhEVM (Zama), Fhenix — FHE-enabled EVM\n- Use case: private smart contract state — nobody, not even the node, can see the contract's data\n\n**Multi-Party Computation (MPC):**\n- Split a private key or secret across multiple parties\n- No single party ever holds the full secret\n- Used by: Circle (CCTP signer), Fireblocks, Coinbase Wallet, Safe{Wallet} MPC option\n\n**Regulatory tension:**\n- OFAC sanctioned Tornado Cash (2022) — first protocol-level sanction\n- European DORA, FATF Travel Rule push against privacy tools\n- ZK identity is seen as a compliant privacy path — prove you're KYC'd without revealing who you are`,

  oracle: `A **blockchain oracle** is a service that brings real-world data (prices, weather, sports scores) onto the blockchain, where smart contracts can consume it.\n\n**Why needed:** Blockchains are deterministic closed systems — they cannot natively access external data.\n\n**Types:**\n- **Price feeds** — Chainlink, Pyth, Tellor\n- **Randomness** — Chainlink VRF\n- **Cross-chain messaging** — Chainlink CCIP, LayerZero\n\n**Oracle manipulation** is a major DeFi attack vector — protocols that rely on a single price source can be exploited via flash loans.`,

  flashloan: `A **flash loan** is an uncollateralized loan that must be borrowed and repaid within a single blockchain transaction.\n\n**How it works:**\n1. Borrow millions of dollars in one tx\n2. Execute arbitrage, liquidation, or collateral swap\n3. Repay the loan + fee in the same tx\n4. If repayment fails, the entire transaction reverts\n\n**Legitimate uses:** Arbitrage, liquidations, collateral swaps, self-liquidation\n\n**Attack vector:** Flash loan attacks have exploited price oracle vulnerabilities to drain DeFi protocols of hundreds of millions of dollars.`,

  layer1: `A **Layer 1 (L1)** is a base blockchain network — the foundation layer that processes and finalizes transactions.\n\n**Major L1s:**\n- **Bitcoin** — store of value, limited programmability\n- **Ethereum** — smart contracts, largest DeFi/NFT ecosystem\n- **Solana** — high throughput, low fees\n- **Avalanche** — subnet architecture, fast finality\n- **Arc** — USDC-native gas, EVM-compatible\n- **BNB Chain** — Binance ecosystem\n- **Polygon PoS** — EVM sidechain\n\n**L1 trilemma:** Decentralization, Security, Scalability — you can optimize for two, but not all three simultaneously.`,

  // ── Fundamentals deep dives ────────────────────────────────────────────────
  fund_consensus: `**Consensus Mechanisms** are the rules by which all nodes in a decentralised network agree on the same version of truth — without a central authority.\n\n**Proof of Work (PoW):**\n- Nodes (miners) compete to solve a computationally expensive puzzle\n- Winner adds the next block and earns a block reward + fees\n- Security: to attack the chain, you need 51% of the total hash rate\n- Used by: Bitcoin, Litecoin\n- Energy intensive; intentional — makes attacks costly\n\n**Proof of Stake (PoS):**\n- Validators lock up ("stake") tokens as collateral\n- Randomly selected (weighted by stake) to propose the next block\n- Slashing: dishonest validators lose their stake\n- Used by: Ethereum (since The Merge, Sep 2022), Solana, Cardano, Avalanche, Cosmos\n- 99.9% more energy-efficient than PoW\n\n**Delegated PoS (DPoS):**\n- Token holders vote for a fixed set of block producers (e.g. 21 on EOS, BNB Chain)\n- More performant but more centralised\n\n**Proof of History (PoH):**\n- Solana's innovation: a verifiable delay function creates a cryptographic timestamp sequence, allowing validators to agree on order of events without messaging each other\n- Enables ~65,000 TPS theoretical throughput\n\n**BFT variants (PBFT, Tendermint):**\n- Used by Cosmos chains; finality in one block; no forks possible\n- Requires known validator set; suits permissioned or semi-permissioned chains\n\n**Key tradeoff:** PoW maximises decentralisation and security; PoS maximises efficiency and participation.`,

  fund_cryptography: `**Cryptography fundamentals** underpin every aspect of blockchain security — from wallet addresses to transaction signing to ZK proofs.\n\n**Hash functions:**\n- Input of any size → fixed-size output (e.g. SHA-256 produces 256 bits)\n- Deterministic, one-way, collision-resistant\n- Bitcoin uses SHA-256; Ethereum uses Keccak-256\n- Any change to the input produces a completely different hash — makes blockchain tamper-evident\n\n**Public-key cryptography (asymmetric):**\n- You have a **private key** (a random 256-bit number; never shared)\n- A **public key** is mathematically derived from the private key\n- An **address** is derived from the public key (e.g. last 20 bytes of Keccak-256 hash on Ethereum)\n- You can **sign** a transaction with your private key; anyone can verify the signature using only your public key\n- Bitcoin and Ethereum use **ECDSA** (Elliptic Curve Digital Signature Algorithm) on the secp256k1 curve\n\n**Merkle trees:**\n- A binary tree of hashes; each node = hash of its two children; root = hash of all data\n- Bitcoin and Ethereum store transaction hashes in a Merkle tree\n- Enables efficient **Merkle proofs**: prove a transaction is in a block without downloading the whole block (used by light clients)\n\n**Zero-knowledge proofs (ZKPs):**\n- Prove you know a value without revealing the value\n- ZK-SNARKs and ZK-STARKs power ZK rollups (zkSync, StarkNet, Scroll) and privacy protocols\n- Enables verifiable computation: prove a program ran correctly without re-running it`,

  fund_wallets_keys: `**Wallets, Keys, and Addresses** — understanding what a crypto wallet actually is and how it relates to keys and addresses.\n\n**What a wallet is NOT:**\n- A wallet does not hold your coins — your coins exist on the blockchain\n- A wallet holds your **private keys**, which prove ownership and authorise transactions\n\n**Key hierarchy (BIP-32/44/39):**\n- A **seed phrase** (12 or 24 words, BIP-39) encodes a master private key\n- From the master key, a deterministic tree of child keys is derived (BIP-32 HD wallets)\n- BIP-44 defines a standard derivation path: m / purpose / coin_type / account / change / index\n- One seed phrase → unlimited accounts on unlimited chains\n\n**Address derivation:**\n- Ethereum: private key → ECDSA public key → Keccak-256 hash → take last 20 bytes → prefix 0x\n- Bitcoin: private key → public key → SHA-256 + RIPEMD-160 hash → Base58Check encode\n- Solana: ed25519 public key used directly as the address\n\n**Types of wallets:**\n- **Non-custodial:** you control the private key (MetaMask, Ledger, Rabby, Phantom)\n- **Custodial:** exchange or app controls the key on your behalf (Coinbase, Binance)\n- **Hot:** connected to the internet (software wallets)\n- **Cold:** offline (hardware wallets like Ledger, Trezor)\n- **Smart contract wallets:** ERC-4337 accounts; programmable recovery, batched txs, gasless\n\n**Security:** losing your private key or seed phrase = permanent loss of funds; no recovery mechanism exists in a non-custodial setup.`,

  fund_transactions: `**How blockchain transactions work** — from signing to inclusion in a block.\n\n**Transaction lifecycle:**\n1. **Creation:** user constructs a transaction (recipient, amount, data, gas limit)\n2. **Signing:** user signs with their private key using ECDSA; signature proves ownership without revealing the key\n3. **Broadcast:** signed transaction sent to any node in the P2P network; nodes forward it to peers\n4. **Mempool:** transaction waits in the "memory pool" (mempool) until a validator/miner includes it\n5. **Inclusion:** validator selects transactions (usually by fee), builds a block, and proposes it\n6. **Confirmation:** once included in a block, subsequent blocks build on top — each additional block = one more confirmation\n7. **Finality:** on PoS chains like Ethereum, finality is typically reached within 2 epochs (~12 min); on BFT chains (Cosmos), finality is instant; on Bitcoin, 6 confirmations (~60 min) is considered final\n\n**EVM transaction fields:**\n- nonce — sequential number preventing replay attacks\n- to — recipient address (or null for contract deployment)\n- value — amount of native token to send (ETH/USDC on Arc)\n- data — encoded function call for smart contract interactions\n- gasLimit — max gas the transaction may consume\n- maxFeePerGas + maxPriorityFeePerGas (EIP-1559) — fee cap and miner tip\n\n**UTXO vs Account model:**\n- Bitcoin uses **UTXO** (unspent transaction outputs) — like physical coins in a wallet\n- Ethereum uses an **account model** — like a bank balance; simpler for smart contracts`,

  fund_smart_contracts_deep: `**Smart contracts — deep dive** — self-executing programs deployed on a blockchain that run exactly as coded, with no possibility of downtime, censorship, or third-party interference.\n\n**Anatomy of a smart contract:**\n- Written in Solidity (EVM), Rust (Solana), Cairo (StarkNet), or Move (Aptos/Sui)\n- Compiled to bytecode and deployed to the blockchain at a specific address\n- Has its own storage, balance, and logic\n- Called by sending a transaction to its address with encoded function data\n\n**Key properties:**\n- **Immutable** — once deployed, code cannot be changed (unless an upgradeable proxy pattern is used)\n- **Deterministic** — same inputs always produce the same outputs on all nodes\n- **Trustless** — no intermediary; the code IS the contract\n- **Composable** — contracts can call other contracts; DeFi "money lego"\n\n**Common patterns:**\n- **ERC-20 token** — fungible token standard\n- **ERC-721 NFT** — non-fungible token standard\n- **Proxy pattern** — delegatecall to an implementation contract, allowing logic upgrades\n- **Multisig** — N-of-M key approval required for execution\n- **Timelock** — delay execution of admin actions for transparency\n\n**Gas and execution:**\n- Every EVM opcode has a gas cost; execution stops if gas runs out (transaction reverts)\n- Gas prices adjust with network congestion (EIP-1559 base fee)\n\n**Security:** Smart contract bugs are irreversible. Critical vulnerabilities: reentrancy, integer overflow, access control flaws, oracle manipulation. Audits, formal verification, and bug bounties are essential mitigations.`,

  fund_token_standards: `**Token standards** define a common interface so tokens work seamlessly with wallets, DEXs, and other contracts.\n\n**EVM (Ethereum and compatible chains):**\n- **ERC-20** — fungible tokens: USDC, USDT, WETH, UNI, AAVE. Functions: transfer, approve, transferFrom, balanceOf, totalSupply\n- **ERC-721** — non-fungible tokens (NFTs): each token has a unique ID. Functions: ownerOf, safeTransferFrom, tokenURI\n- **ERC-1155** — multi-token: a single contract can hold fungible and non-fungible tokens. Gas-efficient for batch mints (gaming)\n- **ERC-4626** — tokenised vaults: standardises yield-bearing token interfaces (aUSDC, sUSDS). Makes DeFi composability much easier\n- **ERC-2612** — permit extension to ERC-20: sign an off-chain approval (no approval tx needed, gas-free for users)\n- **ERC-4337** — account abstraction: smart contract wallets with programmable validation logic\n\n**Solana:**\n- **SPL Token** — Solana's fungible token standard (equivalent to ERC-20)\n- **Metaplex Token Metadata** — NFT standard on Solana\n- **Token Extensions (Token-2022)** — adds transfer fees, confidential transfers, permanent delegate, and more\n\n**Why standards matter:** A DEX built to the ERC-20 interface can trade ANY ERC-20 token without custom code. Standards are the foundation of DeFi composability.`,

  fund_scaling: `**Blockchain scaling** — why blockchains are slow, and the solutions being built.\n\n**The blockchain trilemma (Vitalik Buterin):**\n- Decentralisation, Security, Scalability — you can optimise two, but not all three simultaneously\n- Bitcoin optimises security + decentralisation at the expense of throughput (7 TPS)\n- Solana optimises speed + throughput at the expense of decentralisation (~1,900 validators)\n\n**On-chain scaling:**\n- **Larger blocks** — increases throughput but raises hardware requirements, reducing node count\n- **Faster block times** — increases throughput but increases uncle/orphan block rates\n- **Sharding** — split the blockchain into parallel "shards"; Ethereum's Danksharding roadmap\n\n**Layer 2 scaling (Ethereum):**\n- **Optimistic Rollups** (Arbitrum, Optimism, Base) — execute transactions off-chain; post compressed data + state root to L1; 7-day fraud proof window for withdrawals\n- **ZK Rollups** (zkSync Era, StarkNet, Scroll, Linea) — generate ZK validity proofs; faster finality; no fraud window\n- **State channels** — off-chain payment channels (Lightning Network on Bitcoin); instant finality; limited to pre-committed participants\n- **Plasma** — child chains; mostly superseded by rollups\n\n**Data availability:**\n- **EIP-4844 (Proto-Danksharding)** — blob transactions: L2s post data as cheaper "blobs" rather than calldata; reduced L2 fees ~10x\n- **Full Danksharding** — future: 64 blobs per block, supporting thousands of TPS across L2s\n\n**Alt-L1 approach:** Solana, Avalanche, BNB Chain achieve higher throughput through different consensus, hardware requirements, and reduced decentralisation.`,

  fund_network_security: `**Blockchain network security** — how attacks work and why they're so expensive.\n\n**51% attack:**\n- An attacker who controls >50% of a PoW network's hash rate can: reorder transactions, double-spend, and censor blocks\n- Cannot create tokens out of thin air or steal from wallets\n- On Bitcoin: cost to rent 51% hash rate for 1 hour ≈ hundreds of millions of dollars\n- Smaller PoW chains (ETC, BSV) have been 51% attacked multiple times\n\n**Long-range attacks (PoS):**\n- An attacker who acquires old private keys could rewrite history from that point\n- Mitigated by: checkpoint finality, slashing, and weak subjectivity (nodes must sync from a recent trusted state)\n\n**Sybil attacks:**\n- Creating many fake node identities to subvert voting or network rules\n- Mitigated by: PoW (computational cost), PoS (economic stake), identity systems\n\n**Eclipse attacks:**\n- Isolate a node from the honest network by surrounding it with attacker-controlled peers\n- Causes the victim to receive a false view of the chain\n\n**Smart contract attacks (layer above the protocol):**\n- Reentrancy, flash loan exploits, oracle manipulation — affect DeFi protocols, not the base chain\n\n**Nakamoto coefficient:**\n- The minimum number of entities that must collude to compromise a network\n- Bitcoin: ~3–5 mining pools; Ethereum: ~4 staking entities; Solana: ~19 validators\n- Higher = more decentralised\n\n**Why Bitcoin is considered the most secure:** 15+ years of unbroken operation, deepest PoW security budget, widest node distribution, simplest attack surface.`,

  fund_web3: `**Web3 vs Web1 vs Web2** — the evolution of the internet and where blockchain fits.\n\n**Web1 (1990–2004): Read**\n- Static HTML pages; content created by companies and institutions\n- Users consume content; no interaction or user-generated content\n- No personalisation; no accounts\n\n**Web2 (2004–present): Read + Write**\n- Dynamic, interactive platforms: Facebook, Google, Twitter, YouTube\n- Users create content but platforms own the data\n- Business model: surveillance capitalism (sell user data to advertisers)\n- Centralised control: platforms can censor, ban, or change terms\n- Data silos: your followers, posts, and purchases are locked inside each platform\n\n**Web3 (emerging): Read + Write + Own**\n- Users own their data, identity, and assets via cryptographic keys\n- Applications run on decentralised networks (blockchains) — no single entity controls them\n- Tokens enable value transfer and governance without intermediaries\n- Composability: protocols interoperate like LEGO bricks (vs Web2 silos)\n\n**Key Web3 primitives:**\n- **Wallets** — portable identity; log in anywhere with the same address\n- **Tokens** — programmable money and ownership\n- **Smart contracts** — code-enforced agreements\n- **DAOs** — community governance without a company\n- **DeSoc** — decentralised social (Farcaster, Lens Protocol)\n\n**Criticism:** Web3 still has UX friction, scalability limits, and is often more centralised in practice than claimed. The vision and reality are still converging.`,

  fund_crypto_history: `**Crypto history** — key milestones from Bitcoin's launch to the AI agent economy.\n\n**2008:** Satoshi Nakamoto publishes the Bitcoin whitepaper ("Bitcoin: A Peer-to-Peer Electronic Cash System") on 31 October 2008\n\n**2009:** Bitcoin genesis block mined (3 Jan 2009); first transaction between Satoshi and Hal Finney\n\n**2010:** First real Bitcoin transaction: Laszlo Hanyecz buys 2 pizzas for 10,000 BTC (now worth ~$1B+)\n\n**2013:** Bitcoin reaches $1,000 for the first time; first major altcoin cycle; Mt. Gox dominates trading\n\n**2014:** Mt. Gox hack — 850,000 BTC stolen; exchange collapses\n\n**2015:** Ethereum mainnet launches; smart contracts and programmable money become a reality\n\n**2017:** ICO boom; CryptoKitties congests Ethereum; Bitcoin reaches ~$20,000\n\n**2020:** DeFi Summer — Compound launches COMP liquidity mining; Uniswap, Aave, Curve explode in TVL\n\n**2021:** NFT mania — Beeple's art sells for $69M; BAYC launches; Bitcoin hits $69,000; Axie Infinity peaks\n\n**2022:** Terra/LUNA collapse ($60B lost); Three Arrows Capital, Celsius, Voyager, FTX all fail; crypto winter\n\n**2023:** Bitcoin ETF applications multiply; USDC briefly de-pegs (SVB); Ordinals launch on Bitcoin\n\n**2024:** Bitcoin spot ETF approved in the US (January); Bitcoin halving (April); ETH spot ETF approved; BlackRock enters tokenised funds\n\n**2025:** US crypto regulatory clarity via FIT21 and SAB 121 reversal; AI x crypto narrative dominates; RWA TVL surpasses $15B\n\n**2026:** Arc mainnet live; stablecoin payment volume rivals traditional rails in key corridors; AI agents transact onchain autonomously`,

  // ── RWA sector ─────────────────────────────────────────────────────────
  rwa_overview: `**Real-World Asset (RWA) Tokenisation — Overview** is the process of representing ownership of a physical or traditional financial asset as a blockchain token, making it programmable, divisible, and tradeable 24/7.\n\n**Why RWA tokenisation matters:**\n- Traditional assets (bonds, equities, real estate) settle in days and require intermediaries\n- Tokenisation enables: fractional ownership, instant settlement (T+0), global access, programmable compliance, and DeFi composability\n- Estimated market opportunity: $10–$16 trillion of tokenisable assets by 2030 (BCG, BlackRock estimates)\n\n**The four pillars of RWA:**\n1. **Tokenised securities** — stocks, bonds, ETFs issued or mirrored on-chain\n2. **Tokenised real estate** — fractional ownership of residential and commercial property\n3. **Tokenised credit** — private loans, invoice financing, trade finance on-chain\n4. **Tokenised commodities** — gold, silver, oil, carbon credits on-chain\n\n**Key platforms:** Ondo Finance, BlackRock BUIDL, Franklin BENJI, Centrifuge, Maple Finance, Backed Finance, Swarm Markets, RealT, Parcl, Paxos Gold\n\n**Market size (2026):** Tokenised RWA TVL exceeded $15B in 2025 and is the fastest growing DeFi vertical.`,

  rwa_stocks: `**Tokenised Stocks and Equities** are blockchain-based tokens that mirror the price of publicly traded company shares, giving crypto users exposure to traditional equity markets without a brokerage account.\n\n**How tokenised stocks work:**\n- **Backed assets model:** a regulated custodian holds the real shares; tokens are issued 1:1 against them\n- **Synthetic model:** price exposure via derivatives (no underlying share held)\n- **Direct issuance:** companies issue tokenised shares directly on blockchain as a primary fundraising mechanism\n\n**Key platforms and products:**\n- **Backed Finance** — issues bTokens (e.g. bCSPX = tokenised S&P 500 ETF); backed by real shares at Interactive Brokers; ERC-20 tokens on Base and Ethereum\n- **Swarm Markets** — regulated German platform (BaFin); tokenised Apple, Tesla, Google, coinbase shares; on Polygon\n- **Ondo Finance (OMMF)** — tokenised US money market fund and equity exposure products\n- **Republic Note / Republic.co** — tokenised private equity and startup shares\n- **Kraken / Coinbase (EU/non-US)** — offered stock tokens on CFD basis before regulatory pressure\n\n**24/7 trading advantage:** traditional stock exchanges close; tokenised stocks trade around the clock, enabling global liquidity and no after-hours gaps\n\n**Regulatory status:** tokenised stocks are classified as securities in most jurisdictions; issuers require broker-dealer or equivalent licences. Not available to US retail investors in most structures.\n\n**Key risk:** if the custodian fails or misappropriates the underlying shares, tokens become worthless — due diligence on the issuer is critical.`,

  rwa_equities_protocols: `**RWA Equity Protocols and Platforms** — a detailed look at the infrastructure enabling tokenised stock markets.\n\n**Backed Finance:**\n- Incorporated in Switzerland; works with a Liechtenstein-licensed custodian\n- Products: bCSPX (S&P 500 ETF), bNVDA (Nvidia), bCOIN (Coinbase), bIBIT (BlackRock Bitcoin ETF)\n- Tokens are ERC-20 on Base and Ethereum; redeemable for real shares (qualified investors)\n- Uses chainlink oracles for real-time NAV pricing\n\n**Swarm Markets (SMT):**\n- First DeFi platform licensed under German MiCA precursor regulations\n- Live tokenised US equities (AAPL, TSLA, GOOGL, MSFT, AMZN) and crypto assets on Polygon\n- Automated Market Maker for security tokens\n\n**Dinari:**\n- US-registered transfer agent; issues dShares for US-listed equities\n- Available on Base, Arbitrum; compliant with US securities law for eligible non-US investors\n\n**Ondo Finance:**\n- OUSG: tokenised BlackRock short-term US Treasury ETF\n- USDY: yield-bearing stablecoin backed by Treasuries (not a security token)\n- OMMF: on-chain money market fund\n- Working on tokenised equity access via Ondo Global Markets\n\n**Regulatory note:** All of the above restrict US persons under Regulation D or S exemptions. European MiCA provides a clearer framework for tokenised security issuance.`,

  rwa_real_estate: `**Tokenised Real Estate** enables fractional ownership of properties — reducing the minimum investment from hundreds of thousands of dollars to as little as $50.\n\n**How it works:**\n- A Special Purpose Vehicle (SPV) holds legal title to the property\n- Tokens represent fractional ownership shares of the SPV\n- Token holders receive proportional rental income and/or capital appreciation\n- Tokens trade on secondary markets 24/7\n\n**Key platforms:**\n- **RealT** — largest tokenised real estate platform; US rental properties; tokens pay daily rental yield in USDC; 40,000+ investors in 160+ countries\n- **Parcl** — synthetic real estate index tokens tracking price/sqft of major US cities (NYC, Miami, LA) on Solana; long/short exposure without owning property\n- **Lofty AI** — Algorand-based fractional rental properties; daily ALGO rental payments\n- **Landshares / Propy** — real estate transaction settlement and tokenisation\n- **Tangible (USDR)** — real-estate-backed stablecoin on Polygon; backed by UK residential properties\n\n**Yield profile:** rental income typically 6–12% gross; varies by market and property type\n\n**Liquidity risk:** real estate tokens have thin secondary market liquidity — do not expect to exit quickly\n\n**Legal complexity:** token holders must understand the SPV structure, jurisdiction, and what legal rights tokens actually confer.`,

  rwa_commodities: `**Tokenised Commodities** bring gold, silver, oil, carbon credits, and other physical assets onto public blockchains.\n\n**Gold:**\n- **PAXG (Paxos Gold)** — each token = 1 troy oz of London Good Delivery gold held in Brinks vaults; redeemable for physical gold; ERC-20 on Ethereum\n- **XAUT (Tether Gold)** — Tether's gold token; each = 1 troy oz in Swiss vault; on Ethereum and Tron\n- **Cache Gold (CGT)** — 1g of gold per token in 11 global vaults\n\n**Silver:** SLVT and other silver tokens follow similar vault-backed models\n\n**Oil:** experimental tokenised oil barrel tokens on private chains; limited DeFi liquidity\n\n**Carbon credits:**\n- **Toucan Protocol** — bridges voluntary carbon credits onto Polygon as BCT/NCT tokens\n- **KlimaDAO** — protocol that buys and retires on-chain carbon credits; KLIMA token\n- **C3 / Flowcarbon** — similar tokenised carbon markets\n- Controversy: quality of underlying credits is uneven; "cheap" on-chain carbon ≠ high-quality offset\n\n**Agricultural commodities:** limited live products; pilot programs for tokenised crop futures\n\n**Advantages over physical:** instant settlement, no storage costs, 24/7 trading, use as DeFi collateral\n\n**Key risk:** token value is only as good as the custodian's reserves — verify audit reports.`,

  rwa_private_credit: `**Tokenised Private Credit and Fixed Income** brings institutional lending markets onto public blockchains, offering yield to DeFi participants that is uncorrelated with crypto volatility.\n\n**What is private credit?**\n- Loans made directly by non-bank lenders to businesses (not traded on exchanges)\n- Typically higher yield than public bonds due to illiquidity premium\n- TradFi private credit market: ~$1.7 trillion globally\n\n**Key platforms:**\n- **Maple Finance** — institutional lending marketplace on Ethereum and Solana; pools managed by professional credit teams; borrowers are crypto firms, RWA companies; recent pivot to US T-bill yield products\n- **Centrifuge** — the largest RWA DeFi protocol; finances real-world assets: trade finance, invoice factoring, real estate bridge loans, car loans; issues ERC-20 tokens per asset pool; integrates with MakerDAO for DAI liquidity\n- **Goldfinch** — peer-to-pool lending to businesses in emerging markets (Philippines, Kenya, Mexico); credit underwriting by local "auditors"\n- **TrueFi** — uncollateralised lending to TradFi borrowers; on-chain credit scoring\n- **Credix** — Latin America focused private credit protocol\n\n**Yield profile:** 8–15% APY in stablecoins; higher than lending protocols but with liquidity lock-ups\n\n**Risk:** default risk (loans may not be repaid), liquidity lock (funds are locked for the loan duration), smart contract risk, legal enforceability across jurisdictions`,

  rwa_regulation: `**RWA Tokenisation Regulation** is the defining challenge for this sector — turning a blockchain token into a legally enforceable claim on a real asset requires navigating securities laws, property law, and financial regulation simultaneously.\n\n**Securities law:**\n- In the US, tokenised stocks and bonds are almost certainly securities under the Howey Test\n- Must be issued under exemptions (Reg D, Reg S) or via full SEC registration\n- Reg D: US accredited investors only; Reg S: non-US investors only\n- JOBS Act Regulation A+/CF allow limited retail tokenised securities issuance\n\n**European Union — MiCA and MiFID:**\n- MiCA covers utility tokens and stablecoins but NOT security tokens\n- Security tokens fall under **MiFID II** as financial instruments\n- DLT Pilot Regime (2023) — EU sandbox allowing tokenised securities on blockchains with relaxed rules\n- Germany BaFin, Luxembourg CSSF, and Liechtenstein LIA are most active security token regulators\n\n**Singapore (MAS):**\n- Project Guardian — MAS-led pilots for tokenised bonds and funds\n- Fixed Income, FX, and Asset Management working groups with DBS, JPMorgan, SBI\n\n**UAE (DFSA / VARA):**\n- DFSA issued guidance on Security Tokens; DIFC is a hub for RWA issuance\n\n**Key legal structures:**\n- SPV (Special Purpose Vehicle) — most common; holds the asset, token = share of SPV\n- Trust structure — trustee holds asset for token holders\n- Direct tokenisation — asset recorded on blockchain as primary register (rare but enabled in some jurisdictions)\n\n**Outlook:** The combination of MiCA clarity in Europe, Project Guardian in Singapore, and US tokenisation pilots (BlackRock, Fidelity, Franklin Templeton) suggests a fast-maturing regulatory environment by 2026–2027.`,

  // ── RWA deep-dive topics ─────────────────────────────────────────────────────
  rwa_bonds: `**Tokenised Bonds and Fixed Income** — the largest and fastest-growing RWA vertical, bringing government and corporate debt on-chain.\n\n**Why bonds first?**\n- Bonds have predictable cash flows (coupons) and defined maturity dates — ideal for programmable smart contracts\n- Institutional appetite for yield in a DeFi-native format is enormous\n- US Treasury bills and bonds dominate because of their risk-free status and high demand as collateral\n\n**US Treasury products (2026 leaders):**\n- **BlackRock BUIDL** — ERC-20 on Ethereum; 100% US Treasuries; $1B+ AUM; custodied by BNY Mellon; transferable 24/7 between whitelisted wallets; pays daily dividends in USDC\n- **Franklin Templeton BENJI** — first US registered mutual fund on a public blockchain (Stellar, then Polygon); $500M+; $1 NAV target; mobile app for retail access\n- **Ondo OUSG** — tokenised BlackRock short-term US Treasury ETF; Ethereum + Solana; for qualified purchasers\n- **Ondo USDY** — yield-bearing note backed by Treasuries; accessible to non-US retail; used as a stablecoin alternative\n- **Superstate USTB** — tokenised Treasury fund; Circle provides settlement rails\n- **OpenTrade** — treasury yield products for B2B and DeFi protocols\n\n**Corporate bonds:**\n- Goldman Sachs Digital Asset Platform (GS DAP) — issued €100M digital bond for European Investment Bank\n- Société Générale Forge — issued covered bonds and green bonds as security tokens on Ethereum\n- HSBC Orion — tokenised bonds for institutional clients\n\n**How they work:**\n1. SPV/fund holds the underlying bonds\n2. Smart contract mints ERC-20 tokens representing shares\n3. Coupon/yield distributed as USDC to token holders daily or weekly\n4. Tokens redeemable for underlying at par (for qualified investors)\n\n**Yield profile (2026):** US Treasury tokens yielding 4.5–5.5% APY in USDC — higher than most DeFi lending with far lower smart contract risk`,

  rwa_defi_collateral: `**RWA Tokens as DeFi Collateral** — how tokenised real-world assets are being integrated into lending protocols to expand the DeFi collateral base.\n\n**Why RWA collateral matters:**\n- DeFi lending has historically only accepted volatile crypto as collateral (BTC, ETH, stablecoins)\n- RWA collateral brings: stable value, uncorrelated yield, and access to TradFi-grade credit\n- Expands the universe of borrowers and lenders significantly\n\n**MakerDAO / Sky — the RWA pioneer:**\n- MakerDAO was the first DeFi protocol to accept RWA collateral (2021)\n- Direct lending to Huntingdon Valley Bank, Société Générale\n- Real estate bridge loans via Centrifuge and Monetalis\n- Monetalis Clydesdale vault: $1.28B in short-term US Treasury ETFs backing DAI\n- By 2024, RWA was ~50% of MakerDAO's revenue — a complete strategic pivot from pure crypto\n\n**Aave:**\n- Aave Arc (institutional whitelisted pool) accepts RWA collateral from KYC-verified users\n- Governance voted to explore T-bill collateral to earn yield on protocol's idle USDC reserves\n\n**Morpho Blue:**\n- Centrifuge deployed Morpho vaults accepting tokenised invoices and trade finance as collateral\n\n**Benefits for DeFi protocols:**\n- Earn real yield on protocol treasuries (vs holding idle USDC)\n- Attract institutional borrowers who need onchain stablecoin liquidity\n- Diversify revenue beyond crypto-native trading fees\n\n**Risk:** RWA collateral is typically illiquid — if the smart contract is exploited or the RWA defaults, liquidation may take weeks vs seconds for crypto collateral`,

  rwa_infrastructure: `**RWA Infrastructure — Oracles, KYC, and Settlement Rails**\n\nTokenising a real-world asset requires more than a smart contract — it needs pricing feeds, identity verification, compliance checks, and a legal settlement layer.\n\n**Oracles for RWA pricing:**\n- **Chainlink** — dominant oracle provider; Real World Data feeds for NAV pricing of tokenised funds; used by Backed Finance, Ondo, and others\n- **Pyth Network** — high-frequency price feeds; used on Solana-based RWA\n- **Chronicle** — MakerDAO's in-house oracle network; secures $20B+ in RWA-backed vaults\n- Pricing challenge: most RWA assets (bonds, real estate) don't have real-time prices — stale NAV vs live token price creates arbitrage risk\n\n**On-chain KYC and compliance:**\n- **Coinbase Verifications (on-chain attestations)** — EAS-based identity claims on Base\n- **Quadrata Passport** — on-chain KYC/AML credential issued to wallet addresses\n- **Fractal ID / Synaps** — off-chain KYC that issues on-chain credentials\n- **Compliant token standards:** ERC-3643 (T-REX) — ERC-20 extension with transfer restrictions; only whitelisted wallets can hold the token\n\n**Settlement and payment rails:**\n- Circle USDC + CCTP: the de facto settlement layer for most institutional RWA products; daily yield payments in USDC\n- SWIFT gpi: some hybrid products still settle off-chain via SWIFT, then record on-chain\n- JPMorgan Onyx / J.P. Morgan Coin: private blockchain settlement for institutional repo trades\n- DTCC Project Ion: exploring DLT settlement for US equities\n\n**Custody infrastructure:**\n- Fireblocks: most widely used institutional digital asset custody MPC platform; supports RWA token issuance\n- Copper, BitGo, Anchorage Digital: qualified custodians for RWA issuers\n- BNY Mellon: custodian for BlackRock BUIDL underlying assets`,

  rwa_luxury_ip: `**Tokenised Luxury Goods, Art, and Intellectual Property** — the long tail of RWA beyond finance.\n\n**Fine art:**\n- **Masterworks** — fractional investment in blue-chip art (Basquiat, Banksy, Warhol); securitised shares; not native blockchain but pioneered the model\n- **Freeport** — Ethereum-based fractional fine art investment\n- **Async Art** — programmable art NFTs where layers can be owned and traded separately\n- Challenge: art valuation is illiquid and subjective; authenticity depends on physical custody and provenance records\n\n**Luxury watches:**\n- **Arianee Protocol** — digital passports for luxury items (LVMH, Breitling, Vacheron Constantin use it)\n- **WatchTech / Chrono24 tokenisation** — fractional luxury watch ownership pilots\n- Token represents ownership; physical watch stored in a secure vault\n\n**Collectibles and sports:**\n- **Goldin / Rally Rd** — fractional trading cards and collectibles (off-chain, CEX-style)\n- **Chiliiz / Socios** — fan tokens for sports clubs (not RWA but related)\n- **Sorare** — NFTs representing real football/baseball players; licences from 250+ clubs\n\n**Music royalties and IP:**\n- **Royal.io** — buy fractional streaming royalties from artists (3LAU, Nas); earn USDC distributions when songs are streamed\n- **Sound.xyz** — onchain music releases; collectors earn royalty splits\n- **Opulous** — music copyright NFTs and DeFi loans backed by streaming royalty income\n- **Catalog** — 1/1 music NFTs; artist receives all primary and secondary sale royalties\n\n**IP licensing:**\n- Smart contracts can automate licence payments — every time an IP is used commercially, a micro-payment flows to the token holder\n- Still early; most IP tokenisation is experimental or restricted to specific jurisdictions`,

  rwa_emerging_markets: `**RWA in Emerging Markets** — tokenisation is having outsized impact in countries with underdeveloped financial infrastructure.\n\n**Why emerging markets benefit most:**\n- Limited access to US dollar savings and investment products\n- High inflation erodes local currency savings\n- Unbanked or underbanked populations need alternative financial rails\n- Tokenised T-bills and USDC offer a "dollar savings account" without a US bank\n\n**Key use cases:**\n\n**Dollar savings for LatAm / Africa:**\n- Ondo USDY and Franklin BENJI give non-US individuals access to US Treasury yield in USDC\n- Goldfinch financed businesses in Philippines, Kenya, Mexico, Nigeria through on-chain private credit\n- Users in hyperinflationary economies (Argentina, Venezuela) use stablecoin T-bill tokens to preserve value\n\n**Agricultural supply chain finance:**\n- AgriDex — tokenised agricultural commodity trades on Solana; pilots in Africa\n- Acre Africa — blockchain-based crop insurance and micro-lending pilots in Kenya\n- Centrifuge pools: invoice financing for SMEs in emerging markets\n\n**Real estate access:**\n- RealT allows Nigerians, Brazilians, and Indonesians to earn US rental income from $50\n- Landshares and Brixkey exploring emerging market property tokenisation\n\n**Remittances:**\n- USDC stablecoin remittances are 10–100x cheaper than traditional services (Western Union, MoneyGram)\n- Tokenised assets + USDC create an end-to-end financial stack: save (T-bill token), transfer (USDC), invest (fractional property)\n\n**Regulatory landscape:**\n- UAE, Nigeria SEC, South Africa FSCA, Brazil BCB, and India RBI are all running tokenisation sandbox programmes\n- Brazil's Drex CBDC programme includes tokenised government bonds as DeFi collateral — the most advanced CBDC-RWA integration`,

  rwa_institutional_onboarding: `**Institutional RWA Onboarding** — how banks, asset managers, and corporates enter the tokenised asset space.\n\n**The institutional stack:**\n1. **Custody** — qualified custodian (Coinbase Custody, Fireblocks, BitGo, BNY Mellon)\n2. **Compliance** — KYC/AML checks, sanctions screening, on-chain identity attestations\n3. **Issuance** — legal SPV/trust structure, smart contract deployment (ERC-3643 or standard ERC-20)\n4. **Distribution** — whitelist management, primary sale, secondary market access\n5. **Reporting** — NAV calculation, on-chain accounting, tax reporting\n\n**Key institutional platforms:**\n- **Securitize** — end-to-end tokenised securities platform; KYC, issuance, transfer agent; partners include BlackRock (BUIDL) and KKR\n- **Tokeny (ERC-3643)** — compliance token issuance platform; T-REX standard; 150+ issuers; used by major European banks\n- **ADDX** — Singapore-based institutional private markets exchange for tokenised securities\n- **Arca Labs** — US digital asset securities management\n- **Chintai** — tokenised securities and fund infrastructure on EVM; Singapore-based\n\n**Barriers institutions face:**\n- Fragmented legal frameworks across jurisdictions\n- Smart contract audit and insurance requirements\n- Tax treatment of tokenised assets unclear in many countries\n- Interoperability: SWIFT-connected institutions need a bridge to DLT settlement\n- Investor education: understanding wallets, gas, private keys\n\n**Solutions being built:**\n- SWIFT interlinking with DLT networks (SWIFT connector pilots with Chainlink CCIP)\n- Bank-issued wallets with embedded custody (no seed phrase for corporate users)\n- Regulated secondary markets for tokenised securities (ADDX, Archax, SDX)`,

  rwa_future: `**The Future of RWA Tokenisation** — where the sector is heading in 2026 and beyond.\n\n**Near-term (2026–2027):**\n- Total tokenised RWA (ex-stablecoins) projected to exceed $50B\n- US and EU regulatory clarity will unlock institutional flows\n- Tokenised money market funds become the preferred DeFi collateral (replacing stablecoins in some contexts)\n- More sovereign bonds tokenised: Singapore SGS bonds, EU EIB bonds, Brazil Drex T-bonds\n\n**Medium-term (2027–2030):**\n- BCG/BlackRock estimates $10–16T addressable tokenisation market\n- Tokenised equities gain traction as regulated secondary markets develop\n- Real estate tokenisation scales with legal clarity and improved liquidity pools\n- DeFi protocols become fully "real-yield" — backed by RWA rather than crypto inflation\n\n**Technical evolution:**\n- **CCIP (Chainlink)** — cross-chain interoperability for RWA tokens; hold on Ethereum, use as collateral on Arbitrum\n- **ERC-3643 (T-REX)** — compliance-native token standard goes mainstream\n- **ZK identity proofs** — prove KYC compliance without revealing identity on-chain\n- **Programmable compliance** — automatic transfer restrictions, dividend distribution, and voting rights encoded in the token\n\n**The endgame:**\n- Every financial asset has an on-chain representation\n- T+0 global settlement becomes standard\n- DeFi and TradFi merge into a single liquidity layer\n- Retail investors globally access institutional-grade products from a wallet\n- AI agents manage RWA portfolios autonomously, rebalancing across chains in real time\n\n**Key risks to watch:** regulatory backsliding, smart contract exploits on large RWA pools, custody failures, and legal enforceability challenges in cross-border disputes.`,

  rwa_market_overview: `**The RWA Tokenisation Market — 2026 Overview** tracks adoption, TVL, and institutional momentum.\n\n**TVL and market metrics:**\n- Total tokenised RWA on-chain (ex-stablecoins): ~$15–20B in 2026\n- Tokenised Treasuries: ~$6–8B (fastest growing segment)\n- Private credit on-chain: ~$4–5B\n- Tokenised real estate: ~$200–300M\n- Tokenised commodities (gold): ~$1–2B (PAXG + XAUT)\n\n**Institutional entrants (2024–2026):**\n- **BlackRock BUIDL** — tokenised Treasury fund on Ethereum; $500M+ in first weeks\n- **Franklin Templeton BENJI** — US registered money market fund on Stellar/Polygon; $350M+\n- **JPMorgan Onyx** — tokenised repo transactions; $1T+ in transactions\n- **Goldman Sachs DAP** — Digital Asset Platform; tokenised bonds\n- **Deutsche Bank, HSBC, Citi** — all running tokenisation pilots\n\n**Chain preferences:**\n- Ethereum: most institutional RWA (compliance tooling, largest DeFi TVL)\n- Stellar: Franklin Templeton BENJI; built for payments and asset issuance\n- Polygon: Swarm Markets, RealT, Centrifuge\n- Solana: Maple Finance, Ondo expanding to Solana\n- Base: Backed Finance, Dinari\n\n**Growth catalysts:**\n- Regulatory clarity in EU (MiCA DLT Pilot) and Singapore (Project Guardian)\n- Institutional demand for on-chain yield distribution\n- DeFi protocols accepting RWA tokens as collateral (MakerDAO, Aave)\n- Circle and CCTP making USDC the settlement layer for tokenised assets\n\n**Key risk:** illiquidity of underlying assets during market stress; custody/legal risk remains the biggest barrier to mainstream adoption.`,

  // ── NFT sector ─────────────────────────────────────────────────────────
  nft_overview: `The **NFT sector** encompasses all blockchain-based markets for unique digital assets. After an explosive peak in 2021–2022, the market matured into more niche segments: digital art, gaming, music rights, sports collectibles, and real-world asset tokenization.\n\n**Key standards:**\n- **ERC-721** — one token = one unique asset (Ethereum)\n- **ERC-1155** — batch minting, mix fungible + non-fungible\n- **Metaplex** — Solana's NFT standard\n\n**Leading marketplaces:**\n- **OpenSea** — largest multi-chain NFT marketplace\n- **Blur** — pro trading platform with aggregator and lending\n- **Zora** — creator-focused, onchain minting protocol\n- **Magic Eden** — dominant on Solana and Bitcoin Ordinals\n- **Tensor** — Solana NFT trading with advanced order types`,

  nft_art: `**NFT digital art** allows creators to issue verifiably scarce, ownable digital works on-chain — solving the "right-click save" problem by anchoring provenance to a public ledger.\n\n**Landmark collections:**\n- **CryptoPunks** (2017) — 10,000 pixelated characters, one of the earliest NFT collections\n- **Bored Ape Yacht Club (BAYC)** — 10,000 generative apes; holders gain IP and community access\n- **Art Blocks** — on-chain generative art platform; code stored fully on Ethereum\n- **Fidenza, Ringers** — high-value Art Blocks pieces\n\n**Creator royalties:** ERC-2981 standard enables on-chain royalty enforcement so artists earn a % on every secondary sale.\n\n**Storage:** Most NFT images live off-chain (IPFS, Arweave). A truly "on-chain" NFT stores all data directly in the contract.`,

  nft_gaming: `**NFT gaming** (GameFi) lets players own in-game items as tradeable onchain assets — skins, weapons, characters, and land parcels that exist independently of any game server.\n\n**Models:**\n- **Play-to-Earn (P2E)** — players earn token rewards; pioneered by Axie Infinity\n- **Free-to-Own** — NFTs distributed free to build community (pioneered by Limit Break)\n- **Full Onchain Games (FOCGs)** — game logic lives entirely in smart contracts; censorship-resistant\n\n**Notable projects:**\n- **Axie Infinity** — P2E battle game on Ronin chain\n- **Gods Unchained** — onchain trading card game\n- **Illuvium** — AAA RPG with tradeable assets\n- **Dark Forest** — ZK-based fully onchain strategy game\n\n**Risks:** P2E economies can collapse if token price falls; games shutdown while NFTs remain.`,

  // ── GameFi deep dives ─────────────────────────────────────────────────────
  gamefi_overview: `**GameFi** is the fusion of blockchain technology, NFTs, and DeFi mechanics into video game experiences. It emerged as a major category during the 2021 crypto bull market and has evolved substantially since.\n\n**Core pillars:**\n- **Asset ownership** — in-game items are NFTs on public blockchains; players truly own them\n- **Interoperability** — assets can theoretically move between games (still mostly aspirational)\n- **Player economies** — in-game currencies are real tokens with market prices\n- **Transparent rules** — game logic verifiable on-chain\n\n**Market size:** GameFi peaked at over $20B in NFT gaming assets in 2022. The market contracted severely in 2022–2023 as P2E economies collapsed, then began rebuilding with more sustainable models in 2024–2026.\n\n**Key infrastructure:** Ronin (Axie), Immutable X (IMX), Arbitrum, Polygon, and dedicated L3 app-chains are the preferred platforms for gaming due to low fees and high throughput.\n\n**Why it matters:** Games are the largest media industry globally. Blockchain ownership could fundamentally change how value flows between players, developers, and studios.`,

  gamefi_models: `**GameFi business models** have evolved from the unsustainable P2E wave to more nuanced approaches.\n\n**Play-to-Earn (P2E):**\n- Players earn token rewards for playing\n- Problem: requires constant new player inflow to sustain token price (Ponzi dynamic)\n- Axie Infinity's SLP token collapsed 99% when new player growth stopped\n- Still exists but requires careful tokenomics design\n\n**Free-to-Own (F2O):**\n- NFTs given free to players; no upfront cost barrier\n- Pioneered by Limit Break (DigiDaigaku)\n- Lowers barrier to entry, builds community before monetisation\n\n**Play-and-Earn:**\n- Fun-first game design; earning is secondary\n- Tokens earned through skill, not grinding\n- Examples: Gods Unchained, Parallel TCG\n\n**Full Onchain Games (FOCGs):**\n- All game state and logic on the blockchain\n- Permissionless: anyone can build on top, fork, or extend\n- MUD framework (lattice.xyz) is the leading development toolkit\n- Examples: Dark Forest, Primodium, OPCraft\n\n**AAA GameFi:**\n- Traditional AAA production values + blockchain ownership layer\n- Illuvium, Big Time, Shrapnel — multi-year development\n- Risk: long time-to-market, high capital requirements`,

  gamefi_economy: `**GameFi token economies** are the most complex and fragile part of blockchain gaming. Most have failed; understanding why matters.\n\n**Dual-token model (common pattern):**\n- **Governance token** — scarce, used for staking/voting (e.g. AXS in Axie)\n- **Utility/reward token** — earnable in-game, spendable on upgrades (e.g. SLP in Axie)\n- Problem: utility tokens inflate rapidly if there are more earners than burners\n\n**Token sinks (burn mechanisms):**\n- Breeding new characters (Axie)\n- Crafting and upgrading items\n- Entry fees for tournaments\n- Land maintenance costs\n- Without strong sinks, reward tokens inflate to zero\n\n**The Scholarship model (Axie-era):**\n- NFT owners (managers) lent Axies to players in developing countries who couldn't afford to buy in\n- Managers took 30–50% of earnings\n- Created real incomes in Philippines, Venezuela during peak — but collapsed when SLP price crashed\n\n**Sustainable model principles:**\n- Value must enter the economy (new players, in-game purchases, sponsorships)\n- Earn rate must not exceed value creation\n- Game must be fun independent of financial incentives\n- Transparent on-chain treasury management`,

  gamefi_platforms: `**GameFi infrastructure platforms** provide the chain, tooling, and marketplace layer for blockchain games.\n\n**Dedicated gaming chains:**\n- **Ronin** — Axie Infinity's custom EVM sidechain; gasless transactions, ~$0 fees; suffered $625M hack in 2022 (Lazarus Group)\n- **Immutable X** — Ethereum L2 for gaming using StarkEx ZK proofs; zero gas fees for NFT mints; home to Gods Unchained, Guild of Guardians\n- **Immutable zkEVM** — EVM-compatible ZK rollup from Immutable; launched 2024 for broader developer adoption\n- **Ancient8** — Ethereum L2 gaming chain backed by Coinbase; Southeast Asia focus\n\n**General chains popular for gaming:**\n- **Arbitrum** — low fees, EVM; home to Treasure ecosystem (MAGIC token)\n- **Polygon** — used by Ubisoft, Atari, early gaming NFT projects\n- **Avalanche** — Avalanche subnets used by DeFi Kingdoms, Shrapnel\n- **Solana** — Star Atlas, Aurory, Genopets\n\n**Development toolkits:**\n- **MUD** (lattice.xyz) — onchain game engine; store all game state as smart contract tables\n- **Dojo** (Starknet) — Cairo-based onchain game engine\n- **Unity / Unreal SDKs** — Thirdweb, Immutable, Sequence all offer game engine SDKs`,

  gamefi_projects: `**Notable GameFi projects** span from early pioneers to modern AAA titles and fully onchain experiments.\n\n**Pioneers:**\n- **CryptoKitties** (2017) — the first viral blockchain game; breeding cats as NFTs; famously congested Ethereum\n- **Axie Infinity** (2018/2021) — P2E battle game; peaked at 2.7M daily players in 2021; AXS token hit $165; SLP token collapsed\n\n**Trading Card Games:**\n- **Gods Unchained** — Immutable X; free-to-play TCG where cards are ERC-721 NFTs\n- **Parallel TCG** — sci-fi card game on Base; $PRIME token; used AI-generated art\n- **Sorare** — fantasy football with NFT player cards licensed from real clubs\n\n**RPG / AAA:**\n- **Illuvium** — open-world auto-battler RPG on Immutable; multi-year development; highly anticipated\n- **Big Time** — time-travel action RPG; sold in-game land and cosmetics as NFTs pre-launch\n- **Shrapnel** — AAA extraction shooter on Avalanche subnet\n\n**Strategy / Sandbox:**\n- **The Sandbox** — voxel metaverse world; SAND token; land NFTs; brands bought virtual land\n- **Decentraland** — Ethereum-based 3D world; MANA token; DAO-governed\n- **DeFi Kingdoms** — RPG meets DeFi; JEWEL token; crossed $1B TVL\n\n**Fully Onchain:**\n- **Dark Forest** — ZK-based strategy game; all state on-chain\n- **Primodium** — resource management FOCG on MUD framework\n- **0xPlanet / OPCraft** — Minecraft-like voxel world fully on Optimism`,

  gamefi_guilds: `**Gaming guilds** emerged as a core GameFi institution — organisations that accumulate NFT game assets and deploy them to players in exchange for a share of earnings.\n\n**What guilds do:**\n- Buy NFTs (Axies, game characters, land) in bulk\n- Lend NFTs to "scholars" — players who can't afford to buy in\n- Scholars play and earn tokens; guild takes 20–50%\n- Guild manages dozens to thousands of assets across multiple games\n\n**Peak guild era (2021–2022):**\n- **Yield Guild Games (YGG)** — the largest; raised $4.6M in IDO in 8 seconds; expanded to 18 countries\n- **Merit Circle** — Dutch guild; transitioned to a gaming DAO and launchpad\n- **Avocado Guild** — Southeast Asia focus\n- **GuildFi** — Thailand-based; aggregator for guild infrastructure\n\n**Post-collapse evolution:**\n- The scholarship model collapsed with P2E economies in 2022\n- Guilds pivoted to: game launchpads, token publishing, developer funding, and esports\n- YGG rebranded as a "Web3 gaming network" — community + quests + token incentives\n- Merit Circle rebranded as **Beam** — a gaming-focused EVM blockchain\n\n**Guild infrastructure:**\n- On-chain treasury management (Gnosis Safe)\n- Delegation contracts for automated revenue splitting\n- Analytics dashboards tracking scholar performance across games`,

  // ── GameFi deep-dive topics ──────────────────────────────────────────────
  gamefi_ronin: `**Ronin — the blockchain built for gaming** is an EVM sidechain created by Sky Mavis specifically to run Axie Infinity at scale, and later opened to other game developers.\n\n**Technical design:**\n- Delegated Proof-of-Stake (DPoS) with 22 validators\n- Near-zero gas fees — users get a daily free transaction quota\n- EVM-compatible; games migrate from Ethereum without rewriting contracts\n- Ronin Bridge connects to Ethereum for asset movement\n\n**The $625M hack (March 2022):**\n- Lazarus Group (North Korean state hackers) compromised 5 of 9 Ronin validator keys\n- Drained 173,600 ETH and $25.5M USDC — the largest DeFi hack in history\n- Sky Mavis reimbursed users; added validators; overhauled security\n- The bridge was relaunched with decentralised validators and Chainlink oracle backup\n\n**Ecosystem beyond Axie:**\n- Ronin opened to third-party developers in 2022\n- Mavis Hub — the app store and marketplace for Ronin games\n- Katana — Ronin's native DEX for in-game token trading\n- RON token — used for gas and validator staking\n- Games on Ronin: Pixels (farming RPG, 1M+ daily players 2024), Axie Homeland, Wild Forest, Lumiterra\n\n**Pixels surge (2024):** Pixels migrated to Ronin from Polygon and became the most played blockchain game globally at its peak — proving Ronin's value beyond Axie.`,

  gamefi_treasure: `**Treasure DAO and Arbitrum gaming** — the largest Web3 gaming ecosystem on an EVM L2.\n\n**Treasure DAO:**\n- Decentralised gaming ecosystem on Arbitrum\n- MAGIC token is the reserve currency of the Treasure metaverse\n- Started as a loot-derivative project; evolved into a full gaming ecosystem\n\n**Key games in Treasure:**\n- **Bridgeworld** — the flagship strategy game; MAGIC stakers mine resources\n- **Smol Brains** — popular PFP collection with gaming integrations\n- **The Beacon** — dungeon crawler RPG; uses MAGIC for upgrades\n- **Realm** — city-building game\n- **Toadstoolz, Battlefly** — community-built games in the Treasure ecosystem\n\n**MAGIC token mechanics:**\n- Staked MAGIC mines resources in Bridgeworld\n- Used to craft items, power upgrades, enter game loops\n- Emission schedule designed to slow over time\n\n**TreasureChain (2024):**\n- Treasure migrated to its own dedicated L3 gaming chain\n- Built on Arbitrum Orbit; EVM-compatible\n- Reduced gas costs further for in-game transactions\n\n**Broader Arbitrum gaming:**\n- **Xai** — Offchain Labs gaming L3 on Arbitrum; focus on traditional game studios\n- **Pirate Nation** — fully onchain RPG on Arbitrum Nova\n- Arbitrum grants program attracted 20+ gaming teams in 2023–2024`,

  gamefi_solana_gaming: `**Solana gaming** — ultra-low fees and high throughput make Solana a natural home for blockchain games requiring frequent microtransactions.\n\n**Why Solana for gaming:**\n- Sub-cent transaction fees — in-game actions (move, attack, craft) are economically viable\n- ~400ms block times — near-real-time state updates\n- Compressed NFTs (cNFTs) — mint millions of in-game items for a fraction of the cost on Ethereum\n- Strong consumer wallet ecosystem (Phantom, Backpack, Solflare)\n\n**Notable Solana games:**\n- **Star Atlas** — most ambitious Solana game; space exploration MMO; ATLAS and POLIS tokens; AAA unreal engine quality; multi-year development\n- **Aurory** — JRPG-style game; Aurorian NFT characters; AURY token; launched on Solana and Sonic SVM\n- **Genopets** — move-to-earn game; real-world activity drives in-game progress; Kinect integration\n- **Nyan Heroes** — hero shooter; cats vs robots; launched on Epic Games Store\n- **Honeyland** — bee colony simulation; HONEY token\n- **DRiP** — free compressed NFT platform; artists send cNFTs weekly to holders; millions of cNFTs distributed\n\n**Sonic SVM:**\n- Gaming-focused Solana Virtual Machine (SVM) L2\n- Designed for games needing isolated throughput\n- Aurory migrated here for its full launch\n\n**GameShift (Solana Labs):**\n- Solana Labs developer API for game studios\n- Abstracts wallet creation, NFT minting, and token transfers behind a REST API\n- Lets Web2 game studios integrate blockchain without Solana expertise`,

  gamefi_mobile: `**Mobile GameFi** — where blockchain gaming meets the world's largest gaming platform.\n\n**Why mobile matters:**\n- 3.2 billion mobile gamers globally; far larger addressable market than PC/console\n- Most P2E early adopters (Philippines, Vietnam, Indonesia, Brazil) play primarily on mobile\n- App store restrictions created major headwinds (Apple/Google initially blocked NFT games)\n\n**App store evolution:**\n- **Apple App Store policy (2023):** NFT apps allowed but in-app NFT purchases must use Apple's payment system (30% fee)\n- **Google Play policy (2023):** blockchain games allowed; tokenised assets permitted; must comply with gambling laws\n- Workaround: many games use browser-based checkout, then deliver NFTs to linked wallets\n\n**Notable mobile GameFi:**\n- **Notcoin** — Telegram tap-to-earn game on TON blockchain; 35M+ players; the largest crypto game by user count; launched NOT token\n- **Hamster Kombat** — Telegram-based clicker game; 200M+ registered users; HMSTR token airdrop\n- **Pixels** — browser/mobile farming RPG on Ronin; 1M+ daily users at peak\n- **STEPN** — move-to-earn; earn GST/GMT tokens by walking/running tracked via GPS; peaked $400M+ market cap; significant decline post-peak\n- **Catizen** — Telegram cat game; multi-million users\n\n**Telegram Mini Apps (TON ecosystem):**\n- Telegram's 900M+ users are a direct pipeline to GameFi\n- TON blockchain powers Notcoin, Hamster Kombat, and hundreds of clicker games\n- Low-friction onboarding: no MetaMask, no seed phrase — Telegram handles the wallet\n\n**Challenges:** retention beyond earning incentives; app store fees; device fragmentation`,

  gamefi_web2_studios: `**Web2 game studios entering Web3** — how established publishers are (cautiously) integrating blockchain.\n\n**Early failures (2021–2022):**\n- Ubisoft Quartz (Ghost Recon cosmetic NFTs) — community backlash; shelved within months\n- Team17 (Worms NFTs) — cancelled after developer uproar\n- S.T.A.L.K.E.R. 2 NFT plans — cancelled after fan pressure\n- Pattern: top-down corporate NFT initiatives failed; player communities rejected them\n\n**Cautious re-engagement (2024–2026):**\n- **Square Enix** — sold some Western studios to fund Web3 initiatives; Symphony of Origin; vocal CEO support\n- **Nexon** — MapleStory Universe on Polygon; long-running IP adapting to onchain economies\n- **Kabam** — Infinite Victory on Immutable; mobile gaming veteran entering Web3\n- **Mythical Games** — NFL Rivals and Blankos on their own EVM chain (Mythos)\n- **Atari** — VCS console; partnerships with The Sandbox\n\n**What works:**\n- Games designed as blockchain-native from the start (not retrofitted)\n- Player-first design: blockchain ownership is an enhancement, not the feature\n- Incremental integration: start with cosmetics and collectibles before core gameplay tokens\n- Studio acqui-hires: hiring Web3 studios or talent rather than converting existing teams\n\n**Key studios building natively:**\n- Fenix Games — acquires and publishes blockchain game titles\n- Playtika — mobile gaming giant piloting blockchain rewards\n- Animoca Brands — the most active Web3 gaming investor/publisher (100+ portfolio companies)`,

  gamefi_investing: `**Investing in GameFi** — how to evaluate blockchain game projects and associated tokens.\n\n**Due diligence framework:**\n\n**Team and studio:**\n- Shipping history: has the team released games before?\n- Web3 experience vs Web2 pedigree — ideal is both\n- Funding and backers: a16z, Paradigm, Animoca, Griffin Gaming signal credibility\n- Token vesting: are team tokens locked for 1–3 years? Early unlocks are a red flag\n\n**Game quality and design:**\n- Is it fun without financial incentives?\n- Play a demo or alpha if available\n- Art style and production value — judge against Web2 competitors\n- Lore and IP — strong IP retains players\n\n**Tokenomics:**\n- Is the token required for gameplay or purely speculative?\n- What are the token sinks? Are they strong enough to offset emissions?\n- Dual-token vs single-token — dual-token is higher complexity and higher failure risk\n- Initial token distribution: high % to team/VCs = potential dump risk\n\n**Chain and infrastructure:**\n- Is the chain live and battle-tested?\n- Gas fees during peak usage\n- What happens to NFTs if the game shuts down?\n\n**Community:**\n- Discord/Telegram activity and quality\n- Organic vs bot-inflated follower counts\n- Are players playing because they enjoy it, or purely farming?\n\n**Red flags:**\n- Promises of guaranteed returns\n- No playable product after 2+ years of development\n- Anonymous team with no track record\n- Scholarship-only player base (100% dependent on earn incentives)`,

  gamefi_safety: `**GameFi safety and scams** — the unique risks facing players and investors in blockchain gaming.\n\n**Common scam types:**\n\n**Rug pulls:**\n- Team mints NFTs, raises funds, then abandons the project\n- Signs: anonymous team, no vesting, no prototype, hype without substance\n- Example: Evolved Apes (2021) — developer stole $2.7M worth of ETH from NFT mint, disappeared\n\n**Fake scholarship programs:**\n- "Scholarships" that require upfront deposits or wallet access\n- Real scholarship programmes never require payment — the guild provides the NFTs\n\n**Wallet drainers:**\n- Malicious NFT mint sites that include approval transactions draining your wallet\n- Always check what you are approving before signing; use revoke.cash to audit approvals\n\n**Smart contract exploits:**\n- Ronin bridge hack: $625M\n- Wormhole bridge hack: $320M (affected Solana game assets)\n- Harvest Finance, Vulcan Forged, others: all affected GameFi players\n\n**Fake token listings:**\n- Scammers create fake versions of game tokens on DEXs\n- Always verify the official token contract address from the game's official website\n\n**Pump-and-dump game tokens:**\n- Influencers paid to promote games; dump after retail buys in\n\n**Protecting yourself:**\n- Use a separate wallet for gaming (never connect your main wallet to games)\n- Keep NFT assets in a cold wallet; only move to a hot wallet when playing\n- Never give seed phrases or private keys to anyone, including "support"\n- Check contract addresses on the game's official website before interacting\n- Review token unlock schedules before investing in game tokens`,

  gamefi_future: `**The future of GameFi** is shaped by lessons from the 2021–2022 boom-and-bust and new technology enabling more ambitious designs.\n\n**Emerging trends:**\n- **AI NPCs** — non-player characters powered by LLMs; on-chain ownership of AI agent companions\n- **Agent-driven economies** — autonomous AI agents participating in onchain game economies\n- **Fully onchain physics** — ZK proofs enabling real-time state verification without centralised servers\n- **Cross-game asset interoperability** — standards work by Immutable, Sequence, and ERC-6551 (token-bound accounts)\n- **Onchain esports** — verifiable tournament results, prize distribution, and anti-cheat via ZK proofs\n\n**ERC-6551 (Token Bound Accounts):**\n- Each NFT can have its own wallet address\n- A character NFT can "own" its inventory items\n- Enables composable, nested asset ownership\n\n**Challenges remaining:**\n- Scalability — games need millions of cheap transactions\n- UX — wallets and gas are still friction for mainstream players\n- Game quality — most blockchain games lag far behind AAA Web2 games\n- Tokenomics — sustainable in-game economies are still hard to design\n\n**Outlook:** GameFi's long-term success depends on delivering games people want to play first, with blockchain ownership as an enhancement — not the primary incentive.`,

  nft_rwa: `**Real-World Asset (RWA) tokenization** is the process of issuing an NFT or token representing ownership of a physical asset — bridging TradFi and DeFi.\n\n**Asset types being tokenized:**\n- Real estate (fractional property ownership)\n- Treasury bonds and fixed income (Ondo Finance, OpenTrade)\n- Private credit and loans\n- Commodities (gold, carbon credits)\n- Luxury goods (watches, art)\n\n**Why it matters:** Tokenized RWAs unlock 24/7 trading, fractional ownership, programmable compliance, and instant settlement for assets that traditionally take days to settle.\n\n**Leading protocols:** Centrifuge, Maple Finance, Ondo Finance, Goldfinch\n\n**Regulatory note:** Tokenized securities must comply with local securities law — a major barrier to mainstream adoption.`,

  // ── Meme coin sector ────────────────────────────────────────────────────
  memecoins: `**Meme coins** are cryptocurrencies inspired by internet culture, jokes, or viral moments rather than utility or technology. They are driven almost entirely by community sentiment and social media momentum.\n\n**The originals:**\n- **Dogecoin (DOGE)** — launched 2013 as a joke based on the Shiba Inu meme; became a top-10 coin\n- **Shiba Inu (SHIB)** — self-described "Dogecoin killer"; launched the ShibaSwap DEX\n\n**The 2024–2025 wave:**\n- **WIF (dogwifhat)** — Solana-based Shiba Inu with a hat; reached multi-billion market cap\n- **BONK** — Solana community meme coin airdropped to NFT holders\n- **PEPE** — Ethereum-based Pepe the Frog token\n- **BRETT, MOG, POPCAT** — Base and Solana meme coins\n\n**Characteristics:** Unlimited or near-unlimited supply, no product, speculative only. Extremely high volatility — many go to zero.`,

  meme_launchpads: `**Meme coin launchpads** are permissionless platforms that let anyone deploy a meme coin in seconds, usually with a built-in bonding curve that bootstraps liquidity automatically.\n\n**How bonding curves work:**\n1. Token price starts very low\n2. Each buy increases the price along a curve\n3. When market cap reaches a threshold (e.g. $69K on pump.fun), liquidity migrates to a DEX\n4. Sellers can exit at any time\n\n**Major platforms:**\n- **pump.fun** (Solana) — the dominant launchpad; hundreds of thousands of tokens created\n- **Clanker** (Base) — AI-integrated token launcher triggered by Farcaster mentions\n- **Four.meme** (BNB Chain) — BNB ecosystem launchpad\n\n**Risks:** Most tokens launched are worthless or outright scams. The vast majority never graduate from the bonding curve. Rug pulls are common — deploy, pump, abandon.`,

  meme_culture: `**Meme coin culture** is a distinct subculture within crypto with its own language, rituals, and social dynamics.\n\n**Key concepts:**\n- **CT (Crypto Twitter / X)** — the primary social layer where narratives form and spread\n- **Narrative rotation** — capital cycles from one meme theme to the next (AI coins, dog coins, cat coins, political coins)\n- **KOLs (Key Opinion Leaders)** — influencers who can move meme coin prices with a single post\n- **Sniping** — buying a token in the first block after launch for maximum gain\n- **Bundling** — using multiple wallets to accumulate a large % of supply at launch\n- **Insider wallets** — addresses that buy before public announcement\n\n**Seasons:** Meme coin mania tends to coincide with bull market peaks. Most participants lose money; a small number of early buyers capture most gains.\n\n**Caution:** Meme coins carry the highest risk in crypto. Never invest more than you can afford to lose entirely.`,

  // ── NFT deep dives ────────────────────────────────────────────────────────
  nft_marketplaces: `**NFT Marketplaces** are the trading venues where buyers and sellers exchange non-fungible tokens. The landscape has shifted dramatically since 2021.\n\n**Major platforms:**\n- **OpenSea** — the original dominant marketplace; multi-chain (Ethereum, Polygon, Base, Solana); faced competition eroding share\n- **Blur** — launched 2022; designed for pro traders; introduced pro-style order books, aggregation, and NFT lending (Blend); briefly captured majority Ethereum volume\n- **Zora** — creator-first, onchain minting protocol; rewards creators on every mint; no platform fees\n- **Magic Eden** — dominant on Solana; expanded to Ethereum, Bitcoin Ordinals, and Base\n- **Tensor** — Solana-native with advanced AMM pools, limit orders, and sweep tools\n- **X2Y2, LooksRare** — early challengers to OpenSea with token incentives\n\n**Royalties war:** In 2022–2023, many platforms made royalties optional to attract traders. Zora and some collections fought back with on-chain enforcement. The debate over creator compensation remains active.`,

  nft_bitcoin_ordinals: `**Bitcoin Ordinals** is a protocol introduced in January 2023 by developer Casey Rodarmor that enables arbitrary data — images, text, code, audio — to be inscribed directly onto individual satoshis (the smallest Bitcoin unit).\n\n**How it works:**\n- Each satoshi is assigned an ordinal number based on mining order\n- Inscriptions attach data to a specific satoshi via Bitcoin's Taproot upgrade (SegWit witness data)\n- Data is stored fully on-chain — no IPFS, no external link\n\n**Why it matters:**\n- Bitcoin NFTs without any new protocol layer or token\n- Immutable and permanent — as long as the Bitcoin blockchain exists\n- Controversial: critics argue inscriptions clog the blockchain and inflate fees\n\n**Notable collections:** Bitcoin Puppets, NodeMonkes, Ordinal Punks, Satoshi Nakamoto inscriptions\n\n**BRC-20:** An experimental fungible token standard on Bitcoin using Ordinals for meme coins like ORDI and SATS.`,

  nft_utility: `**Utility NFTs** go beyond images — they grant holders real access, rights, or functionality.\n\n**Types of utility:**\n- **Membership access** — token-gated communities, Discord servers, events (Bored Ape holders get IRL events)\n- **IP rights** — some projects (BAYC, Nouns) grant holders commercial rights to their NFT's image\n- **Gaming assets** — weapons, characters, land that function in games (Axie, Illuvium)\n- **Event tickets** — Coachella, Token2049, and other events have used NFTs as verifiable tickets\n- **DeFi collateral** — NFTs can be borrowed against on platforms like Blend (Blur) and NFTfi\n- **Domain names** — ENS (.eth), Unstoppable Domains (.crypto) are NFTs that function as readable wallet addresses\n\n**Soulbound Tokens (SBTs):** Non-transferable NFTs proposed by Vitalik Buterin to represent credentials, certifications, and reputation — cannot be sold or transferred.`,

  nft_lifecycle: `**The NFT lifecycle** describes the journey of an NFT from creation to trading and beyond.\n\n**1. Creation (Minting):**\n- Creator deploys or uses an ERC-721/ERC-1155 contract\n- Media is typically stored on IPFS or Arweave (not on-chain, unless specifically designed)\n- Metadata JSON links token ID to image and traits\n\n**2. Primary Sale:**\n- Public mint (fixed price, Dutch auction, or allowlist)\n- Dutch auction: price starts high and drops over time until all mint\n- Allowlist: early supporters get guaranteed mint spots before public\n\n**3. Secondary Market:**\n- Trading on OpenSea, Blur, Tensor etc.\n- Floor price = cheapest listed NFT in the collection\n- Volume and floor are key health metrics\n\n**4. Reveal:**\n- Many collections launch as unrevealed "mystery boxes"\n- Traits are assigned randomly at reveal\n\n**5. Long-term fate:**\n- Blue-chip collections retain value and community\n- Most collections go to zero — developers abandon, community dissolves\n- Strong IP and onchain storage maximise long-term survival`,

  nft_solana_ecosystem: `**Solana's NFT ecosystem** is the second-largest after Ethereum, known for ultra-low minting costs and a vibrant gaming/meme culture.\n\n**Standards:**\n- **Metaplex** — the dominant Solana NFT protocol; handles minting, metadata, and marketplaces\n- **Token Extensions (Token-2022)** — newer standard adding features like transfer fees, confidential transfers, and permanent delegate\n- **cNFTs (Compressed NFTs)** — use Merkle trees to store millions of NFTs cheaply; used for massive airdrops\n\n**Flagship collections:**\n- **DeGods** — high-culture PFP collection; migrated to Ethereum\n- **y00ts** — companion collection to DeGods\n- **Mad Lads** — PFPs tied to the Backpack wallet ecosystem\n- **Tensorians** — Tensor platform's native collection\n- **SMB (Solana Monkey Business)** — OG Solana collection (2021)\n\n**Key marketplaces:** Magic Eden, Tensor\n\n**Minting cost:** A Solana NFT mint costs ~$0.001–$0.005 vs $5–$50 on Ethereum mainnet.`,

  // ── NFT deep-dive topics ─────────────────────────────────────────────────────
  nft_music: `**Music NFTs** are a new model for artists to sell ownership of their music directly to fans — replacing streaming royalties and label advances with direct fan-to-artist value transfer.\n\n**How music NFTs work:**\n- An artist mints a song, album stem, or release as an NFT\n- The buyer receives ownership of that edition; some carry streaming royalty rights\n- Artists retain creative control and a much larger share of revenue (~80–100% primary, set royalties on secondary)\n\n**Key platforms:**\n- **Sound.xyz** — dominant Ethereum music NFT platform; "listening parties" let fans collect early; top artists earn $50K–$500K per drop\n- **Catalog** — 1-of-1 music NFT editions; single-edition records collected by music fans\n- **Zora** — open protocol; many artists self-publish music NFTs and earn secondary royalties\n- **Audius** — decentralised music streaming + tipping; AUDIO token rewards for artists and curators\n- **Opulous** — music royalty-backed loans and fractionalized royalty ownership\n- **Royal.io** — sell fractional streaming royalties (Spotify, Apple Music share) to holders; 3LAU and Nas have done drops\n\n**The economic model:**\n- Primary sale: artist sets price and edition size; fans speculate on artist growth\n- Secondary royalties: typically 5–10%; every resale pays the artist forever\n- Streaming integration: some platforms route Spotify/Apple Music royalties on-chain to token holders\n\n**Why it matters:** A top 0.1% artist on Spotify earns ~$3,000/month from streaming. The same artist selling 200 NFTs at $100 each earns $20,000 in one drop — with ongoing secondary royalties on top.`,

  nft_sports: `**Sports NFTs and Collectibles** brought mainstream brands and audiences into the NFT space with officially licensed digital trading cards, moments, and memorabilia.\n\n**Major platforms:**\n- **NBA Top Shot (Dapper Labs / Flow)** — the breakout 2021 hit; licensed NBA video "moments" as NFTs; $1B+ in sales; introduced millions to NFTs via pack drops\n- **NFL All Day** — same model for American football; on Flow blockchain\n- **Sorare** — fantasy football meets NFT trading cards; licensed by 250+ football clubs, NBA, MLB; cards used in weekly fantasy games; real prizes for top managers\n- **Panini NFTs / Topps NFT** — traditional card companies' blockchain entry\n- **Chiliz / Socios** — fan tokens (not NFTs) for club governance votes and rewards; PSG, FC Barcelona, Juventus tokens\n\n**Sports collectibles mechanics:**\n- Scarcity tiers: Common, Rare, Super Rare, Unique (1-of-1) — scarcity drives value\n- Utility: Top Shot moments are collectable only; Sorare cards have in-game utility\n- Licensed = real legal relationship between brand and platform\n\n**Market dynamics:**\n- NBA Top Shot peaked at $800M/month in sales (Feb 2021); corrected sharply; still runs with a stable user base\n- Sorare raised $532M Series B (2021); remains one of the most used NFT-adjacent apps with real sports engagement\n\n**Current state (2026):** Sports NFTs have contracted from 2021 peaks but sports card culture persists; secondary market volumes for Top Shot and Sorare remain in the millions monthly.`,

  nft_analytics: `**NFT Analytics and Valuation** — tools and frameworks for evaluating NFT collections and making informed decisions.\n\n**On-chain analytics tools:**\n- **NFTScan** — multi-chain NFT explorer; track wallets, collections, and transfers\n- **Nansen** — wallet labelling and NFT smart money tracking; see what "whale" wallets are buying\n- **Cielo Finance** — real-time NFT trade feed with wallet notifications\n- **Dune Analytics** — custom SQL dashboards for NFT market data; community-built boards for every major collection\n- **Reservoir** — developer API for NFT data, orders, and liquidity aggregation\n\n**Marketplace analytics:**\n- **NFTGo** — floor price, volume, holder concentration, and whale activity per collection\n- **Blur Analytics** — advanced bid depth charts, trait floor prices, collection liquidity depth\n- **Context.app** — social graph of NFT collectors; see what wallets you follow are collecting\n\n**Valuation frameworks:**\n- **Floor price** — cheapest available listing; the baseline market value but often manipulated\n- **Trait rarity** — a 1-of-1 background or rare trait commands a premium (check rarity.tools, trait-floor on Blur)\n- **Holder concentration** — a top-10 wallet holding 30%+ = centralisation risk (check NFTGo)\n- **Volume / liquidity** — thin volume = illiquid; you may not be able to exit at floor\n- **Bid depth** — how many active bids within 10% of floor? Shallow bid depth = high slippage on exit\n- **Wash trading detection** — same wallet buying and selling to itself; inflates volume metrics\n\n**Red flags:** Sudden volume spike with no news, top wallet flipping most of supply, royalty enforcement removed, team anonymity, no roadmap delivery.`,

  nft_creator_tools: `**NFT Creator Tools** — the infrastructure artists, musicians, and builders use to mint, distribute, and manage their NFT projects.\n\n**Smart contract frameworks:**\n- **OpenZeppelin Contracts Wizard** — generate audited ERC-721/1155 contracts in minutes; no Solidity experience needed\n- **Manifold** — most popular creator contract platform; Ethereum/Base; custom contracts, airdrop, burn mechanics, allowlists\n- **Zora Protocol** — open minting protocol; any creator deploys a Zora collection; fees go to creators\n- **ThirdWeb** — full-stack platform: smart contracts, gasless minting, marketplace widgets, Solana support\n- **Crossmint** — credit card NFT checkout; email-based wallets; used for mainstream audience onboarding\n\n**Metadata and storage:**\n- **IPFS (Pinata, NFT.storage)** — decentralised content-addressed storage; most common for NFT images\n- **Arweave** — permanent storage; pay once, stored forever; used for on-chain projects that want permanence\n- **On-chain SVG** — fully on-chain; image data stored in smart contract bytecode; survives any server shutdown (Nouns, Loot)\n\n**Minting mechanics:**\n- **Dutch auction** — price starts high, decreases over time until all tokens sell; used by Art Blocks, Yuga Labs\n- **Fixed price + allowlist (whitelist)** — set price; early supporters get guaranteed access at mint price\n- **Free mint + royalties** — zero cost to mint; creator captures value via secondary royalties (DigiDaigaku model)\n- **Bonding curve mint** — price increases with each mint; early minters get the best price\n\n**Royalty enforcement:**\n- ERC-2981 on-chain royalty standard: embedded in contract; marketplaces can choose to honour or bypass\n- OpenSea and Blur reduced royalty enforcement in 2022–2023; ongoing controversy\n- Zora and manifold contracts include blocking non-enforcing marketplaces as an option`,

  nft_market_history: `**NFT Market History** — from CryptoKitties congestion to the 2021 mania and the 2022–2026 restructuring.\n\n**2017 — The beginning:**\n- CryptoPunks (Larva Labs) — 10,000 pixel characters; given away free; became the blueprint for PFP NFTs; sold for $7,500 average in 2021\n- CryptoKitties — first viral NFT game; congested Ethereum at peak; proved digital scarcity had value\n\n**2020 — DeFi summer overlap:**\n- Rarible and OpenSea launch; NFT infrastructure matures quietly\n- NBA Top Shot launches on Flow (October 2020) and grows explosively into 2021\n\n**Q1 2021 — Explosion:**\n- Beeple's "Everydays: The First 5000 Days" sells for $69M at Christie's (March 2021)\n- NBA Top Shot hits $800M monthly volume (February 2021)\n- OpenSea monthly volume hits $100M for the first time\n\n**Q2–Q3 2021 — PFP summer:**\n- BAYC (Bored Ape Yacht Club) launches at 0.08 ETH (April 2021); floor reaches 150+ ETH by end of year\n- CryptoPunks floor hits 100 ETH+; single Punk sells for $7.5M\n- Art Blocks explodes; Squiggles, Fidenzas become blue chips\n\n**Q4 2021 — Peak mania:**\n- OpenSea hits $3.4B monthly volume (August 2021)\n- Metaverse NFTs: Sandbox, Decentraland land sales surge on Meta rebrand\n- Project launches: Azuki, Doodles, Moonbirds all raise millions\n\n**2022 — Bear market:**\n- LUNA collapse (May 2022) drains liquidity; NFT volumes crash 95%+\n- OpenSea to Blur shift begins; Blur launches October 2022\n- Wash trading revealed to be widespread; market confidence damaged\n\n**2023 — Blur dominance + Ordinals:**\n- Blur captures 50%+ of Ethereum NFT volume; royalties effectively eliminated\n- Bitcoin Ordinals launch (January 2023); new narrative drives excitement\n- Base launches (August 2023); new chain = new NFT culture begins\n\n**2024–2026 — Maturation:**\n- Market splits into blue chips (CryptoPunks, BAYC), utility NFTs, RWA NFTs, and meme NFTs\n- Zora's open minting model gains traction with creators\n- Fully onchain games (Dark Forest, Primodium) emerge as a credible subculture\n- NFT volume stabilises at $200–500M/month; down from 2021 peak but sustainable`,

  nft_evm_ecosystems: `**NFT on EVM Chains Beyond Ethereum** — Base, Arbitrum, and Polygon have distinct NFT cultures.\n\n**Base:**\n- The fastest growing NFT chain in 2023–2026\n- **Zora on Base** — most active open minting activity; artists deploy and collect freely\n- **Clanker-minted culture NFTs** — AI-generated tokens and NFTs launched via Farcaster\n- **Onchain Summer (2023)** — Coinbase campaign onboarding artists to Base; ~1.5M NFTs minted in one month\n- **OnchainKit** — Coinbase's toolkit for building NFT UIs on Base\n\n**Arbitrum:**\n- Home to **Treasure** — gaming NFT ecosystem; Bridgeworld, Magic token, gaming guild\n- **Smol Brains / Smolverse** — native Arbitrum PFP and gaming collection\n- NFT activity driven by GameFi rather than art\n\n**Polygon:**\n- Partnered with Reddit (Reddit Collectible Avatars — 10M+ wallets created), Starbucks Odyssey, DraftKings\n- Low-cost minting made Polygon the enterprise NFT chain of choice 2021–2023\n- Volume has migrated to Base/Solana but brand partnerships remain active\n\n**Optimism:**\n- Smaller NFT scene; **Mirror.xyz** writing NFTs are popular with writers and journalists\n- OP-native culture focuses on public goods and retroactive grants\n\n**zkSync / StarkNet:**\n- Emerging NFT ecosystems; ultra-low cost minting; early-stage communities\n- imX (Immutable X) — ZK rollup purpose-built for NFT gaming; Gods Unchained, Illuvium, Guild of Guardians`,

  nft_tax_legal: `**NFT Taxes and Legal Considerations** — often overlooked but critically important for collectors and creators.\n\n**Tax treatment (varies by jurisdiction):**\n\n**United States (IRS guidance):**\n- NFT purchase: no taxable event\n- NFT sale: capital gain/loss = sale price minus cost basis (purchase price + gas fees)\n- Short-term (held under 1 year) = taxed as ordinary income (up to 37%)\n- Long-term (held over 1 year) = taxed at capital gains rate (0%, 15%, or 20%)\n- NFT-for-NFT swap: taxable disposal — both NFTs marked to market at the time of swap\n- Royalty income received by creators = ordinary income, not capital gains\n- "Collectible" classification: IRS may tax certain NFTs at 28% long-term rate (higher than standard 20%)\n\n**UK (HMRC):**\n- NFT disposals subject to Capital Gains Tax\n- Creator income = Income Tax\n- HMRC has issued guidance specifically naming NFTs as chargeable assets\n\n**EU:**\n- MiCA does not directly regulate NFTs (per the "unique" exemption) but national tax authorities apply CGT\n- Germany: crypto/NFTs held over 1 year may be tax-free (currently under review)\n\n**Record keeping essentials:**\n- Every buy, sell, mint, and airdrop must be tracked with date, amount, gas fees, and fair market value in fiat\n- Tools: Koinly, TaxBit, TokenTax, CoinTracker — all support NFT transactions\n\n**Legal considerations:**\n- Owning an NFT does NOT grant copyright of the underlying artwork (unless explicitly stated in the contract)\n- IP rights: Yuga Labs (BAYC) grants commercial rights; most other projects do not\n- Smart contract bugs: no legal recourse in most jurisdictions if a smart contract loses your funds\n- Wash trading: intentional wash trading to inflate volume may constitute market manipulation`,

  nft_defi: `**NFT-Fi** is the intersection of NFTs and DeFi, enabling NFTs to participate in financial protocols.\n\n**NFT lending & borrowing:**\n- **Blur Blend** — peer-to-peer NFT lending; borrow ETH against your NFT, lender earns interest; liquidation if you can't repay\n- **NFTfi** — pioneered NFT-collateralised loans; fixed-term peer-to-peer\n- **Arcade** — enterprise-grade NFT lending\n- **BendDAO** — pool-based NFT lending (higher liquidation risk)\n\n**NFT Liquidity:**\n- **Sudoswap (LSSVM)** — AMM for NFTs; pool-based constant product pricing\n- **Caviar** — NFT-to-ERC20 AMM pools\n- **Fractional / Tessera** — split an NFT into ERC-20 shares for collective ownership\n\n**Royalty DeFi:**\n- Music NFTs on Sound.xyz and Catalog let holders earn streaming royalty fractions\n\n**Risks:** NFT prices are illiquid and volatile; liquidation can happen quickly; smart contract bugs in lending protocols have caused losses.`,

  // ── Meme coin deep dives ─────────────────────────────────────────────────
  meme_tokenomics: `**Meme coin tokenomics** are deliberately simple — there is usually no vesting, no utility, and supply is either fixed or burned.\n\n**Common structures:**\n- **Fixed supply** — e.g. 1 quadrillion SHIB, 21 trillion BONK\n- **Burn mechanics** — SHIB has a burn portal; reducing supply is used as a narrative catalyst\n- **Tax tokens** — early BSC meme coins charged buy/sell taxes (e.g. 5% on every trade) split between marketing wallets and burns; now largely out of fashion\n- **Fair launch** — no team allocation, no VCs; all tokens available from day one via bonding curve or liquidity pool\n- **Dev wallet** — a portion held by the team; watching dev wallet movements on-chain is standard practice to spot potential rug pulls\n\n**Supply distribution red flags:**\n- Single wallet holding >5% of supply\n- Locked liquidity that expires soon\n- Large unlabelled wallets bought in the same block as deployment\n\n**Tools:** DEXScreener, Bubblemaps (visualise wallet clustering), Birdeye (Solana)`,

  meme_trading: `**Trading meme coins** involves fast execution, on-chain analysis, and high risk tolerance. Most participants lose money.\n\n**Key tools:**\n- **DEXScreener** — real-time price charts, volume, and holder distribution for any token on any chain\n- **Birdeye** — Solana-focused token analytics\n- **Bubblemaps** — visualise holder clustering to spot insider accumulation\n- **Photon / BullX** — fast Solana trading bots with sniper mode\n- **Maestro / Banana Gun** — Ethereum/EVM trading bots\n\n**Trading concepts:**\n- **Entry timing** — the earlier, the riskier and higher-reward. First-block snipers risk getting rugged immediately\n- **Market cap stages** — sub-$100K (ultra-risky), $100K–$1M (speculative), $1M+ (more liquid)\n- **Exit strategy** — take profits in tranches; never wait for the "perfect" top\n- **Liquidity** — low liquidity means large slippage; a $10K sell in a thin pool can crash price 50%\n\n**Tax note:** Every meme coin trade is a taxable event in most jurisdictions. Keep records.`,

  meme_notable: `**Notable meme coins and their stories** show the extreme range of outcomes in the sector.\n\n**Mega successes (from the top):**\n- **DOGE** — 2013 joke coin that reached $88B market cap in May 2021; Elon Musk tweets moved price by 50%+\n- **SHIB** — launched 2020 anonymously; Vitalik was gifted 50% of supply and donated/burned it, briefly making SHIB a story of charity\n- **WIF (dogwifhat)** — hat on a dog photo; grew from $0 to ~$5B market cap in 2024\n- **PEPE** — Pepe the Frog; launched April 2023, reached $1B cap in 2 weeks — one of the fastest ever\n\n**Notable failures:**\n- **SQUID** — fake Squid Game token; rug pulled in minutes taking millions\n- **LUNA** — not a meme coin but collapsed algorithmically in May 2022, wiping $40B\n- **Countless pump.fun tokens** — the majority of 100,000+ tokens launched on pump.fun have gone to zero\n\n**Political meme coins:**\n- **TRUMP / MELANIA** — launched by political figures before the 2025 inauguration; billions in volume, then rapid decline`,

  // ── Meme coin deep-dive topics ───────────────────────────────────────────
  meme_solana: `**Solana meme coin ecosystem** is the most active meme coin chain by launch volume, trading speed, and retail participation.\n\n**Why Solana dominates meme launches:**\n- Sub-$0.01 transaction fees — viable to buy $50 of a meme coin without gas eating the position\n- ~400ms finality — price reacts faster; snipers operate in milliseconds\n- pump.fun — the defining meme launchpad processed $2B+ in volume in 2024\n- Tight-knit CT community centred around Solana degens\n\n**The pump.fun machine:**\n- Any wallet can launch a token for ~0.02 SOL\n- Bonding curve: token starts at $0, price increases with each buy, graduates at ~$69K market cap\n- At graduation, liquidity migrates to Raydium; LP tokens are burned\n- Peak days: 50,000+ new tokens launched in 24 hours\n- Most tokens (95%+) never graduate\n\n**Notable Solana meme ecosystems:**\n- **Dogwifhat (WIF)** — the first Solana meme to reach multi-billion market cap; #1 Solana meme\n- **BONK** — airdropped to Solana NFT holders in December 2022; revived Solana's bear market community\n- **POPCAT** — cat popping a balloon; simple image became $1B+ asset\n- **MEW (cat in a dogs world)** — capitalised on anti-dog narrative\n- **BOME (Book of Meme)** — launched via presale raising $10M in days\n\n**Solana meme infrastructure:**\n- Photon, BullX, Trojan — fast trading bots with built-in sniper modes\n- Rugcheck.xyz — Solana-specific rug detection\n- Birdeye — Solana token analytics and new pair alerts`,

  meme_evm: `**EVM meme coin ecosystem** spans Ethereum, Base, and BNB Chain — each with its own culture and dominant coins.\n\n**Ethereum:**\n- Home of PEPE, MOG, BRETT (originally), and most "blue chip" meme coins\n- High gas fees ($5–50+ per trade) price out small wallets — Ethereum memes tend to attract larger capital\n- PEPE — launched April 2023; reached $1B market cap in 2 weeks; one of the fastest ever\n- MOG — the "culture coin"; strong artist/CT community identity\n- Uniswap v2/v3 are the primary trading venues\n\n**Base:**\n- Coinbase L2 — low fees, easy onramp from Coinbase wallet\n- **Toshi** — homage to Satoshi; Base's first community meme coin\n- **BRETT** — blue boy from Matt Furie's Boys Club comic (same creator as Pepe); migrated Base community\n- **Degen** — tipped by Farcaster users; grew from social token to meme coin\n- **Clanker** — AI-integrated launcher on Base; tokens created by mentioning @clanker on Farcaster\n- Base culture: builder-friendly, Coinbase nexus, lower degeneracy ceiling than Solana\n\n**BNB Chain:**\n- Four.meme is the dominant launchpad\n- FLOKI — Elon Musk named his dog Floki; community built ecosystem around the dog\n- Baby Doge — DOGE derivative with burn mechanics\n- BNB memes often copy Solana trends 1–2 weeks later ("meta rotation")\n\n**Cross-chain meme bridges:**\n- Major memes bridge to multiple chains via LayerZero OFT or CCTP\n- PEPE, WIF, BONK all have multi-chain versions\n- Bridged versions sometimes trade at a premium/discount vs the canonical chain`,

  meme_cycles: `**Meme coin market cycles** follow predictable seasonal patterns tied to broader crypto market conditions.\n\n**The cycle structure:**\n1. **Bitcoin breaks all-time high** — risk appetite surges; ETH follows\n2. **Alt season** — large caps rally; attention spreads\n3. **Meme season** — speculative capital floods into the highest-risk assets; new meme coins launch daily\n4. **Narrative rotation** — themes cycle: dog coins, cat coins, AI coins, political coins, pop-culture coins\n5. **Market peak** — volume and prices peak; experienced traders exit\n6. **Bear market** — 80–95% of meme coins go to zero; only a handful survive\n\n**Key cycle metrics to watch:**\n- Bitcoin dominance falling = alt/meme capital rotation beginning\n- Fear and Greed Index above 80 = peak greed; meme mania\n- pump.fun daily new token launches hitting ATH = late cycle signal\n- Social volume (LunarCrush, Santiment) spike on low-cap meme = narrative forming\n\n**Narrative rotation examples (2024–2025):**\n- AI meme coins (GOAT, AIXBT, ai16z) — Q4 2024\n- Political meme coins (TRUMP, MELANIA) — January 2025\n- Dog with hat (WIF successors) — mid 2024\n- Solana cat coins (MEW, POPCAT) — 2024\n\n**Survival across cycles:**\n- Only coins with genuine community survive bear markets (DOGE, SHIB, PEPE)\n- Utility additions (ShibaSwap, SHIB L2 Shibarium) attempt to build staying power\n- Most 2021 memes were worth near-zero by 2023`,

  meme_kol: `**KOL (Key Opinion Leader) economy** is the engine of meme coin price discovery — and manipulation.\n\n**What KOLs do:**\n- Build an audience of crypto retail traders on X (Twitter), YouTube, or TikTok\n- Receive payments (often in tokens) to post about new meme coins\n- A single tweet from a top KOL can 5–20x a low-cap meme coin within minutes\n\n**The KOL deal structure:**\n- "Shill deal" — paid in tokens at a discount; KOL pumps, then sells into retail buying\n- "Revenue share" — KOL receives % of fees from affiliated trading bots\n- "Presale allocation" — KOL gets tokens before launch at zero cost\n- "Bundled launch" — KOL coordinates with dev to buy early, then announce simultaneously\n\n**Famous KOL categories:**\n- **Macro-KOLs** — 500K+ followers; move markets; Ansem, Murad, Ilan Solot\n- **Mid-tier KOLs** — 50K–500K; niche influence; often more transparent about sponsorships\n- **Micro-KOLs** — 5K–50K; mostly retail audience; often less disclosed paid promotions\n\n**How to filter KOL signal:**\n- Check if the KOL holds the token via on-chain analysis (Arkham, Nansen)\n- Look for disclosure of sponsored content\n- Track KOL wallet buy/sell timing relative to posts\n- Cross-check: multiple independent KOLs posting organically vs one high-follower paid post\n\n**Murad thesis (2024):** Influential KOL Murad Mahmudov argued that only meme coins with genuine cult-like communities will survive long term — "memecoins are the ultimate social consensus asset."`,

  meme_onchain_analysis: `**Onchain analysis for meme coins** is essential due diligence before buying any new token.\n\n**Wallet concentration analysis:**\n- Use Bubblemaps to visualise holder clusters — connected wallets sharing the same deployer suggest coordinated insider accumulation\n- Top 10 holders holding >30% is a risk signal; >50% is extremely dangerous\n- Check if top holders are exchanges/CEX wallets (benign) or unlabelled wallets (suspicious)\n\n**Deployer wallet investigation:**\n- Check the contract deployer's history on Etherscan/Solscan\n- Serial deployers with multiple rug pulls are a clear red flag\n- Verify the contract is renounced (ownership given up) — non-renounced contracts can be modified or rugged\n\n**Liquidity analysis:**\n- LP tokens should be burned (sent to dead address) or locked via Team.Finance, Unicrypt, or Mudra\n- Check lock expiry date — a 30-day lock expiring soon is a timed rug risk\n- LP depth: how much USDC/SOL is in the pool? Low LP = high price impact on sells\n\n**Transaction pattern analysis:**\n- Even buy/sell intervals suggest bot activity, not organic interest\n- Large coordinated buys from multiple wallets in the same block = bundled launch\n- Honeypot check: try to simulate a sell on honeypot.is (EVM) or rugcheck.xyz (Solana)\n\n**Tools by chain:**\n- **EVM:** Etherscan, Bubblemaps, DEXTools, DEXScreener, honeypot.is, tokensniffer.com\n- **Solana:** Solscan, Birdeye, Rugcheck.xyz, Bubblemaps Solana, Photon analytics`,

  meme_defi: `**Meme coins and DeFi** — how speculative assets interact with decentralised financial infrastructure.\n\n**Meme coin liquidity pools:**\n- All meme coins trade in AMM pools (Uniswap, Raydium, PancakeSwap)\n- LP providers for meme coins face extreme impermanent loss risk — as the meme moons or crashes, LP value diverges sharply\n- High trading fees (0.3–1%) partially compensate LPs during high-volume periods\n\n**Meme coins as collateral (experimental):**\n- Some lending protocols accept top meme coins as collateral at very low LTV (10–20%)\n- Risks: sudden price drops can cause mass liquidations; liquidators must buy an illiquid asset\n- DOGE, SHIB, and PEPE have had some DeFi protocol integrations\n\n**Meme coin staking:**\n- SHIB staking via ShibaSwap to earn BONE and LEASH tokens\n- FLOKI staking for yield and fee discounts on FlokiFi\n- Most meme staking yields are paid in the meme token itself — creating reflexive inflation\n\n**Meme DEX ecosystems:**\n- ShibaSwap (Ethereum) — SHIB native DEX; BONE governance token\n- Shibarium — SHIB L2 on Ethereum; processes SHIB ecosystem transactions at lower cost\n- FlokiFi — FLOKI's DeFi suite: staking, vaults, lending\n- Dogecoin: has no native DeFi but wrapped versions exist on Ethereum/BNB\n\n**Yield farming with memes:**\n- Meme-ETH LP pairs earn fees + sometimes additional meme token rewards\n- Typical yields are unsustainable (100–1000% APY in meme tokens worth very little)\n- Only viable if you believe in the underlying meme coin appreciating`,

  meme_regulation: `**Meme coin regulation** is an evolving and unclear area across major jurisdictions.\n\n**The core regulatory question:**\nAre meme coins securities, commodities, or something else entirely? No major regulator has issued definitive guidance specifically for meme coins.\n\n**United States:**\n- SEC has focused on larger tokens (ETH, XRP, SOL); meme coins have largely escaped enforcement\n- SEC unofficial view: meme coins without utility or promises of profit are less likely to be securities under the Howey test\n- CFTC: DOGE and other meme coins have been referenced as commodities in some filings\n- FIT21 (passed 2024): creates clearer commodity vs security distinction; most meme coins would fall under CFTC jurisdiction\n- KOL payments for promotions: SEC has pursued celebrity promoters (Kim Kardashian, Floyd Mayweather) for undisclosed crypto promotions\n\n**European Union:**\n- MiCA (Markets in Crypto-Assets) — in force 2024: applies to asset-referenced tokens and e-money tokens; pure meme coins may be exempt as "utility tokens" but issuers face whitepaper disclosure requirements\n\n**United Kingdom:**\n- FCA: crypto promotions must be fair, clear, and not misleading; KOL shill posts require disclosure\n- Crypto marketing rules in force since 2023; influencers promoting memes without disclosure face fines\n\n**Practical risk for traders:**\n- Tax: meme coin trades are taxable capital gains events in US, UK, EU, Australia\n- Anti-money laundering: large meme coin gains may trigger SAR (Suspicious Activity Reports) from exchanges\n- Most retail meme traders are not directly targeted by regulators — the risk is to issuers and promoters`,

  meme_safety: `**Meme coin safety** requires treating every interaction as potentially adversarial.\n\n**Before buying:**\n- Check contract on DEXScreener — is liquidity locked? For how long?\n- Check top holders via Bubblemaps — any single wallet with >5%?\n- Check if the contract has mint functions (can team print unlimited supply)\n- Verify the LP burn/lock — unburned LP means the team can drain liquidity at any time\n- Search the token on Twitter/X — is it trending organically or via paid KOL spam?\n\n**During the trade:**\n- Use a dedicated "degen wallet" — never use your main wallet for meme coin apes\n- Set slippage carefully — too low: transaction fails; too high: front-run by MEV bots\n- Know your exit before you enter\n\n**Red flags (likely rug or scam):**\n- Honeypot — you can buy but not sell (detectable via honeypot.is or DEXScreener flags)\n- Tax >10% — often used to slowly drain liquidity\n- Anonymous team + no community + KOL-only hype\n- "Safe" or "guaranteed" in marketing\n\n**Tools:** honeypot.is, tokensniffer.com, rugcheck.xyz (Solana)`,
}

// ── Topic categories ───────────────────────────────────────────────────────
const TOPIC_CATEGORIES = [
  {
    label: 'Fundamentals',
    icon: Hash,
    topics: [
      'blockchain', 'bitcoin', 'ethereum', 'mining', 'halving',
      'fund_consensus', 'fund_cryptography', 'fund_wallets_keys',
      'fund_transactions', 'fund_smart_contracts_deep', 'fund_token_standards',
      'fund_scaling', 'fund_network_security', 'fund_web3', 'fund_crypto_history',
    ],
  },
  {
    label: 'DeFi & Finance',
    icon: DollarSign,
    topics: [
      'defi', 'defi_overview_deep', 'defi_liquidity', 'defi_yield_strategies',
      'defi_money_markets', 'defi_lending', 'defi_liquid_staking',
      'defi_protocols_by_chain', 'defi_hacks', 'defi_pendle_yield',
      'defi_rwa', 'defi_portfolio', 'defi_bridges_deep',
      'yield', 'staking', 'flashloan', 'impermanent_loss', 'oracle',
    ],
  },
  {
    label: 'DEX',
    icon: Coins,
    topics: ['dex_overview', 'dex_amm', 'dex_uniswap', 'dex_curve_balancer', 'dex_solana', 'dex_aggregators', 'dex_liquidity_mining', 'dex_mev', 'dex_onchain_orderbooks', 'dex_perps'],
  },
  {
    label: 'CEX',
    icon: Globe,
    topics: ['cex_overview', 'cex_platforms', 'cex_security_hacks', 'cex_trading_features', 'cex_fiat_onramps', 'cex_regulation', 'cex_exchange_tokens', 'cex_derivatives', 'cex_institutional', 'cex_vs_dex'],
  },
  {
    label: 'RWA',
    icon: TrendingUp,
    topics: ['rwa_overview', 'rwa_bonds', 'rwa_stocks', 'rwa_equities_protocols', 'rwa_real_estate', 'rwa_commodities', 'rwa_private_credit', 'rwa_defi_collateral', 'rwa_infrastructure', 'rwa_luxury_ip', 'rwa_emerging_markets', 'rwa_institutional_onboarding', 'rwa_regulation', 'rwa_market_overview', 'rwa_future', 'nft_rwa', 'defi_rwa'],
  },
  {
    label: 'NFTs',
    icon: Zap,
    topics: ['nft', 'nft_overview', 'nft_market_history', 'nft_art', 'nft_gaming', 'nft_music', 'nft_sports', 'nft_rwa', 'nft_marketplaces', 'nft_bitcoin_ordinals', 'nft_utility', 'nft_lifecycle', 'nft_solana_ecosystem', 'nft_evm_ecosystems', 'nft_defi', 'nft_analytics', 'nft_creator_tools', 'nft_tax_legal'],
  },
  {
    label: 'GameFi',
    icon: TrendingUp,
    topics: ['gamefi_overview', 'gamefi_models', 'gamefi_economy', 'gamefi_platforms', 'gamefi_ronin', 'gamefi_treasure', 'gamefi_solana_gaming', 'gamefi_mobile', 'gamefi_projects', 'gamefi_guilds', 'gamefi_web2_studios', 'gamefi_investing', 'gamefi_safety', 'gamefi_future'],
  },
  {
    label: 'Meme Coins',
    icon: TrendingUp,
    topics: ['memecoins', 'meme_notable', 'meme_solana', 'meme_evm', 'meme_cycles', 'meme_kol', 'meme_onchain_analysis', 'meme_defi', 'meme_regulation', 'meme_launchpads', 'meme_culture', 'meme_tokenomics', 'meme_trading', 'meme_safety'],
  },
  {
    label: 'Tokens & Standards',
    icon: Coins,
    topics: ['usdc', 'erc20', 'std_erc20_deep', 'std_nft_standards', 'std_account_abstraction', 'std_vault_tokens', 'std_solana_tokens', 'std_governance_tokens', 'std_utility_tokens', 'std_wrapped_tokens', 'std_token_launches', 'fund_token_standards', 'cbdc'],
  },
  {
    label: 'Infrastructure',
    icon: Layers,
    topics: ['layer1', 'infra_evm_deep', 'infra_ethereum_deep', 'infra_bitcoin_network', 'layer2', 'infra_zk_tech', 'infra_appchains', 'infra_data_availability', 'infra_node_rpc', 'infra_cross_chain_messaging', 'infra_chainlink_pyth', 'infra_private_compute', 'oracle', 'cctp', 'gas', 'arc', 'solana'],
  },
  {
    label: 'Security & Wallets',
    icon: Lock,
    topics: ['wallet', 'metamask', 'seed', 'smart_contract'],
  },
  {
    label: 'Governance',
    icon: Globe,
    topics: ['dao', 'gov_dao_mechanics', 'gov_voting_systems', 'gov_tooling', 'gov_major_daos', 'gov_attacks', 'gov_legal', 'gov_contributor_model', 'gov_case_studies'],
  },
  {
    label: 'Stablecoins',
    icon: DollarSign,
    topics: ['stablecoins', 'stable_usdc_deep', 'usdc', 'stable_usdt', 'stable_dai_sky', 'stable_algo', 'stable_frax_ethena', 'stable_pyusd_others', 'stable_yield', 'stable_yield_strategies', 'stable_regulation', 'stable_payments', 'stable_enterprise', 'stable_multichain', 'stable_risks', 'stable_depegs', 'stable_cbdc_comparison', 'cbdc'],
  },
  {
    label: 'Bridges & L0',
    icon: Layers,
    topics: ['bridges', 'bridge_cctp_deep', 'cctp', 'bridge_layerzero_deep', 'bridge_wormhole_deep', 'bridge_ibc_cosmos', 'bridge_polkadot', 'bridge_intent', 'bridge_hacks', 'bridge_chain_abstraction', 'layer0', 'infra_cross_chain_messaging'],
  },
  {
    label: 'Security',
    icon: Shield,
    topics: ['crypto_security', 'sec_hardware_wallets', 'sec_seed_keys', 'seed', 'sec_defi_security', 'sec_attack_patterns', 'sec_opsec', 'sec_wallet_recovery', 'sec_phishing', 'sec_onchain_forensics', 'wallet_advanced'],
  },
  {
    label: 'Ecosystems',
    icon: Globe,
    topics: ['evm_ecosystem', 'layer1', 'layer2', 'solana', 'arc'],
  },
  {
    label: 'Markets & Trading',
    icon: TrendingUp,
    topics: ['tokenomics', 'crypto_derivatives', 'defi_lending', 'mkt_onchain_analysis', 'mkt_technical_analysis', 'mkt_cycles_macro', 'mkt_futures_deep', 'mkt_options_deep', 'mkt_market_making', 'mkt_funding_basis', 'mkt_onchain_data_tools', 'mkt_portfolio_management'],
  },
  {
    label: 'Industry & AI',
    icon: Zap,
    topics: ['regulation', 'ind_us_regulation', 'ind_global_regulation', 'ind_crypto_taxes', 'ind_institutional', 'ai_crypto', 'ind_ai_agents', 'ind_decentral_ai', 'ind_verifiable_ai', 'ind_ai_tokens', 'privacy_crypto', 'ind_privacy_deep', 'priv_zk_identity', 'priv_monero_deep', 'priv_tornado_legal', 'priv_railgun_aztec', 'priv_confidential_compute', 'priv_ux_tools', 'priv_future'],
  },
]

const TOPIC_LABELS: Record<string, string> = {
  blockchain: 'Blockchain', bitcoin: 'Bitcoin', ethereum: 'Ethereum',
  mining: 'Mining', halving: 'Bitcoin Halving', defi: 'DeFi',
  yield: 'Yield Farming', staking: 'Staking', flashloan: 'Flash Loans',
  impermanent_loss: 'Impermanent Loss', usdc: 'USDC', erc20: 'ERC-20',
  dex_overview: 'DEX Overview', dex_amm: 'How AMMs Work', dex_uniswap: 'Uniswap Deep Dive',
  dex_curve_balancer: 'Curve & Balancer', dex_solana: 'Solana DEXs', dex_aggregators: 'DEX Aggregators',
  dex_liquidity_mining: 'Liquidity Mining', dex_mev: 'MEV Explained', dex_onchain_orderbooks: 'Onchain Order Books',
  dex_perps: 'Perpetual DEXs',
  cex_overview: 'CEX Overview', cex_platforms: 'Major CEX Platforms',
  cex_security_hacks: 'CEX Security & Hacks', cex_trading_features: 'Trading Features',
  cex_fiat_onramps: 'Fiat On/Off Ramps', cex_regulation: 'CEX Regulation',
  cex_exchange_tokens: 'Exchange Tokens', cex_derivatives: 'CEX Derivatives',
  cex_institutional: 'Institutional Services', cex_vs_dex: 'CEX vs DEX Comparison',
  nft: 'NFTs Intro', nft_overview: 'NFT Sector Overview', nft_market_history: 'NFT Market History',
  nft_art: 'Digital Art & Collections', nft_music: 'Music NFTs', nft_sports: 'Sports Collectibles',
  nft_analytics: 'NFT Analytics & Valuation', nft_creator_tools: 'Creator Tools',
  nft_evm_ecosystems: 'NFT on EVM Chains', nft_tax_legal: 'NFT Taxes & Legal',
  fund_consensus: 'Consensus Mechanisms', fund_cryptography: 'Cryptography Basics',
  fund_wallets_keys: 'Wallets, Keys & Addresses', fund_transactions: 'How Transactions Work',
  fund_smart_contracts_deep: 'Smart Contracts Deep Dive', fund_token_standards: 'Token Standards Overview',
  std_erc20_deep: 'ERC-20 Deep Dive', std_nft_standards: 'ERC-721 & ERC-1155',
  std_account_abstraction: 'Account Abstraction (ERC-4337)', std_vault_tokens: 'ERC-4626 Vault Tokens',
  std_solana_tokens: 'Solana Token Standards', std_governance_tokens: 'Governance Tokens',
  std_utility_tokens: 'Utility Tokens', std_wrapped_tokens: 'Wrapped Tokens',
  std_token_launches: 'Token Launch Mechanisms',
  infra_ethereum_deep: 'Ethereum Deep Dive', infra_bitcoin_network: 'Bitcoin Network',
  infra_zk_tech: 'ZK Technology', infra_appchains: 'Appchains',
  infra_data_availability: 'Data Availability', infra_node_rpc: 'Nodes, RPC & Indexers',
  infra_cross_chain_messaging: 'Cross-Chain Messaging', infra_chainlink_pyth: 'Chainlink & Pyth',
  infra_evm_deep: 'EVM Ecosystem 2026', infra_private_compute: 'Privacy & Confidential Compute',
  fund_scaling: 'Blockchain Scaling', fund_network_security: 'Network Security',
  fund_web3: 'Web3 vs Web2', fund_crypto_history: 'Crypto History',
  rwa_overview: 'RWA Overview', rwa_bonds: 'Tokenised Bonds & Fixed Income',
  rwa_stocks: 'Tokenised Stocks & Equities', rwa_equities_protocols: 'RWA Equity Protocols',
  rwa_real_estate: 'Tokenised Real Estate', rwa_commodities: 'Tokenised Commodities',
  rwa_private_credit: 'Tokenised Private Credit', rwa_defi_collateral: 'RWA as DeFi Collateral',
  rwa_infrastructure: 'RWA Infrastructure', rwa_luxury_ip: 'Luxury Goods, Art & IP',
  rwa_emerging_markets: 'RWA in Emerging Markets', rwa_institutional_onboarding: 'Institutional Onboarding',
  rwa_regulation: 'RWA Regulation', rwa_market_overview: 'RWA Market 2026', rwa_future: 'Future of RWA',
  nft_gaming: 'NFT Gaming (GameFi)', nft_rwa: 'Real-World Assets (RWA)',
  gamefi_overview: 'GameFi Overview', gamefi_models: 'GameFi Business Models',
  gamefi_economy: 'GameFi Token Economies', gamefi_platforms: 'GameFi Platforms & Chains',
  gamefi_ronin: 'Ronin Deep Dive', gamefi_treasure: 'Treasure DAO & Arbitrum',
  gamefi_solana_gaming: 'Solana Gaming', gamefi_mobile: 'Mobile GameFi',
  gamefi_projects: 'Notable GameFi Projects', gamefi_guilds: 'Gaming Guilds',
  gamefi_web2_studios: 'Web2 Studios in Web3', gamefi_investing: 'GameFi Investing',
  gamefi_safety: 'GameFi Safety & Scams', gamefi_future: 'Future of GameFi',
  nft_marketplaces: 'NFT Marketplaces', nft_bitcoin_ordinals: 'Bitcoin Ordinals',
  nft_utility: 'Utility NFTs', nft_lifecycle: 'NFT Lifecycle', nft_solana_ecosystem: 'Solana NFT Ecosystem',
  nft_defi: 'NFT-Fi (DeFi x NFTs)',
  memecoins: 'Meme Coins Overview', meme_launchpads: 'Meme Launchpads', meme_culture: 'Meme Coin Culture',
  meme_tokenomics: 'Meme Tokenomics', meme_trading: 'Meme Trading Tools', meme_notable: 'Notable Meme Coins',
  meme_safety: 'Meme Coin Safety', meme_solana: 'Solana Meme Ecosystem',
  meme_evm: 'EVM Meme Ecosystem', meme_cycles: 'Meme Coin Cycles',
  meme_kol: 'KOL Economy', meme_onchain_analysis: 'Onchain Meme Analysis',
  meme_defi: 'Meme Coins & DeFi', meme_regulation: 'Meme Coin Regulation',
  stablecoins: 'Stablecoins Overview',
  stable_usdc_deep: 'USDC Deep Dive', stable_usdt: 'USDT (Tether)',
  stable_dai_sky: 'DAI / USDS (Sky)', stable_algo: 'Algorithmic Stablecoins',
  stable_yield: 'Yield-Bearing Stablecoins', stable_regulation: 'Stablecoin Regulation',
  stable_payments: 'Stablecoins as Payments', stable_depegs: 'Historical De-Pegs',
  stable_frax_ethena: 'Frax & Ethena (USDe)', stable_pyusd_others: 'PYUSD & Emerging Stablecoins',
  stable_multichain: 'Multi-Chain Landscape', stable_yield_strategies: 'Stablecoin Yield Strategies',
  stable_enterprise: 'Enterprise & B2B Adoption', stable_risks: 'Stablecoin Risk Management',
  stable_cbdc_comparison: 'Stablecoins vs CBDCs',
  bridges: 'Crypto Bridges', bridge_cctp_deep: 'CCTP Deep Dive', bridge_layerzero_deep: 'LayerZero Deep Dive',
  bridge_wormhole_deep: 'Wormhole & NTT', bridge_ibc_cosmos: 'IBC & Cosmos', bridge_polkadot: 'Polkadot & Parachains',
  bridge_intent: 'Intent-Based Bridging', bridge_hacks: 'Bridge Hacks & Security', bridge_chain_abstraction: 'Chain Abstraction',
  crypto_security: 'Crypto Security',
  gov_dao_mechanics: 'DAO Mechanics', gov_voting_systems: 'Voting Systems',
  gov_tooling: 'DAO Tooling', gov_major_daos: 'Major DAOs',
  gov_attacks: 'Governance Attacks', gov_legal: 'DAO Legal Structures',
  gov_contributor_model: 'Contributor Models', gov_case_studies: 'Governance Case Studies',
  sec_hardware_wallets: 'Hardware Wallets', sec_seed_keys: 'Seed Phrases & Keys',
  sec_defi_security: 'DeFi Security', sec_attack_patterns: 'Smart Contract Attacks',
  sec_opsec: 'Crypto OPSEC', sec_wallet_recovery: 'Wallet Recovery',
  sec_phishing: 'Phishing & Social Engineering', sec_onchain_forensics: 'Onchain Forensics',
  mkt_onchain_analysis: 'On-Chain Market Analysis', mkt_technical_analysis: 'Technical Analysis',
  mkt_cycles_macro: 'Market Cycles & Macro', mkt_futures_deep: 'Crypto Futures Deep Dive',
  mkt_options_deep: 'Crypto Options Deep Dive', mkt_market_making: 'Market Making & Liquidity',
  mkt_funding_basis: 'Funding Rates & Basis Trade', mkt_onchain_data_tools: 'On-Chain Data Tools',
  mkt_portfolio_management: 'Portfolio Management',
  tokenomics: 'Tokenomics', regulation: 'Crypto Regulation', ai_crypto: 'AI x Crypto',
  defi_lending: 'DeFi Lending', defi_overview_deep: 'DeFi Deep Dive',
  defi_liquidity: 'Liquidity Provision', defi_yield_strategies: 'Yield Strategies',
  defi_money_markets: 'Money Markets', defi_liquid_staking: 'Liquid Staking',
  defi_protocols_by_chain: 'DeFi by Chain', defi_hacks: 'DeFi Hacks & Exploits',
  defi_pendle_yield: 'Yield Tokenisation (Pendle)', defi_rwa: 'RWAs in DeFi',
  defi_portfolio: 'DeFi Portfolio Management', defi_bridges_deep: 'Cross-Chain DeFi',
  priv_zk_identity: 'ZK Identity & Compliant Privacy', priv_monero_deep: 'Monero Deep Dive',
  priv_tornado_legal: 'Tornado Cash Legal Saga', priv_railgun_aztec: 'Railgun & Aztec',
  priv_confidential_compute: 'Confidential Compute & FHE', priv_ux_tools: 'Privacy UX Tools',
  priv_future: 'Future of Onchain Privacy',
  privacy_crypto: 'Privacy in Crypto',
  ind_us_regulation: 'US Regulation Deep Dive', ind_global_regulation: 'Global Regulation',
  ind_crypto_taxes: 'Crypto Taxes', ind_institutional: 'Institutional Adoption',
  ind_ai_agents: 'AI Agents & Onchain Payments', ind_decentral_ai: 'Decentralised AI Compute',
  ind_verifiable_ai: 'Verifiable AI & zkML', ind_ai_tokens: 'AI Token Sector',
  ind_privacy_deep: 'Privacy Deep Dive',
  crypto_derivatives: 'Crypto Derivatives', wallet_advanced: 'Advanced Wallets',
  layer0: 'Layer 0 Protocols', evm_ecosystem: 'EVM Ecosystem',
  cbdc: 'CBDC', layer1: 'Layer 1', layer2: 'Layer 2',
  gas: 'Gas Fees', oracle: 'Oracles', cctp: 'CCTP', arc: 'Arc',
  solana: 'Solana', wallet: 'Crypto Wallets', metamask: 'MetaMask',
  seed: 'Seed Phrases', smart_contract: 'Smart Contracts', dao: 'DAOs',
}

// ── Glossary ───────────────────────────────────────────────────────────────
const GLOSSARY: GlossaryEntry[] = [
  { term: 'DYOR', definition: 'Do Your Own Research — always verify information independently.' },
  { term: 'HODL', definition: 'Hold On for Dear Life — a strategy of holding crypto long-term regardless of volatility.' },
  { term: 'FOMO', definition: 'Fear Of Missing Out — buying due to emotional pressure when prices rise.' },
  { term: 'FUD', definition: 'Fear, Uncertainty, and Doubt — negative sentiment spread about crypto.' },
  { term: 'Whale', definition: 'An entity holding a large amount of cryptocurrency, capable of moving markets.' },
  { term: 'ATH', definition: 'All-Time High — the highest price a cryptocurrency has ever reached.' },
  { term: 'ATL', definition: 'All-Time Low — the lowest price a cryptocurrency has ever reached.' },
  { term: 'Rekt', definition: 'Slang for suffering a major financial loss in crypto.' },
  { term: 'Rug pull', definition: 'A scam where developers abandon a project and abscond with investor funds.' },
  { term: 'Gas', definition: 'Fee paid to validators for executing transactions on EVM blockchains.' },
  { term: 'Gwei', definition: '10⁻⁹ ETH — the unit used to express Ethereum gas prices.' },
  { term: 'Mempool', definition: 'The pool of pending, unconfirmed transactions waiting to be included in a block.' },
  { term: 'DEX', definition: 'Decentralized Exchange — a peer-to-peer trading platform without a central operator.' },
  { term: 'CEX', definition: 'Centralized Exchange — a traditional crypto exchange like Coinbase or Binance.' },
  { term: 'AMM', definition: 'Automated Market Maker — a DEX that uses liquidity pools and pricing formulas instead of order books.' },
  { term: 'TVL', definition: 'Total Value Locked — the total value of assets deposited in a DeFi protocol.' },
  { term: 'APY', definition: 'Annual Percentage Yield — yearly return including compounding.' },
  { term: 'APR', definition: 'Annual Percentage Rate — yearly return without compounding.' },
  { term: 'LP', definition: 'Liquidity Provider — someone who deposits assets into a DEX pool to earn fees.' },
  { term: 'EVM', definition: 'Ethereum Virtual Machine — the runtime that executes smart contract code on Ethereum-compatible chains.' },
  { term: 'ABI', definition: 'Application Binary Interface — defines how to interact with a smart contract.' },
  { term: 'EOA', definition: 'Externally Owned Account — a regular Ethereum wallet controlled by a private key.' },
  { term: 'SCA', definition: 'Smart Contract Account — a wallet that is itself a smart contract (ERC-4337).' },
  { term: 'Finality', definition: 'The point at which a transaction is irreversible and permanently confirmed.' },
  { term: 'Slippage', definition: 'The difference between expected and actual execution price of a trade.' },
  { term: 'Floor price', definition: 'The lowest listed price for any NFT in a collection — a key measure of collection value.' },
  { term: 'Mint', definition: 'The act of creating a new NFT on a blockchain — recording it on-chain for the first time.' },
  { term: 'Rarity', definition: 'How uncommon an NFT\'s traits are within its collection. Rarer NFTs typically command higher prices.' },
  { term: 'PFP', definition: 'Profile Picture — an NFT used as a social media avatar; a major use case for collections like BAYC and CryptoPunks.' },
  { term: 'Generative art', definition: 'Art created algorithmically from randomized trait combinations at mint time. Examples: Art Blocks, BAYC.' },
  { term: 'Royalty', definition: 'A % of every secondary sale automatically paid to the original creator, enforced by ERC-2981 or marketplace policy.' },
  { term: 'Ordinals', definition: 'A protocol for inscribing data (images, text) onto individual satoshis on the Bitcoin blockchain — "Bitcoin NFTs".' },
  { term: 'Sats / Satoshi', definition: 'The smallest unit of Bitcoin (0.00000001 BTC). Ordinals assign data to individual satoshis.' },
  { term: 'DOGE', definition: 'Dogecoin — the original meme coin, launched 2013. Symbol is a Shiba Inu dog from the "doge" meme.' },
  { term: 'SHIB', definition: 'Shiba Inu — an ERC-20 meme coin marketed as the "Dogecoin killer." Has its own ShibaSwap DEX.' },
  { term: 'Pump.fun', definition: 'A Solana-based permissionless meme coin launchpad using a bonding curve; dominant in the 2024–2025 meme cycle.' },
  { term: 'Bonding curve', definition: 'A pricing mechanism where token price increases automatically as supply is bought. Used by meme launchpads.' },
  { term: 'Degen', definition: 'Short for "degenerate" — a crypto participant who takes extreme risks, often in meme coins or high-leverage trades.' },
  { term: 'P2E', definition: 'Play-to-Earn — a game model where players earn crypto or NFT rewards for in-game activity.' },
  { term: 'GameFi', definition: 'The intersection of gaming and DeFi — games with tokenized economies, NFT items, and token rewards.' },
  { term: 'RWA', definition: 'Real-World Asset — a physical or financial asset (real estate, bonds, gold) tokenized on a blockchain.' },
  { term: 'CT', definition: 'Crypto Twitter (now Crypto X) — the social media layer where crypto narratives, alpha, and memes originate.' },
  { term: 'KOL', definition: 'Key Opinion Leader — an influencer whose posts significantly move prices, especially in meme coins.' },
  { term: 'Sniping', definition: 'Buying a token in the very first transaction(s) after launch to maximize potential gains.' },
  { term: 'Alpha', definition: 'Information or insight that gives an edge before it becomes widely known.' },
  // NFT terms
  { term: 'Dutch auction', definition: 'A mint mechanism where price starts high and decreases over time until all NFTs are sold or a floor is hit.' },
  { term: 'Allowlist (AL/WL)', definition: 'A pre-approved list of wallet addresses permitted to mint an NFT before the public sale, usually at a lower price.' },
  { term: 'Reveal', definition: 'The moment NFT traits are randomly assigned and made visible, usually after the full collection has minted.' },
  { term: 'On-chain NFT', definition: 'An NFT where all metadata and media are stored directly in the smart contract, not on IPFS or a server.' },
  { term: 'IPFS', definition: 'InterPlanetary File System — a decentralised storage network commonly used to host NFT images and metadata.' },
  { term: 'Arweave', definition: 'A permanent, pay-once decentralised storage network. More durable than IPFS for NFT metadata.' },
  { term: 'Trait', definition: 'An individual visual or metadata attribute of an NFT (e.g. hat, eyes, background). Rarer trait combos = higher value.' },
  { term: 'Sweep', definition: 'Buying multiple NFTs from the floor of a collection at once, often to signal confidence or accumulate supply.' },
  { term: 'Blue chip NFT', definition: 'An established, high-value NFT collection with long-term community and brand recognition (e.g. CryptoPunks, BAYC).' },
  { term: 'Inscription', definition: 'Data (image, text, code) permanently written onto a Bitcoin satoshi via the Ordinals protocol.' },
  { term: 'BRC-20', definition: 'An experimental fungible token standard on Bitcoin using Ordinals inscriptions. Examples: ORDI, SATS.' },
  { term: 'cNFT', definition: 'Compressed NFT — uses Solana\'s state compression and Merkle trees to store millions of NFTs at near-zero cost.' },
  { term: 'ENS', definition: 'Ethereum Name Service — NFT-based .eth domain names that map to wallet addresses. Example: vitalik.eth.' },
  { term: 'Soulbound token (SBT)', definition: 'A non-transferable NFT representing credentials, achievements, or reputation. Cannot be sold or transferred.' },
  { term: 'Token-gated', definition: 'Content or access restricted to holders of a specific NFT or token.' },
  { term: 'NFT-Fi', definition: 'The intersection of NFTs and DeFi — NFT lending, borrowing, fractionalization, and AMM-based trading.' },
  // Meme coin terms
  { term: 'Ape in', definition: 'To buy a token quickly without much research, trusting community momentum.' },
  { term: 'Honeypot', definition: 'A scam contract where buyers cannot sell — you can buy but the contract blocks any sell transaction.' },
  // Meme coin deep-dive terms
  { term: 'WIF (dogwifhat)', definition: 'Solana meme coin of a Shiba Inu wearing a hat; reached multi-billion market cap in 2024; the defining Solana meme coin.' },
  { term: 'BONK', definition: 'Community meme coin airdropped to Solana NFT holders in December 2022; credited with reviving Solana community sentiment during the bear market.' },
  { term: 'PEPE', definition: 'Ethereum-based meme coin using Pepe the Frog imagery; launched April 2023 and reached $1B market cap in under 2 weeks.' },
  { term: 'MOG', definition: 'Ethereum "culture coin" with a strong artist and CT community identity; gained traction as a premium EVM meme asset.' },
  { term: 'BRETT', definition: "Base meme coin from Matt Furie's Boys Club comic (same creator as Pepe); became one of the largest Base-native meme coins." },
  { term: 'Toshi', definition: "Base's first major community meme coin; homage to Satoshi Nakamoto; orange cat mascot." },
  { term: 'Degen (token)', definition: 'Base/Farcaster social token tipped between users on the Farcaster protocol; evolved into a meme coin with DeFi integrations.' },
  { term: 'BOME', definition: 'Book of Meme — Solana meme coin launched via presale that raised $10M in days; one of the fastest presale fundraises in meme history.' },
  { term: 'MEW', definition: '"Cat in a dogs world" Solana meme coin; capitalised on the anti-dog narrative during the 2024 cat coin wave.' },
  { term: 'POPCAT', definition: 'Solana meme coin based on the cat-popping-a-balloon meme; reached $1B+ market cap in 2024.' },
  { term: 'FLOKI', definition: "Meme coin named after Elon Musk's Shiba Inu dog; built FlokiFi DeFi suite and Shibarium ecosystem." },
  { term: 'Shibarium', definition: 'SHIB L2 blockchain on Ethereum; processes Shiba Inu ecosystem transactions at lower cost; launched 2023.' },
  { term: 'ShibaSwap', definition: 'Native DEX of the Shiba Inu ecosystem on Ethereum; BONE governance token; LEASH scarce companion token.' },
  { term: 'TRUMP token', definition: 'Political meme coin launched in January 2025; billions in 24h volume; sharp decline after inauguration.' },
  { term: 'Murad thesis', definition: 'Influential 2024 argument that only meme coins with genuine cult communities will survive long-term — the "social consensus asset" thesis.' },
  { term: 'Narrative rotation', definition: 'The cyclical movement of meme capital from one theme to the next: dog coins, cat coins, AI coins, political coins, pop-culture coins.' },
  { term: 'Rugcheck.xyz', definition: 'Solana rug detection tool; checks LP lock, mint authority, freeze authority, and top holder concentration before buying.' },
  { term: 'Tokensniffer.com', definition: 'EVM rug detection tool; scans contract code for honeypot functions, mint functions, and dangerous ownership patterns.' },
  { term: 'LP lock', definition: 'Locking the liquidity pool tokens in a time-lock contract so the team cannot drain funds.' },
  { term: 'Bundling', definition: 'Using multiple wallets to accumulate a large % of a meme coin supply at launch while appearing as many separate buyers.' },
  { term: 'Graduate', definition: 'On pump.fun, a token that has filled its bonding curve and migrated liquidity to Raydium DEX.' },
  { term: 'DEXScreener', definition: 'A real-time token analytics platform tracking price, volume, liquidity, and holder data across hundreds of DEXs.' },
  { term: 'Bubblemaps', definition: 'A tool that visualises wallet clustering and token distribution to detect insider accumulation or bundled wallets.' },
  { term: 'Narrative', definition: 'The current market story driving a group of tokens — e.g. "AI coins", "dog coins", "political coins". Capital rotates between narratives.' },
  // GameFi terms
  { term: 'Play-to-Earn (P2E)', definition: 'A game model where players earn crypto tokens or NFTs as rewards for in-game activity.' },
  { term: 'Free-to-Own (F2O)', definition: 'A GameFi model where NFTs are distributed free to players, removing the upfront cost barrier. Pioneered by Limit Break.' },
  { term: 'Full Onchain Game (FOCG)', definition: 'A game where all state and logic lives in smart contracts on a public blockchain. Permissionless and censorship-resistant.' },
  { term: 'Scholarship (GameFi)', definition: 'An arrangement where an NFT owner (manager) lends game assets to a player (scholar) who shares a % of earnings in return.' },
  { term: 'Token sink', definition: 'A mechanic that removes tokens from circulation — breeding, crafting, entry fees — to counteract inflation in P2E economies.' },
  { term: 'Dual-token model', definition: 'A GameFi tokenomics pattern with a scarce governance token and an inflationary reward token (e.g. AXS + SLP in Axie Infinity).' },
  { term: 'Ronin', definition: 'Axie Infinity\'s custom EVM sidechain with near-zero gas fees, designed for gaming. Suffered a $625M hack in 2022.' },
  { term: 'Immutable X (IMX)', definition: 'Ethereum L2 for gaming using ZK proofs; offers zero gas fee NFT minting. Home to Gods Unchained and Guild of Guardians.' },
  { term: 'MUD framework', definition: 'An onchain game engine by lattice.xyz that stores all game state as smart contract tables. Used for fully onchain games.' },
  { term: 'Yield Guild Games (YGG)', definition: 'The largest P2E gaming guild; accumulated game NFTs and lent them to scholars globally; pivoted to a Web3 gaming network post-P2E collapse.' },
  { term: 'ERC-6551', definition: 'Token Bound Accounts — each NFT can have its own wallet address, enabling NFTs to own other assets (e.g. a character NFT owning its items).' },
  { term: 'CryptoKitties', definition: 'The first viral blockchain game (2017) where players bred unique cat NFTs. Famously congested the Ethereum network at peak popularity.' },
  { term: 'Axie Infinity', definition: 'The defining P2E game; peaked at 2.7M daily players in 2021. AXS governance token and SLP reward token; SLP later collapsed.' },
  // GameFi deep-dive terms
  { term: 'RON', definition: "Ronin's native gas and staking token; validators stake RON to secure the network; used for Katana DEX liquidity incentives." },
  { term: 'Katana DEX', definition: "Ronin's native automated market maker DEX for trading in-game tokens (AXS, SLP, PIXELS); RON-USDC is the main liquidity pool." },
  { term: 'Sky Mavis', definition: 'Developer of Axie Infinity and the Ronin blockchain; raised $152M Series B at $3B valuation; suffered the $625M Ronin bridge hack.' },
  { term: 'Pixels', definition: 'Farming RPG on Ronin blockchain; peaked at 1M+ daily users in 2024; PIXEL token; one of the most-played blockchain games.' },
  { term: 'Treasure DAO', definition: 'Decentralised gaming ecosystem on Arbitrum; MAGIC token is the reserve currency; hosts Bridgeworld, Smol Brains, The Beacon.' },
  { term: 'MAGIC token', definition: 'Reserve currency of the Treasure DAO gaming ecosystem on Arbitrum; staked to mine resources in Bridgeworld.' },
  { term: 'Xai', definition: 'Arbitrum Orbit L3 gaming chain by Offchain Labs; targets traditional game studios moving to blockchain.' },
  { term: 'Star Atlas', definition: 'Ambitious Solana space MMO with AAA Unreal Engine graphics; ATLAS (in-game) and POLIS (governance) tokens; years in development.' },
  { term: 'Notcoin', definition: 'Telegram tap-to-earn game on TON blockchain; 35M+ players; NOT token airdrop; one of the highest-user-count crypto games ever.' },
  { term: 'Hamster Kombat', definition: 'Telegram clicker game on TON; claimed 200M+ registered users; HMSTR token airdrop; defined the Telegram mini-app GameFi wave.' },
  { term: 'STEPN', definition: 'Move-to-earn game on Solana; earn GST/GMT tokens by walking/running tracked via GPS; peaked at $400M+ market cap before sharp decline.' },
  { term: 'Animoca Brands', definition: 'Most active Web3 gaming investor and publisher; 100+ portfolio companies; co-created The Sandbox; led by Yat Siu.' },
  { term: 'Mythos Chain', definition: 'Mythical Games EVM chain for NFL Rivals and Blankos; built for mobile GameFi with familiar Web2 onboarding.' },
  { term: 'GameShift', definition: 'Solana Labs REST API for game developers; abstracts wallet creation, NFT minting, and token transfers for Web2 studios.' },
  { term: 'Sonic SVM', definition: 'Gaming-focused Solana Virtual Machine L2; isolated throughput for games; Aurory migrated here for its full launch.' },
  { term: 'DRiP', definition: 'Free compressed NFT distribution platform on Solana; artists send cNFTs weekly; millions distributed to subscribers.' },
  // DEX / CEX terms
  { term: 'Order book', definition: 'A list of open buy and sell orders for an asset, sorted by price. Used by CEXs and some DEXs (dYdX, Hyperliquid, Phoenix).' },
  { term: 'Uniswap v3', definition: 'Concentrated liquidity AMM; LPs set custom price ranges, achieving up to 4000x capital efficiency over v2.' },
  { term: 'Uniswap v4', definition: 'Adds "hooks" to Uniswap pools — custom logic at lifecycle events enabling limit orders, dynamic fees, MEV mitigation.' },
  { term: 'UniswapX', definition: 'Intent-based swap layer; users sign an off-chain order, solvers compete to fill at best price with no sandwiching.' },
  { term: 'Curve Wars', definition: 'Competition among DeFi protocols to accumulate veCRV and direct CRV emissions to their liquidity pools.' },
  { term: 'veCRV', definition: 'Vote-escrowed CRV; locked CRV that grants boosted yields and voting rights over Curve gauge weights.' },
  { term: 'veTokenomics', definition: 'Token model where locking tokens long-term grants voting power and yield boosts; pioneered by Curve Finance.' },
  { term: 'crvUSD', definition: "Curve's CDP stablecoin using the LLAMMA liquidation AMM to softly rebalance collateral as price falls." },
  { term: 'Gauge voting', definition: 'Mechanism where veToken holders vote each epoch to direct protocol token emissions to specific liquidity pools.' },
  { term: 'Bribes', definition: 'Payments made to veToken holders to vote for a specific gauge/pool; creates an open vote marketplace.' },
  { term: 've(3,3)', definition: 'DEX tokenomics model combining vote-escrow locking with game-theory cooperation; popularised by Velodrome and Aerodrome.' },
  { term: 'Aerodrome', definition: 'Dominant DEX on Base using ve(3,3) model; largest TVL and trading volume on Base.' },
  { term: 'Velodrome', definition: 'Dominant DEX on Optimism; parent of Aerodrome; ve(3,3) model with weekly gauge voting.' },
  { term: 'CLOB', definition: 'Central Limit Order Book — traditional price-time priority matching engine; now live onchain on Solana (Phoenix) and Hyperliquid.' },
  { term: 'Hyperliquid', definition: 'Purpose-built L1 with fully onchain perpetual futures CLOB; sub-second finality; HYPE token; top onchain perp in 2025–2026.' },
  { term: 'ZK identity', definition: 'Zero-knowledge proof that reveals a credential (e.g. "over 18", "KYC-passed") without revealing the holder\'s identity.' },
  { term: 'World ID', definition: 'Worldcoin\'s biometric iris-scan system proving unique humanity with a ZK proof; Sybil resistance at scale.' },
  { term: 'Semaphore', definition: 'ZK protocol for anonymous group membership proofs; widely used for private voting and anonymous credentials.' },
  { term: 'Polygon ID', definition: 'Decentralised identity using ZK credentials on Polygon; W3C Verifiable Credentials standard.' },
  { term: 'RingCT', definition: 'Monero\'s Ring Confidential Transactions — hides transaction amounts using Pedersen commitments; mandatory since 2018.' },
  { term: 'Stealth address', definition: 'One-time address per transaction in Monero; makes it impossible to link transactions to a public address.' },
  { term: 'Ring signature', definition: 'Monero cryptographic signature using decoy inputs; hides which input was actually spent.' },
  { term: 'Proof of Innocence', definition: 'Railgun feature using ZK exclusion proofs to prove funds do NOT come from sanctioned sources.' },
  { term: 'Aztec Network', definition: 'ZK rollup with programmable privacy; private smart contracts in Noir language; private DeFi interactions.' },
  { term: 'Noir (Aztec)', definition: 'Aztec\'s ZK domain-specific language for writing private smart contracts.' },
  { term: 'FHE', definition: 'Fully Homomorphic Encryption — perform computations on encrypted data without decrypting; the privacy holy grail now practical.' },
  { term: 'Zama fhEVM', definition: 'FHE-enabled EVM by Zama; confidential smart contracts with encrypted state on standard Ethereum tooling.' },
  { term: 'Fhenix', definition: 'FHE-enabled L2 rollup on Ethereum; confidential DeFi and private smart contracts.' },
  { term: 'Phala Network', definition: 'TEE-based confidential compute network; 50,000+ Intel SGX worker nodes; private smart contracts (phat contracts).' },
  { term: 'Remote attestation', definition: 'Cryptographic proof that specific code is running inside a genuine TEE; verifiable without trusting the hardware operator.' },
  { term: 'CoinJoin', definition: 'Bitcoin privacy technique combining multiple inputs/outputs so on-chain observers can\'t tell which input maps to which output.' },
  { term: 'Wasabi Wallet', definition: 'Desktop Bitcoin wallet with built-in CoinJoin mixing and Tor routing for transaction privacy.' },
  { term: 'OFAC SDN', definition: 'US Treasury\'s Specially Designated Nationals list; adding a smart contract address (Tornado Cash) set a privacy-law precedent.' },
  { term: 'Roman Storm', definition: 'Tornado Cash developer facing US criminal charges for money laundering conspiracy; first trial of a developer for writing privacy software.' },
  { term: 'Van Loon v Treasury', definition: '5th Circuit ruling (Nov 2024) that OFAC overstepped: immutable smart contracts are not "property" and cannot be sanctioned.' },
  { term: 'SOPR', definition: 'Spent Output Profit Ratio — measures if coins moving on-chain are in profit; below 1 signals capitulation.' },
  { term: 'MVRV', definition: 'Market Value to Realised Value — compares market cap to cost basis of all coins; above 3.5 historically signals overvaluation.' },
  { term: 'Realised cap', definition: 'Values each UTXO at its last moved price; smoother measure of total value stored in Bitcoin than market cap.' },
  { term: 'NVT', definition: 'Network Value to Transactions — a P/E ratio for blockchains; high NVT = overvalued relative to on-chain usage.' },
  { term: 'Exchange netflow', definition: 'Net BTC/ETH moving to/from exchanges; inflows = selling pressure; outflows = accumulation or self-custody.' },
  { term: 'Open Interest (OI)', definition: 'Total outstanding derivative contracts on an exchange; high OI + price drop = potential long squeeze.' },
  { term: 'Funding rate', definition: 'Periodic payment between perp longs and shorts to keep price near spot; positive = longs pay shorts.' },
  { term: 'Golden cross', definition: '50-day MA crossing above 200-day MA — widely watched bullish signal.' },
  { term: 'Death cross', definition: '50-day MA crossing below 200-day MA — widely watched bearish signal.' },
  { term: 'RSI', definition: 'Relative Strength Index — momentum oscillator 0–100; above 70 = overbought; below 30 = oversold.' },
  { term: 'MACD', definition: 'Moving Average Convergence Divergence — trend-following momentum indicator; crossovers and histogram flips signal trend changes.' },
  { term: 'Bollinger Bands', definition: 'Price bands ±2 standard deviations from a moving average; squeezes precede big moves.' },
  { term: 'BTC halving cycle', definition: 'Every ~4 years Bitcoin\'s block reward halves; historically followed by bull market 12–18 months later.' },
  { term: 'Basis trade', definition: 'Long spot + short futures to earn the premium (basis); delta-neutral; popular with institutional desks.' },
  { term: 'Contango', definition: 'Futures price above spot; indicates bullish market sentiment; normal state for crypto.' },
  { term: 'Backwardation', definition: 'Futures price below spot; indicates bearish sentiment or market stress.' },
  { term: 'Delta (options)', definition: 'Rate of change of option price per $1 move in the underlying; 0.5 delta = $0.50 option gain per $1 asset rise.' },
  { term: 'Theta (options)', definition: 'Time decay — options lose value daily as expiry approaches; works against buyers, in favour of sellers.' },
  { term: 'IV (Implied Volatility)', definition: 'Market\'s expectation of future price volatility derived from option prices; rising IV = more expensive options.' },
  { term: 'DVOL', definition: 'Deribit\'s Bitcoin Implied Volatility Index — crypto\'s equivalent of the VIX fear gauge.' },
  { term: 'Deribit', definition: 'Dominant crypto options exchange; ~90% of BTC/ETH options open interest; home of the DVOL index.' },
  { term: 'Coinglass', definition: 'Aggregates futures OI, funding rates, liquidations, and long/short ratios across all major exchanges.' },
  { term: 'Token Terminal', definition: 'DeFi analytics platform showing protocol revenue, fees, and P/S ratios — fundamental analysis for DeFi.' },
  { term: 'Glassnode', definition: 'Gold-standard on-chain analytics platform for Bitcoin and Ethereum; MVRV, SOPR, exchange flows and more.' },
  { term: 'Wyckoff method', definition: 'Market cycle framework: accumulation → spring → markup → distribution → markdown; widely applied to crypto.' },
  { term: 'Kelly Criterion', definition: 'Mathematical formula for optimal bet sizing: fraction = edge / odds; often halved ("half Kelly") in practice.' },
  { term: 'Core-satellite portfolio', definition: 'BTC+ETH core (60-80%) + higher-risk satellite positions (20-40%); most common crypto allocation framework.' },
  { term: 'CCTP v2', definition: 'Circle\'s upgraded Cross-Chain Transfer Protocol with Fast Transfer mode (~2 sec) and Hook support for composable cross-chain actions.' },
  { term: 'TokenMessenger', definition: 'The CCTP smart contract that initiates USDC burns on source chains and mints on destination chains.' },
  { term: 'DVN (LayerZero)', definition: 'Decentralised Verifier Network — off-chain oracles that verify cross-chain messages for LayerZero; configurable per application.' },
  { term: 'OFT (Omnichain Fungible Token)', definition: 'LayerZero\'s token standard for a unified supply across multiple chains; burns on source, mints on destination.' },
  { term: 'VAA (Wormhole)', definition: 'Verified Action Approval — signed message produced by Wormhole\'s Guardian network after verifying a cross-chain event.' },
  { term: 'NTT (Wormhole)', definition: 'Native Token Transfers — Wormhole\'s multi-chain token standard with rate limiting and access control, similar to OFT.' },
  { term: 'IBC', definition: 'Inter-Blockchain Communication — the Cosmos protocol for trust-minimised cross-chain messaging using light client verification.' },
  { term: 'Relay chain', definition: 'Polkadot\'s central chain that provides shared security and XCM messaging coordination for all connected parachains.' },
  { term: 'Parachain', definition: 'A sovereign blockchain that leases a slot on the Polkadot relay chain and gets its security from relay chain validators.' },
  { term: 'XCM', definition: 'Cross-Consensus Messaging — Polkadot\'s native message format for communication between the relay chain and parachains.' },
  { term: 'Agile Coretime', definition: 'Polkadot 2.0\'s replacement for fixed parachain slot auctions — flexible monthly purchase of block production time.' },
  { term: 'Solver (intents)', definition: 'Specialised actor that fills user intents in intent-based bridging by fronting destination capital and being reimbursed onchain.' },
  { term: 'ERC-7683', definition: 'Cross-chain intent standard co-authored by Across Protocol and Uniswap; unified intent format for any solver to fill.' },
  { term: 'Across Protocol', definition: 'Fastest EVM bridge; relayer-based intent filling with UMA optimistic oracle verification; consistently lowest fees.' },
  { term: 'Universal Account', definition: 'Particle Network\'s chain-abstracted account — single address controlling assets on all chains with one balance view.' },
  { term: 'Polymer Protocol', definition: 'Brings IBC light-client verification to Ethereum mainnet via ZK proofs — IBC without running a Cosmos chain.' },
  { term: 'Candle auction', definition: 'Polkadot\'s parachain slot auction mechanism — ends at a random retroactive block to prevent last-second sniping.' },
  { term: 'Nomad bridge', definition: 'Bridge that suffered a $190M hack in 2022 due to a Merkle proof misconfiguration that enabled a copy-paste exploit.' },
  { term: 'Phoenix', definition: 'Fully onchain CLOB on Solana; zero maker fees; deterministic matching used by HFT bots and market makers.' },
  { term: 'MEV-Boost', definition: 'Ethereum PBS module separating block proposing from building; professional builders maximise block value via MEV-Boost.' },
  { term: 'Flashbots', definition: 'Org behind MEV-Boost and Flashbots Protect RPC; aims to make MEV transparent and reduce harmful extraction.' },
  { term: 'Convex Finance', definition: 'Protocol that aggregated veCRV to boost Curve LP yields; cvxCRV is a liquid wrapper for locked CRV.' },
  // CEX deep-dive terms
  { term: 'Mt. Gox', definition: 'First major Bitcoin exchange (2010–2014); handled 70% of BTC volume before 850,000 BTC were stolen; collapsed 2014.' },
  { term: 'BitLicence', definition: 'New York State DFS crypto exchange licence; the most stringent US state requirement; only ~20 companies hold it.' },
  { term: 'MPI licence', definition: 'Major Payment Institution licence from Singapore MAS required to offer crypto payment services in Singapore.' },
  { term: 'VARA', definition: 'Virtual Asset Regulatory Authority — Dubai regulator for crypto firms; crypto-friendly with clear licensing framework.' },
  { term: 'MiCA', definition: 'Markets in Crypto-Assets Regulation — EU-wide law in force 2024 creating a single licence for crypto firms across 27 member states.' },
  { term: 'KYC', definition: 'Know Your Customer — identity verification (ID, address proof) required by regulated exchanges to prevent fraud and money laundering.' },
  { term: 'AML', definition: 'Anti-Money Laundering — legal requirements to detect and report suspicious transactions; goes hand-in-hand with KYC.' },
  { term: 'MTL', definition: 'Money Transmitter Licence — US state-level licence required for crypto exchanges operating as money transmitters.' },
  { term: 'BNB', definition: "Binance's exchange token; top-5 market cap; 25% fee discount on Binance; powers BNB Smart Chain ecosystem; quarterly token burn." },
  { term: 'OKB', definition: "OKX's exchange token; fee discounts, staking, launchpad access; used on OKX X1 L2." },
  { term: 'KCS', definition: 'KuCoin Shares — holders receive a daily dividend of 50% of KuCoin trading fee revenue.' },
  { term: 'CRO', definition: "Crypto.com's token; stake to unlock higher Visa card cashback tiers; powers the Cronos EVM chain." },
  { term: 'FTT', definition: 'FTX exchange token; collapsed to near-zero when FTX fraud was exposed in November 2022; cautionary tale for exchange tokens.' },
  { term: 'Proof of Reserves', definition: 'Cryptographic audit (Merkle tree) proving an exchange holds at least as much in assets as it owes to users.' },
  { term: 'Coinbase Prime', definition: "Coinbase's institutional brokerage: custody, OTC, staking, portfolio reporting; used by BlackRock for IBIT ETF custody." },
  { term: 'OCO order', definition: 'One-Cancels-Other — a pair of orders where if one fills, the other is automatically cancelled; used to manage risk.' },
  { term: 'Basis trade', definition: 'Simultaneously holding spot and shorting futures when they trade at a premium; captures the spread as near-risk-free yield.' },
  { term: 'Deribit', definition: 'Leading crypto options exchange; ~80% market share in BTC and ETH options; used by institutional options traders.' },
  { term: 'SAFU', definition: "Secure Asset Fund for Users — Binance's $1B+ insurance fund that covers users in cases of security breaches." },
  { term: 'P2P market', definition: 'Peer-to-peer trading section of a CEX where users trade directly with each other using local payment methods; avoids banking rails.' },
  // RWA deep-dive terms
  { term: 'BUIDL', definition: "BlackRock's tokenised US Treasury fund on Ethereum; $1B+ AUM; pays daily USDC dividends; custodied by BNY Mellon." },
  { term: 'Franklin BENJI', definition: 'First US-registered mutual fund on a public blockchain (Stellar/Polygon); tokenised money market fund targeting $1 NAV.' },
  { term: 'OUSG', definition: "Ondo Finance's tokenised BlackRock short-term US Treasury ETF; ERC-20 on Ethereum and Solana; for qualified purchasers." },
  { term: 'USDY', definition: "Ondo Finance's yield-bearing note backed by Treasuries; non-US retail accessible; used as a stablecoin alternative in DeFi." },
  { term: 'Superstate USTB', definition: 'Tokenised Treasury fund by Superstate; Circle provides settlement rails; institutional-grade T-bill exposure onchain.' },
  { term: 'ERC-3643 / T-REX', definition: 'Compliance-native ERC-20 extension; includes transfer restrictions so only whitelisted wallets can hold security tokens.' },
  { term: 'Securitize', definition: 'End-to-end tokenised securities platform; handles KYC, issuance, and transfer agent services; partner of BlackRock for BUIDL.' },
  { term: 'Tokeny', definition: 'ERC-3643 token issuance platform for compliant security tokens; used by 150+ European institutional issuers.' },
  { term: 'GS DAP', definition: "Goldman Sachs Digital Asset Platform; issued €100M digital bond for the European Investment Bank on a private blockchain." },
  { term: 'Drex', definition: "Brazil's CBDC programme; includes tokenised government bonds as DeFi collateral — the most advanced CBDC-RWA integration globally." },
  { term: 'ADDX', definition: 'Singapore-based institutional exchange for tokenised private market securities; regulated by MAS.' },
  { term: 'Centrifuge', definition: 'Largest RWA DeFi protocol; finances trade finance, invoices, real estate, and car loans on-chain; integrates with MakerDAO for DAI.' },
  // NFT deep-dive terms
  { term: 'Sound.xyz', definition: "Dominant Ethereum music NFT platform; artists mint limited edition songs; top drops earn $50K–$500K from direct fan sales." },
  { term: 'Royal.io', definition: 'Fractional music streaming royalty NFTs; holders earn proportional Spotify/Apple Music royalty distributions in USDC.' },
  { term: 'Catalog', definition: '1-of-1 music NFT marketplace on Ethereum; single-edition records; purist collector culture.' },
  { term: 'Audius', definition: 'Decentralised music streaming protocol; AUDIO token rewards artists and curators; integrates with TikTok.' },
  { term: 'NBA Top Shot', definition: 'Dapper Labs NFT platform; licensed NBA video moments on the Flow blockchain; $1B+ in sales; onboarded millions of mainstream users.' },
  { term: 'Sorare', definition: 'Fantasy football + NFT trading cards; licensed by 250+ clubs; top players earn weekly prizes; $532M Series B raised.' },
  { term: 'Manifold', definition: "Most popular Ethereum NFT creator contract platform; custom minting pages, airdrop, burn mechanics, and allowlists — Eminem and Snoop Dogg used it." },
  { term: 'ThirdWeb', definition: 'Full-stack NFT/web3 development platform; pre-built smart contracts, gasless minting, marketplace widgets, Solana support.' },
  { term: 'Crossmint', definition: 'Credit card NFT checkout and email-based wallet infrastructure; lets non-crypto users buy NFTs without MetaMask.' },
  { term: 'Dutch auction (NFT)', definition: 'Mint price starts high and decreases over time until all tokens sell; used by Art Blocks, Yuga Labs, and many blue-chip launches.' },
  { term: 'ERC-2981', definition: 'On-chain royalty standard for NFTs; specifies a royalty recipient and percentage in the token contract; marketplaces may choose to ignore it.' },
  { term: 'NFTScan', definition: 'Multi-chain NFT explorer; track wallets, collection transfers, and on-chain activity across 20+ blockchains.' },
  { term: 'Nansen', definition: 'Blockchain analytics; labels wallets by behaviour (smart money, VCs, exchanges); widely used to track NFT whale movements.' },
  { term: 'Cost basis (NFT)', definition: 'Purchase price + gas fees paid; used to calculate capital gain/loss on disposal for tax reporting.' },
  { term: 'Wash trading (NFT)', definition: 'Buying and selling an NFT to yourself to artificially inflate volume; may constitute market manipulation; common on incentivised marketplaces.' },
  { term: 'Koinly', definition: 'Crypto/NFT tax software; imports transactions from 700+ exchanges and wallets; calculates capital gains for 30+ countries.' },
  { term: 'Zora Protocol', definition: 'Open on-chain minting protocol on Ethereum and Base; no platform fee; creators earn 100% primary and set secondary royalties.' },
  { term: 'Arianee', definition: 'Digital passport protocol for luxury goods; LVMH, Breitling, and Vacheron Constantin use it for product authentication.' },
  { term: 'Goldfinch', definition: 'DeFi private credit protocol lending to businesses in emerging markets (Philippines, Kenya, Mexico); credit underwriting by local auditors.' },
  { term: 'Chronicle', definition: "MakerDAO's in-house oracle network; secures $20B+ in RWA-backed vaults with NAV and price data." },
  { term: 'Fireblocks', definition: 'Most widely used institutional digital asset MPC custody platform; supports RWA token issuance and custody.' },
  { term: 'Maker / Taker', definition: 'Maker adds liquidity (places a limit order); Taker removes liquidity (fills an existing order). Maker fees are usually lower.' },
  { term: 'Spread', definition: 'The difference between the best bid (buy) and ask (sell) price. Tighter spreads = more liquid market.' },
  { term: 'Liquidity pool', definition: 'A smart contract holding two or more tokens that users can trade against. LPs deposit tokens and earn fees from every trade.' },
  { term: 'Concentrated liquidity', definition: 'Uniswap v3 feature where LPs choose a price range. Capital is used only when price is in range — higher fees but more risk.' },
  { term: 'Price impact', definition: 'How much a trade moves the pool price. Larger trades on smaller pools cause higher price impact and effective slippage.' },
  { term: 'MEV', definition: 'Maximal Extractable Value — profit extracted by validators/searchers by reordering, inserting, or censoring transactions in a block.' },
  { term: 'Sandwich attack', definition: 'An MEV attack: a bot front-runs your swap by buying before you and selling after, profiting from your price impact.' },
  { term: 'Front-running', definition: 'Submitting a transaction with higher gas to execute before a known pending transaction, exploiting its price movement.' },
  { term: 'Intent-based trading', definition: 'User signs an intent (desired outcome) rather than a transaction. Solvers compete to fill it optimally. Used by CoW, UniswapX, 1inch Fusion.' },
  { term: 'Funding rate', definition: 'A periodic payment between long and short traders on a perpetual DEX that keeps the perpetual price anchored to spot.' },
  { term: 'Perpetual contract', definition: 'A derivative with no expiry date. Traders can hold leveraged positions indefinitely, paying or receiving funding rates.' },
  { term: 'Proof of reserves', definition: 'A cryptographic audit proving a CEX holds sufficient assets to cover all user balances. Became standard after the FTX collapse.' },
  { term: 'KYC / AML', definition: 'Know Your Customer / Anti-Money Laundering — identity verification required by regulated CEXs to comply with financial law.' },
  { term: 'Spot trading', definition: 'Buying or selling an asset for immediate delivery at the current market price. The most basic form of trading on both CEX and DEX.' },
  { term: 'Margin trading', definition: 'Borrowing funds from a platform to increase position size. Amplifies both gains and losses; liquidation possible if collateral drops.' },
  { term: 'CeDeFi', definition: 'Centralised-Decentralised Finance — hybrid products that blend CEX infrastructure with onchain settlement (e.g. BNB Chain, dYdX appchain).' },
  // Stablecoins / bridges
  { term: 'USDT (Tether)', definition: 'The largest stablecoin by market cap. Issued by Tether Ltd (offshore). Backs most crypto trading pairs on CEXs. Less transparent than USDC historically.' },
  { term: 'DAI', definition: 'A decentralised, crypto-backed stablecoin issued by MakerDAO. Overcollateralised by ETH, wBTC, and other assets. Soft-pegged to $1.' },
  { term: 'Yield-bearing stablecoin', definition: 'A stablecoin that automatically accrues yield (e.g. sUSDe, sUSDS) from underlying DeFi strategies or reserve income.' },
  { term: 'Algorithmic stablecoin', definition: 'A stablecoin using code and incentives to maintain its peg. Notorious for failures — UST/LUNA collapsed in May 2022 wiping out ~$40B.' },
  { term: 'Lock-and-mint bridge', definition: 'A bridge that locks tokens on the source chain and mints a wrapped copy on the destination. Risk: the lock contract is a single point of failure.' },
  { term: 'Wrapped token', definition: 'A tokenised representation of an asset on another chain (e.g. WBTC is Bitcoin wrapped as an ERC-20 on Ethereum).' },
  { term: 'IBC', definition: 'Inter-Blockchain Communication — Cosmos\'s native cross-chain messaging protocol enabling sovereign chains to transfer tokens and data.' },
  // Security
  { term: 'Phishing', definition: 'A social engineering attack using fake websites or messages to trick users into revealing their seed phrase or signing a malicious transaction.' },
  { term: 'Approval scam', definition: 'A malicious dApp requesting unlimited token approval. Use revoke.cash to audit and revoke old approvals.' },
  { term: 'Drainer', definition: 'A smart contract that drains a wallet in one click via Permit2 or setApprovalForAll. Common in fake NFT mint and airdrop sites.' },
  { term: 'SIM swap', definition: 'An attack where a hacker ports your phone number to steal SMS-based 2FA. Use a hardware key (YubiKey) instead.' },
  { term: 'Multi-sig', definition: 'A wallet requiring M-of-N key signatures to authorise a transaction (e.g. 3-of-5). Standard for DAO treasuries and protocol admin keys.' },
  // Tokenomics / derivatives
  { term: 'Vesting', definition: 'The schedule over which team/investor token allocations unlock. Shorter vesting = higher dump risk after token launch.' },
  { term: 'Emission schedule', definition: 'The rate at which new tokens are released into circulation. High emissions dilute holders unless demand keeps pace.' },
  { term: 'Open Interest (OI)', definition: 'The total value of outstanding derivative contracts (futures/perps) that have not been settled. High OI signals active speculation.' },
  { term: 'Basis', definition: 'The difference between a futures contract price and the spot price. Positive basis (contango) means futures trade at a premium.' },
  { term: 'Max pain', definition: 'The options strike price at which the maximum number of contracts expire worthless — often a price magnet near options expiry.' },
  // Regulation / AI
  { term: 'MiCA', definition: 'Markets in Crypto-Assets — the EU\'s comprehensive crypto regulatory framework, fully in force 2025. Covers stablecoins, exchanges, and token issuers.' },
  { term: 'Howey Test', definition: 'A US legal test for whether an asset is a security: investment of money in a common enterprise with an expectation of profits from others\' efforts.' },
  { term: 'SAB 121', definition: 'SEC accounting guidance that initially prevented banks from custodying crypto on balance sheet. Reversed in 2025, opening bank custody of digital assets.' },
  { term: 'AI agent', definition: 'An autonomous software program that perceives its environment and takes actions. In crypto, agents can hold wallets, pay for services, and execute onchain transactions.' },
  { term: 'x402', definition: 'A protocol for HTTP 402 payments — allows AI agents and APIs to charge USDC micropayments per request without a traditional billing account.' },
  { term: 'Bittensor (TAO)', definition: 'A decentralised network where machine learning models compete to provide the best AI inference, rewarded in TAO tokens.' },
  { term: 'Layer 0', definition: 'Infrastructure below Layer 1 blockchains providing cross-chain messaging, shared security, or data availability (Polkadot, Cosmos, LayerZero, Wormhole).' },
  { term: 'Superchain', definition: 'Optimism\'s vision of multiple OP Stack chains sharing a security layer, messaging standard, and governance framework.' },
  // Stablecoin terms
  { term: 'USDS', definition: 'The renamed version of DAI after MakerDAO rebranded to Sky Protocol in 2024. Functionally equivalent to DAI; earns the Sky Savings Rate (SSR).' },
  { term: 'sUSDe', definition: 'Ethena\'s yield-bearing stablecoin. Earns funding rates from delta-neutral ETH hedging positions. Higher yield than T-bill stables but carries funding rate risk.' },
  { term: 'USDe (Ethena)', definition: 'A synthetic USD stablecoin by Ethena. Backed by ETH collateral delta-hedged with short perpetuals. Not algorithmic — carries funding rate and exchange counterparty risk.' },
  { term: 'PSM', definition: 'Peg Stability Module — MakerDAO mechanism to swap USDC 1:1 for DAI with no slippage, keeping DAI tightly pegged. Source of DAI\'s centralisation risk.' },
  { term: 'CDP', definition: 'Collateralised Debt Position — the MakerDAO vault where users lock collateral and mint DAI. Now called a "vault" in the Sky Protocol.' },
  { term: 'Collateralisation ratio', definition: 'The ratio of collateral value to borrowed amount. A 150% ratio means $150 of collateral is needed to borrow $100. Below the liquidation ratio triggers forced repayment.' },
  { term: 'Liquidation', definition: 'The automated process of selling collateral when a borrower\'s position falls below the minimum collateral ratio, protecting the protocol from bad debt.' },
  { term: 'PYUSD', definition: 'PayPal USD — PayPal\'s fiat-backed stablecoin issued on Ethereum and Solana. Backed by USD cash and T-bills; aimed at PayPal\'s consumer payment network.' },
  { term: 'GENIUS Act', definition: 'A proposed US federal stablecoin law requiring 1:1 reserve backing, monthly audits, and federal/state licensing for dollar-pegged stablecoin issuers.' },
  { term: 'EMT', definition: 'E-Money Token — the MiCA category for fiat-referenced stablecoins. Requires 1:1 backing, EU-licensed issuer, and redemption at par at any time.' },
  { term: 'De-peg', definition: 'When a stablecoin\'s market price deviates significantly from its target (e.g. $1.00). Caused by loss of confidence, reserve issues, or liquidity crises.' },
  { term: 'LUSD', definition: 'Liquity USD — a crypto-backed stablecoin backed only by ETH at a minimum 110% ratio. Fully decentralised; no governance; stability pool absorbs liquidations.' },
  { term: 'FRAX', definition: 'Frax Finance\'s stablecoin. Started as partially algorithmic; moved to fully-collateralised (USDC + ETH) after UST collapse. Also issues frxETH liquid staking token.' },
  // DeFi terms
  { term: 'TVL', definition: 'Total Value Locked — the dollar value of all assets deposited in a DeFi protocol. The primary metric of protocol size and adoption.' },
  { term: 'LP token', definition: 'Liquidity Provider token — a receipt token issued when you deposit assets into a DEX liquidity pool. Redeemable for your share of the pool.' },
  { term: 'Liquidity mining', definition: 'Earning a protocol\'s governance tokens as a bonus reward for providing liquidity or lending to their platform. Often temporary; creates sell pressure.' },
  { term: 'stETH', definition: 'Lido\'s liquid staking ETH token. 1 stETH = 1 ETH + accumulated staking rewards. Accepted as collateral on Aave, MakerDAO, and most major DeFi protocols.' },
  { term: 'rETH', definition: 'Rocket Pool\'s liquid staking ETH token. Appreciates vs ETH over time as staking rewards accrue. More decentralised than Lido\'s stETH.' },
  { term: 'Utilisation rate', definition: 'In lending protocols: the percentage of supplied assets that are currently borrowed. High utilisation drives interest rates up; low utilisation keeps them low.' },
  { term: 'Health factor', definition: 'Aave\'s metric for collateral safety. A health factor above 1.0 is safe; below 1.0 triggers liquidation. Keep above 1.5 for a comfortable buffer.' },
  { term: 'Recursive lending', definition: 'A DeFi loop: supply asset A, borrow asset B, swap to asset A, supply again. Amplifies yield AND liquidation risk proportionally.' },
  { term: 'Pendle', definition: 'A DeFi protocol that splits yield-bearing tokens into principal (PT) and yield (YT) components, enabling fixed-rate lending and yield speculation.' },
  { term: 'PT (Principal Token)', definition: 'Pendle\'s principal component of a yield-bearing token. Redeemable 1:1 for the underlying asset at maturity — effectively a fixed-rate bond.' },
  { term: 'YT (Yield Token)', definition: 'Pendle\'s yield component. Receives all yield generated by the underlying until maturity. Decays to zero if rates fall; appreciates if rates rise.' },
  { term: 'Convex Finance', definition: 'A protocol that boosts Curve LP rewards by pooling CRV vote-locking power. The dominant layer on top of Curve for CRV reward optimisation.' },
  { term: 'Yearn Finance', definition: 'The original DeFi yield aggregator. Automatically moves capital between strategies to maximise APY for depositors.' },
  { term: 'Morpho Blue', definition: 'A permissionless lending protocol that allows anyone to create isolated lending markets with custom parameters. More efficient than Aave/Compound for niche pairs.' },
  { term: 'LTV (Loan-to-Value)', definition: 'The ratio of borrowed amount to collateral value. A 75% LTV means you can borrow $75 for every $100 of collateral. Exceeding max LTV triggers liquidation.' },
  { term: 'Real yield', definition: 'Yield sourced from actual protocol revenue (trading fees, interest) rather than newly minted governance token emissions. More sustainable long-term.' },
  { term: 'Reentrancy', definition: 'A smart contract vulnerability where an external contract is called before state is finalised, allowing it to re-enter and drain funds. Source of The DAO hack (2016).' },
  { term: 'Nexus Mutual', definition: 'A decentralised protocol insurance provider. Covers smart contract bugs and exchange hacks. Members vote on claims; pays out in NXM tokens.' },
  { term: 'Tokenised Treasury', definition: 'A blockchain-based token representing ownership of US Treasury bills or bonds. Examples: Ondo OUSG, BlackRock BUIDL, Franklin BENJI.' },
  // RWA terms
  { term: 'Tokenised stock', definition: 'A blockchain token that represents ownership of or exposure to a publicly traded company share. Examples: bCSPX (Backed Finance), Swarm Markets equities.' },
  { term: 'SPV', definition: 'Special Purpose Vehicle — a legal entity created to hold a specific asset (e.g. a property or a share portfolio). RWA tokens typically represent ownership of an SPV.' },
  { term: 'Reg D', definition: 'SEC exemption allowing US companies to raise capital from accredited investors without full registration. Most tokenised security offerings in the US use Reg D.' },
  { term: 'Reg S', definition: 'SEC exemption for securities offerings made outside the United States. Allows non-US investors to buy tokenised securities not registered with the SEC.' },
  { term: 'Backed Finance', definition: 'A Swiss RWA platform issuing bTokens — ERC-20 tokens backed 1:1 by real ETF shares held at a custodian. Examples: bCSPX (S&P 500 ETF), bNVDA (Nvidia).' },
  { term: 'PAXG', definition: 'Paxos Gold — an ERC-20 token where each token represents one troy ounce of gold held in London vaults by Paxos Trust. Redeemable for physical gold.' },
  { term: 'XAUT', definition: 'Tether Gold — a token backed by one troy ounce of gold in Swiss vaults, issued by Tether on Ethereum and Tron.' },
  { term: 'RealT', definition: 'The largest tokenised real estate platform. US rental properties are tokenised as ERC-20 tokens; holders receive daily USDC rental income.' },
  { term: 'Parcl', definition: 'A Solana-based protocol offering synthetic exposure to real estate price indices (price per sqft) in major US cities. Long/short without owning property.' },
  { term: 'BUIDL', definition: 'BlackRock USD Institutional Digital Liquidity Fund — a tokenised US Treasury money market fund on Ethereum. Widely used as high-quality collateral in DeFi.' },
  { term: 'DLT Pilot Regime', definition: 'An EU regulatory sandbox (effective 2023) that allows tokenised securities to be traded and settled on blockchain with relaxed traditional market structure rules.' },
  { term: 'Project Guardian', definition: 'A MAS (Singapore)-led initiative to pilot tokenised bonds, funds, and FX with major institutions including DBS, JPMorgan, Standard Chartered, and T. Rowe Price.' },
  { term: 'T+0 settlement', definition: 'Instant settlement on the day of trade — eliminating the 2-day (T+2) delay in traditional markets. Blockchain enables T+0 or T+minutes settlement.' },
  { term: 'Carbon credit token', definition: 'An on-chain representation of a voluntary carbon offset. Toucan Protocol (BCT/NCT) and KlimaDAO tokenise real-world carbon credits on Polygon.' },
  { term: 'Dinari', definition: 'A US-registered transfer agent issuing dShares — tokenised representations of US-listed equities for eligible non-US investors. Deployed on Base and Arbitrum.' },
  // Fundamentals terms
  // Tokens & Standards deep-dive terms
  { term: 'ERC-2612', definition: 'Permit extension for ERC-20 — sign an off-chain approval, skipping the on-chain approve transaction. Saves gas; used by USDC v2, DAI.' },
  { term: 'SafeERC20', definition: 'OpenZeppelin wrapper for ERC-20 calls that handles non-standard return values and protects against the approve race condition.' },
  { term: 'ERC-721', definition: 'Ethereum NFT standard; each token has a unique tokenId, an owner, and a tokenURI pointing to metadata JSON.' },
  { term: 'ERC-1155', definition: 'Multi-token standard — one contract holds both fungible and non-fungible types; batch transfers are gas-efficient; common in gaming.' },
  { term: 'ERC-2981', definition: 'On-chain royalty standard; royaltyInfo(tokenId, salePrice) returns the royalty recipient and amount; respected voluntarily by marketplaces.' },
  { term: 'ERC-6551', definition: 'Token Bound Accounts — each NFT has a smart contract wallet, enabling NFTs to own assets and sign transactions.' },
  { term: 'ERC-4337', definition: 'Account Abstraction standard; introduces UserOperations processed by Bundlers and the EntryPoint contract; enables programmable smart wallets.' },
  { term: 'UserOperation', definition: 'ERC-4337 pseudo-transaction containing sender, calldata, paymaster, and signature; validated by the smart account logic.' },
  { term: 'Bundler', definition: 'ERC-4337 infrastructure node that collects UserOperations and submits them on-chain via the EntryPoint contract.' },
  { term: 'Paymaster', definition: 'ERC-4337 contract that sponsors gas — users pay in USDC or pay nothing; the paymaster covers ETH gas costs.' },
  { term: 'Session key', definition: 'Pre-approved signing key for a smart account that can execute transactions within defined limits without per-tx confirmation.' },
  { term: 'ERC-6900', definition: 'Modular smart account standard extending ERC-4337; install/uninstall plugin modules for multisig, subscriptions, and session keys.' },
  { term: 'ERC-4626', definition: 'Tokenised vault standard; defines deposit/withdraw/redeem interface so yield vaults are composable across DeFi.' },
  { term: 'Vault shares', definition: 'ERC-4626 tokens received on deposit; appreciate as yield accrues. Share price = totalAssets / totalSupply.' },
  { term: 'ATA', definition: 'Associated Token Account — Solana account holding a specific SPL token for a wallet; a PDA derived from wallet + mint address.' },
  { term: 'Token-2022', definition: 'Solana Token Extensions program; adds transfer fees, confidential transfers, permanent delegate, and transfer hooks to SPL tokens.' },
  { term: 'Mint authority', definition: 'Solana: address authorised to mint new tokens. Revoking mint authority makes supply fixed and increases community trust.' },
  { term: 'Freeze authority', definition: 'Solana: address that can freeze token accounts (used by USDC for compliance). Separate from mint authority.' },
  { term: 'veToken', definition: 'Vote-escrowed token — lock governance tokens for 1-4 years to receive amplified voting power and yield share.' },
  { term: 'WETH', definition: 'Wrapped Ether — ETH wrapped 1:1 as ERC-20 so it can be used in DeFi pools requiring the ERC-20 interface.' },
  { term: 'WBTC', definition: 'Wrapped Bitcoin on Ethereum; custodied by BitGo; 1:1 BTC-backed ERC-20; used as DeFi collateral. Centralisation risk.' },
  { term: 'cbBTC', definition: "Coinbase-issued wrapped Bitcoin on Base/Ethereum; 1:1 BTC-backed; alternative to WBTC." },
  { term: 'tBTC', definition: 'Decentralised wrapped Bitcoin by Threshold Network; no single custodian; backed by distributed node operators staking T tokens.' },
  { term: 'OFT', definition: 'Omnichain Fungible Token (LayerZero) — token standard deployable across chains with unified supply via burn-and-mint, not wrapping.' },
  { term: 'LBP', definition: 'Liquidity Bootstrapping Pool (Balancer) — starts heavily weighted toward a new token, gradually rebalances; discourages bot sniping.' },
  { term: 'IDO', definition: 'Initial DEX Offering — token sale on a decentralised launchpad (Fjord Foundry, Camelot) with immediate DEX liquidity.' },
  { term: 'Points program', definition: 'Off-chain points awarded before a token launch; convert to allocation at TGE. Risk: no guaranteed conversion ratio or timeline.' },
  { term: 'Retroactive airdrop', definition: 'Token distribution to past protocol users; pioneered by Uniswap ($400/address), followed by ARB, OP, JTO, W, and many others.' },
  { term: 'Work token', definition: 'Token staked by service providers to earn the right to do work (e.g. Chainlink node operators); slashed for misbehaviour.' },
  // Infrastructure deep-dive terms
  // Industry & AI terms
  { term: 'x402', definition: 'HTTP 402 "Payment Required" repurposed for machine-to-machine USDC micropayments. An AI agent requests a resource, pays in USDC, and the server fulfils the request — no bank account needed.' },
  { term: 'MCP (Model Context Protocol)', definition: "Anthropic's open standard for connecting AI models to tools and data sources. Circle MCP tools allow AI assistants to send USDC, check balances, and create wallets." },
  { term: 'ERC-8004', definition: 'An EVM standard for registering AI agents with an onchain identity, agent card (name, description, services), and associated wallet address. Basis of the Arc agent marketplace.' },
  { term: 'zkML', definition: 'Zero-Knowledge Machine Learning — using ZK proofs to verify that a specific AI model ran on specific inputs and produced a specific output, without revealing model weights or inputs.' },
  { term: 'EZKL', definition: 'Open-source library for generating ZK proofs of ML model inference. Used by developers building verifiable AI applications.' },
  { term: 'Gensyn', definition: 'Decentralised ML training network using cryptographic proofs to verify compute actually occurred. Solving the verifiable compute problem for AI.' },
  { term: 'io.net', definition: 'GPU cluster marketplace aggregating idle RTX cards for parallelised ML inference. Tokenised as IO.' },
  { term: 'Virtuals Protocol', definition: 'Launchpad for tokenised AI agents on Base. VIRTUAL token. Agents like LUNA and AIXBT launched here with their own tokens.' },
  { term: 'ElizaOS / ai16z', definition: 'The most popular open-source AI agent framework by GitHub stars. Built on Solana. Enables developers to build autonomous AI agents with onchain capabilities.' },
  { term: 'BitLicense', definition: "New York State's crypto business licence, required for any entity operating a virtual currency business serving NY residents. The most stringent US state crypto requirement." },
  { term: 'SPDI', definition: 'Special Purpose Depository Institution — a Wyoming bank charter for crypto-native businesses. Allows crypto companies to hold deposits without FDIC insurance.' },
  { term: 'SAB 121', definition: 'SEC Staff Accounting Bulletin 121 required banks to hold customer crypto on their own balance sheet, making custody economically unfeasible. Reversed in 2025, enabling banks to custody crypto.' },
  { term: 'CASP', definition: 'Crypto Asset Service Provider — MiCA\'s term for any crypto exchange, broker, or custodian operating in the EU. Must be authorised by an EU member state regulator.' },
  { term: 'Bitcoin Standard', definition: "MicroStrategy's strategy of holding Bitcoin as a primary treasury reserve asset. Pioneered by Michael Saylor; widely copied by smaller public companies." },
  { term: 'Coinbase Prime', definition: 'Institutional prime brokerage from Coinbase. Offers custody, OTC trading, lending, and staking for hedge funds, asset managers, and corporations.' },
  { term: 'FIT21', definition: 'Financial Innovation and Technology for the 21st Century Act. Passed the US House in 2024. Clarifies SEC vs CFTC jurisdiction based on whether a blockchain is sufficiently decentralised.' },
  { term: 'Form 8949', definition: 'IRS form for reporting capital gains and losses. Every crypto trade generating a gain or loss must be reported here. Exchanges now issue 1099-DA.' },
  { term: 'Wash sale (crypto)', definition: 'Selling an asset at a loss and repurchasing it within 30 days to claim the tax loss. Currently legal for crypto (unlike stocks); proposed legislation may close this.' },
  { term: 'ASI Alliance', definition: 'Artificial Superintelligence Alliance — merger of Fetch.ai (FET), SingularityNET (AGIX), and Ocean Protocol (OCEAN) into a unified AI token and ecosystem.' },
  { term: 'IBIT', definition: "BlackRock's spot Bitcoin ETF. Launched January 2024; reached $50B+ AUM faster than any ETF in history." },
  // Extended stablecoin terms
  { term: 'Frax', definition: 'Stablecoin protocol by Sam Kazemian. Frax v3 is fully over-collateralised with RWAs, ETH, and USDC. Also issues frxETH liquid staking and runs Fraxlend/Fraxswap.' },
  { term: 'frxETH / sfrxETH', definition: 'Frax liquid staking tokens. frxETH tracks ETH 1:1; sfrxETH earns all Frax ETH staking yield — one of the highest-yield LSTs.' },
  { term: 'USDe (Ethena)', definition: 'Delta-neutral synthetic dollar: ETH deposits hedged with short ETH perps. sUSDe earns perpetual funding rates. Not algorithmic — funded by real hedge positions.' },
  { term: 'sUSDe', definition: 'Staked USDe from Ethena. Earns ETH perpetual funding rates — historically 10–25% APY but variable; can go to zero or negative in bear markets.' },
  { term: 'ENA', definition: 'Governance token of Ethena protocol. Stakers participate in protocol governance and can receive revenue share.' },
  { term: 'PYUSD', definition: 'PayPal USD — fiat-backed stablecoin issued by Paxos on behalf of PayPal. On Ethereum and Solana. Targets PayPal\'s 430M+ user base.' },
  { term: 'FDUSD', definition: 'First Digital USD — Hong Kong-issued stablecoin. Rose to $4B+ supply as a Binance BUSD replacement. BDO-attested; mainly on BNB Chain and Ethereum.' },
  { term: 'GHO', definition: "Aave's native stablecoin. Minted against Aave collateral. stkAAVE holders get a borrow rate discount. Revenue goes to Aave DAO treasury." },
  { term: 'LUSD', definition: 'Liquity v1 stablecoin. Immutable, governance-free; ETH-only collateral; 110% minimum collateral ratio. Most decentralised fiat-pegged stablecoin.' },
  { term: 'BOLD', definition: 'Liquity v2 stablecoin. Multi-collateral (ETH + LSTs); user-set interest rates; earns yield via the Stability Pool.' },
  { term: 'Bridge (stablecoin company)', definition: 'Stablecoin infrastructure API company acquired by Stripe for $1.1B in 2024. Enables developers to issue, store, and transfer stablecoins programmatically.' },
  { term: 'Paxos', definition: 'Regulated blockchain infrastructure company. Issues PYUSD (for PayPal), PAXG (tokenised gold), and previously BUSD (for Binance, ordered to halt minting 2023).' },
  { term: 'Black Thursday', definition: 'March 12–13, 2020. ETH fell 50% in hours. Ethereum network congestion caused MakerDAO liquidation auctions to clear at $0. Created $8M in bad debt, later covered by MKR dilution.' },
  { term: 'e-CNY', definition: "China's digital yuan CBDC. Most advanced CBDC globally — 260M+ wallets, retail use cases, NFC offline payments, programmable expiry dates on issued funds." },
  { term: 'mBridge', definition: 'Multi-CBDC platform for cross-border settlement between China, UAE, Thailand, and Hong Kong. Built on a permissioned distributed ledger.' },
  { term: 'Drex', definition: "Brazil's wholesale CBDC. Built on a permissioned blockchain; designed for DeFi-like programmable settlement between financial institutions." },
  // Governance terms
  { term: 'Governor contract', definition: 'A smart contract that manages the full proposal lifecycle (creation, voting, timelock, execution). OpenZeppelin Governor and Compound Governor Bravo are the most used implementations.' },
  { term: 'Timelock', definition: 'A mandatory delay between a governance vote passing and the change being executed onchain. Gives token holders time to exit if they disagree with the outcome.' },
  { term: 'Snapshot (governance)', definition: 'The leading off-chain gasless voting platform. Token holders sign votes with their wallet; no gas cost. Results are not automatically executed onchain.' },
  { term: 'Tally', definition: 'Governance analytics and voting platform for onchain Governor contracts. Shows delegate rankings, proposal history, and live vote state.' },
  { term: 'Quorum', definition: 'The minimum percentage of token supply that must vote for a governance proposal to be valid. Too high blocks governance; too low enables small-group capture.' },
  { term: 'Delegation', definition: 'Assigning your governance votes to another address. Allows passive holders to have their votes counted by active, informed delegates without transferring tokens.' },
  { term: 'Quadratic voting', definition: 'A voting system where the cost of N votes is N² tokens, reducing the dominance of large holders. Vulnerable to Sybil attacks if addresses are not uniquely identified.' },
  { term: 'Conviction voting', definition: 'Voting weight grows the longer you hold a position. Rewards patient, committed participants. Used by Gardens Protocol (1Hive).' },
  { term: 'Wyoming DAO LLC', definition: 'The first US state legal structure recognising DAOs as limited liability companies (2021). Provides personal liability protection for DAO members.' },
  { term: 'Sub-DAO', definition: 'An autonomous child organisation within a larger DAO. The parent DAO funds it and retains veto; the sub-DAO operates with its own mandate and governance.' },
  { term: 'Working group', definition: 'A bounded team within a DAO with a specific mandate (grants, engineering, treasury). Funded by governance vote; operates semi-independently.' },
  { term: 'RetroPGF', definition: "Optimism's Retroactive Public Goods Funding program. Citizens House distributes USDC/OP to open-source builders for value already delivered to the ecosystem." },
  { term: 'Superfluid (streaming)', definition: 'A protocol for real-time token streams. DAOs pay contributors by the second rather than monthly. Used widely for DAO contributor salaries.' },
  { term: 'Coordinape', definition: 'Peer-to-peer DAO compensation tool. Team members allocate GIVE tokens to colleagues; allocations convert to token rewards. Removes manager subjectivity.' },
  { term: 'DeepDAO', definition: 'DAO analytics platform tracking treasury size, active members, proposal volume, and governance health across 13,000+ DAOs.' },
  { term: 'Security Council (DAO)', definition: 'A multi-sig of elected trusted individuals with power to bypass the governance timelock in emergencies. Used by Arbitrum, Optimism, Compound.' },
  { term: 'Flash loan governance attack', definition: 'Borrow governance tokens, vote on a malicious proposal, repay — all in one transaction. Beanstalk Protocol lost $182M to this attack in 2022.' },
  { term: 'Beanstalk', definition: 'DeFi protocol that lost $182M in April 2022 to a flash loan governance attack. The attacker borrowed enough BEAN governance tokens to pass a malicious proposal stealing the treasury.' },
  { term: 'Karpatkey', definition: 'A DAO-native treasury management organisation managing the investment strategies of Gnosis, Balancer, ENS, CoW Protocol, and others.' },
  // Security & Wallets terms
  { term: 'Hardware wallet', definition: 'A dedicated signing device that stores private keys offline. The key never leaves the device. Ledger, Trezor, Coldcard, Foundation Passport are popular options.' },
  { term: 'Secure element', definition: 'A tamper-resistant chip (CC EAL5+) inside Ledger devices that stores the private key. Cannot be extracted even with physical access.' },
  { term: 'Seed phrase backup (metal)', definition: 'Stamping BIP-39 seed words onto a stainless steel plate (Cryptosteel, Bilodeau) for fire- and water-resistant long-term storage.' },
  { term: 'Passphrase (25th word)', definition: 'Optional BIP-39 extension; appended to a seed phrase to create a completely separate wallet set. Store separately from the 24 words.' },
  { term: 'Shamir Secret Sharing', definition: 'Mathematical scheme to split a secret into N shares where any M shares reconstruct it. Used to distribute seed phrase backups with no single point of failure.' },
  { term: 'Revoke.cash', definition: 'Free tool to audit and revoke ERC-20 allowances and NFT approvals. Recommended monthly use for any active DeFi wallet.' },
  { term: 'Permit2', definition: 'Uniswap protocol for gasless ERC-20 approvals via signed messages. Legitimate tool but weaponised by drainer contracts — a blind Permit2 signature can drain tokens.' },
  { term: 'Drainer contract', definition: 'A malicious smart contract that, upon receiving your signature (Permit, Permit2, setApprovalForAll), immediately transfers all approved assets to the attacker.' },
  { term: 'Blind signing', definition: 'Signing a transaction where the wallet shows only a hex blob with no decoded data. Extremely dangerous — Ledger and Trezor now warn and can block blind signing.' },
  { term: 'Rabby Wallet', definition: 'Browser extension wallet with built-in transaction simulation, approval management, and address book. Preferred by security-conscious DeFi users over MetaMask.' },
  { term: 'Reentrancy', definition: 'Smart contract attack where a malicious contract re-enters a victim function before state updates. Exploited in The DAO hack ($60M, 2016). Fixed with ReentrancyGuard.' },
  { term: 'OPSEC', definition: 'Operational Security — practices to protect sensitive information. In crypto: wallet architecture, digital hygiene, physical security, and information minimisation.' },
  { term: 'Cold vault wallet', definition: 'A hardware wallet used exclusively for long-term storage; never connected to dApps; receives funds but rarely sends. The highest security tier.' },
  { term: 'Burner wallet', definition: 'A fresh wallet created for a single interaction (mint, airdrop, new dApp) and discarded after. Zero approval surface; contains minimal funds.' },
  { term: 'Social recovery wallet', definition: 'ERC-4337 smart account where guardians (trusted friends, institutions) can replace the signing key if lost. No seed phrase required.' },
  { term: 'Flashbots Protect', definition: 'Private mempool RPC endpoint. Transactions submitted here bypass the public mempool, preventing sandwich attacks and allowing compromised-wallet asset rescue.' },
  { term: 'Chainalysis', definition: 'The dominant blockchain analytics firm. Used by exchanges, banks, and law enforcement to trace stolen funds and screen for sanctions exposure.' },
  { term: 'Arkham Intelligence', definition: 'Public blockchain intelligence platform with entity deanonymisation and wallet labelling. ARKM token. Controversial for its "deanonymisation bounty" model.' },
  { term: 'Bubblemaps', definition: 'Free visual wallet clustering tool. Shows token holder connections graphically. Popular for meme coin rug pull investigation and NFT wash trading detection.' },
  { term: '$5 wrench attack', definition: 'Physical coercion to hand over crypto keys. The joke: no amount of cryptographic security protects against someone threatening you with a wrench. Mitigated by multi-sig + duress wallets.' },
  { term: 'Clipboard hijacking', definition: 'Malware that silently replaces copied wallet addresses with the attacker\'s address. Always verify the destination address character by character after pasting.' },
  { term: 'Checks-effects-interactions', definition: 'Solidity pattern: update all state (effects) before making external calls (interactions). Prevents reentrancy attacks.' },
  { term: 'The Merge', definition: "Ethereum's transition from Proof of Work to Proof of Stake on September 15, 2022. Energy dropped 99.95%; issuance dropped ~90%." },
  { term: 'EIP-1559', definition: 'Ethereum fee reform (Aug 2021) introducing a burned base fee + optional priority tip. Made fees predictable and ETH deflationary during high activity.' },
  { term: 'EIP-4844 (Proto-Danksharding)', definition: 'Ethereum upgrade (March 2024) adding blob transactions — temporary data storage that reduced L2 fees by 90%+.' },
  { term: 'Execution layer', definition: "Ethereum's transaction-processing layer. Clients: Geth, Nethermind, Besu, Reth." },
  { term: 'Consensus layer', definition: "Ethereum's validator and finality layer. Clients: Prysm, Lighthouse, Teku, Nimbus." },
  { term: 'UTXO', definition: 'Unspent Transaction Output — Bitcoin\'s accounting model. Each "coin" is a discrete locked output; spending consumes UTXOs and creates new ones.' },
  { term: 'Taproot', definition: 'Bitcoin upgrade (Nov 2021) enabling Schnorr signatures and MAST scripts. Enables Ordinals inscriptions; improves privacy and multi-sig efficiency.' },
  { term: 'Lightning Network', definition: 'Bitcoin L2 payment channel network. Instant, near-zero fee payments routed through a network of bidirectional channels. Used by Strike, Cash App.' },
  { term: 'ZK-SNARK', definition: 'Succinct Non-interactive ARgument of Knowledge. Small, fast-to-verify ZK proof. Requires trusted setup. Used by zkSync, Aztec, Zcash.' },
  { term: 'ZK-STARK', definition: 'Scalable Transparent ARgument of Knowledge. No trusted setup; post-quantum secure; larger proofs. Used by StarkNet, Polygon Miden.' },
  { term: 'Appchain', definition: 'A blockchain built for a single application — custom execution, gas token, and governance. Examples: dYdX v4, Hyperliquid, Ronin, ApeChain.' },
  { term: 'Cosmos SDK', definition: 'Framework for building sovereign appchains that connect via IBC. Used by dYdX, Osmosis, Celestia, Injective.' },
  { term: 'OP Stack', definition: "Optimism's open-source L2 framework. Base, Worldchain, Zora, Mode are all built on OP Stack. Forms the Superchain." },
  { term: 'Arbitrum Orbit', definition: 'L3 framework built on Arbitrum L2. ApeChain, Xai, Degen Chain are Orbit chains.' },
  { term: 'Celestia', definition: 'Modular DA (Data Availability) layer. Rollups post data to Celestia instead of Ethereum for lower costs. TIA token.' },
  { term: 'EigenDA', definition: 'EigenLayer restaking-backed Data Availability layer. Used by Mantle, Celo migration.' },
  { term: 'Blob (EIP-4844)', definition: 'Temporary data attachment to an Ethereum block. 18-day retention. Rollups use blobs instead of calldata for 90%+ cheaper DA.' },
  { term: 'Danksharding', definition: 'Full Ethereum DA roadmap: 64+ blobs per block via Data Availability Sampling (DAS). Blobs expand from current ~6 to 64+.' },
  { term: 'The Graph', definition: 'Decentralised indexing protocol. Subgraphs index smart contract events; GRT token incentivises indexers and curators.' },
  { term: 'Alchemy', definition: 'The most popular managed node RPC provider. Enhanced APIs for NFT/token data. Supports Ethereum, Base, Arbitrum, Polygon, and more.' },
  { term: 'LayerZero', definition: 'Cross-chain messaging protocol. Uses DVN (Decentralised Verifier Networks). OFT token standard for omnichain tokens. ZRO token.' },
  { term: 'CCIP', definition: "Chainlink Cross-Chain Interoperability Protocol. Enterprise messaging + token transfer. Used by SWIFT CBDC pilot, Synthetix." },
  { term: 'IBC', definition: 'Inter-Blockchain Communication — Cosmos native cross-chain protocol. Trust-minimised light client verification. Connects 100+ Cosmos chains.' },
  { term: 'Aztec', definition: 'ZK rollup with programmable privacy. Enables private DeFi — private token transfers and private contract interactions on Ethereum.' },
  { term: 'TEE', definition: 'Trusted Execution Environment — hardware secure enclave (Intel SGX, AMD SEV) for confidential smart contract execution. Used by Secret Network, Oasis.' },
  { term: 'FHE', definition: 'Fully Homomorphic Encryption — compute on encrypted data without decrypting. Fhenix, Zama fhEVM. Still computationally expensive.' },
  { term: 'MPC (Multi-Party Computation)', definition: 'Split a private key across multiple parties so no single party holds it. Used by Fireblocks, Circle, Coinbase Wallet.' },
  { term: 'Superchain', definition: "Optimism's vision of OP Stack chains (Base, Worldchain, Zora, Mode) sharing a sequencer and bridge for unified liquidity." },
  { term: 'Pyth Network', definition: 'Pull-based oracle providing first-party price data from trading firms. Ultra-low latency (~400ms). Dominant on Solana. PYTH token.' },
  { term: 'Hyperliquid', definition: 'Custom L1 with onchain order book; captured ~70% of onchain perp volume in 2025–2026. HYPE token used for gas and staking.' },
  { term: 'Proof of Work', definition: 'A consensus mechanism where miners compete to solve a cryptographic puzzle. Winner adds the next block and earns a reward. Used by Bitcoin. Energy-intensive but maximally decentralised.' },
  { term: 'Proof of Stake', definition: 'A consensus mechanism where validators lock up tokens as collateral to earn block-proposal rights. Used by Ethereum (post-Merge), Solana, Cardano. 99.9% more energy-efficient than PoW.' },
  { term: 'Slashing', definition: 'The penalty for dishonest or negligent validator behaviour in Proof of Stake. A portion of the staked collateral is destroyed. Aligns validator incentives with network health.' },
  { term: 'Mempool', definition: 'Memory pool — the holding area for broadcast but unconfirmed transactions. Validators/miners pick from the mempool to fill the next block, usually by fee.' },
  { term: 'Nonce', definition: 'In transactions: a sequential counter per address preventing replay attacks. In mining: a value miners iterate through to find a valid block hash.' },
  { term: 'Merkle tree', definition: 'A binary hash tree where each leaf is a data hash and each node is the hash of its children. Enables efficient Merkle proofs — proving data is in a set without downloading all of it.' },
  { term: 'ECDSA', definition: 'Elliptic Curve Digital Signature Algorithm — the cryptographic scheme used by Bitcoin and Ethereum. Signs transactions with a private key; anyone can verify with the public key.' },
  { term: 'BIP-39', definition: 'Bitcoin Improvement Proposal 39 — the standard for generating a human-readable seed phrase (12 or 24 words) from entropy. Used by MetaMask, Ledger, and virtually every non-custodial wallet.' },
  { term: 'BIP-32', definition: 'HD (Hierarchical Deterministic) wallet standard. Derives a tree of child keys from a master seed, so one seed phrase controls unlimited accounts on unlimited chains.' },
  { term: 'EIP-1559', definition: 'Ethereum Improvement Proposal 1559 — introduced a burned base fee and optional priority tip. Made gas fees more predictable and made ETH deflationary under high usage.' },
  { term: 'EIP-4844', definition: 'Proto-Danksharding — introduces "blob" transactions for L2 data posting. Reduced L2 fees ~10x by replacing expensive calldata with cheaper ephemeral blobs.' },
  { term: 'UTXO', definition: 'Unspent Transaction Output — Bitcoin\'s accounting model. Each transaction consumes previous UTXOs and creates new ones. More private but harder to program than the account model.' },
  { term: 'Nakamoto coefficient', definition: 'The minimum number of entities that must collude to compromise a blockchain network. Higher = more decentralised. Bitcoin ~3–5 mining pools; Ethereum ~4 staking entities.' },
  { term: 'Web3', definition: 'The vision of a user-owned internet built on blockchain. Users control their identity (wallet), data, and assets via cryptographic keys — without relying on platform companies.' },
  { term: 'Finality', definition: 'The point at which a transaction is considered irreversible. Bitcoin: ~6 confirmations (~60 min). Ethereum PoS: 2 epochs (~12 min). BFT chains (Cosmos): instant. Arc: sub-second.' },
]

// ── Suggested questions ────────────────────────────────────────────────────
const SUGGESTED_QUESTIONS = [
  { label: 'Bitcoin basics', question: 'What is Bitcoin?' },
  { label: 'USDC stablecoin', question: 'How does USDC work?' },
  { label: 'DeFi explained', question: 'What is DeFi?' },
  { label: 'Staking rewards', question: 'How does crypto staking work?' },
  { label: 'Layer 2 networks', question: 'What are Layer 2 networks?' },
  { label: 'Crypto wallets', question: 'What types of crypto wallets exist?' },
]

// ── Response engine ────────────────────────────────────────────────────────
function generateResponse(userQuery: string): string {
  const q = userQuery.toLowerCase()

  if (/^(hi|hello|hey|greetings|howdy|sup|yo)\b/.test(q.trim())) {
    return `Hello! I'm CryptoAdvisor — your crypto knowledge assistant.\n\nI can explain Bitcoin, Ethereum, DeFi, NFTs, wallets, gas fees, staking, Layer 2s, and much more. Browse topics in the **Topics** panel, or just ask me anything.`
  }

  if (/\b(thank(s| you)|cheers|great|awesome|perfect|helpful)\b/.test(q)) {
    return `You're welcome! Feel free to ask anything else. You can also browse topics in the Topics panel or search the Glossary for quick definitions.`
  }

  if (/\b(price|worth|value|cost|how much)\b/.test(q) && /\b(btc|bitcoin|eth|ethereum|sol|solana|usdc|bnb|xrp|avax|dot)\b/.test(q)) {
    return `I don't have access to live market prices.\n\n**For real-time data:**\n- **CoinGecko** — coingecko.com\n- **CoinMarketCap** — coinmarketcap.com\n- **TradingView** — tradingview.com\n- **DefiLlama** — defillama.com (DeFi TVL)\n\nI specialize in explaining how cryptocurrencies and blockchain technology work.`
  }

  if (/\b(should i (buy|sell|invest|trade)|good investment|recommend|financial advice|portfolio)\b/.test(q)) {
    return `I'm not able to provide investment or financial advice. Cryptocurrency markets are highly volatile and speculative.\n\nFor guidance, consult a licensed financial advisor. I can explain how any specific cryptocurrency, protocol, or concept works — just ask!`
  }

  const topicMap: Array<[RegExp, string]> = [
    [/\b(consensus mechanism|proof.of.work|proof.of.stake|delegated pos|proof.of.history|bft consensus|validator consensus|how blockchain agrees)\b/, 'fund_consensus'],
    [/\b(hash function|sha.256|keccak|ecdsa|public key crypto|private key crypto|asymmetric crypto|merkle tree|zero.knowledge proof|digital signature crypto)\b/, 'fund_cryptography'],
    [/\b(hd wallet|bip.39|bip.32|bip.44|seed phrase derivation|address derivation|how wallet works|key hierarchy|wallet vs key)\b/, 'fund_wallets_keys'],
    [/\b(how transaction works|transaction lifecycle|mempool|broadcast transaction|tx confirmation|nonce transaction|utxo model|account model|tx finality)\b/, 'fund_transactions'],
    [/\b(smart contract deep|contract anatomy|deploy contract|bytecode evm|contract storage|proxy pattern|upgradeable contract|delegatecall)\b/, 'fund_smart_contracts_deep'],
    [/\b(token standard|erc.20 standard|erc.721 standard|erc.1155|erc.4626|erc.2612|spl token|token interface|token standard comparison)\b/, 'fund_token_standards'],
    [/\b(erc.?20 deep|erc20 interface|transfer from|approve race|safeERC20|erc20 permit|erc2612|token decimals|erc20 function)\b/, 'std_erc20_deep'],
    [/\b(erc.?721|erc.?1155|nft standard|tokenuri|ownerof|erc2981|erc6551|token bound|royalty standard|multi.token standard)\b/, 'std_nft_standards'],
    [/\b(account abstraction|erc.?4337|useroperation|bundler|paymaster|session key|smart wallet|erc.?6900|modular wallet|social recovery)\b/, 'std_account_abstraction'],
    [/\b(erc.?4626|vault token|yield vault|vault shares|deposit withdraw redeem|totalassets|shard price vault|tokenised vault)\b/, 'std_vault_tokens'],
    [/\b(solana token standard|spl token|token.2022|token extension|associated token account|ata solana|mint authority|freeze authority|metaplex token)\b/, 'std_solana_tokens'],
    [/\b(governance token|dao vote|token voting|delegation|quadratic voting|vetoken|ve crv|uni governance|aave governance|arb governance)\b/, 'std_governance_tokens'],
    [/\b(utility token|gas token|fee discount token|work token|access token|link utility|fil utility|grt utility|rndr utility)\b/, 'std_utility_tokens'],
    [/\b(wrapped token|weth|wbtc|cBTC|tbtc|wrapped btc|wrapped eth|liquid staking token|steth|cbeth|msol|oft token)\b/, 'std_wrapped_tokens'],
    [/\b(token launch|ido|ico|ieo|lbp|airdrop mechanism|fair launch|presale|token distribution|retroactive airdrop|points program|tge)\b/, 'std_token_launches'],
    [/\b(ethereum deep|ethereum architecture|the merge|eip.1559|eip.4844|blob|ethereum roadmap|ethereum validator|execution layer|consensus layer|geth|nethermind|prysm|lighthouse)\b/, 'infra_ethereum_deep'],
    [/\b(bitcoin network|utxo|bitcoin script|taproot|p2pkh|p2tr|bitcoin node|bitcoin mining difficulty|lightning network|htlc|bitcoin full node)\b/, 'infra_bitcoin_network'],
    [/\b(zk.snark|zk.stark|zero.knowledge proof|zk proof|zkvm|zk coprocessor|fhe ethereum|aztec network|zk identity|zkml|trusted setup|groth16|plonk)\b/, 'infra_zk_tech'],
    [/\b(appchain|application.specific chain|cosmos sdk|polkadot parachain|avalanche subnet|orbit chain|op stack chain|polygon cdk|zk stack|dydx chain|injective chain)\b/, 'infra_appchains'],
    [/\b(data availability|celestia|eigenda|avail da|near da|blob da|danksharding|modular blockchain|data availability sampling)\b/, 'infra_data_availability'],
    [/\b(run a node|rpc provider|alchemy|infura|quicknode|ankr rpc|the graph subgraph|dune analytics|archive node|full node|light node|etherscan api|indexer)\b/, 'infra_node_rpc'],
    [/\b(cross.chain message|ccip|layerzero|wormhole|axelar|hyperlane|ibc cosmos|omnichain|ntt token|dvn verifier|cross.chain governance)\b/, 'infra_cross_chain_messaging'],
    [/\b(chainlink deep|pyth network|chainlink vrf|chainlink automation|chainlink functions|data streams chainlink|pyth confidence|first.party oracle|twap oracle|oracle deep)\b/, 'infra_chainlink_pyth'],
    [/\b(evm ecosystem|superchain|arbitrum ecosystem|bnb chain|polygon pos|sonic chain|linea|scroll chain|evm landscape|all evm chains|base ecosystem|op stack ecosystem)\b/, 'infra_evm_deep'],
    [/\b(private compute|fhe|fully homomorphic|tee blockchain|secret network|oasis network|railgun|aztec privacy|zk identity|mpc key|confidential contract)\b/, 'infra_private_compute'],
    [/\b(blockchain scaling|trilemma|optimistic rollup|zk rollup|state channel|lightning network|danksharding|eip.4844|blob transaction|l2 scaling|scaling solution)\b/, 'fund_scaling'],
    [/\b(51.percent attack|network attack|sybil attack|eclipse attack|long range attack|nakamoto coefficient|blockchain security|double spend)\b/, 'fund_network_security'],
    [/\b(web3|web 3\.0|decentralised web|user owned internet|on.chain identity|farcaster|lens protocol|crypto internet)\b/, 'fund_web3'],
    [/\b(crypto history|bitcoin history|satoshi nakamoto|genesis block|mt\.?gox|defi summer|nft mania|luna collapse|ftx collapse|bitcoin etf history|crypto timeline)\b/, 'fund_crypto_history'],
    [/\b(bitcoin|btc|satoshi|nakamoto)\b/, 'bitcoin'],
    [/\b(ethereum|eth|vitalik|erc.?20|erc.?721|the merge)\b/, 'ethereum'],
    [/\b(usdc|usd coin|circle stablecoin)\b/, 'usdc'],
    [/\b(stablecoin)\b/, 'usdc'],
    [/\b(defi|decentralized finance|lending protocol|borrowing protocol)\b/, 'defi'],
    [/\b(usdc deep|usdc reserve|usdc backing|usdc attestation|usdc regulation|cctp usdc|circle usdc|usdc trust)\b/, 'stable_usdc_deep'],
    [/\b(usdt|tether stablecoin|tether reserve|tether hack|tether risk|tron usdt|tether vs usdc)\b/, 'stable_usdt'],
    [/\b(dai stablecoin|makerdao|sky protocol|usds stablecoin|mkr token|cdp maker|psm maker|vault maker|dai depeg)\b/, 'stable_dai_sky'],
    [/\b(algorithmic stablecoin|ust collapse|luna crash|terra collapse|algo stable|iron finance|basis cash|ampl stable)\b/, 'stable_algo'],
    [/\b(yield.bearing stable|susde|susds|ausdc|ousd|stusdt|ethena usde|yield stablecoin|interest.bearing stable)\b/, 'stable_yield'],
    [/\b(stablecoin law|stablecoin regulation|genius act|mica stablecoin|emt stablecoin|stablecoin bill|stablecoin compliance)\b/, 'stable_regulation'],
    [/\b(stablecoin payment|stablecoin remit|usdc payment|swift alternative|stablecoin rail|stripe usdc|visa usdc|paypal usdc)\b/, 'stable_payments'],
    [/\b(frax|frxeth|sfrxeth|ethena|usde|susde|ena token|delta.neutral stable|frax protocol|ethena protocol)\b/, 'stable_frax_ethena'],
    [/\b(pyusd|paypal usd|fdusd|first digital|gho aave|lusd liquity|bold liquity|paxos stablecoin|emerging stablecoin|new stablecoin)\b/, 'stable_pyusd_others'],
    [/\b(stablecoin chain|usdc on base|usdc on solana|usdc on arbitrum|tron usdt|multi.chain stable|stablecoin landscape|cctp chain)\b/, 'stable_multichain'],
    [/\b(stablecoin yield|earn on usdc|stable yield strategy|aave usdc yield|curve usdc|susds yield|susde yield|t.bill yield|rwa yield)\b/, 'stable_yield_strategies'],
    [/\b(stripe stablecoin|paypal usdc|visa usdc|mastercard stable|enterprise stablecoin|b2b stablecoin|corporate treasury stable|jpmorgan coin|jpm coin)\b/, 'stable_enterprise'],
    [/\b(stablecoin risk|stablecoin safety|counterparty risk stable|depeg risk|issuer risk|stable reserve risk|stablecoin checklist)\b/, 'stable_risks'],
    [/\b(cbdc vs stablecoin|cbdc comparison|ecny|digital yuan|digital euro|cbdc privacy|programmable money|mbridge|drex cbdc|fedcoin)\b/, 'stable_cbdc_comparison'],
    [/\b(depeg|de.peg|stablecoin depeg|usdc depeg|svb usdc|usdc svb|stablecoin crash|peg break|peg failure)\b/, 'stable_depegs'],
    [/\b(stablecoin type|usdt|tether|dai stablecoin|algorithmic stable|ust luna|yield.bearing stable|types of stable)\b/, 'stablecoins'],
    [/\b(bridge|cross.chain|wormhole bridge|layerzero|stargate bridge|hop protocol|across protocol|lock.and.mint|wrapped token|wbtc)\b/, 'bridges'],
    [/\b(on.chain analysis|mvrv|sopr|exchange flow|netflow|glassnode|nansen market|cryptoquant|whale wallet|exchange netflow|realised cap|nvt ratio)\b/, 'mkt_onchain_analysis'],
    [/\b(technical analysis|ta crypto|chart pattern|rsi crypto|macd crypto|bollinger band|moving average|support resistance|fibonacci|wyckoff|death cross|golden cross)\b/, 'mkt_technical_analysis'],
    [/\b(crypto cycle|halving cycle|bull market cycle|bear market crypto|market cycle|4 year cycle|macro crypto|btc dominance|alt season|accumulation phase)\b/, 'mkt_cycles_macro'],
    [/\b(crypto futures|perpetual futures|quarterly futures|open interest|cme futures|futures leverage|long squeeze|futures funding|futures basis|perp funding)\b/, 'mkt_futures_deep'],
    [/\b(crypto options|call option|put option|option greeks|implied volatility|dvol|deribit|options strategy|straddle option|iron condor|theta decay|option premium)\b/, 'mkt_options_deep'],
    [/\b(market maker|market making|liquidity provider|bid ask spread|wintermute|gsr market|jump trading|slippage market|hlp hyperliquid)\b/, 'mkt_market_making'],
    [/\b(funding rate|basis trade|cash and carry|carry trade crypto|ethena basis|contango|backwardation|perp arbitrage|funding arbitrage)\b/, 'mkt_funding_basis'],
    [/\b(on.chain tool|debank|zapper portfolio|zerion|token terminal|dune analytics|flipside|coinglass|tradingview crypto|kaiko|messari|the block data)\b/, 'mkt_onchain_data_tools'],
    [/\b(portfolio management|crypto portfolio|position sizing|kelly criterion|core satellite|drawdown limit|rebalancing crypto|portfolio risk|portfolio strategy)\b/, 'mkt_portfolio_management'],
    [/\b(cctp deep|cctp v2|cctp fast|tokenmessenger|fast transfer cctp|depositforburn|circle bridge deep)\b/, 'bridge_cctp_deep'],
    [/\b(layerzero deep|layerzero dvn|layerzero oft|ultra light node|layerzero executor|zro token|omnichain)\b/, 'bridge_layerzero_deep'],
    [/\b(wormhole deep|wormhole guardian|vaa|wormhole ntt|native token transfer|wormhole hack|w token wormhole)\b/, 'bridge_wormhole_deep'],
    [/\b(ibc cosmos|cosmos bridge|cosmos hub|atom staking|interchain security|ibc protocol|osmosis|neutron|cosmos sdk chain)\b/, 'bridge_ibc_cosmos'],
    [/\b(polkadot|parachain|relay chain|xcm|dot token|parathread|coretime|agile coretime|kusama|moonbeam|acala)\b/, 'bridge_polkadot'],
    [/\b(intent bridge|intent.based bridge|solver bridge|erc.7683|across intent|uniswapx bridge|relay protocol|chain abstraction bridge)\b/, 'bridge_intent'],
    [/\b(bridge hack|bridge exploit|bridge security|nomad hack|harmony bridge|poly network hack|bridge history|bridge safety)\b/, 'bridge_hacks'],
    [/\b(chain abstraction|universal account|particle network|near chain abstraction|chain signatures|abstracting chains|agoric orchestration)\b/, 'bridge_chain_abstraction'],
    [/\b(dao mechanics|dao lifecycle|dao proposal|governor contract|timelock delay|on.chain vote|off.chain vote|dao bootstrap|dao formation)\b/, 'gov_dao_mechanics'],
    [/\b(voting system|snapshot vote|tally governance|quadratic voting|conviction voting|delegated vote|bicameral governance|token.weighted vote)\b/, 'gov_voting_systems'],
    [/\b(dao tooling|gnosis safe dao|llama finance|superfluid stream|sablier vest|coordinape|dework bounty|charmverse|deepdao|enzyme finance)\b/, 'gov_tooling'],
    [/\b(uniswap dao|makerdao governance|arbitrum dao|optimism governance|ens dao|nouns dao|compound dao|aave governance|major dao)\b/, 'gov_major_daos'],
    [/\b(governance attack|flash loan governance|beanstalk hack|low quorum attack|governance takeover|proposal spam|malicious upgrade|governance exploit)\b/, 'gov_attacks'],
    [/\b(dao legal|wyoming dao|dao llc|dao foundation|dao liability|dao cayman|unincorporated dao|lao model|dao tax|dao regulation)\b/, 'gov_legal'],
    [/\b(sub.dao|working group|contributor model|retropgf|retroactive funding|dao contributor|dao payroll|dao delegate|karpatkey)\b/, 'gov_contributor_model'],
    [/\b(governance case study|compound governance bug|uniswap fee switch|arbitrum aip.1|optimism retropgf|makerdao endgame|governance history|protocol governance example)\b/, 'gov_case_studies'],
    [/\b(hardware wallet|ledger|trezor|coldcard|foundation passport|cold storage wallet|signing device|secure element)\b/, 'sec_hardware_wallets'],
    [/\b(seed phrase|private key|bip.39|bip.32|12 words|24 words|mnemonic|key management|metal backup|cryptosteel|shamir|passphrase 25th)\b/, 'sec_seed_keys'],
    [/\b(defi security|approval risk|revoke approvals|permit2|transaction simulation|rabby wallet|pocket universe|contract risk|immunefi)\b/, 'sec_defi_security'],
    [/\b(smart contract attack|reentrancy|oracle manipulation exploit|access control hack|integer overflow|flash loan attack|signature replay|largest hack|protocol exploit)\b/, 'sec_attack_patterns'],
    [/\b(crypto opsec|wallet architecture|hot wallet|cold vault|burner wallet|digital hygiene|clipboard hijack|wrench attack|dedicated device|vpn crypto)\b/, 'sec_opsec'],
    [/\b(lost seed phrase|recover wallet|wallet recovery|compromised wallet|flashbots rescue|social recovery guardian|lost hardware wallet)\b/, 'sec_wallet_recovery'],
    [/\b(phishing crypto|fake website|malicious nft|discord hack|fake support|drainer contract|blind signing|permit drain|setapprovalforall scam)\b/, 'sec_phishing'],
    [/\b(blockchain forensics|onchain analytics|chainalysis|elliptic|trm labs|arkham intel|nansen wallet|breadcrumbs|fund tracing|wallet clustering)\b/, 'sec_onchain_forensics'],
    [/\b(crypto hack|phishing|approval scam|drainer|sim swap|wallet security|private key security|revoke\.cash|safe wallet|staying safe)\b/, 'crypto_security'],
    [/\b(tokenomics|token supply|emission|vesting schedule|token distribution|deflationary token|inflationary token|burn mechanic)\b/, 'tokenomics'],
    [/\b(ai agent payment|x402|mcp circle|erc.8004|agent wallet|agent economy|autonomous payment|agent marketplace|per.call payment)\b/, 'ind_ai_agents'],
    [/\b(decentralised compute|bittensor subnet|akash gpu|io\.net|gensyn|render network compute|hyperbolic ai|filecoin ai|decentralised ai)\b/, 'ind_decentral_ai'],
    [/\b(verifiable ai|zkml|zk inference|ezkl|opml|ai oracle|proof of inference|modulus labs|giza tech|risc zero ai)\b/, 'ind_verifiable_ai'],
    [/\b(ai token|tao token|rndr token|akt akash|virtuals protocol|elizaos|ai16z|zerebro|asi alliance|fetch\.ai|agix|near ai|icp ai)\b/, 'ind_ai_tokens'],
    [/\b(us crypto regulation|sec crypto|cftc crypto|howey test|fit21|sab 121|bitlicense|bitcoin etf sec|coinbase lawsuit|binance doj|spdi)\b/, 'ind_us_regulation'],
    [/\b(global regulation|mica regulation|casp|vara dubai|mas singapore|fsa japan|hkma|el salvador bitcoin|china crypto ban|crypto law global)\b/, 'ind_global_regulation'],
    [/\b(crypto tax|crypto capital gain|irs crypto|form 8949|hmrc crypto|crypto cgt|koinly|taxbit|cointracker|crypto tax tool|1099.da)\b/, 'ind_crypto_taxes'],
    [/\b(institutional crypto|bitcoin etf|ibit blackrock|microstrategy bitcoin|coinbase prime|falconx|jpmorgan crypto|goldman crypto|bnk crypto|corporate treasury crypto)\b/, 'ind_institutional'],
    [/\b(zk identity|world id|proof of innocence|polygon id|semaphore zk|verifiable credential|kyc zk|onchain kyc|compliant privacy|zk compliance)\b/, 'priv_zk_identity'],
    [/\b(monero deep|xmr technical|ringct|ring signature|stealth address|monero mining|randomx|monero delist|monero regulation)\b/, 'priv_monero_deep'],
    [/\b(tornado cash legal|tornado cash sanction|roman storm|alexey pertsev|ofac tornado|van loon treasury|tornado cash ruling|mixer sanction)\b/, 'priv_tornado_legal'],
    [/\b(railgun|railgun proof|aztec network|noir language|aztec private|private defi|shielded pool|relayer privacy)\b/, 'priv_railgun_aztec'],
    [/\b(fhe crypto|fully homomorphic|zama fhevm|fhenix|confidential compute|tee blockchain|phala network|marlin tee|intel sgx crypto|mpc wallet key)\b/, 'priv_confidential_compute'],
    [/\b(privacy tool|flashbots protect|mev blocker|wasabi wallet|coinjoin|joinmarket|coin mixing|private rpc|privacy ux)\b/, 'priv_ux_tools'],
    [/\b(future privacy|privacy 2030|private l2|zk coprocessor|private rollup|fhe defi|private wallet default|aztec mainnet)\b/, 'priv_future'],
    [/\b(privacy coin|monero|zcash|tornado cash|railgun privacy|aztec network|chainalysis|elliptic analytics|trm labs|arkham|privacy deep)\b/, 'ind_privacy_deep'],
    [/\b(regulation|sec crypto|cftc crypto|mica regulation|howey test|crypto law|crypto legal|ftx lawsuit|crypto compliance|fit21|sab 121)\b/, 'regulation'],
    [/\b(ai.?crypto|ai agent|crypto ai|bittensor|fetch\.ai|agix|ocean protocol|vana|x402|ai payment|agent payment|autonomous agent)\b/, 'ai_crypto'],
    [/\b(defi deep|defi stack|defi tvl|defi vs tradfi|defi ecosystem|defi overview)\b/, 'defi_overview_deep'],
    [/\b(liquidity provision|lp provider|provide liquidity|concentrated liquidity|liquidity mining|lp token|stable pool curve)\b/, 'defi_liquidity'],
    [/\b(yield strateg|defi yield|conservative yield|moderate yield|aggressive yield|yearn|convex|beefy|yield aggregat|defi apy)\b/, 'defi_yield_strategies'],
    [/\b(money market|utilisation rate|kink model|aave v3|compound v3|morpho blue|euler v2|defi interest rate|health factor)\b/, 'defi_money_markets'],
    [/\b(liquid staking|steth|reth|lido|rocket pool|frxeth|cbeth|wbeth|jitosol|msol|liquid stake|staking token)\b/, 'defi_liquid_staking'],
    [/\b(defi chain|defi by chain|aerodrome|velodrome|camelot dex|radiant|pendle arbitrum|moonwell|defi arbitrum|defi base|defi optimism|defi solana)\b/, 'defi_protocols_by_chain'],
    [/\b(defi hack|defi exploit|ronin hack|wormhole hack|euler hack|nomad hack|mango hack|reentrancy|defi attack|defi loss|defi theft)\b/, 'defi_hacks'],
    [/\b(pendle|yield tokenis|pt token|yt token|principal token|yield token|fixed rate defi|yield split|yield trading)\b/, 'defi_pendle_yield'],
    [/\b(rwa defi|real world asset|tokenised treasur|ondo finance|centrifuge|maple finance|goldfinch|buidl fund|benji fund|tokenized bond)\b/, 'defi_rwa'],
    [/\b(defi portfolio|health factor|debank|zerion|zapper|nansen defi|apy.vision|defi risk tier|defi position|manage defi)\b/, 'defi_portfolio'],
    [/\b(cross.chain defi|defi bridge|stargate|across protocol|hop protocol|chain abstraction|canonical bridge|defi crosschain)\b/, 'defi_bridges_deep'],
    [/\b(defi lend|aave|compound finance|morpho|euler finance|kamino|supply apy|borrow rate|overcollateral|liquidation threshold)\b/, 'defi_lending'],
    [/\b(privacy coin|monero|zcash|tornado cash|railgun|aztec|chain analysis|chainalysis|trm labs|anonymous crypto)\b/, 'privacy_crypto'],
    [/\b(crypto derivative|futures crypto|options crypto|deribit|cme bitcoin|open interest|perpetual swap|structured product|max pain|basis trade)\b/, 'crypto_derivatives'],
    [/\b(smart account|erc.?4337|account abstraction|safe wallet|gnosis safe|multi.?sig|mpc wallet|passkey wallet|session key|social recover|paymaster)\b/, 'wallet_advanced'],
    [/\b(layer 0|l0|polkadot|cosmos ibc|layerzero|wormhole|ccip chainlink|avail data|parachain|relay chain|ibc protocol)\b/, 'layer0'],
    [/\b(evm ecosystem|base chain|arbitrum ecosystem|optimism ecosystem|superchain|op stack|polygon ecosystem|zksync|scroll chain|bnb chain|avalanche c)\b/, 'evm_ecosystem'],
    [/\b(amm|automated market maker|liquidity pool|constant product|uniswap v3|concentrated liquidity|x\s*\*\s*y|x\s*times\s*y)\b/, 'dex_amm'],
    [/\b(dex aggregator|1inch|paraswap|cow protocol|cowswap|jupiter aggreg|odos|best swap price|split route|intent.based)\b/, 'dex_aggregators'],
    [/\b(perp dex|perpetual dex|onchain perp|dydx|gmx protocol|hyperliquid|synthetix perp|funding rate|perpetual contract|leveraged dex)\b/, 'dex_perps'],
    [/\b(uniswap v[234]|uniswap hooks|uniswapx|uni token|uniswap deep|uniswap history|uniswap liquidity)\b/, 'dex_uniswap'],
    [/\b(curve finance|crv token|vecr v|curve wars|stableswap|balancer|crv usd|crvusd|bal token|balancer pool|convex finance|bribe)\b/, 'dex_curve_balancer'],
    [/\b(solana dex|jupiter dex|raydium|orca whirlpool|phoenix dex|drift protocol|solana swap|jup token)\b/, 'dex_solana'],
    [/\b(liquidity mining|gauge|emission|ve\(3,3\)|velodrome|aerodrome|velo token|aero token|gauge voting)\b/, 'dex_liquidity_mining'],
    [/\b(mev|maximal extractable value|sandwich attack|front.?running|flashbots|mev.?boost|back.?running|mev protection)\b/, 'dex_mev'],
    [/\b(onchain order book|clob|hyperliquid|hype token|phoenix order book|serum|openbook|vertex protocol|limit order dex)\b/, 'dex_onchain_orderbooks'],
    [/\b(dex|decentralized exchange|uniswap|raydium|orca|pancakeswap|aerodrome|velodrome|curve finance|balancer)\b/, 'dex_overview'],
    [/\b(cex hack|exchange hack|mt\.?gox|bitfinex hack|coincheck|kucoin hack|exchange security|proof of reserves|cold storage exchange|safu)\b/, 'cex_security_hacks'],
    [/\b(limit order|stop.?loss|stop.?limit|oco order|market order|trailing stop|twap|vwap|copy trading|grid bot|dca bot|cex bot|margin trading cex)\b/, 'cex_trading_features'],
    [/\b(fiat onramp|fiat offramp|ach deposit|sepa crypto|bank transfer crypto|crypto atm|p2p market|buy crypto with card|withdraw to bank|cex deposit)\b/, 'cex_fiat_onramps'],
    [/\b(cex regulation|crypto licence|bitlicence|fit21|mica exchange|mpi licence|vara licence|money transmitter|finCEN|cex legal|exchange licence)\b/, 'cex_regulation'],
    [/\b(exchange token|bnb token|okb token|kcs token|cro token|ftt token|exchange coin|exchange native token|bnb burn)\b/, 'cex_exchange_tokens'],
    [/\b(cex derivatives|exchange futures|exchange perps|binance futures|bybit perp|okx futures|deribit|cme bitcoin|quarterly futures|basis trade|exchange options|liquidation cascade)\b/, 'cex_derivatives'],
    [/\b(institutional crypto|coinbase prime|binance institutional|crypto prime broker|crypto custody|bitcoin etf|spot etf|microstrategy|corporate treasury crypto|crypto hedge fund)\b/, 'cex_institutional'],
    [/\b(cex compare|coinbase vs|binance vs|which exchange|best exchange|kraken exchange|bybit|okx exchange|bitget|kucoin)\b/, 'cex_platforms'],
    [/\b(cex vs dex|dex vs cex|centralized vs decentralized exchange|compare exchange)\b/, 'cex_vs_dex'],
    [/\b(cex|centralized exchange|coinbase|binance|kraken|exchange platform|proof of reserves|exchange hack|ftx collapse)\b/, 'cex_overview'],
    [/\b(gamefi overview|what is gamefi|blockchain gaming overview|gamefi history|gamefi market)\b/, 'gamefi_overview'],
    [/\b(gamefi model|p2e model|play.to.earn model|free.to.own|f2o|play.and.earn|gamefi business)\b/, 'gamefi_models'],
    [/\b(gamefi economy|game token|dual.token|token sink|scholarship model|axie economy|slp token|game tokenomics)\b/, 'gamefi_economy'],
    [/\b(ronin chain|ronin hack|sky mavis|katana dex|ron token|ronin validator|pixels game|wild forest|axie homeland)\b/, 'gamefi_ronin'],
    [/\b(treasure dao|magic token|bridgeworld|smol brain|xai gaming|arbitrum gaming|treasure chain|pirate nation arb)\b/, 'gamefi_treasure'],
    [/\b(solana gaming|star atlas|aurory|genopets|nyan heroes|drip solana|gameshift|sonic svm|solana game)\b/, 'gamefi_solana_gaming'],
    [/\b(mobile gamefi|notcoin|hamster kombat|stepn|ton game|telegram game|catizen|pixels mobile|move.to.earn)\b/, 'gamefi_mobile'],
    [/\b(web2 game studio|ubisoft nft|square enix web3|nexon web3|mythical game|animoca brands|fenix games|mapple story web3)\b/, 'gamefi_web2_studios'],
    [/\b(gamefi invest|game token evaluation|gamefi due diligence|game tokenomics eval|gamefi red flag|game vesting)\b/, 'gamefi_investing'],
    [/\b(gamefi scam|gamefi rug|gaming phish|game wallet drain|fake scholarship|evolved apes|gamefi safety|game hack)\b/, 'gamefi_safety'],
    [/\b(ronin chain|immutable.?x|imx|immutable zkevm|mud framework|dojo starknet|game chain|gaming chain|gaming l2)\b/, 'gamefi_platforms'],
    [/\b(cryptokitties|axie infinity|gods unchained|parallel tcg|illuvium|big time|shrapnel|sandbox game|decentraland|defi kingdoms|primodium|dark forest|opcraft)\b/, 'gamefi_projects'],
    [/\b(gaming guild|yield guild|ygg|merit circle|beam gaming|scholarship|scholar model|avocado guild)\b/, 'gamefi_guilds'],
    [/\b(future of gamefi|ai npc|agent game|erc.?6551|token.?bound account|onchain esport|gamefi trend|game interoperab)\b/, 'gamefi_future'],
    [/\b(gamefi|blockchain game|nft game|play.to.earn|p2e|game nft|in.game nft|in.game asset)\b/, 'nft_gaming'],
    [/\b(nft sector|nft market|nft overview|nft space|nft industry)\b/, 'nft_overview'],
    [/\b(nft art|cryptopunk|bored ape|bayc|art blocks|pfp|generative art|digital art|nft collection|nft royalt)\b/, 'nft_art'],
    [/\b(nft game|gamefi|play.to.earn|p2e|axie|free.to.own|onchain game)\b/, 'nft_gaming'],
    [/\b(tokenised bond|tokenized bond|rwa bond|buidl fund|franklin benji|ousg|usdy|superstate|treasury token|on.chain bond|corporate bond token|government bond token|t.?bill token)\b/, 'rwa_bonds'],
    [/\b(rwa collateral|rwa defi|maker rwa|sky rwa|aave rwa|morpho rwa|rwa lending|monetalis|on.chain collateral rwa)\b/, 'rwa_defi_collateral'],
    [/\b(rwa oracle|rwa kyc|erc.3643|t.rex token|securitize|tokeny|rwa infrastructure|rwa settlement|fireblocks rwa|on.chain kyc rwa|chronicle oracle)\b/, 'rwa_infrastructure'],
    [/\b(tokenised art|tokenised luxury|tokenised watch|royal\.io|music royalt|ip token|arianee|freeport art|opulous|sound\.xyz)\b/, 'rwa_luxury_ip'],
    [/\b(rwa emerging market|goldfinch|agridex|rwa africa|rwa latin america|rwa unbanked|drex brazil|tokenised remittance)\b/, 'rwa_emerging_markets'],
    [/\b(institutional rwa|rwa onboarding|rwa custody|rwa prime broker|addx|rwa bank|rwa asset manager|rwa swift|rwa reporting|institutional tokenisation)\b/, 'rwa_institutional_onboarding'],
    [/\b(future rwa|rwa 2027|rwa 2030|rwa roadmap|rwa outlook|ccip rwa|programmable compliance|zk identity rwa)\b/, 'rwa_future'],
    [/\b(rwa overview|real.world asset overview|tokenisation overview|rwa market|rwa tvl|rwa 2026|institutional rwa|rwa sector)\b/, 'rwa_overview'],
    [/\b(tokenised stock|tokenized stock|tokenised equit|tokenized equit|stock token|equity token|backed finance|bCSPX|bNVDA|swarm markets|dinari|dshare|tokenised share)\b/, 'rwa_stocks'],
    [/\b(rwa equity protocol|backed btoken|swarm market|dinari protocol|ondo global market|republic note|rwa platform stock)\b/, 'rwa_equities_protocols'],
    [/\b(tokenised real estate|tokenized real estate|realt|parcl|lofty|real estate token|fractional property|rental yield token|property nft)\b/, 'rwa_real_estate'],
    [/\b(tokenised gold|paxg|xaut|tether gold|paxos gold|gold token|tokenised silver|carbon credit token|toucan protocol|klima dao|tokenised commodity)\b/, 'rwa_commodities'],
    [/\b(tokenised credit|private credit token|maple finance|centrifuge protocol|goldfinch finance|truefi|credix|on.chain loan|tokenised loan)\b/, 'rwa_private_credit'],
    [/\b(rwa regulation|security token law|reg d|reg s|mifid rwa|dlt pilot|project guardian|rwa compliance|tokenised security law)\b/, 'rwa_regulation'],
    [/\b(rwa market 2026|buidl fund|franklin benji|jpmorgan onyx|rwa institutional|rwa adoption|tokenisation market|blackrock rwa)\b/, 'rwa_market_overview'],
    [/\b(real.world asset|rwa|tokeniz|tokenised|tokenization|ondo|centrifuge|maple finance)\b/, 'nft_rwa'],
    [/\b(music nft|sound\.xyz|catalog nft|audius|royal\.io|opulous|music royalt token|nft music artist)\b/, 'nft_music'],
    [/\b(sports nft|nba top shot|nfl all day|sorare|dapper labs|flow blockchain nft|panini nft|topps nft|chiliz|fan token)\b/, 'nft_sports'],
    [/\b(nft analytic|nft valuation|nft floor price|bid depth nft|nftgo|nftscan|nansen nft|dune nft|wash trading nft|trait rarity|holder concentration)\b/, 'nft_analytics'],
    [/\b(nft creator|manifold|thirdweb|crossmint|zora protocol|nft tooling|nft mint tool|dutch auction nft|allowlist tool|erc.2981|nft royalt enforce)\b/, 'nft_creator_tools'],
    [/\b(nft history|nft mania 2021|nft bear|cryptopunks history|bayc history|beeple|opensea history|nft crash|nft recovery|nft market 2022|nft market 2023)\b/, 'nft_market_history'],
    [/\b(nft on base|nft arbitrum|nft polygon|nft l2|nft optimism|nft zksync|treasure dao|smol brain|reddit nft|starbucks odyssey|immutable x nft)\b/, 'nft_evm_ecosystems'],
    [/\b(nft tax|nft capital gain|nft irs|nft hmrc|nft legal|nft copyright|nft ip|koinly nft|taxbit nft|nft cost basis|nft wash trade law)\b/, 'nft_tax_legal'],
    [/\b(nft marketplace|opensea|blur|tensor|magic eden marketplace|x2y2|looksrare|royalt)\b/, 'nft_marketplaces'],
    [/\b(ordinal|inscription|brc.?20|satoshi nft|bitcoin nft|taproot nft|nodemonke|bitcoin punk)\b/, 'nft_bitcoin_ordinals'],
    [/\b(utility nft|token.gated|soulbound|sbt|nft membership|ens domain|nft ticket|nft ip right)\b/, 'nft_utility'],
    [/\b(nft lifecycle|mint process|nft reveal|dutch auction mint|allowlist|whitelist mint|primary mint)\b/, 'nft_lifecycle'],
    [/\b(solana nft|metaplex|compressed nft|cnft|mad lad|degod|smb|tensorian|solana collection)\b/, 'nft_solana_ecosystem'],
    [/\b(nft.?fi|nft lend|nft borrow|blend protocol|nftfi|sudoswap|nft amm|nft fraction|nft collateral)\b/, 'nft_defi'],
    [/\b(nft|non.fungible|erc.?721|zora|magic eden)\b/, 'nft'],
    [/\b(meme tokenomics|meme supply|burn mechanic|tax token|fair launch meme|dev wallet)\b/, 'meme_tokenomics'],
    [/\b(meme trading|dexscreener|birdeye|bubblemaps|photon bot|bullx|banana gun|maestro bot|meme tool)\b/, 'meme_trading'],
    [/\b(notable meme|biggest meme|meme history|doge history|shib history|pepe history|wif history|trump token|squid game token)\b/, 'meme_notable'],
    [/\b(meme safety|honeypot|lp lock|rug check|tokensniffer|bundl|meme scam|meme red flag)\b/, 'meme_safety'],
    [/\b(solana meme|sol meme|wif|dogwifhat|bonk|popcat|mew coin|bome|sol pump|pump\.fun ecosystem)\b/, 'meme_solana'],
    [/\b(evm meme|ethereum meme|base meme|pepe coin|brett coin|toshi coin|mog coin|clanker|bnb meme|floki)\b/, 'meme_evm'],
    [/\b(meme cycle|meme season|alt season meme|meme bull|narrative rotation|meme market cycle|fear and greed meme)\b/, 'meme_cycles'],
    [/\b(kol meme|key opinion leader|meme influencer|shill deal|paid promotion crypto|murad thesis)\b/, 'meme_kol'],
    [/\b(meme onchain|bubblemaps|wallet cluster|deployer wallet|meme analysis|lp burn|freeze authority|mint authority)\b/, 'meme_onchain_analysis'],
    [/\b(meme defi|shibarium|shibaswap|flokifi|meme staking|meme liquidity|meme lp|meme yield)\b/, 'meme_defi'],
    [/\b(meme regulation|meme legal|meme tax|meme sec|meme mica|kol disclosure|crypto promo law)\b/, 'meme_regulation'],
    [/\b(meme coin|memecoin|doge|shib|shiba|pepe coin|wif|bonk|brett|popcat|dogecoin)\b/, 'memecoins'],
    [/\b(pump\.fun|launchpad|bonding curve|token launch|clanker|four\.meme)\b/, 'meme_launchpads'],
    [/\b(meme culture|crypto twitter|ct culture|kol|sniping|degen|narrative rotation|meme season)\b/, 'meme_culture'],
    [/\b(wallet|metamask|ledger|trezor|private key)\b/, 'wallet'],
    [/\b(metamask)\b/, 'metamask'],
    [/\b(gas fee|gwei|transaction fee|gas price|base fee)\b/, 'gas'],
    [/\b(staking|stake|validator|proof.of.stake|lido|rocket pool)\b/, 'staking'],
    [/\b(blockchain|distributed ledger)\b/, 'blockchain'],
    [/\b(mining|miner|proof.of.work|pow|asic|hash rate)\b/, 'mining'],
    [/\b(halving|halvening|block reward)\b/, 'halving'],
    [/\b(solana|sol|proof.of.history)\b/, 'solana'],
    [/\b(arc chain|arc testnet|arc mainnet|arc blockchain)\b/, 'arc'],
    [/\b(layer 2|l2|rollup|arbitrum|optimism|zksync|starknet|base chain)\b/, 'layer2'],
    [/\b(layer 1|l1|base layer|l1 chain)\b/, 'layer1'],
    [/\b(cctp|cross.chain transfer|circle bridge)\b/, 'cctp'],
    [/\b(seed phrase|mnemonic|recovery phrase|12.?word|24.?word)\b/, 'seed'],
    [/\b(smart contract|solidity|bytecode|deploy contract|erc.4337)\b/, 'smart_contract'],
    [/\b(dao|decentralized autonomous|governance token|proposal|on.chain voting)\b/, 'dao'],
    [/\b(yield farm|liquidity mining|lp token|provide liquidity)\b/, 'yield'],
    [/\b(erc.?20|token standard|erc20)\b/, 'erc20'],
    [/\b(cbdc|central bank digital|digital dollar|digital euro|e.cny)\b/, 'cbdc'],
    [/\b(impermanent loss|il|amm loss|lp loss)\b/, 'impermanent_loss'],
    [/\b(oracle|chainlink|price feed|pyth|data feed)\b/, 'oracle'],
    [/\b(flash loan|flashloan|uncollateralized loan)\b/, 'flashloan'],
  ]

  for (const [regex, key] of topicMap) {
    if (regex.test(q) && CRYPTO_KNOWLEDGE[key]) {
      return CRYPTO_KNOWLEDGE[key]
    }
  }

  if (/\b(crypto|cryptocurrency|coin|token|altcoin)\b/.test(q)) {
    return `**Cryptocurrencies** are digital assets secured by cryptography and recorded on decentralized blockchains.\n\n**Key areas to explore:**\n- **Bitcoin** — the original, store of value\n- **Ethereum** — programmable blockchain for smart contracts\n- **Stablecoins** (USDC) — price-stable tokens pegged to fiat\n- **DeFi** — decentralized financial services\n- **NFTs** — unique digital ownership\n- **Layer 2s** — scaling solutions\n\nBrowse the Topics panel for a full topic list, or ask about anything specific!`
  }

  return `Great question! I specialize in cryptocurrency and blockchain topics.\n\n**I can explain:**\n- Bitcoin, Ethereum, Solana fundamentals\n- Stablecoins and USDC\n- DeFi protocols, yield farming, flash loans\n- **NFTs** — marketplaces, digital art, Bitcoin Ordinals, utility NFTs, lifecycle, Solana ecosystem, NFT-Fi\n- **GameFi** — models (P2E, F2O, FOCG), token economies, platforms, notable projects, guilds, and the future\n- **Meme coins** — history, tokenomics, trading tools, notable coins, launchpads, safety\n- Wallets and key management\n- Staking and validators\n- Layer 1 and Layer 2 networks\n- Smart contracts and DAOs\n- Gas fees and transaction mechanics\n\nBrowse the **Topics** panel for 220+ topics, or check the **Glossary** for 450+ quick definitions.`
}

// ── Markdown renderer ──────────────────────────────────────────────────────
function renderContent(text: string, dark: boolean) {
  const inkColor = dark ? 'var(--ink)' : 'var(--ink)'
  return text.split('\n').map((line, i) => {
    const parts = line.replace(/^- /, '').split(/\*\*(.*?)\*\*/g)
    const rendered = parts.map((part, j) =>
      j % 2 === 1
        ? <strong key={j} style={{ color: inkColor, fontWeight: 600 }}>{part}</strong>
        : part
    )
    if (line.startsWith('- ')) {
      return (
        <span key={i} className="flex gap-2 mt-0.5">
          <span style={{ color: 'var(--muted)', flexShrink: 0 }}>•</span>
          <span>{rendered}</span>
        </span>
      )
    }
    return (
      <span key={i} className="block" style={{ marginTop: i > 0 && line === '' ? '0.5rem' : undefined }}>
        {rendered}
      </span>
    )
  })
}

// ── Copy button ────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all"
      style={{ color: 'var(--subtle)', background: 'transparent' }}
      title="Copy message"
    >
      {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ── Share link helpers ─────────────────────────────────────────────────────
function encodeShareFragment(content: string): string {
  return btoa(unescape(encodeURIComponent(content)))
}
function decodeShareFragment(frag: string): string | null {
  try { return decodeURIComponent(escape(atob(frag))) } catch { return null }
}

function ShareLinkButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)
  const handleShare = () => {
    const url = `${window.location.origin}${window.location.pathname}#q=${encodeShareFragment(content)}`
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all"
      style={{ color: 'var(--subtle)', background: 'transparent' }}
      title="Copy share link"
    >
      {copied ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Link size={12} />}
      {copied ? 'Copied!' : 'Share'}
    </button>
  )
}

function readSharedAnswer(): string | null {
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  if (!hash.startsWith('#q=')) return null
  return decodeShareFragment(hash.slice(3))
}

function SharedAnswerModal({ dark }: { dark: boolean }) {
  // Lazy initializer reads the URL fragment once at mount — no effect needed
  const [answer, setAnswer] = useState<string | null>(readSharedAnswer)
  if (!answer) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={() => { setAnswer(null); window.history.replaceState(null, '', window.location.pathname) }}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl p-6 shadow-2xl"
        style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent)' }}>
              <Link size={14} style={{ color: dark ? '#0d1b2f' : '#fff' }} />
            </div>
            <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Shared Answer</span>
          </div>
          <button
            onClick={() => { setAnswer(null); window.history.replaceState(null, '', window.location.pathname) }}
            className="p-1 rounded-lg"
            style={{ color: 'var(--subtle)' }}
          >
            <X size={16} />
          </button>
        </div>
        <div
          className="text-sm leading-relaxed max-h-96 overflow-y-auto pr-1"
          style={{ color: 'var(--ink-2)' }}
        >
          {answer.split('\n').map((line, i) => {
            const bold = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            return <p key={i} className="mb-1" dangerouslySetInnerHTML={{ __html: bold }} />
          })}
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
          <CopyButton text={answer.replace(/\*\*/g, '')} />
          <button
            onClick={() => { setAnswer(null); window.history.replaceState(null, '', window.location.pathname) }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const { address, isConnected } = useAccount()
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '0',
      role: 'assistant',
      content: `Welcome to **CryptoAdvisor**! I'm your AI-powered crypto assistant with deep knowledge of Bitcoin, Ethereum, DeFi, NFTs, GameFi, meme coins, wallets, stablecoins, and more.\n\nConnect your wallet and pay **$0.01 USDC** per question. Answers are powered by AI with a built-in knowledge base fallback.`,
      timestamp: new Date(),
    },
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')

  // Session key state
  const [showSessionSetup, setShowSessionSetup] = useState(false)
  const { data: queryFeeFromContract } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'queryFee',
    chainId: ARC_CHAIN_ID,
  })

  // Push notification subscription state
  const [pushSubscribed, setPushSubscribed] = useState(false)
  type ModelChoice = 'auto' | 'groq' | 'gemini' | 'local'
  const [selectedModel, setSelectedModel] = useState<ModelChoice>('auto')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [marketFetchedAt, setMarketFetchedAt] = useState<number | null>(null)
  useEffect(() => {
    const load = () => {
      void fetch('/api/market-context')
        .then(r => r.ok ? r.json() : null)
        .then((d: { fetchedAt?: number } | null) => {
          if (d?.fetchedAt) queueMicrotask(() => setMarketFetchedAt(d.fetchedAt!))
        })
        .catch(() => null)
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!modelMenuOpen) return
    const close = () => setModelMenuOpen(false)
    document.addEventListener('click', close, { capture: true, once: true })
    return () => document.removeEventListener('click', close, { capture: true })
  }, [modelMenuOpen])
  const [pushLoading, setPushLoading] = useState(false)
  // Check on mount if already subscribed
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    void (async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) return
      const sub = await reg.pushManager.getSubscription()
      setPushSubscribed(!!sub)
    })()
  }, [])

  const togglePushNotifications = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error('Push notifications require the app to be installed or run over HTTPS.')
      return
    }
    setPushLoading(true)
    try {
      // Fetch VAPID public key from server
      const keyRes = await fetch('/api/push/vapid-public')
      const { key } = await keyRes.json() as { key: string | null }
      if (!key) { toast.error('Push not configured on server.'); return }

      let reg = await navigator.serviceWorker.getRegistration()
      if (!reg) reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready

      if (pushSubscribed) {
        // Unsubscribe
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          await fetch('/api/push/unsubscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          })
          await sub.unsubscribe()
        }
        setPushSubscribed(false)
        toast.success('Daily notifications turned off.')
      } else {
        // Request permission then subscribe
        const perm = await Notification.requestPermission()
        if (perm !== 'granted') { toast.error('Notification permission denied.'); return }

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        })
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wallet: address ?? 'anonymous', subscription: sub.toJSON() }),
        })
        setPushSubscribed(true)
        toast.success('Daily crypto digest enabled — 9 AM UTC every day.')
      }
    } catch (e) {
      toast.error('Could not toggle notifications. Try after deploying over HTTPS.')
      console.error(e)
    } finally {
      setPushLoading(false)
    }
  }, [pushSubscribed, address])

  const [activePanel, setActivePanel] = useState<Panel>('chat')
  const [searchHistory, setSearchHistory] = useState<Array<{ q: string; answer: string }>>([])
  const [glossarySearch, setGlossarySearch] = useState('')
  const [expandedCategory, setExpandedCategory] = useState<string | null>('Fundamentals')
  const [pendingQuery, setPendingQuery] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Per-user query count from contract
  const { data: userQueryCount } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'queriesByUser',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15000 },
  })

  // Subscription status
  const { data: userIsSubscribed } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'isSubscribed',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15000 },
  })

  // Subscription expiry timestamp
  const { data: subExpiry } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'subscriptionExpiry',
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15000 },
  })

  // Live clock for countdown (updates every minute)
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])

  // Days left on subscription (0 = expired / no sub)
  const daysLeft = subExpiry && subExpiry > 0n
    ? Math.max(0, Math.ceil((Number(subExpiry) - nowSecs) / 86400))
    : 0

  // Subscription fee
  const { data: subscriptionFeeRaw } = useReadContract({
    address: QUERY_PAYMENT_ADDRESS,
    abi: QUERY_PAYMENT_ABI,
    functionName: 'subscriptionFee',
    chainId: ARC_CHAIN_ID,
    query: { refetchInterval: 60000 },
  })

  // Apply dark/light CSS vars to root
  useEffect(() => {
    const root = document.documentElement
    if (dark) {
      root.style.setProperty('--bg', '#0d1b2f')
      root.style.setProperty('--bg-gradient', 'linear-gradient(180deg, #0d1b2f 0%, #0d1b2f 58%, #122d45 100%)')
      root.style.setProperty('--surface', 'rgba(255,255,255,0.07)')
      root.style.setProperty('--surface-strong', 'rgba(255,255,255,0.11)')
      root.style.setProperty('--surface-muted', '#1f2f44')
      root.style.setProperty('--ink', '#f9faf3')
      root.style.setProperty('--ink-2', '#e3ecf9')
      root.style.setProperty('--muted', '#cbd5e1')
      root.style.setProperty('--subtle', '#94a3b8')
      root.style.setProperty('--border', 'rgba(255,255,255,0.12)')
      root.style.setProperty('--border-strong', 'rgba(203,219,242,0.55)')
      root.style.setProperty('--accent', '#acc6e9')
      root.style.setProperty('--accent-hover', '#cbdbf2')
      root.style.setProperty('--success', '#8dd89f')
      root.style.setProperty('--danger', '#e86d7a')
    } else {
      root.style.setProperty('--bg', '#ffffff')
      root.style.setProperty('--bg-gradient', 'linear-gradient(180deg, #f9f9fc 0%, #fffcf7 52%, #fbf7f2 100%)')
      root.style.setProperty('--surface', 'rgba(255,255,255,0.72)')
      root.style.setProperty('--surface-strong', 'rgba(255,255,255,0.90)')
      root.style.setProperty('--surface-muted', '#f5f5f8')
      root.style.setProperty('--ink', '#122d45')
      root.style.setProperty('--ink-2', '#334155')
      root.style.setProperty('--muted', '#6b6580')
      root.style.setProperty('--subtle', '#8a849c')
      root.style.setProperty('--border', 'rgba(18,45,69,0.12)')
      root.style.setProperty('--border-strong', 'rgba(25,53,77,0.50)')
      root.style.setProperty('--accent', '#122d45')
      root.style.setProperty('--accent-hover', '#1061a6')
      root.style.setProperty('--success', '#1a8047')
      root.style.setProperty('--danger', '#ba2b4c')
    }
    document.body.style.background = 'var(--bg-gradient)'
  }, [dark])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Ref always holds the latest messages — kept in sync via layout effect (not during render)
  const messagesRef = useRef(messages)
  useLayoutEffect(() => { messagesRef.current = messages }, [messages])

  // Called after payment confirmed — streams AI answer or falls back to local KB
  const deliverAnswer = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: trimmed, timestamp: new Date() }
    setMessages(prev => [...prev, userMsg])
    setSearchHistory(prev => [{ q: trimmed, answer: '' }, ...prev.filter(h => h.q !== trimmed)].slice(0, 20))
    setInput('')
    setIsTyping(true)
    setActivePanel('chat')

    // Build conversation history for context (last 8 exchanges)
    const history = messagesRef.current.slice(-16).map(m => ({ role: m.role, content: m.content }))
    const assistantId = (Date.now() + 1).toString()

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history, { role: 'user', content: trimmed }], model: selectedModel }),
      })

      if (!resp.ok || !resp.body) throw new Error('API unavailable')

      // Add streaming placeholder
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '', timestamp: new Date(),
        aiPowered: true, streaming: true,
      }])
      setIsTyping(false)

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break
          try {
            const parsed = JSON.parse(data) as { delta?: string; error?: string }
            if (parsed.error) throw new Error(parsed.error)
            if (parsed.delta) {
              accumulated += parsed.delta
              setMessages(prev => prev.map(m =>
                m.id === assistantId ? { ...m, content: accumulated } : m
              ))
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      // Mark streaming done and save answer to history
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, streaming: false } : m
      ))
      setSearchHistory(prev => prev.map(h =>
        h.q === trimmed && h.answer === '' ? { ...h, answer: accumulated } : h
      ))

    } catch {
      // Fallback to local knowledge base
      await new Promise(r => setTimeout(r, 400 + Math.random() * 300))
      const response = generateResponse(trimmed)
      setMessages(prev => {
        const hasPlaceholder = prev.some(m => m.id === assistantId)
        if (hasPlaceholder) {
          return prev.map(m => m.id === assistantId
            ? { ...m, content: response, aiPowered: false, streaming: false }
            : m
          )
        }
        return [...prev, { id: assistantId, role: 'assistant', content: response, timestamp: new Date(), aiPowered: false }]
      })
      setSearchHistory(prev => prev.map(h =>
        h.q === trimmed && h.answer === '' ? { ...h, answer: response } : h
      ))
      setIsTyping(false)
    }
  }, [selectedModel])

  // Initiating a query — gates behind payment
  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isTyping) return
    if (!isConnected) {
      toast.error('Connect your wallet to ask questions.')
      return
    }
    // Show the payment gate; deliverAnswer is called after payment
    setPendingQuery(trimmed)
    setInput('')
    setActivePanel('chat')
  }, [isTyping, isConnected])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }

  const toggleBookmark = (id: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, bookmarked: !m.bookmarked } : m))
  }

  const handleReset = () => {
    setMessages([{ id: Date.now().toString(), role: 'assistant', content: `Conversation reset. Ask me anything about crypto and blockchain.`, timestamp: new Date() }])
  }

  const bookmarkedMessages = messages.filter(m => m.bookmarked)
  const filteredGlossary = GLOSSARY.filter(g =>
    g.term.toLowerCase().includes(glossarySearch.toLowerCase()) ||
    g.definition.toLowerCase().includes(glossarySearch.toLowerCase())
  )

  const allNavItems: Array<{ id: Panel; icon: typeof Bot; label: string; badge?: number }> = [
    { id: 'chat',      icon: Bot,           label: 'Chat' },
    { id: 'swap',      icon: ArrowLeftRight, label: 'Market' },
    { id: 'wallet',    icon: KeyRound,       label: 'Wallet' },
    { id: 'topics',    icon: Hash,           label: 'Topics' },
    { id: 'bookmarks', icon: Bookmark,       label: 'Saved',     badge: bookmarkedMessages.length || undefined },
    { id: 'history',   icon: History,        label: 'History',   badge: searchHistory.length || undefined },
    { id: 'glossary',  icon: BookOpen,       label: 'Glossary' },
    { id: 'owner',     icon: LayoutDashboard, label: 'Dashboard' },
    { id: 'agent',     icon: Activity,        label: 'Agent' },
    { id: 'portfolio', icon: ShieldCheck,     label: 'Portfolio' },
  ]
  // Primary tabs always shown; overflow tabs live in the More drawer
  const PRIMARY_COUNT = 4
  const primaryNavItems = allNavItems.slice(0, PRIMARY_COUNT)
  const moreNavItems = allNavItems.slice(PRIMARY_COUNT)
  const activeInMore = moreNavItems.some(n => n.id === activePanel)
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div className="min-h-dvh flex flex-col max-w-lg mx-auto" style={{ background: 'var(--bg-gradient)' }}>

      {/* Header */}
      <header
        className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 border-b"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', backdropFilter: 'blur(16px)' }}
      >
        <div
          className="flex items-center justify-center w-9 h-9 rounded-xl flex-shrink-0"
          style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
        >
          <Zap size={18} />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="display font-semibold text-sm leading-tight truncate" style={{ color: 'var(--ink)' }}>CryptoAdvisor</p>
          <p className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
            <Zap size={9} style={{ color: 'var(--accent)' }} />
            <span className="truncate">AI-powered crypto agent</span>
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Wallet connect */}
          <ConnectKitButton.Custom>
            {({ isConnected: ckConnected, show, address: ckAddr }) => (
              <button
                onClick={show}
                className="flex items-center gap-1 px-2 py-1.5 rounded-xl text-xs font-semibold transition-colors border mr-0.5 max-w-[90px] truncate"
                style={{
                  background: ckConnected ? 'var(--surface-muted)' : 'var(--accent)',
                  borderColor: ckConnected ? 'var(--border)' : 'transparent',
                  color: ckConnected ? 'var(--ink-2)' : (dark ? '#0d1b2f' : '#fff'),
                }}
              >
                <Wallet size={12} className="flex-shrink-0" />
                <span className="truncate">
                  {ckConnected && ckAddr
                    ? `${ckAddr.slice(0, 4)}…${ckAddr.slice(-3)}`
                    : 'Connect'}
                </span>
              </button>
            )}
          </ConnectKitButton.Custom>
          <SessionBadge address={address} onSetup={() => setShowSessionSetup(true)} />
          <button
            onClick={() => { void togglePushNotifications() }}
            disabled={pushLoading}
            className="w-8 h-8 flex items-center justify-center rounded-xl transition-colors"
            style={{ color: pushSubscribed ? 'var(--accent)' : 'var(--subtle)' }}
            title={pushSubscribed ? 'Turn off daily digest' : 'Get daily crypto digest'}
          >
            {pushLoading ? <Loader2 size={14} className="animate-spin" /> : pushSubscribed ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
          <button
            onClick={() => setDark(d => { localStorage.setItem('theme', d ? 'light' : 'dark'); return !d })}
            className="w-8 h-8 flex items-center justify-center rounded-xl transition-colors"
            style={{ color: 'var(--subtle)' }}
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            onClick={handleReset}
            className="w-8 h-8 flex items-center justify-center rounded-xl transition-colors"
            style={{ color: 'var(--subtle)' }}
            title="Reset chat"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* Nav tabs — primary row + More button */}
      <div
        className="flex border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}
      >
        {primaryNavItems.map(({ id, icon: Icon, label, badge }) => (
          <button
            key={id}
            onClick={() => setActivePanel(id)}
            className="flex-1 flex flex-col items-center gap-0.5 px-1 py-2 text-xs font-medium transition-colors relative"
            style={{
              color: activePanel === id ? 'var(--accent)' : 'var(--subtle)',
              borderBottom: activePanel === id ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            <div className="relative">
              <Icon size={15} />
              {badge !== undefined && badge > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 text-[9px] font-bold w-3.5 h-3.5 flex items-center justify-center rounded-full"
                  style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
                >
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </div>
            <span className="truncate w-full text-center">{label}</span>
          </button>
        ))}
        {/* More button */}
        <button
          onClick={() => setMoreOpen(o => !o)}
          className="flex-1 flex flex-col items-center gap-0.5 px-1 py-2 text-xs font-medium transition-colors relative"
          style={{
            color: activeInMore ? 'var(--accent)' : 'var(--subtle)',
            borderBottom: activeInMore ? '2px solid var(--accent)' : '2px solid transparent',
          }}
        >
          <div className="relative">
            <MoreHorizontal size={15} />
            {moreNavItems.some(n => n.badge && n.badge > 0) && (
              <span
                className="absolute -top-1.5 -right-1.5 text-[9px] font-bold w-3.5 h-3.5 flex items-center justify-center rounded-full"
                style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
              >
                {moreNavItems.reduce((s, n) => s + (n.badge ?? 0), 0)}
              </span>
            )}
          </div>
          <span className="truncate w-full text-center">More</span>
        </button>
      </div>

      {/* More drawer — slides up from the tab bar */}
      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.div
              key="more-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30"
              style={{ background: 'rgba(0,0,0,0.35)' }}
              onClick={() => setMoreOpen(false)}
            />
            <motion.div
              key="more-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed bottom-0 left-0 right-0 z-40 rounded-t-2xl border-t max-w-lg mx-auto"
              style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>More</span>
                <button onClick={() => setMoreOpen(false)} style={{ color: 'var(--subtle)' }}><X size={16} /></button>
              </div>
              <div className="grid grid-cols-4 gap-1 p-3">
                {moreNavItems.map(({ id, icon: Icon, label, badge }) => (
                  <button
                    key={id}
                    onClick={() => { setActivePanel(id); setMoreOpen(false) }}
                    className="flex flex-col items-center gap-1.5 py-3 rounded-xl text-xs font-medium transition-colors relative"
                    style={{
                      background: activePanel === id ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--surface-muted)',
                      color: activePanel === id ? 'var(--accent)' : 'var(--ink-2)',
                    }}
                  >
                    <div className="relative">
                      <Icon size={18} />
                      {badge !== undefined && badge > 0 && (
                        <span
                          className="absolute -top-1.5 -right-1.5 text-[9px] font-bold w-3.5 h-3.5 flex items-center justify-center rounded-full"
                          style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
                        >
                          {badge > 9 ? '9+' : badge}
                        </span>
                      )}
                    </div>
                    {label}
                  </button>
                ))}
              </div>
              {/* safe area padding for phones with home bar */}
              <div className="pb-safe pb-4" />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Panel content */}
      <div className="flex-1 overflow-y-auto">

        {/* CHAT PANEL */}
        {activePanel === 'chat' && (
          <div className="flex flex-col min-h-full">
            {/* ── Model selector ─────────────────────────────────────────── */}
            {(() => {
              const models: { id: ModelChoice; label: string; badge: string }[] = [
                { id: 'auto',   label: 'Auto',              badge: 'Groq → Gemini' },
                { id: 'groq',   label: 'Groq',              badge: 'Llama 3.3 70B' },
                { id: 'gemini', label: 'Gemini',            badge: '2.0 Flash' },
                { id: 'local',  label: 'Local KB',          badge: 'Offline' },
              ]
              const current = models.find(m => m.id === selectedModel)!
              return (
                <div className="relative px-4 pt-3 pb-1 flex items-center gap-2">
                  <button
                    onClick={() => setModelMenuOpen(o => !o)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                    style={{
                      background: 'var(--surface-strong)',
                      border: '1px solid var(--border)',
                      color: 'var(--ink-2)',
                    }}
                  >
                    <Cpu size={12} style={{ color: 'var(--accent)' }} />
                    <span style={{ color: 'var(--ink-1)' }}>{current.label}</span>
                    <span style={{ color: 'var(--subtle)' }}>{current.badge}</span>
                    <ChevronDown size={11} className={`transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--subtle)' }} />
                  </button>

                  {marketFetchedAt && selectedModel !== 'local' && (
                    <span
                      className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold"
                      style={{ background: 'var(--success-soft, #d1fae5)', color: 'var(--success, #059669)' }}
                      title={`Live market data as of ${new Date(marketFetchedAt).toLocaleTimeString()}`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                      Live data
                    </span>
                  )}

                  <AnimatePresence>
                    {modelMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.97 }}
                        transition={{ duration: 0.14 }}
                        className="absolute left-4 top-full mt-1 z-50 rounded-xl overflow-hidden shadow-xl min-w-[200px]"
                        style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
                      >
                        {models.map(m => (
                          <button
                            key={m.id}
                            onClick={() => { setSelectedModel(m.id); setModelMenuOpen(false) }}
                            className="w-full flex items-center justify-between px-3 py-2.5 text-xs transition-colors hover:opacity-80"
                            style={{
                              background: selectedModel === m.id ? 'var(--accent-soft)' : 'transparent',
                              color: 'var(--ink-1)',
                            }}
                          >
                            <span className="font-medium">{m.label}</span>
                            <span style={{ color: selectedModel === m.id ? 'var(--accent)' : 'var(--subtle)' }}>
                              {selectedModel === m.id ? '✓ ' : ''}{m.badge}
                            </span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })()}
            <div className="flex-1 px-4 py-4 space-y-4">
              <AnimatePresence initial={false}>
                {messages.map(msg => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, ease: 'easeOut' }}
                    className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                  >
                    <div
                      className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-1"
                      style={{
                        background: msg.role === 'assistant' ? 'var(--accent)' : 'var(--surface-muted)',
                        color: msg.role === 'assistant' ? (dark ? '#0d1b2f' : '#fff') : 'var(--ink-2)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {msg.role === 'assistant' ? <Bot size={13} /> : <User size={13} />}
                    </div>
                    <div className={`flex flex-col gap-1 max-w-[80%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      <div
                        className="rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"
                        style={{
                          background: msg.role === 'assistant' ? 'var(--surface-strong)' : 'var(--accent)',
                          color: msg.role === 'assistant' ? 'var(--ink-2)' : (dark ? '#0d1b2f' : '#fff'),
                          border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                          borderBottomLeftRadius: msg.role === 'assistant' ? '4px' : undefined,
                          borderBottomRightRadius: msg.role === 'user' ? '4px' : undefined,
                        }}
                      >
                        <div className="space-y-0.5">
                        {renderContent(msg.content, dark)}
                        {msg.streaming && (
                          <motion.span
                            className="inline-block w-2 h-4 rounded-sm ml-0.5 align-middle"
                            style={{ background: 'var(--accent)', opacity: 0.8 }}
                            animate={{ opacity: [0.8, 0.2, 0.8] }}
                            transition={{ duration: 0.9, repeat: Infinity }}
                          />
                        )}
                      </div>
                      </div>
                      <div className="flex items-center gap-1 px-1">
                        <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                          {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.role === 'assistant' && msg.aiPowered && !msg.streaming && (
                          <span
                            className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ background: 'var(--surface-muted)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                          >
                            <Zap size={9} />AI
                          </span>
                        )}
                        {msg.role === 'assistant' && !msg.streaming && <CopyButton text={msg.content.replace(/\*\*/g, '')} />}
                        {msg.role === 'assistant' && !msg.streaming && (
                          <button
                            onClick={() => toggleBookmark(msg.id)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all"
                            style={{ color: msg.bookmarked ? 'var(--accent)' : 'var(--subtle)' }}
                            title={msg.bookmarked ? 'Remove bookmark' : 'Bookmark'}
                          >
                            {msg.bookmarked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}

                {isTyping && (
                  <motion.div key="typing" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-2.5">
                    <div
                      className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                      style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff', border: '1px solid var(--border)' }}
                    >
                      <Bot size={13} />
                    </div>
                    <div className="rounded-2xl rounded-bl-[4px] px-4 py-3" style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}>
                      <div className="flex gap-1 items-center h-4">
                        {[0, 1, 2].map(i => (
                          <motion.span
                            key={i}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: 'var(--muted)' }}
                            animate={{ opacity: [0.3, 1, 0.3] }}
                            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                          />
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Suggestions */}
              {messages.length <= 1 && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>
                    Popular questions
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {SUGGESTED_QUESTIONS.map(s => (
                      <button
                        key={s.label}
                        onClick={() => { void sendMessage(s.question) }}
                        className="flex items-center justify-between text-left px-3 py-2.5 rounded-xl text-xs font-medium border transition-colors"
                        style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--ink-2)' }}
                      >
                        <span>{s.label}</span>
                        <ChevronRight size={11} style={{ color: 'var(--subtle)', flexShrink: 0 }} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Payment gate — shown above input when pending */}
            <AnimatePresence>
              {pendingQuery && (
                <PaymentGate
                  dark={dark}
                  pendingQuery={pendingQuery}
                  onPaid={(q) => {
                    setPendingQuery(null)
                    void deliverAnswer(q)
                  }}
                  onCancel={() => setPendingQuery(null)}
                />
              )}
            </AnimatePresence>
          </div>
        )}

        {/* TOPICS PANEL */}
        {activePanel === 'topics' && (
          <div className="px-4 py-4 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>
              Browse {Object.keys(CRYPTO_KNOWLEDGE).length} topics
            </p>
            {TOPIC_CATEGORIES.map(cat => (
              <div key={cat.label} className="rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
                <button
                  onClick={() => setExpandedCategory(expandedCategory === cat.label ? null : cat.label)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
                  style={{ background: 'var(--surface-strong)', color: 'var(--ink)' }}
                >
                  <div className="flex items-center gap-2.5">
                    <cat.icon size={15} style={{ color: 'var(--muted)' }} />
                    {cat.label}
                    <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface-muted)', color: 'var(--muted)' }}>
                      {cat.topics.length}
                    </span>
                  </div>
                  {expandedCategory === cat.label ? <ChevronUp size={14} style={{ color: 'var(--subtle)' }} /> : <ChevronDown size={14} style={{ color: 'var(--subtle)' }} />}
                </button>
                <AnimatePresence>
                  {expandedCategory === cat.label && (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: 'auto' }}
                      exit={{ height: 0 }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="px-3 pb-3 pt-1 grid grid-cols-2 gap-1.5" style={{ background: 'var(--surface)' }}>
                        {cat.topics.map(key => (
                          <button
                            key={key}
                            onClick={() => { void sendMessage(`Tell me about ${TOPIC_LABELS[key]}`) }}
                            className="text-left px-3 py-2 rounded-xl text-xs font-medium border transition-colors"
                            style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--ink-2)' }}
                          >
                            {TOPIC_LABELS[key]}
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        )}

        {/* BOOKMARKS PANEL */}
        {activePanel === 'bookmarks' && (
          <div className="px-4 py-4 space-y-3">
            <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>
              Saved answers ({bookmarkedMessages.length})
            </p>
            {bookmarkedMessages.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <BookmarkCheck size={32} style={{ color: 'var(--border-strong)' }} />
                <p className="text-sm font-medium" style={{ color: 'var(--muted)' }}>No saved answers yet</p>
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>Tap the bookmark icon on any assistant reply</p>
              </div>
            ) : (
              bookmarkedMessages.map(msg => (
                <div key={msg.id} className="rounded-2xl p-4 border" style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}>
                  <div className="text-sm leading-relaxed mb-2" style={{ color: 'var(--ink-2)' }}>
                    {renderContent(msg.content.slice(0, 200) + (msg.content.length > 200 ? '…' : ''), dark)}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div className="flex gap-1">
                      <CopyButton text={msg.content.replace(/\*\*/g, '')} />
                      <ShareLinkButton content={msg.content} />
                      <button
                        onClick={() => toggleBookmark(msg.id)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs"
                        style={{ color: 'var(--danger)' }}
                      >
                        <X size={11} /> Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* HISTORY PANEL */}
        {activePanel === 'history' && (
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}>
                Search history ({searchHistory.length})
              </p>
              {searchHistory.length > 0 && (
                <button
                  onClick={() => setSearchHistory([])}
                  className="text-xs px-2 py-1 rounded-lg border"
                  style={{ color: 'var(--danger)', borderColor: 'var(--border)' }}
                >
                  Clear all
                </button>
              )}
            </div>
            {searchHistory.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <History size={32} style={{ color: 'var(--border-strong)' }} />
                <p className="text-sm font-medium" style={{ color: 'var(--muted)' }}>No history yet</p>
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>Your questions will appear here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {searchHistory.map((entry, i) => (
                  <div
                    key={i}
                    className="rounded-xl border overflow-hidden"
                    style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
                  >
                    {/* Question row */}
                    <button
                      onClick={() => { void sendMessage(entry.q) }}
                      className="w-full text-left flex items-center gap-3 px-4 py-3 transition-colors"
                      style={{ color: 'var(--ink-2)' }}
                    >
                      <Search size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} />
                      <span className="text-sm font-medium truncate flex-1">{entry.q}</span>
                      <ChevronRight size={13} style={{ color: 'var(--subtle)', flexShrink: 0 }} />
                    </button>
                    {/* Answer preview + share */}
                    {entry.answer && (
                      <div
                        className="px-4 pb-3 pt-0 flex items-start gap-2"
                        style={{ borderTop: '1px solid var(--border)' }}
                      >
                        <p className="text-xs flex-1 line-clamp-2" style={{ color: 'var(--muted)' }}>
                          {entry.answer.replace(/\*\*/g, '').slice(0, 160)}{entry.answer.length > 160 ? '…' : ''}
                        </p>
                        <div className="flex-shrink-0 pt-0.5">
                          <ShareLinkButton content={`**${entry.q}**\n\n${entry.answer}`} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* GLOSSARY PANEL */}
        {activePanel === 'glossary' && (
          <div className="px-4 py-4 space-y-3">
            <div
              className="flex items-center gap-2 rounded-xl px-3 py-2 border"
              style={{ background: 'var(--surface-muted)', borderColor: 'var(--border-strong)' }}
            >
              <Search size={14} style={{ color: 'var(--subtle)' }} />
              <input
                value={glossarySearch}
                onChange={e => setGlossarySearch(e.target.value)}
                placeholder="Search terms…"
                className="flex-1 bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink)', fontFamily: 'inherit' }}
              />
              {glossarySearch && (
                <button onClick={() => setGlossarySearch('')}>
                  <X size={13} style={{ color: 'var(--subtle)' }} />
                </button>
              )}
            </div>
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              {filteredGlossary.length} of {GLOSSARY.length} terms
            </p>
            <div className="space-y-1.5">
              {filteredGlossary.map(entry => (
                <div
                  key={entry.term}
                  className="rounded-xl px-4 py-3 border"
                  style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
                >
                  <p className="text-sm font-semibold mono mb-0.5" style={{ color: 'var(--ink)' }}>{entry.term}</p>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{entry.definition}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Market + Swap panel */}
        {activePanel === 'swap' && (
          <MarketSwapPanel darkMode={dark} />
        )}

        {/* Passkey wallet panel */}
        {activePanel === 'wallet' && (
          <div className="p-4 flex flex-col gap-4">
            <div>
              <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Circle Passkey Wallet</p>
              <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                An alternative to MetaMask — sign in with Face ID, Touch ID, or Windows Hello. Powered by Circle Modular Wallets (ERC-4337). Gas is sponsored on Arc.
              </p>
              <PasskeyWalletPanel
                darkMode={dark}
                onConnected={(addr) => { void addr }}
                onDisconnected={() => {}}
              />
            </div>

            {/* Console setup instructions */}
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Circle Console setup (one-time)</p>
              <ol className="text-xs space-y-1.5 list-decimal list-inside" style={{ color: 'var(--text-muted)' }}>
                <li>Go to <strong>console.circle.com → Keys → Client Keys → Create a key</strong></li>
                <li>Under <strong>Applicable Platforms → Web</strong>, set <strong>Allowed Domain</strong> to: <code className="bg-black/10 dark:bg-white/10 px-1 rounded text-[10px]">ibchwrygch1u2hlt0c9m4.preview.studio.arc.io</code></li>
                <li>Paste the Client Key into <code className="bg-black/10 dark:bg-white/10 px-1 rounded text-[10px]">VITE_CLIENT_KEY</code> in your <code className="bg-black/10 dark:bg-white/10 px-1 rounded text-[10px]">.env</code></li>
                <li>Go to <strong>Wallets → Modular Wallets → Configurator → Passkeys</strong> and set <strong>Domain Name</strong> to the same hostname above</li>
                <li>Restart the dev server, then test passkey registration in the preview</li>
              </ol>
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Do not use localhost or a parent domain — Circle requires an exact match to the preview iframe origin.
              </p>
            </div>

            {/* x402 info */}
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>x402 Agent Payments (backend)</p>
              <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                The <code className="bg-black/10 dark:bg-white/10 px-1 rounded">/api/chat</code> endpoint is gated behind Circle Gateway Nanopayments (x402). AI agents pay <strong>$0.001 USDC per query</strong> automatically via HTTP 402.
              </p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                To activate: add <code className="bg-black/10 dark:bg-white/10 px-1 rounded">SELLER_ADDRESS=0x...</code> (your EVM receive address) to <code className="bg-black/10 dark:bg-white/10 px-1 rounded">.env</code> and restart the server. Without it the endpoint is open.
              </p>
            </div>
          </div>
        )}

        {activePanel === 'owner' && (
          <div className="p-4">
            <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Owner Dashboard</p>
            <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              Live contract stats and admin controls. Connect the owner wallet to unlock withdraw, fee, and ownership actions.
            </p>
            <OwnerDashboard
              contractAddress={QUERY_PAYMENT_ADDRESS}
              chainId={ARC_CHAIN_ID}
              darkMode={dark}
            />
          </div>
        )}

        {activePanel === 'agent' && (
          <AgentStatusPanel darkMode={dark} />
        )}

        {activePanel === 'portfolio' && (
          <PortfolioPanel dark={dark} />
        )}

      </div>

      {/* Input bar — only on chat panel */}
      {activePanel === 'chat' && (
        <div
          className="sticky bottom-0 px-4 pb-6 pt-3 border-t"
          style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', backdropFilter: 'blur(16px)' }}
        >
          {/* Wallet status / query count bar */}
          {!isConnected ? (
            <div
              className="flex items-center gap-2.5 mb-2.5 px-3 py-2 rounded-xl border"
              style={{ background: 'var(--surface-muted)', borderColor: 'var(--border)' }}
            >
              <Wallet size={13} style={{ color: 'var(--muted)' }} />
              <span className="text-xs flex-1" style={{ color: 'var(--muted)' }}>
                Connect wallet to ask questions — $0.01 USDC per query
              </span>
              <ConnectKitButton.Custom>
                {({ show }) => (
                  <button
                    onClick={show}
                    className="text-xs font-semibold px-2.5 py-1 rounded-lg"
                    style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
                  >
                    Connect
                  </button>
                )}
              </ConnectKitButton.Custom>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 mb-2.5 px-3 py-1.5 rounded-xl border"
              style={{ background: userIsSubscribed ? (dark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.08)') : 'var(--surface-muted)', borderColor: userIsSubscribed ? '#10b981' : 'var(--border)' }}
            >
              {userIsSubscribed ? (
                <>
                  <Shield size={12} className="text-emerald-500 flex-shrink-0" />
                  <span className="text-xs text-emerald-500 font-semibold truncate">
                    Subscribed — {daysLeft === 1 ? '1 day left' : `${daysLeft} days left`}
                  </span>
                  {daysLeft <= 3 && daysLeft > 0 && (
                    <span className="ml-auto text-xs font-semibold flex-shrink-0 text-amber-500">Renew soon</span>
                  )}
                </>
              ) : (
                <>
                  <DollarSign size={12} style={{ color: 'var(--muted)' }} className="flex-shrink-0" />
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>$0.01/q</span>
                  {subscriptionFeeRaw !== undefined && (
                    <span className="text-xs flex-shrink-0" style={{ color: 'var(--subtle)' }}>or ${(Number(subscriptionFeeRaw) / 1e6).toFixed(2)}/mo</span>
                  )}
                  {userQueryCount !== undefined && userQueryCount > 0n && (
                    <span className="ml-auto text-xs font-semibold tabular-nums flex-shrink-0" style={{ color: 'var(--subtle)' }}>
                      {userQueryCount.toString()} paid
                    </span>
                  )}
                </>
              )}
            </div>
          )}

          {/* Category chips */}
          <div className="flex gap-1.5 mb-2.5 overflow-x-auto scrollbar-hide pb-0.5">
            {[
              { icon: TrendingUp, label: 'Prices', q: 'How do I check crypto prices?' },
              { icon: Coins, label: 'DeFi', q: 'What is DeFi?' },
              { icon: Shield, label: 'Security', q: 'How do I secure my crypto?' },
              { icon: Layers, label: 'Layer 2', q: 'What are Layer 2 networks?' },
              { icon: DollarSign, label: 'Staking', q: 'How does staking work?' },
            ].map(({ icon: Icon, label, q }) => (
              <button
                key={label}
                onClick={() => { void sendMessage(q) }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 border transition-colors"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--ink-2)' }}
              >
                <Icon size={11} style={{ color: 'var(--muted)' }} />
                {label}
              </button>
            ))}
          </div>
          <div
            className="flex items-end gap-2 rounded-2xl px-3 py-2 border"
            style={{ background: 'var(--surface-muted)', borderColor: 'var(--border-strong)' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about crypto…"
              rows={1}
              disabled={isTyping}
              className="flex-1 resize-none bg-transparent text-sm outline-none leading-relaxed py-1 min-h-[36px]"
              style={{ color: 'var(--ink)', maxHeight: '120px', fontFamily: 'inherit' }}
            />
            <button
              onClick={() => { void sendMessage(input) }}
              disabled={!input.trim() || isTyping}
              className="flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-xl transition-all disabled:opacity-40"
              style={{ background: 'var(--accent)', color: dark ? '#0d1b2f' : '#fff' }}
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-xs text-center mt-2" style={{ color: 'var(--subtle)' }}>
            Educational purposes only — not financial advice.
          </p>
        </div>
      )}

      {/* Shared answer modal — shown when page loads with a #q= fragment */}
      <SharedAnswerModal dark={dark} />

      {/* Session key setup modal */}
      <AnimatePresence>
        {showSessionSetup && address && (
          <SessionSetupModal
            dark={dark}
            address={address}
            queryFeeRaw={queryFeeFromContract ?? QUERY_FEE_RAW}
            onClose={() => setShowSessionSetup(false)}
            onActivated={() => setShowSessionSetup(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
