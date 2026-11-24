import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { ProjectSummary, SessionSummary, TokenCounts, ToolId, UsageBreakdownRow, UsageSummary } from '@tokentracky/core';
import type { ApiClient, LocalStatus } from '../api';
import { TOOLS, errorText, formatCompact, formatCost, formatCostCompact, formatExact, formatShare, shortDay, timeAgo, toolLabel } from '../format';
import { costGroups } from '../Insights';
import { addDays, fillRange, hourList, last24Hours, previousRange, previousWindow, utcToday, type DayRange, type HourWindow } from '../ranges';
import { usageRevision } from '../refresh';
import { Loading, Notice, ToolIcon } from '../ui';
import { comparedWith } from '../usage-span';
import { downloadCsv } from '../You';
import { ActivityGrid } from './ActivityGrid';
import { useMachine } from './machine';
import { ICONS } from './icons';
import { busiestHour, busiestWeekdayUtc, changeVsPrevious, dailyByModel, dailyByTool, favouriteModel, longestSession, mostExpensiveDay, trendingModel } from './insights';
import { ToolbarActions } from './Shell';
import { OverviewStrip, StackedAreaChart, type ChartSeries } from './StackedAreaChart';
import { bestWeek, cachePerDay, costPerMillion, kindSeries, modelMix, paceToday, projectName, projectSeries, sessionLengths, tokensSpan, weekdayHourStats, weekly, type TokensPeriod, type TokensSpan } from './tokens-model';
import './personal.css';

export type Period = '24h' | TokensPeriod;
type Metric = 'tokens' | 'cost';
type Group = 'tools' | 'models';
type Split = Group | 'projects' | 'kinds';
type Grain = 'hour' | 'day' | 'week';
/** A period's usage, with the range and tool it was loaded for. Over hours `breakdown` is by hour: each row's `day` is its hour's first instant.
 *  `hours` is its tokens by hour of day on this computer's clock, and `grid` by weekday and hour. */
export interface TokensData { range: DayRange | HourWindow; tool: 'all' | ToolId; summary: UsageSummary; before: UsageSummary; breakdown: UsageBreakdownRow[]; projects: ProjectSummary[]; sessions: SessionSummary[]; hours: number[]; grid?: number[][] }

/** This computer's time zone, for the hours of the day. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PERIODS: Array<{ value: Period; label: string }> = [{ value: '24h', label: '24h' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEEKDAY_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const FULL_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const WEEKDAY_HOUR = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/** Dollars as the mockups write them: cents below $1,000, whole dollars above. Unknown pricing stays unknown. */
const money = (micro: number | null) => micro === null ? '—' : micro >= 1e9 ? `$${formatExact(Math.round(micro / 1e6))}` : formatCost(micro);
/** A length of time as hours and minutes: 6h 42m, 42m, or under a minute. */
const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
/** An hour of the day as a clock reads it: 22 is 22:00, 24 is 00:00. */
const clock = (hour: number) => `${String(hour % 24).padStart(2, '0')}:00`;
/** A range as a key that changes when its span does. */
const rangeKey = (range: DayRange | HourWindow) => 'since' in range ? `${range.since}-${range.until}` : `${range.from}-${range.to}`;
/** What the span is called in sentences: "the last 24 hours", "this month", "Oct 1 – Oct 31". */
const spanPhrase = (period: Period, span: TokensSpan | null) => !span ? 'the last 24 hours' : period === 'all' ? 'all time' : span.title.startsWith('1–') || span.title.includes('day ') ? `this ${period}` : `${shortDay(span.from)} – ${shortDay(span.to)}`;
/** What the span is compared with: the same length just before it. */
const beforePhrase = (range: DayRange | HourWindow) => 'since' in range ? (range.until - range.since <= DAY_MS ? 'the 24 hours before' : `the ${Math.round((range.until - range.since) / HOUR_MS)} hours before`) : comparedWith(range.from, range.to);
const weekend = (day: string) => [0, 6].includes(utc(day).getUTCDay());
/** All input: plain, read from the cache and written to it. Cache hit rate is cache reads over this. */
const inputOf = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite;

/** The tool each model was used with most. */
function mainTools(rows: UsageBreakdownRow[]): Map<string, ToolId> {
  const totals = new Map<string, Map<ToolId, number>>();
  for (const row of rows) {
    const tools = totals.get(row.model) ?? new Map<ToolId, number>();
    tools.set(row.tool, (tools.get(row.tool) ?? 0) + row.tokens);
    totals.set(row.model, tools);
  }
  return new Map([...totals].map(([model, tools]) => [model, [...tools].sort((a, b) => b[1] - a[1])[0]![0]]));
}

// Each further model of one tool is a deeper shade of that tool's hue, so colour still says which tool it ran in.
const SHADES = [100, 62, 40, 26];
/** Colours for model series: their main tool's hue, shaded in series order within each tool; the folded-in rest is grey. */
export function modelColors(series: Array<{ key: string; other?: true }>, toolOf: Map<string, ToolId>): Map<string, string> {
  const seen = new Map<ToolId, number>();
  return new Map(series.map((item) => {
    if (item.other) return [item.key, 'var(--heat-2)'];
    const tool = toolOf.get(item.key) ?? 'cursor';
    const rank = seen.get(tool) ?? 0; seen.set(tool, rank + 1);
    const shade = SHADES[Math.min(rank, SHADES.length - 1)]!;
    return [item.key, shade === 100 ? `var(--tool-${tool})` : `color-mix(in oklab, var(--tool-${tool}) ${shade}%, var(--bg))`];
  }));
}

/** The chart's series over `days`: by tool, or the top five models and the rest; tokens carry their cost for the tooltip. */
export function chartSeries(rows: UsageBreakdownRow[], days: string[], group: Group, metric: Metric): ChartSeries[] {
  const groups = group === 'tools' ? dailyByTool(rows, days) : dailyByModel(rows, days);
  const colors = group === 'models' ? modelColors(groups, mainTools(rows)) : null;
  return groups.map((item) => { const color = colors?.get(item.key) ?? `var(--tool-${item.key})`; return {
    key: item.key,
    label: group === 'tools' ? toolLabel(item.key as ToolId) : item.other ? 'Other' : item.key,
    color, soft: color === 'var(--tool-codex)' || undefined,
    values: metric === 'tokens' ? item.tokens : item.cost,
    costs: metric === 'tokens' ? item.cost : undefined,
  }; });
}

/** Moves the app to another of its pages without reloading it: the router follows history. */
function openPage(path: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
}

/** The Tokens page: your local usage over a week, a month, all time, the last 24 hours or a custom range, stepping back through earlier ones and opening any day. */
export function TokensView({ api, status }: { api: ApiClient; status: LocalStatus | null }) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [period, setPeriodState] = useState<Period>('month');
  const [back, setBack] = useState(0);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [grain, setGrain] = useState<Grain>('day');
  const [tool, setTool] = useState<'all' | ToolId>('all');
  const [drill, setDrill] = useState<string | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [data, setData] = useState<TokensData | null>(null);
  const [year, setYear] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = utcToday();
  const span = period === '24h' ? null : tokensSpan(period, back, today, first, custom);
  // A week can be read hour by hour; the last 24 hours always are.
  const range: DayRange | HourWindow = !span ? last24Hours()
    : grain === 'hour' && period === 'week' && !custom ? { since: Date.parse(`${span.from}T00:00:00Z`), until: Math.min(Date.parse(`${span.to}T00:00:00Z`) + DAY_MS, Math.floor(Date.now() / HOUR_MS) * HOUR_MS + HOUR_MS) }
      : { from: span.from, to: span.to };
  const setPeriod = (next: Period) => { setPeriodState(next); setBack(0); setCustom(null); setGrain(next === 'all' ? 'week' : 'day'); };
  // New data arrives with each scan, refresh cycle and price table.
  const revision = usageRevision(status);
  useEffect(() => {
    let live = true; setError(null);
    const before = 'since' in range ? previousWindow(range) : previousRange(range);
    const breakdown = 'since' in range
      ? api.localHours(range, tool).then(({ items }) => items.map(({ hour, ...row }) => ({ ...row, day: hour })))
      : api.localBreakdown(range, tool).then(({ items }) => items);
    Promise.all([api.localSummary(range, tool), api.localSummary(before, tool), breakdown, api.localProjects(range, tool), api.localSessions(range, tool), api.localSummary(range, tool, ZONE)])
      .then(([summary, before, breakdown, projects, sessions, local]) => { if (live) setData({ range, tool, summary, before, breakdown, projects: projects.items, sessions: sessions.items, hours: local.byHour, grid: local.byWeekdayHour }); })
      .catch((value: unknown) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [api, rangeKey(range), tool, revision]);
  useEffect(() => {
    let live = true;
    api.localSummary({ from: addDays(today, -364), to: today }, tool).then((value) => { if (live) setYear(value); }).catch(() => { if (live) setYear(null); });
    return () => { live = false; };
  }, [api, tool, revision]);
  // The first day used, where all time starts.
  useEffect(() => {
    let live = true;
    api.localSummary({ from: '2015-01-01', to: today }).then((value) => { if (live) setFirst(value.daily.find((day) => day.tokens > 0)?.day ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [api, revision]);
  if (drill) return <DayView api={api} day={drill} tool={tool} back={span?.title.split(' · ')[0] ?? 'Last 24 hours'} onBack={() => setDrill(null)} onStep={(days) => setDrill(addDays(drill, days))} />;
  return <TokensPage data={data} year={year} status={status} range={range} period={period} span={span} metric={metric} tool={tool} grain={grain} custom={custom !== null} error={error}
    onMetric={setMetric} onPeriod={setPeriod} onStep={(delta) => setBack(Math.max(0, back + delta))} onCustom={(value) => { setCustom(value); if (value) { setPeriodState('week'); setGrain('day'); } }} onTool={setTool} onGrain={setGrain}
    onDrill={setDrill} onExport={() => { downloadCsv(api, range, tool).catch((value: unknown) => setError(errorText(value))); }} />;
}

export function TokensPage({ data: loaded, year, status, range, period, span, metric, tool, grain, custom = false, error, onMetric, onPeriod, onStep, onCustom, onTool, onGrain, onDrill, onExport }: {
  data: TokensData | null; year: UsageSummary | null; status: LocalStatus | null; range: DayRange | HourWindow; period: Period; span: TokensSpan | null; metric: Metric; tool: 'all' | ToolId; grain: Grain; custom?: boolean; error: string | null;
  onMetric: (metric: Metric) => void; onPeriod: (period: Period) => void; onStep: (delta: number) => void; onCustom: (range: { from: string; to: string } | null) => void; onTool: (tool: 'all' | ToolId) => void;
  onGrain: (grain: Grain) => void; onDrill: (day: string) => void; onExport: () => void;
}) {
  const { name } = useMachine();
  const [picking, setPicking] = useState(false);
  // A new range or tool takes seconds to load; until it has, the last one's totals would sit under the new labels.
  const data = loaded && rangeKey(loaded.range) === rangeKey(range) && loaded.tool === tool ? loaded : null;
  const tracking = status === null || status.sources.some((source) => source.enabled && source.state !== 'unsupported');
  const yearDays = useMemo(() => year ? fillRange(year.daily, { from: addDays(utcToday(), -364), to: utcToday() }) : null, [year]);
  // The chart's points: the range's days, or its hours.
  const points = useMemo(() => 'since' in range ? hourList(range) : fillRange([], range).map((point) => point.day), [rangeKey(range)]);
  const phrase = `${spanPhrase(period, span)}${tool === 'all' ? '' : ` · ${toolLabel(tool)}`}`;
  return <div className="m-page tk-page">
    <ToolbarActions>
      <Seg label="Period" value={period} options={PERIODS} onChange={onPeriod} />
      <div className="tk-step" role="group" aria-label="Step through periods">
        <button type="button" aria-label="Earlier" disabled={!span?.canBack} onClick={() => onStep(1)}>{ICONS.chevronLeft}</button>
        <b>{span ? span.title.split(' · ')[0] : 'Last 24 hours'}</b>
        <button type="button" aria-label="Later" disabled={!span?.canForward} onClick={() => onStep(-1)}>{ICONS.chevronRight}</button>
      </div>
      <button type="button" className={`m-btn${picking ? ' on' : ''}`} aria-expanded={picking} onClick={() => setPicking(!picking)}>{ICONS.calendar}Custom range</button>
      <label className="tk-select m-btn"><span className="sr-only">Tool</span>
        <select value={tool} onChange={(event) => onTool(event.target.value as 'all' | ToolId)}>
          <option value="all">All tools</option>{TOOLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>{ICONS.chevronDown}</label>
      <button type="button" className="m-btn icon" title="Export CSV" aria-label="Export CSV" onClick={onExport}>{ICONS.download}</button>
    </ToolbarActions>
    {picking && <CustomRange span={span} onApply={(value) => { onCustom(value); setPicking(false); }} onClear={() => { onCustom(null); setPicking(false); }} />}
    {!tracking && <div className="m-card tk-setup">
      <span className="tk-setup-icon">{ICONS.folder}</span>
      <div><b>Tokentracky isn’t reading any tools yet.</b><span>Choose which tools to read in Settings. Only token counts are kept; prompts and code never are.</span></div>
      <a className="m-btn primary" href="/settings" onClick={openPage('/settings')}>Open Settings</a>
    </div>}
    {error && <Notice tone="error">Could not load your usage: {error}</Notice>}
    {!data ? !error && <Loading>Loading your usage…</Loading> : <>
      <div className="tk-span">
        <span><b>{span ? span.title : 'Last 24 hours'}</b> · {'since' in range ? `${WEEKDAY_HOUR.format(range.since)} – ${WEEKDAY_HOUR.format(range.until)} · local time` : 'UTC days'}</span>
        <span className="tk-faint">Compared with {beforePhrase(range)}{status?.lastRefreshAt ? ` · updated ${timeAgo(status.lastRefreshAt)}` : ''}</span>
      </div>
      <ChartCard data={data} year={year} yearDays={yearDays} range={range} points={points} metric={metric} grain={grain} custom={custom} period={period} phrase={phrase} onMetric={onMetric} onGrain={onGrain} onDrill={onDrill} />
      <SectionHead title="Breakdown" note={`Where the tokens went · projects and sessions stay on this ${name}`} />
      <Breakdown data={data} range={range} onExport={onExport} />
      <SectionHead title="When you work" note="Your hours, your days, and how long your sessions run" />
      <WhenYouWork data={data} />
      {!('since' in range) && <>
        <SectionHead title="Models and cost" note="Which models you lean on, and what a token costs you" />
        <ModelsAndCost data={data} points={points} />
      </>}
      <SectionHead title="Cache and token types" note="How much of your input comes from the cache, and what each kind of token costs" />
      <CacheAndTypes data={data} points={points} phrase={phrase} />
      <Insights data={data} year={year} yearDays={yearDays} range={range} span={phrase} previous={beforePhrase(range)} />
      {yearDays && year && <>
        <SectionHead title="Your year" note="Every day you used an AI coding tool" />
        <ActivityGrid days={yearDays} stats={year.activity} label="Last 12 months" />
      </>}
    </>}
  </div>;
}

/** Two days to read between, applied together. */
function CustomRange({ span, onApply, onClear }: { span: TokensSpan | null; onApply: (range: { from: string; to: string }) => void; onClear: () => void }) {
  const today = utcToday();
  const [from, setFrom] = useState(span?.from ?? addDays(today, -29));
  const [to, setTo] = useState(span?.to ?? today);
  const valid = from <= to && to <= today && (utc(to).getTime() - utc(from).getTime()) / DAY_MS < 3660;
  return <div className="m-card tk-custom" role="group" aria-label="Custom range">
    <label>From<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
    <label>To<input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} /></label>
    <button type="button" className="m-btn primary" disabled={!valid} onClick={() => onApply({ from, to })}>Show these days</button>
    <button type="button" className="m-btn" onClick={onClear}>Back to periods</button>
  </div>;
}

function ChartCard({ data, year, yearDays, range, points, metric, grain, custom, period, phrase, onMetric, onGrain, onDrill }: {
  data: TokensData; year: UsageSummary | null; yearDays: Array<{ day: string; tokens: number }> | null; range: DayRange | HourWindow; points: string[]; metric: Metric; grain: Grain; custom: boolean; period: Period; phrase: string;
  onMetric: (metric: Metric) => void; onGrain: (grain: Grain) => void; onDrill: (day: string) => void;
}) {
  const [split, setSplit] = useState<Split>('tools');
  const [mode, setMode] = useState<'stacked' | 'lines'>('stacked');
  const [compare, setCompare] = useState(false);
  const hours = 'since' in range;
  // Projects and token types split days; a split the span can't take falls back to tools.
  const shown: Split = hours && split === 'projects' ? 'tools' : metric === 'cost' && (split === 'projects' || split === 'kinds') ? 'tools' : split;
  const daily = useMemo(() => shown === 'projects' ? projectSeries(data.projects, points, data.breakdown) : shown === 'kinds' ? kindSeries(data.breakdown, points) : chartSeries(data.breakdown, points, shown, metric), [data, points, shown, metric]);
  const byWeek = !hours && grain === 'week';
  const series = byWeek ? daily.map((item) => ({ ...item, values: weekly(points, item.values).values, costs: item.costs && weekly(points, item.costs).values })) : daily;
  const days = byWeek ? weekly(points, points.map(() => 0)).days : points;
  const total = sum(series.flatMap((item) => item.values));
  const format = metric === 'tokens' ? formatCompact : formatCostCompact;
  const { summary, before } = data;
  // The period before, day by day under this one's days, for the dashed comparison.
  const previous = useMemo(() => {
    if (hours || byWeek || !compare) return undefined;
    const prior = fillRange(before.daily, { from: addDays(points[0]!, -points.length), to: addDays(points[0]!, -1) }, (day) => metric === 'tokens' ? day.tokens : day.costMicrousd ?? 0);
    return prior.map((day) => day.tokens);
  }, [hours, byWeek, compare, before, points, metric]);
  const today = utcToday();
  const todayTokens = points.at(-1) === today ? sum(series.map((item) => item.values.at(-1) ?? 0)) : 0;
  const pace = !hours && !byWeek && metric === 'tokens' && todayTokens > 0 ? paceToday(todayTokens) : null;
  const unit = hours ? 'hour' : byWeek ? 'week' : 'day';
  const title = `${metric === 'tokens' ? 'Tokens' : 'Est. cost'} per ${unit}`;
  const change = (now: number | null, then: number | null) => now === null || then === null || (!now && !then) ? undefined : changeVsPrevious(now, then);
  const activeDays = summary.daily.filter((day) => day.tokens > 0).length;
  const grains: Array<{ value: Grain; label: string }> = [...(period === 'week' && !custom ? [{ value: 'hour' as const, label: 'Hour' }] : []), { value: 'day', label: 'Day' }, ...(period !== 'week' ? [{ value: 'week' as const, label: 'Week' }] : [])];
  return <section className="m-card tk-chart-card" aria-label="Usage over time">
    <div className="tk-tiles">
      <Tile label="Tokens" on={metric === 'tokens'} onClick={() => onMetric('tokens')} value={formatCompact(summary.tokens)} title={`${formatExact(summary.tokens)} tokens`} change={change(summary.tokens, before.tokens)} sub={`vs ${formatCompact(before.tokens)}`} />
      <Tile label="Est. cost" on={metric === 'cost'} onClick={() => onMetric('cost')} value={money(summary.costMicrousd)} change={change(summary.costMicrousd, before.costMicrousd)} sub={`vs ${money(before.costMicrousd)}`} />
      <Tile label="Sessions" value={formatExact(summary.sessions)} change={change(summary.sessions, before.sessions)} sub={`across ${formatExact(data.projects.length)} ${data.projects.length === 1 ? 'project' : 'projects'}`} />
      <Tile label={hours ? 'Avg / active hour' : 'Avg / active day'} value={activeDays && !hours ? formatCompact(Math.round(summary.tokens / activeDays)) : hours ? formatCompact(Math.round(summary.tokens / Math.max(1, data.breakdown.filter((row) => row.tokens > 0).map((row) => row.day).filter((day, index, all) => all.indexOf(day) === index).length))) : '—'}
        sub={hours ? 'hours with tokens' : `${formatExact(activeDays)} of ${formatExact(points.length)} days active`} />
      <Tile label="Cache hit rate" value={`${(summary.cacheRate * 100).toFixed(1)}%`} sub={`${formatCompact(summary.breakdown.cacheRead)} of ${formatCompact(inputOf(summary.breakdown))} input`} />
    </div>
    <div className="tk-controls">
      <span className="tk-ctl-k">Split by</span>
      <Seg small label="Split by" value={shown} onChange={setSplit} options={[{ value: 'tools', label: 'Tool' }, { value: 'models', label: 'Model' }, ...(hours || metric === 'cost' ? [] : [{ value: 'projects' as const, label: 'Project' }, { value: 'kinds' as const, label: 'Token type' }])]} />
      {!hours && <Seg small label="Chart style" value={mode} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'lines', label: 'Lines' }]} onChange={setMode} />}
      <span className="tk-push" />
      {period !== '24h' && <><span className="tk-ctl-k">Granularity</span><Seg small label="Granularity" value={hours ? 'hour' : grain} options={grains} onChange={onGrain} /></>}
      {!hours && !byWeek && <label className="tk-toggle"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} /><i aria-hidden="true" />Compare <span className="tk-faint">with {beforePhrase(range)}</span></label>}
    </div>
    <div className="tk-legend-row">
      <b>{title}</b>
      {series.map((item) => { const value = sum(item.values); return value > 0 && <span key={item.key}><i style={{ background: item.color }} />{item.label} <span className="tk-faint">{format(value)} · {formatShare(value, total)}</span></span>; })}
    </div>
    <div className="tk-chart-box">
      {total > 0
        ? <StackedAreaChart days={days} series={series} mode={mode} hours={hours} average={!hours && mode === 'stacked' && days.length > 1 ? total / days.length : undefined} format={format}
          label={`${title} by ${shown === 'tools' ? 'tool' : shown === 'models' ? 'model' : shown === 'projects' ? 'project' : 'token type'}, ${phrase}`}
          previous={previous} shade={!hours && !byWeek && days.length <= 62 ? days.map(weekend) : undefined} pace={pace} onPick={!hours && !byWeek ? (index) => onDrill(days[index]!) : undefined} />
        : <p className="tk-empty">No usage in this range yet.</p>}
    </div>
    {yearDays && !hours && <div className="tk-strip-box"><OverviewStrip days={yearDays} from={range.from} to={range.to} /></div>}
    {year && yearDays && <Bests year={year} yearDays={yearDays} />}
  </section>;
}

/** A total that can switch the chart to it, with its change on the period before. */
function Tile({ label, value, title, change, sub, on, onClick }: { label: string; value: string; title?: string; change?: number | null; sub: ReactNode; on?: boolean; onClick?: () => void }) {
  const body = <><div className="tk-tile-k">{onClick && <i className={on ? 'on' : undefined} aria-hidden="true" />}{label}</div><div className="tk-tile-v" title={title}>{value}</div>
    <div className="tk-tile-s">{change !== undefined && <Delta compact value={change} />} {sub}</div></>;
  return onClick ? <button type="button" className={`tk-tile${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>{body}</button> : <div className="tk-tile">{body}</div>;
}

/** Your records, as three meters: this week against your best week, today against your best day, and your streak against your longest. */
function Bests({ year, yearDays }: { year: UsageSummary; yearDays: Array<{ day: string; tokens: number }> }) {
  const today = utcToday();
  const monday = addDays(today, -((utc(today).getUTCDay() + 6) % 7));
  const thisWeek = sum(yearDays.filter((day) => day.day >= monday).map((day) => day.tokens));
  const best = bestWeek(yearDays);
  const todayTokens = yearDays.at(-1)?.day === today ? yearDays.at(-1)!.tokens : 0;
  const bestDay = year.activity.bestDay;
  const { currentStreak, longestStreak } = year.activity;
  const meter = (share: number, color: string) => <div className="tk-meter" style={{ ['--c' as string]: color }}><i style={{ width: `${Math.min(100, share * 100)}%` }} /></div>;
  return <div className="tk-bests" aria-label="Personal bests">
    <div className="tk-bests-k">{ICONS.star}<span><b>Personal best watch</b>Against your own records</span></div>
    <div><div className="tk-bests-row"><span>This week</span><b>{formatCompact(thisWeek)}{best && <span className="tk-faint"> of {formatCompact(best.tokens)}</span>}</b></div>
      {best && meter(thisWeek / best.tokens, 'var(--text)')}<div className="tk-bests-s">{best ? `best: week of ${shortDay(best.from)}` : 'No weeks yet'}</div></div>
    <div><div className="tk-bests-row"><span>Today</span><b>{formatCompact(todayTokens)}</b></div>
      {bestDay && meter(todayTokens / bestDay.tokens, 'var(--pink-2)')}<div className="tk-bests-s">{bestDay ? `best day ${formatCompact(bestDay.tokens)} on ${shortDay(bestDay.day)}` : 'No days yet'}</div></div>
    <div><div className="tk-bests-row"><span>Streak</span><b>{formatExact(currentStreak)} {currentStreak === 1 ? 'day' : 'days'} <span className="tk-faint">best {formatExact(longestStreak)}</span></b></div>
      {longestStreak > 0 && meter(currentStreak / longestStreak, 'var(--flame, #ff8a3d)')}
      <div className="tk-bests-s">{currentStreak >= longestStreak && currentStreak > 0 ? 'Your best yet' : `${formatExact(Math.max(0, longestStreak - currentStreak + 1))} more days to beat your best`}</div></div>
  </div>;
}

/** Your hours of the week, how long your sessions run, and the longest of them. */
function WhenYouWork({ data }: { data: TokensData }) {
  const grid = data.grid;
  const stats = grid ? weekdayHourStats(grid) : null;
  const lengths = sessionLengths(data.sessions);
  const counted = sum(lengths.map((bucket) => bucket.sessions));
  const peak = Math.max(1, ...(grid ?? []).flat());
  const top = Math.max(1, ...lengths.map((bucket) => bucket.sessions));
  const longest = data.sessions.filter((session) => session.startedAt && session.lastUsedAt)
    .map((session) => ({ session, length: Date.parse(session.lastUsedAt!) - Date.parse(session.startedAt!) })).sort((a, b) => b.length - a.length).slice(0, 5);
  const longestLength = Math.max(1, ...longest.map((item) => item.length));
  const median = (() => {
    const all = data.sessions.filter((session) => session.startedAt && session.lastUsedAt).map((session) => Date.parse(session.lastUsedAt!) - Date.parse(session.startedAt!)).sort((a, b) => a - b);
    return all.length ? all[Math.floor((all.length - 1) / 2)]! : null;
  })();
  const level = (tokens: number) => tokens <= 0 ? 0 : Math.min(5, 1 + Math.floor((tokens / peak) * 5));
  return <div className="tk-work">
    {grid && stats && <section className="m-card tk-heat" aria-label="Hour by weekday">
      <div className="m-card-head"><span className="m-card-title">Hour by weekday</span><span className="tk-faint">Your local time · each square is one hour of the week</span></div>
      <div className="tk-heat-body">
        <div className="tk-heat-grid" role="img" aria-label={`Busiest: ${WEEKDAYS[stats.peak.day]} at ${clock(stats.peak.hour)}`}>
          {grid.map((row, day) => <div key={day} className="tk-heat-row"><span className={day === stats.busiestDay ? 'on' : undefined}>{WEEKDAYS[day]!.slice(0, 3)}</span>
            {row.map((tokens, hour) => <i key={hour} className={`l${level(tokens)}${day === stats.peak.day && hour === stats.peak.hour ? ' peak' : ''}`} title={`${WEEKDAYS[day]} ${clock(hour)}: ${formatCompact(tokens)} tokens`} />)}
            <b style={{ ['--w' as string]: `${(stats.days[day]! / Math.max(1, ...stats.days)) * 100}%` }}><em />{formatCompact(stats.days[day]!)}</b>
          </div>)}
          <div className="tk-heat-hours">{stats.hours.map((tokens, hour) => <i key={hour} className={hour === stats.busiestHour ? 'on' : undefined} style={{ height: `${Math.max(2, (tokens / Math.max(1, ...stats.hours)) * 100)}%` }} />)}</div>
          <div className="tk-heat-axis">{[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => <span key={hour}>{String(hour).padStart(2, '0')}</span>)}</div>
        </div>
      </div>
      <div className="tk-heat-foot">
        <span>Busiest hour <b>{clock(stats.busiestHour)}–{clock(stats.busiestHour + 1)}</b> · {formatShare(stats.hours[stats.busiestHour]!, stats.total)}</span>
        <span>Busiest weekday <b>{WEEKDAYS[stats.busiestDay]}</b> · {formatShare(stats.days[stats.busiestDay]!, stats.total)}</span>
        <span>Hottest hour of the week <b>{WEEKDAYS[stats.peak.day]!.slice(0, 3)} {clock(stats.peak.hour)}</b> · {formatCompact(stats.peak.tokens)}</span>
        <span>Weekends <b>{formatShare(stats.weekend, stats.total)}</b></span>
        <span>After 20:00 <b>{formatShare(sum(stats.hours.slice(20)), stats.total)}</b></span>
      </div>
    </section>}
    <section className="m-card tk-lengths" aria-label="Session length">
      <div className="m-card-head"><span className="m-card-title">Session length</span><span className="tk-faint">{formatExact(counted)} {counted === 1 ? 'session' : 'sessions'}{median !== null && ` · median ${duration(median)}`}</span></div>
      <div className="tk-len-bars">{lengths.map((bucket) => <div key={bucket.label}>
        <span className="tk-len-n">{bucket.sessions ? formatExact(bucket.sessions) : ''}</span>
        <i style={{ height: `${Math.max(2, (bucket.sessions / top) * 100)}%` }} className={bucket.label.startsWith('1–') || bucket.label.startsWith('2–') ? 'long' : undefined} />
        <span className="tk-len-k">{bucket.label}</span><span className="tk-len-s">{formatShare(bucket.tokens, Math.max(1, data.summary.tokens))}</span>
      </div>)}</div>
      <p className="tk-len-note">Length runs from a session’s first request to its last. The second row is each length’s share of tokens.</p>
    </section>
    <section className="m-card tk-longest" aria-label="Longest sessions">
      <div className="m-card-head"><span className="m-card-title">Longest sessions</span><span className="tk-faint">{data.sessions.length} in this span</span></div>
      {longest.length ? <ul>{longest.map(({ session, length }) => <li key={session.id ?? `${session.startedAt}${session.project}`}>
        <ToolIcon id={session.tool} />
        <span className="tk-ls-who"><b>{projectName(session.project)}</b><small className="mono">{session.model} · {WEEKDAY_DAY.format(new Date(session.startedAt!))}</small></span>
        <span className="tk-ls-bar"><i style={{ width: `${(length / longestLength) * 100}%` }} /></span>
        <span className="tk-ls-len">{duration(length)}</span>
        <span className="tk-ls-tok"><b>{formatCompact(session.tokens)}</b><small>{money(session.costMicrousd ?? null)}</small></span>
      </li>)}</ul> : <p className="tk-empty">No sessions in this span.</p>}
    </section>
  </div>;
}

/** Which models carry each day, and what a million tokens cost, day by day and by tool. */
function ModelsAndCost({ data, points }: { data: TokensData; points: string[] }) {
  const mix = useMemo(() => modelMix(data.breakdown, points), [data.breakdown, points]);
  const colors = useMemo(() => modelColors(mix.map((item) => ({ key: item.key, ...(item.key === 'other' ? { other: true as const } : {}) })), mainTools(data.breakdown)), [mix, data.breakdown]);
  const series: ChartSeries[] = mix.map((item) => ({ key: item.key, label: item.label, color: colors.get(item.key) ?? 'var(--heat-2)', values: item.values.map((share) => share * 100) }));
  const rates = costPerMillion(data.summary.daily, points);
  // Quiet days carry the last known rate on, so the line doesn't drop to nothing.
  let last = 0;
  const carried = rates.map((rate) => (last = rate ?? last));
  const total = data.summary.costMicrousd && data.summary.tokens ? data.summary.costMicrousd / data.summary.tokens : null;
  const before = data.before.costMicrousd && data.before.tokens ? data.before.costMicrousd / data.before.tokens : null;
  const tools = data.summary.byTool.filter((item) => item.tokens > 0 && item.costMicrousd !== null).sort((a, b) => b.tokens - a.tokens);
  const topRate = Math.max(0.01, ...tools.map((item) => item.costMicrousd! / item.tokens));
  return <div className="tk-row-2 tk-even">
    <section className="m-card" aria-label="Model mix">
      <div className="m-card-head"><span className="m-card-title">Model mix</span><span className="tk-faint">Share of tokens per day</span></div>
      {series.length ? <StackedAreaChart days={points} series={series} mode="stacked" format={(value) => `${Math.round(value)}%`} label="Each day's share of tokens by model" small best={false} /> : <p className="tk-empty">No models in this span.</p>}
      <div className="tk-mix-legend">{data.summary.byModel.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 6).map((item) => {
        const was = data.before.byModel.find((entry) => entry.model === item.model)?.tokens ?? 0;
        const pts = (item.tokens / Math.max(1, data.summary.tokens) - was / Math.max(1, data.before.tokens)) * 100;
        return <span key={item.model}><i style={{ background: colors.get(item.model) ?? 'var(--heat-2)' }} /><span className="mono">{item.model}</span><b>{formatShare(item.tokens, data.summary.tokens)}</b><em className={pts >= 0 ? 'up' : 'down'}>{pts >= 0 ? '+' : '−'}{Math.abs(pts).toFixed(1)}</em></span>;
      })}</div>
    </section>
    <section className="m-card" aria-label="Cost per million tokens">
      <div className="m-card-head"><span className="m-card-title">Cost per 1M tokens</span><span className="tk-faint">Est. cost ÷ tokens, per day</span></div>
      <div className="tk-rate"><b>{total === null ? '—' : `$${total.toFixed(2)}`}</b>{total !== null && before !== null && <span className={total <= before ? 'up' : 'down'}>{total <= before ? '▼' : '▲'} {formatShare(Math.abs(total - before), before)} vs ${before.toFixed(2)} before</span>}</div>
      {rates.some((rate) => rate !== null) ? <StackedAreaChart days={points} series={[{ key: 'rate', label: 'Per 1M tokens', color: 'var(--text-2)', values: carried }]} mode="lines" format={(value) => `$${value.toFixed(2)}`} label="Estimated dollars per million tokens, per day" small best={false} /> : <p className="tk-empty">No priced days in this span.</p>}
      <div className="tk-rates">{tools.map((item) => { const rate = item.costMicrousd! / item.tokens; return <div key={item.tool}>
        <span><ToolIcon id={item.tool} />{toolLabel(item.tool)}</span><span className="tk-share"><i style={{ width: `${(rate / topRate) * 100}%`, background: `var(--tool-${item.tool})` }} /></span><b>${rate.toFixed(2)}</b>
      </div>; })}</div>
    </section>
  </div>;
}

/** How much input the cache serves, day by day and by tool, and the totals and cost by kind of token. */
function CacheAndTypes({ data, points, phrase }: { data: TokensData; points: string[]; phrase: string }) {
  const hours = 'since' in data.range;
  const daily = hours ? [] : cachePerDay(data.breakdown, points);
  let last = 0;
  const carried = daily.map((rate) => (last = rate ?? last) * 100);
  const rate = data.summary.cacheRate * 100, before = data.before.cacheRate * 100;
  const tools = data.summary.byTool.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  return <>
    <div className="tk-row-2">
      <section className="m-card" aria-label="Cache efficiency">
        <div className="m-card-head"><span className="m-card-title">Cache efficiency</span><span className="tk-faint">Cache reads ÷ all input</span></div>
        <div className="tk-rate"><b>{rate.toFixed(1)}%</b><span className={rate >= before ? 'up' : 'down'}>{rate >= before ? '▲' : '▼'} {Math.abs(rate - before).toFixed(1)} pts vs before</span>
          {data.summary.costParts && <span className="tk-save"><b>{money(data.summary.costParts.cacheSavings)}</b> saved by the cache</span>}</div>
        {!hours && daily.some((value) => value !== null) && <StackedAreaChart days={points} series={[{ key: 'cache', label: 'Cache hit rate', color: 'var(--kind-cache-read)', values: carried }]} mode="lines" format={(value) => `${Math.round(value)}%`} label="Cache hit rate per day" small best={false} />}
        <div className="tk-rates">{tools.map((item) => { const share = item.breakdown.cacheRead / Math.max(1, inputOf(item.breakdown)); return <div key={item.tool}>
          <span><ToolIcon id={item.tool} />{toolLabel(item.tool)}</span><span className="tk-share"><i style={{ width: `${share * 100}%`, background: `var(--tool-${item.tool})` }} /></span><b>{(share * 100).toFixed(1)}%</b>
        </div>; })}</div>
      </section>
      <CostByType summary={data.summary} />
    </div>
    <Totals summary={data.summary} period={phrase} />
  </>;
}

/** One day opened from the chart: its totals, its hours by tool and its sessions, with the days either side a step away. */
function DayView({ api, day, tool, back, onBack, onStep }: { api: ApiClient; day: string; tool: 'all' | ToolId; back: string; onBack: () => void; onStep: (days: number) => void }) {
  const [state, setState] = useState<{ day: string; summary: UsageSummary; hours: UsageBreakdownRow[]; sessions: SessionSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const window = { since: Date.parse(`${day}T00:00:00Z`), until: Date.parse(`${day}T00:00:00Z`) + DAY_MS };
  useEffect(() => {
    let live = true; setError(null);
    Promise.all([api.localSummary({ from: day, to: day }, tool), api.localHours(window, tool), api.localSessions({ from: day, to: day }, tool)])
      .then(([summary, hours, sessions]) => { if (live) setState({ day, summary, hours: hours.items.map(({ hour, ...row }) => ({ ...row, day: hour })), sessions: sessions.items }); })
      .catch((value: unknown) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [api, day, tool]);
  // Esc goes back to the period, as the header says.
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onBack(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onBack]);
  const today = utcToday();
  const loaded = state?.day === day ? state : null;
  const points = hourList(window);
  // Within the day: a session that began the day before counts from midnight.
  const clamp = (at: number) => Math.max(window.since, Math.min(window.until, at));
  const series = loaded ? chartSeries(loaded.hours, points, 'tools', 'tokens') : [];
  const busiest = loaded ? points.map((hour) => sum(loaded.hours.filter((row) => row.day === hour).map((row) => row.tokens))) : [];
  const peak = busiest.indexOf(Math.max(0, ...busiest));
  const timed = loaded?.sessions.filter((session) => session.startedAt && session.lastUsedAt) ?? [];
  const first = timed.length ? clamp(Math.min(...timed.map((session) => Date.parse(session.startedAt!)))) : null;
  const lastAt = timed.length ? clamp(Math.max(...timed.map((session) => Date.parse(session.lastUsedAt!)))) : null;
  return <div className="m-page tk-page">
    <ToolbarActions>
      <button type="button" className="m-btn" onClick={onBack}>{ICONS.chevronLeft}{back}</button>
      <div className="tk-step" role="group" aria-label="Step through days">
        <button type="button" aria-label="The day before" onClick={() => onStep(-1)}>{ICONS.chevronLeft}</button>
        <b>{shortDay(day)}</b>
        <button type="button" aria-label="The day after" disabled={day >= today} onClick={() => onStep(1)}>{ICONS.chevronRight}</button>
      </div>
    </ToolbarActions>
    <div className="tk-day-head"><h1>{FULL_DAY.format(utc(day))}</h1><span className="tk-faint">UTC day · Esc or the button goes back to {back}</span></div>
    {error && <Notice tone="error">Could not load the day: {error}</Notice>}
    {!loaded ? !error && <Loading>Loading the day…</Loading> : <>
      <div className="tk-tiles">
        <Tile label="Tokens" value={formatCompact(loaded.summary.tokens)} title={`${formatExact(loaded.summary.tokens)} tokens`} sub="this day" />
        <Tile label="Est. cost" value={money(loaded.summary.costMicrousd)} sub={loaded.summary.costMicrousd && loaded.summary.tokens ? `$${(loaded.summary.costMicrousd / loaded.summary.tokens).toFixed(2)} per 1M tokens` : 'API-price estimate'} />
        <Tile label="Sessions" value={formatExact(loaded.summary.sessions)} sub={`across ${new Set(loaded.sessions.map((session) => session.project)).size} projects`} />
        <Tile label="Busiest hour" value={busiest[peak] ? `${TIME.format(new Date(points[peak]!))}` : '—'} sub={busiest[peak] ? `${formatCompact(busiest[peak]!)} · ${formatShare(busiest[peak]!, loaded.summary.tokens)} of the day` : 'no usage'} />
        <Tile label="Active span" value={first !== null && lastAt !== null ? duration(lastAt - first) : '—'} sub={first !== null && lastAt !== null ? `${TIME.format(first)} → ${TIME.format(lastAt)}` : 'no sessions'} />
        <Tile label="Cache hit rate" value={`${(loaded.summary.cacheRate * 100).toFixed(1)}%`} sub={`${formatCompact(loaded.summary.breakdown.cacheRead)} of ${formatCompact(inputOf(loaded.summary.breakdown))} input`} />
      </div>
      <section className="m-card tk-chart-card" aria-label="By hour">
        <div className="tk-legend-row"><b>By hour</b>{series.map((item) => { const value = sum(item.values); return value > 0 && <span key={item.key}><i style={{ background: item.color }} />{item.label} <span className="tk-faint">{formatCompact(value)} · {formatShare(value, loaded.summary.tokens)}</span></span>; })}</div>
        <div className="tk-chart-box">{loaded.summary.tokens > 0 ? <StackedAreaChart days={points} series={series} mode="stacked" hours format={formatCompact} label={`Tokens per hour by tool, ${shortDay(day)}`} /> : <p className="tk-empty">No usage on this day.</p>}</div>
      </section>
      <section className="m-card tk-day-sessions" aria-label="Sessions">
        <div className="m-card-head"><span className="m-card-title">Sessions on {shortDay(day)}</span><span className="tk-faint">{loaded.sessions.length} {loaded.sessions.length === 1 ? 'session' : 'sessions'} · sorted by start</span></div>
        <table className="m-table tk-table">
          <thead><tr><th className="l">Time</th><th className="l">Across the day</th><th className="l">Project</th><th className="l">Tool · model</th><th>Length</th><th>Of day</th><th>Est. cost</th><th>Tokens</th></tr></thead>
          <tbody>{[...timed].sort((a, b) => a.startedAt!.localeCompare(b.startedAt!)).map((session) => {
            const start = Date.parse(session.startedAt!), end = Date.parse(session.lastUsedAt!);
            const from = clamp(start), to = clamp(end);
            return <tr key={session.id ?? `${session.startedAt}${session.project}`}>
              <td className="l">{TIME.format(start)}–{TIME.format(end)}</td>
              <td className="l"><span className="tk-dayline"><i style={{ left: `${((from - window.since) / DAY_MS) * 100}%`, width: `${Math.max(1, ((to - from) / DAY_MS) * 100)}%` }} /></span></td>
              <td className="l"><span className="tk-project">{projectName(session.project)}</span></td>
              <td className="l"><span className="tk-model-name"><ToolIcon id={session.tool} /><span className="mono">{session.model}</span></span></td>
              <td>{duration(end - start)}</td><td>{formatShare(session.tokens, loaded.summary.tokens)}</td><td>{money(session.costMicrousd ?? null)}</td><td className="tk-tok">{formatCompact(session.tokens)}</td>
            </tr>;
          })}</tbody>
        </table>
      </section>
    </>}
  </div>;
}

function Seg<T extends string | number>({ label, value, options, onChange, small }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; small?: boolean }) {
  return <div className={`m-seg${small ? ' tk-seg-sm' : ''}`} role="group" aria-label={label}>
    {options.map((option) => <button key={String(option.value)} type="button" className={option.value === value ? 'on' : undefined} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function SectionHead({ title, note }: { title: string; note: string }) {
  return <div className="tk-section-head"><h2>{title}</h2><p>{note}</p></div>;
}

function Delta({ value, compact }: { value: number | null; compact?: boolean }) {
  if (value === null) return <span className={`tk-delta flat${compact ? ' sm' : ''}`}>New</span>;
  const size = Math.abs(value);
  const shown = size < 10 ? size.toFixed(1).replace(/\.0$/, '') : formatExact(Math.round(size));
  const tone = Math.round(size * 10) === 0 ? ' flat' : value < 0 ? ' neg' : '';
  // The pill carries an arrow; the compact form is signed text.
  if (compact) return <span className={`tk-delta sm${tone}`}>{tone === ' flat' ? '±' : value < 0 ? '−' : '+'}{shown}%</span>;
  return <span className={`tk-delta${tone}`} aria-label={`${value < 0 ? 'Down' : 'Up'} ${shown}%`}>{tone === ' flat' ? null : value < 0 ? ICONS.arrowDown : ICONS.arrowUp}{shown}%</span>;
}

function Total({ label, value, title, sub, up }: { label: string; value: string; title?: string; sub: string; up?: boolean }) {
  return <div><div className="m-label">{label}</div><div className={`m-stat-value${up ? ' tk-up' : ''}`} title={title}>{value}</div><div className="tk-t-sub">{sub}</div></div>;
}

/** The period's tokens by kind. Cache reads are the cached input; plain input and cache writes are the uncached rest. Reasoning is counted inside output, never added again. */
export function Totals({ summary, period }: { summary: UsageSummary; period: string }) {
  const { input, output, cacheRead, cacheWrite, reasoning = 0 } = summary.breakdown;
  const all = inputOf(summary.breakdown);
  const exact = (tokens: number) => `${formatExact(tokens)} tokens`;
  return <section className="m-card" aria-label="Totals">
    <div className="m-card-head"><span className="m-card-title">Totals</span><span className="tk-right">{period[0]!.toUpperCase() + period.slice(1)}</span></div>
    <div className="tk-totals">
      <Total label="Processed tokens" value={formatCompact(summary.tokens)} title={exact(summary.tokens)} sub="input, cache and output" />
      <Total label="Cached input" value={formatCompact(cacheRead)} title={exact(cacheRead)} sub={`${formatShare(cacheRead, all)} of input`} />
      <Total label="Uncached input" value={formatCompact(input + cacheWrite)} title={exact(input + cacheWrite)} sub={`${formatShare(input + cacheWrite, all)} of input`} />
      <Total label="Output" value={formatCompact(output)} title={exact(output)} sub={`${formatShare(output, summary.tokens)} of tokens`} />
      <Total label="Reasoning" value={formatCompact(reasoning)} title={exact(reasoning)} sub="counted inside output" />
      <Total label="Cache savings" value={summary.costParts ? money(summary.costParts.cacheSavings) : '—'} sub={summary.costParts ? 'vs uncached pricing' : 'pricing unknown'} up={!!summary.costParts} />
    </div>
  </section>;
}

const COST_KINDS = [{ key: 'input', label: 'Input', color: 'var(--kind-input)' }, { key: 'cacheRead', label: 'Cache read', color: 'var(--kind-cache-read)' }, { key: 'cacheWrite', label: 'Cache write', color: 'var(--kind-cache-write)' }, { key: 'output', label: 'Output', color: 'var(--kind-output)' }] as const;

/** The estimated cost split by token kind; unknown when a model in the period has no price. */
export function CostByType({ summary }: { summary: UsageSummary }) {
  const parts = summary.costParts, cost = summary.costMicrousd;
  const models = summary.byModel.filter((model) => model.tokens > 0).length;
  return <section className="m-card" aria-label="Cost by type">
    <div className="m-card-head"><span className="m-card-title">Cost by type</span><span className="tk-right">API-price estimate</span></div>
    <div className="m-card-body">{parts && cost ? <>
      <div className="tk-cost-total"><span className="m-stat-value" title={formatCost(cost)}>{money(cost)}</span><span className="tk-faint">across {models} {models === 1 ? 'model' : 'models'}</span></div>
      <div className="tk-costbar" role="img" aria-label={COST_KINDS.map((kind) => `${kind.label} ${formatShare(parts[kind.key], cost)}`).join(', ')}>
        {COST_KINDS.filter((kind) => parts[kind.key] > 0).map((kind) => <span key={kind.key} style={{ flex: parts[kind.key], background: kind.color }} />)}
      </div>
      <div className="tk-cost-rows">{COST_KINDS.map((kind) => <div key={kind.key}>
        <i style={{ background: kind.color }} /><span>{kind.label}</span><span>{formatShare(parts[kind.key], cost)}</span><b title={formatCost(parts[kind.key])}>{money(parts[kind.key])}</b>
      </div>)}</div>
    </> : <p className="tk-cost-unknown">Cost by type is unknown: a model in this period has no known price.</p>}</div>
  </section>;
}

function Insight({ icon, label, value, mono, sub, children }: { icon: ReactNode; label: string; value: ReactNode; mono?: boolean; sub: ReactNode; children?: ReactNode }) {
  return <div className="m-card tk-ins">
    <div className="tk-ins-label">{icon}{label}</div>
    <div className={`tk-ins-value${mono ? ' m' : ''}`}>{value}</div>
    <div className="tk-ins-sub">{sub}</div>
    {children && <div className="tk-ins-foot">{children}</div>}
  </div>;
}

function Meter({ share, color, caption }: { share: number; color: string; caption?: [ReactNode, ReactNode] }) {
  return <><div className="tk-meter" style={{ ['--c' as string]: color }}><i style={{ width: `${Math.min(100, share * 100)}%` }} /></div>
    {caption && <div className="tk-meter-cap"><span>{caption[0]}</span><span>{caption[1]}</span></div>}</>;
}

function Insights({ data, year, yearDays, range, span, previous }: { data: TokensData; year: UsageSummary | null; yearDays: Array<{ day: string; tokens: number }> | null; range: DayRange | HourWindow; span: string; previous: string }) {
  const { summary, before, breakdown, projects, sessions } = data;
  const toolOf = useMemo(() => mainTools(breakdown), [breakdown]);
  const favourite = favouriteModel(summary.byModel);
  const weekday = yearDays ? busiestWeekdayUtc(yearDays) : null;
  const hour = busiestHour(data.hours);
  const peak = Math.max(1, ...data.hours);
  // The most expensive day is one of the range's days; the last 24 hours have none whole.
  const daySpan = 'since' in range ? null : range;
  const expensive = mostExpensiveDay(summary.daily);
  const expensiveTools = expensive ? costGroups(breakdown.filter((row) => row.day === expensive.day), (row) => row.tool) : [];
  const project = [...projects].sort((a, b) => b.tokens - a.tokens)[0];
  const session = longestSession(sessions);
  const trending = trendingModel(summary.byModel, before.byModel);
  const streak = year?.activity;
  const glyph = (model: string) => { const tool = toolOf.get(model); return tool ? <ToolIcon id={tool} /> : null; };
  return <>
    <SectionHead title="Insights" note={`From your local records · ${span} unless noted`} />
    <div className="tk-insights">
      <Insight icon={ICONS.star} label="Favourite model" mono value={favourite ? <span className="tk-model">{glyph(favourite.model)}{favourite.model}</span> : '—'}
        sub={favourite ? `${formatShare(favourite.tokens, summary.tokens)} of tokens · ${formatCompact(favourite.tokens)}` : 'No usage in this range yet'}>
        {favourite && <Meter share={favourite.share} color={`var(--tool-${toolOf.get(favourite.model) ?? 'cursor'})`} caption={[`${summary.byModel.filter((item) => item.tokens > 0).length} models used`, span]} />}
      </Insight>
      <Insight icon={ICONS.clock} label="Busiest hour" value={hour ? `${clock(hour.hour)} – ${clock(hour.hour + 1)}` : '—'}
        sub={hour ? `${formatShare(hour.share, 1)} of tokens · your local time` : 'No usage in this range yet'}>
        {hour && <>
          <div className="tk-mini-bars tk-hours" aria-hidden="true">{data.hours.map((tokens, index) => <span key={index} className={index === hour.hour ? 'hi' : undefined} style={{ height: `${Math.max(4, (tokens / peak) * 100)}%` }} />)}</div>
          <div className="tk-mini-axis tk-hours-axis" aria-hidden="true">{['00', '06', '12', '18'].map((label) => <span key={label}>{label}</span>)}</div>
        </>}
      </Insight>
      <Insight icon={ICONS.calendar} label="Busiest weekday · UTC" value={weekday ? WEEKDAYS[weekday.weekday] : '—'}
        sub={weekday ? `${formatCompact(weekday.averages[weekday.weekday]!)} avg · ${weekday.ratio.toFixed(1)}× a typical day` : 'Not enough history yet'}>
        {weekday && <>
          <div className="tk-mini-bars" aria-hidden="true">{weekday.averages.map((average, index) => <span key={index} className={index === weekday.weekday ? 'hi' : undefined} style={{ height: `${Math.max(4, (average / Math.max(...weekday.averages)) * 100)}%` }} />)}</div>
          <div className="tk-mini-axis" aria-hidden="true">{WEEKDAYS.map((name, index) => <span key={name} className={index === weekday.weekday ? 'on' : undefined}>{name[0]}</span>)}</div>
        </>}
      </Insight>
      <Insight icon={ICONS.flame} label="Longest streak" value={streak ? `${formatExact(streak.longestStreak)} ${streak.longestStreak === 1 ? 'day' : 'days'}` : '—'} sub="Last 12 months · UTC days">
        {streak && streak.longestStreak > 0 && <Meter share={streak.currentStreak / streak.longestStreak} color="var(--text)"
          caption={[`Current: ${formatExact(streak.currentStreak)} ${streak.currentStreak === 1 ? 'day' : 'days'}`, streak.currentStreak >= streak.longestStreak ? 'Your best yet' : `${formatExact(streak.longestStreak - streak.currentStreak)} to beat it`]} />}
      </Insight>
      {daySpan && <Insight icon={ICONS.dollar} label="Most expensive day" value={expensive ? money(expensive.costMicrousd) : '—'}
        sub={expensive ? `${WEEKDAY_DAY.format(utc(expensive.day))} · ${formatCompact(expensive.tokens)} tokens` : 'No priced usage in this range'}>
        {expensive && expensiveTools.length > 0 && <>
          <div className="m-bar" aria-hidden="true">{expensiveTools.filter((item) => item.cost > 0).map((item) => <span key={item.key} style={{ ['--c' as string]: `var(--tool-${item.key})`, flex: item.cost }} />)}</div>
          <div className="tk-meter-cap"><span>{formatShare(expensiveTools[0]!.cost, expensive.costMicrousd)} of cost in {toolLabel(expensiveTools[0]!.key as ToolId)}</span>
            {summary.costMicrousd ? <span>{(expensive.costMicrousd / (summary.costMicrousd / fillRange([], daySpan).length)).toFixed(1)}× daily avg</span> : null}</div>
        </>}
      </Insight>}
      <Insight icon={ICONS.folder} label="Top project" mono value={project ? <span title={project.name}>{projectName(project.name)}</span> : '—'}
        sub={project ? `${formatCompact(project.tokens)} tokens · ${formatShare(project.tokens, summary.tokens)} of period` : 'No projects in this range'}>
        <span className="tk-lock">{ICONS.lock}Local only — never uploaded</span>
      </Insight>
      <Insight icon={ICONS.stack} label="Longest session" value={session ? <span title="From the quarter hour of its first event to its last">{duration(session.length)}</span> : '—'}
        sub={session ? `${formatCompact(session.tokens)} tokens · ${WEEKDAY_DAY.format(new Date(session.lastUsedAt!))}` : 'No sessions in this range'}>
        {session && <span className="m-pill"><ToolIcon id={session.tool} />{session.model} in {toolLabel(session.tool)}</span>}
      </Insight>
      <Insight icon={ICONS.trending} label="Trending model" mono value={trending ? <span className="tk-model">{glyph(trending.model)}{trending.model}</span> : '—'}
        sub={trending ? <><span className="tk-up">+{trending.gain.toFixed(1)} pts</span> share vs {previous}</> : 'No model gained share'}>
        {trending && <>
          <div className="tk-compare"><span>Before</span><Meter share={trending.previousShare / Math.max(trending.share, trending.previousShare)} color="var(--heat-2)" /><b>{(trending.previousShare * 100).toFixed(1)}%</b></div>
          <div className="tk-compare"><span>Now</span><Meter share={trending.share / Math.max(trending.share, trending.previousShare)} color={`var(--tool-${toolOf.get(trending.model) ?? 'cursor'})`} /><b>{(trending.share * 100).toFixed(1)}%</b></div>
        </>}
      </Insight>
    </div>
  </>;
}

type Tab = 'model' | 'tool' | 'day' | 'project';
function Breakdown({ data, range, onExport }: { data: TokensData; range: DayRange | HourWindow; onExport: () => void }) {
  const [tab, setTab] = useState<Tab>('model');
  const { summary, breakdown, projects } = data;
  const toolOf = useMemo(() => mainTools(breakdown), [breakdown]);
  const byTokens = <T extends { tokens: number }>(items: T[]) => [...items].sort((a, b) => b.tokens - a.tokens).filter((item) => item.tokens > 0);
  const models = byTokens(costGroups(breakdown, (row) => row.model));
  const kinds = useMemo(() => {
    const totals = new Map<string, TokenCounts>();
    for (const row of breakdown) {
      const sum = totals.get(row.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      totals.set(row.model, { input: sum.input + row.breakdown.input, output: sum.output + row.breakdown.output, cacheRead: sum.cacheRead + row.breakdown.cacheRead, cacheWrite: sum.cacheWrite + row.breakdown.cacheWrite });
    }
    return totals;
  }, [breakdown]);
  const kind = (tokens: number) => <td title={`${formatExact(tokens)} tokens`}>{formatCompact(tokens)}</td>;
  const sessions = new Map(summary.byModel.map((item) => [item.model, item.sessions]));
  const tools = byTokens(costGroups(breakdown, (row) => row.tool));
  const days = [...summary.daily].filter((point) => point.tokens > 0).sort((a, b) => b.day.localeCompare(a.day));
  const projectRows = byTokens(projects);
  const total = summary.tokens;
  const top = Math.max(1, ...models.map((item) => item.tokens));
  const cost = (group: { tokens: number; unpriced: number; cost: number }) => group.tokens > group.unpriced ? money(group.cost) : <span className="zero" title="No known price">—</span>;
  const tail = (tokens: number) => <><td className="tk-muted">{formatShare(tokens, total)}</td><td className="tk-tok" title={`${formatExact(tokens)} tokens`}>{formatCompact(tokens)}</td></>;
  const counts: Record<Tab, string> = {
    model: `${models.length} ${models.length === 1 ? 'model' : 'models'} this period`, tool: `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} this period`,
    day: `${days.length} active ${days.length === 1 ? 'day' : 'days'}`, project: `${projectRows.length} ${projectRows.length === 1 ? 'project' : 'projects'} · never uploaded`,
  };
  // The last 24 hours span parts of two UTC days, so they have no Day tab.
  const tabs = ([{ value: 'model', label: 'Model' }, { value: 'tool', label: 'Tool' }, { value: 'day', label: 'Day' }, { value: 'project', label: 'Project' }] as Array<{ value: Tab; label: string }>)
    .filter((option) => option.value !== 'day' || !('since' in range));
  return <section className="m-card tk-breakdown" aria-label="Breakdown">
    <div className="m-card-head">
      <span className="m-card-title">Breakdown</span>
      <span className="tk-faint">{'since' in range ? 'Last 24 hours' : `${shortDay(range.from)} – ${shortDay(range.to)}`}</span>
      <div className="tk-push"><Seg small label="Break down by" value={tab} options={tabs} onChange={setTab} /></div>
    </div>
    <table className="m-table tk-table">
      {/* Input is plain input and cache writes; Cached is cache reads. */}
      {tab === 'model' && <>
        <thead><tr><th className="l">#</th><th className="l">Model</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cached</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead>
        <tbody>{models.map((item, index) => { const tool = toolOf.get(item.key); return <tr key={item.key}>
          <td className="l tk-rank">{index + 1}</td>
          <td className="l"><div className="tk-model-cell"><span className="tk-model-name">{tool && <ToolIcon id={tool} />}{item.key}</span><span className="tk-uline" style={{ ['--c' as string]: `var(--tool-${tool ?? 'cursor'})`, width: `${(item.tokens / top) * 72}%` }} /></div></td>
          <td>{formatExact(sessions.get(item.key) ?? 0)}</td>{kind(kinds.get(item.key)!.input + kinds.get(item.key)!.cacheWrite)}{kind(kinds.get(item.key)!.output)}{kind(kinds.get(item.key)!.cacheRead)}
          <td>{cost(item)}</td>{tail(item.tokens)}
        </tr>; })}</tbody>
      </>}
      {tab === 'tool' && <>
        <thead><tr><th className="l">#</th><th className="l">Tool</th><th>Models</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead>
        <tbody>{tools.map((item, index) => <tr key={item.key}>
          <td className="l tk-rank">{index + 1}</td>
          <td className="l"><span className="tk-model-name tk-sans"><ToolIcon id={item.key as ToolId} />{toolLabel(item.key as ToolId)}</span></td>
          <td>{new Set(breakdown.filter((row) => row.tool === item.key && row.tokens > 0).map((row) => row.model)).size}</td>
          <td>{cost(item)}</td>{tail(item.tokens)}
        </tr>)}</tbody>
      </>}
      {tab === 'day' && <>
        <thead><tr><th className="l">Day · UTC</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead>
        <tbody>{days.map((point) => <tr key={point.day}><td className="l">{WEEKDAY_DAY.format(utc(point.day))}</td><td>{money(point.costMicrousd)}</td>{tail(point.tokens)}</tr>)}</tbody>
      </>}
      {tab === 'project' && <>
        <thead><tr><th className="l">#</th><th className="l">Project</th><th>Sessions</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead>
        <tbody>{projectRows.map((item, index) => <tr key={item.name}>
          <td className="l tk-rank">{index + 1}</td>
          <td className="l" title={item.name}><span className="tk-project">{projectName(item.name)}</span>{item.repository && <small className="tk-faint"> {item.repository}</small>}</td>
          <td>{formatExact(item.sessions)}</td><td>{money(item.costMicrousd)}</td>{tail(item.tokens)}
        </tr>)}</tbody>
      </>}
    </table>
    <div className="tk-table-foot"><span>{counts[tab]}</span><button type="button" className="tk-link" onClick={onExport}>Export CSV</button></div>
  </section>;
}
