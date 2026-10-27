import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {type FastifyInstance} from 'fastify';
import {migrateCloud} from '@tokentracky/cloud';
import {postgresRateLimitStore} from './rate-limit-store.ts';
import {gatewayHeaders,parseGatewayAuthConfig} from './gateway-auth.ts';
import {createHttpServer} from './http-server.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('shared PostgreSQL quotas', () => {
  const schema = 'quota_' + randomUUID().replaceAll('-', '');
  let pool: Pool;
  let left: FastifyInstance;
  let right: FastifyInstance;
  const gatewaySecret = 'a secure gateway secret with at least thirty-two bytes';
  const gateway = parseGatewayAuthConfig('true', gatewaySecret);
  const request = (app: FastifyInstance, method: 'GET' | 'POST', path: string, ip: string, xff?: string) => app.inject({method,url:path,remoteAddress:'10.0.0.2',headers:{...gatewayHeaders(gatewaySecret,method,path,ip),...(xff ? {'x-forwarded-for':xff} : {})}});
  const create = async () => {
    const app = await createHttpServer({gateway,store:postgresRateLimitStore(pool, schema),rateLimit:{max:4,timeWindow:60_000}});
    app.get('/api/read', () => ({ok: true}));
    app.post('/api/device-auth', {config: {rateLimit: {max: 2, timeWindow: 60_000}}}, () => ({ok: true}));
    return app;
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/tokentracky_test' || url.username !== 'tokentracky') throw new Error('Use only the isolated loopback test database');
    pool = new Pool({connectionString: databaseUrl, max: 4});
    await migrateCloud(pool, {schema});
    left = await create(); right = await create();
  });
  afterAll(async () => {
    await left?.close(); await right?.close();
    if (pool) {await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
  });
  it('combines concurrent requests across instances while keeping clients and route quotas separate', async () => {
    const replies = await Promise.all(Array.from({length: 6}, (_, i) => request(i % 2 ? left : right,'GET','/api/read','198.51.100.1',i % 2 ? '203.0.113.9' : '192.0.2.9')));
    expect(replies.filter(reply => reply.statusCode === 200)).toHaveLength(4);
    expect(replies.filter(reply => reply.statusCode === 429)).toHaveLength(2);
    expect(replies.find(reply => reply.statusCode === 429)?.headers['retry-after']).toBeDefined();
    expect((await request(left,'GET','/api/read','198.51.100.2')).statusCode).toBe(200);
    expect((await request(left,'POST','/api/device-auth','198.51.100.1')).statusCode).toBe(200);
    expect((await request(right,'POST','/api/device-auth','198.51.100.1')).statusCode).toBe(200);
    expect((await request(left,'POST','/api/device-auth','198.51.100.1')).statusCode).toBe(429);
    const rows = (await pool.query(`SELECT key_hash, hits FROM ${schema}.cloud_rate_limits`)).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every(row => /^[a-f0-9]{64}$/.test(row.key_hash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('198.51.100');
  });
  it('retains quota over application restart and resets expired counters', async () => {
    const fresh = await create();
    try {
      expect((await request(fresh,'GET','/api/read','198.51.100.1')).statusCode).toBe(429);
      await pool.query(`UPDATE ${schema}.cloud_rate_limits SET expires_at = now() - interval '1 second'`);
      expect((await request(fresh,'GET','/api/read','198.51.100.1')).statusCode).toBe(200);
    } finally {await fresh.close();}
  });
  it('fails closed without leaking database errors when storage is unavailable', async () => {
    const failedPool = {query: async () => {throw new Error('private database credentials');}} as unknown as Pool;
    const app = await createHttpServer({store:postgresRateLimitStore(failedPool),rateLimit:{max:1,timeWindow:60_000}});
    app.get('/api/read', () => ({ok: true}));
    const reply = await app.inject('/api/read');
    expect(reply.statusCode).toBe(500);
    expect(reply.body).not.toContain('private database credentials');
    await app.close();
  });
});
