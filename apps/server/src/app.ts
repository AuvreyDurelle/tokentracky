import {type FastifyInstance} from 'fastify';
import {createHttpServer} from './http-server.ts';
import staticFiles from '@fastify/static';
import {Pool} from 'pg';
import {migrateCloud, PostgresCloudRepository, registerCloudRoutes, CloudError, supabaseGithubLogin, parseModerationPolicy, type ModerationPolicy} from '@tokentracky/cloud';
import {postgresRateLimitStore} from './rate-limit-store.ts';
import type {FastifyRateLimitStoreCtor} from '@fastify/rate-limit';
import type {GatewayAuthConfig} from './gateway-auth.ts';

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
/** Pages the web app renders at their own addresses; static hosting (vercel.json) must rewrite the same set. */
export const SPA_PAGES = ['/privacy','/terms','/support','/leaderboard','/you','/join'] as const;
export const PROFILE_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
export const contentSecurityPolicy = (authOrigin?: string) => `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${authOrigin ? ' '+authOrigin : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
async function baseApp(webRoot: string, authOrigin?: string, trustedProxies?: string[], rateLimitStore?: FastifyRateLimitStoreCtor, gateway?: GatewayAuthConfig): Promise<FastifyInstance> {
  // No request logging: headers, query strings and local paths may contain secrets.
  const app = await createHttpServer({trustedProxies,store:rateLimitStore,gateway});
  app.addHook('onRequest', async (_request,reply) => {
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
  app.get('/',(_request,reply)=>reply.sendFile('index.html'));
  // Legal and support pages are rendered by the web app at their own addresses.
  for (const page of SPA_PAGES) app.get(page,(_request,reply)=>reply.sendFile('index.html'));
  // Public profiles have shareable addresses; the web app shows its own not-found state for unknown names.
  app.get<{Params:{alias:string}}>('/u/:alias',(request,reply)=>PROFILE_ALIAS.test(request.params.alias) ? reply.sendFile('index.html') : reply.callNotFound());
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
  const app = await baseApp(options.webRoot,publicAuth,options.trustedProxies,postgresRateLimitStore(pool),options.gateway).catch(async error => {await pool.end();throw error;});
  app.addHook('onClose',async()=>{await pool.end();});
  try {
    await migrateCloud(pool);
    // Moderation events go to Cloud Logging as structured lines for the log-based alert; they carry no alias or account id.
    const logModeration = (event:object)=>{process.stdout.write(`${JSON.stringify({severity:'NOTICE',...event})}\n`);};
    const githubLogin = publicAuth && options.supabaseServiceRoleKey ? supabaseGithubLogin(publicAuth,options.supabaseServiceRoleKey) : undefined;
    await registerCloudRoutes(app,{repository:new PostgresCloudRepository(pool,undefined,undefined,logModeration,moderationPolicy),auth:options.auth,githubLogin});
    const authProviders = publicAuth ? options.authProviders ?? ['email'] : [];
    app.get('/api/health',()=>({mode:'hosted',authConfigured:!!publicAuth,version:'0.1.0',cloudUrl:null,supabaseUrl:publicAuth ?? null,supabaseAnonKey:options.supabaseAnonKey ?? null,authProviders}));
    await app.ready();
    return app;
  } catch(error) {await app.close();throw error;}
}
