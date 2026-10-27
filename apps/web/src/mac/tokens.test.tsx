import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LocalStatus } from '../api';
import { addDays, hourList, last24Hours } from '../ranges';
import { personalFixtures } from './personal-fixtures';
import { TokensPage, chartSeries, modelColors } from './TokensView';

const f = personalFixtures();
const noop = () => {};
const page = (overrides: Partial<Parameters<typeof TokensPage>[0]> = {}) => renderToStaticMarkup(<TokensPage
  data={{ range: f.range, tool: 'all', summary: f.summary, before: f.before, breakdown: f.breakdown, projects: f.projects, sessions: f.sessions }} year={f.year} status={f.status}
  range={f.range} days={30} metric="tokens" tool="all" error={null} onMetric={noop} onDays={noop} onTool={noop} onExport={noop} {...overrides} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('TokensPage', () => {
  it('leads with the period total, its change, cost and sessions, beside the split by tool', () => {
    const html = text(page());
    expect(html).toContain('Total tokens · last 30 days');
    expect(html).toMatch(/6\.9B 38%/);
    expect(html).toContain('$2,394 est. cost · 1,284 sessions · 5B previous 30 days');
    for (const tool of ['Claude Code 412 sessions 4.6B 67%', 'Codex 731 sessions 1.8B 26%', 'Gemini CLI 74 sessions 248.4M 3.6%']) expect(html).toContain(tool);
  });
  it("waits for the chosen period's totals instead of showing the last period's under its labels", () => {
    const week = { from: addDays(f.range.to, -6), to: f.range.to };
    for (const html of [text(page({ days: 7, range: week })), text(page({ tool: 'codex' }))]) {
      expect(html).toContain('Loading your usage');
      expect(html).not.toContain('6.9B');
    }
  });
  it('offers the ranges the local API serves, with the chosen one pressed', () => {
    const html = page({ days: 90 });
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">90d<\/button>/);
    for (const label of ['24h', '7d', '30d', '12m', 'Export CSV']) expect(html).toContain(label);
  });
  it('charts the days by tool, with every value in a hidden table', () => {
    const html = page();
    expect(html).toContain('<caption>Daily tokens by tool, last 30 days</caption>');
    expect(html.match(/class="tk-area"/g)).toHaveLength(5);
  });
  it('reads today, 7 and 30 days with their cost and change from the year, and the cache rate from the period', () => {
    const html = text(page());
    for (const kpi of ['Today 186.4M', '7 days', '30 days 6.9B', 'Avg / active day 87.2M', 'Cache hit rate 97.1%']) expect(html).toContain(kpi);
    expect(html).toMatch(/Today 186\.4M \$[\d.,]+ · so far · UTC/);
    expect(html).toMatch(/30 days 6\.9B \$[\d,]+ · [+−±][\d.]+%/);
    // Cache reads (90%) of all input (cache reads, plain input and cache writes: 97%).
    expect(html).toContain('Cache hit rate 97.1% 6.2B of 6.7B input');
  });
  it('totals the period by kind, cached and uncached input apart, and splits the cost by kind', () => {
    const counts = { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 };
    const parts = { input: 300_000, output: 750_000, cacheRead: 240_000, cacheWrite: 210_000, cacheSavings: 2_160_000 };
    const summary = { ...f.summary, tokens: 1_000, breakdown: counts, costParts: parts, costMicrousd: 1_500_000 };
    const html = text(page({ data: { range: f.range, tool: 'all', summary, before: f.before, breakdown: f.breakdown, projects: f.projects, sessions: f.sessions } }));
    for (const total of ['Processed tokens 1K', 'Cached input 800 84%', 'Uncached input 150 16%', 'Output 50 5.0% of tokens', 'Reasoning 30 counted inside output', 'Cache savings $2.16']) expect(html).toContain(total);
    expect(html).toContain('Cost by type API-price estimate $1.50 across 9 models');
    for (const row of ['Input 20% $0.30', 'Cache read 16% $0.24', 'Cache write 14% $0.21', 'Output 50% $0.75']) expect(html).toContain(row);
    expect(text(page())).toContain('Cost by type is unknown');
  });
  it('shows the insights the local records support', () => {
    const html = text(page());
    expect(html).toContain('Favourite model claude-opus-5-5');
    expect(html).toContain('Busiest weekday · UTC');
    expect(html).toContain('Longest streak 58 days');
    expect(html).toContain('Top project usage-dashboard');
    expect(html).toContain('Local only — never uploaded');
    expect(html).toContain('Biggest session 184.2M');
    expect(html).toContain('Trending model gpt-6.1-sol');
    expect(html).toContain('+6.2 pts');
    expect(html).not.toContain('Busiest hour');
  });
  it('breaks the period down by model, largest first, with its input, output and cached tokens', () => {
    const html = page();
    const table = /<table class="m-table tk-table">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? '';
    expect(text(table)).toMatch(/1 claude-opus-5-5[\s\S]*2 gpt-6.1-sol/);
    expect(text(table)).toContain('# Model Sessions Input Output Cached Cost Share Tokens');
    // claude-opus-5-5: 4.2B, of which 7% plain input and cache writes, 3% output and 90% cache reads.
    // 92% of Claude Code's 412 sessions.
    expect(text(table)).toContain('1 claude-opus-5-5 379 296.2M 127M 3.8B');
  });
  it('shows the last 24 hours as stacked bars against the 24 before, without the views that need days', () => {
    const window = last24Hours();
    // Breakdown rows by hour: each row's day is its hour's first instant.
    const hours = hourList(window).map((day, index) => ({ ...f.breakdown[0]!, day, tokens: (index + 1) * 1e6 }));
    const html = page({ days: '24h', range: window, data: { range: window, tool: 'all', summary: f.summary, before: f.before, breakdown: hours, projects: f.projects, sessions: f.sessions } });
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">24h<\/button>/);
    expect(text(html)).toContain('Total tokens · last 24 hours');
    expect(text(html)).toContain('previous 24 hours');
    expect(html).toContain('<caption>Hourly tokens by tool, last 24 hours</caption>');
    expect(html.match(/class="tk-hour"/g)).toHaveLength(24);
    for (const gone of ['Most expensive day', 'Daily avg', '>Day</button>', 'Chart style']) expect(html).not.toContain(gone);
    expect(text(page())).toContain('Most expensive day');
  });
  it('points to Settings instead of dead-ending when no tool is tracked', () => {
    const idle: LocalStatus = { ...f.status, sources: f.status.sources.map((source) => ({ ...source, enabled: false })) };
    expect(page({ status: idle })).toMatch(/href="\/settings"[^>]*>Open Settings/);
    expect(page()).not.toContain('Open Settings');
  });
});

describe('chartSeries', () => {
  const days = Array.from(new Set(f.breakdown.map((row) => row.day)));
  it('colours tools by their own hue and keeps cost alongside tokens', () => {
    const series = chartSeries(f.breakdown, days, 'tools', 'tokens');
    expect(series.map((item) => item.color).slice(0, 2)).toEqual(['var(--tool-claude)', 'var(--tool-codex)']);
    expect(series[0]!.costs).toHaveLength(days.length);
    expect(chartSeries(f.breakdown, days, 'tools', 'cost')[0]!.costs).toBeUndefined();
  });
  it('groups the top five models and the rest', () => {
    expect(chartSeries(f.breakdown, days, 'models', 'tokens').map((item) => item.label)).toEqual(['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-6-astra', 'gemini-3.8-flash', 'claude-sonnet-5-5', 'Other']);
  });
});

describe('modelColors', () => {
  it("shades each model from its main tool's hue, in order, with the rest in grey", () => {
    const colors = modelColors([{ key: 'opus' }, { key: 'sol' }, { key: 'sonnet' }, { key: 'other', other: true }], new Map([['opus', 'claude'], ['sol', 'codex'], ['sonnet', 'claude']]));
    expect(colors.get('opus')).toBe('var(--tool-claude)');
    expect(colors.get('sol')).toBe('var(--tool-codex)');
    expect(colors.get('sonnet')).toMatch(/^color-mix\(in oklab, var\(--tool-claude\) \d+%, var\(--bg\)\)$/);
    expect(colors.get('other')).toBe('var(--heat-2)');
  });
});
