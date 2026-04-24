/**
 * @file raydium.ts
 * @description Raydium V3 API integration for CPMM pool discovery and spot price calculation.
 *
 * Responsibilities:
 * 1. Fetch all CPMM pools for a given mint pair from the Raydium V3 API.
 * 2. Parse the API response into strongly-typed pool objects.
 * 3. Calculate accurate spot prices using the Constant Product (x·y=k) formula,
 *    properly adjusting for token decimal differences.
 *
 * ─── PRICE MATH ───
 * For a CPMM pool with base reserve B and quote reserve Q:
 *
 *   spotPrice = (Q / 10^quoteDecimals) / (B / 10^baseDecimals)
 *
 * This gives the price of 1 unit of the base token denominated in the quote token.
 *
 * ─── API ENDPOINT ───
 * GET https://api-v3.raydium.io/pools/info/mint
 *   ?mint1={mint1}&mint2={mint2}&poolType=all&poolSortField=default&sortType=desc&pageSize=100&page=1
 *
 * NOTE: The Raydium V3 API does NOT support `poolType=cpmm` (returns HTTP 500).
 * Valid poolType values: all, concentrated, standard, allFarm, concentratedFarm, standardFarm.
 * CPMM pools are returned as type="Standard" with programId="CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C".
 * We fetch all pools and filter client-side by program ID.
 */

import axios, { AxiosError } from "axios";
import { logger } from "./logger";

// ── Constants ────────────────────────────────────────────────────────

const RAYDIUM_V3_BASE = "https://api-v3.raydium.io";
const POOL_INFO_ENDPOINT = `${RAYDIUM_V3_BASE}/pools/info/mint`;

/**
 * The on-chain program ID for Raydium CPMM pools.
 * Used to filter CPMM pools from the API response (which mixes AMM v4, CPMM, and CLMM).
 */
const CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

/**
 * The on-chain program ID for Raydium AMM v4 (legacy Standard pools).
 * We include these as a fallback if no CPMM pools exist for the pair.
 */
const AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

/**
 * Maximum number of retry attempts for transient API failures.
 */
const MAX_RETRIES = 3;

/**
 * Base delay (ms) for exponential back-off between retries.
 */
const RETRY_BASE_DELAY_MS = 1000;

// ── Types ────────────────────────────────────────────────────────────

/**
 * Represents a single Raydium CPMM pool with the data we need
 * for price calculation and arbitrage detection.
 */
export interface CpmmPool {
  /** On-chain pool address */
  id: string;

  /** Human-readable pool type (e.g. "Standard", "Concentrated") */
  type: string;

  /** Program ID that owns this pool */
  programId: string;

  /** Base token mint address */
  mintA: string;

  /** Quote token mint address */
  mintB: string;

  /** Base token symbol (e.g. "SOL") */
  symbolA: string;

  /** Quote token symbol (e.g. "USDC") */
  symbolB: string;

  /** Base token decimals */
  decimalsA: number;

  /** Quote token decimals */
  decimalsB: number;

  /**
   * Raw base reserve as a string (to avoid JS floating point issues
   * with very large on-chain amounts). We parse to number for math.
   */
  reserveA: number;

  /** Raw quote reserve (same treatment as reserveA). */
  reserveB: number;

  /**
   * Pool fee rate as a decimal (e.g. 0.0025 = 0.25%).
   * Applied on each swap within this pool.
   */
  feeRate: number;

  /**
   * Calculated spot price: price of 1 unit of mintA in terms of mintB.
   * Computed from reserves and decimals.
   */
  spotPrice: number;

  /** Total Value Locked in USD (from API) */
  tvl: number;

  /** 24h trading volume in USD (from API) */
  volume24h: number;
}

// ── Raw API Response Types ───────────────────────────────────────────

/**
 * Shape of a single pool object in the Raydium V3 API response.
 * We only type the fields we actually use.
 */
interface RaydiumApiPool {
  id: string;
  type: string;
  programId: string;
  mintA: {
    address: string;
    symbol: string;
    decimals: number;
  };
  mintB: {
    address: string;
    symbol: string;
    decimals: number;
  };
  /** Vault amounts — already in HUMAN-READABLE form (not raw lamports!) */
  mintAmountA: number;
  mintAmountB: number;
  /** Pre-calculated price from the API (price of 1 tokenA in tokenB) */
  price: number;
  feeRate: number;
  tvl: number;
  day: {
    volume: number;
  };
  // There may be more fields; we ignore what we don't need.
  [key: string]: unknown;
}

interface RaydiumApiResponse {
  id: string;
  success: boolean;
  data: {
    count: number;
    data: RaydiumApiPool[];
    hasNextPage: boolean;
  };
}

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Calculate the CPMM spot price of token A in terms of token B.
 *
 * IMPORTANT: The Raydium V3 API returns `mintAmountA` and `mintAmountB`
 * already in HUMAN-READABLE form (e.g., 55075.44 SOL, not 55075441979949 lamports).
 * Therefore we do NOT divide by 10^decimals — just reserveB / reserveA.
 *
 * Formula (with pre-normalized reserves):
 *   spotPrice = reserveB / reserveA
 *
 * This tells us: "How many units of token B does 1 unit of token A cost?"
 *
 * @param reserveA  - Human-readable reserve of token A (already divided by 10^decimals)
 * @param reserveB  - Human-readable reserve of token B (already divided by 10^decimals)
 * @returns Spot price of 1 token A in token B units
 */
export function calculateSpotPrice(
  reserveA: number,
  reserveB: number
): number {
  // Guard: avoid division by zero if a pool has empty reserves
  if (reserveA === 0) {
    logger.warn("Reserve A is zero — cannot calculate spot price");
    return 0;
  }

  return reserveB / reserveA;
}

/**
 * Fetch all CPMM pools for a given token pair from the Raydium V3 API.
 *
 * Implements:
 * - Exponential back-off retry on transient failures (429, 5xx)
 * - Structured logging of discovery results
 * - Spot price calculation for each discovered pool
 *
 * @param mint1 - First token mint address
 * @param mint2 - Second token mint address
 * @returns Array of parsed CpmmPool objects, sorted by TVL descending
 */
export async function discoverPools(
  mint1: string,
  mint2: string
): Promise<CpmmPool[]> {
  const url = POOL_INFO_ENDPOINT;
  // Use poolType="all" because the API does NOT support "cpmm" (returns 500).
  // We filter by CPMM program ID client-side after fetching.
  const params = {
    mint1,
    mint2,
    poolType: "all",
    poolSortField: "default",
    sortType: "desc",
    pageSize: 100,
    page: 1,
  };

  logger.info(
    { mint1: truncateMint(mint1), mint2: truncateMint(mint2) },
    "Discovering CPMM pools via Raydium V3 API..."
  );

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<RaydiumApiResponse>(url, {
        params,
        timeout: 15_000, // 15-second timeout
        headers: {
          Accept: "application/json",
          "User-Agent": "raydium-arb-monitor/1.0.0",
        },
      });

      // Validate response structure
      if (!response.data?.success || !response.data?.data?.data) {
        logger.warn(
          { responseId: response.data?.id },
          "Raydium API returned unsuccessful or malformed response"
        );
        return [];
      }

      const rawPools = response.data.data.data;
      const totalCount = response.data.data.count;

      logger.info(
        { totalCount, returned: rawPools.length },
        `API returned ${rawPools.length} pool(s) of all types`
      );

      // Parse all pools first
      const allParsed: CpmmPool[] = rawPools
        .map((raw) => parsePool(raw))
        .filter((pool): pool is CpmmPool => pool !== null);

      // Filter to CPMM pools only (identified by program ID)
      let pools = allParsed.filter(
        (pool) => pool.programId === CPMM_PROGRAM_ID
      );

      if (pools.length > 0) {
        logger.info(
          { cpmmCount: pools.length, totalParsed: allParsed.length },
          `Found ${pools.length} CPMM pool(s) (filtered by program ID)`
        );
      } else {
        // Fallback: if no CPMM pools, include ALL standard-type pools
        // (AMM v4 + CPMM) for cross-pool-type arbitrage detection
        pools = allParsed.filter(
          (pool) =>
            pool.programId === CPMM_PROGRAM_ID ||
            pool.programId === AMM_V4_PROGRAM_ID
        );
        if (pools.length > 0) {
          logger.info(
            { count: pools.length },
            `No CPMM-only pools found; including ${pools.length} Standard pool(s) (AMM v4 + CPMM)`
          );
        } else {
          // Last resort: include everything (CLMM, AMM, CPMM)
          pools = allParsed;
          logger.info(
            { count: pools.length },
            `No Standard pools found; including all ${pools.length} pool(s) for comparison`
          );
        }
      }

      // Sort by TVL descending — higher TVL pools are more reliable
      pools.sort((a, b) => b.tvl - a.tvl);

      // Log each discovered pool
      for (const pool of pools) {
        logger.debug(
          {
            poolId: truncateMint(pool.id),
            pair: `${pool.symbolA}/${pool.symbolB}`,
            programId: truncateMint(pool.programId),
            type: pool.type,
            spotPrice: pool.spotPrice.toFixed(8),
            tvl: `$${pool.tvl.toFixed(2)}`,
            feeRate: `${(pool.feeRate * 100).toFixed(4)}%`,
          },
          `Pool: ${pool.symbolA}/${pool.symbolB} [${pool.type}]`
        );
      }

      return pools;
    } catch (error) {
      lastError = error as Error;

      if (error instanceof AxiosError) {
        const status = error.response?.status;

        // Retry on rate-limit or server errors
        if (status === 429 || (status && status >= 500)) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logger.warn(
            { attempt, maxRetries: MAX_RETRIES, status, delayMs: delay },
            `Raydium API returned ${status}, retrying in ${delay}ms...`
          );
          await sleep(delay);
          continue;
        }

        // Non-retryable HTTP error
        logger.error(
          { status, message: error.message },
          "Raydium API request failed (non-retryable)"
        );
        return [];
      }

      // Non-Axios error (network issues, etc.)
      logger.error(
        { error: (error as Error).message },
        "Unexpected error during pool discovery"
      );
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
    }
  }

  logger.error(
    { error: lastError?.message },
    `Pool discovery failed after ${MAX_RETRIES} attempts`
  );
  return [];
}

// ── Internal Helpers ─────────────────────────────────────────────────

/**
 * Parse a raw API pool object into our strongly-typed CpmmPool.
 * Returns null if critical fields are missing.
 */
function parsePool(raw: RaydiumApiPool): CpmmPool | null {
  try {
    // Validate essential fields exist
    if (!raw.id || !raw.mintA?.address || !raw.mintB?.address) {
      logger.warn({ rawId: raw.id }, "Skipping pool with missing mint data");
      return null;
    }

    // NOTE: mintAmountA/B from the Raydium V3 API are already in
    // HUMAN-READABLE form (e.g., 55075.44 SOL, not 55075441979949 lamports).
    const reserveA = Number(raw.mintAmountA);
    const reserveB = Number(raw.mintAmountB);
    const decimalsA = raw.mintA.decimals;
    const decimalsB = raw.mintB.decimals;

    // Skip pools with zero reserves (likely inactive/drained)
    if (reserveA <= 0 || reserveB <= 0) {
      logger.debug(
        { poolId: truncateMint(raw.id) },
        "Skipping pool with zero reserves"
      );
      return null;
    }

    // Use the API's pre-calculated price if available; otherwise compute from reserves.
    // The API `price` field is the most accurate as it accounts for CLMM tick math.
    const apiPrice = Number(raw.price);
    const reservePrice = calculateSpotPrice(reserveA, reserveB);
    const spotPrice = apiPrice > 0 ? apiPrice : reservePrice;

    if (apiPrice > 0 && reservePrice > 0) {
      const priceDiffPct = Math.abs((apiPrice - reservePrice) / apiPrice) * 100;
      if (priceDiffPct > 5) {
        logger.debug(
          {
            poolId: truncateMint(raw.id),
            apiPrice: apiPrice.toFixed(6),
            reservePrice: reservePrice.toFixed(6),
            diffPct: priceDiffPct.toFixed(2),
          },
          "API price and reserve-derived price differ significantly (CLMM pool?)"
        );
      }
    }

    return {
      id: raw.id,
      type: raw.type ?? "unknown",
      programId: raw.programId ?? "",
      mintA: raw.mintA.address,
      mintB: raw.mintB.address,
      symbolA: raw.mintA.symbol ?? "???",
      symbolB: raw.mintB.symbol ?? "???",
      decimalsA,
      decimalsB,
      reserveA,
      reserveB,
      feeRate: raw.feeRate ?? 0,
      spotPrice,
      tvl: raw.tvl ?? 0,
      volume24h: raw.day?.volume ?? 0,
    };
  } catch (err) {
    logger.warn(
      { poolId: raw.id, error: (err as Error).message },
      "Failed to parse pool data"
    );
    return null;
  }
}

/**
 * Truncate a Solana address for readable log output.
 * "So11111111111111111111111111111111111111112" → "So1111...11112"
 */
function truncateMint(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 6)}...${mint.slice(-5)}`;
}

/**
 * Promise-based sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
