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

// ── Exported Config ──────────────────────────────────────────────────

export interface AppConfig {
  /** Solana JSON-RPC endpoint URL */
  rpcEndpoint: string;

  /** Polling interval in milliseconds */
  pollIntervalMs: number;

  /** Minimum net profit (USD) to flag an opportunity */
  minProfitThresholdUsd: number;

  /** Estimated SOL cost per transaction */
  solTxFeeEstimate: number;

  /** Current SOL/USD price for fee conversion */
  solPriceUsd: number;

  /** Notional trade size in USD for profit estimation */
  tradeSizeUsd: number;

  /** Pino log level */
  logLevel: string;
}

/**
 * The validated, immutable application configuration.
 * Freezing prevents accidental mutation at runtime.
 */
export const config: Readonly<AppConfig> = Object.freeze({
  rpcEndpoint: requireEnv("RPC_ENDPOINT", "https://api.mainnet-beta.solana.com"),
  pollIntervalMs: requirePositiveNumber("POLL_INTERVAL_MS", "5000"),
  minProfitThresholdUsd: requirePositiveNumber("MIN_PROFIT_THRESHOLD_USD", "0.50"),
  solTxFeeEstimate: requirePositiveNumber("SOL_TX_FEE_ESTIMATE", "0.00035"),
  solPriceUsd: requirePositiveNumber("SOL_PRICE_USD", "150.00"),
  tradeSizeUsd: requirePositiveNumber("TRADE_SIZE_USD", "1000.00"),
  logLevel: requireEnv("LOG_LEVEL", "info"),
});
