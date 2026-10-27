import {isIP} from 'node:net';
// .js: this file also runs in the Vercel function, which compiles each file to .js without rewriting specifiers.
import {gatewayHeaders, validSecret} from './gateway-auth.js';

export const VERCEL_GATEWAY_PREFIX = '/api/gateway';
export const DEFAULT_BODY_LIMIT = 256_000;
export const INGEST_BODY_LIMIT = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const RESPONSE_HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length']);

export interface GatewayEnvironment {origin?: string; secret?: string}
export type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function error(status: number, message: string): Response {
  return new Response(JSON.stringify({error:{code:status === 413 ? 'PAYLOAD_TOO_LARGE' : 'GATEWAY_UNAVAILABLE',message}}), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}

export function parseGatewayOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || isIP(url.hostname)) return null;
    return url;
  } catch { return null; }
}

export function routeFromGatewayUrl(url: URL): string | null {
  // Depending on the Vercel runtime, IncomingMessage.url may expose either the
  // rewrite destination or the visitor-facing source path. Both map to the
  // same signed upstream path; never treat a nested gateway path as an API.
  let route: string;
  if (url.pathname.startsWith(VERCEL_GATEWAY_PREFIX + '/')) {
    route = url.pathname.slice(VERCEL_GATEWAY_PREFIX.length);
  } else if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/badge/') || url.pathname.startsWith('/card/')) {
    route = url.pathname;
  } else {
    return null;
  }
  if (!(route.startsWith('/api/') || route.startsWith('/badge/') || route.startsWith('/card/')) || route === VERCEL_GATEWAY_PREFIX || route.startsWith(VERCEL_GATEWAY_PREFIX + '/')) return null;
  return route + url.search;
}

function vercelClientIp(headers: Headers): string | null {
  // Vercel documents x-vercel-forwarded-for as its platform client IP, insulated from a proxy overwriting x-forwarded-for.
  const ip = headers.get('x-vercel-forwarded-for');
  return ip && ip.length <= 64 && !ip.includes(',') && isIP(ip) ? ip : null;
}

function requestHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) if (name === 'accept' || name === 'accept-language' || name === 'authorization' || name === 'content-type' || name === 'if-none-match') forwarded.set(name, value);
  return forwarded;
}

// Node fetch decodes compressed bodies; forwarding their original encoding/length corrupts downstream responses.
function responseHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers) if (!RESPONSE_HOP_BY_HOP.has(name.toLowerCase())) forwarded.set(name, value);
  return forwarded;
}

function bounded(stream: ReadableStream<Uint8Array>, limit: number, exceeded: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) return controller.close();
      total += next.value.byteLength;
      if (total > limit) {
        exceeded();
        controller.error(new Error('gateway body limit exceeded'));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {return reader.cancel(reason);},
  });
}

function bodyLimit(route: string): number { return route.split('?', 1)[0] === '/api/ingest' ? INGEST_BODY_LIMIT : DEFAULT_BODY_LIMIT; }

/** Fixed-origin Vercel function core. It forwards only documented API, badge and card paths and never logs request data. */
export async function proxyVercelGateway(request: Request, environment: GatewayEnvironment, requestFetch: GatewayFetch = fetch): Promise<Response> {
  const origin = parseGatewayOrigin(environment.origin);
  const secret = environment.secret;
  const route = routeFromGatewayUrl(new URL(request.url));
  const ip = vercelClientIp(request.headers);
  if (!origin || !secret || !validSecret(secret)) return error(503, 'Gateway is not configured.');
  if (!route || !ip || !['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(request.method)) return error(400, 'Gateway request is invalid.');
  const target = new URL(route, origin);
  if (target.origin !== origin.origin) return error(400, 'Gateway request is invalid.');
  const headers = requestHeaders(request.headers);
  Object.entries(gatewayHeaders(secret, request.method, route, ip)).forEach(([name, value]) => headers.set(name, value));
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > bodyLimit(route)) return error(413, 'Request body is too large.');
  let tooLarge = false;
  const body = request.body ? bounded(request.body, bodyLimit(route), () => {tooLarge = true;}) : undefined;
  const abort = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const upstream = await requestFetch(target, {method:request.method,headers,body:body as BodyInit | undefined,redirect:'error',signal:abort,duplex:'half'} as RequestInit);
    const length = Number(upstream.headers.get('content-length') ?? '0');
    if (!Number.isSafeInteger(length) || length < 0 || length > RESPONSE_LIMIT) {
      await upstream.body?.cancel().catch(() => {});
      return error(502, 'Gateway response is invalid.');
    }
    const responseBody = upstream.body ? bounded(upstream.body, RESPONSE_LIMIT, () => {}) : null;
    // A chunked oversized response terminates its stream rather than buffering unbounded data in the function.
    return new Response(responseBody, {status:upstream.status,headers:responseHeaders(upstream.headers)});
  } catch { return error(tooLarge ? 413 : 502, tooLarge ? 'Request body is too large.' : 'Gateway could not reach the API.'); }
}
