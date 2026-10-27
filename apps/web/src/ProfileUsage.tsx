import { useState } from 'react';
import type { ProfileStats } from '@tokentracky/core';
import { Heatmap } from './Heatmap';
import { rangeLabel } from './ranges';
import { TrendChart } from './TrendChart';
import { Segmented } from './ui';

type UsageView = 'daily' | 'cumulative' | 'calendar';
type UsageSpan = '24h' | 30 | 90 | 365;
const VIEWS: Array<{ value: UsageView; label: string }> = [{ value: 'daily', label: 'Daily' }, { value: 'cumulative', label: 'Cumulative' }, { value: 'calendar', label: 'Calendar' }];
const SPANS: Array<{ value: UsageSpan; label: string }> = [{ value: '24h', label: '24h' }, { value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 365, label: '12m' }];

/** Running totals of a daily series, so each point is everything up to and including its day. */
export function runningTotals(points: Array<{ day: string; tokens: number }>): Array<{ day: string; tokens: number }> {
  let sum = 0;
  return points.map(({ day, tokens }) => ({ day, tokens: (sum += tokens) }));
}

/** A profile's recent daily tokens as an area chart, a running total or a calendar, over the last 30 days, 90 days or 12 months; or its last 24 whole UTC hours, hour by hour.
 *  The website's profile and the Mac app's both show it. */
export function ProfileUsage({ daily, hours }: { daily: ProfileStats['daily']; hours: ProfileStats['hours'] }) {
  const [view, setView] = useState<UsageView>('daily');
  const [span, setSpan] = useState<UsageSpan>(90);
  const days = span === '24h' ? [] : daily.slice(-span);
  const name = span === '24h' ? 'last 24 hours' : rangeLabel({ preset: span });
  return <div className="profile-usage">
    <div className="usage-head">
      {span !== '24h' && <Segmented label="Chart" value={view} options={VIEWS} onChange={setView} />}
      <Segmented label="Range" value={span} options={SPANS} onChange={setSpan} />
    </div>
    {span === '24h'
      ? hours ? <TrendChart hours points={hours.map(({ hour, tokens }) => ({ day: hour, tokens }))} label={`Tokens per UTC hour, ${name}`} /> : <p className="muted">No hourly totals synced yet.</p>
      : view === 'calendar'
        ? <Heatmap days={days} label={`Tokens per UTC day, ${name}`} />
        : view === 'daily'
          ? <TrendChart points={days} label={`Tokens per UTC day, ${name}`} />
          : <TrendChart points={runningTotals(days)} label={`Running total of tokens, ${name}`} />}
  </div>;
}
