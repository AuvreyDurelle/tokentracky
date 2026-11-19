import { describe, expect, it } from 'vitest';
import { badgeOptions, badgeSvg, cardSvg, heatmapSvg } from '../src/badge.ts';

describe('badge options', () => {
  it('defaults to a flat tokentracky badge in the accent colour', () => {
    expect(badgeOptions({})).toEqual({style: 'flat', label: 'tokentracky', color: '4f56b8'});
    expect(badgeSvg('1.2M tokens')).toContain('rx="3"');
  });
  it('takes a style, a label of up to 30 characters and a six-digit colour', () => {
    const options = badgeOptions({style: 'flat-square', label: 'AI tokens', color: 'FF8800'});
    expect(options).toEqual({style: 'flat-square', label: 'AI tokens', color: 'ff8800'});
    const svg = badgeSvg('#4', options);
    expect(svg).toContain('rx="0"');
    expect(svg).toContain('fill="#ff8800"');
    expect(svg).toContain('>AI tokens<');
    expect(badgeOptions({label: 'x'.repeat(30)}).label).toHaveLength(30);
  });
  it.each([
    [{style: 'plastic'}], [{label: ''}], [{label: 'x'.repeat(31)}], [{label: 'a\u0000b'}], [{label: ['a', 'b']}],
    [{color: '#ff8800'}], [{color: 'f80'}], [{color: 'gg8800'}],
  ])('rejects %j', (query) => {
    expect(() => badgeOptions(query)).toThrow();
  });
  it('escapes the label and value', () => {
    const svg = badgeSvg('<b>"1"</b>', badgeOptions({label: `a&b<script>'`}));
    expect(svg).not.toMatch(/<script|<b>/);
    expect(svg).toContain('a&#38;b&#60;script&#62;&#39;');
    expect(svg).toContain('&#60;b&#62;&#34;1&#34;&#60;/b&#62;');
  });
});

describe('README card', () => {
  const data = {alias: 'marenh', rank: 42, tokens: 18_400_000_000, costMicrousd: 6_412_000_000, tools: {claude: 9e9, codex: 6e9, gemini: 2e9, cline: 1e9}};
  it('is 600×180 with the name, rank, tokens, cost and the top three tools', () => {
    const svg = cardSvg(data, 'dark', 'all');
    expect(svg).toContain('width="600" height="180"');
    expect(svg).toContain('>marenh<');
    expect(svg).toContain('>#42<');
    expect(svg).toContain('18B tokens · $6,412 est.');
    expect(svg).toContain('>Claude Code<');
    expect(svg).toContain('>Gemini CLI<');
    expect(svg).not.toContain('>Cline<');
    expect(svg).toContain('>All time<');
  });
  it('leaves out cost and tools when they are not known, and says when a profile is private', () => {
    const svg = cardSvg({alias: 'quiet', rank: 3, tokens: 1200, costMicrousd: null}, 'light', 'week');
    expect(svg).toContain('1.2K tokens<');
    expect(svg).not.toContain('est.');
    expect(svg).toContain('>This week<');
    expect(svg).toContain('fill="#ffffff"');
    expect(cardSvg(null, 'dark', 'all')).toContain('>private<');
  });
});

describe('README heatmap', () => {
  // 365 days ending Thursday 2026-10-22: Monday-first weeks put the first day, Thursday 2025-10-23, in row 3.
  const daily = Array.from({length: 365}, (_, index) => ({day: new Date(Date.UTC(2025, 9, 23) + index * 86_400_000).toISOString().slice(0, 10), tokens: index >= 361 ? 10 ** (index - 360) : 0}));
  it('draws a cell per day in the site\'s quartile levels, with month and weekday labels, the year\'s total and the streak', () => {
    const svg = heatmapSvg({alias: 'token-wizard', daily, currentStreak: 4}, 'dark');
    expect(svg.match(/<rect x="\d+" y="\d+" width="10" height="10" rx="2" fill="[^"]+"><title>/g)).toHaveLength(365);
    expect(svg).toContain('<rect x="52" y="103" width="10" height="10" rx="2" fill="#161719"><title>2025-10-23: 0 tokens</title>');
    expect(svg).toContain('fill="#eceef0"><title>2026-10-22: 10,000 tokens</title>');
    expect(svg).toContain('fill="#2c2e31"><title>2026-10-19: 10 tokens</title>');
    expect(svg).toContain('>Nov<');
    expect(svg).toContain('>Mon<');
    expect(svg).toContain('token-wizard<tspan');
    expect(svg).toContain(' · 11K tokens in the last year<');
    expect(svg).toContain('>4-day streak<');
    expect(svg).toContain('width="761"');
  });
  it('uses light colours on the light theme, escapes the name and draws the private placeholder', () => {
    expect(heatmapSvg({alias: 'a<b', daily, currentStreak: 0}, 'light')).toContain('a&#60;b');
    expect(heatmapSvg({alias: 'x', daily, currentStreak: 0}, 'light')).toContain('fill="#ebedf0"><title>2025-10-23');
    expect(heatmapSvg({alias: 'x', daily, currentStreak: 0}, 'dark')).toContain('>No current streak<');
    expect(heatmapSvg(null, 'dark')).toContain('>private<');
  });
});
