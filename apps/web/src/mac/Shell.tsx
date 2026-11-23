import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MyClub, PublicProfile, UsageSummary } from '@tokentracky/core';
import { ClubMark } from '../ClubMark';
import type { ApiClient, LocalStatus } from '../api';
import { formatCompact, formatCost, formatExact, timeAgo } from '../format';
import { addDays, fillRange, utcToday } from '../ranges';
import { usageRevision } from '../refresh';
import type { Route } from '../route';
import { Avatar, JUMP_KEYS, SearchIcon, useRank } from '../ui';
import { daysToPass, gapToNext, rankMove, resetText, windowStartOf } from './leaderboard';

type Page = Route['page'] | 'connect';
export type Tracking = 'collecting' | 'paused' | 'off';
export interface Today { tokens: number; costMicrousd: number | null; spark: number[] }

// A profile opens as a dialog over the leaderboard, so the frame still shows the leaderboard.
const TITLES: Partial<Record<Page, string>> = { leaderboard: 'Leaderboard', tokens: 'Tokens', you: 'Tokens', achievements: 'Achievements', settings: 'Settings', profile: 'Leaderboard', join: 'How it works', missing: 'Page not found',
  town: 'Town', 'town-map': 'Town map', 'town-visit': 'Town', clubs: 'Clubs', club: 'Clubs' };

/** Sent after joining or leaving a club anywhere in the app, so the sidebar lists your clubs again. */
export const CLUBS_CHANGED = 'tokentracky:clubs-changed';
export const clubsChanged = () => window.dispatchEvent(new Event(CLUBS_CHANGED));

/** Where a page's controls go: the window toolbar, before the jump button. */
const ToolbarSlot = createContext<HTMLElement | null>(null);

/** A page's controls, placed in the window toolbar as the mockups have them. A page rendered outside the frame keeps them at its top. */
export function ToolbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot);
  return slot ? createPortal(children, slot) : <div className="m-page-actions">{children}</div>;
}

/** Today's UTC totals and the last 14 days for the sidebar, quiet days as zero. */
export function todayOf(daily: UsageSummary['daily'], now = new Date()): Today {
  const day = utcToday(now);
  const point = daily.find((entry) => entry.day === day);
  return { tokens: point?.tokens ?? 0, costMicrousd: point ? point.costMicrousd : 0, spark: fillRange(daily, { from: addDays(day, -13), to: day }).map((entry) => entry.tokens) };
}

/** The local app's frame: sidebar, toolbar and a scrolling content pane. */
export function MacShell({ api, status, me, page, path, go, onPalette, children }: { api: ApiClient; status: LocalStatus | null; me: string | null; page: Page; path: string; go: (route: Route) => void; onPalette: () => void; children: ReactNode }) {
  const [today, setToday] = useState<Today | null>(null);
  // Your clubs under Clubs in the sidebar, read again when you join or leave one (the address changes) and after each sync.
  const [clubs, setClubs] = useState<MyClub[]>([]);
  const [joined, setJoined] = useState(0);
  useEffect(() => {
    const changed = () => setJoined((value) => value + 1);
    window.addEventListener(CLUBS_CHANGED, changed);
    return () => window.removeEventListener(CLUBS_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!me) { setClubs([]); return; }
    let live = true;
    api.myClubs().then((value) => { if (live) setClubs(value.clubs); }).catch(() => {});
    return () => { live = false; };
  }, [api, me, path, status?.lastSyncAt, joined]);
  const rank = useRank(api, me);
  const week = useWeek(api, me, status?.lastSyncAt ?? null);
  const content = useRef<HTMLDivElement>(null);
  // Set as the toolbar mounts, before the first paint, so a page's controls never show at its top first.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
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
    <Sidebar page={page} path={path} go={go} today={today} week={week} tracking={tracking} syncedAt={status?.lastSyncAt ?? null} me={me} rank={rank} clubs={clubs} />
    <div className="main">
      <header className="toolbar">
        <span className="toolbar-title">{TITLES[page]}</span>
        <div className="toolbar-right">
          <div className="toolbar-actions" ref={setSlot} />
          <button type="button" className="btn ghost sm" aria-label="Jump to a page or project" aria-keyshortcuts="Meta+K Control+K" onClick={onPalette}><SearchIcon /><span className="kbd">{JUMP_KEYS}</span></button>
        </div>
      </header>
      <div className="content" ref={content}><ToolbarSlot.Provider value={slot}>{children}</ToolbarSlot.Provider></div>
    </div>
  </div>;
}

const icon = (paths: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
const CLUBS_ICON = icon(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.2a5 5 0 0 1 5.5 5.3" /></>);
const NAV = [
  { page: 'leaderboard', label: 'Leaderboard', icon: icon(<><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></>) },
  { page: 'clubs', label: 'Clubs', icon: CLUBS_ICON },
  { page: 'tokens', label: 'Tokens', icon: icon(<><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>) },
  { page: 'achievements', label: 'Achievements', icon: icon(<><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" /></>) },
  { page: 'town', label: 'Town', icon: icon(<><path d="M3 21h18" /><path d="M5 21V11l4-3 4 3v10" /><path d="M13 21v-6h6v6" /><path d="M16 15v-3" /><path d="M9 21v-4" /><path d="M9 8V4l3 1.5L9 7" /></>) },
] as const;
const SETTINGS_ICON = icon(<><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>);

export function Sidebar({ page, path = '', go, today, week = null, tracking, syncedAt, me, rank, clubs = [] }: { page: Page; path?: string; go: (route: Route) => void; today: Today | null; week?: PublicProfile[] | null; tracking: Tracking; syncedAt: string | null; me: string | null; rank: number | null; clubs?: MyClub[] }) {
  // `/you` is the Tokens page under its older address; a profile sits over the leaderboard.
  const current = (target: Page) => page === target || (target === 'tokens' && page === 'you') || (target === 'leaderboard' && page === 'profile')
    || (target === 'town' && (page === 'town-map' || page === 'town-visit')) ? 'page' : undefined;
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark" aria-hidden="true" />Tokentracky</div>
    <nav className="nav" aria-label="Primary">
      {NAV.map((item) => <div key={item.page} className="nav-group">
        <button type="button" className="nav-item" aria-current={item.page === 'clubs' ? page === 'clubs' ? 'page' : undefined : current(item.page)} onClick={() => go(item.page === 'clubs' ? { page: 'clubs', tab: 'mine' } : { page: item.page })}>{item.icon}{item.label}</button>
        {item.page === 'clubs' && clubs.length > 0 && <div className="nav-clubs">{clubs.map(({ club, you, matchup }) => <button key={club.slug} type="button" className="nav-item nav-club"
          aria-current={page === 'club' && (path === `/c/${club.slug}` || path.startsWith(`/c/${club.slug}/`)) ? 'page' : undefined} onClick={() => go({ page: 'club', slug: club.slug, tab: 'board' })}><ClubMark mark={club.mark} slug={club.slug} /><span>{club.name}</span>
          {matchup && <i className={`nav-club-fight ${matchup.perMember > matchup.opponentPerMember ? 'lead' : matchup.perMember < matchup.opponentPerMember ? 'trail' : 'level'}`} title={`${matchup.perMember > matchup.opponentPerMember ? 'Leading' : matchup.perMember < matchup.opponentPerMember ? 'Trailing' : 'Level with'} ${matchup.opponent.name}`} />}
          {you.rank && <span className={`nav-club-rank${you.rank <= 3 ? ` p${you.rank}` : ''}`} title={`#${formatExact(you.rank)} of ${formatExact(you.ranked)} this week`}>#{formatExact(you.rank)}</span>}</button>)}</div>}
      </div>)}
    </nav>
    <div className="sidebar-spacer" />
    {me && week && <WeekCard rows={week} me={me} />}
    {today && <TodayCard today={today} />}
    <div className="sync"><span className={`dot${tracking === 'collecting' ? ' dot-live' : ''}`} />{tracking === 'collecting' ? `Collecting${syncedAt ? ` · synced ${timeAgo(syncedAt)}` : ''}` : tracking === 'paused' ? 'Paused' : 'Not tracking'}</div>
    <nav className="nav" aria-label="Preferences"><button type="button" className="nav-item" aria-current={current('settings')} onClick={() => go({ page: 'settings' })}>{SETTINGS_ICON}Settings</button></nav>
    <button type="button" className="me" onClick={() => go(me ? { page: 'profile', alias: me } : { page: 'tokens' })}>
      {me ? <Avatar alias={me} /> : <span className="avatar" aria-hidden="true" />}
      <span className="who"><b>{me ?? 'You'}</b>{me ? rank !== null && <span>#{rank} all time</span> : <span>Not on the leaderboard</span>}</span>
    </button>
  </aside>;
}

/** You and the builders either side of you on this week's board, reloaded after each sync; null until loaded or off the board. */
function useWeek(api: ApiClient, me: string | null, syncedAt: string | null): PublicProfile[] | null {
  const [rows, setRows] = useState<PublicProfile[] | null>(null);
  useEffect(() => {
    if (!me) { setRows(null); return; }
    let live = true;
    api.leaderboardAround(me, 'week').then((value) => { if (live) setRows(value.items); }).catch(() => {});
    return () => { live = false; };
  }, [api, me, syncedAt]);
  return rows;
}

/** Your week on every page: rank and its move, tokens, when the week resets and the gap to your rival, the builder directly above you. */
export function WeekCard({ rows, me, now = Date.now() }: { rows: readonly PublicProfile[]; me: string; now?: number }) {
  const mine = rows.find((row) => row.alias === me);
  if (!mine) return null;
  const ahead = gapToNext(rows, me);
  const days = ahead && daysToPass(ahead.tokens, mine.daily, ahead.ahead.daily);
  const reset = resetText('week', windowStartOf('week', now), now);
  const move = rankMove(mine);
  return <div className="week-card">
    <div className="row"><span className="label">This week</span>{reset && <span className="faint">resets in {reset.left}</span>}</div>
    <div className="week-main"><span className="week-rank">#{formatExact(mine.rank)}</span>
      {move.kind === 'up' || move.kind === 'down' ? <span className={`week-mv ${move.kind === 'up' ? 'rise' : 'fall'}`}>{move.kind === 'up' ? '▲' : '▼'}{move.by}</span> : null}
      <span className="week-tokens" title={`${formatExact(mine.tokens)} tokens`}>{formatCompact(mine.tokens)}</span></div>
    <div className="week-chase">{ahead ? <>{formatCompact(ahead.tokens)} to pass {ahead.ahead.alias}{days ? ` · ~${formatExact(days)}d` : ''}</> : 'You lead this week'}</div>
  </div>;
}

export function TodayCard({ today }: { today: Today }) {
  const max = Math.max(0, ...today.spark);
  return <div className="today-card">
    <div className="row"><span className="label">Today</span><span className="faint num">{formatCost(today.costMicrousd)}</span></div>
    <div className="value" title={`${formatExact(today.tokens)} tokens`}>{formatCompact(today.tokens)}</div>
    <div className="spark" aria-hidden="true">{today.spark.map((tokens, index) => <span key={index} style={{ height: `${max ? (tokens / max) * 100 : 0}%` }} />)}</div>
  </div>;
}
