import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UsageSummary } from '@tokentracky/core';
import type { ApiClient, LocalStatus } from '../api';
import { formatCompact, formatCost, formatExact, timeAgo } from '../format';
import { addDays, fillRange, utcToday } from '../ranges';
import { usageRevision } from '../refresh';
import type { Route } from '../route';
import { Avatar, JUMP_KEYS, SearchIcon, useRank } from '../ui';

type Page = Route['page'] | 'connect';
export type Tracking = 'collecting' | 'paused' | 'off';
export interface Today { tokens: number; costMicrousd: number | null; spark: number[] }

// A profile opens as a dialog over the leaderboard, so the frame still shows the leaderboard.
const TITLES: Partial<Record<Page, string>> = { leaderboard: 'Leaderboard', tokens: 'Tokens', you: 'Tokens', achievements: 'Achievements', settings: 'Settings', profile: 'Leaderboard', join: 'How it works', missing: 'Page not found' };

/** Today's UTC totals and the last 14 days for the sidebar, quiet days as zero. */
export function todayOf(daily: UsageSummary['daily'], now = new Date()): Today {
  const day = utcToday(now);
  const point = daily.find((entry) => entry.day === day);
  return { tokens: point?.tokens ?? 0, costMicrousd: point ? point.costMicrousd : 0, spark: fillRange(daily, { from: addDays(day, -13), to: day }).map((entry) => entry.tokens) };
}

/** The local app's frame: sidebar, toolbar and a scrolling content pane. */
export function MacShell({ api, status, me, page, path, go, onPalette, children }: { api: ApiClient; status: LocalStatus | null; me: string | null; page: Page; path: string; go: (route: Route) => void; onPalette: () => void; children: ReactNode }) {
  const [today, setToday] = useState<Today | null>(null);
  const rank = useRank(api, me);
  const content = useRef<HTMLDivElement>(null);
  // Today moves with each scan, refresh cycle and price table, like the pages' own totals. It waits for the first status, and a failed reload keeps the last card.
  const loaded = status !== null;
  const revision = usageRevision(status);
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    api.localSummary({ days: 30 }).then((summary) => { if (live) setToday(todayOf(summary.daily)); }).catch(() => {});
    return () => { live = false; };
  }, [api, loaded, revision]);
  // The pane scrolls, not the window: start each address at its top, except a profile, which opens over the leaderboard where it stands.
  const pane = page === 'profile' || page === 'leaderboard' ? 'leaderboard' : path;
  useEffect(() => { content.current?.scrollTo(0, 0); }, [pane]);
  const tracking: Tracking = status?.collecting ? 'collecting' : status?.sources.some((source) => source.state === 'paused') ? 'paused' : 'off';
  return <div className="mac app">
    <Sidebar page={page} go={go} today={today} tracking={tracking} syncedAt={status?.lastSyncAt ?? null} me={me} rank={rank} />
    <div className="main">
      <header className="toolbar">
        <span className="toolbar-title">{TITLES[page]}</span>
        <div className="toolbar-right">
          <button type="button" className="btn ghost sm" aria-label="Jump to a page or project" aria-keyshortcuts="Meta+K Control+K" onClick={onPalette}><SearchIcon /><span className="kbd">{JUMP_KEYS}</span></button>
        </div>
      </header>
      <div className="content" ref={content}>{children}</div>
    </div>
  </div>;
}

const icon = (paths: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
const NAV = [
  { page: 'leaderboard', label: 'Leaderboard', icon: icon(<><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></>) },
  { page: 'tokens', label: 'Tokens', icon: icon(<><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>) },
  { page: 'achievements', label: 'Achievements', icon: icon(<><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" /></>) },
] as const;
const SETTINGS_ICON = icon(<><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>);

export function Sidebar({ page, go, today, tracking, syncedAt, me, rank }: { page: Page; go: (route: Route) => void; today: Today | null; tracking: Tracking; syncedAt: string | null; me: string | null; rank: number | null }) {
  // `/you` is the Tokens page under its older address; a profile sits over the leaderboard.
  const current = (target: Page) => page === target || (target === 'tokens' && page === 'you') || (target === 'leaderboard' && page === 'profile') ? 'page' : undefined;
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark" aria-hidden="true" />Tokentracky</div>
    <nav className="nav" aria-label="Primary">
      {NAV.map((item) => <button key={item.page} type="button" className="nav-item" aria-current={current(item.page)} onClick={() => go({ page: item.page })}>{item.icon}{item.label}</button>)}
    </nav>
    <div className="sidebar-spacer" />
    {today && <TodayCard today={today} />}
    <div className="sync"><span className={`dot${tracking === 'collecting' ? ' dot-live' : ''}`} />{tracking === 'collecting' ? `Collecting${syncedAt ? ` · synced ${timeAgo(syncedAt)}` : ''}` : tracking === 'paused' ? 'Paused' : 'Not tracking'}</div>
    <nav className="nav" aria-label="Preferences"><button type="button" className="nav-item" aria-current={current('settings')} onClick={() => go({ page: 'settings' })}>{SETTINGS_ICON}Settings</button></nav>
    <button type="button" className="me" onClick={() => go(me ? { page: 'profile', alias: me } : { page: 'tokens' })}>
      {me ? <Avatar alias={me} /> : <span className="avatar" aria-hidden="true" />}
      <span className="who"><b>{me ?? 'You'}</b>{me ? rank !== null && <span>#{rank} all time</span> : <span>Not on the leaderboard</span>}</span>
    </button>
  </aside>;
}

export function TodayCard({ today }: { today: Today }) {
  const max = Math.max(0, ...today.spark);
  return <div className="today-card">
    <div className="row"><span className="label">Today</span><span className="faint num">{formatCost(today.costMicrousd)}</span></div>
    <div className="value" title={`${formatExact(today.tokens)} tokens`}>{formatCompact(today.tokens)}</div>
    <div className="spark" aria-hidden="true">{today.spark.map((tokens, index) => <span key={index} style={{ height: `${max ? (tokens / max) * 100 : 0}%` }} />)}</div>
  </div>;
}
