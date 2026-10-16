/**
 * OwnerDashboard — live stats, admin controls, and analytics for QueryPayment.
 * Includes subscription fee management, 48h fee timelock, two-step ownership,
 * and a query analytics tab with charts.
 */
import { useState } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { toast } from 'sonner'
import { getUsdc, buildTxExplorerUrl } from '@/onchain-facts'
import { TrendingUp, DollarSign, Users, Settings, Download, RefreshCw, ExternalLink, BarChart2, Shield } from 'lucide-react'
import { QueryAnalytics } from './QueryAnalytics'

// Module-level constant — computed once at import time, not during any render
const MODULE_LOAD_SECS = BigInt(Math.floor(Date.now() / 1000))

interface OwnerDashboardProps {
  contractAddress: `0x${string}`
  chainId: number
  darkMode: boolean
}

const QUERY_ABI = [
  { name: 'queryFee',                    type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'subscriptionFee',             type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'totalQueriesPaid',            type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'totalSubscriptions',          type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'owner',                       type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'address' }] },
  { name: 'pendingOwner',               type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'address' }] },
  { name: 'pendingQueryFee',            type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'pendingQueryFeeActiveAt',    type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'pendingSubscriptionFee',     type: 'function', stateMutability: 'view',       inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'pendingSubscriptionFeeActiveAt', type: 'function', stateMutability: 'view',   inputs: [],                                                                         outputs: [{ type: 'uint256' }] },
  { name: 'setQueryFee',                type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newFee',    type: 'uint256' }],                                   outputs: [] },
  { name: 'applyQueryFee',             type: 'function', stateMutability: 'nonpayable', inputs: [],                                                                         outputs: [] },
  { name: 'setSubscriptionFee',         type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newFee',    type: 'uint256' }],                                   outputs: [] },
  { name: 'applySubscriptionFee',      type: 'function', stateMutability: 'nonpayable', inputs: [],                                                                         outputs: [] },
  { name: 'withdraw',                   type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],     outputs: [] },
  { name: 'withdrawAll',                type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }],                                          outputs: [] },
  { name: 'transferOwnership',          type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }],                                    outputs: [] },
  { name: 'acceptOwnership',           type: 'function', stateMutability: 'nonpayable', inputs: [],                                                                         outputs: [] },
] as const

const ERC20_BALANCE_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

type DashTab = 'stats' | 'analytics' | 'admin'

function StatCard({ icon, label, value, dark, loading }: { icon: React.ReactNode; label: string; value: string; dark: boolean; loading: boolean }) {
  const cardCls = dark ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-xl p-3' : 'bg-white border border-[#e8eaf0] rounded-xl p-3 shadow-sm'
  return (
    <div className={cardCls}>
      <div className={`flex items-center gap-1.5 mb-1 ${dark ? 'text-[#8b9cc6]' : 'text-[#6b7280]'} text-xs`}>
        {icon} {label}
      </div>
      {loading ? <div className={`h-5 w-16 rounded ${dark ? 'bg-[#2a3044]' : 'bg-[#f0f2f5]'} animate-pulse`} /> : (
        <p className={`text-lg font-bold ${dark ? 'text-white' : 'text-[#0d1421]'}`}>{value}</p>
      )}
    </div>
  )
}

export function OwnerDashboard({ contractAddress, chainId, darkMode: dark }: OwnerDashboardProps) {
  const { address } = useAccount()
  const usdcFact = getUsdc(chainId)!
  const usdcDecimals = usdcFact.decimals
  const [tab, setTab] = useState<DashTab>('stats')

  const [newQueryFee, setNewQueryFee]       = useState('')
  const [newSubFee, setNewSubFee]           = useState('')
  const [withdrawTo, setWithdrawTo]         = useState('')
  const [withdrawAmt, setWithdrawAmt]       = useState('')
  const [newOwner, setNewOwner]             = useState('')

  const { data: reads, isFetching, refetch } = useReadContracts({
    contracts: [
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'queryFee',                    chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'subscriptionFee',             chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'totalQueriesPaid',            chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'totalSubscriptions',          chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'owner',                       chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'pendingOwner',               chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'pendingQueryFee',            chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'pendingQueryFeeActiveAt',    chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'pendingSubscriptionFee',     chainId },
      { address: contractAddress,                   abi: QUERY_ABI,         functionName: 'pendingSubscriptionFeeActiveAt', chainId },
      { address: usdcFact.address as `0x${string}`, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', chainId, args: [contractAddress] },
    ],
  })

  const queryFee              = reads?.[0].result
  const subscriptionFee       = reads?.[1].result
  const totalQueriesPaid      = reads?.[2].result
  const totalSubscriptions    = reads?.[3].result
  const owner                 = reads?.[4].result
  const pendingOwner          = reads?.[5].result
  const pendingQF             = reads?.[6].result
  const pendingQFActiveAt     = reads?.[7].result
  const pendingSF             = reads?.[8].result
  const pendingSFActiveAt     = reads?.[9].result
  const contractBalance       = reads?.[10].result

  const { writeContract, data: txHash, isPending } = useWriteContract()
  const { isLoading: confirming } = useWaitForTransactionReceipt({ hash: txHash, query: { enabled: !!txHash } })

  const isOwner = address && owner && address.toLowerCase() === owner.toLowerCase()
  const isPendingOwner = address && pendingOwner && address.toLowerCase() === pendingOwner.toLowerCase()
  const busy = isPending || confirming
  const loading = isFetching

  const fmt = (raw: bigint) => parseFloat(formatUnits(raw, usdcDecimals)).toFixed(2)
  const fmtTs = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleString()
  const qfReady = pendingQFActiveAt && pendingQFActiveAt > 0n && MODULE_LOAD_SECS >= pendingQFActiveAt
  const sfReady = pendingSFActiveAt && pendingSFActiveAt > 0n && MODULE_LOAD_SECS >= pendingSFActiveAt

  const handleWrite = (args: Parameters<typeof writeContract>[0]) => {
    writeContract(args, {
      onSuccess: () => toast.loading('Waiting for confirmation…', { id: 'tx-confirm', duration: 30000 }),
      onError: (e) => toast.error(e.message.slice(0, 120)),
    })
  }
  const handleRefresh = () => { void refetch().then(() => toast.success('Refreshed')) }

  // Styles
  const card = dark ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-xl p-4' : 'bg-white border border-[#e8eaf0] rounded-xl p-4 shadow-sm'
  const text  = dark ? 'text-white' : 'text-[#0d1421]'
  const sub   = dark ? 'text-[#8b9cc6]' : 'text-[#6b7280]'
  const subXs = `${sub} text-xs`
  const inp   = dark
    ? 'w-full bg-[#242938] border border-[#2a3044] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#1652f0]'
    : 'w-full bg-[#f7f8fa] border border-[#e8eaf0] rounded-lg px-3 py-2 text-[#0d1421] text-sm focus:outline-none focus:border-[#1652f0]'
  const btnBlue = 'px-3 py-1.5 rounded-lg bg-[#1652f0] text-white text-xs font-semibold hover:bg-[#1245d4] disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
  const btnRed  = 'px-3 py-1.5 rounded-lg bg-[#ef4444] text-white text-xs font-semibold hover:bg-[#dc2626] disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
  const btnGreen = 'px-3 py-1.5 rounded-lg bg-[#10b981] text-white text-xs font-semibold hover:bg-[#059669] disabled:opacity-40 disabled:cursor-not-allowed transition-colors'

  const tabActive = dark ? 'bg-[#1652f0] text-white' : 'bg-[#1652f0] text-white'
  const tabInactive = dark ? 'text-[#8b9cc6] hover:bg-[#2a3044]' : 'text-[#6b7280] hover:bg-[#f0f2f5]'

  const tabs: { id: DashTab; label: string; icon: React.ReactNode }[] = [
    { id: 'stats',     label: 'Stats',     icon: <TrendingUp size={12} /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart2 size={12} /> },
    { id: 'admin',     label: 'Admin',     icon: <Settings size={12} /> },
  ]

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Tab bar */}
      <div className={`flex gap-1 p-1 rounded-xl ${dark ? 'bg-[#242938]' : 'bg-[#f0f2f5]'}`}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${tab === t.id ? tabActive : tabInactive}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* STATS TAB */}
      {tab === 'stats' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatCard icon={<Users size={14} />}      label="Total queries"       value={totalQueriesPaid  !== undefined ? totalQueriesPaid.toString()            : '—'} dark={dark} loading={loading} />
            <StatCard icon={<Shield size={14} />}     label="Subscriptions"       value={totalSubscriptions !== undefined ? totalSubscriptions.toString()          : '—'} dark={dark} loading={loading} />
            <StatCard icon={<DollarSign size={14} />} label="Contract balance"    value={contractBalance   !== undefined ? `$${fmt(contractBalance)}`              : '—'} dark={dark} loading={loading} />
            <StatCard icon={<TrendingUp size={14} />} label="Query fee"           value={queryFee          !== undefined ? `$${fmt(queryFee)}`                     : '—'} dark={dark} loading={loading} />
            <StatCard icon={<DollarSign size={14} />} label="Subscription fee"    value={subscriptionFee   !== undefined ? `$${fmt(subscriptionFee)}/mo`           : '—'} dark={dark} loading={loading} />
            <div onClick={() => setTab('analytics')} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && setTab('analytics')} className="cursor-pointer">
              <StatCard
                icon={<TrendingUp size={14} />}
                label="True earnings (event-sourced)"
                value="→ Analytics"
                dark={dark}
                loading={false}
              />
            </div>
          </div>

          <div className={card}>
            <div className="flex items-center justify-between mb-2">
              <span className={`${text} text-xs font-semibold`}>Contract</span>
              <button onClick={handleRefresh} className={`${subXs} hover:opacity-70 flex items-center gap-1`}>
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
            <p className={`${subXs} font-mono break-all`}>{contractAddress}</p>
            <a href={buildTxExplorerUrl(chainId, contractAddress).replace('/tx/', '/address/')} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 mt-1 text-[#1652f0] text-xs hover:underline">
              View on explorer <ExternalLink size={10} />
            </a>
            {owner && (
              <p className={`${subXs} mt-2`}>
                Owner: <span className="font-mono">{owner.slice(0, 8)}…{owner.slice(-6)}</span>
                {isOwner && <span className={`ml-2 ${dark ? 'bg-[#0d2a1a] text-[#4ade80]' : 'bg-[#dcfce7] text-[#166534]'} text-xs px-1.5 py-0.5 rounded-full`}>You</span>}
              </p>
            )}
            {pendingOwner && pendingOwner !== '0x0000000000000000000000000000000000000000' && (
              <p className={`${subXs} mt-1 text-amber-400`}>Pending owner: <span className="font-mono">{pendingOwner.slice(0, 8)}…{pendingOwner.slice(-6)}</span></p>
            )}
          </div>

          {/* Pending fee changes */}
          {(pendingQF !== undefined && pendingQF > 0n) && (
            <div className={`${dark ? 'bg-[#1a1a0a] border-[#3a3a0a]' : 'bg-[#fffbeb] border-[#fde68a]'} border rounded-xl p-3`}>
              <p className={`text-xs font-semibold ${dark ? 'text-amber-300' : 'text-amber-700'} mb-1`}>Pending query fee change</p>
              <p className={subXs}>New fee: ${fmt(pendingQF)} — active {pendingQFActiveAt ? fmtTs(pendingQFActiveAt) : '—'}</p>
              <button disabled={busy || !qfReady} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'applyQueryFee' })} className={`mt-2 ${btnGreen}`}>
                {qfReady ? 'Apply now' : 'Not ready yet'}
              </button>
            </div>
          )}
          {(pendingSF !== undefined && pendingSF > 0n) && (
            <div className={`${dark ? 'bg-[#1a1a0a] border-[#3a3a0a]' : 'bg-[#fffbeb] border-[#fde68a]'} border rounded-xl p-3`}>
              <p className={`text-xs font-semibold ${dark ? 'text-amber-300' : 'text-amber-700'} mb-1`}>Pending subscription fee change</p>
              <p className={subXs}>New fee: ${fmt(pendingSF)}/mo — active {pendingSFActiveAt ? fmtTs(pendingSFActiveAt) : '—'}</p>
              <button disabled={busy || !sfReady} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'applySubscriptionFee' })} className={`mt-2 ${btnGreen}`}>
                {sfReady ? 'Apply now' : 'Not ready yet'}
              </button>
            </div>
          )}

          {/* Accept ownership (for pending owner) */}
          {isPendingOwner && (
            <div className={`${dark ? 'bg-[#0a1a2e] border-[#1652f0]' : 'bg-[#eff6ff] border-[#93c5fd]'} border rounded-xl p-3`}>
              <p className={`text-xs font-semibold ${dark ? 'text-blue-300' : 'text-blue-700'} mb-1`}>You are the pending owner</p>
              <p className={`${subXs} mb-2`}>Accept ownership to become the contract owner.</p>
              <button disabled={busy} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'acceptOwnership' })} className={btnBlue}>
                Accept ownership
              </button>
            </div>
          )}
        </>
      )}

      {/* ANALYTICS TAB */}
      {tab === 'analytics' && (
        <QueryAnalytics contractAddress={contractAddress} dark={dark} />
      )}

      {/* ADMIN TAB */}
      {tab === 'admin' && (
        <>
          {!address && (
            <div className={`${dark ? 'bg-[#1a1f0a] border border-[#3a4014]' : 'bg-[#fffbeb] border border-[#fde68a]'} rounded-xl p-4 text-center`}>
              <p className={`${dark ? 'text-[#fbbf24]' : 'text-[#92400e]'} text-sm`}>Connect your wallet to access admin controls.</p>
            </div>
          )}
          {address && owner && !isOwner && (
            <div className={`${dark ? 'bg-[#1a0f0a] border border-[#3a2014]' : 'bg-[#fff7ed] border border-[#fed7aa]'} rounded-xl p-4 text-center`}>
              <p className={`${dark ? 'text-[#fb923c]' : 'text-[#c2410c]'} text-sm`}>Connected wallet is not the contract owner.</p>
              {owner && <p className={`${subXs} mt-1`}>Owner: {owner.slice(0, 8)}…{owner.slice(-6)}</p>}
            </div>
          )}

          {isOwner && (
            <>
              {/* Withdraw */}
              <div className={card}>
                <div className="flex items-center gap-2 mb-3">
                  <Download size={14} className="text-[#1652f0]" />
                  <span className={`${text} text-sm font-semibold`}>Withdraw USDC</span>
                </div>
                <p className={`${subXs} mb-3`}>Balance: <span className="font-semibold">{contractBalance !== undefined ? `$${fmt(contractBalance)}` : '—'}</span></p>
                <div className="flex flex-col gap-2">
                  <div>
                    <label className={`${subXs} block mb-1`}>Recipient address</label>
                    <input value={withdrawTo} onChange={e => setWithdrawTo(e.target.value)} placeholder="0x…" className={inp} />
                  </div>
                  <div>
                    <label className={`${subXs} block mb-1`}>Amount (USDC) — blank = withdraw all</label>
                    <input value={withdrawAmt} onChange={e => setWithdrawAmt(e.target.value)} placeholder="e.g. 5.00" type="number" min="0" step="0.01" className={inp} />
                  </div>
                  <div className="flex gap-2">
                    <button disabled={busy || !withdrawTo} onClick={() => {
                      const to = withdrawTo as `0x${string}`
                      if (withdrawAmt) {
                        handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'withdraw', args: [to, parseUnits(withdrawAmt, usdcDecimals)] })
                      } else {
                        handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'withdrawAll', args: [to] })
                      }
                    }} className={btnBlue}>
                      {busy ? 'Sending…' : withdrawAmt ? `Withdraw $${withdrawAmt}` : 'Withdraw all'}
                    </button>
                    <button onClick={() => setWithdrawTo(address || '')} className={`${dark ? 'text-[#8b9cc6] border-[#2a3044]' : 'text-[#6b7280] border-[#e8eaf0]'} border px-3 py-1.5 rounded-lg text-xs hover:opacity-70`}>My address</button>
                  </div>
                </div>
              </div>

              {/* Query fee */}
              <div className={card}>
                <div className="flex items-center gap-2 mb-3">
                  <Settings size={14} className="text-[#1652f0]" />
                  <span className={`${text} text-sm font-semibold`}>Query fee (per query)</span>
                </div>
                <p className={`${subXs} mb-1`}>Current: <span className="font-semibold">{queryFee !== undefined ? `$${fmt(queryFee)}` : '—'}</span> — Changes take 48 hours to activate.</p>
                <div className="flex gap-2 mb-2 flex-wrap">
                  {['0.01','0.05','0.10','0.25'].map(v => (
                    <button key={v} onClick={() => setNewQueryFee(v)} className={`text-xs px-2 py-1 rounded-lg border ${dark ? 'border-[#2a3044] text-[#8b9cc6] hover:bg-[#2a3044]' : 'border-[#e8eaf0] text-[#6b7280] hover:bg-[#f0f2f5]'}`}>${v}</button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={newQueryFee} onChange={e => setNewQueryFee(e.target.value)} placeholder="0.01" type="number" min="0.000001" step="0.001" className={inp} />
                  <button disabled={busy || !newQueryFee} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'setQueryFee', args: [parseUnits(newQueryFee, usdcDecimals)] })} className={btnBlue}>Queue</button>
                </div>
                {pendingQF !== undefined && pendingQF > 0n && (
                  <p className={`${subXs} mt-2 text-amber-400`}>Queued: ${fmt(pendingQF)} — active {pendingQFActiveAt ? fmtTs(pendingQFActiveAt) : '—'}</p>
                )}
              </div>

              {/* Subscription fee */}
              <div className={card}>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={14} className="text-[#1652f0]" />
                  <span className={`${text} text-sm font-semibold`}>Subscription fee (per month)</span>
                </div>
                <p className={`${subXs} mb-1`}>Current: <span className="font-semibold">{subscriptionFee !== undefined ? `$${fmt(subscriptionFee)}/mo` : '—'}</span> — Changes take 48 hours to activate.</p>
                <div className="flex gap-2 mb-2 flex-wrap">
                  {['0.99','1.99','2.99','4.99'].map(v => (
                    <button key={v} onClick={() => setNewSubFee(v)} className={`text-xs px-2 py-1 rounded-lg border ${dark ? 'border-[#2a3044] text-[#8b9cc6] hover:bg-[#2a3044]' : 'border-[#e8eaf0] text-[#6b7280] hover:bg-[#f0f2f5]'}`}>${v}</button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input value={newSubFee} onChange={e => setNewSubFee(e.target.value)} placeholder="0.99" type="number" min="0.000001" step="0.01" className={inp} />
                  <button disabled={busy || !newSubFee} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'setSubscriptionFee', args: [parseUnits(newSubFee, usdcDecimals)] })} className={btnBlue}>Queue</button>
                </div>
                {pendingSF !== undefined && pendingSF > 0n && (
                  <p className={`${subXs} mt-2 text-amber-400`}>Queued: ${fmt(pendingSF)}/mo — active {pendingSFActiveAt ? fmtTs(pendingSFActiveAt) : '—'}</p>
                )}
              </div>

              {/* Transfer ownership */}
              <div className={card}>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={14} className="text-[#ef4444]" />
                  <span className={`${text} text-sm font-semibold`}>Transfer ownership</span>
                </div>
                <p className={`${subXs} mb-3`}>Two-step: the new owner must call acceptOwnership() from their wallet to complete the transfer.</p>
                <div className="flex gap-2">
                  <input value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder="0x… new owner address" className={inp} />
                  <button disabled={busy || !newOwner} onClick={() => handleWrite({ address: contractAddress, abi: QUERY_ABI, functionName: 'transferOwnership', args: [newOwner] })} className={btnRed}>Transfer</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
