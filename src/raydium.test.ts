/**
 * @file raydium.test.ts
 * @description Unit tests for spot-price calculation.
 */

import { describe, it, expect } from "vitest";
import { calculateSpotPrice } from "./raydium";

describe("calculateSpotPrice", () => {
  it("returns reserveB / reserveA for valid reserves", () => {
    expect(calculateSpotPrice(100, 15_000)).toBe(150);
    expect(calculateSpotPrice(50, 100)).toBe(2);
    expect(calculateSpotPrice(1, 0.5)).toBe(0.5);
  });

  it("returns 0 when reserveA is 0", () => {
    expect(calculateSpotPrice(0, 100)).toBe(0);
  });

  it("handles tiny / large reserves without overflow", () => {
    expect(calculateSpotPrice(1e-6, 1e-3)).toBeCloseTo(1000, 6);
    expect(calculateSpotPrice(1e9, 1e12)).toBeCloseTo(1000, 6);
  });
});
