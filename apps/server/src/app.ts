import {type FastifyInstance,type FastifyReply} from 'fastify';
import {ALIAS_PATTERN} from '@tokentracky/core';
import {createHttpServer} from './http-server.ts';
import staticFiles from '@fastify/static';
import {Pool} from 'pg';
import {migrateCloud, PostgresCloudRepository, registerCloudRoutes, CloudError, supabaseGithubLogin, parseModerationPolicy, type ModerationPolicy} from '@tokentracky/cloud';
import {postgresRateLimitStore} from './rate-limit-store.ts';
import type {FastifyRateLimitStoreCtor} from '@fastify/rate-limit';
import type {GatewayAuthConfig} from './gateway-auth.ts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publicSite} from '@tokentracky/cloud';
import {compareMeta, profileMeta, wrappedMeta} from './share-page.ts';
import {accountCallback, standingsQuery, SHARE_META_TYPE, shareDocument, unavailableShare, withStandings, type ShareMeta} from './public-html.ts';

export interface HostedOptions {
  databaseUrl: string;
  /** Server-only upload policy; defaults to the private deployment environment. */
  moderationPolicy?: ModerationPolicy;
  webRoot: string;
  auth: {issuer:string;audience:string;jwksUrl:string};
  trustedProxies?: string[];
  gateway?: GatewayAuthConfig;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** Server-only key for reading a member's verified GitHub login (`SUPABASE_SERVICE_ROLE_KEY`). Never sent to browsers. */
  supabaseServiceRoleKey?: string;
  /** Sign-in methods enabled in the auth project; the site offers only these. Defaults to email/password. */
  authProviders?: AuthProvider[];
}
export const AUTH_PROVIDERS = ['email','github','google'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export function parseAuthProviders(value: string | undefined): AuthProvider[] {
  if (value === undefined || value.trim() === '') return ['email'];
  const providers = [...new Set(value.split(',').map(item => item.trim().toLowerCase()))];
  if (providers.some(provider => !AUTH_PROVIDERS.includes(provider as AuthProvider))) throw new Error('TOKENTRACKY_AUTH_PROVIDERS may contain email, github and google');
  return providers as AuthProvider[];
}
export const PUBLIC_PAGES = ['privacy','terms','support','join','blog'] as const;
export const contentSecurityPolicy = (authOrigin?: string) => `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${authOrigin ? ' '+authOrigin : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
async function baseApp(webRoot: string, authOrigin: string | undefined, trustedProxies: string[] | undefined, rateLimitStore: FastifyRateLimitStoreCtor | undefined, gateway: GatewayAuthConfig | undefined, repository: PostgresCloudRepository): Promise<FastifyInstance> {
  // No request logging: headers, query strings and local paths may contain secrets.
  const app = await createHttpServer({trustedProxies,store:rateLimitStore,gateway});
  app.addHook('onRequest', async (request,reply) => {
    if (/^\/(api|badge|card|og|you|u|vs|wrapped)(?:[/?]|$)/.test(request.url)) reply.header('X-Robots-Tag','noindex');
    reply.header('Content-Security-Policy',contentSecurityPolicy(authOrigin));
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','no-referrer');
    reply.header('Cache-Control','no-store');
    reply.header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  });
  app.setErrorHandler((error,_request,reply) => {
    if (error instanceof CloudError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    reply.code(status >= 400 && status < 500 ? status : 500).send({error:{code:status === 429 ? 'RATE_LIMITED' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',message:status === 429 ? 'Too many requests. Please try again shortly.' : status < 500 ? 'The request could not be accepted.' : 'The service could not complete this request.'}});
  });
  await app.register(staticFiles,{root:webRoot,serve:false,cacheControl:false});
  // An explicit asset route avoids exposing filesystem paths or falling back APIs to HTML.
  app.get('/assets/*', (request,reply) => reply.sendFile('assets/'+(request.params as {'*':string})['*']));
  app.get('/',async(request,reply)=>{
    const url = new URL(request.url,'http://localhost');
    if (accountCallback(url.searchParams)) return reply.header('X-Robots-Tag','noindex').sendFile('index.html');
    const query = standingsQuery(url.searchParams);
    const [template, board] = await Promise.all([
      readFile(join(webRoot,'hosted/index.html'),'utf8'),
      repository.leaderboard(query).catch(() => null),
    ]);
    return reply.type('text/html; charset=utf-8').send(withStandings(template,query.period,board));
  });
  app.get('/leaderboard',(request,reply)=>reply.redirect('/'+new URL(request.url,'http://localhost').search,308));
  app.get('/you',(_request,reply)=>reply.sendFile('index.html'));
  for (const page of PUBLIC_PAGES) app.get('/'+page,(_request,reply)=>reply.sendFile(`hosted/${page}.html`));
  for (const file of ['robots.txt','sitemap.xml']) app.get('/'+file,(_request,reply)=>reply.sendFile(file));
  app.get<{Params:{slug:string}}>('/blog/:slug',(request,reply)=>{
    const {slug} = request.params;
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? reply.sendFile(`hosted/blog/${slug}.html`) : reply.callNotFound();
  });

  const shared = async (reply: FastifyReply, read: () => Promise<ShareMeta>) => {
    // Vercel asks for the same public projection, then renders its own deployment's JS and CSS.
    const dataOnly = reply.request.headers.accept === SHARE_META_TYPE;
    reply.header('Vary','Accept');
    let meta: ShareMeta;
    try {
      meta = await read();
    } catch (error) {
      const status = error instanceof CloudError && (error.statusCode === 400 || error.statusCode === 404) ? 404 : 503;
      reply.code(status);
      if (dataOnly) return reply.send({error:'Page unavailable'});
      return reply.type('text/html; charset=utf-8').send(unavailableShare(await readFile(join(webRoot,'index.html'),'utf8'),status));
    }
    if (dataOnly) return reply.send(meta);
    const template = await readFile(join(webRoot,'index.html'),'utf8');
    return reply.type('text/html; charset=utf-8').send(shareDocument(template,meta.title,meta.description,meta));
  };
  // A page shared in a window (`?period=week|month`) previews that window.
  const window = (period: unknown) => period === 'week' || period === 'month' ? period : 'all';
  app.get<{Params:{alias:string};Querystring:{period?:string}}>('/u/:alias',async(request,reply)=>ALIAS_PATTERN.test(request.params.alias)
    ? shared(reply,()=>profileMeta(repository,request.params.alias,window(request.query.period),publicSite(request.headers))) : reply.callNotFound());
  app.get<{Params:{alias:string;period:string}}>('/wrapped/:alias/:period',async(request,reply)=>ALIAS_PATTERN.test(request.params.alias) && /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(request.params.period)
    ? shared(reply,()=>wrappedMeta(repository,request.params.alias,request.params.period,publicSite(request.headers))) : reply.callNotFound());
  app.get<{Params:{a:string;b:string};Querystring:{period?:string}}>('/vs/:a/:b',async(request,reply)=>ALIAS_PATTERN.test(request.params.a) && ALIAS_PATTERN.test(request.params.b)
    ? shared(reply,()=>compareMeta(repository,request.params.a,request.params.b,window(request.query.period),publicSite(request.headers))) : reply.callNotFound());
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'This endpoint does not exist.'}}));
  return app;
}
function authOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_url');
    return url.origin;
  } catch {throw new Error('Supabase URL must be an HTTPS origin (loopback HTTP is allowed for development).');}
}
export async function createHostedApp(options: HostedOptions): Promise<FastifyInstance> {
  const publicAuth = options.supabaseUrl ? authOrigin(options.supabaseUrl) : undefined;
  if (!!publicAuth !== !!options.supabaseAnonKey) throw new Error('Both public Supabase settings are required together');
  if (options.supabaseAnonKey?.startsWith('sb_secret_')) throw new Error('A Supabase secret key cannot be exposed to browsers');
  if (options.supabaseAnonKey?.startsWith('ey')) {
    try {if (JSON.parse(Buffer.from(options.supabaseAnonKey.split('.')[1]!, 'base64url').toString()).role !== 'anon') throw new Error();}
    catch {throw new Error('Only a public anon or publishable key can be exposed to browsers');}
  }
  const moderationPolicy = options.moderationPolicy ?? parseModerationPolicy(process.env.TOKENTRACKY_MODERATION_POLICY);
  const pool = new Pool({connectionString:options.databaseUrl,max:10});
  // Moderation events go to Cloud Logging as structured lines for the log-based alert; they carry no alias or account id.
  const logModeration = (event:object)=>{process.stdout.write(`${JSON.stringify({severity:'NOTICE',...event})}\n`);};
  const repository = new PostgresCloudRepository(pool,undefined,undefined,logModeration,moderationPolicy);
  const app = await baseApp(options.webRoot,publicAuth,options.trustedProxies,postgresRateLimitStore(pool),options.gateway,repository).catch(async error => {await pool.end();throw error;});
  app.addHook('onClose',async()=>{await pool.end();});
  try {
    await migrateCloud(pool);
    const githubLogin = publicAuth && options.supabaseServiceRoleKey ? supabaseGithubLogin(publicAuth,options.supabaseServiceRoleKey) : undefined;
    await registerCloudRoutes(app,{repository,auth:options.auth,githubLogin});
    const authProviders = publicAuth ? options.authProviders ?? ['email'] : [];
    app.get('/api/health',()=>({mode:'hosted',authConfigured:!!publicAuth,version:'0.1.0',cloudUrl:null,supabaseUrl:publicAuth ?? null,supabaseAnonKey:options.supabaseAnonKey ?? null,authProviders}));
    await app.ready();
    return app;
  } catch(error) {await app.close();throw error;}
}
