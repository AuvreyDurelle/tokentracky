import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LocalStatus } from '../api';
import { addDays, hourList, last24Hours } from '../ranges';
import { personalFixtures } from './personal-fixtures';
import { TokensPage, chartSeries, modelColors } from './TokensView';
import { OverviewStrip } from './StackedAreaChart';

const f = personalFixtures();
const noop = () => {};
const page = (overrides: Partial<Parameters<typeof TokensPage>[0]> = {}) => renderToStaticMarkup(<TokensPage
  data={{ range: f.range, tool: 'all', summary: f.summary, before: f.before, breakdown: f.breakdown, projects: f.projects, sessions: f.sessions, hours: f.summary.byHour }} year={f.year} status={f.status}
  range={f.range} period="month" span={{ from: f.range.from, to: f.range.to, title: 'Last 30 days', canBack: true, canForward: false }} grain="day" metric="tokens" tool="all" error={null}
  onMetric={noop} onPeriod={noop} onStep={noop} onCustom={noop} onTool={noop} onGrain={noop} onDrill={noop} onExport={noop} {...overrides} />);
/** The usage chart's card, the first on the page. */
const chartCard = (html: string) => /<section class="m-card tk-chart-card"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('TokensPage', () => {
  it('reads a week hour by hour, but a custom range only by day', () => {
    const week = { period: 'week' as const, span: { from: f.range.from, to: f.range.to, title: 'This week', canBack: true, canForward: false } };
    expect(chartCard(page(week))).toMatch(/>Hour</);
    expect(chartCard(page({ ...week, custom: true }))).not.toMatch(/>Hour</);
  });
  it('leads with the totals as tiles, each with its change, and the split by tool over the chart', () => {
    const html = text(page());
    expect(html).toMatch(/Tokens 6\.9B \+38% vs 5B/);
    expect(html).toContain('Est. cost $2,394');
    expect(html).toContain('Sessions 1,284');
    for (const tool of ['Claude Code 4.6B · 67%', 'Codex 1.8B · 26%', 'Gemini CLI 248.4M · 3.6%']) expect(html).toContain(tool);
    expect(page()).toMatch(/<button type="button" class="tk-tile on" aria-pressed="true">/);
  });
  it("waits for the chosen period's totals instead of showing the last period's under its labels", () => {
    const week = { from: addDays(f.range.to, -6), to: f.range.to };
    for (const html of [text(page({ range: week })), text(page({ tool: 'codex' }))]) {
      expect(html).toContain('Loading your usage');
      expect(html).not.toContain('6.9B');
    }
  });
  it('offers the four periods, stepping back through them, and a custom range', () => {
    const html = page();
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">Month<\/button>/);
    for (const label of ['24h', 'Week', 'All time', 'Custom range', 'Export CSV', 'aria-label="Earlier"']) expect(html).toContain(label);
    expect(html).toContain('aria-label="Later" disabled=""');
  });
  it('charts the days by tool with weekends shaded and every value in a hidden table, and opens a day on click', () => {
    const card = chartCard(page());
    expect(card).toMatch(/<caption>Tokens per day by tool, [^<]+<\/caption>/);
    expect(card.match(/class="tk-area"/g)).toHaveLength(5);
    expect(card).toContain('class="tk-band"');
    expect(card).toContain('class="tk-pickable"');
    for (const control of ['Split by', 'Token type', 'Project', 'Granularity', 'Compare']) expect(card).toContain(control);
  });
  it('reads the cache rate from the period, and today, this week and the streak against your records', () => {
    const html = text(chartCard(page()));
    // Cache reads (90%) of all input (cache reads, plain input and cache writes: 97%).
    expect(html).toContain('Cache hit rate 97.1% 6.2B of 6.7B input');
    expect(html).toContain('Avg / active day');
    expect(html).toContain('Personal best watch');
    expect(html).toMatch(/Today 186\.4M/);
    expect(html).toMatch(/Streak \d+ days? best 58/);
  });
  it('totals the period by kind, cached and uncached input apart, and splits the cost by kind', () => {
    const counts = { input: 100, output: 50, cacheRead: 800, cacheWrite: 50, reasoning: 30 };
    const parts = { input: 300_000, output: 750_000, cacheRead: 240_000, cacheWrite: 210_000, cacheSavings: 2_160_000 };
    const summary = { ...f.summary, tokens: 1_000, breakdown: counts, costParts: parts, costMicrousd: 1_500_000 };
    const html = text(page({ data: { range: f.range, tool: 'all', summary, before: f.before, breakdown: f.breakdown, projects: f.projects, sessions: f.sessions, hours: f.summary.byHour } }));
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
    // The biggest session ran about 3 hours, from the quarter hour of its first event.
    expect(html).toMatch(/Longest session 3h \d+m 184\.2M tokens · \w{3}, \w{3} \d+ claude-opus-5-5 in Claude Code/);
    expect(html).toContain('Trending model gpt-6.1-sol');
    expect(html).toContain('+6.2 pts');
    expect(html).toContain('Busiest hour 22:00 – 23:00');
    expect(html).toContain('12% of tokens · your local time');
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
    const html = page({ period: '24h', span: null, range: window, data: { range: window, tool: 'all', summary: f.summary, before: f.before, breakdown: hours, projects: f.projects, sessions: f.sessions, hours: f.summary.byHour } });
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">24h<\/button>/);
    expect(text(html)).toContain('Last 24 hours');
    expect(text(html)).toContain('Compared with the 24 hours before');
    expect(html).toContain('<caption>Tokens per hour by tool, the last 24 hours</caption>');
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

describe('OverviewStrip', () => {
  it('lights only the chart’s own days, not everything since they began', () => {
    const days = Array.from({ length: 40 }, (_, at) => ({ day: addDays('2026-10-01', at), tokens: at }));
    const html = renderToStaticMarkup(<OverviewStrip days={days} from="2026-10-05" to="2026-10-11" />);
    expect(html).toMatch(/(Oct 5|5 Oct) to (Oct 11|11 Oct) highlighted/);
  });
});
