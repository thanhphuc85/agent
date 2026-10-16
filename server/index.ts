import express from 'express'
import { GoogleGenAI } from '@google/genai'
import Groq from 'groq-sdk'
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server'
import { rateLimit } from 'express-rate-limit'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TelegramBot = require('node-telegram-bot-api') as typeof import('node-telegram-bot-api').default
import webpush from 'web-push'
import cron from 'node-cron'
import fs from 'fs'
import path from 'path'
import { USDC_ADDRESS, CONTRACT_ADDRESS, getArcRpc } from './chain-config.ts'
import { keccak256, toBytes, toHex } from 'viem'
import {
  loadPortfolios, savePortfolios, loadRules, saveRules, loadAlerts, saveAlerts,
  parseRuleWithGroq, evaluateRule, scorePortfolioRisk, ARC_YIELD_TABLE,
  type PortfolioSnapshot, type AutomationRule, type Alert,
} from './portfolio.ts'

const app = express()
app.use(express.json())

const DATA_DIR = path.join(import.meta.dir, 'data')

// ── Live market data cache ─────────────────────────────────────────────────
interface CoinSnapshot {
  symbol: string; name: string; price: number
  change24h: number; marketCapRank: number; volume24h: number; marketCap: number
}
interface MarketCache { data: CoinSnapshot[]; fetchedAt: number }
let marketCache: MarketCache | null = null
const MARKET_CACHE_TTL_MS = 60_000

async function fetchMarketContext(): Promise<CoinSnapshot[]> {
  const now = Date.now()
  if (marketCache && now - marketCache.fetchedAt < MARKET_CACHE_TTL_MS) return marketCache.data
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h'
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`)
    const raw = await resp.json() as Array<{
      symbol: string; name: string; current_price: number
      price_change_percentage_24h: number; market_cap_rank: number
      total_volume: number; market_cap: number
    }>
    const data: CoinSnapshot[] = raw.map(c => ({
      symbol: c.symbol.toUpperCase(), name: c.name, price: c.current_price,
      change24h: c.price_change_percentage_24h ?? 0, marketCapRank: c.market_cap_rank,
      volume24h: c.total_volume, marketCap: c.market_cap,
    }))
    marketCache = { data, fetchedAt: now }
    console.log(`[market] Fetched ${data.length} coins from CoinGecko`)
    return data
  } catch (err) {
    console.warn('[market] CoinGecko fetch failed:', err instanceof Error ? err.message : err)
    return marketCache?.data ?? []
  }
}

function buildMarketBlock(coins: CoinSnapshot[]): string {
  if (coins.length === 0) return ''
  const fmt = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toLocaleString()}`
  const rows = coins.slice(0, 15).map(c => {
    const sign = c.change24h >= 0 ? '+' : ''
    return `${c.symbol} (${c.name}): $${c.price.toLocaleString(undefined, { maximumFractionDigits: c.price < 1 ? 6 : 2 })} | 24h: ${sign}${c.change24h.toFixed(2)}% | Vol: ${fmt(c.volume24h)} | MCap: ${fmt(c.marketCap)}`
  }).join('\n')
  return `\n\n[LIVE MARKET DATA — as of ${new Date().toUTCString()}]\n${rows}\n[Use these real prices and changes when answering. Never say you cannot access live data.]`
}

// ── On-chain event poller ──────────────────────────────────────────────────
interface ChainEvent {
  id: string; type: 'QueryPaid' | 'Subscribed' | 'UsdcTransfer'
  blockNumber: string; txHash: string; from: string; amountUsdc: string; timestamp: number
}
interface EventCache { events: ChainEvent[]; lastBlock: string; updatedAt: number }

const EVENTS_FILE = path.join(DATA_DIR, 'events-cache.json')
const SSE_CLIENTS = new Set<express.Response>()

// AI fallback health tracking
interface FallbackLog { tier: 'groq' | 'gemini' | 'local'; reason: string; at: number }
const fallbackLog: FallbackLog[] = []
let currentTier: 'groq' | 'gemini' | 'local' = 'groq'

function loadEventCache(): EventCache {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8')) as EventCache }
  catch { return { events: [], lastBlock: '0x0', updatedAt: 0 } }
}
function saveEventCache(cache: EventCache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(cache, null, 2))
}
function broadcastEvent(ev: ChainEvent): void {
  const msg = `data: ${JSON.stringify(ev)}\n\n`
  for (const client of SSE_CLIENTS) {
    try { client.write(msg) } catch { SSE_CLIENTS.delete(client) }
  }
}

// Minimal JSON-RPC helper
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpcUrl = getArcRpc()
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await resp.json() as { result?: T; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

// Compute keccak256 topic hashes from ABI event signatures at startup
function eventTopic(sig: string): string { return keccak256(toBytes(toHex(new TextEncoder().encode(sig)))) }
// QueryPaid(address indexed,uint256,uint256)
const TOPIC_QUERY_PAID   = eventTopic('QueryPaid(address,uint256,uint256)')
// Subscribed(address indexed,uint256,uint256)
const TOPIC_SUBSCRIBED   = eventTopic('Subscribed(address,uint256,uint256)')
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value) — standard, unchanging
const USDC_TRANSFER_TOPIC = keccak256(toBytes(toHex(new TextEncoder().encode('Transfer(address,address,uint256)'))))

function topicToAddr(t: string): string { return '0x' + t.slice(26) }
function dataToUint(data: string, offset = 0): bigint {
  if (!data || data === '0x') return 0n
  return BigInt('0x' + data.slice(2 + offset * 64, 2 + (offset + 1) * 64))
}

async function pollOnchainEvents(): Promise<void> {
  try {
    const cache = loadEventCache()
    const latestHex = await rpc<string>('eth_blockNumber', [])
    const latest = BigInt(latestHex)
    const fromBlock = cache.lastBlock === '0x0' ? latest - 14400n : BigInt(cache.lastBlock) + 1n
    if (fromBlock > latest) return
    const toBlock = fromBlock + 500n > latest ? latest : fromBlock + 500n

    interface RawLog {
      address: string; topics: string[]; data: string
      blockNumber: string; transactionHash: string
    }

    // Fetch all events from the contract (no topic filter — detect by data/topic count)
    const contractLogs = await rpc<RawLog[]>('eth_getLogs', [{
      address: CONTRACT_ADDRESS,
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock:   '0x' + toBlock.toString(16),
    }])

    // USDC transfers TO the contract
    const usdcLogs = await rpc<RawLog[]>('eth_getLogs', [{
      address: USDC_ADDRESS,
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock:   '0x' + toBlock.toString(16),
      topics: [USDC_TRANSFER_TOPIC, null, '0x' + CONTRACT_ADDRESS.slice(2).padStart(64, '0')],
    }])

    const newEvents: ChainEvent[] = []

    for (const log of contractLogs) {
      const topic0 = log.topics[0] ?? ''
      // Detect event type: QueryPaid has 3 indexed params (4 topics), Subscribed has 3 indexed params
      // Both are 3-topic events (topic0 = sig, topic1 = user address, data = fee + extra)
      const isKnownQueryPaid   = topic0 === TOPIC_QUERY_PAID
      const isKnownSubscribed  = topic0 === TOPIC_SUBSCRIBED
      // Fallback detection: if topic0 is unknown but log has 2 topics + data, classify by data length
      const likelyQueryPaid = !isKnownSubscribed && log.topics.length >= 2 && log.data.length > 2
      const eventType = isKnownSubscribed ? 'Subscribed' : (isKnownQueryPaid || likelyQueryPaid) ? 'QueryPaid' : null
      if (!eventType) continue

      const userAddr = log.topics[1] ? topicToAddr(log.topics[1]) : '0x?'
      const amount   = dataToUint(log.data, 0)
      const ev: ChainEvent = {
        id: `${log.transactionHash}-${topic0.slice(0, 10)}`,
        type: eventType,
        blockNumber: String(parseInt(log.blockNumber, 16)),
        txHash: log.transactionHash,
        from: userAddr,
        amountUsdc: (Number(amount) / 1e6).toFixed(6),
        timestamp: Date.now(),
      }
      newEvents.push(ev)

      // Telegram alert for large payments (>$1 USDC)
      if (Number(ev.amountUsdc) >= 1 && tgBot && TELEGRAM_CHAT_ID) {
        const label = eventType === 'Subscribed' ? 'New subscription' : 'Query payment'
        void tgBot.sendMessage(
          TELEGRAM_CHAT_ID,
          `🔔 *${label}*\nFrom: \`${userAddr.slice(0, 10)}…\`\nAmount: $${ev.amountUsdc} USDC`,
          { parse_mode: 'Markdown' },
        ).catch(() => null)
      }
    }

    for (const log of usdcLogs) {
      const from2  = log.topics[1] ? topicToAddr(log.topics[1]) : '0x?'
      const amount = dataToUint(log.data, 0)
      const ev: ChainEvent = {
        id: `${log.transactionHash}-usdc`,
        type: 'UsdcTransfer',
        blockNumber: String(parseInt(log.blockNumber, 16)),
        txHash: log.transactionHash,
        from: from2,
        amountUsdc: (Number(amount) / 1e6).toFixed(6),
        timestamp: Date.now(),
      }
      newEvents.push(ev)
    }

    if (newEvents.length > 0) {
      cache.events = [...newEvents, ...cache.events].slice(0, 500)
      for (const ev of newEvents) broadcastEvent(ev)
      console.log(`[chain] ${newEvents.length} new event(s) (blocks ${fromBlock}–${toBlock})`)
    }
    cache.lastBlock = '0x' + toBlock.toString(16)
    cache.updatedAt = Date.now()
    saveEventCache(cache)
  } catch (err) {
    console.warn('[chain] Poll error:', err instanceof Error ? err.message : err)
  }
}

cron.schedule('*/30 * * * * *', () => { void pollOnchainEvents() })

// ── Portfolio monitor cron (every 60s) ────────────────────────────────────

function broadcastAlert(alert: Alert): void {
  const msg = `data: ${JSON.stringify({ type: 'alert', alert })}\n\n`
  for (const client of SSE_CLIENTS) {
    try { client.write(msg) } catch { SSE_CLIENTS.delete(client) }
  }
}

async function runPortfolioMonitor(): Promise<void> {
  const portfolios = loadPortfolios()
  if (portfolios.length === 0) return
  const rules = loadRules()
  const coins = marketCache?.data ?? []
  const now = Date.now()
  const newAlerts: Alert[] = []

  for (const portfolio of portfolios) {
    // Refresh USDC balance from chain
    try {
      const balHex = await rpc<string>('eth_call', [{
        to: USDC_ADDRESS,
        data: '0x70a08231' + portfolio.wallet.slice(2).padStart(64, '0'),
      }, 'latest'])
      portfolio.prevUsdcBalance = portfolio.usdcBalance
      portfolio.usdcBalance = BigInt(balHex).toString()

      // Contract balance
      const cBalHex = await rpc<string>('eth_call', [{
        to: USDC_ADDRESS,
        data: '0x70a08231' + CONTRACT_ADDRESS.slice(2).padStart(64, '0'),
      }, 'latest'])
      portfolio.contractUsdcBalance = BigInt(cBalHex).toString()
      portfolio.updatedAt = now
    } catch {
      // RPC failure — use cached values
    }

    // Evaluate rules for this wallet
    const walletRules = rules.filter(r => r.wallet.toLowerCase() === portfolio.wallet.toLowerCase())
    for (const rule of walletRules) {
      const alert = evaluateRule(rule, portfolio, coins, now)
      if (alert) {
        newAlerts.push(alert)
        rule.lastFiredAt = now
        // Telegram alert
        if (tgBot && TELEGRAM_CHAT_ID) {
          const emoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️'
          void tgBot.sendMessage(
            TELEGRAM_CHAT_ID,
            `${emoji} *Portfolio Alert*\nWallet: \`${portfolio.wallet.slice(0, 10)}…\`\n${alert.message}`,
            { parse_mode: 'Markdown' },
          ).catch(() => null)
        }
        broadcastAlert(alert)
        console.log(`[portfolio] Alert fired for ${portfolio.wallet.slice(0, 10)}: ${alert.message}`)
      }
    }
  }

  savePortfolios(portfolios)
  saveRules(rules)
  if (newAlerts.length > 0) {
    const existing = loadAlerts()
    saveAlerts([...newAlerts, ...existing].slice(0, 200))
  }
}

cron.schedule('*/60 * * * * *', () => { void runPortfolioMonitor() })

// ── VAPID setup ────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_EMAIL   = process.env.VAPID_EMAIL       ?? 'mailto:admin@cryptoadvisor.app'
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE)

const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json')
interface StoredSub { wallet: string; subscription: webpush.PushSubscription; createdAt: string }
function loadSubs(): StoredSub[] {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8')) as StoredSub[] }
  catch { return [] }
}
function saveSubs(subs: StoredSub[]): void {
  fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true })
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2))
}

// ── Rate limiter ───────────────────────────────────────────────────────────
const chatRateLimit = rateLimit({
  windowMs: 60_000, max: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many requests — limit is 20 per minute. Please slow down.' },
})

// ── Admin auth ─────────────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? ''
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!ADMIN_SECRET) { next(); return }
  if (req.headers['x-admin-secret'] === ADMIN_SECRET) { next(); return }
  res.status(401).json({ error: 'Unauthorized' })
}

// ── Telegram bot ────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? ''
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID   ?? ''
let tgBot: TelegramBot | null = null
if (TELEGRAM_TOKEN) tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false })

// ── x402 Gateway ──────────────────────────────────────────────────────────
const gateway = process.env.SELLER_ADDRESS
  ? createGatewayMiddleware({ sellerAddress: process.env.SELLER_ADDRESS })
  : null

// ── Groq ───────────────────────────────────────────────────────────────────
let groq: Groq | null = null
function getGroq(): Groq | null {
  if (!process.env.GROQ_API_KEY) return null
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
  return groq
}

// ── Gemini ─────────────────────────────────────────────────────────────────
let genai: GoogleGenAI | null = null
function getGenAI(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null
  if (!genai) genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return genai
}

// ── Prompts ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are CryptoAdvisor, an expert cryptocurrency and blockchain knowledge assistant. You answer questions clearly, accurately, and concisely.

RULES:
- Only answer questions about cryptocurrency, blockchain, DeFi, NFTs, GameFi, meme coins, wallets, staking, trading, and related Web3 topics.
- For off-topic questions, politely redirect to crypto topics.
- Never give investment advice or price predictions. If asked, say you cannot provide financial advice and suggest consulting a licensed advisor.
- For live price questions, use the [LIVE MARKET DATA] block appended to this prompt. Quote the exact price and 24h change. Always note prices are from the last cached fetch.
- Format responses with **bold** for key terms and bullet lists where helpful.
- Keep answers focused and educational — typically 100–300 words. Go longer only for complex multi-part topics.
- Always include a safety disclaimer for high-risk topics (meme coins, leverage, scams).
- End with a relevant follow-up suggestion when natural.

EXPERTISE AREAS:
Bitcoin, Ethereum, Solana, Arc, USDC, stablecoins, DeFi (Uniswap, Aave, Curve, MakerDAO), NFTs (OpenSea, Blur, Zora, Ordinals, ERC-721, ERC-1155), GameFi (Axie Infinity, Ronin, Immutable X, P2E, FOCG, guilds), meme coins (DOGE, SHIB, PEPE, WIF, pump.fun, bonding curves), wallets (MetaMask, hardware wallets, ERC-4337), gas fees, staking, Layer 2s (Arbitrum, Base, Optimism, zkSync), CCTP, smart contracts, DAOs, flash loans, oracles, RWA tokenization, CBDCs, blockchain security, and more.`

const DIGEST_PROMPT = `You are CryptoAdvisor's daily digest writer. Write a short, engaging daily crypto update in exactly this format:

📊 **Daily Crypto Digest — {DATE}**

**Market Pulse:** One sentence on overall crypto market sentiment today.

**Did You Know?** One interesting crypto fact, protocol milestone, or concept — educational and surprising.

**Concept of the Day:** Name one DeFi/NFT/blockchain concept and explain it in 2 sentences for a curious beginner.

**Today's Tip:** One actionable security or portfolio tip.

Keep the total under 120 words. Be educational, never give financial advice, and end with "Ask me anything in CryptoAdvisor →"`

async function generateDigest(eventSummary?: string): Promise<string> {
  const client = getGenAI()
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  let prompt = DIGEST_PROMPT.replace('{DATE}', date)
  if (eventSummary) prompt += `\n\nACTIVITY TODAY:\n${eventSummary}`
  if (!client) {
    return `📊 Daily Crypto Digest — ${date}\n\nDid You Know? Bitcoin's Lightning Network processes millions of micropayments per second.\n\nConcept of the Day: Gas fees are the cost of computation on Ethereum — paid in ETH to validators.\n\nToday's Tip: Always verify a contract address before approving token spending.\n\nAsk me anything in CryptoAdvisor →`
  }
  try {
    const resp = await client.models.generateContent({
      model: 'gemini-2.0-flash',
      config: { systemInstruction: prompt, maxOutputTokens: 220 },
      contents: [{ role: 'user', parts: [{ text: 'Generate today\'s digest.' }] }],
    })
    return resp.text ?? 'Daily digest unavailable.'
  } catch {
    return `📊 Daily Crypto Digest — ${date}\n\nAI digest temporarily unavailable. Ask me anything in CryptoAdvisor →`
  }
}

function buildEventSummary(): string {
  const cache = loadEventCache()
  const since = Date.now() - 86_400_000
  const recent = cache.events.filter(e => e.timestamp > since)
  if (recent.length === 0) return ''
  const queries = recent.filter(e => e.type === 'QueryPaid').length
  const subs    = recent.filter(e => e.type === 'Subscribed').length
  const revenue = recent.filter(e => e.type === 'QueryPaid' || e.type === 'Subscribed')
    .reduce((s, e) => s + parseFloat(e.amountUsdc), 0)
  return `${queries} queries paid, ${subs} new subscriptions, $${revenue.toFixed(4)} USDC earned in the last 24 hours.`
}

async function sendDailyDigest(): Promise<void> {
  const subs = loadSubs()
  console.log(`[push] Generating digest for ${subs.length} subscriber(s)…`)
  const body = await generateDigest(buildEventSummary() || undefined)
  const title = '📊 Your Daily Crypto Digest'
  const dead: string[] = []
  await Promise.allSettled(subs.map(async ({ subscription }) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({ title, body, url: '/' }))
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 410 || status === 404) dead.push(JSON.stringify(subscription.endpoint))
    }
  }))
  if (dead.length > 0) {
    saveSubs(subs.filter(s => !dead.includes(JSON.stringify(s.subscription.endpoint))))
    console.log(`[push] Pruned ${dead.length} expired subscription(s)`)
  }
  console.log(`[push] Digest sent to ${subs.length - dead.length} subscriber(s)`)
  if (tgBot && TELEGRAM_CHAT_ID) {
    const summary = buildEventSummary()
    const tgBody  = summary ? `${body}\n\n📈 *Last 24h:* ${summary}` : body
    try {
      await tgBot.sendMessage(TELEGRAM_CHAT_ID, tgBody, { parse_mode: 'Markdown' })
      console.log('[telegram] Digest sent')
    } catch (err: unknown) {
      console.warn('[telegram] Send failed:', err instanceof Error ? err.message : err)
    }
  }
}

cron.schedule('0 9 * * *', () => { void sendDailyDigest() }, { timezone: 'UTC' })

// ── SSE: on-chain event stream ──────────────────────────────────────────────
app.get('/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()
  SSE_CLIENTS.add(res)
  const cache = loadEventCache()
  for (const ev of cache.events.slice(0, 20)) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  req.on('close', () => { SSE_CLIENTS.delete(res) })
})

app.get('/events/recent', (_req, res) => {
  const cache = loadEventCache()
  res.json({ events: cache.events.slice(0, 50), lastBlock: cache.lastBlock, updatedAt: cache.updatedAt, summary: buildEventSummary() })
})

// ── Push routes ─────────────────────────────────────────────────────────────
app.post('/push/subscribe', (req, res) => {
  const { wallet, subscription } = req.body as { wallet?: string; subscription?: webpush.PushSubscription }
  if (!subscription?.endpoint) { res.status(400).json({ error: 'subscription.endpoint required' }); return }
  if (!VAPID_PUBLIC) { res.status(503).json({ error: 'Push not configured (VAPID keys missing)' }); return }
  const subs = loadSubs()
  const existing = subs.findIndex(s => s.subscription.endpoint === subscription.endpoint)
  const entry: StoredSub = { wallet: wallet ?? 'anonymous', subscription, createdAt: new Date().toISOString() }
  if (existing >= 0) subs[existing] = entry; else subs.push(entry)
  saveSubs(subs)
  webpush.sendNotification(subscription, JSON.stringify({
    title: '🔔 CryptoAdvisor Notifications On',
    body: 'You\'ll receive a daily crypto digest at 9 AM UTC. Ask me anything!',
    url: '/',
  })).catch(() => null)
  res.json({ ok: true, total: subs.length })
})

app.delete('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body as { endpoint?: string }
  if (!endpoint) { res.status(400).json({ error: 'endpoint required' }); return }
  saveSubs(loadSubs().filter(s => s.subscription.endpoint !== endpoint))
  res.json({ ok: true })
})

app.get('/push/vapid-public', (_req, res) => { res.json({ key: VAPID_PUBLIC || null }) })

app.post('/push/send-now', requireAdmin, async (_req, res) => {
  try { await sendDailyDigest(); res.json({ ok: true }) }
  catch (err: unknown) { res.status(500).json({ error: String(err) }) }
})

// ── Session key verification ───────────────────────────────────────────────
// Session keys are managed client-side (PasskeyWallet) and presented as a
// signed EIP-712 token. This endpoint verifies the session is still valid.
app.post('/session/verify', (req, res) => {
  const { address, expiry } = req.body as { address?: string; expiry?: number }
  if (!address || !expiry) { res.status(400).json({ valid: false, reason: 'missing fields' }); return }
  if (expiry < Date.now()) { res.json({ valid: false, reason: 'expired' }); return }
  // Session is client-attested; server trusts the expiry and logs it
  console.log(`[session] Verified session for ${address.slice(0, 10)}…, expires ${new Date(expiry).toISOString()}`)
  res.json({ valid: true, address, expiry })
})

// ── Chat ──────────────────────────────────────────────────────────────────
const chatMiddleware = gateway ? [gateway.require('$0.001')] : []
type ModelChoice = 'auto' | 'groq' | 'gemini' | 'local'

app.post('/chat', chatRateLimit, ...chatMiddleware, async (req, res) => {
  const { messages, model = 'auto' } = req.body as {
    messages: Array<{ role: string; content: string }>; model?: ModelChoice
  }
  if (!messages || !Array.isArray(messages)) { res.status(400).json({ error: 'messages array required' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  if (model === 'local') {
    res.write(`data: ${JSON.stringify({ delta: '📚 **Local Knowledge Base**\n\nThe AI backend is bypassed. Please ask your question and I\'ll route it through the built-in knowledge base on the client side.' })}\n\n`)
    res.write('data: [DONE]\n\n'); res.end(); return
  }

  const coins = await fetchMarketContext()
  const enrichedSystemPrompt = SYSTEM_PROMPT + buildMarketBlock(coins)
  const groqClient  = getGroq()
  const geminiClient = getGenAI()

  const tryGroq = (model === 'groq' || model === 'auto') && !!groqClient
  if (tryGroq) {
    try {
      const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: enrichedSystemPrompt },
        ...messages.filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ]
      const stream = await groqClient!.chat.completions.create({
        model: 'llama-3.3-70b-versatile', messages: groqMessages, max_tokens: 600, stream: true,
      })
      currentTier = 'groq'
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
      }
      res.write('data: [DONE]\n\n'); res.end(); return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const reason = msg.includes('429') || msg.toLowerCase().includes('rate') ? 'rate_limit'
        : msg.includes('401') || msg.toLowerCase().includes('auth') ? 'auth_error' : 'network_error'
      fallbackLog.unshift({ tier: 'groq', reason, at: Date.now() })
      if (fallbackLog.length > 50) fallbackLog.length = 50
      if (model === 'groq') {
        res.write(`data: ${JSON.stringify({ error: 'Groq unavailable: ' + msg })}\n\n`)
        res.write('data: [DONE]\n\n'); res.end(); return
      }
      console.warn(`[groq] Fallback triggered (${reason}), trying Gemini…`)
    }
  }

  const tryGemini = (model === 'gemini' || model === 'auto') && !!geminiClient
  if (tryGemini) {
    try {
      const contents = messages.filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      const stream = await geminiClient!.models.generateContentStream({
        model: 'gemini-2.0-flash',
        config: { systemInstruction: enrichedSystemPrompt, maxOutputTokens: 600 },
        contents,
      })
      currentTier = 'gemini'
      for await (const chunk of stream) {
        const delta = chunk.text
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`)
      }
      res.write('data: [DONE]\n\n'); res.end(); return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const reason = msg.includes('429') || msg.toLowerCase().includes('quota') ? 'rate_limit' : 'network_error'
      fallbackLog.unshift({ tier: 'gemini', reason, at: Date.now() })
      if (fallbackLog.length > 50) fallbackLog.length = 50
      currentTier = 'local'
      console.warn(`[gemini] Fallback triggered (${reason}), falling to local KB…`)
      res.write(`data: ${JSON.stringify({ error: `Gemini unavailable (${reason}). Switching to local KB.` })}\n\n`)
      res.write('data: [DONE]\n\n'); res.end(); return
    }
  }

  currentTier = 'local'
  res.write(`data: ${JSON.stringify({ error: 'No AI service configured. Set GROQ_API_KEY or GEMINI_API_KEY.' })}\n\n`)
  res.write('data: [DONE]\n\n'); res.end()
})

// ── Market context ─────────────────────────────────────────────────────────
app.get('/market-context', async (_req, res) => {
  const coins = await fetchMarketContext()
  res.json({ coins, fetchedAt: marketCache?.fetchedAt ?? null, count: coins.length })
})

// ── Agent status ───────────────────────────────────────────────────────────
app.get('/agent-status', (_req, res) => {
  const cache = loadEventCache()
  res.json({
    ok: true,
    aiPrimary: process.env.GROQ_API_KEY ? 'groq' : process.env.GEMINI_API_KEY ? 'gemini' : 'none',
    currentTier,
    groq: !!process.env.GROQ_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    x402: !!process.env.SELLER_ADDRESS,
    push: !!VAPID_PUBLIC,
    telegram: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    adminProtected: !!ADMIN_SECRET,
    subscribers: loadSubs().length,
    recentFallbacks: fallbackLog.slice(0, 10),
    chainEvents: { total: cache.events.length, lastBlock: cache.lastBlock, updatedAt: cache.updatedAt, summary: buildEventSummary() },
  })
})

// ── Portfolio routes ───────────────────────────────────────────────────────

// Register or update a wallet's portfolio (auto-fetches on-chain USDC balance)
app.post('/portfolio/register', async (req, res) => {
  const { wallet, manualTokens } = req.body as { wallet?: string; manualTokens?: PortfolioSnapshot['manualTokens'] }
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'valid wallet address required' }); return
  }
  const portfolios = loadPortfolios()
  const existing = portfolios.find(p => p.wallet.toLowerCase() === wallet.toLowerCase())
  let usdcBalance = existing?.usdcBalance ?? '0'
  let contractBalance = existing?.contractUsdcBalance ?? '0'
  try {
    const balHex = await rpc<string>('eth_call', [{
      to: USDC_ADDRESS,
      data: '0x70a08231' + wallet.slice(2).padStart(64, '0'),
    }, 'latest'])
    usdcBalance = BigInt(balHex).toString()
    const cBalHex = await rpc<string>('eth_call', [{
      to: USDC_ADDRESS,
      data: '0x70a08231' + CONTRACT_ADDRESS.slice(2).padStart(64, '0'),
    }, 'latest'])
    contractBalance = BigInt(cBalHex).toString()
  } catch { /* use cached */ }

  const snapshot: PortfolioSnapshot = {
    wallet,
    usdcBalance,
    contractUsdcBalance: contractBalance,
    manualTokens: manualTokens ?? existing?.manualTokens ?? [],
    updatedAt: Date.now(),
    prevUsdcBalance: existing?.usdcBalance,
  }
  if (existing) Object.assign(existing, snapshot)
  else portfolios.push(snapshot)
  savePortfolios(portfolios)
  res.json({ ok: true, snapshot })
})

// Get portfolio snapshot + risk score + yield table
app.get('/portfolio/:wallet', (req, res) => {
  const { wallet } = req.params
  const portfolios = loadPortfolios()
  const portfolio = portfolios.find(p => p.wallet.toLowerCase() === wallet.toLowerCase())
  if (!portfolio) { res.status(404).json({ error: 'not registered' }); return }
  const risk = scorePortfolioRisk(portfolio, marketCache?.data ?? [])
  res.json({ portfolio, risk, yields: ARC_YIELD_TABLE })
})

// Add or update manual tokens for a wallet
app.patch('/portfolio/:wallet/tokens', (req, res) => {
  const { wallet } = req.params
  const { manualTokens } = req.body as { manualTokens?: PortfolioSnapshot['manualTokens'] }
  if (!manualTokens) { res.status(400).json({ error: 'manualTokens required' }); return }
  const portfolios = loadPortfolios()
  const portfolio = portfolios.find(p => p.wallet.toLowerCase() === wallet.toLowerCase())
  if (!portfolio) { res.status(404).json({ error: 'not registered' }); return }
  portfolio.manualTokens = manualTokens
  portfolio.updatedAt = Date.now()
  savePortfolios(portfolios)
  res.json({ ok: true })
})

// Create an automation rule (NL → parsed)
app.post('/portfolio/rules', async (req, res) => {
  const { wallet, text } = req.body as { wallet?: string; text?: string }
  if (!wallet || !text) { res.status(400).json({ error: 'wallet and text required' }); return }
  const groqKey = process.env.GROQ_API_KEY
  let parsed = null
  if (groqKey) parsed = await parseRuleWithGroq(text, groqKey)
  if (!parsed) {
    // Fallback: basic keyword parser
    const isDropPct = /drop|fall|down|decrease/i.test(text)
    const isRisePct = /rise|pump|up|increase/i.test(text)
    const numMatch  = text.match(/(\d+(?:\.\d+)?)/)
    const assetMatch = text.match(/\b(BTC|ETH|SOL|USDC|BNB|XRP|ADA|AVAX|portfolio)\b/i)
    parsed = {
      asset: assetMatch?.[1]?.toUpperCase() ?? 'portfolio',
      condition: (isDropPct ? 'drops_pct' : isRisePct ? 'rises_pct' : 'drops_pct') as AutomationRule['condition'],
      threshold: Number(numMatch?.[1]) || 10,
      windowHours: 24,
      cooldownMinutes: 60,
    }
  }
  const rule: AutomationRule = {
    id: `${wallet.slice(2, 8)}-${Date.now()}`,
    wallet,
    raw: text,
    ...parsed,
    createdAt: Date.now(),
    enabled: true,
  }
  const rules = loadRules()
  rules.push(rule)
  saveRules(rules)
  res.json({ ok: true, rule })
})

// List rules for a wallet
app.get('/portfolio/rules/:wallet', (req, res) => {
  const { wallet } = req.params
  res.json({ rules: loadRules().filter(r => r.wallet.toLowerCase() === wallet.toLowerCase()) })
})

// Delete a rule
app.delete('/portfolio/rules/:id', (req, res) => {
  const { id } = req.params
  const rules = loadRules().filter(r => r.id !== id)
  saveRules(rules)
  res.json({ ok: true })
})

// Toggle rule enabled/disabled
app.patch('/portfolio/rules/:id', (req, res) => {
  const { id } = req.params
  const { enabled } = req.body as { enabled?: boolean }
  const rules = loadRules()
  const rule = rules.find(r => r.id === id)
  if (!rule) { res.status(404).json({ error: 'rule not found' }); return }
  rule.enabled = enabled ?? !rule.enabled
  saveRules(rules)
  res.json({ ok: true, rule })
})

// Get recent alerts for a wallet
app.get('/portfolio/alerts/:wallet', (req, res) => {
  const { wallet } = req.params
  const alerts = loadAlerts().filter(a => a.wallet.toLowerCase() === wallet.toLowerCase())
  res.json({ alerts: alerts.slice(0, 50) })
})

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    aiPrimary: process.env.GROQ_API_KEY ? 'groq' : process.env.GEMINI_API_KEY ? 'gemini' : 'none',
    currentTier,
    groq: !!process.env.GROQ_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    x402: !!process.env.SELLER_ADDRESS,
    push: !!VAPID_PUBLIC,
    telegram: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    adminProtected: !!ADMIN_SECRET,
    subscribers: loadSubs().length,
    sellerAddress: process.env.SELLER_ADDRESS ? `${process.env.SELLER_ADDRESS.slice(0, 8)}…` : null,
  })
})

const PORT = 3001
app.listen(PORT, () => {
  console.log(`CryptoAdvisor API running on port ${PORT}`)
  const aiMode = process.env.GROQ_API_KEY
    ? 'Groq (llama-3.3-70b-versatile) primary, Gemini fallback, Local KB final'
    : process.env.GEMINI_API_KEY ? 'Gemini (gemini-2.0-flash) primary, Local KB fallback' : 'no AI key — local KB only'
  console.log(`[ai] ${aiMode}`)
  if (VAPID_PUBLIC) console.log(`[push] VAPID configured — cron fires daily at 09:00 UTC`)
  if (tgBot && TELEGRAM_CHAT_ID) console.log(`[telegram] Bot configured — chat ID: ${TELEGRAM_CHAT_ID}`)
  if (ADMIN_SECRET) console.log(`[admin] /push/send-now protected by ADMIN_SECRET`)
  console.log(`[chain] On-chain event poller active — polling every 30s`)
  void pollOnchainEvents()
})
