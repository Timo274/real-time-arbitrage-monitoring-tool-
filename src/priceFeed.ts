/**
 * @file priceFeed.ts
 * @description Live SOL/USD price feed.
 *
 * The arbitrage profit calculation needs to convert Solana network fees
 * (denominated in SOL) into USD so they can be subtracted from the
 * USD-denominated swap profit. Using a static `SOL_PRICE_USD` from
 * `.env` works but goes stale quickly; this module fetches a fresh
 * price from Raydium's HTTP API and caches it in-process.
 *
 * Caching policy:
 *  - First call to `getSolPriceUsd()` triggers a fetch (or returns the
 *    static config fallback if the fetch fails).
 *  - Subsequent calls within `MIN_REFRESH_MS` reuse the cached value.
 *  - On any fetch failure we keep the last known price (or fall back
 *    to the static config value) and log a warning.
 */

import axios from "axios";
import { logger } from "./logger";
import { config } from "./config";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PRICE_ENDPOINT = "https://api-v3.raydium.io/mint/price";
const MIN_REFRESH_MS = 30_000;

interface RaydiumPriceResponse {
  id: string;
  success: boolean;
  data: Record<string, string>;
}

let cachedPrice: number | null = null;
let lastFetchAt = 0;
let inFlight: Promise<number> | null = null;

/**
 * Fetch the current SOL/USD price from Raydium's price endpoint.
 * Returns a number, or rejects on parse / network errors.
 */
async function fetchSolPriceFromRaydium(): Promise<number> {
  const { data } = await axios.get<RaydiumPriceResponse>(PRICE_ENDPOINT, {
    params: { mints: SOL_MINT },
    timeout: 8_000,
    headers: {
      Accept: "application/json",
      "User-Agent": "raydium-arb-monitor/1.0.0",
    },
  });

  if (!data.success || !data.data) {
    throw new Error("Raydium /mint/price returned unsuccessful response");
  }

  const raw = data.data[SOL_MINT];
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Raydium /mint/price returned invalid SOL price: ${raw}`);
  }

  return price;
}

/**
 * Get the current SOL/USD price, refreshing from Raydium if the cached
 * value is stale (or absent). Returns the static `config.solPriceUsd`
 * as a last-resort fallback so callers never crash on a network blip.
 *
 * Concurrent callers share a single in-flight request.
 */
export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedPrice !== null && now - lastFetchAt < MIN_REFRESH_MS) {
    return cachedPrice;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const price = await fetchSolPriceFromRaydium();
      cachedPrice = price;
      lastFetchAt = Date.now();
      logger.debug({ price }, "Refreshed SOL/USD from Raydium price feed");
      return price;
    } catch (err) {
      const fallback = cachedPrice ?? config.solPriceUsd;
      logger.warn(
        { error: (err as Error).message, fallback },
        "Failed to refresh SOL/USD price; using last known / config fallback"
      );
      return fallback;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Synchronous accessor — returns the latest cached SOL price, or the
 * static config fallback if no fetch has succeeded yet. Used inside
 * pure / synchronous code paths (e.g. `detectArbitrage`).
 */
export function getSolPriceUsdSync(): number {
  return cachedPrice ?? config.solPriceUsd;
}

/**
 * Test / introspection helper — returns whether we have a live price
 * (`true`) or are still on the static config fallback (`false`).
 */
export function hasLiveSolPrice(): boolean {
  return cachedPrice !== null;
}
