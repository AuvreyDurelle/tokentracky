import { usePublicPageReady } from './public-page';
import { useEffect, useState } from 'react';
import { TOOL_NAMES, type Period, type ProfileStats, type ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { errorText, formatCompact, formatExact } from './format';
import { Empty, Loading, Notice, Segmented } from './ui';

const WINDOWS: Record<Period, string> = { week: 'this week', month: 'this month', all: 'all time' };

/** "alice leads by 33%", "Dead even", or the leader alone when the other has no tokens. */
export function leadLine(a: { alias: string; tokens: number }, b: { alias: string; tokens: number }): string {
  if (a.tokens === b.tokens) return 'Dead even';
  const [ahead, behind] = a.tokens > b.tokens ? [a, b] : [b, a];
  return behind.tokens ? `${ahead.alias} leads by ${formatExact(Math.round(((ahead.tokens - behind.tokens) / behind.tokens) * 100))}%` : `${ahead.alias} leads`;
}

/** The head-to-head's address in a window, tagged as a shared link: its preview and page show that window. */
export function compareLink(a: string, b: string, period: Period, origin: string): string {
  return `${origin}/vs/${a}/${b}?${new URLSearchParams({ ...(period === 'all' ? {} : { period }), ref: 'share' }).toString()}`;
}

/** X's post composer with the head-to-head's lead and its tagged link, whose preview shows the card. */
export function compareShareUrl(a: ProfileStats, b: ProfileStats, period: Period, origin: string): string {
  const [left, right] = [{ alias: a.alias, tokens: a.periods[period].tokens }, { alias: b.alias, tokens: b.periods[period].tokens }];
  const text = `${a.alias} vs ${b.alias} on Tokentracky, ${WINDOWS[period]}: ${formatCompact(left.tokens)} to ${formatCompact(right.tokens)} tokens. ${leadLine(left, right)}.`;
  return `https://x.com/intent/post?${new URLSearchParams({ text, url: compareLink(a.alias, b.alias, period, origin) }).toString()}`;
}

const topTool = (stats: ProfileStats) => (Object.entries(stats.toolTokens ?? {}) as Array<[ToolId, number]>).sort((a, b) => b[1] - a[1])[0]?.[0];

/** A shareable `/vs/:a/:b` page: two published profiles side by side. */
export function ComparePage({ api, a, b, origin, onProfile }: { api: ApiClient; a: string; b: string; origin: string; onProfile: (alias: string) => void }) {
  const [pair, setPair] = useState<[ProfileStats, ProfileStats] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setPair(null); setError(null);
    Promise.all([api.profileStats(a), api.profileStats(b)]).then((value) => { if (live) setPair(value); }).catch((value: unknown) => { if (live) setError(value); });
    return () => { live = false; };
  }, [api, a, b]);
  usePublicPageReady(pair !== null || error !== null);
  if (error instanceof ApiError && error.status === 404) return <div className="page-stack"><Empty title="One of these builders isn’t on the leaderboard">They may have deleted their account, or a name is mistyped.</Empty></div>;
  if (error) return <div className="page-stack"><Notice tone="error">Could not load this comparison: {errorText(error)}</Notice></div>;
  if (!pair) return <Loading>Loading comparison…</Loading>;
  // A shared link opens on the window it was shared in.
  const shared = new URLSearchParams(window.location.search).get('period');
  return <CompareView a={pair[0]} b={pair[1]} origin={origin} onProfile={onProfile} initial={shared === 'week' || shared === 'month' ? shared : 'all'} />;
}

export function CompareView({ a, b, origin, onProfile, initial = 'all' }: { a: ProfileStats; b: ProfileStats; origin: string; onProfile: (alias: string) => void; initial?: Period }) {
  const [period, setPeriod] = useState<Period>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const earned = (stats: ProfileStats) => stats.badges.filter((badge) => badge.tier > 0).length;
  // Each row: its label, both values, the numbers that decide who is ahead (higher wins unless `lower`) and how to print them.
  const rows: Array<{ label: string; values: [number, number]; text?: (value: number) => string; lower?: boolean }> = [
    { label: `Tokens ${WINDOWS[period]}`, values: [a.periods[period].tokens, b.periods[period].tokens], text: formatCompact },
    { label: `Rank ${WINDOWS[period]}`, values: [a.periods[period].rank, b.periods[period].rank], text: (value) => value > 0 ? `#${formatExact(value)}` : '—', lower: true },
    { label: 'Active days, last 12 months', values: [a.activity.activeDays, b.activity.activeDays] },
    { label: 'Current streak', values: [a.activity.currentStreak, b.activity.currentStreak], text: (value) => `${formatExact(value)} d` },
    { label: 'Longest streak', values: [a.activity.longestStreak, b.activity.longestStreak], text: (value) => `${formatExact(value)} d` },
    { label: 'Best day', values: [a.activity.bestDay?.tokens ?? 0, b.activity.bestDay?.tokens ?? 0], text: formatCompact },
    { label: 'Badges earned', values: [earned(a), earned(b)] },
  ];
  const ahead = (values: [number, number], lower = false) => {
    const [x, y] = lower ? values.map((value) => value > 0 ? value : Infinity) : values;
    return x === y ? -1 : (lower ? x! < y! : x! > y!) ? 0 : 1;
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(compareLink(a.alias, b.alias, period, origin)); setMessage('Link copied.'); } catch (value) { setMessage(`Copying failed: ${errorText(value)}`); }
  };
  const lead = leadLine({ alias: a.alias, tokens: a.periods[period].tokens }, { alias: b.alias, tokens: b.periods[period].tokens });
  return <div className="page-stack compare">
    <section className="panel" aria-labelledby="compare-title">
      <header className="panel-head"><h1 id="compare-title">{a.alias} vs {b.alias}</h1><span className="push faint">{lead}</span></header>
      <div className="panel-body form">
        <Segmented label="Window" value={period} options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }]} onChange={setPeriod} />
        <img className="share-card" src={`/og/vs/${a.alias}/${b.alias}.png${period === 'all' ? '' : `?period=${period}`}`} width={1200} height={630} alt={`${a.alias} vs ${b.alias}: ${lead}`} />
        <div className="actions">
          <button type="button" className="btn sm" onClick={() => void copy()}>Copy link</button>
          <button type="button" className="btn sm" onClick={() => window.open(compareShareUrl(a, b, period, origin), '_blank', 'noopener')}>Post on X</button>
        </div>
        {message && <p className="faint" role="status">{message}</p>}
      </div>
    </section>
    <section className="panel" aria-label="Side by side">
      <table className="compare-table">
        <thead><tr><th scope="col" /><th scope="col"><button type="button" className="link" onClick={() => onProfile(a.alias)}>{a.alias}</button></th><th scope="col"><button type="button" className="link" onClick={() => onProfile(b.alias)}>{b.alias}</button></th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const winner = ahead(row.values, row.lower);
            return <tr key={row.label}><th scope="row">{row.label}</th>{row.values.map((value, index) => <td key={index} className={winner === index ? 'ahead' : undefined}>{(row.text ?? formatExact)(value)}</td>)}</tr>;
          })}
          <tr><th scope="row">Top tool</th>{[a, b].map((stats) => { const tool = topTool(stats); return <td key={stats.alias}>{tool ? TOOL_NAMES[tool] : '—'}</td>; })}</tr>
          <tr><th scope="row">Favourite model</th>{[a, b].map((stats) => <td key={stats.alias}>{stats.models?.[0]?.model ?? '—'}</td>)}</tr>
        </tbody>
      </table>
    </section>
  </div>;
}
