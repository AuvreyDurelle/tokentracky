import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {expect, it, vi} from 'vitest';
import {migrateCloud} from '../src/migrate.ts';

it('rejects duplicate numeric migration versions before connecting to any database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-duplicate-migrations-'));
  const connect = vi.fn();
  try {
    writeFileSync(join(directory, '0008_token_types.sql'), 'SELECT 1');
    writeFileSync(join(directory, '0008_multi_computer.sql'), 'SELECT 2');
    await expect(migrateCloud({connect} as unknown as Pool, {directory})).rejects.toThrow('Duplicate cloud migration version 8');
    expect(connect).not.toHaveBeenCalled();
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
