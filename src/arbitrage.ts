/**
 * @file arbitrage.ts
 * @description Arbitrage detection engine for Raydium CPMM pools.
 *
 * Given a set of CPMM pools for the same token pair, this module:
 * 1. Compares spot prices across all pool pairs (O(n²) but n is small).
 * 2. Identifies price discrepancies where buying in one pool and
 *    selling in another yields a positive spread.
 * 3. Simulates the actual constant-product swap on each leg
 *    (Δy = (Δx · (1 − f) · y) / (x + Δx · (1 − f))), so the result
 *    accounts for slippage / pool depth — not just the spot spread.
 * 4. Deducts estimated Solana transaction costs (2 transactions:
 *    buy leg + sell leg).
 * 5. Ranks opportunities by net profit descending.
 *
 * ─── PROFIT MATH (CPMM constant-product) ───
 *
 * For a pool with reserves (xBase, yQuote) and fee rate f, swapping
 * `dQuoteIn` quote tokens for base tokens yields:
 *
 *   dQuoteAfterFee = dQuoteIn * (1 − f)
 *   dBaseOut       = (dQuoteAfterFee * xBase) / (yQuote + dQuoteAfterFee)
 *
 * For the symmetric direction (selling `dBaseIn` base tokens for quote):
 *
 *   dBaseAfterFee  = dBaseIn * (1 − f)
 *   dQuoteOut      = (dBaseAfterFee * yQuote) / (xBase + dBaseAfterFee)
 *
 * Round-trip arbitrage:
 *   1) Spend `tradeSizeQuote` USD-equivalent quote in the buy pool → baseOut
 *   2) Sell baseOut in the sell pool → quoteOut
 *   3) netProfit = quoteOut − tradeSizeQuote − txCost
 *
 * IMPORTANT: This properly accounts for slippage. Earlier the code used
 * a "spot price * trade size" approximation, which produced absurd net
 * profits on dust pools (e.g. $33 463 on a $1 000 trade against a $20-TVL
 * pool). With the AMM formula such pools naturally show negative net
 * profit because the swap consumes the entire pool.
 */

import { CpmmPool } from "./raydium";
import { config } from "./config";
import { logger } from "./logger";
import { getSolPriceUsdSync } from "./priceFeed";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Represents a single arbitrage opportunity between two pools.
 */
export interface ArbitrageOpportunity {
  /** Pool where we buy the base token (lower spot price) */
  buyPool: CpmmPool;

  /** Pool where we sell the base token (higher spot price) */
  sellPool: CpmmPool;

  /** Spot price in the buy pool (informational) */
  buyPrice: number;

  /** Spot price in the sell pool (informational) */
  sellPrice: number;

  /** Raw price spread as a percentage: ((sellPrice - buyPrice) / buyPrice) * 100 */
  spreadPct: number;

  /** Effective price actually paid for base on the buy leg (after slippage) */
  effectiveBuyPrice: number;

  /** Effective price actually received for base on the sell leg (after slippage) */
  effectiveSellPrice: number;

  /** Base tokens received from the buy leg (after fee + slippage) */
  baseAmountOut: number;

  /** Quote tokens received from the sell leg (after fee + slippage) */
  quoteAmountOut: number;

  /** Gross profit (USD) before tx costs but after pool fees + slippage */
  grossProfitUsd: number;

  /** Buy pool swap fee component (USD) */
  buyFeeUsd: number;

  /** Sell pool swap fee component (USD) */
  sellFeeUsd: number;

  /** Solana transaction cost component (USD) */
  txCostUsd: number;

  /**
   * Total deduction from gross to net profit (USD).
   *
   * Pool fees are already embedded inside `grossProfitUsd` via the CPMM
   * swap math (see `getCpmmAmountOut`), so the only additional cost on top
   * of the gross is the round-trip Solana transaction cost. This value is
   * therefore equal to `txCostUsd`, ensuring `grossProfitUsd - totalFeesUsd
   * === netProfitUsd` in the dashboard table.
   *
   * `buyFeeUsd` / `sellFeeUsd` are still reported separately for
   * transparency about how much of the slippage came from protocol fees.
   */
  totalFeesUsd: number;

  /** Net profit after pool fees, slippage AND tx costs (USD) */
  netProfitUsd: number;

  /** Net profit as a percentage of trade size */
  netProfitPct: number;

  /** Whether this opportunity exceeds the minimum profit threshold */
  isActionable: boolean;

  /** Timestamp when this opportunity was detected */
  detectedAt: Date;
}

// ── Pure math helpers ────────────────────────────────────────────────

/**
 * Constant-product swap output, with a fee charged on the input side.
 *
 *   amountInAfterFee = amountIn * (1 − feeRate)
 *   amountOut        = (amountInAfterFee * reserveOut) /
 *                      (reserveIn + amountInAfterFee)
 *
 * @param amountIn   Input amount (in input-token human units)
 * @param reserveIn  Pool reserve of the input token (human units)
 * @param reserveOut Pool reserve of the output token (human units)
 * @param feeRate    Fee rate as a decimal (e.g. 0.0025 for 25 bps)
 * @returns Output amount (human units), or 0 for invalid inputs
 */
export function getCpmmAmountOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  feeRate: number
): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  if (feeRate < 0 || feeRate >= 1) return 0;

  const amountInAfterFee = amountIn * (1 - feeRate);
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
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

  // Tx cost in USD for the full arbitrage round-trip (2 transactions).
  // Uses the live SOL/USD price (refreshed by the price feed) and falls
  // back to the static config value if the feed hasn't populated yet.
  const solPriceUsd = getSolPriceUsdSync();
  const txCostUsd = config.solTxFeeEstimate * 2 * solPriceUsd;

  // Compare all pool pairs
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const poolA = pools[i];
      const poolB = pools[j];

      // Skip pools with invalid prices
      if (poolA.spotPrice <= 0 || poolB.spotPrice <= 0) continue;

      // Determine which pool is cheaper (buy) and more expensive (sell)
      const [buyPool, sellPool] =
        poolA.spotPrice < poolB.spotPrice ? [poolA, poolB] : [poolB, poolA];

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
      `${actionable.length} actionable arbitrage opportunit${actionable.length === 1 ? "y" : "ies"} detected`
    );
  } else if (opportunities.length > 0) {
    logger.debug(
      {
        total: opportunities.length,
        bestSpread: `${opportunities[0].spreadPct.toFixed(4)}%`,
      },
      "Spread detected but below profit threshold after fees + slippage"
    );
  }

  return opportunities;
}

/**
 * Calculate the full profit/loss breakdown for a single arbitrage opportunity,
 * simulating both legs against the actual CPMM curve (so slippage is
 * correctly priced in).
 *
 * Reserve orientation: in our `CpmmPool`, `reserveA` is base and `reserveB`
 * is quote. `spotPrice` = reserveB / reserveA (i.e. price of 1 base in quote).
 * Trade size is denominated in quote; we convert to USD via tradeSizeUsd
 * (the user supplies trade size already in USD).
 *
 * @param buyPool      Pool with the lower spot price (we buy base here)
 * @param sellPool     Pool with the higher spot price (we sell base here)
 * @param tradeSizeUsd Notional trade size in USD (= quote amount in)
 * @param txCostUsd    Estimated round-trip Solana tx cost in USD
 */
function calculateOpportunity(
  buyPool: CpmmPool,
  sellPool: CpmmPool,
  tradeSizeUsd: number,
  txCostUsd: number
): ArbitrageOpportunity {
  const buyPrice = buyPool.spotPrice;
  const sellPrice = sellPool.spotPrice;

  // ── Spot spread (informational only — actual profit uses AMM math) ──
  const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

  // ── Buy leg: spend `tradeSizeUsd` of quote (B) to get base (A) ──
  // Inputs: reserveIn = buyPool.reserveB (quote), reserveOut = buyPool.reserveA (base)
  const baseAmountOut = getCpmmAmountOut(
    tradeSizeUsd,
    buyPool.reserveB,
    buyPool.reserveA,
    buyPool.feeRate
  );

  // ── Sell leg: sell base (A) into sellPool to get quote (B) ──
  // Inputs: reserveIn = sellPool.reserveA (base), reserveOut = sellPool.reserveB (quote)
  const quoteAmountOut = getCpmmAmountOut(
    baseAmountOut,
    sellPool.reserveA,
    sellPool.reserveB,
    sellPool.feeRate
  );

  // ── Effective prices (post-slippage) ──
  // Effective buy price: USD-quote spent per base received
  const effectiveBuyPrice =
    baseAmountOut > 0 ? tradeSizeUsd / baseAmountOut : Number.POSITIVE_INFINITY;
  // Effective sell price: USD-quote received per base sold
  const effectiveSellPrice =
    baseAmountOut > 0 ? quoteAmountOut / baseAmountOut : 0;

  // ── Profit components ──
  const grossProfitUsd = quoteAmountOut - tradeSizeUsd;

  // Fee breakdown (informational only): the protocol fee deducted on each
  // leg. These are *already* baked into `grossProfitUsd` via the CPMM swap
  // math, so they MUST NOT be subtracted again when computing net profit.
  // We surface them separately just to show the user how much of the
  // slippage came from protocol fees vs. price impact.
  // Buy leg fee in USD = quote-in * feeRate (charged on quote input).
  const buyFeeUsd = tradeSizeUsd * buyPool.feeRate;
  // Sell leg fee in USD = effective USD value of the base-input fee.
  const sellFeeUsd = baseAmountOut * effectiveSellPrice * sellPool.feeRate;

  // Pool fees are embedded in grossProfitUsd; the only deduction left is
  // the round-trip tx cost. Keeping totalFeesUsd === txCostUsd preserves
  // the `Gross − Fees = Net` invariant shown in the dashboard.
  const totalFeesUsd = txCostUsd;
  const netProfitUsd = grossProfitUsd - totalFeesUsd;
  const netProfitPct = (netProfitUsd / tradeSizeUsd) * 100;

  const isActionable = netProfitUsd >= config.minProfitThresholdUsd;

  return {
    buyPool,
    sellPool,
    buyPrice,
    sellPrice,
    spreadPct,
    effectiveBuyPrice,
    effectiveSellPrice,
    baseAmountOut,
    quoteAmountOut,
    grossProfitUsd,
    buyFeeUsd,
    sellFeeUsd,
    txCostUsd,
    totalFeesUsd,
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
    `  Buy  @ ${buyId}... : spot=${opp.buyPrice.toFixed(8)}  effective=${opp.effectiveBuyPrice.toFixed(8)} (fee: ${(opp.buyPool.feeRate * 100).toFixed(2)}%)`,
    `  Sell @ ${sellId}... : spot=${opp.sellPrice.toFixed(8)}  effective=${opp.effectiveSellPrice.toFixed(8)} (fee: ${(opp.sellPool.feeRate * 100).toFixed(2)}%)`,
    `  Spread (spot): ${opp.spreadPct.toFixed(4)}%`,
    `  Base out:      ${opp.baseAmountOut.toFixed(6)} ${opp.buyPool.symbolA}`,
    `  Quote out:     ${opp.quoteAmountOut.toFixed(4)} ${opp.buyPool.symbolB}`,
    `  Gross:         $${opp.grossProfitUsd.toFixed(4)}`,
    `  Fees:          $${opp.totalFeesUsd.toFixed(4)} (buy: $${opp.buyFeeUsd.toFixed(4)}, sell: $${opp.sellFeeUsd.toFixed(4)}, tx: $${opp.txCostUsd.toFixed(4)})`,
    `  Net:           $${opp.netProfitUsd.toFixed(4)} (${opp.netProfitPct.toFixed(4)}%)`,
    `  Status:        ${opp.isActionable ? "ACTIONABLE" : "Below threshold"}`,
  ].join("\n");
}
