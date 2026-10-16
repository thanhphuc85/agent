/**
 * PasskeyWallet — Circle Modular Wallet with passkey (WebAuthn) auth
 * Offers alongside MetaMask as an alternative login option.
 * Uses Arc Mainnet (/arc path). Gas sponsored via Circle Gas Station paymaster.
 */
import { useState, useCallback } from 'react'
import {
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  toCircleSmartAccount,
} from '@circle-fin/modular-wallets-core'
import { toWebAuthnAccount } from 'viem/account-abstraction'
import { createPublicClient } from 'viem'
import { arc } from 'viem/chains'
import { toast } from 'sonner'
import { getUsdc } from '@/onchain-facts'

const CLIENT_KEY = import.meta.env.VITE_CLIENT_KEY as string | undefined
const CLIENT_URL = import.meta.env.VITE_CLIENT_URL as string | undefined

export type PasskeyWalletState =
  | { status: 'idle' }
  | { status: 'connected'; address: string; balance: string }
  | { status: 'loading'; message: string }

interface PasskeyWalletProps {
  darkMode: boolean
  onConnected: (address: string) => void
  onDisconnected: () => void
}

export function PasskeyWalletPanel({ darkMode, onConnected, onDisconnected }: PasskeyWalletProps) {
  const [state, setState] = useState<PasskeyWalletState>({ status: 'idle' })
  const [username, setUsername] = useState('')

  const usdcFact = getUsdc(arc.id)

  const text = darkMode ? 'text-white' : 'text-[#0d1421]'
  const subtext = darkMode ? 'text-[#8b9cc6] text-xs' : 'text-[#6b7280] text-xs'
  const inputCls = darkMode
    ? 'w-full bg-[#242938] border border-[#2a3044] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#1652f0]'
    : 'w-full bg-[#f7f8fa] border border-[#e8eaf0] rounded-lg px-3 py-2 text-[#0d1421] text-sm focus:outline-none focus:border-[#1652f0]'
  const card = darkMode
    ? 'bg-[#1a1f2e] border border-[#2a3044] rounded-xl p-4'
    : 'bg-white border border-[#e8eaf0] rounded-xl p-4'

  const connect = useCallback(async (mode: WebAuthnMode) => {
    if (!username.trim()) { toast.error('Enter a username'); return }
    if (!CLIENT_KEY || !CLIENT_URL) { toast.error('VITE_CLIENT_KEY not set in .env'); return }

    setState({ status: 'loading', message: mode === WebAuthnMode.Register ? 'Creating wallet…' : 'Signing in…' })
    try {
      const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY)
      const modularTransport = toModularTransport(`${CLIENT_URL}/arc`, CLIENT_KEY)

      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode,
        username: username.trim(),
      })

      const publicClient = createPublicClient({ chain: arc, transport: modularTransport })
      const smartAccount = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({ credential }),
      })

      const addr = smartAccount.address

      // Fetch USDC balance via raw contract read
      let balance = '0.00'
      if (usdcFact) {
        try {
          const raw = await publicClient.readContract({
            address: usdcFact.address as `0x${string}`,
            abi: [{
              name: 'balanceOf',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ type: 'uint256' }],
            }] as const,
            functionName: 'balanceOf',
            args: [addr],
          })
          balance = (Number(raw) / 1e6).toFixed(2)
        } catch { /* ignore read errors */ }
      }

      setState({ status: 'connected', address: addr, balance })
      onConnected(addr)
      toast.success(mode === WebAuthnMode.Register ? 'Wallet created!' : 'Signed in!')
      sessionStorage.setItem('passkeyUsername', username.trim())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Passkey failed'
      setState({ status: 'idle' })
      toast.error(msg)
    }
  }, [username, usdcFact, onConnected])

  const disconnect = useCallback(() => {
    setState({ status: 'idle' })
    sessionStorage.removeItem('passkeyUsername')
    onDisconnected()
    toast.success('Disconnected passkey wallet')
  }, [onDisconnected])

  if (state.status === 'connected') {
    return (
      <div className={`${card} flex flex-col gap-3`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={`${text} text-sm font-semibold`}>Passkey Wallet</p>
            <p className={subtext}>{state.address.slice(0, 8)}…{state.address.slice(-6)}</p>
          </div>
          <span className={`${darkMode ? 'bg-[#0d2a1a] text-[#4ade80]' : 'bg-[#dcfce7] text-[#166534]'} text-xs px-2 py-0.5 rounded-full font-medium`}>
            Connected
          </span>
        </div>
        <div className={`${darkMode ? 'bg-[#0f1623] border border-[#2a3044]' : 'bg-[#f7f8fa] border border-[#e8eaf0]'} rounded-lg px-3 py-2 flex justify-between items-center`}>
          <span className={subtext}>USDC balance</span>
          <span className={`${text} text-sm font-semibold`}>${state.balance}</span>
        </div>
        <p className={`${subtext} text-center`}>Gas sponsored · Arc Mainnet · ERC-4337</p>
        <button onClick={disconnect} className={`text-xs underline ${darkMode ? 'text-[#8b9cc6]' : 'text-[#6b7280]'} hover:opacity-70`}>
          Disconnect passkey wallet
        </button>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className={`${card} text-center`}>
        <div className="animate-spin w-6 h-6 border-2 border-[#1652f0] border-t-transparent rounded-full mx-auto mb-3" />
        <p className={`${text} text-sm`}>{state.message}</p>
        <p className={subtext}>Check your browser's passkey prompt</p>
      </div>
    )
  }

  return (
    <div className={`${card} flex flex-col gap-3`}>
      <div>
        <p className={`${text} text-sm font-semibold mb-1`}>Passkey Wallet</p>
        <p className={subtext}>No seed phrase. Sign in with Face ID / Touch ID / Windows Hello. Gas-free on Arc.</p>
      </div>

      {!CLIENT_KEY && (
        <div className={`${darkMode ? 'bg-[#2a1a0a] border border-[#6b3a1a]' : 'bg-[#fff7ed] border border-[#fed7aa]'} rounded-lg p-3`}>
          <p className={`${darkMode ? 'text-[#fb923c]' : 'text-[#c2410c]'} text-xs`}>
            Add <code className="bg-black/10 px-1 rounded">VITE_CLIENT_KEY</code> to{' '}
            <code className="bg-black/10 px-1 rounded">.env</code> to enable passkey wallets.
          </p>
        </div>
      )}

      <div>
        <label className={`${subtext} block mb-1`}>Username</label>
        <input
          type="text"
          placeholder="e.g. alice"
          value={username}
          onChange={e => setUsername(e.target.value)}
          className={inputCls}
          disabled={!CLIENT_KEY}
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => void connect(WebAuthnMode.Register)}
          disabled={!CLIENT_KEY || !username.trim()}
          className="flex-1 py-2 rounded-lg bg-[#1652f0] text-white text-sm font-semibold hover:bg-[#1245d4] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Create wallet
        </button>
        <button
          onClick={() => void connect(WebAuthnMode.Login)}
          disabled={!CLIENT_KEY || !username.trim()}
          className={`flex-1 py-2 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${darkMode ? 'border-[#2a3044] text-[#8b9cc6] hover:border-[#4a5580]' : 'border-[#e8eaf0] text-[#6b7280] hover:border-[#c0c8d8]'}`}
        >
          Sign in
        </button>
      </div>
    </div>
  )
}
