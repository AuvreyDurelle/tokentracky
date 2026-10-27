import {createServer, type IncomingHttpHeaders} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Json} from './runner.ts';

export interface Call {method: string; path: string; query: Record<string, string>; headers: IncomingHttpHeaders; body: Json}
export interface Answer {status?: number; json?: unknown; text?: string; headers?: Record<string, string>}
export interface Stub {
  /** The loopback origin of the stub, which a local server accepts as a hosted service. */
  url: string;
  calls: Call[];
  /** Answers `METHOD /path` with a fixed answer or a function of the call; unanswered routes get a 404 with the hosted error shape. */
  on(route: string, answer: Answer | ((call: Call) => Answer)): void;
  /** The calls to one route, oldest first. */
  to(route: string): Call[];
  close(): Promise<void>;
}

/** A stand-in for the hosted API, running in the test process: it records what the local server sends and answers as told. */
export async function stubService(): Promise<Stub> {
  const calls: Call[] = [];
  const routes = new Map<string, Answer | ((call: Call) => Answer)>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url!, 'http://stub.invalid');
    const text = Buffer.concat(chunks).toString('utf8');
    const call: Call = {method: request.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body: text ? JSON.parse(text) : undefined};
    calls.push(call);
    const route = routes.get(`${call.method} ${call.path}`);
    const answer = (typeof route === 'function' ? route(call) : route) ?? {status: 404, json: {error: {code: 'NOT_FOUND', message: 'Not found.'}}};
    response.writeHead(answer.status ?? 200, {'content-type': 'application/json', ...answer.headers});
    response.end(answer.text ?? (answer.json === undefined ? '' : JSON.stringify(answer.json)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls,
    on: (route, answer) => {routes.set(route, answer);},
    to: route => calls.filter(call => `${call.method} ${call.path}` === route),
    close: () => new Promise<void>(resolve => {server.closeAllConnections(); server.close(() => resolve());}),
  };
}
