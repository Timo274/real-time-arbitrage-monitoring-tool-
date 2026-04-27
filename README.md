# Raydium CPMM Arbitrage Monitor

> Real-time arbitrage monitoring tool for **Raydium Constant Product Market Maker (CPMM)** pools on **Solana**. Detects price discrepancies across pools for a given token pair and signals profitable arbitrage opportunities — accounting for **fees, slippage, and transaction costs**.

Built for the **Superteam Ukraine** bounty.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Setup](#setup)
- [Configuration](#configuration)
- [Usage](#usage)
- [Price & Profit Math](#price--profit-math)
- [Project Structure](#project-structure)
- [Tests](#tests)
- [License](#license)

---

## Features

| Feature | Description |
|---------|-------------|
| **Pool Discovery** | Fetches all CPMM pools for a given mint pair via the Raydium V3 API. Optional inclusion of legacy AMM v4 pools. |
| **Real-Time Pricing** | Two modes: (a) Raydium HTTP API (cached, fast); (b) **on-chain refresh** of reserves from CPMM vault accounts via JSON-RPC every tick. |
| **Net Profit Calculation** | Simulates each leg of the round-trip swap with the **actual constant-product formula** — so slippage on shallow pools is correctly priced in (no more "$33 463 net profit on a $20-TVL pool"). |
| **Live CLI Dashboard** | Color-coded terminal UI with auto-refreshing pool and opportunity tables; full breakdown for the best opportunity. |
| **Structured Logging** | Pino-based logging with timestamps, levels, JSON output for production, per-tick price-update info logs. |
| **Configurable** | RPC endpoint, polling interval, profit / TVL thresholds, trade size, on-chain mode — all via `.env`. |
| **Live SOL price** | SOL/USD price fetched from Raydium's price endpoint at startup and refreshed every ~30s, so tx-fee USD conversion stays accurate. Static `.env` value is only used as a fallback. |
| **Resilient** | Exponential back-off retry on API failures, graceful shutdown on Ctrl+C. |
| **Tested** | Vitest unit tests for the swap formula and arbitrage detection (incl. dust-pool regression test). |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    CLI Entry Point                       │
│                    (src/index.ts)                        │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │   Config     │   │   Logger     │   │  Rendering   │  │
│  │ (config.ts)  │   │ (logger.ts)  │   │  (index.ts)  │  │
│  └──────┬──────┘   └──────┬───────┘   └──────┬───────┘  │
│         │                 │                   │          │
│  ┌──────▼──────────────────▼───────────────────▼──────┐  │
│  │              Main Polling Loop                     │  │
│  │  1. Discover pools                                 │  │
│  │  2. (Optional) refresh reserves on-chain           │  │
│  │  3. Filter by TVL                                  │  │
│  │  4. Detect arbitrage (full CPMM swap math)         │  │
│  │  5. Render dashboard                               │  │
│  └──────────┬───────────┬───────────────┬───────────┘  │
│             │           │               │                │
│  ┌──────────▼──┐ ┌──────▼─────┐ ┌───────▼──────────┐    │
│  │   Raydium   │ │  On-chain  │ │   Arbitrage      │    │
│  │ (raydium.ts)│ │(onchain.ts)│ │  (arbitrage.ts)  │    │
│  └─────────────┘ └────────────┘ └──────────────────┘    │
└──────────────────────────────────────────────────────────┘
            │             │
            ▼             ▼
   Raydium V3 REST    Solana JSON-RPC
   /pools/info/mint   getMultipleAccountsInfo
   /pools/key/ids     (vault SPL Token accounts)
```

---

## Setup

### Prerequisites

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/Timo274/real-time-arbitrage-monitoring-tool-.git
cd real-time-arbitrage-monitoring-tool-

# 2. Install dependencies
npm install

# 3. Create your .env configuration
cp .env.example .env

# 4. (Optional) Edit .env — especially RPC_ENDPOINT and USE_ONCHAIN_RESERVES
#    if you want true on-chain real-time monitoring with a private RPC.

# 5. Run in development mode
npm run dev -- <MINT1> <MINT2>

# Or build and run the compiled version
npm run build
npm start -- <MINT1> <MINT2>
```

---

## Configuration

All configuration is managed via environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_ENDPOINT` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint. **Use a private RPC** (Helius, QuickNode, Triton) for production. Only used when `USE_ONCHAIN_RESERVES=true`. |
| `USE_ONCHAIN_RESERVES` | `false` | When `true`, refresh pool reserves from on-chain vault accounts every tick. When `false`, reserves come from the Raydium HTTP API (which can lag). |
| `POLL_INTERVAL_MS` | `5000` | How often to poll for fresh data (milliseconds). |
| `MIN_PROFIT_THRESHOLD_USD` | `0.50` | Minimum net profit (USD) to flag as "actionable". `0` = flag every positive opportunity. |
| `MIN_POOL_TVL_USD` | `1000` | Pools below this TVL are still discovered/displayed but excluded from arbitrage detection (avoids dust-pool noise). `0` to include all. |
| `INCLUDE_AMM_V4` | `true` | Also include legacy Raydium AMM v4 pools alongside CPMM. CLMM is never included — its tick math doesn't match `x·y=k`. Set to `false` for CPMM-only mode. |
| `SOL_TX_FEE_ESTIMATE` | `0.00035` | Estimated SOL cost per transaction (base + priority fees). |
| `SOL_PRICE_USD` | `150.00` | Static fallback SOL/USD price. The live price is fetched from Raydium's price endpoint at startup and refreshed every ~30s; this value is only used if the network call fails. |
| `TRADE_SIZE_USD` | `1000.00` | Notional trade amount for profit estimation. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

---

## Usage

### Basic Usage

```bash
# Monitor SOL/USDC pools (default config — Raydium API only, CPMM only)
npm run dev -- \
  So11111111111111111111111111111111111111112 \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Monitor SOL/USDT, including AMM v4 pools, with on-chain reserve refresh
INCLUDE_AMM_V4=true USE_ONCHAIN_RESERVES=true \
RPC_ENDPOINT=https://your-private-rpc.example.com \
  npm run dev -- \
    So11111111111111111111111111111111111111112 \
    Es9vMFrzaCERmKfrSqb7jkWhw64hpVqXe9WEBLEBGAsH
```

### Output

The tool displays a live-updating terminal dashboard with two tables:

1. **Pool Table** — All discovered pools with reserves, spot prices, TVL, and fees.
2. **Arbitrage Table** — Ranked opportunities with spread, gross/net profit, fee breakdown, and status.

Status indicators:
- **GO** — Net profit exceeds the minimum threshold. Actionable.
- **LOW** — Positive profit but below threshold.
- **NEG** — Negative profit after fees + slippage.

For the best actionable opportunity, the dashboard also prints a full breakdown including effective (post-slippage) prices, base/quote amounts, fee components and tx cost.

---

## Price & Profit Math

### Spot Price

For a CPMM pool with reserves `(reserveA, reserveB)` (already in human-readable units — the Raydium API returns `mintAmountA/B` post-decimal, and on-chain mode also normalizes by `10^decimals`), the spot price of 1 unit of token A in token B is simply:

```
Spot Price = reserveB / reserveA
```

**Example:** A SOL/USDC pool with `reserveA = 50 000 SOL` and `reserveB = 7 500 000 USDC` has a spot price of `7 500 000 / 50 000 = 150 USDC per SOL`.

### Arbitrage Profit (full CPMM swap simulation)

Given:
- `tradeSizeUsd` — notional trade size in USD (= quote-side input for the buy leg)
- `(xA, yA, fA)` — buy pool's base reserve, quote reserve, fee rate
- `(xB, yB, fB)` — sell pool's base reserve, quote reserve, fee rate
- `txCostUsd = SOL_TX_FEE_ESTIMATE * 2 * SOL_PRICE_USD`

We simulate both legs against the actual constant-product curve:

**Buy leg** — spend `tradeSizeUsd` quote in pool A to receive base:
```
quoteAfterFee = tradeSizeUsd * (1 - fA)
baseOut       = (quoteAfterFee * xA) / (yA + quoteAfterFee)
```

**Sell leg** — sell `baseOut` of base in pool B to receive quote:
```
baseAfterFee  = baseOut * (1 - fB)
quoteOut      = (baseAfterFee * yB) / (xB + baseAfterFee)
```

**Net profit:**
```
grossProfit = quoteOut - tradeSizeUsd
netProfit   = grossProfit - txCostUsd
```

**Why slippage matters.** Earlier versions of this tool used the naive approximation `tokensReceived = tradeSize / spotPrice`, which assumes infinite liquidity. For dust pools (TVL ≪ trade size) this produced absurd results — e.g. a $1 000 trade against a $20-TVL pool was reported as `+$33 463 net profit`. With the real CPMM formula the output is bounded above by `reserveOut`, so dust-pool "opportunities" naturally collapse to large *losses*, not fake gains. There's a regression test in `src/arbitrage.test.ts` that locks in this behavior.

### Effective Price (post-slippage)

The dashboard shows two prices per leg:

- **Spot price** — `reserveB / reserveA`, the price for an infinitesimal trade.
- **Effective price** — `tradeSizeUsd / baseOut` on the buy leg, `quoteOut / baseOut` on the sell leg. This is what you actually pay/receive after slippage.

For deep pools the two are within bps. For shallow pools they diverge dramatically — and the effective prices are what determine actual P&L.

### When is Arbitrage Profitable?

For a round-trip arbitrage to be net-positive, the **effective** spread (not the spot spread) must exceed the combined fees. As a rough first-pass rule for two CPMM pools both with fee `f`:

```
Required spot spread > 2f + slippageBuy + slippageSell + (txCost / tradeSize)
```

For 0.25 % CPMM pools both deep enough for negligible slippage and a $1 000 trade, the floor is ≈ 0.51 %.

---

## Project Structure

```
real-time-arbitrage-monitoring-tool-/
├── .env.example          # Environment variable template
├── .env                  # Your local config (git-ignored)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── vitest.config.ts      # Test runner configuration
├── README.md             # This file
└── src/
    ├── config.ts         # Environment variable parsing & validation
    ├── logger.ts         # Structured Pino logger setup
    ├── raydium.ts        # Raydium V3 API client & pool parsing
    ├── onchain.ts        # On-chain reserve refresh via JSON-RPC
    ├── priceFeed.ts      # Live SOL/USD price feed (Raydium /mint/price)
    ├── arbitrage.ts      # CPMM swap simulation & arbitrage detection
    ├── arbitrage.test.ts # Unit tests for arbitrage math
    ├── raydium.test.ts   # Unit tests for spot-price helpers
    └── index.ts          # CLI entry point & live dashboard renderer
```

### Module Responsibilities

| Module | Purpose |
|--------|---------|
| `config.ts` | Loads `.env`, validates required vars, exports a frozen typed config object. |
| `logger.ts` | Creates a Pino logger with pino-pretty (dev) or JSON (prod) output. |
| `raydium.ts` | Fetches pools from Raydium V3 API, parses responses, computes reserve-based spot prices, filters by program ID (CPMM, optionally AMM v4). |
| `onchain.ts` | Resolves vault pubkeys for discovered pools, fetches them with `getMultipleAccountsInfo`, decodes SPL Token amount, mutates pools in-place with fresh reserves. |
| `priceFeed.ts` | Fetches SOL/USD from Raydium's `/mint/price` endpoint and caches it (auto-refreshes every 30 s). Falls back to the static `SOL_PRICE_USD` if the endpoint is unreachable. |
| `arbitrage.ts` | Simulates round-trip swaps with the proper CPMM formula, ranks opportunities by net profit. |
| `index.ts` | Parses CLI args, runs the polling loop, renders the terminal dashboard. |

---

## Tests

```bash
npm test          # run all unit tests once
npm run test:watch  # run in watch mode
npm run typecheck   # tsc --noEmit
```

Coverage:
- `getCpmmAmountOut` — boundary conditions, monotonicity in trade size, fee monotonicity, closed-form value match.
- `calculateSpotPrice` — basic ratio, zero-reserve guard, large/small reserve scaling.
- `detectArbitrage` — pair detection, ranking, **dust-pool regression test** (asserts the slippage cap), spot-spread direction, no-spread short-circuit.

---

## License

MIT License. See [LICENSE](./LICENSE) for details.

---

## Acknowledgments

- [Raydium](https://raydium.io/) — AMM and CPMM protocol on Solana
- [Superteam Ukraine](https://superteam.fun/) — Bounty sponsor
- [Solana](https://solana.com/) — High-performance blockchain
