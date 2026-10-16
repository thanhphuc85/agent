/**
 * Portfolio Monitor — autonomous risk management for CryptoAdvisor
 *
 * Responsibilities:
 *  1. Store per-wallet portfolio snapshots (on-chain USDC + manual tokens)
 *  2. Parse natural-language automation rules via Groq
 *  3. Evaluate rules every 30 s and fire alerts (Telegram + SSE)
 *  4. Track Arc-native yield opportunities
 */

import fs from 'fs'
import path from 'path'
import Groq from 'groq-sdk'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ManualToken {
  symbol: string
  amount: number
  /** Optional CoinGecko id for price lookup */
  coingeckoId?: string
}

export interface PortfolioSnapshot {
  wallet: string
  /** USDC balance on-chain, 6-decimal units string */
  usdcBalance: string
  /** USDC locked in QueryPayment contract (subscription prepay, etc.) */
  contractUsdcBalance: string
  manualTokens: ManualToken[]
  updatedAt: number
  /** 24h ago snapshot for change calculation */
  prevUsdcBalance?: string
}

export interface AutomationRule {
  id: string
  wallet: string
  /** Raw user text, e.g. "alert me if ETH drops 10% in a day" */
  raw: string
  /** Parsed structured rule */
  asset: string           // 'USDC' | 'ETH' | 'BTC' | … | 'portfolio'
  condition: 'drops_pct' | 'rises_pct' | 'drops_below' | 'rises_above' | 'volatility_above'
  threshold: number       // percentage or absolute USD
  windowHours: number     // evaluation window
  /** Cooldown: don't re-fire within this many minutes */
  cooldownMinutes: number
  lastFiredAt?: number
  createdAt: number
  enabled: boolean
}

export interface Alert {
  id: string
  wallet: string
  ruleId: string
  ruleRaw: string
  message: string
  severity: 'info' | 'warning' | 'critical'
  firedAt: number
}

// ── Storage helpers ─────────────────────────────────────────────────────────

const DATA_DIR = path.join(import.meta.dir, 'data')
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolios.json')
const RULES_FILE     = path.join(DATA_DIR, 'rules.json')
const ALERTS_FILE    = path.join(DATA_DIR, 'alerts.json')

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }) }

export function loadPortfolios(): PortfolioSnapshot[] {
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8')) as PortfolioSnapshot[] }
  catch { return [] }
}
export function savePortfolios(p: PortfolioSnapshot[]) {
  ensureDir()
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(p, null, 2))
}
export function loadRules(): AutomationRule[] {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')) as AutomationRule[] }
  catch { return [] }
}
export function saveRules(r: AutomationRule[]) {
  ensureDir()
  fs.writeFileSync(RULES_FILE, JSON.stringify(r, null, 2))
}
export function loadAlerts(): Alert[] {
  try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')) as Alert[] }
  catch { return [] }
}
export function saveAlerts(a: Alert[]) {
  ensureDir()
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(a, null, 2))
}

// ── Yield table (Arc-native opportunities, static) ──────────────────────────

export interface YieldOpportunity {
  protocol: string
  asset: string
  apy: number          // annualised %, e.g. 4.5
  riskLevel: 'low' | 'medium' | 'high'
  description: string
  url?: string
}

export const ARC_YIELD_TABLE: YieldOpportunity[] = [
  {
    protocol: 'Arc Native Staking',
    asset: 'USDC',
    apy: 4.5,
    riskLevel: 'low',
    description: 'Native USDC staking rewards on Arc Network — gas fees are redistributed to stakers.',
    url: 'https://arc.io/stake',
  },
  {
    protocol: 'CryptoAdvisor Subscription Revenue',
    asset: 'USDC',
    apy: 0,
    riskLevel: 'low',
    description: 'USDC locked in QueryPayment contract earns subscription fee revenue. Withdraw anytime.',
  },
  {
    protocol: 'Circle Yield (USDC)',
    asset: 'USDC',
    apy: 5.1,
    riskLevel: 'low',
    description: "Circle's institutional USDC yield product (T-bill backed). Available to verified entities.",
    url: 'https://www.circle.com/yield',
  },
  {
    protocol: 'Idle USDC (wallet)',
    asset: 'USDC',
    apy: 0,
    riskLevel: 'low',
    description: 'USDC sitting in your wallet earns nothing. Consider deploying to a yield source above.',
  },
]

// ── NL rule parser ──────────────────────────────────────────────────────────

const RULE_PARSE_PROMPT = `You parse natural-language alert rules into structured JSON.
Output ONLY valid JSON, no markdown, no explanation.
Schema:
{
  "asset": "<string — token symbol like USDC, ETH, BTC, or 'portfolio' for overall>",
  "condition": "<one of: drops_pct | rises_pct | drops_below | rises_above | volatility_above>",
  "threshold": <number — percentage for *_pct and volatility_above, absolute USD for drops_below/rises_above>,
  "windowHours": <number — time window in hours, default 24>,
  "cooldownMinutes": <number — re-alert cooldown, default 60>
}
Examples:
  "alert me if ETH drops 10% in a day"
  → {"asset":"ETH","condition":"drops_pct","threshold":10,"windowHours":24,"cooldownMinutes":60}

  "notify me if my USDC balance drops below 50"
  → {"asset":"USDC","condition":"drops_below","threshold":50,"windowHours":1,"cooldownMinutes":30}

  "warn me when BTC rises more than 20% in a week"
  → {"asset":"BTC","condition":"rises_pct","threshold":20,"windowHours":168,"cooldownMinutes":120}

  "alert if volatility is above 5% in an hour"
  → {"asset":"portfolio","condition":"volatility_above","threshold":5,"windowHours":1,"cooldownMinutes":30}
`

export async function parseRuleWithGroq(
  rawText: string,
  groqApiKey: string,
): Promise<Omit<AutomationRule, 'id' | 'wallet' | 'raw' | 'createdAt' | 'enabled' | 'lastFiredAt'> | null> {
  try {
    const client = new Groq({ apiKey: groqApiKey })
    const resp = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: RULE_PARSE_PROMPT },
        { role: 'user',   content: rawText },
      ],
      max_tokens: 200,
      temperature: 0,
    })
    const text = resp.choices[0]?.message?.content?.trim() ?? ''
    const parsed = JSON.parse(text) as {
      asset: string; condition: AutomationRule['condition']
      threshold: number; windowHours: number; cooldownMinutes: number
    }
    return {
      asset: parsed.asset ?? 'portfolio',
      condition: parsed.condition ?? 'drops_pct',
      threshold: Number(parsed.threshold) || 10,
      windowHours: Number(parsed.windowHours) || 24,
      cooldownMinutes: Number(parsed.cooldownMinutes) || 60,
    }
  } catch (err) {
    console.warn('[portfolio] Rule parse failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Rule evaluator ──────────────────────────────────────────────────────────

interface CoinPrice { symbol: string; price: number; change24h: number }

export function evaluateRule(
  rule: AutomationRule,
  portfolio: PortfolioSnapshot,
  marketCoins: CoinPrice[],
  now = Date.now(),
): Alert | null {
  // Cooldown check
  if (rule.lastFiredAt && (now - rule.lastFiredAt) < rule.cooldownMinutes * 60_000) return null
  if (!rule.enabled) return null

  const coin = marketCoins.find(c => c.symbol.toUpperCase() === rule.asset.toUpperCase())

  // USDC-balance-based conditions
  if (rule.asset.toUpperCase() === 'USDC') {
    const bal = Number(portfolio.usdcBalance) / 1e6
    if (rule.condition === 'drops_below' && bal < rule.threshold) {
      return makeAlert(rule, portfolio.wallet, `USDC balance ($${bal.toFixed(2)}) dropped below $${rule.threshold}`, 'warning', now)
    }
    if (rule.condition === 'rises_above' && bal > rule.threshold) {
      return makeAlert(rule, portfolio.wallet, `USDC balance ($${bal.toFixed(2)}) rose above $${rule.threshold}`, 'info', now)
    }
    // 24h change for USDC balance itself
    if (portfolio.prevUsdcBalance) {
      const prev = Number(portfolio.prevUsdcBalance) / 1e6
      if (prev > 0) {
        const changePct = ((bal - prev) / prev) * 100
        if (rule.condition === 'drops_pct' && changePct <= -rule.threshold) {
          return makeAlert(rule, portfolio.wallet, `USDC balance dropped ${Math.abs(changePct).toFixed(1)}% in ${rule.windowHours}h (now $${bal.toFixed(2)})`, 'warning', now)
        }
        if (rule.condition === 'rises_pct' && changePct >= rule.threshold) {
          return makeAlert(rule, portfolio.wallet, `USDC balance rose ${changePct.toFixed(1)}% in ${rule.windowHours}h (now $${bal.toFixed(2)})`, 'info', now)
        }
      }
    }
  }

  // Market-price-based conditions
  if (coin) {
    const change = coin.change24h // 24h % change from CoinGecko
    if (rule.condition === 'drops_pct' && change <= -rule.threshold) {
      return makeAlert(rule, portfolio.wallet,
        `${rule.asset} dropped ${Math.abs(change).toFixed(1)}% in the last 24h (now $${coin.price.toLocaleString()})`,
        change <= -rule.threshold * 2 ? 'critical' : 'warning', now)
    }
    if (rule.condition === 'rises_pct' && change >= rule.threshold) {
      return makeAlert(rule, portfolio.wallet,
        `${rule.asset} rose ${change.toFixed(1)}% in the last 24h (now $${coin.price.toLocaleString()})`,
        'info', now)
    }
    if (rule.condition === 'drops_below' && coin.price < rule.threshold) {
      return makeAlert(rule, portfolio.wallet,
        `${rule.asset} price ($${coin.price.toLocaleString()}) fell below $${rule.threshold.toLocaleString()}`,
        'warning', now)
    }
    if (rule.condition === 'rises_above' && coin.price > rule.threshold) {
      return makeAlert(rule, portfolio.wallet,
        `${rule.asset} price ($${coin.price.toLocaleString()}) rose above $${rule.threshold.toLocaleString()}`,
        'info', now)
    }
    if (rule.condition === 'volatility_above') {
      const absChange = Math.abs(change)
      if (absChange >= rule.threshold) {
        return makeAlert(rule, portfolio.wallet,
          `${rule.asset} volatility alert: ${absChange.toFixed(1)}% move in 24h (threshold: ${rule.threshold}%)`,
          absChange >= rule.threshold * 2 ? 'critical' : 'warning', now)
      }
    }
  }

  return null
}

function makeAlert(
  rule: AutomationRule,
  wallet: string,
  message: string,
  severity: Alert['severity'],
  now: number,
): Alert {
  return {
    id: `${rule.id}-${now}`,
    wallet,
    ruleId: rule.id,
    ruleRaw: rule.raw,
    message,
    severity,
    firedAt: now,
  }
}

// ── Liquidation risk scorer ─────────────────────────────────────────────────

export interface RiskScore {
  wallet: string
  score: number           // 0 = safe, 100 = critical
  level: 'safe' | 'low' | 'medium' | 'high' | 'critical'
  factors: string[]
  updatedAt: number
}

export function scorePortfolioRisk(
  portfolio: PortfolioSnapshot,
  marketCoins: CoinPrice[],
): RiskScore {
  const factors: string[] = []
  let score = 0

  const usdcBal = Number(portfolio.usdcBalance) / 1e6
  const contractBal = Number(portfolio.contractUsdcBalance) / 1e6
  const total = usdcBal + contractBal

  // Low balance risk
  if (usdcBal < 5) { score += 30; factors.push('USDC wallet balance below $5') }
  else if (usdcBal < 20) { score += 15; factors.push('USDC wallet balance below $20') }

  // High concentration in volatile assets
  const manualUsd = portfolio.manualTokens.reduce((sum, t) => {
    const c = marketCoins.find(m => m.symbol.toUpperCase() === t.symbol.toUpperCase())
    return sum + (c ? c.price * t.amount : 0)
  }, 0)
  if (total > 0 && manualUsd / (total + manualUsd) > 0.8) {
    score += 20; factors.push('Over 80% of portfolio in non-stable assets')
  }

  // High volatility assets in portfolio
  for (const t of portfolio.manualTokens) {
    const c = marketCoins.find(m => m.symbol.toUpperCase() === t.symbol.toUpperCase())
    if (c && Math.abs(c.change24h) >= 15) {
      score += 10; factors.push(`${t.symbol} moved ${c.change24h.toFixed(1)}% in 24h`)
    }
  }

  // Balance drop from previous snapshot
  if (portfolio.prevUsdcBalance) {
    const prev = Number(portfolio.prevUsdcBalance) / 1e6
    if (prev > 0 && usdcBal < prev * 0.7) {
      score += 25; factors.push(`USDC balance dropped ${((1 - usdcBal / prev) * 100).toFixed(0)}% from previous snapshot`)
    }
  }

  score = Math.min(score, 100)
  const level: RiskScore['level'] =
    score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 40 ? 'medium' : score >= 20 ? 'low' : 'safe'

  return { wallet: portfolio.wallet, score, level, factors, updatedAt: Date.now() }
}
