import {expect,it,vi} from 'vitest';
import {renderPage} from '../../../api/page.ts';

const render = (path:string, read=vi.fn()) => renderPage(new URL(path,'https://tokentracky.com'),read,
  async file => file === 'hosted/app.html'
    ? '<head><title>Board</title></head><div id="root"></div><script src="/assets/current-build.js"></script>'
    : '<h1>Board</h1><!--public-standings-->');
it('renders weekly standings or an explicit unavailable message and preserves private callbacks',async () => {
  const read=vi.fn().mockResolvedValueOnce(Response.json({items:[{alias:'alice',rank:1,tokens:12345}],updatedAt:'2026-11-20T12:45:00.000Z'}))
    .mockResolvedValueOnce(new Response(null,{status:503}));
  const response=await render('/api/page?__page=/',read);
  expect(await response.text()).toContain('<a href="/u/alice">alice</a> · 12,345 tokens');
  expect(await (await render('/',read)).text()).toContain('temporarily unavailable');
  const callback=await render('/?code=synthetic',read);
  expect(callback.headers.get('x-robots-tag')).toBe('noindex');
  expect(await callback.text()).toContain('/assets/current-build.js');
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([['all','All-time leaders'],['month','This month’s leaders'],['24h','Leaders in the last 24 hours']])('renders the requested %s standings on Vercel',async (period,heading) => {
  const read=vi.fn().mockResolvedValue(Response.json({items:[],updatedAt:'2026-11-20T12:45:00.000Z'}));
  const response=await render('/api/page?__page=/&period='+period,read);
  expect(await response.text()).toContain(heading);
  expect(new URL(read.mock.calls[0][0],'https://tokentracky.com').searchParams.get('period')).toBe(period);
});
it('uses the public projection with the deployed shell and preserves withdrawal and upstream errors',async () => {
  const read=vi.fn().mockResolvedValueOnce(Response.json({title:'alice on Tokentracky',description:'Weekly total',url:'https://tokentracky.com/u/alice',image:'https://tokentracky.com/og/alice.png'}))
    .mockResolvedValueOnce(new Response(null,{status:404})).mockRejectedValueOnce(new Error('offline'));
  const response=await render('/api/page?__page=/u/alice&period=week',read);
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.text()).toContain('<h1>alice on Tokentracky</h1>');
  expect(read).toHaveBeenCalledWith('/u/alice?period=week','application/vnd.tokentracky.share+json');
  expect((await render('/u/alice',read)).status).toBe(404);
  expect((await render('/u/alice',read)).status).toBe(503);
  expect((await render('/api/page?__page=/api/account',read)).status).toBe(404);
  expect(read).toHaveBeenCalledTimes(3);
});
