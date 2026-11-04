import {describe,expect,it,vi} from 'vitest';
import {gatewayHeaders} from './gateway-auth.ts';
import {DEFAULT_BODY_LIMIT,INGEST_BODY_LIMIT,proxyVercelGateway,routeFromGatewayUrl} from './vercel-gateway.ts';

const secret='a secure gateway secret with at least thirty-two bytes';
const environment={origin:'https://tokentracky-api-123.europe-west2.run.app',secret};

describe('Vercel authenticated gateway',()=>{
  it('maps both the rewritten destination and original Vercel source URL to the same signed route',()=>{
    for (const value of [
      'https://site.example/api/gateway/api/health?detail=1',
      'https://site.example/api/health?detail=1',
      'https://site.example/badge/alice.svg?theme=dark',
      'https://site.example/card/alice.svg?theme=light',
      'https://site.example/api/gateway/card/alice.svg?theme=light',
    ]) {
      const expected=value.includes('badge')?'/badge/alice.svg?theme=dark':value.includes('card')?'/card/alice.svg?theme=light':'/api/health?detail=1';
      expect(routeFromGatewayUrl(new URL(value))).toBe(expected);
    }
  });
  it('rejects gateway recursion and paths outside the API and badge surfaces',()=>{
    for (const path of ['/api/gateway','/api/gateway/api/gateway/api/health','/api/gateway/foo','/assets/app.js','/apiary/health']) {
      expect(routeFromGatewayUrl(new URL(path,'https://site.example'))).toBeNull();
    }
  });
  it('preserves the API route, query, body and Authorization while signing Vercel identity and stripping forged headers',async()=>{
    const forwarded=vi.fn(async(input:RequestInfo | URL, init?:RequestInit)=>{
      expect(String(input)).toBe('https://tokentracky-api-123.europe-west2.run.app/api/ingest?batch=1');
      const headers=new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer retained-token');
      expect(headers.get('x-forwarded-for')).toBeNull();
      expect(headers.get('x-tokentracky-gateway-signature')).toBe(gatewayHeaders(secret,'POST','/api/ingest?batch=1','198.51.100.7')['x-tokentracky-gateway-signature']);
      expect(await new Response(init?.body).text()).toBe('{"buckets":[]}');
      return new Response('accepted',{status:201,headers:{'cache-control':'no-store','retry-after':'2'}});
    });
    const response=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/ingest?batch=1',{method:'POST',headers:{authorization:'Bearer retained-token','content-type':'application/json','x-vercel-forwarded-for':'198.51.100.7','x-forwarded-for':'203.0.113.99','x-tokentracky-gateway-signature':'forged'},body:'{"buckets":[]}'}),environment,forwarded);
    expect(response.status).toBe(201);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.text()).toBe('accepted');
  });
  it('signs and forwards the original source URL when Vercel exposes that path to the function',async()=>{
    const forwarded=vi.fn(async(input:RequestInfo | URL,init?:RequestInit)=>{
      expect(String(input)).toBe(`${environment.origin}/api/identity?period=week`);
      const headers=new Headers(init?.headers);
      expect(headers.get('x-tokentracky-gateway-signature')).toBe(gatewayHeaders(secret,'GET','/api/identity?period=week','198.51.100.7')['x-tokentracky-gateway-signature']);
      return new Response('ok');
    });
    const response=await proxyVercelGateway(new Request('https://site.example/api/identity?period=week',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}}),environment,forwarded);
    expect(response.status).toBe(200);
    expect(forwarded).toHaveBeenCalledOnce();
  });
  it('never uses caller supplied forwarding or gateway headers as an identity',async()=>{
    const forwarded=vi.fn();
    const response=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/leaderboard',{headers:{'x-forwarded-for':'198.51.100.7','x-tokentracky-gateway-ip':'198.51.100.7'}}),environment,forwarded);
    expect(response.status).toBe(400);
    expect(forwarded).not.toHaveBeenCalled();
  });
  it('fails closed when its secret/origin is absent and rejects non-API routes',async()=>{
    const request=new Request('https://site.example/api/gateway/api/leaderboard',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}});
    expect((await proxyVercelGateway(request,{origin:environment.origin})).status).toBe(503);
    expect((await proxyVercelGateway(new Request('https://site.example/api/gateway/https://bad.example',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}}),environment)).status).toBe(400);
  });
  it('bounds normal bodies at 256KB but deliberately preserves the 2MB ingest contract',async()=>{
    const consume=async(_input:RequestInfo | URL, init?:RequestInit)=>new Response(await new Response(init?.body).text());
    const normal=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/leaderboard',{method:'POST',headers:{'x-vercel-forwarded-for':'198.51.100.7'},body:'x'.repeat(DEFAULT_BODY_LIMIT+1)}),environment,consume);
    expect(normal.status).toBe(413);
    const ingest=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/ingest',{method:'POST',headers:{'x-vercel-forwarded-for':'198.51.100.7'},body:'x'.repeat(INGEST_BODY_LIMIT)}),environment,consume);
    expect(ingest.status).toBe(200);
  });
});

it('strips stale compressed response metadata after fetch decoding', async()=>{
  const response=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/health',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}}),environment,async()=>new Response('decoded',{headers:{'content-encoding':'gzip','content-length':'99'}}));
  expect(await response.text()).toBe('decoded');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('content-length')).toBeNull();
});

it('cancels an oversized upstream stream instead of leaving it running',async()=>{
  const cancel=vi.fn();
  const response=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/health',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}}),environment,async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(INGEST_BODY_LIMIT+1));},cancel})));
  await expect(response.arrayBuffer()).rejects.toThrow('gateway body limit');
  expect(cancel).toHaveBeenCalledOnce();
});

it('cancels an upstream response rejected by its declared length',async()=>{
  const cancel=vi.fn();
  const response=await proxyVercelGateway(new Request('https://site.example/api/gateway/api/health',{headers:{'x-vercel-forwarded-for':'198.51.100.7'}}),environment,async()=>new Response(new ReadableStream({cancel}),{headers:{'content-length':String(INGEST_BODY_LIMIT+1)}}));
  expect(response.status).toBe(502);
  expect(cancel).toHaveBeenCalledOnce();
});
