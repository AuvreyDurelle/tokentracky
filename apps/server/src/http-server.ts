import {isIP} from 'node:net';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type {FastifyRateLimitStoreCtor} from '@fastify/rate-limit';
import {isGatewayRoute, type GatewayAuthConfig, verifyGatewayHeaders} from './gateway-auth.ts';

export function parseTrustedProxies(value?: string): string[] {
  if (value === undefined || value.trim() === '') return [];
  const addresses = value.split(',').map(address => address.trim());
  for (const address of addresses) {
    const [ip, prefix, ...extra] = address.split('/');
    const family = isIP(ip!);
    if (!family || extra.length || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TOKENTRACKY_TRUSTED_PROXIES must contain explicit IP addresses or CIDRs with nonzero prefixes');
    }
  }
  return addresses;
}

export interface HttpServerOptions {
  trustedProxies?: string[];
  store?: FastifyRateLimitStoreCtor;
  gateway?: GatewayAuthConfig;
  rateLimit?: {max?: number; timeWindow?: number | string};
}

export async function createHttpServer(options: HttpServerOptions = {}) {
  const addresses = parseTrustedProxies(options.trustedProxies?.join(','));
  const gateway = options.gateway ?? {required: false};
  if (gateway.required && addresses.length) throw new Error('Authenticated gateway identity requires TOKENTRACKY_TRUSTED_PROXIES to be empty');
  const app = Fastify({logger:false,bodyLimit:256_000,requestTimeout:30_000,trustProxy:addresses.length ? addresses : false});
  const identities = new WeakMap<object, string>();
  if (gateway.required) app.addHook('onRequest', async (request, reply) => {
    const path = request.raw.url ?? request.url;
    if (!isGatewayRoute(path)) return;
    const ip = verifyGatewayHeaders(gateway, request.method, path, request.headers);
    if (!ip) return reply.code(401).send({error:{code:'GATEWAY_AUTH_REQUIRED',message:'Authenticated gateway identity is required.'}});
    identities.set(request, `gateway:${ip}`);
  });
  await app.register(rateLimit,{max:options.rateLimit?.max ?? 240,timeWindow:options.rateLimit?.timeWindow ?? '1 minute',store:options.store,keyGenerator:request=>identities.get(request) ?? request.ip});
  return app;
}
