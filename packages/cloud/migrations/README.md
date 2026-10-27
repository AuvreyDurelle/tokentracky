# Cloud schema migrations

These files are the source of truth for the hosted PostgreSQL schema. Any API implementation (the current TypeScript service or a later port) applies them with the same protocol and must not keep schema logic of its own.

## Protocol

In one transaction:

1. `SELECT pg_advisory_xact_lock(hashtextextended('<quoted schema>:tokentracky:cloud:migrate', 0))`. `<quoted schema>` is the schema name in double quotes, for example `"tokentracky_cloud"`.
2. `CREATE SCHEMA IF NOT EXISTS <schema>`, then `SET LOCAL search_path TO <schema>, pg_catalog`.
3. Read the applied versions from `cloud_migrations`. If that table does not exist yet, none are applied.
4. Apply each `NNNN_name.sql` whose version `NNNN` is not applied, in ascending order. After each one, insert its version into `cloud_migrations`.
5. Apply `privileges.sql`. It runs every time and is idempotent.
6. Commit. Any failure rolls back everything.

Each file is plain SQL with no placeholders. Objects are created unqualified, so the `search_path` places them in the dedicated schema. The default schema is `tokentracky_cloud`; tests use throwaway schemas.

## Adding a migration

Add the next numbered file. Never edit a file that has been released, because databases that already applied it won't run it again. Keep each step's behaviour and the HTTP contract in `docs/IMPLEMENTATION_CONTRACT.md` in step.
