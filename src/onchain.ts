/**
 * @file onchain.ts
 * @description Optional on-chain reserve refresh via Solana RPC.
 *
 * The Raydium V3 HTTP API returns `mintAmountA`/`mintAmountB` from a cache
 * that may lag behind chain state by minutes. For a true "real-time"
 * arbitrage monitor we re-fetch the SPL Token vault balances every tick
 * directly from the chain.
 *
 * Pipeline:
 *  1. For each pool we know `id`. Call Raydium `/pools/key/ids` to obtain
 *     the on-chain `vault.A` / `vault.B` pubkeys.
 *  2. `getMultipleAccountsInfo` for the vaults in one round-trip.
 *  3. Decode the SPL Token account `amount` field (u64 LE at offset 64).
 *  4. Replace `reserveA`/`reserveB` (and recompute spot price) with the
 *     fresh on-chain values.
 *
 * SPL Token account layout (minimum, offsets in bytes):
 *   0  ..32  mint (pubkey)
 *   32 ..64  owner (pubkey)
 *   64 ..72  amount (u64, little-endian)
 *   ... (rest unused here)
 */

import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "./logger";
import type { CpmmPool } from "./raydium";

const KEY_INFO_ENDPOINT = "https://api-v3.raydium.io/pools/key/ids";

interface RaydiumKeyInfo {
  id: string;
  vault?: { A?: string; B?: string };
}

interface RaydiumKeyInfoResponse {
  id: string;
  success: boolean;
  data: Array<RaydiumKeyInfo | null>;
}

/**
 * In-memory cache of pool id → vaults. Pool vaults never change, so we
 * fetch them once per process run.
 */
const vaultCache = new Map<string, { vaultA: string; vaultB: string }>();

/**
 * Fetch the vault A/B pubkeys for the given pool ids and cache them.
 * Returns a map from poolId → vaults. Pools with missing key info are
 * silently skipped (the caller will keep their API-derived reserves).
 */
async function fetchVaults(
  poolIds: string[]
): Promise<Map<string, { vaultA: string; vaultB: string }>> {
  const result = new Map<string, { vaultA: string; vaultB: string }>();

  // Serve from cache first
  const missing: string[] = [];
  for (const id of poolIds) {
    const cached = vaultCache.get(id);
    if (cached) {
      result.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) return result;

  // Raydium accepts up to ~100 ids per call (comma-separated)
  const ids = missing.join(",");
  try {
    const { data } = await axios.get<RaydiumKeyInfoResponse>(KEY_INFO_ENDPOINT, {
      params: { ids },
      timeout: 15_000,
      headers: {
        Accept: "application/json",
        "User-Agent": "raydium-arb-monitor/1.0.0",
      },
    });

    if (!data.success || !Array.isArray(data.data)) {
      logger.warn("Raydium /pools/key/ids returned unsuccessful response");
      return result;
    }

    for (const entry of data.data) {
      if (!entry || !entry.vault?.A || !entry.vault?.B) continue;
      const vaults = { vaultA: entry.vault.A, vaultB: entry.vault.B };
      vaultCache.set(entry.id, vaults);
      result.set(entry.id, vaults);
    }
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "Failed to fetch pool key info (vaults). Falling back to API reserves."
    );
  }

  return result;
}

/**
 * Decode the `amount` field (u64 LE) from a raw SPL Token account.
 * Returns the amount as a JS number (safe for Solana token supplies up to
 * ~9e15; for tokens larger than that we'd need BigInt — none of the
 * common Solana SPLs hit that ceiling at vault scale).
 */
function decodeTokenAccountAmount(data: Buffer): number {
  if (data.length < 72) {
    throw new Error(
      `SPL Token account data too short: got ${data.length} bytes, need >= 72`
    );
  }
  // u64 little-endian at offset 64
  const lo = data.readUInt32LE(64);
  const hi = data.readUInt32LE(68);
  // Combine: hi * 2^32 + lo. Number.MAX_SAFE_INTEGER ≈ 2^53, so this is
  // safe for any practical pool vault. We don't need full u64 precision
  // for spot-price / arbitrage estimates.
  return hi * 0x1_0000_0000 + lo;
}

/**
 * Refresh reserves of the given pools in-place using on-chain vault data.
 *
 * @param connection - Solana JSON-RPC connection
 * @param pools      - Pools to refresh (mutated)
 * @returns The same array (for chainability)
 */
export async function refreshReservesOnchain(
  connection: Connection,
  pools: CpmmPool[]
): Promise<CpmmPool[]> {
  if (pools.length === 0) return pools;

  // 1) Resolve vault addresses
  const vaults = await fetchVaults(pools.map((p) => p.id));
  if (vaults.size === 0) {
    logger.debug("No vault data available; keeping API-derived reserves");
    return pools;
  }

  // 2) Build a flat list of vault pubkeys to query in one RPC round-trip
  const flatPubkeys: PublicKey[] = [];
  const vaultIndex: Array<{ poolId: string; side: "A" | "B" }> = [];

  for (const pool of pools) {
    const v = vaults.get(pool.id);
    if (!v) continue;
    flatPubkeys.push(new PublicKey(v.vaultA));
    vaultIndex.push({ poolId: pool.id, side: "A" });
    flatPubkeys.push(new PublicKey(v.vaultB));
    vaultIndex.push({ poolId: pool.id, side: "B" });
  }

  if (flatPubkeys.length === 0) return pools;

  // 3) Fetch all vault accounts in one call
  let infos;
  try {
    infos = await connection.getMultipleAccountsInfo(flatPubkeys, "processed");
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "RPC getMultipleAccountsInfo failed; keeping API-derived reserves"
    );
    return pools;
  }

  // 4) Apply fresh amounts
  const poolById = new Map(pools.map((p) => [p.id, p]));
  let refreshed = 0;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    const meta = vaultIndex[i];
    if (!info?.data) continue;

    const data = info.data as Buffer;
    let amount: number;
    try {
      amount = decodeTokenAccountAmount(data);
    } catch (err) {
      logger.debug(
        { poolId: meta.poolId, side: meta.side, error: (err as Error).message },
        "Failed to decode vault token amount"
      );
      continue;
    }

    const pool = poolById.get(meta.poolId);
    if (!pool) continue;

    const decimals = meta.side === "A" ? pool.decimalsA : pool.decimalsB;
    const human = amount / Math.pow(10, decimals);

    if (meta.side === "A") {
      pool.reserveA = human;
    } else {
      pool.reserveB = human;
    }
  }

  // 5) Recompute spot price for pools we touched
  for (const pool of pools) {
    if (vaults.has(pool.id) && pool.reserveA > 0) {
      pool.spotPrice = pool.reserveB / pool.reserveA;
      refreshed++;
    }
  }

  logger.info(
    { refreshed, total: pools.length },
    `Refreshed reserves for ${refreshed}/${pools.length} pool(s) from on-chain`
  );

  return pools;
}
