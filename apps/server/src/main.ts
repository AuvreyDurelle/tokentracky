import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostedApp,parseAuthProviders} from './app.ts';
import {parseTrustedProxies} from './http-server.ts';
import {parseGatewayAuthConfig} from './gateway-auth.ts';

const webRoot = resolve(process.env.TOKENTRACKY_WEB_ROOT ?? fileURLToPath(new URL('../../web/dist',import.meta.url)));
if (process.env.TOKENTRACKY_MODE && process.env.TOKENTRACKY_MODE !== 'hosted') throw new Error('The Node server supports hosted mode only. Use the Rust CLI for local tracking.');
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');

const required = (key:string) => {const value=process.env[key];if (!value) throw new Error(`Missing ${key}`);return value;};
const app = await createHostedApp({webRoot,trustedProxies:parseTrustedProxies(process.env.TOKENTRACKY_TRUSTED_PROXIES),gateway:parseGatewayAuthConfig(process.env.TOKENTRACKY_REQUIRE_GATEWAY,process.env.TOKENTRACKY_GATEWAY_SECRET),databaseUrl:required('DATABASE_URL'),auth:{issuer:required('AUTH_ISSUER'),audience:required('AUTH_AUDIENCE'),jwksUrl:required('AUTH_JWKS_URL')},supabaseUrl:process.env.SUPABASE_URL,supabaseAnonKey:process.env.SUPABASE_PUBLISHABLE_KEY,supabaseServiceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY,authProviders:parseAuthProviders(process.env.TOKENTRACKY_AUTH_PROVIDERS)});
await app.listen({host:'0.0.0.0',port});
process.stdout.write(`Tokentracky hosted service listening on port ${port}\n`);
let closing = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{if (!closing) {closing=true;void app.close().then(()=>process.exit(0),()=>process.exit(1));}});
