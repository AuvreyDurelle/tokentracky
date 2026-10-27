import {describe,expect,it} from 'vitest';
import {access,readFile} from 'node:fs/promises';
import {SPA_PAGES,PROFILE_ALIAS,contentSecurityPolicy} from './app.ts';

interface VercelConfig {rewrites:Array<{source:string;destination:string}>;headers:Array<{source:string;headers:Array<{key:string;value:string}>}>}
const config=JSON.parse(await readFile(new URL('../../../vercel.json',import.meta.url),'utf8')) as VercelConfig;
const destination=(source:string)=>config.rewrites.find(rewrite=>rewrite.source===source)?.destination;

describe('static hosting config',()=>{
  it('rewrites the same app pages the server serves',()=>{
    expect(destination(`/(${SPA_PAGES.map(page=>page.slice(1)).join('|')})`)).toBe('/index.html');
    expect(destination(`/u/:alias(${PROFILE_ALIAS.source.slice(1,-1)})`)).toBe('/index.html');
  });
  it('sends API, badge and card requests through the signing gateway function',async()=>{
    // Outside Next.js, Vercel routes [...path] files as one segment, so the gateway is a plain file and reads the visitor's path.
    await expect(access(new URL('../../../api/gateway.ts',import.meta.url))).resolves.toBeUndefined();
    // Unnamed groups: Vercel appends unused named parameters (:path*) as query fields, which the API rejects.
    expect(destination('/api/(.*)')).toBe('/api/gateway');
    expect(destination('/badge/(.*)')).toBe('/api/gateway');
    expect(destination('/card/(.*)')).toBe('/api/gateway');
  });
  it('imports the gateway function\'s modules by the .js names Vercel compiles them to',async()=>{
    // Vercel compiles each file to .js without rewriting import specifiers, so a .ts specifier fails at runtime.
    for (const file of ['../../../api/gateway.ts','./vercel-gateway.ts','./gateway-auth.ts']) {
      const source=await readFile(new URL(file,import.meta.url),'utf8');
      expect(source.match(/from '\.{1,2}\/[^']*\.ts'/g) ?? []).toEqual([]);
    }
  });
  it('sends the server security headers with the auth origin',()=>{
    const headers=Object.fromEntries(config.headers.find(rule=>rule.source==='/(.*)')!.headers.map(header=>[header.key,header.value]));
    const authOrigin=headers['Content-Security-Policy']!.match(/connect-src 'self' (\S+);/)![1];
    expect(authOrigin).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co$/);
    expect(headers).toEqual({'Content-Security-Policy':contentSecurityPolicy(authOrigin),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()'});
  });
});
