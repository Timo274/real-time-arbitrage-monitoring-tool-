/**
 * @file arbitrage.test.ts
 * @description Unit tests for the CPMM swap formula and arbitrage detection.
 */

import { describe, it, expect } from "vitest";
import { getCpmmAmountOut, detectArbitrage } from "./arbitrage";
import type { CpmmPool } from "./raydium";

function makePool(overrides: Partial<CpmmPool>): CpmmPool {
  return {
    id: "pool-id",
    type: "Standard",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    mintA: "MintA",
    mintB: "MintB",
    symbolA: "TKNA",
    symbolB: "USDC",
    decimalsA: 9,
    decimalsB: 6,
    reserveA: 1000,
    reserveB: 100_000,
    feeRate: 0.0025,
    spotPrice: 100, // reserveB / reserveA
    tvl: 200_000,
    volume24h: 10_000,
    ...overrides,
  };
}

describe("getCpmmAmountOut (constant-product swap)", () => {
  it("returns 0 for invalid inputs", () => {
    expect(getCpmmAmountOut(0, 100, 100, 0.003)).toBe(0);
    expect(getCpmmAmountOut(-1, 100, 100, 0.003)).toBe(0);
    expect(getCpmmAmountOut(10, 0, 100, 0.003)).toBe(0);
    expect(getCpmmAmountOut(10, 100, 0, 0.003)).toBe(0);
    expect(getCpmmAmountOut(10, 100, 100, -0.1)).toBe(0);
    expect(getCpmmAmountOut(10, 100, 100, 1)).toBe(0);
    expect(getCpmmAmountOut(10, 100, 100, 1.5)).toBe(0);
  });

  it("matches the closed-form CPMM formula", () => {
    // amountIn=10, reserveIn=1000, reserveOut=10000, fee=0
    //   amountOut = (10 * 10000) / (1000 + 10) = 100000 / 1010 ≈ 99.0099
    expect(getCpmmAmountOut(10, 1000, 10_000, 0)).toBeCloseTo(99.0099, 3);

    // With 0.3 % fee: amountInAfterFee = 9.97
    //   amountOut = (9.97 * 10000) / (1000 + 9.97) = 99700 / 1009.97 ≈ 98.7158
    expect(getCpmmAmountOut(10, 1000, 10_000, 0.003)).toBeCloseTo(98.7158, 3);
  });

  it("output is bounded above by reserveOut (cannot drain pool)", () => {
    // Even with an enormous input, output approaches but never reaches reserveOut
    const out = getCpmmAmountOut(1e18, 1000, 10_000, 0);
    expect(out).toBeLessThan(10_000);
  });

  it("output strictly increases with input (monotonic)", () => {
    const a = getCpmmAmountOut(1, 1000, 10_000, 0.003);
    const b = getCpmmAmountOut(10, 1000, 10_000, 0.003);
    const c = getCpmmAmountOut(100, 1000, 10_000, 0.003);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("output decreases as fee increases", () => {
    const noFee = getCpmmAmountOut(10, 1000, 10_000, 0);
    const lowFee = getCpmmAmountOut(10, 1000, 10_000, 0.003);
    const highFee = getCpmmAmountOut(10, 1000, 10_000, 0.01);
    expect(noFee).toBeGreaterThan(lowFee);
    expect(lowFee).toBeGreaterThan(highFee);
  });
});

describe("detectArbitrage", () => {
  it("returns no opportunities for fewer than 2 pools", () => {
    expect(detectArbitrage([])).toEqual([]);
    expect(detectArbitrage([makePool({})])).toEqual([]);
  });

  it("identifies a buy-low / sell-high pair when prices differ", () => {
    // Pool 1 cheaper, pool 2 expensive — but BOTH deep enough that
    // a $1000 trade goes through with tiny slippage.
    const cheap = makePool({
      id: "cheap",
      reserveA: 100_000,
      reserveB: 9_950_000, // spot ≈ 99.5
      spotPrice: 99.5,
      feeRate: 0.0025,
      tvl: 10_000_000,
    });
    const expensive = makePool({
      id: "expensive",
      reserveA: 100_000,
      reserveB: 10_050_000, // spot ≈ 100.5
      spotPrice: 100.5,
      feeRate: 0.0025,
      tvl: 10_000_000,
    });

    const opps = detectArbitrage([cheap, expensive]);
    expect(opps).toHaveLength(1);
    expect(opps[0].buyPool.id).toBe("cheap");
    expect(opps[0].sellPool.id).toBe("expensive");
    // Spread is ~1 %, fees combined are 0.50 % → net should be positive
    expect(opps[0].netProfitUsd).toBeGreaterThan(0);
  });

  it("dust pools must NOT show absurd profit (slippage is enforced)", () => {
    // Big reference pool with deep liquidity at price 100
    const deepPool = makePool({
      id: "deep",
      reserveA: 1_000_000,
      reserveB: 100_000_000,
      spotPrice: 100,
      feeRate: 0.0025,
      tvl: 200_000_000,
    });

    // Tiny dust pool at a "cheap" spot price of 50 with TVL of just $40
    // (reserveA=0.4, reserveB=20). Naive `tradeSize / spotPrice` math
    // would say "buy 20 base for $1000 then sell for $2000 = +$1000" —
    // but this dust pool only has 0.4 base in it. Real CPMM math
    // strictly bounds the output by the pool reserve.
    const dustPool = makePool({
      id: "dust",
      reserveA: 0.4,
      reserveB: 20,
      spotPrice: 50,
      feeRate: 0.0025,
      tvl: 40,
    });

    const opps = detectArbitrage([deepPool, dustPool]);
    expect(opps.length).toBeGreaterThan(0);
    const opp = opps[0];

    // In the dust pool we can buy at most ~0.4 base (the entire pool).
    // At a deep-pool sell price of ~$100, that's ≤ $40 of revenue
    // for a $1000 input — i.e. a massive loss, NOT a gain.
    expect(opp.baseAmountOut).toBeLessThan(0.4);
    expect(opp.netProfitUsd).toBeLessThan(0);
    // Sanity: no four-figure "profits" (the bug we're fixing)
    expect(opp.netProfitUsd).toBeGreaterThan(-2000);
    expect(opp.netProfitUsd).toBeLessThan(0);
  });

  it("ranks opportunities by net profit descending", () => {
    const a = makePool({ id: "a", reserveA: 100_000, reserveB: 9_950_000, spotPrice: 99.5, feeRate: 0.0025, tvl: 10_000_000 });
    const b = makePool({ id: "b", reserveA: 100_000, reserveB: 10_050_000, spotPrice: 100.5, feeRate: 0.0025, tvl: 10_000_000 });
    const c = makePool({ id: "c", reserveA: 100_000, reserveB: 10_500_000, spotPrice: 105.0, feeRate: 0.0025, tvl: 10_000_000 });

    const opps = detectArbitrage([a, b, c]);
    // 3 pools → 3 pairs (a-b, a-c, b-c)
    expect(opps).toHaveLength(3);
    for (let i = 1; i < opps.length; i++) {
      expect(opps[i - 1].netProfitUsd).toBeGreaterThanOrEqual(opps[i].netProfitUsd);
    }
    // Best should be a→c (largest spread)
    expect(opps[0].buyPool.id).toBe("a");
    expect(opps[0].sellPool.id).toBe("c");
  });

  it("respects the spot-spread direction even when fees would make trade unprofitable", () => {
    // Two identical pools — no spread, no opportunity returned
    const p1 = makePool({ id: "p1", spotPrice: 100, reserveA: 100_000, reserveB: 10_000_000 });
    const p2 = makePool({ id: "p2", spotPrice: 100, reserveA: 100_000, reserveB: 10_000_000 });
    expect(detectArbitrage([p1, p2])).toEqual([]);
  });

  it("preserves the dashboard invariant Gross − totalFeesUsd = Net", () => {
    // Pool fees are embedded in grossProfitUsd via the CPMM swap math, so
    // totalFeesUsd must equal txCostUsd (not txCost + buyFee + sellFee),
    // otherwise the dashboard's Gross/Fees/Net columns won't add up.
    const cheap = makePool({
      id: "cheap",
      reserveA: 100_000,
      reserveB: 9_950_000,
      spotPrice: 99.5,
      feeRate: 0.0025,
      tvl: 10_000_000,
    });
    const expensive = makePool({
      id: "expensive",
      reserveA: 100_000,
      reserveB: 10_050_000,
      spotPrice: 100.5,
      feeRate: 0.0025,
      tvl: 10_000_000,
    });

    const [opp] = detectArbitrage([cheap, expensive]);
    expect(opp).toBeDefined();
    expect(opp.totalFeesUsd).toBeCloseTo(opp.txCostUsd, 8);
    expect(opp.grossProfitUsd - opp.totalFeesUsd).toBeCloseTo(opp.netProfitUsd, 8);
  });
});
