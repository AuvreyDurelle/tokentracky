import type {IncomingMessage, ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {proxyVercelGateway} from '../apps/server/src/vercel-gateway.js';
import {accountCallback, standingsQuery, SHARE_META_TYPE, shareDocument, unavailableShare, withStandings, type ShareMeta} from '../apps/server/src/public-html.js';

type ReadPublic = (path: string, accept: string) => Promise<Response>;

/** Render the current Vercel deployment's assets, even when the API deploy has a different web build. */
export async function renderPage(url: URL, readPublic: ReadPublic, template: (file:string)=>Promise<string>): Promise<Response> {
  const path = url.pathname === '/api/page' ? url.searchParams.get('__page') : url.pathname;
  const headers = {'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','x-robots-tag':'noindex'};
  if (path === '/') {
    if (accountCallback(url.searchParams)) return new Response(await template('hosted/app.html'),{headers});
    const boardQuery = standingsQuery(url.searchParams);
    const query = new URLSearchParams(Object.entries(boardQuery).map(([key,value])=>[key,String(value)]));
    const [home, board] = await Promise.all([
      template('hosted/index.html'),
      readPublic('/api/leaderboard?'+query,'application/json').then(reply => reply.ok ? reply.json() : null).catch(() => null),
    ]);
    return new Response(withStandings(home,boardQuery.period,board),{headers:{'content-type':headers['content-type'],'cache-control':'no-store'}});
  }
  if (!path || !/^\/(?:u\/[a-zA-Z0-9_-]+|wrapped\/[a-zA-Z0-9_-]+\/\d{4}(?:-\d{2})?|vs\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/.test(path)) return new Response(null,{status:404,headers});
  const period = url.searchParams.get('period');
  const target = path + (period === 'week' || period === 'month' ? '?period='+period : '');
  const shell = await template('hosted/app.html');
  try {
    const response = await readPublic(target,SHARE_META_TYPE);
    if (response.ok) {
      const meta: ShareMeta = await response.json();
      return new Response(shareDocument(shell,meta.title,meta.description,meta),{headers});
    }
    const status = response.status === 404 ? 404 : response.status === 429 ? 429 : 503;
    const retry = response.headers.get('retry-after');
    return new Response(unavailableShare(shell,status),{status,headers:{...headers,...(retry ? {'retry-after':retry} : {})}});
  } catch {
    return new Response(unavailableShare(shell,503),{status:503,headers});
  }
}

export default async function page(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405,{Allow:'GET, HEAD'});
    response.end();
    return;
  }
  const url = new URL(request.url ?? '/', 'https://gateway.invalid');
  const readPublic: ReadPublic = (path, accept) => {
    // The board and share projections are anonymous reads. Send only the signed gateway's identity inputs.
    const headers = new Headers({accept});
    for (const key of ['x-vercel-forwarded-for','x-forwarded-host']) {
      const value = request.headers[key];
      if (typeof value === 'string') headers.set(key,value);
    }
    return proxyVercelGateway(new Request(new URL(path,url.origin),{headers}),{
      origin:process.env.TOKENTRACKY_GATEWAY_ORIGIN,secret:process.env.TOKENTRACKY_GATEWAY_SECRET,
    });
  };
  const result = await renderPage(url,readPublic,file=>readFile(join(process.cwd(),'apps/web/dist',file),'utf8'));
  response.writeHead(result.status,Object.fromEntries(result.headers));
  response.end(request.method === 'HEAD' ? undefined : await result.text());
}
