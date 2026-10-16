# CryptoAdvisor

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

A pay-per-query crypto knowledge agent. Users connect their wallet and pay $0.01 USDC per question. The app covers Bitcoin, Ethereum, DeFi, NFTs, meme coins, wallets, staking, Layer 2s, and more. Includes dark/light mode, topic browser, bookmarks, history, and glossary.

## Smart Contracts

| Contract | Address | Chain | Explorer |
|---|---|---|---|
| QueryPayment (Testnet) | 0x32ffcf43c1345b4e0769d418bfc6a74291b1c3ce | Arc Testnet | https://explorer.testnet.arc.io/address/0x32ffcf43c1345b4e0769d418bfc6a74291b1c3ce |
| QueryPayment (Mainnet) | 0x0a83a718D6d8cBE850B986c025dE287bc3fe5a29 | Arc Mainnet | https://explorer.arc.io/address/0x0a83a718D6d8cBE850B986c025dE287bc3fe5a29 |

### Mainnet Deployment (must be done by you — Arc Studio does not deploy to mainnet)

1. Compile: `forge build` from `contracts/` (Solidity source: `contracts/QueryPayment.sol`)
2. Deploy from your own wallet to Arc Mainnet (chainId 5042, RPC: `https://rpc.mainnet.arc.io`) with these constructor args:
   - `usdcToken`: `0x3600000000000000000000000000000000000000` (Arc Mainnet USDC)
   - `initialOwner`: your wallet address
   - `initialFeeAmount`: `10000` (= $0.01 USDC, 6 decimals) — adjust as needed
3. After deployment, update `QUERY_PAYMENT_ADDRESS` in `src/App.tsx` (line ~22) with the deployed contract address.
4. Verify the contract on the Arc Mainnet explorer: https://explorer.arc.io

**Current frontend config**: points to Arc Mainnet (chainId 5042). The placeholder address `0x000...000` in `App.tsx` MUST be replaced before going live.

- USDC token (Arc Mainnet): 0x3600000000000000000000000000000000000000 (6 decimals ERC-20)
- Arc Mainnet explorer: https://explorer.arc.io

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Mainnet (Chain ID: 5042, imported from `viem/chains` as `arc`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Mainnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
