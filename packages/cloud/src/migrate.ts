import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { cloudSchema } from './schema.ts';

const MIGRATION = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** The SQL files sit beside the package source, or beside the server bundle (`dist/migrations`). */
export function migrationsDirectory(): string {
  const found = ['../migrations/', './migrations/'].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(join(path, 'privileges.sql')));
  if (!found) throw new Error('Cloud migrations are missing');
  return found;
}

/**
 * Applies `packages/cloud/migrations` with the protocol in its README: numbered files once each, in order,
 * then `privileges.sql`, in one locked transaction. The SQL files are the schema's source of truth.
 */
export async function migrateCloud(pool: Pool, options: {schema?: string; directory?: string} = {}): Promise<void> {
  const schema = cloudSchema(options.schema);
  const directory = options.directory ?? migrationsDirectory();
  const files = readdirSync(directory).filter(name => MIGRATION.test(name)).sort();
  const versions = new Map<number, string>();
  for (const file of files) {
    const version = Number(MIGRATION.exec(file)![1]);
    const previous = versions.get(version);
    if (previous) throw new Error(`Duplicate cloud migration version ${version}: ${previous}, ${file}`);
    versions.set(version, file);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [schema + ':tokentracky:cloud:migrate']);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    const exists = (await client.query<{table: string | null}>(`SELECT to_regclass('cloud_migrations')::text AS table`)).rows[0]!.table !== null;
    const applied = new Set(exists ? (await client.query<{version: number}>('SELECT version FROM cloud_migrations')).rows.map(row => row.version) : []);
    for (const file of files) {
      const version = Number(MIGRATION.exec(file)![1]);
      if (applied.has(version)) continue;
      await client.query(readFileSync(join(directory, file), 'utf8'));
      await client.query('INSERT INTO cloud_migrations(version) VALUES ($1)', [version]);
    }
    await client.query(readFileSync(join(directory, 'privileges.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
