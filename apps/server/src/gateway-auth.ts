import {createHmac, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';

export const GATEWAY_IP_HEADER = 'x-tokentracky-gateway-ip';
export const GATEWAY_TIMESTAMP_HEADER = 'x-tokentracky-gateway-timestamp';
export const GATEWAY_SIGNATURE_HEADER = 'x-tokentracky-gateway-signature';
const MAX_CLOCK_SKEW_MS = 30_000;

export interface GatewayAuthConfig {required: boolean; secret?: string}

export function validSecret(secret: string): boolean {
  const length = Buffer.byteLength(secret, 'utf8');
  return length >= 32 && length <= 1024 && !/[\r\n\0]/.test(secret);
}

/** Hosted-only: an enabled gateway is fail-closed, rather than falling back to an egress address. */
export function parseGatewayAuthConfig(requiredValue?: string, secret?: string): GatewayAuthConfig {
  if (requiredValue === undefined || requiredValue === '') {
    if (secret !== undefined && secret !== '') throw new Error('TOKENTRACKY_GATEWAY_SECRET requires TOKENTRACKY_REQUIRE_GATEWAY=true');
    return {required: false};
  }
  if (requiredValue !== 'true') throw new Error('TOKENTRACKY_REQUIRE_GATEWAY must be true when set');
  if (!secret || !validSecret(secret)) throw new Error('TOKENTRACKY_GATEWAY_SECRET must be a 32-1024 byte secret without line breaks');
  return {required: true, secret};
}

function canonical(method: string, path: string, timestamp: string, ip: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${ip}`;
}

export function gatewaySignature(secret: string, method: string, path: string, timestamp: string, ip: string): string {
  return createHmac('sha256', secret).update(canonical(method, path, timestamp, ip)).digest('hex');
}

export function gatewayHeaders(secret: string, method: string, path: string, ip: string, now = Date.now()): Record<string, string> {
  if (!validClientIp(ip)) throw new Error('Gateway client IP must be an IP address');
  const timestamp = String(Math.floor(now / 1000));
  return {
    [GATEWAY_IP_HEADER]: ip,
    [GATEWAY_TIMESTAMP_HEADER]: timestamp,
    [GATEWAY_SIGNATURE_HEADER]: gatewaySignature(secret, method, path, timestamp, ip),
  };
}

export function validClientIp(ip: string): boolean {
  return ip.length <= 64 && isIP(ip) !== 0;
}

export function isGatewayRoute(url: string): boolean {
  const path = url.split('?', 1)[0]!;
  return path === '/api' || path.startsWith('/api/') || path === '/badge' || path.startsWith('/badge/') || path === '/card' || path.startsWith('/card/');
}

/** Returns the signed client address only after every signed field has been verified. */
export function verifyGatewayHeaders(config: GatewayAuthConfig, method: string, path: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): string | null {
  if (!config.required || !config.secret) return null;
  const value = (name: string) => {
    const header = headers[name];
    return typeof header === 'string' ? header : undefined;
  };
  const ip = value(GATEWAY_IP_HEADER);
  const timestamp = value(GATEWAY_TIMESTAMP_HEADER);
  const signature = value(GATEWAY_SIGNATURE_HEADER);
  if (!ip || !timestamp || !signature || !validClientIp(ip) || !/^\d{1,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return null;
  const at = Number(timestamp);
  if (!Number.isSafeInteger(at) || Math.abs(now - at * 1000) > MAX_CLOCK_SKEW_MS) return null;
  const expected = gatewaySignature(config.secret, method, path, timestamp, ip);
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ? ip : null;
}
