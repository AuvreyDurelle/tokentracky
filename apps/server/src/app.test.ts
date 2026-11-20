import {TEST_MODERATION_POLICY} from '../../../packages/cloud/test/moderation-policy.ts';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {PostgresCloudRepository,registerCloudRoutes,CloudError} from '@tokentracky/cloud';
import {createHostedApp,parseAuthProviders,PUBLIC_PAGES} from './app.ts';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});

describe('hosted configuration',()=>{
  it.each(['http://auth.example','https://user:pass@auth.example','https://auth.example/auth','https://auth.example/?key=value','https://auth.example/#fragment','invalid'])('rejects invalid public auth origin %s before opening the database',async supabaseUrl=>{
    await expect(createHostedApp({databaseUrl:'unused',webRoot:resolve('.runtime'),auth:{issuer:'https://auth.example',audience:'authenticated',jwksUrl:'https://auth.example/keys'},supabaseUrl,supabaseAnonKey:'sb_publishable_test'})).rejects.toThrow('HTTPS origin');
  });
  it('requires private moderation configuration before opening the database',async()=>{
    vi.stubEnv('TOKENTRACKY_MODERATION_POLICY', undefined);
    try {
      await expect(createHostedApp({databaseUrl:'unused',webRoot:resolve('.runtime'),auth:{issuer:'https://auth.example',audience:'authenticated',jwksUrl:'https://auth.example/keys'}})).rejects.toThrow('Missing TOKENTRACKY_MODERATION_POLICY');
    } finally {vi.unstubAllEnvs();}
  });
  it('parses the enabled sign-in providers for the hosted site',()=>{
    expect(parseAuthProviders(undefined)).toEqual(['email']);
    expect(parseAuthProviders(' email, GitHub ,google,email')).toEqual(['email','github','google']);
    expect(()=>parseAuthProviders('email,apple')).toThrow('TOKENTRACKY_AUTH_PROVIDERS');
  });
  it('rejects exposing a Supabase service secret before opening the database',async()=>{
    await expect(createHostedApp({databaseUrl:'unused',webRoot:resolve('.runtime'),auth:{issuer:'https://auth.example',audience:'authenticated',jwksUrl:'https://auth.example/keys'},supabaseUrl:'https://auth.example',supabaseAnonKey:'sb_secret_DO_NOT_EXPOSE'})).rejects.toThrow('secret key');
  });
});
describe('hosted proxy rate-limit identity',()=>{
  async function proxyApp(trustedProxies?:string[]) {
    const {createHttpServer}=await import('./http-server.ts');
    const app=await createHttpServer({trustedProxies});
    cleanup.push(()=>app.close());
    app.get('/identity',request=>({ip:request.ip}));
    await app.ready();
    return app;
  }
  it('ignores forwarded addresses by default',async()=>{
    const app=await proxyApp();
    const response=await app.inject({url:'/identity',remoteAddress:'10.0.0.2',headers:{'x-forwarded-for':'198.51.100.1'}});
    expect(response.json()).toEqual({ip:'10.0.0.2'});
  });
  it('keeps trusted clients independent and stops at the first untrusted hop',async()=>{
    const app=await proxyApp(['10.0.0.0/24']);
    const request=(ip:string)=>app.inject({url:'/identity',remoteAddress:'10.0.0.2',headers:{'x-forwarded-for':ip}});
    for(let i=0;i<240;i++) expect((await request('198.51.100.1')).statusCode).toBe(200);
    expect((await request('198.51.100.1')).statusCode).toBe(429);
    const other=await request('198.51.100.2');
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ip:'198.51.100.2'});
    expect((await request('203.0.113.99, 198.51.100.2')).json()).toEqual({ip:'198.51.100.2'});
  });
  it('cannot bypass a direct peer quota by spoofing forwarded addresses',async()=>{
    const app=await proxyApp(['10.0.0.2']);
    for(let i=0;i<240;i++) {
      const response=await app.inject({url:'/identity',remoteAddress:'203.0.113.5',headers:{'x-forwarded-for':`198.51.100.${i}`}});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ip:'203.0.113.5'});
    }
    expect((await app.inject({url:'/identity',remoteAddress:'203.0.113.5',headers:{'x-forwarded-for':'192.0.2.5'}})).statusCode).toBe(429);
  });
  it('limits anonymous device connection requests more tightly than reads',async()=>{
    const {createHttpServer}=await import('./http-server.ts');
    const app=await createHttpServer();cleanup.push(()=>app.close());
    const repository={startDeviceAuthorization:async()=>({userCode:'BCDF-GHJK'})} as unknown as PostgresCloudRepository;
    await registerCloudRoutes(app,{repository,verifyAccount:async()=>{throw new CloudError(401,'UNAUTHORIZED','Unauthorized');}});
    for(let i=0;i<10;i++) expect((await app.inject({method:'POST',url:'/api/device-auth',payload:{deviceName:'Mac'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/api/device-auth',payload:{deviceName:'Mac'}})).statusCode).toBe(429);
  });
  it('limits like changes to 30 a minute',async()=>{
    const {createHttpServer}=await import('./http-server.ts');
    const app=await createHttpServer();cleanup.push(()=>app.close());
    const repository={like:async()=>true} as unknown as PostgresCloudRepository;
    await registerCloudRoutes(app,{repository,verifyAccount:async()=>({issuer:'https://auth.example',subject:'member'})});
    for(const method of ['PUT','DELETE'] as const) {
      const change=()=>app.inject({method,url:'/api/profiles/someone/like',headers:{authorization:'Bearer session'}});
      for(let i=0;i<30;i++) expect((await change()).statusCode).toBe(204);
      expect((await change()).statusCode).toBe(429);
    }
    expect((await app.inject({url:'/api/profiles/someone/like',headers:{authorization:'Bearer session'}})).json()).toEqual({liked:true});
  });
  it('rejects blanket trust and non-address configuration',async()=>{
    const {parseTrustedProxies}=await import('./http-server.ts');
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('10.0.0.2, 2001:db8::/64')).toEqual(['10.0.0.2','2001:db8::/64']);
    for(const value of ['true','*','loopback','0.0.0.0/0','::/0','10.0.0.1/33','10.0.0.1,']) expect(()=>parseTrustedProxies(value)).toThrow('TOKENTRACKY_TRUSTED_PROXIES');
  });
});

describe('authenticated hosted gateway identity',()=>{
  const secret='a secure gateway secret with at least thirty-two bytes';
  async function gatewayApp() {
    const {createHttpServer}=await import('./http-server.ts');
    const {parseGatewayAuthConfig}=await import('./gateway-auth.ts');
    const app=await createHttpServer({gateway:parseGatewayAuthConfig('true',secret),rateLimit:{max:2,timeWindow:'1 minute'}});
    cleanup.push(()=>app.close());
    app.get('/api/identity',request=>({ip:request.ip}));
    await app.ready();
    return app;
  }
  async function signed(app:Awaited<ReturnType<typeof gatewayApp>>, ip:string, extra:Record<string,string>={}, timestamp=Date.now()) {
    const {gatewayHeaders}=await import('./gateway-auth.ts');
    return app.inject({url:'/api/identity?period=week',remoteAddress:'10.0.0.2',headers:{...gatewayHeaders(secret,'GET','/api/identity?period=week',ip,timestamp),...extra}});
  }
  it('uses the signed Vercel client identity across instances, not a forwarded header or shared egress',async()=>{
    const left=await gatewayApp();const right=await gatewayApp();
    expect((await signed(left,'198.51.100.1',{'x-forwarded-for':'203.0.113.99'})).statusCode).toBe(200);
    expect((await signed(left,'198.51.100.1',{'x-forwarded-for':'192.0.2.2'})).statusCode).toBe(200);
    const limited=await signed(left,'198.51.100.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await signed(left,'198.51.100.2')).statusCode).toBe(200);
    // Each app has its own in-memory store here; the PostgreSQL store test covers shared cross-instance counters.
    expect((await signed(right,'198.51.100.1')).statusCode).toBe(200);
  });
  it('keeps the pre-migration egress identity when gateway enforcement is off',async()=>{
    const {createHttpServer}=await import('./http-server.ts');
    const {gatewayHeaders}=await import('./gateway-auth.ts');
    const app=await createHttpServer({rateLimit:{max:1,timeWindow:'1 minute'}});cleanup.push(()=>app.close());
    app.get('/api/identity',request=>({ip:request.ip}));await app.ready();
    expect((await app.inject({url:'/api/identity',remoteAddress:'10.0.0.2',headers:gatewayHeaders(secret,'GET','/api/identity','198.51.100.1')})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/identity',remoteAddress:'10.0.0.2',headers:gatewayHeaders(secret,'GET','/api/identity','198.51.100.2')})).statusCode).toBe(429);
  });
  it('fails closed for direct Cloud Run requests and forged, expired, or route-mismatched signatures',async()=>{
    const app=await gatewayApp();
    expect((await app.inject({url:'/api/identity',remoteAddress:'10.0.0.2',headers:{'x-forwarded-for':'198.51.100.1'}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/identity',remoteAddress:'10.0.0.2',headers:{'x-tokentracky-gateway-ip':'198.51.100.1','x-tokentracky-gateway-timestamp':'1','x-tokentracky-gateway-signature':'0'.repeat(64)}})).statusCode).toBe(401);
    expect((await signed(app,'198.51.100.1',{},Date.now()-31_000)).statusCode).toBe(401);
    const {gatewayHeaders}=await import('./gateway-auth.ts');
    expect((await app.inject({url:'/api/identity?period=week',remoteAddress:'10.0.0.2',headers:gatewayHeaders(secret,'GET','/api/other?period=week','198.51.100.1')})).statusCode).toBe(401);
  });
  it('rejects incomplete gateway configuration and cannot combine it with trusted forwarded addresses',async()=>{
    const {parseGatewayAuthConfig}=await import('./gateway-auth.ts');
    const {createHttpServer}=await import('./http-server.ts');
    expect(parseGatewayAuthConfig()).toEqual({required:false});
    expect(()=>parseGatewayAuthConfig(undefined,secret)).toThrow('TOKENTRACKY_GATEWAY_SECRET');
    expect(()=>parseGatewayAuthConfig('true')).toThrow('TOKENTRACKY_GATEWAY_SECRET');
    expect(()=>parseGatewayAuthConfig('yes',secret)).toThrow('TOKENTRACKY_REQUIRE_GATEWAY');
    await expect(createHttpServer({trustedProxies:['10.0.0.0/24'],gateway:parseGatewayAuthConfig('true',secret)})).rejects.toThrow('TOKENTRACKY_TRUSTED_PROXIES');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('hosted GitHub username wiring',()=>{
  const supabase='https://project.supabase.example';const issuer=`${supabase}/auth/v1`;const jwksUrl=`${issuer}/.well-known/jwks.json`;
  const serviceRoleKey='sb_secret_SERVICE_ROLE_NEVER_SHOWN';const anonKey='sb_publishable_test';
  const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const segment=(value:object)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=(subject:string)=>{
    const now=Math.floor(Date.now()/1000);
    const body=`${segment({alg:'ES256',kid:'test'})}.${segment({sub:subject,iss:issuer,aud:'authenticated',role:'authenticated',iat:now,exp:now+300})}`;
    return `${body}.${sign('sha256',Buffer.from(body),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
  };
  /** A real hosted app on the test database; its outbound requests (the JWKS and the Supabase admin API) are answered here. */
  async function hosted(settings:{supabaseUrl?:string;supabaseAnonKey?:string;supabaseServiceRoleKey?:string}) {
    const url=new URL(process.env.TEST_DATABASE_URL!);
    if(url.hostname!=='127.0.0.1'||url.pathname!=='/tokentracky_test'||url.username!=='tokentracky') throw new Error('Use only the isolated loopback test database');
    const admin:Array<{url:string;headers:unknown}>=[];
    vi.stubGlobal('fetch',async(input:string|URL|Request,init?:RequestInit)=>{
      const target=String(input);
      if(target===jwksUrl) return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'test',alg:'ES256',use:'sig'}]});
      if(target.startsWith(`${supabase}/auth/v1/admin/users/`)){admin.push({url:target,headers:init?.headers});return Response.json({identities:[{provider:'github',identity_data:{user_name:'octo-cat'}}]});}
      throw new Error('Unexpected outbound request');
    });
    cleanup.push(async()=>{vi.unstubAllGlobals();});
    await mkdir('.runtime',{recursive:true});const webRoot=await mkdtemp(resolve('.runtime/hosted-test-'));
    cleanup.push(()=>rm(webRoot,{recursive:true,force:true}));
    await writeFile(join(webRoot,'index.html'),'<html><head><title>Tokentracky</title><meta name="description" content="site" /></head><body>hosted</body></html>');
    await mkdir(join(webRoot,'hosted/blog'),{recursive:true});
    await writeFile(join(webRoot,'hosted/index.html'),'<h1>hosted board</h1><!--public-standings-->');
    for (const page of PUBLIC_PAGES) await writeFile(join(webRoot,'hosted',page+'.html'),'<h1>hosted '+page+'</h1>');
    await writeFile(join(webRoot,'hosted/blog/test-guide.html'),'<article>hosted test guide</article>');
    await writeFile(join(webRoot,'sitemap.xml'),'<urlset/>');
    await writeFile(join(webRoot,'robots.txt'),'User-agent: *');
    // createHostedApp migrates the default schema; each test erases the member it created.
    const app=await createHostedApp({databaseUrl:url.toString(),webRoot,moderationPolicy:TEST_MODERATION_POLICY,auth:{issuer,audience:'authenticated',jwksUrl},...settings});
    cleanup.push(()=>app.close());
    const subject=`wiring-${randomUUID()}`;const alias=`wiring-${randomUUID().slice(0,8)}`;
    const member=(method:'GET'|'PUT'|'DELETE',path:string,payload?:object)=>app.inject({method,url:path,headers:{authorization:`Bearer ${token(subject)}`},...(payload?{payload}:{})});
    const publish=()=>member('PUT','/api/publication',{alias});
    return {app,admin,subject,alias,member,publish};
  }
  it('reads the GitHub username with the service-role key, which no response ever carries',async()=>{
    const {app,admin,subject,alias,member,publish}=await hosted({supabaseUrl:supabase,supabaseAnonKey:anonKey,supabaseServiceRoleKey:serviceRoleKey});
    try {
      const joined=await publish();
      expect(joined.statusCode).toBe(200);
      expect(admin).toEqual([{url:`${supabase}/auth/v1/admin/users/${subject}`,headers:{apikey:serviceRoleKey,authorization:`Bearer ${serviceRoleKey}`}}]);
      const stats=await app.inject(`/api/profiles/${alias}/stats`);
      expect(stats.json().githubLogin).toBe('octo-cat');
      const health=await app.inject('/api/health');
      expect(health.json()).toMatchObject({supabaseUrl:supabase,supabaseAnonKey:anonKey});
      const responses=[joined,stats,health,await app.inject('/api/leaderboard'),await app.inject('/api/community'),await member('GET','/api/account'),await app.inject('/api/missing'),await member('PUT','/api/publication',{alias:'bad alias'}),await app.inject('/')];
      for(const response of responses) expect(JSON.stringify(response.headers)+response.body).not.toContain(serviceRoleKey);
    } finally {expect((await member('DELETE','/api/account')).statusCode).toBe(204);}
  });
  it('serves hosted pages and security headers while local tracking routes are absent',async()=>{
    const {app}=await hosted({});
    for(const page of ['/','/privacy','/terms','/support','/blog','/blog/test-guide','/you','/join']) {
      const response=await app.inject(page);
      expect(response.statusCode,page).toBe(200);
      expect(response.body).toContain('hosted');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
    const redirect=await app.inject('/leaderboard?period=week&ref=share');
    expect([redirect.statusCode,redirect.headers.location]).toEqual([308,'/?period=week&ref=share']);
    for(const path of ['/?connect=synthetic','/?code=synthetic','/you']) {
      const result=await app.inject(path);
      expect(result.headers['x-robots-tag']).toBe('noindex');
      expect(result.body).not.toContain('hosted board');
    }
    expect((await app.inject('/robots.txt')).headers['content-type']).toContain('text/plain');
    expect((await app.inject('/sitemap.xml')).headers['content-type']).toContain('xml');
    for(const page of ['/privacy/extra','/blog/missing','/blog/bad.slug','/u/x','/u/a/b','/api/local/status','/api/local/summary']) {
      expect((await app.inject(page)).statusCode,page).toBe(404);
    }
    expect((await app.inject('/api/health')).json()).toMatchObject({mode:'hosted',authConfigured:false});
  });
  it('serves published share metadata and returns 404 for unavailable pages',async()=>{
    const {app,alias,member,publish}=await hosted({});
    try {
      expect((await publish()).statusCode).toBe(200);
      const page=await app.inject({url:`/u/${alias.toUpperCase()}?ref=share`,headers:{'x-tokentracky-host':'tokentracky.com'}});
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.body).toContain(`<title>${alias} on Tokentracky</title>`);
      expect(page.body).toMatch(/<meta name="description" content="#\d+ all time with 0 AI coding tokens\. See where you rank on the token leaderboard\." \/>/);
      expect(page.body).toContain(`<meta property="og:url" content="https://tokentracky.com/u/${alias}" />`);
      expect(page.body).toContain(`<meta property="og:image" content="https://tokentracky.com/og/${alias}.png" />`);
      expect(page.body).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(page.body).not.toContain('content="site"');
      const profileWeek=(await app.inject({url:`/u/${alias}?period=week&ref=share`,headers:{'x-tokentracky-host':'tokentracky.com'}})).body;
      expect(profileWeek).toMatch(/<meta name="description" content="#\d+ this week with 0 AI coding tokens\./);
      expect(profileWeek).toContain(`<meta property="og:image" content="https://tokentracky.com/og/${alias}.png?period=week" />`);
      expect(page.body).toContain('hosted');
      expect(page.headers['x-robots-tag']).toBe('noindex');
      const unknown=await app.inject('/u/nobody-at-all');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body).toContain('<title>Page unavailable</title>');
      expect(unknown.body).not.toContain('og:image');
      const meta=await app.inject({url:`/u/${alias}`,headers:{accept:'application/vnd.tokentracky.share+json','x-tokentracky-host':'tokentracky.com'}});
      expect(meta.json()).toMatchObject({title:`${alias} on Tokentracky`,url:`https://tokentracky.com/u/${alias}`});
      const month=new Date().toISOString().slice(0,7);
      const wrap=(await app.inject({url:`/wrapped/${alias}/${month}`,headers:{'x-tokentracky-host':'tokentracky.com'}})).body;
      expect(wrap).toMatch(new RegExp(`<title>${alias}&#39;s \\w+ \\d{4} on Tokentracky</title>`));
      expect(wrap).toMatch(/<meta name="description" content="0 AI coding tokens in \w+ \d{4}\. See where you rank/);
      expect(wrap).toContain(`<meta property="og:image" content="https://tokentracky.com/og/wrapped/${alias}/${month}.png" />`);
      expect((await app.inject(`/wrapped/${alias}/2999`)).statusCode).toBe(404);
      for (const path of [`/wrapped/${alias}/2026-13`,`/wrapped/${alias}`,'/wrapped/x/2026']) expect((await app.inject(path)).statusCode,path).toBe(404);
      const versus=(await app.inject({url:`/vs/${alias}/${alias}`,headers:{'x-tokentracky-host':'tokentracky.com'}})).body;
      expect(versus).toContain(`<title>${alias} vs ${alias} on Tokentracky</title>`);
      expect(versus).toMatch(/<meta name="description" content="[^"]+: 0 tokens \(#\d+\) · [^"]+: 0 tokens \(#\d+\), all time\. Dead even\." \/>/);
      expect(versus).toContain(`<meta property="og:image" content="https://tokentracky.com/og/vs/${alias}/${alias}.png" />`);
      expect((await app.inject(`/vs/${alias}/nobody-at-all`)).statusCode).toBe(404);
      const weekly=(await app.inject({url:`/vs/${alias}/${alias}?period=week&ref=share`,headers:{'x-tokentracky-host':'tokentracky.com'}})).body;
      expect(weekly).toContain(`<meta property="og:image" content="https://tokentracky.com/og/vs/${alias}/${alias}.png?period=week" />`);
      expect(weekly).toMatch(/0 tokens \(#\d+\), this week\. Dead even\./);
      expect((await app.inject(`/vs/${alias}/${alias}?period=year`)).body).toContain(`/og/vs/${alias}/${alias}.png" />`);
      expect((await app.inject(`/vs/${alias}/x`)).statusCode).toBe(404);
    } finally {expect((await member('DELETE','/api/account')).statusCode).toBe(204);}
  });
  it('renders weekly public data, drops withdrawn aliases, and tolerates a temporary read outage',async()=>{
    const {app,alias,member,publish}=await hosted({});
    try {
      expect((await publish()).statusCode).toBe(200);
      const profile=await app.inject(`/u/${alias}`);
      expect(profile.statusCode).toBe(200);
      expect(profile.headers['cache-control']).toBe('no-store');
      expect((await app.inject('/')).body).toContain('This week’s leaders');
      const offline=vi.spyOn(PostgresCloudRepository.prototype,'leaderboard').mockRejectedValueOnce(new Error('offline'));
      try {expect((await app.inject('/')).body).toContain('weekly standings are temporarily unavailable');}
      finally {offline.mockRestore();}
      const failure=vi.spyOn(PostgresCloudRepository.prototype,'profile').mockRejectedValueOnce(new Error('offline'));
      try {expect((await app.inject(`/u/${alias}`)).statusCode).toBe(503);}
      finally {failure.mockRestore();}
      expect((await member('DELETE','/api/account')).statusCode).toBe(204);
      expect((await app.inject(`/u/${alias}`)).statusCode).toBe(404);
    } finally {await member('DELETE','/api/account');}
  });
  it.each([
    ['without the service-role key',{supabaseUrl:supabase,supabaseAnonKey:anonKey}],
    ['without the Supabase URL',{supabaseServiceRoleKey:serviceRoleKey}],
  ])('stores no GitHub username %s',async(_case,settings)=>{
    const {app,admin,alias,member,publish}=await hosted(settings);
    try {
      expect((await publish()).statusCode).toBe(200);
      expect(admin).toEqual([]);
      expect((await app.inject(`/api/profiles/${alias}/stats`)).json()).not.toHaveProperty('githubLogin');
    } finally {expect((await member('DELETE','/api/account')).statusCode).toBe(204);}
  });
});
