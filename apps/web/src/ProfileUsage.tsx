import { useEffect, useState, type CSSProperties } from 'react';
import type { ProfileStats, ToolId, UsageWindow } from '@tokentracky/core';
import { errorText, formatCompact, formatCost, formatCostCompact, formatExact, formatShare, shortDay, toolLabel, utcHourSpan } from './format';
import { utcToday } from './ranges';
import { type ChartPoint, UsageChart } from './UsageChart';
import { ToolIcon } from './ui';
import { byWeek, comparedWith, daySummary, type UsagePeriod, usageSpan } from './usage-span';

type View = 'daily' | 'running';
type Metric = 'tokens' | 'cost';
const PERIODS: Array<{ value: UsagePeriod; label: string }> = [{ value: '24h', label: '24h' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
// Longer spans than a quarter read better a week at a time.
const WEEKLY_FROM = 93;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LETTER = new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' });
const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const date = (day: string) => new Date(`${day}T00:00:00Z`);
const weekend = (day: string) => [0, 6].includes(date(day).getUTCDay());

/** Running totals of a daily series, so each point is everything up to and including its day. */
export function runningTotals(points: Array<{ day: string; tokens: number }>): Array<{ day: string; tokens: number }> {
  let sum = 0;
  return points.map(({ day, tokens }) => ({ day, tokens: (sum += tokens) }));
}

/** Change against what came before, as "▲ 14%"; null without anything before. */
function change(now: number, before: number): { up: boolean; text: string } | null {
  if (before <= 0) return null;
  return { up: now >= before, text: `${now >= before ? '▲' : '▼'} ${formatShare(Math.abs(now - before), before)}` };
}

/**
 * A builder's usage as a pink chart: the last 24 hours hour by hour, or a week, a month or all time day by day, stepping
 * back through earlier weeks and months. Hovering a point reads its tokens, share and, as shared, cost, top tool and top
 * model; under the chart, the span's tool split and model mix. The website's profile and the Mac app's both show it.
 */
/** What the usage chart loads its spans from: the website's API client or the Mac app's. */
export interface UsageApi { profileUsage(alias: string, from: string, to: string): Promise<UsageWindow> }

export function ProfileUsage({ alias, api, hours, start, now = new Date() }: { alias: string; api: UsageApi; hours: ProfileStats['hours']; start: string | null; now?: Date }) {
  const [period, setPeriodState] = useState<UsagePeriod>('month');
  const [back, setBack] = useState(0);
  const [view, setView] = useState<View>('daily');
  const [metric, setMetric] = useState<Metric>('tokens');
  const [usage, setUsage] = useState<UsageWindow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const today = utcToday(now);
  const span = period === '24h' ? null : usageSpan(period, back, today, start);
  const setPeriod = (next: UsagePeriod) => { setPeriodState(next); setBack(0); };
  useEffect(() => {
    if (!span) return;
    let live = true;
    setError(null);
    api.profileUsage(alias, span.from, span.to).then((value) => { if (live) setUsage(value); }).catch((reason: unknown) => { if (live) setError(reason); });
    return () => { live = false; };
    // The span is fully described by its days.
  }, [api, alias, span?.from, span?.to]);
  const shown = usage && span && usage.from === span.from ? usage : null;
  // Cost is offered only when every day in the span has a price: an unknown price is not a zero one.
  const costs = typeof shown?.costMicrousd === 'number';
  const useCost = metric === 'cost' && costs && period !== '24h';
  return <section className="pu" aria-label={`${alias}’s usage`}>
    <div className="pu-bar">
      <span className="pu-title">Usage</span>
      <div className="pu-seg" role="group" aria-label="Period">{PERIODS.map((option) => <button key={option.value} type="button" className={option.value === period ? 'on' : undefined} aria-pressed={option.value === period} onClick={() => setPeriod(option.value)}>{option.label}</button>)}</div>
      <div className="pu-step">
        <button type="button" aria-label="Earlier" disabled={!span?.canBack} onClick={() => setBack(back + 1)}><Chevron d="m15 18-6-6 6-6" /></button>
        <b>{span ? spanName(period, span.from, span.to) : 'Last 24 hours'}{span && period !== 'all' && <small>{spanDays(span.from, span.to)}</small>}{!span && <small>UTC</small>}</b>
        <button type="button" aria-label="Later" disabled={!span?.canForward} onClick={() => setBack(back - 1)}><Chevron d="m9 18 6-6-6-6" /></button>
      </div>
      <span className="pu-push" />
      <div className="pu-seg" role="group" aria-label="Chart">{(['daily', 'running'] as const).map((option) => <button key={option} type="button" className={option === view ? 'on' : undefined} aria-pressed={option === view} onClick={() => setView(option)}>{option === 'daily' ? (period === '24h' ? 'Hourly' : 'Daily') : 'Running total'}</button>)}</div>
    </div>
    {period === '24h' ? <LastDay hours={hours} view={view} />
      : error ? <p className="pu-note">Could not load the usage: {errorText(error)}</p>
        : !shown ? <p className="pu-note">Loading usage…</p>
          : <Span usage={shown} period={period} view={view} cost={useCost} metric={metric} costs={costs} today={today} onMetric={setMetric} />}
  </section>;
}

function spanName(period: UsagePeriod, from: string, to: string): string {
  if (period === 'month') return MONTH.format(date(from));
  if (period === 'all') return `Since ${shortDay(from)} ${date(from).getUTCFullYear()}`;
  return `${shortDay(from)} – ${shortDay(to)}`;
}
function spanDays(from: string, to: string): string { return `${date(from).getUTCDate()}–${date(to).getUTCDate()}`; }

function Span({ usage, period, view, cost, metric, costs, today, onMetric }: { usage: UsageWindow; period: UsagePeriod; view: View; cost: boolean; metric: Metric; costs: boolean; today: string; onMetric: (metric: Metric) => void }) {
  const days = usage.daily;
  const weekly = view === 'daily' && days.length >= WEEKLY_FROM;
  const of = (point: { tokens: number; costMicrousd?: number | null }) => cost ? point.costMicrousd ?? 0 : point.tokens;
  const series = weekly ? byWeek(days) : days;
  let sum = 0;
  const points: ChartPoint[] = series.map((point) => ({ at: point.day, value: view === 'running' ? (sum += of(point)) : of(point) }));
  const { best, average } = daySummary(days.map((day) => ({ day: day.day, tokens: of(day) })));
  const total = cost ? usage.costMicrousd ?? 0 : usage.tokens;
  const moved = cost || period === 'all' ? null : change(usage.tokens, usage.previousTokens);
  const fmt = cost ? (n: number) => formatCost(n) : formatExact;
  const short = cost ? (n: number) => formatCostCompact(n) : formatCompact;
  const under = days.at(-1)?.day === today && view === 'daily' && !weekly;
  const axisEvery = Math.max(1, Math.ceil(points.length / 10));
  const axis = (index: number) => {
    const day = series[index]!.day;
    if (weekly || points.length > 40) return index % axisEvery === 0 || index === points.length - 1 ? `${date(day).getUTCDate()} ${MONTH_SHORT.format(date(day))}` : null;
    if (index === points.length - 1 && day === today) return 'Today';
    return index % axisEvery === 0 ? (points.length <= 8 ? `${LETTER.format(date(day))} ${date(day).getUTCDate()}` : String(date(day).getUTCDate())) : null;
  };
  const tip = (index: number) => {
    const point = series[index]!;
    const day = days.find((entry) => entry.day === point.day);
    const value = of(point);
    const vs = average > 0 && view === 'daily' && !weekly ? change(value, average) : null;
    return <>
      <div className="pu-tip-h"><b>{weekly ? `Week of ${shortDay(point.day)}` : WEEKDAY.format(date(point.day))}</b><span>{weekly ? `${'days' in point ? point.days : 7} days` : 'UTC day'}</span></div>
      <div className="pu-tip-v"><b>{view === 'running' ? short(points[index]!.value) : short(value)}</b><span>{view === 'running' ? 'so far' : cost ? 'est. cost' : 'tokens'}</span></div>
      {view === 'daily' && <div className="pu-tip-r"><span>Share of the span</span><b>{formatShare(value, total)}</b></div>}
      {vs && <div className="pu-tip-r"><span>vs the average day ({short(average)})</span><b className={vs.up ? 'up' : 'down'}>{vs.text}</b></div>}
      {!weekly && day && <>
        {!cost && day.costMicrousd !== undefined && <div className="pu-tip-r"><span>Est. cost</span><b>{formatCost(day.costMicrousd)}</b></div>}
        {day.topTool && <div className="pu-tip-r"><span>Top tool</span><b><ToolIcon id={day.topTool.tool} />{toolLabel(day.topTool.tool)} <i>{formatShare(day.topTool.tokens, day.tokens)}</i></b></div>}
        {day.topModel && <div className="pu-tip-r"><span>Top model</span><b className="mono">{day.topModel.model} <i>{formatShare(day.topModel.tokens, day.tokens)}</i></b></div>}
      </>}
    </>;
  };
  const bestIndex = best && !weekly && view === 'daily' ? series.findIndex((point) => point.day === best.day) : -1;
  return <>
    <div className="pu-sum">
      <div>
        <div className="pu-k">{usage.from === usage.to ? shortDay(usage.from) : `${shortDay(usage.from)} – ${shortDay(usage.to)}`} · UTC days</div>
        <div className="pu-line">
          <b className="pu-big" title={fmt(total)}>{short(total)}</b><span className="pu-u">{cost ? 'est. cost' : 'tokens'}</span>
          {moved && <span className="pu-d"><span className={moved.up ? 'up' : 'down'}>{moved.text}</span> vs {comparedWith(usage.from, usage.to)}</span>}
          {best && <><i className="pu-sep" /><span className="pu-d">best day <b>{short(best.tokens)}</b> · {shortDay(best.day)}</span></>}
          {average > 0 && <><i className="pu-sep" /><span className="pu-d"><i className="pu-dash" />avg day <b>{short(average)}</b></span></>}
        </div>
      </div>
      <span className="pu-push" />
      {costs && <div className="pu-seg" role="group" aria-label="Measure">{(['tokens', 'cost'] as const).map((option) => <button key={option} type="button" className={option === metric ? 'on' : undefined} aria-pressed={option === metric} onClick={() => onMetric(option)}>{option === 'tokens' ? 'Tokens' : 'Cost'}</button>)}</div>}
    </div>
    <UsageChart points={points} label={`${cost ? 'Estimated cost' : 'Tokens'} per ${weekly ? 'week' : 'UTC day'}${view === 'running' ? ', running total' : ''}, ${shortDay(usage.from)} to ${shortDay(usage.to)}`}
      value={fmt} tick={short} axis={axis} tip={tip} average={view === 'daily' && !weekly ? average : undefined} partial={under}
      best={bestIndex >= 0 ? { index: bestIndex, text: `Best day · ${short(best!.tokens)}` } : null} shade={weekly || period === 'all' ? undefined : (index) => weekend(series[index]!.day)} />
    <Split usage={usage} />
  </>;
}

/** The last 24 whole UTC hours, hour by hour, as the profile sends them. */
function LastDay({ hours, view }: { hours: ProfileStats['hours']; view: View }) {
  if (!hours) return <p className="pu-note">No hourly totals synced yet.</p>;
  const total = hours.reduce((sum, hour) => sum + hour.tokens, 0);
  const average = Math.round(total / hours.length);
  const peak = hours.reduce((max, hour) => hour.tokens > max.tokens ? hour : max, hours[0]!);
  let sum = 0;
  const points = hours.map((hour) => ({ at: hour.hour, value: view === 'running' ? (sum += hour.tokens) : hour.tokens }));
  const tip = (index: number) => {
    const hour = hours[index]!;
    const vs = view === 'daily' ? change(hour.tokens, average) : null;
    return <>
      <div className="pu-tip-h"><b>{utcHourSpan(hour.hour)}</b><span>UTC hour</span></div>
      <div className="pu-tip-v"><b>{formatCompact(points[index]!.value)}</b><span>{view === 'running' ? 'so far' : 'tokens'}</span></div>
      {view === 'daily' && <div className="pu-tip-r"><span>Share of the 24 hours</span><b>{formatShare(hour.tokens, total)}</b></div>}
      {vs && <div className="pu-tip-r"><span>vs the average hour ({formatCompact(average)})</span><b className={vs.up ? 'up' : 'down'}>{vs.text}</b></div>}
    </>;
  };
  return <>
    <div className="pu-sum"><div>
      <div className="pu-k">Last 24 whole hours · UTC</div>
      <div className="pu-line"><b className="pu-big" title={formatExact(total)}>{formatCompact(total)}</b><span className="pu-u">tokens</span>
        {peak.tokens > 0 && <><i className="pu-sep" /><span className="pu-d">peak <b>{formatCompact(peak.tokens)}</b> at {peak.hour.slice(11, 16)}</span></>}
        {average > 0 && <><i className="pu-sep" /><span className="pu-d"><i className="pu-dash" />avg hour <b>{formatCompact(average)}</b></span></>}</div>
    </div></div>
    <UsageChart points={points} label={`Tokens per UTC hour${view === 'running' ? ', running total' : ''}, last 24 hours`} value={formatExact} tick={formatCompact} tip={tip}
      axis={(index) => index % 3 === 0 || index === hours.length - 1 ? hours[index]!.hour.slice(11, 16) : null} average={view === 'daily' ? average : undefined} />
  </>;
}

/** The span's tool split and model mix as two thin bars, when the builder shares them. */
function Split({ usage }: { usage: UsageWindow }) {
  const tools = Object.entries(usage.toolTokens ?? {}).filter(([, tokens]) => tokens).sort(([, a], [, b]) => b! - a!) as Array<[ToolId, number]>;
  const models = usage.models ?? [];
  if (!tools.length && !models.length) return null;
  const toolSum = tools.reduce((sum, [, tokens]) => sum + tokens, 0);
  return <div className="pu-split">
    <span className="pu-split-k">Tools · Models <small>share of {formatCompact(usage.tokens)}</small></span>
    {tools.length > 0 && <div className="pu-split-col">
      <div className="pu-split-bar">{tools.map(([tool, tokens]) => <span key={tool} style={{ width: `${(tokens / toolSum) * 100}%`, '--c': `var(--tool-${tool})` } as CSSProperties} />)}</div>
      <div className="pu-split-legend">{tools.slice(0, 4).map(([tool, tokens]) => <span key={tool}><ToolIcon id={tool} />{toolLabel(tool)} <b>{formatCompact(tokens)}</b> {formatShare(tokens, toolSum)}</span>)}</div>
    </div>}
    {models.length > 0 && <div className="pu-split-col">
      <div className="pu-split-bar models">{models.map((model, index) => <span key={model.model} style={{ width: `${(model.tokens / usage.tokens) * 100}%`, '--c': `var(--pink-${Math.min(5, index + 1)})` } as CSSProperties} />)}</div>
      <div className="pu-split-legend">{models.slice(0, 3).map((model, index) => <span key={model.model}><i style={{ '--c': `var(--pink-${Math.min(5, index + 1)})` } as CSSProperties} /><span className="mono">{model.model}</span> {formatShare(model.tokens, usage.tokens)}</span>)}{models.length > 3 && <span>+{models.length - 3}</span>}</div>
    </div>}
  </div>;
}

const Chevron = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
