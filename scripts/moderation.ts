// Operator moderation against the hosted database. Run: npx tsx scripts/moderation.ts <command>
// MODERATION_DATABASE_URL is read from the environment and never printed. MODERATION_SCHEMA overrides the schema for drills.
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { moderationCommand, PostgresCloudRepository } from '../packages/cloud/src/index.ts';

const url = process.env.MODERATION_DATABASE_URL;
if (!url) {
  process.stderr.write('Set MODERATION_DATABASE_URL to the operator database connection.\n');
  process.exit(2);
}
const pool = new pg.Pool({connectionString: url, max: 2});
const input = createInterface({input: process.stdin, output: process.stdout});
try {
  const repository = new PostgresCloudRepository(pool, undefined, process.env.MODERATION_SCHEMA);
  process.exitCode = await moderationCommand(repository, process.argv.slice(2), {ask: question => input.question(question), print: line => process.stdout.write(`${line}\n`)});
} finally {
  input.close();
  await pool.end();
}
