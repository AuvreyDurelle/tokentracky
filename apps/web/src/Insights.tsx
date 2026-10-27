import type { ActivityStats, UsageBreakdownRow } from '@tokentracky/core';
import { formatCompact, formatExact, shortDay } from './format';
import { Heatmap } from './Heatmap';

const plural = (count: number, word: string) => `${formatExact(count)} ${word}${count === 1 ? '' : 's'}`;

/** A year of daily tokens with streaks and best day, for the You page and public profiles. */
export function ActivityPanel({ days, activity, note }: { days: Array<{ day: string; tokens: number }>; activity: ActivityStats; note: string }) {
  return <section className="panel" aria-label="Activity">
    <header className="panel-head"><h2>Activity</h2><span className="push faint">{note}</span></header>
    <div className="panel-body"><Heatmap days={days} label="Tokens per UTC day, last 12 months" /></div>
    <dl className="stats five">
      <div><dt>Active days</dt><dd>{formatExact(activity.activeDays)}</dd></div>
      <div><dt>Current streak</dt><dd>{plural(activity.currentStreak, 'day')}</dd></div>
      <div><dt>Longest streak</dt><dd>{plural(activity.longestStreak, 'day')}</dd></div>
      <div><dt>Best day</dt><dd>{activity.bestDay ? formatCompact(activity.bestDay.tokens) : '—'}</dd>{activity.bestDay && <small>{shortDay(activity.bestDay.day)}</small>}</div>
      <div><dt>Average per active day</dt><dd>{activity.activeDays ? formatCompact(activity.averagePerActiveDay) : '—'}</dd></div>
    </dl>
  </section>;
}

interface CostGroup { key: string; label: string; tokens: number; cost: number; unpriced: number }
/** Known cost and the tokens whose model has no price, grouped by `key`; largest cost first. */
export function costGroups(rows: UsageBreakdownRow[], key: (row: UsageBreakdownRow) => string, label: (key: string) => string = (value) => value): CostGroup[] {
  const groups = new Map<string, CostGroup>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? { key: id, label: label(id), tokens: 0, cost: 0, unpriced: 0 };
    group.tokens += row.tokens;
    if (row.costMicrousd === null) group.unpriced += row.tokens; else group.cost += row.costMicrousd;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label));
}
