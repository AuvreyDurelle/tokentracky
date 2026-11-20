// Check the deployable HTML directly, without rendering JavaScript or contacting any services.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath, URL} from 'node:url';
import {join} from 'node:path';
import process from 'node:process';

const dist = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const origin = 'https://tokentracky.com';
const routes = ['/', '/join', '/privacy', '/terms', '/support', '/blog'];
const featured = [
  '/blog/how-tokentracky-counts-tokens',
  '/blog/what-joining-the-leaderboard-shares',
  '/blog/token-town-development-diary',
  '/blog/how-to-read-the-token-leaderboard',
];
const articles = readdirSync(join(dist, 'hosted/blog')).filter(file => file.endsWith('.html'))
  .map(file => '/blog/' + file.slice(0, -5));
const guides = articles.filter(path => !featured.includes(path));
assert.ok(guides.length >= 13, 'Expected at least thirteen footer guide files');
for (const path of featured) assert.ok(articles.includes(path), 'Missing article ' + path);
const pages = new Set([...routes, ...articles]);
const titles = new Set();
const descriptions = new Set();

// These checks read the quoted attributes produced by the site's React/build serializers.
function tags(html, tag) {
  return [...html.matchAll(new RegExp('<' + tag + '\\b([^>]*)>', 'gi'))].map(match =>
    Object.fromEntries([...match[1].matchAll(/([^\s=/>]+)\s*=\s*(["'])(.*?)\2/gs)].map(attr =>
      [attr[1].toLowerCase(), attr[3].replaceAll('&amp;', '&')])));
}

function locations(html, base) {
  return tags(html, 'a').map(({href}) => {
    assert.ok(href?.trim(), base + ' has an anchor without a destination');
    return new URL(href, base);
  });
}

function asset(url, page) {
  assert.ok(url.pathname.startsWith('/assets/'), page + ' links to an unexpected asset ' + url.pathname);
  assert.ok(statSync(join(dist, url.pathname)).size > 0, page + ' references an empty asset ' + url.pathname);
}

for (const path of pages) {
  const url = origin + path;
  const html = readFileSync(join(dist, 'hosted', (path === '/' ? 'index' : path.slice(1)) + '.html'), 'utf8');
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const title = head.match(/<title>([^<]+)<\/title>/i)?.[1];
  const meta = tags(head, 'meta');
  const description = meta.find(tag => tag.name === 'description')?.content;
  assert.ok(title?.trim() && !titles.has(title), path + ' needs a unique title');
  assert.ok(description?.trim() && !descriptions.has(description), path + ' needs a unique description');
  titles.add(title);
  descriptions.add(description);
  assert.deepEqual(tags(head, 'link').filter(tag => tag.rel === 'canonical').map(tag => tag.href), [url], path);
  assert.ok(!meta.some(tag => tag.name === 'robots' && /\b(noindex|none)\b/i.test(tag.content)), path + ' blocks indexing');
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? '';
  assert.equal(tags(main, 'h1').length, 1, path + ' needs one H1 in the initial main content');
  assert.match(main, /<p\b[^>]*>[\s\S]+?<\/p>/i, path + ' needs visible copy');

  const footerPattern = /<footer\b[^>]*>[\s\S]*?<\/footer>/gi;
  const footerPaths = locations((html.match(footerPattern) ?? []).join(''), url)
    .filter(link => link.origin === origin).map(link => link.pathname);
  const otherPaths = locations(html.replace(footerPattern, ''), url)
    .filter(link => link.origin === origin).map(link => link.pathname);
  for (const guide of guides) {
    assert.ok(footerPaths.includes(guide), path + ' footer is missing ' + guide);
    assert.ok(!otherPaths.includes(guide), path + ' links outside the footer to ' + guide);
  }
  if (path === '/blog') {
    const mainPaths = locations(main, url).filter(link => link.origin === origin).map(link => link.pathname);
    for (const post of featured) assert.ok(mainPaths.includes(post), 'Blog index is missing ' + post);
  }
  for (const link of locations(html, url)) {
    assert.ok(['https:', 'mailto:'].includes(link.protocol), path + ' has an invalid link ' + link.href);
    if (link.origin !== origin) continue;
    if (link.pathname.startsWith('/assets/')) asset(link, path);
    else assert.ok(pages.has(link.pathname) || link.pathname === '/you', path + ' links to unknown page ' + link.href);
  }
  for (const img of tags(main, 'img')) {
    assert.ok(img.src && img.alt !== undefined, path + ' image lacks a source or alt attribute');
    const image = new URL(img.src, url);
    if (image.origin === origin) asset(image, path);
    if (articles.includes(path)) assert.ok(img.alt && Number(img.width) > 0 && Number(img.height) > 0, path + ' needs descriptive, sized article images');
  }
  if (articles.includes(path)) {
    const json = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(match => tags('<script' + match[1] + '>', 'script')[0]?.type === 'application/ld+json')
      .map(match => JSON.parse(match[2]));
    const post = json.find(item => item['@type'] === 'BlogPosting');
    assert.ok(post?.headline && post.author && post.datePublished && Number.isFinite(Date.parse(post.datePublished)), path + ' has incomplete BlogPosting data');
    assert.ok(main.includes('<article'), path + ' needs a visible article');
  }
}

const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
assert.deepEqual(listed.sort(), [...routes, ...featured].map(path => origin + path).sort(),
  'The sitemap must list each primary page and featured article once. Footer-only guides are discovered through the footer.');
assert.match(readFileSync(join(dist, 'robots.txt'), 'utf8'), /^Sitemap:\s*https:\/\/tokentracky\.com\/sitemap\.xml\s*$/im);
process.stdout.write(`Checked ${pages.size} hosted pages, including ${featured.length} featured articles and ${guides.length} footer-only guides.\n`);
