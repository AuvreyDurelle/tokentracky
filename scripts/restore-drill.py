#!/usr/bin/env python3
"""Restore a logical application backup into an empty loopback-only drill database.

SOURCE_DATABASE_URL and RESTORE_DATABASE_URL are read from the environment and
never printed or passed as command-line arguments. Source is only read. Target
must be an empty, pre-created database named tokentracky_restore_<suffix>.
PG_BIN may name the directory holding matching pg_dump/pg_restore/psql binaries.
The temporary dump is private and removed on exit. No hosted API is started.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlparse


def connection(value, target=False):
    parsed = urlparse(value)
    name = unquote(parsed.path.removeprefix('/'))
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not name:
        raise ValueError('Invalid database connection configuration')
    query = parse_qs(parsed.query)
    if target and (parsed.hostname not in ('127.0.0.1', '::1') or not re.fullmatch(r'tokentracky_restore_[a-z0-9_]+', name) or query):
        raise ValueError('Restore destination must be a loopback drill database without query overrides')
    if not target and parsed.hostname not in ('127.0.0.1', '::1') and query.get('sslmode') != ['verify-full']:
        raise ValueError('Remote source requires sslmode=verify-full')
    if set(query) - {'sslmode', 'sslrootcert'}:
        raise ValueError('Unsupported database connection parameters')
    # Discard inherited libpq options/services, which could redirect the target.
    env = {key: val for key, val in os.environ.items() if not key.startswith('PG') and key not in ('SOURCE_DATABASE_URL', 'RESTORE_DATABASE_URL')}
    env.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432), PGDATABASE=name,
               PGUSER=unquote(parsed.username or ''), PGPASSWORD=unquote(parsed.password or ''),
               PGCONNECT_TIMEOUT='15')
    for key, val in query.items():
        env['PG' + key.upper()] = val[0]
    return env


def command(name, args, env, stdin=None):
    binary = str(Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')) / name)
    result = subprocess.run([binary, *args], env=env, input=stdin, text=True, capture_output=True, timeout=300)
    if result.returncode:
        # libpq errors can contain host/user/connection details: never echo them.
        raise RuntimeError(f'{name} failed; check database access and PostgreSQL versions privately')
    return result.stdout.strip()


def sql(query, env):
    return command('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], env, query)


def drill():
    started = time.monotonic()
    source = connection(os.environ['SOURCE_DATABASE_URL'])
    target = connection(os.environ['RESTORE_DATABASE_URL'], target=True)
    if source['PGDATABASE'] == target['PGDATABASE'] and source['PGHOST'] == target['PGHOST'] and source['PGPORT'] == target['PGPORT']:
        raise ValueError('Source and destination must differ')
    if sql("SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%';", target) != '0':
        raise ValueError('Restore destination is not empty')
    if sql("SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p','v','m','S','f');", target) != '0':
        raise ValueError('Restore destination public schema is not empty')
    with tempfile.TemporaryDirectory(prefix='tokentracky-restore-') as folder:
        os.chmod(folder, 0o700)
        archive = str(Path(folder) / 'application.dump')
        command('pg_dump', ['--format=custom', '--schema=tokentracky_cloud', '--no-owner', '--no-acl', '--file', archive], source)
        os.chmod(archive, 0o600)
        command('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', target['PGDATABASE'], archive], target)
    migration_dir = Path(__file__).resolve().parents[1] / 'packages/cloud/migrations'
    source_versions = sql('SELECT string_agg(version::text,\',\' ORDER BY version) FROM tokentracky_cloud.cloud_migrations;', target)
    applied = {int(value) for value in source_versions.split(',') if value}
    upgrade = ['BEGIN;', "SELECT pg_advisory_xact_lock(hashtextextended('\"tokentracky_cloud\":tokentracky:cloud:migrate',0));", 'SET LOCAL search_path TO tokentracky_cloud, pg_catalog;']
    for migration in sorted(migration_dir.glob('[0-9][0-9][0-9][0-9]_*.sql')):
        version = int(migration.name[:4])
        if version not in applied:
            upgrade.extend([migration.read_text(), f'INSERT INTO cloud_migrations(version) VALUES ({version});'])
    upgrade.extend([(migration_dir / 'privileges.sql').read_text(), 'COMMIT;'])
    sql('\n'.join(upgrade), target)
    tables = sql("SELECT count(*) FROM pg_class WHERE relnamespace='tokentracky_cloud'::regnamespace AND relkind='r';", target)
    if int(tables) < 6:
        raise RuntimeError('Restored application schema is incomplete')
    unprotected = sql("SELECT count(*) FROM pg_class WHERE relnamespace='tokentracky_cloud'::regnamespace AND relkind='r' AND NOT relrowsecurity;", target)
    if unprotected != '0':
        raise RuntimeError('Restored tables are missing row-level security')
    versions = sql('SELECT string_agg(version::text,\',\' ORDER BY version) FROM tokentracky_cloud.cloud_migrations;', target)
    # A backup can predate withdrawals/deletions. Quarantine every restored publication
    # and device grant until an operator reconciles the separate deletion history.
    sql('BEGIN; DELETE FROM tokentracky_cloud.cloud_publications; DELETE FROM tokentracky_cloud.cloud_device_authorizations; DELETE FROM tokentracky_cloud.cloud_devices; COMMIT;', target)
    if sql('SELECT count(*) FROM tokentracky_cloud.cloud_buckets;', target) != '0':
        raise RuntimeError('Restored public buckets were not quarantined')
    # Restore intentionally excludes ACLs/owners; apply the application's current grants
    # again before considering any use of the restored database.
    return {'passed': True, 'elapsedSeconds': round(time.monotonic() - started, 2), 'sourceMigrationVersions': source_versions, 'migrationVersions': versions,
            'tableCount': int(tables), 'rowLevelSecurity': True, 'publicationQuarantined': True,
            'sourceModified': False, 'dumpRetained': False,
            'notVerified': ['Supabase physical-backup restore', 'Auth-provider restore', 'Reconciliation of post-backup deletions', 'Production recovery time objective']}


if __name__ == '__main__':
    try:
        print(json.dumps(drill(), indent=2))
    except Exception as error:
        # No raw connection errors or URLs in reports.
        print(json.dumps({'passed': False, 'errorType': type(error).__name__,
                          'message': 'Restore drill failed. Check required settings, empty local destination and database access privately.'}))
        sys.exit(1)
