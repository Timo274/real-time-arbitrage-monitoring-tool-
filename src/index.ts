/**
 * @file index.ts
 * @description Main entry point for the Raydium CPMM Arbitrage Monitor.
 *
 * This module orchestrates the entire CLI application:
 * 1. Parses command-line arguments (two mint addresses).
 * 2. Runs the main polling loop at the configured interval.
 * 3. On each tick: discovers pools → calculates prices → detects arbitrage.
 * 4. Renders a live-updating CLI table with pool data and opportunities.
 * 5. Handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Usage:
 *   npx ts-node src/index.ts <MINT1> <MINT2>
 *   node dist/index.js <MINT1> <MINT2>
 *
 * Example (SOL/USDC):
 *   npx ts-node src/index.ts \
 *     So11111111111111111111111111111111111111112 \
 *     EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */

import Table from "cli-table3";
import { config } from "./config";
import { logger } from "./logger";
import { discoverPools, CpmmPool } from "./raydium";
import { detectArbitrage, ArbitrageOpportunity, formatOpportunitySummary } from "./arbitrage";

// ── Constants ────────────────────────────────────────────────────────

/**
 * ANSI escape codes for terminal coloring.
 * We use raw codes to avoid extra dependencies.
 */
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

// ── State ────────────────────────────────────────────────────────────

let isRunning = true;
let tickCount = 0;
let lastPools: CpmmPool[] = [];
let lastOpportunities: ArbitrageOpportunity[] = [];

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Parse CLI arguments ──
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const [mint1, mint2] = args;

  // Basic validation: Solana addresses are base58, 32-44 chars
  if (!isValidSolanaAddress(mint1) || !isValidSolanaAddress(mint2)) {
    console.error(
      `${COLORS.red}Error: Invalid Solana mint address format.${COLORS.reset}`
    );
    console.error("Addresses should be 32-44 character base58 strings.\n");
    printUsage();
    process.exit(1);
  }

  if (mint1 === mint2) {
    console.error(
      `${COLORS.red}Error: Both mint addresses are the same.${COLORS.reset}`
    );
    process.exit(1);
  }

  // ── Print startup banner ──
  printBanner();
  printConfig(mint1, mint2);

  logger.info(
    {
      mint1: truncate(mint1),
      mint2: truncate(mint2),
      pollInterval: `${config.pollIntervalMs}ms`,
      minProfit: `$${config.minProfitThresholdUsd}`,
      tradeSize: `$${config.tradeSizeUsd}`,
    },
    "Starting Raydium CPMM Arbitrage Monitor"
  );

  // ── Register graceful shutdown ──
  setupGracefulShutdown();

  // ── Main polling loop ──
  while (isRunning) {
    try {
      await tick(mint1, mint2);
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        "Unhandled error in main loop"
      );
    }

    // Wait for the next polling interval
    if (isRunning) {
      await sleep(config.pollIntervalMs);
    }
  }

  console.log(`\n${COLORS.dim}Monitor stopped. Goodbye! 👋${COLORS.reset}\n`);
}

// ── Core Loop ────────────────────────────────────────────────────────

/**
 * Single iteration of the monitoring loop.
 * Discovers pools, calculates prices, detects arbitrage, and renders output.
 */
async function tick(mint1: string, mint2: string): Promise<void> {
  tickCount++;
  const tickStart = Date.now();

  logger.debug({ tick: tickCount }, `── Tick #${tickCount} ──`);

  // Step 1: Discover all CPMM pools for this pair
  const pools = await discoverPools(mint1, mint2);

  if (pools.length === 0) {
    renderNoPools(mint1, mint2);
    return;
  }

  lastPools = pools;

  // Step 2: Detect arbitrage opportunities
  const opportunities = detectArbitrage(pools);
  lastOpportunities = opportunities;

  // Step 3: Render the live-updating display
  renderDisplay(pools, opportunities, tickStart);

  // Step 4: Log actionable opportunities in detail
  for (const opp of opportunities.filter((o) => o.isActionable)) {
    logger.info(formatOpportunitySummary(opp));
  }
}

// ── Rendering ────────────────────────────────────────────────────────

/**
 * Clear the terminal and render the full display:
 * header, pool table, and arbitrage opportunities table.
 */
function renderDisplay(
  pools: CpmmPool[],
  opportunities: ArbitrageOpportunity[],
  tickStart: number
): void {
  // Clear screen and move cursor to top
  process.stdout.write("\x1b[2J\x1b[H");

  const elapsed = Date.now() - tickStart;
  const now = new Date().toLocaleTimeString();

  // ── Header ──
  console.log(
    `${COLORS.bold}${COLORS.cyan}╔══════════════════════════════════════════════════════════════════════════╗${COLORS.reset}`
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}║${COLORS.reset}  ${COLORS.bold}⚡ Raydium CPMM Arbitrage Monitor${COLORS.reset}                                       ${COLORS.cyan}║${COLORS.reset}`
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}╚══════════════════════════════════════════════════════════════════════════╝${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}  Tick #${tickCount} | ${now} | Latency: ${elapsed}ms | Pools: ${pools.length} | Interval: ${config.pollIntervalMs}ms${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}  Trade Size: $${config.tradeSizeUsd} | Min Profit: $${config.minProfitThresholdUsd} | SOL Price: $${config.solPriceUsd}${COLORS.reset}`
  );
  console.log();

  // ── Pool Table ──
  renderPoolTable(pools);

  // ── Arbitrage Table ──
  renderArbitrageTable(opportunities);

  // ── Footer ──
  console.log(
    `${COLORS.dim}  Press Ctrl+C to stop monitoring.${COLORS.reset}`
  );
}

/**
 * Render the pool discovery table showing all discovered CPMM pools.
 */
function renderPoolTable(pools: CpmmPool[]): void {
  console.log(
    `  ${COLORS.bold}${COLORS.white}📊 Discovered CPMM Pools${COLORS.reset}`
  );

  const table = new Table({
    head: [
      "Pool ID",
      "Type",
      "Pair",
      "Spot Price",
      "Fee Rate",
      "Reserve A",
      "Reserve B",
      "TVL (USD)",
      "24h Vol (USD)",
    ].map((h) => `${COLORS.cyan}${h}${COLORS.reset}`),
    style: {
      head: [],
      border: [],
    },
    colWidths: [16, 10, 14, 18, 10, 16, 16, 14, 14],
  });

  for (const pool of pools) {
    // NOTE: pool.reserveA/B are already in human-readable form from the API
    // (e.g., 55075 SOL, not 55075000000000 lamports). No decimal conversion needed.

    // Determine a short label for the pool type based on program ID
    let typeLabel = pool.type;
    if (pool.programId === "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C") {
      typeLabel = "CPMM";
    } else if (pool.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") {
      typeLabel = "AMM v4";
    } else if (pool.programId === "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK") {
      typeLabel = "CLMM";
    }

    table.push([
      `${pool.id.slice(0, 6)}...${pool.id.slice(-4)}`,
      typeLabel,
      `${pool.symbolA}/${pool.symbolB}`,
      pool.spotPrice < 0.001
        ? pool.spotPrice.toExponential(4)
        : pool.spotPrice.toFixed(6),
      `${(pool.feeRate * 100).toFixed(2)}%`,
      formatNumber(pool.reserveA),
      formatNumber(pool.reserveB),
      `$${formatNumber(pool.tvl)}`,
      `$${formatNumber(pool.volume24h)}`,
    ]);
  }

  console.log(table.toString());
  console.log();
}

/**
 * Render the arbitrage opportunities table.
 */
function renderArbitrageTable(opportunities: ArbitrageOpportunity[]): void {
  if (opportunities.length === 0) {
    console.log(
      `  ${COLORS.dim}🔍 No arbitrage opportunities detected across current pools.${COLORS.reset}`
    );
    console.log();
    return;
  }

  console.log(
    `  ${COLORS.bold}${COLORS.white}💰 Arbitrage Opportunities (ranked by net profit)${COLORS.reset}`
  );

  const table = new Table({
    head: [
      "#",
      "Buy Pool",
      "Sell Pool",
      "Buy Price",
      "Sell Price",
      "Spread %",
      "Gross ($)",
      "Fees ($)",
      "Net ($)",
      "Net %",
      "Status",
    ].map((h) => `${COLORS.magenta}${h}${COLORS.reset}`),
    style: {
      head: [],
      border: [],
    },
  });

  for (let i = 0; i < opportunities.length; i++) {
    const opp = opportunities[i];
    const rank = i + 1;

    // Color-code the net profit
    let netProfitStr: string;
    let statusStr: string;

    if (opp.isActionable) {
      netProfitStr = `${COLORS.green}${COLORS.bold}$${opp.netProfitUsd.toFixed(4)}${COLORS.reset}`;
      statusStr = `${COLORS.bgGreen}${COLORS.bold} ✅ GO ${COLORS.reset}`;
    } else if (opp.netProfitUsd > 0) {
      netProfitStr = `${COLORS.yellow}$${opp.netProfitUsd.toFixed(4)}${COLORS.reset}`;
      statusStr = `${COLORS.yellow}⚠ LOW${COLORS.reset}`;
    } else {
      netProfitStr = `${COLORS.red}-$${Math.abs(opp.netProfitUsd).toFixed(4)}${COLORS.reset}`;
      statusStr = `${COLORS.red}✗ NEG${COLORS.reset}`;
    }

    table.push([
      rank.toString(),
      `${opp.buyPool.id.slice(0, 6)}...${opp.buyPool.id.slice(-4)}`,
      `${opp.sellPool.id.slice(0, 6)}...${opp.sellPool.id.slice(-4)}`,
      opp.buyPrice < 0.001
        ? opp.buyPrice.toExponential(4)
        : opp.buyPrice.toFixed(6),
      opp.sellPrice < 0.001
        ? opp.sellPrice.toExponential(4)
        : opp.sellPrice.toFixed(6),
      `${opp.spreadPct.toFixed(4)}%`,
      `$${opp.grossProfitUsd.toFixed(4)}`,
      `$${opp.totalFeesUsd.toFixed(4)}`,
      netProfitStr,
      `${opp.netProfitPct.toFixed(4)}%`,
      statusStr,
    ]);
  }

  console.log(table.toString());
  console.log();

  // Print detailed breakdown for the best opportunity
  if (opportunities.length > 0 && opportunities[0].isActionable) {
    const best = opportunities[0];
    console.log(
      `  ${COLORS.bold}${COLORS.green}🏆 Best Opportunity Breakdown:${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Buy in:   ${best.buyPool.id.slice(0, 12)}... @ ${best.buyPrice.toFixed(8)} (fee: ${(best.buyPool.feeRate * 100).toFixed(2)}%)${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Sell in:  ${best.sellPool.id.slice(0, 12)}... @ ${best.sellPrice.toFixed(8)} (fee: ${(best.sellPool.feeRate * 100).toFixed(2)}%)${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Spread:   ${best.spreadPct.toFixed(6)}%${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Gross:    $${best.grossProfitUsd.toFixed(6)}${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Buy Fee:  $${best.buyFeeUsd.toFixed(6)}${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Sell Fee: $${best.sellFeeUsd.toFixed(6)}${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}├─ Tx Cost:  $${best.txCostUsd.toFixed(6)} (${config.solTxFeeEstimate * 2} SOL × $${config.solPriceUsd})${COLORS.reset}`
    );
    console.log(
      `  ${COLORS.dim}└─ Net:      ${COLORS.reset}${COLORS.green}${COLORS.bold}$${best.netProfitUsd.toFixed(6)} (${best.netProfitPct.toFixed(4)}%)${COLORS.reset}`
    );
    console.log();
  }
}

/**
 * Render a "no pools found" message.
 */
function renderNoPools(mint1: string, mint2: string): void {
  process.stdout.write("\x1b[2J\x1b[H");

  console.log(
    `${COLORS.bold}${COLORS.cyan}╔══════════════════════════════════════════════════════════════════════════╗${COLORS.reset}`
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}║${COLORS.reset}  ${COLORS.bold}⚡ Raydium CPMM Arbitrage Monitor${COLORS.reset}                                       ${COLORS.cyan}║${COLORS.reset}`
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}╚══════════════════════════════════════════════════════════════════════════╝${COLORS.reset}`
  );
  console.log();
  console.log(
    `  ${COLORS.yellow}⚠ No CPMM pools found for the given mint pair.${COLORS.reset}`
  );
  console.log(
    `  ${COLORS.dim}Mint 1: ${mint1}${COLORS.reset}`
  );
  console.log(
    `  ${COLORS.dim}Mint 2: ${mint2}${COLORS.reset}`
  );
  console.log();
  console.log(
    `  ${COLORS.dim}Possible reasons:${COLORS.reset}`
  );
  console.log(
    `  ${COLORS.dim}  • No Raydium CPMM pools exist for this pair${COLORS.reset}`
  );
  console.log(
    `  ${COLORS.dim}  • Mint addresses might be incorrect${COLORS.reset}`
  );
  console.log(
    `  ${COLORS.dim}  • API might be temporarily unavailable${COLORS.reset}`
  );
  console.log();
  console.log(
    `  ${COLORS.dim}Retrying in ${config.pollIntervalMs / 1000}s...${COLORS.reset}`
  );
}

// ── UI Helpers ───────────────────────────────────────────────────────

/**
 * Print the startup banner.
 */
function printBanner(): void {
  console.log();
  console.log(
    `${COLORS.cyan}${COLORS.bold}  ╦═╗╔═╗╦ ╦╔╦╗╦╦ ╦╔╦╗  ╔═╗╦═╗╔╗   ╔╦╗╔═╗╔╗╔╦╔╦╗╔═╗╦═╗${COLORS.reset}`
  );
  console.log(
    `${COLORS.cyan}${COLORS.bold}  ╠╦╝╠═╣╚╦╝ ║║║║ ║║║║  ╠═╣╠╦╝╠╩╗  ║║║║ ║║║║║ ║ ║ ║╠╦╝${COLORS.reset}`
  );
  console.log(
    `${COLORS.cyan}${COLORS.bold}  ╩╚═╩ ╩ ╩ ═╩╝╩╚═╝╩ ╩  ╩ ╩╩╚═╚═╝  ╩ ╩╚═╝╝╚╝╩ ╩ ╚═╝╩╚═${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}  Real-time CPMM pool arbitrage detection for Solana/Raydium${COLORS.reset}`
  );
  console.log(
    `${COLORS.dim}  ─────────────────────────────────────────────────────────${COLORS.reset}`
  );
  console.log();
}

/**
 * Print active configuration summary.
 */
function printConfig(mint1: string, mint2: string): void {
  console.log(`  ${COLORS.bold}Configuration:${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ RPC:          ${config.rpcEndpoint}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ Poll:         ${config.pollIntervalMs}ms${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ Trade Size:   $${config.tradeSizeUsd}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ Min Profit:   $${config.minProfitThresholdUsd}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ SOL Price:    $${config.solPriceUsd}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ Tx Fee Est:   ${config.solTxFeeEstimate} SOL${COLORS.reset}`);
  console.log(`  ${COLORS.dim}├─ Mint 1:       ${mint1}${COLORS.reset}`);
  console.log(`  ${COLORS.dim}└─ Mint 2:       ${mint2}${COLORS.reset}`);
  console.log();
}

/**
 * Print usage instructions.
 */
function printUsage(): void {
  console.log(`
${COLORS.bold}Raydium CPMM Arbitrage Monitor${COLORS.reset}

${COLORS.bold}USAGE:${COLORS.reset}
  npx ts-node src/index.ts <MINT1> <MINT2>
  node dist/index.js <MINT1> <MINT2>

${COLORS.bold}ARGUMENTS:${COLORS.reset}
  MINT1   First token mint address (Solana base58)
  MINT2   Second token mint address (Solana base58)

${COLORS.bold}EXAMPLES:${COLORS.reset}
  ${COLORS.dim}# Monitor SOL/USDC pools${COLORS.reset}
  npx ts-node src/index.ts \\
    So11111111111111111111111111111111111111112 \\
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

  ${COLORS.dim}# Monitor SOL/USDT pools${COLORS.reset}
  npx ts-node src/index.ts \\
    So11111111111111111111111111111111111111112 \\
    Es9vMFrzaCERmKfrSqb7jkWhw64hpVqXe9WEBLEBGAsH

${COLORS.bold}CONFIGURATION:${COLORS.reset}
  Copy .env.example to .env and configure:
  - RPC_ENDPOINT         Solana RPC URL
  - POLL_INTERVAL_MS     Polling frequency (ms)
  - MIN_PROFIT_THRESHOLD Minimum profit to flag (USD)
  - TRADE_SIZE_USD       Notional trade amount (USD)
  - SOL_PRICE_USD        SOL/USD price for fee calc
  `);
}

// ── Utility Functions ────────────────────────────────────────────────

/**
 * Basic Solana address format validation.
 * Real validation would require base58 decoding, but this catches most typos.
 */
function isValidSolanaAddress(address: string): boolean {
  // Base58 alphabet: no 0, O, I, l
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

/**
 * Truncate a mint address for display.
 */
function truncate(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * Format a number with locale-aware separators.
 * Handles large numbers (1234567 → "1,234,567") and
 * small numbers (0.000001234 → "0.000001234").
 */
function formatNumber(n: number): string {
  if (n === 0) return "0";

  if (Math.abs(n) < 0.001) {
    return n.toExponential(4);
  }

  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toFixed(2)}K`;
  }

  return n.toFixed(4);
}

/**
 * Promise-based sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register handlers for graceful shutdown.
 */
function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    logger.info({ signal }, `Received ${signal}, shutting down gracefully...`);
    isRunning = false;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── Entry Point ──────────────────────────────────────────────────────

main().catch((error) => {
  logger.fatal({ error: error.message, stack: error.stack }, "Fatal error");
  process.exit(1);
});
