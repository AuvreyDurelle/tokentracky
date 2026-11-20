import {describe,expect,it} from 'vitest';
import {access,readFile} from 'node:fs/promises';
import {ALIAS_PATTERN} from '@tokentracky/core';
import {PUBLIC_PAGES,contentSecurityPolicy} from './app.ts';

interface VercelConfig {rewrites:Array<{source:string;destination:string;has?:Array<{type:string;key:string;value:string}>}>;headers:Array<{source:string;headers:Array<{key:string;value:string}>}>}
const config=JSON.parse(await readFile(new URL('../../../vercel.json',import.meta.url),'utf8')) as VercelConfig;
const destination=(source:string)=>config.rewrites.find(rewrite=>rewrite.source===source&&!rewrite.has)?.destination;

describe('static hosting config',()=>{
  it('rewrites the same app pages the server serves',()=>{
    expect(destination(`/:page(${PUBLIC_PAGES.join('|')})`)).toBe('/hosted/:page.html');
    expect(destination('/blog/:slug([a-z0-9]+(?:-[a-z0-9]+)*)')).toBe('/hosted/blog/:slug.html');
    expect(destination('/you')).toBe('/hosted/app.html');
    expect(destination(`/u/:alias(${ALIAS_PATTERN.source.slice(1,-1)})`)).toBe('/api/page?__page=/u/:alias');
  });
  it('sends API, badge and card requests through the signing gateway function',async()=>{
    // Outside Next.js, Vercel routes [...path] files as one segment, so the gateway is a plain file and reads the visitor's path.
    await expect(access(new URL('../../../api/gateway.ts',import.meta.url))).resolves.toBeUndefined();
    // Unnamed groups: Vercel appends unused named parameters (:path*) as query fields, which the API rejects.
    expect(destination('/api/(.*)')).toBe('/api/gateway');
    expect(destination('/badge/(.*)')).toBe('/api/gateway');
    expect(destination('/card/(.*)')).toBe('/api/gateway');
    expect(destination('/og/(.*)')).toBe('/api/gateway');
  });
  it('serves the same share page to every visitor and uses the current Vercel build',async()=>{
    const alias=ALIAS_PATTERN.source.slice(1,-1);
    expect(config.rewrites.some(rule=>rule.has)).toBe(false);
    expect(destination('/')).toBe('/api/page?__page=/');
    expect(destination(`/vs/:a(${alias})/:b(${alias})`)).toBe('/api/page?__page=/vs/:a/:b');
    expect(destination(`/wrapped/:alias(${alias})/:period([0-9]{4}(?:-(?:0[1-9]|1[0-2]))?)`)).toBe('/api/page?__page=/wrapped/:alias/:period');
    await expect(access(new URL('../../../api/page.ts',import.meta.url))).resolves.toBeUndefined();
  });
  it('imports the gateway function\'s modules by the .js names Vercel compiles them to',async()=>{
    // Vercel compiles each file to .js without rewriting import specifiers, so a .ts specifier fails at runtime.
    for (const file of ['../../../api/gateway.ts','../../../api/page.ts','./public-html.ts','./vercel-gateway.ts','./gateway-auth.ts']) {
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
