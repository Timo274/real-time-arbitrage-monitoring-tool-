/**
 * @file arbitrage.ts
 * @description Arbitrage detection engine for Raydium CPMM pools.
 *
 * Given a set of CPMM pools for the same token pair, this module:
 * 1. Compares spot prices across all pool pairs (O(n²) but n is small).
 * 2. Identifies price discrepancies where buying in one pool and
 *    selling in another yields a positive spread.
 * 3. Deducts swap fees from BOTH the buy and sell pools.
 * 4. Deducts estimated Solana transaction costs (2 txs: buy + sell).
 * 5. Ranks opportunities by net profit descending.
 *
 * ─── PROFIT MATH ───
 *
 * Given:
 *   - tradeSize   = notional trade amount in quote token (e.g. USDC)
 *   - priceBuy    = spot price in the "cheap" pool (lower price)
 *   - priceSell   = spot price in the "expensive" pool (higher price)
 *   - feeRateBuy  = swap fee of the buy pool (e.g. 0.0025)
 *   - feeRateSell = swap fee of the sell pool (e.g. 0.0025)
 *   - txCostUsd   = estimated Solana tx fee in USD (for 2 transactions)
 *
 * Step 1: Amount of base token received from Buy pool (after fee)
 *   tokensReceived = (tradeSize / priceBuy) * (1 - feeRateBuy)
 *
 * Step 2: Proceeds from selling those tokens in Sell pool (after fee)
 *   sellProceeds = tokensReceived * priceSell * (1 - feeRateSell)
 *
 * Step 3: Net profit
 *   netProfit = sellProceeds - tradeSize - txCostUsd
 *
 * An opportunity is "actionable" when netProfit > minProfitThreshold.
 */

import { CpmmPool } from "./raydium";
import { config } from "./config";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Represents a single arbitrage opportunity between two pools.
 */
export interface ArbitrageOpportunity {
  /** Pool where we buy the base token (lower spot price) */
  buyPool: CpmmPool;

  /** Pool where we sell the base token (higher spot price) */
  sellPool: CpmmPool;

  /** Spot price in the buy pool */
  buyPrice: number;

  /** Spot price in the sell pool */
  sellPrice: number;

  /** Raw price spread as a percentage: ((sellPrice - buyPrice) / buyPrice) * 100 */
  spreadPct: number;

  /** Gross profit before fees (USD) */
  grossProfitUsd: number;

  /** Total fees deducted: buy fee + sell fee + tx costs (USD) */
  totalFeesUsd: number;

  /** Buy pool swap fee component (USD) */
  buyFeeUsd: number;

  /** Sell pool swap fee component (USD) */
  sellFeeUsd: number;

  /** Solana transaction cost component (USD) */
  txCostUsd: number;

  /** Net profit after all fees (USD) */
  netProfitUsd: number;

  /** Net profit as a percentage of trade size */
  netProfitPct: number;

  /** Whether this opportunity exceeds the minimum profit threshold */
  isActionable: boolean;

  /** Timestamp when this opportunity was detected */
  detectedAt: Date;
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Analyze a set of CPMM pools and detect all arbitrage opportunities.
 *
 * Compares every pool pair (i, j) where i ≠ j, treating pool i as
 * the buy side and pool j as the sell side when pool i has a lower
 * spot price. This is O(n²) but safe since n (number of CPMM pools
 * for a single pair) is typically ≤ 10.
 *
 * @param pools - Array of CpmmPool objects for the same token pair
 * @returns Sorted array of ArbitrageOpportunity (best first)
 */
export function detectArbitrage(pools: CpmmPool[]): ArbitrageOpportunity[] {
  if (pools.length < 2) {
    logger.debug("Need at least 2 pools for arbitrage detection");
    return [];
  }

  const opportunities: ArbitrageOpportunity[] = [];
  const tradeSizeUsd = config.tradeSizeUsd;

  // Estimated tx cost in USD for the full arb round-trip (2 swaps)
  // Each swap is a separate transaction on Solana
  const txCostUsd = config.solTxFeeEstimate * 2 * config.solPriceUsd;

  // Compare all pool pairs
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const poolA = pools[i];
      const poolB = pools[j];

      // Skip pools with invalid prices
      if (poolA.spotPrice <= 0 || poolB.spotPrice <= 0) continue;

      // Determine which pool is cheaper (buy) and which is more expensive (sell)
      let buyPool: CpmmPool;
      let sellPool: CpmmPool;

      if (poolA.spotPrice < poolB.spotPrice) {
        buyPool = poolA;
        sellPool = poolB;
      } else {
        buyPool = poolB;
        sellPool = poolA;
      }

      const opp = calculateOpportunity(
        buyPool,
        sellPool,
        tradeSizeUsd,
        txCostUsd
      );

      // Only include opportunities with a positive spread
      // (even if not profitable after fees — useful for monitoring)
      if (opp.spreadPct > 0) {
        opportunities.push(opp);
      }
    }
  }

  // Sort by net profit descending (best opportunities first)
  opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

  // Log summary
  const actionable = opportunities.filter((o) => o.isActionable);
  if (actionable.length > 0) {
    logger.info(
      {
        total: opportunities.length,
        actionable: actionable.length,
        bestProfit: `$${actionable[0].netProfitUsd.toFixed(4)}`,
      },
      `🚨 ${actionable.length} actionable arbitrage opportunit${actionable.length === 1 ? "y" : "ies"} detected!`
    );
  } else if (opportunities.length > 0) {
    logger.debug(
      {
        total: opportunities.length,
        bestSpread: `${opportunities[0].spreadPct.toFixed(4)}%`,
      },
      "Spread detected but below profit threshold after fees"
    );
  }

  return opportunities;
}

/**
 * Calculate the full profit/loss breakdown for a single arbitrage opportunity.
 *
 * @param buyPool     - The pool with the lower spot price (we buy here)
 * @param sellPool    - The pool with the higher spot price (we sell here)
 * @param tradeSizeUsd - Notional trade size in USD
 * @param txCostUsd   - Estimated round-trip Solana tx cost in USD
 * @returns Fully computed ArbitrageOpportunity
 */
function calculateOpportunity(
  buyPool: CpmmPool,
  sellPool: CpmmPool,
  tradeSizeUsd: number,
  txCostUsd: number
): ArbitrageOpportunity {
  const buyPrice = buyPool.spotPrice;
  const sellPrice = sellPool.spotPrice;

  // ── Step 1: Calculate raw spread ──
  const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

  // ── Step 2: Simulate the buy leg ──
  // We spend `tradeSizeUsd` worth of quote tokens to buy base tokens.
  // The buy pool charges its fee on the input.
  const tokensReceived = (tradeSizeUsd / buyPrice) * (1 - buyPool.feeRate);

  // ── Step 3: Simulate the sell leg ──
  // We sell the received base tokens in the sell pool.
  // The sell pool charges its fee on the output.
  const sellProceeds = tokensReceived * sellPrice * (1 - sellPool.feeRate);

  // ── Step 4: Calculate profit components ──
  const grossProfitUsd = sellProceeds - tradeSizeUsd;

  // Fee breakdown for transparency
  const buyFeeUsd = (tradeSizeUsd / buyPrice) * buyPool.feeRate * buyPrice;
  const sellFeeUsd = tokensReceived * sellPrice * sellPool.feeRate;

  const totalFeesUsd = buyFeeUsd + sellFeeUsd + txCostUsd;
  const netProfitUsd = grossProfitUsd - txCostUsd;
  const netProfitPct = (netProfitUsd / tradeSizeUsd) * 100;

  const isActionable = netProfitUsd >= config.minProfitThresholdUsd;

  return {
    buyPool,
    sellPool,
    buyPrice,
    sellPrice,
    spreadPct,
    grossProfitUsd,
    totalFeesUsd,
    buyFeeUsd,
    sellFeeUsd,
    txCostUsd,
    netProfitUsd,
    netProfitPct,
    isActionable,
    detectedAt: new Date(),
  };
}

/**
 * Format an opportunity as a human-readable summary string.
 * Used for logging actionable opportunities.
 */
export function formatOpportunitySummary(opp: ArbitrageOpportunity): string {
  const pair = `${opp.buyPool.symbolA}/${opp.buyPool.symbolB}`;
  const buyId = opp.buyPool.id.slice(0, 8);
  const sellId = opp.sellPool.id.slice(0, 8);

  return [
    `[${pair}] Arbitrage Opportunity`,
    `  Buy  @ ${buyId}... : ${opp.buyPrice.toFixed(8)} (fee: ${(opp.buyPool.feeRate * 100).toFixed(2)}%)`,
    `  Sell @ ${sellId}... : ${opp.sellPrice.toFixed(8)} (fee: ${(opp.sellPool.feeRate * 100).toFixed(2)}%)`,
    `  Spread: ${opp.spreadPct.toFixed(4)}%`,
    `  Gross:  $${opp.grossProfitUsd.toFixed(4)}`,
    `  Fees:   $${opp.totalFeesUsd.toFixed(4)} (buy: $${opp.buyFeeUsd.toFixed(4)}, sell: $${opp.sellFeeUsd.toFixed(4)}, tx: $${opp.txCostUsd.toFixed(4)})`,
    `  Net:    $${opp.netProfitUsd.toFixed(4)} (${opp.netProfitPct.toFixed(4)}%)`,
    `  Status: ${opp.isActionable ? "✅ ACTIONABLE" : "❌ Below threshold"}`,
  ].join("\n");
}
