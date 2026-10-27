import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyRateLimitOptions, FastifyRateLimitStore, FastifyRateLimitStoreCtor} from '@fastify/rate-limit';

interface StoreOptions {timeWindow?: number; routeInfo?: {method?: string | string[]; url?: string}}

/** Atomic database counters use the database clock, so quotas survive instance changes and restarts. */
export function postgresRateLimitStore(pool: Pool, schema = 'tokentracky_cloud'): FastifyRateLimitStoreCtor {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || schema === 'public' || schema.startsWith('pg_')) throw new Error('Rate limits require a private schema');
  const table = `"${schema}".cloud_rate_limits`;
  let nextCleanup = 0;
  return class PostgresRateLimitStore implements FastifyRateLimitStore {
    private readonly windowMs: number;
    private readonly namespace: string;
    constructor(options: FastifyRateLimitOptions) {
      const config = options as StoreOptions;
      this.windowMs = config.timeWindow ?? 60_000;
      if (!Number.isSafeInteger(this.windowMs) || this.windowMs < 1 || this.windowMs > 86_400_000) throw new Error('Unsupported rate-limit window');
      this.namespace = config.routeInfo ? JSON.stringify([config.routeInfo.method, config.routeInfo.url]) : 'global';
    }
    incr(key: string, callback: (error: Error | null, result?: {current: number; ttl: number}) => void): void {
      const now = Date.now();
      if (now >= nextCleanup) {
        nextCleanup = now + 60_000;
        // Bounded, request-driven cleanup. Counters are not publication data and are never uploaded/logged.
        void pool.query(`DELETE FROM ${table} WHERE key_hash IN (SELECT key_hash FROM ${table} WHERE expires_at < now() - interval '5 minutes' LIMIT 1000)`).catch(() => {});
      }
      const hash = createHash('sha256').update(this.namespace).update('\0').update(key).digest('hex');
      void pool.query<{current: number; ttl: number}>(`
        INSERT INTO ${table} AS limits (key_hash, hits, expires_at)
        VALUES ($1, 1, clock_timestamp() + $2 * interval '1 millisecond')
        ON CONFLICT (key_hash) DO UPDATE SET
          hits = CASE WHEN limits.expires_at <= clock_timestamp() THEN 1 ELSE LEAST(limits.hits + 1, 1000000) END,
          expires_at = CASE WHEN limits.expires_at <= clock_timestamp() THEN clock_timestamp() + $2 * interval '1 millisecond' ELSE limits.expires_at END
        RETURNING hits AS current, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())) * 1000))::integer AS ttl
      `, [hash, this.windowMs]).then(result => callback(null, result.rows[0]), () => callback(new Error('Rate-limit storage unavailable')));
    }
    child(options: Parameters<FastifyRateLimitStore['child']>[0]): FastifyRateLimitStore {
      return new PostgresRateLimitStore(options);
    }
  };
}
