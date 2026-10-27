import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
// The shell's styles and the community pages' (leaderboard, profiles, achievements).
const css = ['./mac.css', './community.css'].map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
/** Each selector with the declarations of its rule, as `property: value` strings. */
const rules = [...css.replace(/@media[^{]+\{/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1]!.split(',').map((selector) => ({ selector: selector.trim(), declarations: match[2]!.split(';').map((part) => part.trim()).filter(Boolean) })));
const declarations = (selector: string) => rules.filter((rule) => rule.selector === selector).flatMap((rule) => rule.declarations);

/** The class names a component's `className` attributes can produce: their quoted strings and the fixed parts of their templates. */
function classNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{)/g)) {
    let text = match[1];
    if (text === undefined) {
      const start = match.index! + match[0].length;
      let depth = 1, end = start;
      while (depth > 0 && end < source.length) { const char = source[end++]; if (char === '{') depth++; else if (char === '}') depth--; }
      const expression = source.slice(start, end - 1);
      text = [...[...expression.matchAll(/'([^']*)'|"([^"]*)"/g)].map((part) => part[1] ?? part[2]!), ...[...expression.matchAll(/`([^`]*)`/g)].map((part) => part[1]!.replace(/\$\{[^}]*\}/g, ' '))].join(' ');
    }
    names.push(...text.split(/\s+/).filter(Boolean));
  }
  return names;
}
// The website pages hosted by the shell, with the components they render. The leaderboard and profiles are ported.
const hosted = new Set(['../You.tsx', '../Insights.tsx', '../Heatmap.tsx', '../TrendChart.tsx', '../Join.tsx', '../ui.tsx'].flatMap((file) => classNames(read(file))));
// A rule rooted at one of the shell's own containers, or at an m- primitive (no website markup carries the prefix), cannot reach the website's pages.
// Classes of the website's stylesheet, and the community pages that must not pick up its rules.
const legacy = new Set([...read('../styles.css').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]!));
const COMMUNITY = ['./LeaderboardView.tsx', './ProfileModal.tsx', './AchievementsView.tsx', './Emblem.tsx'];
// Shared as they are (ui.tsx's pieces style themselves), or modifiers whose website rules need a class these pages never use (.btn.primary, .badge.gold, .move.up).
const REUSED = new Set(['sr-only', 'num', 'medal', 'g1', 'g2', 'g3', 'on', 'primary', 'gold', 'sorted', 'zero', 'up']);
const OWN = /^\.mac \.(?:sidebar|toolbar|activity|m-[\w-]+)(?![\w-])/;

describe('mac.css and community.css', () => {
  it('scopes every rule under .mac so the hosted site is untouched', () => {
    const selectors = [...css.replace(/@media[^{]+\{/g, '').matchAll(/(?:^|[{};])\s*([^{};@]+)\{/g)].map((match) => match[1]!);
    expect(selectors.length).toBeGreaterThan(60);
    for (const group of selectors) for (const selector of group.split(',')) expect(selector.trim()).toMatch(/^\.mac\b/);
  });
  it("styles the website's pages in the shell only through the sidebar, toolbar, activity card and m- primitives", () => {
    expect(hosted).toContain('btn');
    for (const name of ['sidebar', 'toolbar', 'activity']) expect(hosted).not.toContain(name);
    expect([...hosted].filter((name) => name.startsWith('m-'))).toEqual([]);
    for (const { selector } of rules) {
      if (OWN.test(selector)) continue;
      expect([...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!).filter((name) => hosted.has(name)), selector).toEqual([]);
      // Not `.mac a`: outside those three a rule starts from a class of the shell's own.
      expect(selector).toMatch(/^\.mac(?:\.[\w-]+)*(?: \.[\w-]+.*)?$/);
    }
    // The frame around the pages passes nothing on to them.
    for (const frame of ['.mac', '.mac.app', '.mac .main', '.mac .content']) expect(declarations(frame).filter((declaration) => /^(?:font|color|line-height|letter-spacing)/.test(declaration)), frame).toEqual([]);
  });
  it('gives m- buttons hover only when enabled', () => {
    const selectors = new Set(rules.map((rule) => rule.selector));
    const hovers = [...selectors].filter((selector) => selector.startsWith('.mac .m-btn') && selector.includes(':hover'));
    expect(hovers.length).toBeGreaterThan(0);
    for (const selector of hovers) expect(selector, selector).toContain(':hover:not(:disabled)');
  });
  it("keeps the website's own rules off the community pages", () => {
    expect(legacy).toContain('board');
    for (const file of COMMUNITY) expect(classNames(read(file)).filter((name) => legacy.has(name) && !REUSED.has(name)), file).toEqual([]);
  });
});
