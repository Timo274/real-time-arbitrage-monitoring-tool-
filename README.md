# ⚡ Raydium CPMM Arbitrage Monitor

> Real-time arbitrage monitoring tool for **Raydium Constant Product Market Maker (CPMM)** pools on **Solana**. Detects price discrepancies across pools for a given token pair and signals profitable arbitrage opportunities.

Built for the **Superteam Ukraine** bounty.

---

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Setup](#-setup)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Price & Profit Math](#-price--profit-math)
- [Project Structure](#-project-structure)
- [License](#-license)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Pool Discovery** | Fetches all CPMM pools for a given mint pair via the Raydium V3 API |
| **Real-Time Pricing** | Calculates accurate spot prices using on-chain reserves and the x·y=k formula |
| **Net Profit Calculation** | Accounts for buy pool fees, sell pool fees, AND Solana transaction costs |
| **Live CLI Dashboard** | Color-coded terminal UI with auto-refreshing pool and opportunity tables |
| **Structured Logging** | Pino-based logging with timestamps, levels, and JSON output for production |
| **Configurable** | RPC endpoint, polling interval, profit thresholds, trade size — all via `.env` |
| **Resilient** | Exponential back-off retry on API failures, graceful shutdown on Ctrl+C |

---

## 🏗 Architecture

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
│  │  1. Discover pools  →  2. Calculate prices         │  │
│  │  3. Detect arbitrage → 4. Render dashboard         │  │
│  └──────────┬──────────────────────┬─────────────────┘  │
│             │                      │                     │
│  ┌──────────▼──────────┐ ┌────────▼──────────────────┐  │
│  │   Pool Discovery    │ │  Arbitrage Detection      │  │
│  │   (raydium.ts)      │ │  (arbitrage.ts)           │  │
│  │                     │ │                            │  │
│  │  • Raydium V3 API   │ │  • Pairwise comparison    │  │
│  │  • Response parsing │ │  • Fee-adjusted profit    │  │
│  │  • Spot price calc  │ │  • Opportunity ranking    │  │
│  └─────────────────────┘ └────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
           ┌──────────────────────────┐
           │   Raydium V3 REST API    │
           │ api-v3.raydium.io/pools  │
           └──────────────────────────┘
```

---

## 🚀 Setup

### Prerequisites

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/raydium-cpmm-arbitrage-monitor.git
cd raydium-cpmm-arbitrage-monitor

# 2. Install dependencies
npm install

# 3. Create your .env configuration
cp .env.example .env

# 4. Edit .env with your preferred settings
# (especially RPC_ENDPOINT — use a private RPC for best results)

# 5. Run in development mode
npm run dev -- <MINT1> <MINT2>

# Or build and run the compiled version
npm run build
npm start -- <MINT1> <MINT2>
```

---

## ⚙ Configuration

All configuration is managed via environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_ENDPOINT` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint. **Use a private RPC** (Helius, QuickNode, Triton) for production. |
| `POLL_INTERVAL_MS` | `5000` | How often to poll the Raydium API (milliseconds). |
| `MIN_PROFIT_THRESHOLD_USD` | `0.50` | Minimum net profit (USD) to flag as "actionable". |
| `SOL_TX_FEE_ESTIMATE` | `0.00035` | Estimated SOL cost per transaction (base + priority fees). |
| `SOL_PRICE_USD` | `150.00` | Current SOL/USD price for fee conversion. |
| `TRADE_SIZE_USD` | `1000.00` | Notional trade amount for profit estimation. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

---

## 💻 Usage

### Basic Usage

```bash
# Monitor SOL/USDC CPMM pools
npm run dev -- \
  So11111111111111111111111111111111111111112 \
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Monitor SOL/USDT CPMM pools
npm run dev -- \
  So11111111111111111111111111111111111111112 \
  Es9vMFrzaCERmKfrSqb7jkWhw64hpVqXe9WEBLEBGAsH
```

### Output

The tool displays a live-updating terminal dashboard with two tables:

1. **Pool Table** — All discovered CPMM pools with reserves, spot prices, TVL, and fees.
2. **Arbitrage Table** — Ranked opportunities with spread, gross/net profit, fee breakdown, and status.

Status indicators:
- ✅ **GO** — Net profit exceeds the minimum threshold. Actionable!
- ⚠ **LOW** — Positive profit but below threshold.
- ✗ **NEG** — Negative profit after fees.

---

## 📐 Price & Profit Math

### Spot Price Calculation (CPMM: x · y = k)

For a Constant Product Market Maker pool with:
- **Reserve A** = amount of token A in the pool (base token)
- **Reserve B** = amount of token B in the pool (quote token)
- **Decimals A** / **Decimals B** = token decimal places

The **spot price** of 1 unit of token A in terms of token B is:

```
                  Reserve_B / 10^Decimals_B
Spot Price = ─────────────────────────────────
                  Reserve_A / 10^Decimals_A
```

**Example:** A SOL/USDC pool with:
- Reserve A (SOL) = 50,000 × 10⁹ = 50,000,000,000,000 (9 decimals)
- Reserve B (USDC) = 7,500,000 × 10⁶ = 7,500,000,000,000 (6 decimals)

```
Spot Price = (7,500,000,000,000 / 10⁶) / (50,000,000,000,000 / 10⁹)
           = 7,500,000 / 50,000
           = 150.00 USDC per SOL
```

### Arbitrage Profit Calculation

Given two pools with different spot prices:

```
Pool A (buy):  price_buy  = 149.80, fee_buy  = 0.25%
Pool B (sell): price_sell = 150.20, fee_sell = 0.25%
Trade size:    $1,000 USDC
Tx cost:       0.0007 SOL × $150 = $0.105
```

**Step 1: Buy base tokens in the cheap pool**
```
tokens_received = ($1,000 / 149.80) × (1 - 0.0025)
                = 6.6756 × 0.9975
                = 6.6589 SOL
```

**Step 2: Sell those tokens in the expensive pool**
```
sell_proceeds = 6.6589 × 150.20 × (1 - 0.0025)
              = 1,000.17 × 0.9975
              = $997.67
```

**Step 3: Calculate net profit**
```
gross_profit = $997.67 - $1,000.00 = -$2.33
net_profit   = -$2.33 - $0.105     = -$2.44
```

> **Note:** In this example, the spread (0.27%) is not enough to overcome the combined fees (0.50%). Profitable arbitrage requires spreads significantly larger than the combined fee rates of both pools.

### When is Arbitrage Profitable?

For arbitrage to be net-positive, the price spread must exceed:

```
Required Spread > fee_buy + fee_sell + (tx_cost / trade_size)
```

For typical CPMM pools with 0.25% fees:
```
Required Spread > 0.25% + 0.25% + ~0.01% ≈ 0.51%
```

This means you need at least a **0.51% price difference** between two pools before the trade becomes profitable.

---

## 📁 Project Structure

```
raydium-cpmm-arbitrage-monitor/
├── .env.example          # Environment variable template
├── .env                  # Your local config (git-ignored)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── README.md             # This file
└── src/
    ├── config.ts         # Environment variable parsing & validation
    ├── logger.ts         # Structured Pino logger setup
    ├── raydium.ts        # Raydium V3 API client & price calculation
    ├── arbitrage.ts      # Arbitrage detection & profit math
    └── index.ts          # CLI entry point & live dashboard renderer
```

### Module Responsibilities

| Module | Purpose |
|--------|---------|
| `config.ts` | Loads `.env`, validates required vars, exports a frozen typed config object |
| `logger.ts` | Creates a Pino logger with pino-pretty (dev) or JSON (prod) output |
| `raydium.ts` | Fetches pools from Raydium V3 API, parses responses, calculates spot prices |
| `arbitrage.ts` | Compares pool prices, calculates fee-adjusted profit, ranks opportunities |
| `index.ts` | Parses CLI args, runs the polling loop, renders the terminal dashboard |

---

## 📜 License

MIT License. See [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgments

- [Raydium](https://raydium.io/) — AMM and CPMM protocol on Solana
- [Superteam Ukraine](https://superteam.fun/) — Bounty sponsor
- [Solana](https://solana.com/) — High-performance blockchain
