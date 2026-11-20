import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { Join } from '../src/Join';
import { DOCS, LegalPage, type LegalPageId } from '../src/Legal';
import { PublicNavigation, SiteFooter } from '../src/Site';
import { launchArticles } from './launch';
import { practicalGuides } from './practical-guides';
import { toolGuides } from './tool-guides';

const origin = 'https://tokentracky.com';
const published = '2026-11-20';
const byline = 'Tokentracky';
const authorUrl = 'https://github.com/AuvreyDurelle/tokentracky';
type Article = typeof launchArticles[number];
type Page = { path: string; title: string; description: string; content: ReactNode; article?: Article };

const images: Record<string, string> = {
  'token-town-development-diary': '/assets/editorial/town-click-1440.webp',
  'how-to-read-the-token-leaderboard': '/assets/editorial/leaderboard.webp',
};

function Header({ page }: { page: 'leaderboard' | 'join' | 'other' }) {
  return <header className="site-nav"><div className="site-nav-inner site-nav-main">
    <div className="site-left"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true" />Tokentracky</a></div>
    <PublicNavigation page={page} />
    <div className="site-right"><a className="btn sm" href="/you">Sign in</a></div>
  </div></header>;
}

function Byline() {
  return <span className="article-byline">{byline} · <time dateTime={published}>November 20, 2026</time></span>;
}

function Blog() {
  return <div className="journal"><h1>Tokentracky blog</h1>
    <p className="journal-intro">Field notes on counting AI coding tokens, sharing usage, and building Token Town.</p>
    <div className="journal-stories">{launchArticles.map(article => <article key={article.slug}>
      <h2><a href={'/blog/' + article.slug}>{article.title}</a></h2>
      <p>{article.description}</p><Byline />
    </article>)}</div>
  </div>;
}

function Story({ article }: { article: Article }) {
  return <article className="journal story">
    <header><h1>{article.title}</h1><p className="journal-intro">{article.description}</p><Byline /></header>
    <div className="story-body">{article.body}</div>
    <section className="story-sources"><h2>Sources</h2><ul>{article.sources.map(source =>
      <li key={source.url}><a href={source.url}>{source.label}</a></li>)}</ul></section>
  </article>;
}

function pages(): Page[] {
  const home = {
    path: '/', title: 'AI coding token leaderboard', description: 'Explore community-reported AI coding token usage by builder, tool, and time period. See how the rankings work and how to join.',
    content: <section className="journal board-intro"><h1>AI coding token leaderboard</h1>
      <p>Compare the tokens builders report from their AI coding tools. The weekly board starts on Monday at 00:00 UTC. Costs are estimates based on model pricing.</p>
      <div dangerouslySetInnerHTML={{ __html: '<!--public-standings-->' }} />
      <p><a href="/join">Track your usage and join the board</a></p>
    </section>,
  };
  const join = {
    path: '/join', title: 'Install Tokentracky and join the AI token leaderboard', description: 'Set up the Mac menu-bar app or terminal tracker, inspect your token counts privately, and choose what happens when you connect a computer.',
    content: <Join />,
  };
  const legal = (Object.keys(DOCS) as LegalPageId[]).map(id => ({
    path: '/' + id, title: DOCS[id].title, description: DOCS[id].lede,
    content: <LegalPage page={id} footer={<SiteFooter />} />,
  }));
  const articles = [...launchArticles, ...practicalGuides, ...toolGuides].map(article => ({
    path: '/blog/' + article.slug, title: article.title, description: article.description, content: <Story article={article} />, article,
  }));
  return [home, join, ...legal, { path: '/blog', title: 'Tokentracky blog', description: 'Read the engineering behind the open-source token collector, a guide to the rankings, and development notes from Token Town.', content: <Blog /> }, ...articles];
}

export function renderHostedFiles(template: string, preview: boolean) {
  const files: Record<string, string> = {};
  const indexed: Page[] = [];
  for (const page of pages()) {
    const canonical = origin + page.path;
    const title = page.title + ' — Tokentracky';
    const image = page.article && images[page.article.slug];
    const schema = page.article && {
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: page.title, description: page.description,
      mainEntityOfPage: canonical, datePublished: published, author: { '@type': 'Organization', name: byline, url: authorUrl },
      ...(image && { image: origin + image }),
    };
    const metadata = renderToStaticMarkup(<>
      <title>{title}</title><meta name="description" content={page.description} /><link rel="canonical" href={canonical} />
      <meta property="og:type" content={schema ? 'article' : 'website'} /><meta property="og:site_name" content="Tokentracky" />
      <meta property="og:title" content={title} /><meta property="og:description" content={page.description} /><meta property="og:url" content={canonical} />
      {image && <><meta property="og:image" content={origin + image} /><meta name="twitter:card" content="summary_large_image" /></>}
      {preview && <meta name="robots" content="noindex" />}
      {schema && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replaceAll('<', '\\u003c') }} />}
    </>);
    const isInteractive = page.path === '/' || page.path === '/join';
    const section = page.path === '/' ? 'leaderboard' : page.path === '/join' ? 'join' : 'other';
    const content = renderToStaticMarkup(page.path.slice(1) in DOCS ? page.content : <div className="app">
      <Header page={section} /><main className="page">{page.content}</main><SiteFooter />
    </div>);
    const html = template.replace(/<meta name="description"[^>]*>/, '').replace(/<title>[^<]*<\/title>/, () => metadata);
    const file = 'hosted/' + (page.path.slice(1) || 'index') + '.html';
    if (files[file]) throw new Error('Duplicate hosted page ' + page.path);
    files[file] = isInteractive
      ? html.replace('<div id="root"></div>', () => '<div id="public-page">' + content + '</div><div id="root"></div>')
      : html.replace(/<script\b[^>]*type="module"[^>]*><\/script>|<link\b[^>]*rel="modulepreload"[^>]*>/g, '').replace('<div id="root"></div>', () => content);
    if (!page.article || launchArticles.includes(page.article)) indexed.push(page);
  }
  files['robots.txt'] = 'User-agent: *\nAllow: /\n\nSitemap: ' + origin + '/sitemap.xml\n';
  files['sitemap.xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + indexed.map(page => '  <url><loc>' + origin + page.path + '</loc>' + (page.article ? '<lastmod>' + published + '</lastmod>' : '') + '</url>').join('\n')
    + '\n</urlset>\n';
  return files;
}
