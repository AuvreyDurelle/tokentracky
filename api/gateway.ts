import type {IncomingMessage, ServerResponse} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
// .js: Vercel compiles each file to .js without rewriting import specifiers.
import {proxyVercelGateway, type GatewayEnvironment, type GatewayFetch} from '../apps/server/src/vercel-gateway.js';

export const config = {api:{bodyParser:false}};

function requestUrl(request: IncomingMessage): string {
  // This is only a parsing base; target selection remains the configured fixed origin.
  return new URL(request.url ?? '/', 'https://gateway.invalid').toString();
}

/** Build the Node adapter with explicit dependencies so stream lifecycle behavior can be tested locally. */
export function createVercelGatewayHandler(environment: GatewayEnvironment, requestFetch?: GatewayFetch) {
  return async function gateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(request) as ReadableStream<Uint8Array>;
    const abort = new AbortController();
    const disconnected = () => {if (!response.writableFinished) abort.abort();};
    response.once('close', disconnected);
    try {
      const proxied = await proxyVercelGateway(new Request(requestUrl(request), {method,signal:abort.signal,headers:request.headers as HeadersInit,body:body as BodyInit | undefined,duplex:'half'} as RequestInit), environment, requestFetch);
      response.statusCode = proxied.status;
      proxied.headers.forEach((value, name) => response.setHeader(name, value));
      if (!proxied.body) {response.end();return;}
      await pipeline(Readable.fromWeb(proxied.body as import('node:stream/web').ReadableStream), response);
    } catch {
      // A streaming limit/disconnect must terminate this response, never become an unhandled stream error.
      if (!response.headersSent && !response.destroyed) {
        response.statusCode = 502;
        response.setHeader('content-type', 'application/json');
        response.setHeader('cache-control', 'no-store');
        response.end(JSON.stringify({error:{code:'GATEWAY_UNAVAILABLE',message:'Gateway response failed.'}}));
      } else response.destroy();
    } finally {response.off('close', disconnected);}
  };
}

export default function gateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
  return createVercelGatewayHandler({
    origin:process.env.TOKENTRACKY_GATEWAY_ORIGIN,
    secret:process.env.TOKENTRACKY_GATEWAY_SECRET,
  })(request, response);
}
