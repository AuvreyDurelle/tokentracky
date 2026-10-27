import { useState } from 'react';
import type { ProfileStats } from '@tokentracky/core';
import { Heatmap } from './Heatmap';
import { rangeLabel } from './ranges';
import { TrendChart } from './TrendChart';
import { Segmented } from './ui';

type UsageView = 'daily' | 'cumulative' | 'calendar';
type UsageSpan = 30 | 90 | 365;
const VIEWS: Array<{ value: UsageView; label: string }> = [{ value: 'daily', label: 'Daily' }, { value: 'cumulative', label: 'Cumulative' }, { value: 'calendar', label: 'Calendar' }];
const SPANS: Array<{ value: UsageSpan; label: string }> = [{ value: 30, label: '30d' }, { value: 90, label: '90d' }, { value: 365, label: '12m' }];

/** Running totals of a daily series, so each point is everything up to and including its day. */
export function runningTotals(points: Array<{ day: string; tokens: number }>): Array<{ day: string; tokens: number }> {
  let sum = 0;
  return points.map(({ day, tokens }) => ({ day, tokens: (sum += tokens) }));
}

/** A profile's recent daily tokens as an area chart, a running total or a calendar, over the last 30 days, 90 days or 12 months. The website's profile and the Mac app's both show it. */
export function ProfileUsage({ daily }: { daily: ProfileStats['daily'] }) {
  const [view, setView] = useState<UsageView>('daily');
  const [span, setSpan] = useState<UsageSpan>(90);
  const days = daily.slice(-span);
  const name = rangeLabel({ preset: span });
  return <div className="profile-usage">
    <div className="usage-head">
      <Segmented label="Chart" value={view} options={VIEWS} onChange={setView} />
      <Segmented label="Range" value={span} options={SPANS} onChange={setSpan} />
    </div>
    {view === 'calendar'
      ? <Heatmap days={days} label={`Tokens per UTC day, ${name}`} />
      : view === 'daily'
        ? <TrendChart points={days} label={`Tokens per UTC day, ${name}`} />
        : <TrendChart points={runningTotals(days)} label={`Running total of tokens, ${name}`} />}
  </div>;
}
