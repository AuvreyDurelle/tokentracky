import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { MenuOverview, ProjectSummary, SessionSummary, ToolId, UsageBreakdownRow, UsageSummary } from '@tokentracky/core';
import type { ApiClient, LocalStatus } from '../api';
import { TOOLS, errorText, formatCompact, formatCost, formatCostCompact, formatExact, formatShare, shortDay, timeAgo, toolLabel } from '../format';
import { costGroups } from '../Insights';
import { dayRange, fillRange, hourList, last24Hours, previousRange, previousWindow, rangeLabel, utcToday, type DayRange, type HourWindow } from '../ranges';
import { usageRevision } from '../refresh';
import { Loading, Notice, ToolIcon } from '../ui';
import { TokenTypes, downloadCsv } from '../You';
import { ActivityGrid } from './ActivityGrid';
import { monotonePath } from './chart';
import { ICONS } from './icons';
import { biggestSession, busiestWeekdayUtc, changeVsPrevious, dailyByModel, dailyByTool, favouriteModel, mostExpensiveDay, trendingModel } from './insights';
import { OverviewStrip, StackedAreaChart, type ChartSeries } from './StackedAreaChart';
import './personal.css';

type Days = '24h' | 7 | 30 | 90 | 365;
type Metric = 'tokens' | 'cost';
type Group = 'tools' | 'models';
/** A period's usage, with the range and tool it was loaded for. Over the last 24 hours `breakdown` is by hour: each row's `day` is its hour's first instant. */
export interface TokensData { range: DayRange | HourWindow; tool: 'all' | ToolId; summary: UsageSummary; before: UsageSummary; breakdown: UsageBreakdownRow[]; projects: ProjectSummary[]; sessions: SessionSummary[] }

const RANGES: Array<{ value: Days; label: string }> = [{ value: '24h', label: '24h' }, { value: 7, label: '7d' }, { value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 365, label: '12m' }];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LONG = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const WEEKDAY_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY_HOUR = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/** Dollars as the mockups write them: cents below $1,000, whole dollars above. Unknown pricing stays unknown. */
const money = (micro: number | null) => micro === null ? '—' : micro >= 1e9 ? `$${formatExact(Math.round(micro / 1e6))}` : formatCost(micro);
const projectName = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No project';
/** How long a period is: "24 hours", "7 days", "12 months". */
const spanOf = (days: Days) => days === '24h' ? '24 hours' : days === 365 ? '12 months' : `${days} days`;
const previousLabel = (days: Days) => `previous ${spanOf(days)}`;
/** A range as a key that changes when its span does. */
const rangeKey = (range: DayRange | HourWindow) => 'since' in range ? `${range.since}-${range.until}` : `${range.from}-${range.to}`;

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

/** The Tokens page: your local usage over a chosen period, loaded and kept current with each refresh cycle. */
export function TokensView({ api, status }: { api: ApiClient; status: LocalStatus | null }) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [days, setDays] = useState<Days>(30);
  const [tool, setTool] = useState<'all' | ToolId>('all');
  const [data, setData] = useState<TokensData | null>(null);
  const [year, setYear] = useState<UsageSummary | null>(null);
  const [overview, setOverview] = useState<MenuOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last 24 hours move on when an hour ends, at the next render.
  const range = days === '24h' ? last24Hours() : dayRange({ preset: days });
  // New data arrives with each scan, refresh cycle and price table.
  const revision = usageRevision(status);
  useEffect(() => {
    let live = true; setError(null);
    const before = 'since' in range ? previousWindow(range) : previousRange(range);
    const breakdown = 'since' in range
      ? api.localHours(range, tool).then(({ items }) => items.map(({ hour, ...row }) => ({ ...row, day: hour })))
      : api.localBreakdown(range, tool).then(({ items }) => items);
    Promise.all([api.localSummary(range, tool), api.localSummary(before, tool), breakdown, api.localProjects(range, tool), api.localSessions(range, tool)])
      .then(([summary, before, breakdown, projects, sessions]) => { if (live) setData({ range, tool, summary, before, breakdown, projects: projects.items, sessions: sessions.items }); })
      .catch((value: unknown) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [api, rangeKey(range), tool, revision]);
  useEffect(() => {
    let live = true;
    api.localSummary(dayRange({ preset: 365 }), tool).then((value) => { if (live) setYear(value); }).catch(() => { if (live) setYear(null); });
    return () => { live = false; };
  }, [api, tool, revision]);
  useEffect(() => {
    let live = true;
    api.localOverview().then((value) => { if (live) setOverview(value); }).catch(() => {});
    return () => { live = false; };
  }, [api, revision]);
  return <TokensPage data={data} year={year} overview={overview} status={status} range={range} days={days} metric={metric} tool={tool} error={error}
    onMetric={setMetric} onDays={setDays} onTool={setTool} onExport={() => { downloadCsv(api, range, tool).catch((value: unknown) => setError(errorText(value))); }} />;
}

export function TokensPage({ data: loaded, year, overview, status, range, days, metric, tool, error, onMetric, onDays, onTool, onExport }: {
  data: TokensData | null; year: UsageSummary | null; overview: MenuOverview | null; status: LocalStatus | null; range: DayRange | HourWindow; days: Days; metric: Metric; tool: 'all' | ToolId; error: string | null;
  onMetric: (metric: Metric) => void; onDays: (days: Days) => void; onTool: (tool: 'all' | ToolId) => void; onExport: () => void;
}) {
  // A new range or tool takes seconds to load; until it has, the last one's totals would sit under the new labels.
  const data = loaded && rangeKey(loaded.range) === rangeKey(range) && loaded.tool === tool ? loaded : null;
  const tracking = status === null || status.sources.some((source) => source.enabled && source.state !== 'unsupported');
  const yearDays = useMemo(() => year ? fillRange(year.daily, dayRange({ preset: 365 })) : null, [year]);
  // The chart's points: the range's days, or its hours.
  const points = useMemo(() => 'since' in range ? hourList(range) : fillRange([], range).map((point) => point.day), [rangeKey(range)]);
  const period = `${days === '24h' ? 'last 24 hours' : rangeLabel({ preset: days })}${tool === 'all' ? '' : ` · ${toolLabel(tool)}`}`;
  return <div className="m-page tk-page">
    <div className="tk-bar">
      <Seg label="Metric" value={metric} options={[{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }]} onChange={onMetric} />
      <Seg label="Range" value={days} options={RANGES} onChange={onDays} />
      <label className="tk-select m-btn"><span className="sr-only">Tool</span>
        <select value={tool} onChange={(event) => onTool(event.target.value as 'all' | ToolId)}>
          <option value="all">All tools</option>{TOOLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>{ICONS.chevronDown}</label>
      <button type="button" className="m-btn icon" title="Export CSV" aria-label="Export CSV" onClick={onExport}>{ICONS.download}</button>
    </div>
    {!tracking && <div className="m-card tk-setup">
      <span className="tk-setup-icon">{ICONS.folder}</span>
      <div><b>Tokentracky isn’t reading any tools yet.</b><span>Choose which tools to read in Settings. Only token counts are kept; prompts and code never are.</span></div>
      <a className="m-btn primary" href="/settings" onClick={openPage('/settings')}>Open Settings</a>
    </div>}
    {error && <Notice tone="error">Could not load your usage: {error}</Notice>}
    {!data ? !error && <Loading>Loading your usage…</Loading> : <>
      <Hero data={data} metric={metric} days={days} range={range} period={period} refreshedAt={status?.lastRefreshAt ?? null} />
      <ChartCard data={data} year={yearDays} overview={overview} range={range} points={points} metric={metric} days={days} period={period} activeDays={year?.activity.activeDays ?? null} averagePerActiveDay={year?.activity.averagePerActiveDay ?? null} />
      {data.summary.tokens > 0 && <TokenTypes summary={data.summary} compare={data.before} versus={`vs ${previousLabel(days)}`} />}
      <ToolCards data={data} points={points} days={days} period={period} />
      <Insights data={data} year={year} yearDays={yearDays} range={range} days={days} />
      {yearDays && year && <>
        <SectionHead title="Activity" note="Every day you used an AI coding tool" />
        <ActivityGrid days={yearDays} stats={year.activity} label="Last 12 months" />
      </>}
      <Breakdown data={data} range={range} onExport={onExport} />
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

function Hero({ data, metric, days, range, period, refreshedAt }: { data: TokensData; metric: Metric; days: Days; range: DayRange | HourWindow; period: string; refreshedAt: string | null }) {
  const { summary, before } = data;
  const [value, previous] = metric === 'tokens' ? [summary.tokens, before.tokens] : [summary.costMicrousd, before.costMicrousd];
  const change = value === null || previous === null || (!value && !previous) ? undefined : changeVsPrevious(value, previous);
  const tools = summary.byTool.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  return <section className="tk-hero" aria-label="Totals">
    <div>
      <div className="m-eyebrow">{metric === 'tokens' ? 'Total tokens' : 'Estimated cost'} · {period}</div>
      <div className="tk-hero-total">
        <span className="m-big-number" title={metric === 'tokens' ? `${formatExact(summary.tokens)} tokens` : formatCost(summary.costMicrousd)}>{metric === 'tokens' ? formatCompact(summary.tokens) : money(summary.costMicrousd)}</span>
        {change !== undefined && <Delta value={change} />}
      </div>
      <div className="tk-hero-meta">
        {metric === 'tokens' ? <><b>{money(summary.costMicrousd)}</b> est. cost</> : <><b>{formatCompact(summary.tokens)}</b> tokens</>}<span className="tk-sep">·</span>
        <b>{formatExact(summary.sessions)}</b> sessions<span className="tk-sep">·</span>{metric === 'tokens' ? formatCompact(before.tokens) : money(before.costMicrousd)} {previousLabel(days)}
      </div>
      <div className="tk-hero-range">{'since' in range ? `${WEEKDAY_HOUR.format(range.since)} – ${WEEKDAY_HOUR.format(range.until)} · local time`
        : `${range.from === range.to ? LONG.format(utc(range.to)) : `${shortDay(range.from)} – ${LONG.format(utc(range.to))}`} · UTC days`} · API-price estimate{refreshedAt ? ` · updated ${timeAgo(refreshedAt)}` : ''}</div>
    </div>
    {tools.length > 0 && <table className="tk-tools">
      <thead><tr><th scope="col">Tool</th><th scope="col">Share</th><th scope="col">Tokens</th><th scope="col">%</th><th scope="col">Cost</th></tr></thead>
      <tbody>{tools.map((item) => <tr key={item.tool} style={{ ['--c' as string]: `var(--tool-${item.tool})` }}>
        <th scope="row"><ToolIcon id={item.tool} />{toolLabel(item.tool)}</th>
        <td><span className="tk-share"><i style={{ width: `${(item.tokens / (summary.tokens || 1)) * 100}%` }} /></span></td>
        <td className="tk-v" title={`${formatExact(item.tokens)} tokens`}>{formatCompact(item.tokens)}</td>
        <td>{formatShare(item.tokens, summary.tokens)}</td>
        <td>{money(item.costMicrousd)}</td>
      </tr>)}</tbody>
    </table>}
  </section>;
}

function ChartCard({ data, year, overview, range, points, metric, days, period, activeDays, averagePerActiveDay }: { data: TokensData; year: Array<{ day: string; tokens: number }> | null; overview: MenuOverview | null; range: DayRange | HourWindow; points: string[]; metric: Metric; days: Days; period: string; activeDays: number | null; averagePerActiveDay: number | null }) {
  const [group, setGroup] = useState<Group>('tools');
  const [mode, setMode] = useState<'stacked' | 'lines'>('stacked');
  const series = useMemo(() => chartSeries(data.breakdown, points, group, metric), [data.breakdown, points, group, metric]);
  const total = sum(series.flatMap((item) => item.values));
  const format = metric === 'tokens' ? formatCompact : formatCostCompact;
  const month = `${utcToday().slice(0, 8)}01`;
  const hours = 'since' in range;
  const title = `${hours ? 'Hourly' : 'Daily'} ${metric === 'tokens' ? 'tokens' : 'estimated cost'}`;
  return <section className="m-card tk-chart-card" aria-label={hours ? 'Hourly usage' : 'Daily usage'}>
    <div className="tk-chart-head">
      <div>
        <div className="m-card-title">{title}</div>
        <div className="tk-legend" aria-hidden="true">{series.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div>
      </div>
      <div className="tk-chart-controls">
        <Seg small label="Group by" value={group} options={[{ value: 'tools', label: 'Tools' }, { value: 'models', label: 'Models' }]} onChange={setGroup} />
        {!hours && <Seg small label="Chart style" value={mode} options={[{ value: 'stacked', label: 'Stacked' }, { value: 'lines', label: 'Lines' }]} onChange={setMode} />}
      </div>
    </div>
    <div className="tk-chart-box">
      {total > 0
        ? <StackedAreaChart days={points} series={series} mode={mode} hours={hours} average={!hours && mode === 'stacked' && points.length > 1 ? total / points.length : undefined} format={format}
          label={`${title} by ${group === 'tools' ? 'tool' : 'model'}, ${period}`} />
        : <p className="tk-empty">No usage in this range yet.</p>}
    </div>
    {year && !hours && <div className="tk-strip-box"><OverviewStrip days={year} from={range.from} /></div>}
    <div className="m-stat-strip tk-kpis">
      {/* Later: today, week and month costs with their change, from the overview's costs (the 5-minute refresh work). */}
      <Kpi label="Today" value={overview ? formatCompact(overview.today) : '—'} sub="so far · UTC" />
      <Kpi label="This week" value={overview ? formatCompact(overview.week) : '—'} sub="since Monday" />
      <Kpi label="This month" value={overview ? formatCompact(overview.month) : '—'} sub={`since ${shortDay(month)}`} />
      <Kpi label="Avg / active day" value={averagePerActiveDay !== null && activeDays ? formatCompact(averagePerActiveDay) : '—'} sub={activeDays !== null ? `last 12 months · ${formatExact(activeDays)} days` : ''} />
      {/* Later: "6.6B of 6.8B input" under the cache rate needs summary.breakdown from the token types work. */}
      <Kpi label="Cache hit rate" value={`${(data.summary.cacheRate * 100).toFixed(1)}%`} sub={`of input · ${spanOf(days)}`} />
    </div>
  </section>;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div><div className="m-label">{label}</div><div className="m-stat-value">{value}</div><div className="tk-kpi-sub">{sub}</div></div>;
}

function ToolCards({ data, points, days, period }: { data: TokensData; points: string[]; days: Days; period: string }) {
  const daily = useMemo(() => new Map(dailyByTool(data.breakdown, points).map((item) => [item.key, item.tokens])), [data.breakdown, points]);
  const tools = data.summary.byTool.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  if (!tools.length) return null;
  return <>
    <SectionHead title="By tool" note={`Share of tokens · ${period} vs ${previousLabel(days)}`} />
    <div className="tk-tool-cards">{tools.map((item) => {
      const before = data.before.byTool.find((entry) => entry.tool === item.tool)?.tokens ?? 0;
      const models = new Set(data.breakdown.filter((row) => row.tool === item.tool && row.tokens > 0).map((row) => row.model)).size;
      return <div key={item.tool} className="m-card tk-tool-card">
        <div className="tk-tc-head"><ToolIcon id={item.tool} />{toolLabel(item.tool)}</div>
        <div className="tk-tc-pct"><b>{formatShare(item.tokens, data.summary.tokens)}</b><Delta compact value={changeVsPrevious(item.tokens, before)} /></div>
        <div className="tk-tc-sub">{formatCompact(item.tokens)} · {models} {models === 1 ? 'model' : 'models'}</div>
        <Sparkline values={daily.get(item.tool) ?? []} color={`var(--tool-${item.tool})`} />
      </div>;
    })}</div>
  </>;
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const id = useId().replace(/[^\w-]/g, '');
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const line = monotonePath(values.map((value, index) => [Math.round((index / (values.length - 1)) * 2000) / 10, Math.round((40 - (value / max) * 32) * 10) / 10]));
  return <svg className="tk-spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: color }} stopOpacity="0.28" /><stop offset="1" style={{ stopColor: color }} stopOpacity="0" /></linearGradient></defs>
    <path d={`${line}L200,44L0,44Z`} fill={`url(#${id})`} />
    <path d={line} fill="none" style={{ stroke: color }} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>;
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

function Insights({ data, year, yearDays, range, days }: { data: TokensData; year: UsageSummary | null; yearDays: Array<{ day: string; tokens: number }> | null; range: DayRange | HourWindow; days: Days }) {
  const { summary, before, breakdown, projects, sessions } = data;
  const toolOf = useMemo(() => mainTools(breakdown), [breakdown]);
  const favourite = favouriteModel(summary.byModel);
  const weekday = yearDays ? busiestWeekdayUtc(yearDays) : null;
  // The most expensive day is one of the range's days; the last 24 hours have none whole.
  const daySpan = 'since' in range ? null : range;
  const expensive = mostExpensiveDay(summary.daily);
  const expensiveTools = expensive ? costGroups(breakdown.filter((row) => row.day === expensive.day), (row) => row.tool) : [];
  const project = [...projects].sort((a, b) => b.tokens - a.tokens)[0];
  const session = biggestSession(sessions);
  const trending = trendingModel(summary.byModel, before.byModel);
  const streak = year?.activity;
  const span = spanOf(days);
  const glyph = (model: string) => { const tool = toolOf.get(model); return tool ? <ToolIcon id={tool} /> : null; };
  return <>
    <SectionHead title="Insights" note={`From your local records · last ${span} unless noted`} />
    <div className="tk-insights">
      <Insight icon={ICONS.star} label="Favourite model" mono value={favourite ? <span className="tk-model">{glyph(favourite.model)}{favourite.model}</span> : '—'}
        sub={favourite ? `${formatShare(favourite.tokens, summary.tokens)} of tokens · ${formatCompact(favourite.tokens)}` : 'No usage in this range yet'}>
        {favourite && <Meter share={favourite.share} color={`var(--tool-${toolOf.get(favourite.model) ?? 'cursor'})`} caption={[`${summary.byModel.filter((item) => item.tokens > 0).length} models used`, `last ${span}`]} />}
      </Insight>
      {/* Later: the Busiest hour card needs hourly totals in local time (the local-time work). */}
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
      {/* Later: Longest session by duration needs session start times (Task 1.4); until then the biggest by tokens. */}
      <Insight icon={ICONS.stack} label="Biggest session" value={session ? <span title={`${formatExact(session.tokens)} tokens`}>{formatCompact(session.tokens)}</span> : '—'}
        sub={session ? `${projectName(session.project)} · ${timeAgo(session.lastUsedAt)}` : 'No sessions in this range'}>
        {session && <span className="m-pill"><ToolIcon id={session.tool} />{session.model} in {toolLabel(session.tool)}</span>}
      </Insight>
      <Insight icon={ICONS.trending} label="Trending model" mono value={trending ? <span className="tk-model">{glyph(trending.model)}{trending.model}</span> : '—'}
        sub={trending ? <><span className="tk-up">+{trending.gain.toFixed(1)} pts</span> share vs {previousLabel(days)}</> : 'No model gained share'}>
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
      {/* Later: Sessions, Input, Output and Cached columns per model need sessions per model (Task 1.4) and summary.breakdown (the token types work). */}
      {tab === 'model' && <>
        <thead><tr><th className="l">#</th><th className="l">Model</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead>
        <tbody>{models.map((item, index) => { const tool = toolOf.get(item.key); return <tr key={item.key}>
          <td className="l tk-rank">{index + 1}</td>
          <td className="l"><div className="tk-model-cell"><span className="tk-model-name">{tool && <ToolIcon id={tool} />}{item.key}</span><span className="tk-uline" style={{ ['--c' as string]: `var(--tool-${tool ?? 'cursor'})`, width: `${(item.tokens / top) * 72}%` }} /></div></td>
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
