import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LegalLinks, LegalPage, legalPageAt, type LegalPageId } from './Legal';

const pages: LegalPageId[] = ['privacy', 'terms', 'support'];

describe('legal and support pages', () => {
  it('are chosen only by their exact addresses', () => {
    expect(pages.map((page) => legalPageAt(`/${page}`))).toEqual(pages);
    for (const path of ['/', '/privacy/', '/Privacy', '/privacy/extra', '/legal']) expect(legalPageAt(path)).toBeNull();
  });
  it.each(pages)('%s marks itself current, links every section and gives the contact address', (page) => {
    const html = renderToStaticMarkup(<LegalPage page={page} />);
    expect(html).toContain(`href="/${page}" aria-current="page"`);
    const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(html).toContain(`href="#${id}"`);
    expect(html).toContain('href="mailto:contact@tokentracky.com"');
  });
  it('says token types are published and the one-hour cache split and service tier stay local', () => {
    const html = renderToStaticMarkup(<LegalPage page="privacy" />);
    expect(html).toContain('daily token totals split by type (input, output, cache read, cache write and reasoning)');
    expect(html).toContain('The split of cache writes into one-hour and five-minute writes, and the service tier of each request, stay on your computer.');
  });
  it('links all three pages from the footer', () => {
    const html = renderToStaticMarkup(<LegalLinks />);
    for (const page of pages) expect(html).toContain(`href="/${page}"`);
  });
});
