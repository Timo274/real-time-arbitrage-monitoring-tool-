/**
 * @file logger.ts
 * @description Structured logger using Pino.
 *
 * Provides a pre-configured Pino logger instance with:
 * - Human-readable timestamps via pino-pretty in development
 * - JSON output in production for log aggregation
 * - Configurable log level from .env
 *
 * Usage:
 *   import { logger } from "./logger";
 *   logger.info({ pool: "abc123" }, "Pool discovered");
 */

import pino from "pino";
import { config } from "./config";

/**
 * Determine if we're running in a production-like environment.
 * In production, emit raw JSON for structured log ingestion.
 * In development, use pino-pretty for human-readable output.
 */
const isProduction = process.env.NODE_ENV === "production";

/**
 * Pino transport configuration.
 * pino-pretty adds color, timestamps, and formatting for local dev.
 */
const transport = isProduction
  ? undefined
  : pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    });

/**
 * The application-wide logger instance.
 *
 * All modules should import this single instance to ensure
 * consistent formatting and level filtering.
 */
export const logger = pino(
  {
    level: config.logLevel,
    // Base fields attached to every log line
    base: {
      app: "raydium-arb-monitor",
    },
    // ISO timestamps for structured parsing
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);
