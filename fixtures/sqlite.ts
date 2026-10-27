import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

/**
 * Materialises `<name>.db.sql` fixtures (schema and inserts, as `sqlite3 .dump` writes them) as real databases.
 * A database stays open until `close()`, like the tool that owns it; a script may leave a transaction open for a later script to end.
 */
export function sqlDatabases() {
  const open = new Map<string, DatabaseSync>();
  return {
    /** Runs the script against the database file, creating it on first use. */
    async apply(script: string, database: string): Promise<void> {
      let db = open.get(database);
      if (!db) {db = new DatabaseSync(database); open.set(database, db);}
      db.exec(await readFile(script, 'utf8'));
    },
    close(): void {
      for (const db of open.values()) try {db.close();} catch {/* Already closed. */}
      open.clear();
    },
  };
}
