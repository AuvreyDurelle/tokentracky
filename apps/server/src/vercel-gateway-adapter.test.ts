import {createServer,request as httpRequest, type Server} from 'node:http';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createVercelGatewayHandler} from '../../../api/gateway.ts';
import type {GatewayFetch} from './vercel-gateway.ts';

const environment={origin:'https://tokentracky-api-123.europe-west2.run.app',secret:'a secure gateway secret with at least thirty-two bytes'};
const servers:Server[]=[];

async function listen(handler:ReturnType<typeof createVercelGatewayHandler>):Promise<{server:Server;url:string}> {
  const server=createServer((req,res)=>{void handler(req,res);});
  servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if (!address || typeof address==='string') throw new Error('test server did not bind a TCP port');
  return {server,url:`http://127.0.0.1:${address.port}`};
}

afterEach(async()=>{
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
    server.close(()=>resolve());
    server.closeAllConnections();
  })));
});

describe('Vercel Node HTTP adapter',()=>{
  it('catches a failed upstream stream after headers and closes the client response cleanly',async()=>{
    let failStream!:()=>void;
    const fetchUpstream:GatewayFetch=async()=>new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        failStream=()=>controller.error(new Error('synthetic upstream stream failure'));
      },
    }));
    const {url}=await listen(createVercelGatewayHandler(environment,fetchUpstream));
    const result=await new Promise<{status:number|undefined;body:string;complete:boolean}>(resolve=>{
      const req=httpRequest(`${url}/api/gateway/api/health`,{headers:{'x-vercel-forwarded-for':'198.51.100.7'}});
      req.on('response',res=>{
        let body='';
        res.setEncoding('utf8');
        res.on('data',chunk=>{body+=chunk;failStream();});
        res.on('close',()=>resolve({status:res.statusCode,body,complete:res.complete}));
        res.on('end',()=>resolve({status:res.statusCode,body,complete:res.complete}));
      });
      req.on('error',()=>resolve({status:undefined,body:'',complete:false}));
      req.end();
    });
    expect(result).toEqual({status:200,body:'partial',complete:false});
  });

  it('aborts the upstream fetch when the client disconnects while it is pending',async()=>{
    let started!:()=>void;
    let disconnected!:()=>void;
    const fetchStarted=new Promise<void>(resolve=>{started=resolve;});
    const fetchAborted=new Promise<void>(resolve=>{disconnected=resolve;});
    const fetchUpstream:GatewayFetch=(_input,init)=>new Promise((_resolve,reject)=>{
      const signal=init?.signal;
      if (!signal) throw new Error('gateway did not pass an abort signal');
      signal.addEventListener('abort',()=>{disconnected();reject(new DOMException('aborted','AbortError'));},{once:true});
      started();
    });
    const {url}=await listen(createVercelGatewayHandler(environment,fetchUpstream));
    const req=httpRequest(`${url}/api/gateway/api/health`,{headers:{'x-vercel-forwarded-for':'198.51.100.7'}});
    req.on('error',()=>{});
    req.end();
    await fetchStarted;
    req.destroy();
    await expect(fetchAborted).resolves.toBeUndefined();
    // If pipeline/response cleanup regresses into an unhandled stream error, this keeps Vitest's
    // event loop live long enough for the process-level error to surface.
    await vi.waitFor(()=>expect(req.destroyed).toBe(true));
  });
});
