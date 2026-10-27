/** Only a trusted server/test setting may choose the namespace. Never a request field. */
export function cloudSchema(schema = 'tokentracky_cloud'): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || schema === 'public' || schema.startsWith('pg_')) throw new Error('Cloud requires a dedicated private PostgreSQL schema');
  return `"${schema}"`;
}
