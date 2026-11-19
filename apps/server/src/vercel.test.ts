import {describe,expect,it} from 'vitest';
import {access,readFile} from 'node:fs/promises';
import {ALIAS_PATTERN} from '@tokentracky/core';
import {SPA_PAGES,contentSecurityPolicy} from './app.ts';

interface VercelConfig {rewrites:Array<{source:string;destination:string;has?:Array<{type:string;key:string;value:string}>}>;headers:Array<{source:string;headers:Array<{key:string;value:string}>}>}
const config=JSON.parse(await readFile(new URL('../../../vercel.json',import.meta.url),'utf8')) as VercelConfig;
const destination=(source:string)=>config.rewrites.find(rewrite=>rewrite.source===source&&!rewrite.has)?.destination;

describe('static hosting config',()=>{
  it('rewrites the same app pages the server serves',()=>{
    expect(destination(`/(${SPA_PAGES.map(page=>page.slice(1)).join('|')})`)).toBe('/index.html');
    expect(destination(`/u/:alias(${ALIAS_PATTERN.source.slice(1,-1)})`)).toBe('/index.html');
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
  it('sends only link-preview crawlers to the API for profile and wrap pages, before the page rewrites',()=>{
    const alias=ALIAS_PATTERN.source.slice(1,-1);
    // Unnamed groups, so Vercel adds no query field to the gateway request.
    const pages=[`/u/(${alias})`,`/wrapped/(${alias})/([0-9]{4}(?:-(?:0[1-9]|1[0-2]))?)`,`/vs/(${alias})/(${alias})`];
    const crawlers=config.rewrites.filter(rewrite=>rewrite.has);
    expect(crawlers.map(rule=>rule.source)).toEqual(pages);
    expect(destination(pages[1]!)).toBe('/index.html');
    expect(destination(pages[2]!)).toBe('/index.html');
    expect(destination(`/u/:alias(${alias})`)).toBe('/index.html');
    for (const rule of crawlers) {
      expect(rule.destination).toBe('/api/gateway');
      expect(config.rewrites.indexOf(rule)).toBeLessThan(config.rewrites.findIndex(rewrite=>!rewrite.has&&rewrite.destination==='/index.html'&&rewrite.source.startsWith(rule.source.slice(0,3))));
      expect(rule.has).toEqual([{type:'header',key:'user-agent',value:crawlers[0]!.has![0]!.value}]);
    }
    const crawls=new RegExp(`^${crawlers[0]!.has![0]!.value}$`);
    for (const agent of ['Twitterbot/1.0','facebookexternalhit/1.1 Facebot Twitterbot/1.0','Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)','Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)','LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)','TelegramBot (like TwitterBot)','WhatsApp/2.23.20.0','Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)']) expect(crawls.test(agent),agent).toBe(true);
    for (const agent of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36']) expect(crawls.test(agent),agent).toBe(false);
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
