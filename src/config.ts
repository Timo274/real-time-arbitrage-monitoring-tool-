/**
 * @file config.ts
 * @description Centralized configuration module.
 *
 * Loads environment variables from `.env` via dotenv, validates them,
 * and exports a strongly-typed, frozen config object used throughout
 * the application. Fails fast with descriptive errors if required
 * values are missing or malformed.
 */

import dotenv from "dotenv";
import path from "path";

// Load .env from the project root (one level up from src/)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Read an env var, throwing if it's missing and no default is provided.
 */
function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `[Config] Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env and set a value.`
    );
  }
  return value.trim();
}

/**
 * Parse an env var as a positive number, with optional fallback.
 */
function requirePositiveNumber(key: string, fallback?: string): number {
  const raw = requireEnv(key, fallback);
  const num = Number(raw);
  if (isNaN(num) || num <= 0) {
    throw new Error(
      `[Config] Environment variable ${key}="${raw}" must be a positive number.`
    );
  }
  return num;
}

/**
 * Parse an env var as a non-negative number (allows 0), with optional fallback.
 */
function requireNonNegativeNumber(key: string, fallback?: string): number {
  const raw = requireEnv(key, fallback);
  const num = Number(raw);
  if (isNaN(num) || num < 0) {
    throw new Error(
      `[Config] Environment variable ${key}="${raw}" must be a non-negative number.`
    );
  }
  return num;
}

/**
 * Parse an env var as a boolean. Accepts: true/false/1/0/yes/no (case-insensitive).
 */
function requireBoolean(key: string, fallback: string): boolean {
  const raw = requireEnv(key, fallback).toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  throw new Error(
    `[Config] Environment variable ${key}="${raw}" must be a boolean (true/false).`
  );
}

// ── Exported Config ──────────────────────────────────────────────────

export interface AppConfig {
  /** Solana JSON-RPC endpoint URL */
  rpcEndpoint: string;

  /**
   * Whether to fetch fresh on-chain reserves from CPMM vault accounts
   * via the configured RPC every tick. When false, reserves are taken
   * from the Raydium HTTP API (which can be stale by ~minutes).
   */
  useOnchainReserves: boolean;

  /** Polling interval in milliseconds */
  pollIntervalMs: number;

  /** Minimum net profit (USD) to flag an opportunity. 0 disables threshold. */
  minProfitThresholdUsd: number;

  /** Estimated SOL cost per transaction */
  solTxFeeEstimate: number;

  /** Current SOL/USD price for fee conversion */
  solPriceUsd: number;

  /** Notional trade size in USD for profit estimation */
  tradeSizeUsd: number;

  /**
   * Whether to also include AMM v4 (legacy "Standard") pools alongside
   * CPMM pools. Off by default to keep results focused on CPMM (per spec).
   */
  includeAmmV4: boolean;

  /**
   * Minimum pool TVL (USD) for a pool to be considered for arbitrage.
   * Pools below this are still discovered and logged but not used in
   * the arb-detection step (avoids noise from dust pools).
   */
  minPoolTvlUsd: number;

  /** Pino log level */
  logLevel: string;
}

/**
 * The validated, immutable application configuration.
 * Freezing prevents accidental mutation at runtime.
 */
export const config: Readonly<AppConfig> = Object.freeze({
  rpcEndpoint: requireEnv("RPC_ENDPOINT", "https://api.mainnet-beta.solana.com"),
  useOnchainReserves: requireBoolean("USE_ONCHAIN_RESERVES", "false"),
  pollIntervalMs: requirePositiveNumber("POLL_INTERVAL_MS", "5000"),
  minProfitThresholdUsd: requireNonNegativeNumber("MIN_PROFIT_THRESHOLD_USD", "0.50"),
  solTxFeeEstimate: requirePositiveNumber("SOL_TX_FEE_ESTIMATE", "0.00035"),
  solPriceUsd: requirePositiveNumber("SOL_PRICE_USD", "150.00"),
  tradeSizeUsd: requirePositiveNumber("TRADE_SIZE_USD", "1000.00"),
  includeAmmV4: requireBoolean("INCLUDE_AMM_V4", "true"),
  minPoolTvlUsd: requireNonNegativeNumber("MIN_POOL_TVL_USD", "1000"),
  logLevel: requireEnv("LOG_LEVEL", "info"),
});
