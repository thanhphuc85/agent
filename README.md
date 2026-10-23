# CryptoAdvisor

An AI-powered cryptocurrency assistant built on Arc Mainnet. Ask any crypto question and pay $0.01 USDC per answer, or subscribe for a flat monthly rate. Features real-time market data, a token swap interface, portfolio monitoring, and daily Telegram/Web Push digests.

Built with [Arc Studio](https://studio.arc.io)

---

## Features

- **AI-powered Q&A** — answers streamed from Groq (Llama 3.3 70B) with Gemini 2.0 Flash fallback and a local knowledge base as the final fallback
- **Pay-per-query** — $0.01 USDC per question via the `QueryPayment` smart contract on Arc Mainnet; no account required
- **Monthly subscription** — flat-fee unlimited queries for 30 days via `subscribe()` on the same contract
- **Session key** — approve a USDC spending allowance once and pay many queries without re-signing each time
- **Model selector** — switch between Auto (Groq→Gemini), Groq, Gemini, and Local KB from the chat header
- **Live market data** — real-time prices injected into every AI response from CoinGecko; answers include current prices, 24h change, and volume
- **Market tab** — price tracker for 20+ coins with 7-day sparklines, sortable columns, and one-click swap
- **Token swap** — LiFi-powered swap of USDT/EURC/DAI/WETH/WBTC → USDC on Arc Mainnet
- **Portfolio monitor** — background cron tracks USDC balance and QueryPayment stats per wallet; natural-language automation rules (e.g. "alert me when ETH drops 10%")
- **Daily digest** — Groq-generated crypto digest sent at 9 AM UTC via Telegram and Web Push
- **Owner dashboard** — live contract stats (total revenue, query count, subscriptions), analytics charts with time-range selector, fee timelock management, two-step ownership transfer
- **x402 nanopayments** — AI agents can pay $0.001/call automatically on `/api/chat` when `SELLER_ADDRESS` is set
- **Rate limiting** — 20 requests/minute per IP on `/api/chat`
- **PWA** — installable on mobile ("Add to Home Screen"), service worker precaches the app shell
- **Dark/light mode** — persisted to localStorage

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 5, TypeScript, Tailwind CSS |
| Web3 | wagmi v2, viem v2, ConnectKit |
| AI | Groq SDK (`llama-3.3-70b-versatile`), Google GenAI (`gemini-2.0-flash`) |
| Backend | Express (Bun), node-cron, web-push, node-telegram-bot-api, express-rate-limit |
| Smart contracts | Solidity 0.8.27, Foundry — source in `contracts/`, tests in `contracts/test/` |
| Chain | Arc Mainnet (Chain ID 5042, RPC `https://rpc.mainnet.arc.io`) |
| USDC | `0x3600000000000000000000000000000000000000` (6 decimals, Arc Mainnet) |
| Token swap | LiFi SDK |
| Deployment | Netlify (frontend static), or Hugging Face Docker Space (full app) |

---

## Smart Contracts

| Contract | Network | Address |
|---|---|---|
| QueryPayment | Arc Mainnet | `0x0a83a718D6d8cBE850B986c025dE287bc3fe5a29` |
| QueryPayment | Arc Testnet | `0x32ffcf43c1345b4e0769d418bfc6a74291b1c3ce` |

The contract holds USDC paid by users, tracks query counts and subscription expiries, and lets the owner withdraw earnings. It includes:
- 48-hour fee change timelock (`setQueryFee` → `applyQueryFee`)
- Two-step ownership transfer (`transferOwnership` → `acceptOwnership`)
- `code.length` check on the USDC token address at deploy time

---

## Setup & Local Development

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Foundry](https://book.getfoundry.sh) (for contract work only)
- A browser wallet (MetaMask or compatible) connected to Arc Mainnet

### Install

```bash
bun install
```

### Run

Start the frontend (Vite dev server on port 5173):

```bash
bun run dev
```

Start the backend (Express on port 3001) in a separate terminal:

```bash
bun run server/index.ts
```

The Vite dev server proxies `/api` to `http://localhost:3001` automatically.

### Build (frontend only)

```bash
bunx vite build
```

Output goes to `dist/`. Deploy `dist/` to any static host.

### Contract commands

```bash
# Compile
forge build

# Run unit tests (70 tests)
forge test
```

---

## Environment Variables

Create a `.env` file in the project root. None of these are required to run the app locally — missing keys activate graceful fallbacks.

| Variable | Purpose | Required |
|---|---|---|
| `GROQ_API_KEY` | Groq LPU inference (primary AI) | No — falls back to Gemini |
| `GEMINI_API_KEY` | Google Gemini 2.0 Flash (fallback AI) | No — falls back to local KB |
| `ADMIN_SECRET` | Authenticates `POST /api/push/send-now` | No — endpoint open without it |
| `SELLER_ADDRESS` | Enables x402 nanopayment gating on `/api/chat` | No — gate inactive without it |
| `TELEGRAM_BOT_TOKEN` | Telegram bot for daily digest | No — Telegram digest silent |
| `TELEGRAM_CHAT_ID` | Target channel/group for digest | No — Telegram digest silent |
| `VITE_CLIENT_KEY` | Circle Modular Wallet client key (Wallet tab) | No — passkey wallet inactive |
| `VITE_CLIENT_URL` | Circle Modular Wallet RPC URL | No — passkey wallet inactive |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key (auto-generated) | Auto |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key (auto-generated) | Auto |

VAPID keys are generated automatically on first server start if absent.

---

## Deploying to Netlify (frontend only)

```bash
bunx vite build
# Then drag-and-drop dist/ to app.netlify.com, or use the Netlify CLI:
netlify deploy --prod --dir dist
```

Add `public/_redirects` with `/* /index.html 200` for SPA routing (already present in this repo).

The backend (AI, push notifications, portfolio monitor) does not run on Netlify. For the full app, deploy to a platform that runs Node/Bun processes (e.g. Railway, Render, or Hugging Face Docker Space).

---

## Deploying the Smart Contract

Deploy `contracts/QueryPayment.sol` using Remix or Foundry to Arc Mainnet:

- **RPC**: `https://rpc.mainnet.arc.io`
- **Chain ID**: 5042
- **Constructor args**:
  - `usdcToken_`: `0x3600000000000000000000000000000000000000`
  - `initialOwner`: your wallet address
  - `initialQueryFee`: `10000` (= $0.01 USDC)
  - `initialSubscriptionFee`: your chosen monthly rate (e.g. `500000` = $0.50)

After deploying, update `QUERY_PAYMENT_ADDRESS` in `src/App.tsx`.

---

## Project Structure

```
├── contracts/          Solidity source + Foundry tests
├── public/             Static assets, PWA icons, _redirects
├── server/             Express backend (AI, push, portfolio, cron)
│   ├── index.ts        Main server entry point
│   ├── portfolio.ts    Portfolio monitor and rule engine
│   └── data/           Runtime data (push subscriptions, events cache)
├── src/
│   ├── App.tsx         Main app — chat, payment gate, all panels
│   ├── config.ts       wagmi + viem config (Arc Mainnet transport)
│   ├── MarketSwapPanel.tsx   Live prices + token swap
│   ├── OwnerDashboard.tsx    Contract admin panel
│   ├── QueryAnalytics.tsx    On-chain event charts
│   ├── PortfolioPanel.tsx    Portfolio monitor UI
│   ├── AgentStatusPanel.tsx  AI health + chain event stream
│   ├── PasskeyWallet.tsx     Circle Modular Wallet (ERC-4337)
│   └── SwapPanel.tsx         LiFi swap widget
└── README.md
```

---

## License

MIT
