import { useEffect, useState } from 'react';
import type { HourBreakdownRow, MenuOverview, SessionSummary, UsageSummary } from '@tokentracky/core';
import type { ApiClient, LocalStatus } from '../api';
import { errorText, formatCompact, formatCost, formatExact, formatShare, shortDay, timeAgo, toolLabel } from '../format';
import { heatLevels } from '../Heatmap';
import { addDays, fillRange, hourList, utcToday } from '../ranges';
import { usageRevision } from '../refresh';
import { Avatar, ToolIcon } from '../ui';
import { ICONS } from './icons';
import { changeVsPrevious, recentTotals } from './insights';
import './personal.css';

/** The days the popover's summary covers: its 7-week grid. */
const WINDOW = 49;
const TODAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000, QUARTER_MS = 900_000;
/** A period's cost as the mockup writes it: whole dollars from $100, cents below; unknown stays unknown. */
const periodCost = (micro: number | null) => micro !== null && micro >= 100e6 ? `$${formatExact(Math.round(micro / 1e6))}` : formatCost(micro);

/** Today's 24 UTC hours: each hour's tokens, and whether it has passed, is under way or is still to come. */
export function hourBars(rows: HourBreakdownRow[], today: string, now: number): Array<{ hour: string; tokens: number; when: 'past' | 'now' | 'later' }> {
  const since = Date.parse(`${today}T00:00:00Z`);
  const tokens = new Map<string, number>();
  for (const row of rows) tokens.set(row.hour, (tokens.get(row.hour) ?? 0) + row.tokens);
  const current = Math.floor((now - since) / HOUR_MS);
  return hourList({ since, until: since + DAY_MS }).map((hour, index) => ({ hour, tokens: tokens.get(hour) ?? 0, when: index < current ? 'past' : index === current ? 'now' : 'later' }));
}

/** Yesterday from its UTC midnight to this time of day, rounded up to the quarter hour the API counts in. */
export function sameTimeYesterday(today: string, now: number): { since: number; until: number } {
  const since = Date.parse(`${today}T00:00:00Z`) - DAY_MS;
  return { since, until: Math.ceil(now / QUARTER_MS) * QUARTER_MS - DAY_MS };
}

/** The current streak from a summary of the last `window` days, and the day it began. One that fills the window may have begun earlier. */
export function streakOf(streak: number, daily: Array<{ day: string; tokens: number }>, today: string, window = WINDOW): { days: number; atLeast: boolean; since: string | null } {
  if (streak <= 0) return { days: 0, atLeast: false, since: null };
  // The streak ends today, or yesterday while today has no tokens yet.
  const end = daily.some((point) => point.day === today && point.tokens > 0) ? today : addDays(today, -1);
  return { days: streak, atLeast: streak >= window, since: addDays(end, 1 - streak) };
}

/** The `count` most recently used sessions, newest first. */
export function latestSessions(sessions: SessionSummary[], count: number): SessionSummary[] {
  return [...sessions].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')).slice(0, count);
}

const projectName = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No project';

/** The menu bar popover: today, the periods, this month's tools, the streak, recent sessions and the three actions. It has no shell and a transparent page, so the window's vibrancy shows through. */
export function Popover({ api, status }: { api: ApiClient; status: LocalStatus | null }) {
  const [overview, setOverview] = useState<MenuOverview | null>(null);
  const [recent, setRecent] = useState<UsageSummary | null>(null);
  const [month, setMonth] = useState<UsageSummary | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [hours, setHours] = useState<HourBreakdownRow[] | null>(null);
  const [yesterday, setYesterday] = useState<number | null>(null);
  const [busy, setBusy] = useState<'refresh' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const today = utcToday();
  useEffect(() => {
    const { documentElement: root, body } = document;
    const before = [root.style.background, body.style.background];
    root.style.background = 'transparent'; body.style.background = 'transparent';
    return () => { root.style.background = before[0]!; body.style.background = before[1]!; };
  }, []);
  // Six reads and nothing else: the overview, the last 49 days (grid, streak, today's and the week's cost), this month (tool mix and cost), a week of
  // sessions, today's hours, and yesterday to this time for today's change.
  const revision = usageRevision(status);
  useEffect(() => {
    let live = true;
    const since = Date.parse(`${today}T00:00:00Z`);
    Promise.all([api.localOverview(), api.localSummary({ from: addDays(today, 1 - WINDOW), to: today }), api.localSummary({ from: `${today.slice(0, 8)}01`, to: today }), api.localSessions({ days: 7 }),
      api.localHours({ since, until: since + DAY_MS }), api.localSummary(sameTimeYesterday(today, Date.now()))])
      .then(([nextOverview, nextRecent, nextMonth, nextSessions, nextHours, nextYesterday]) => {
        if (!live) return;
        setOverview(nextOverview); setRecent(nextRecent); setMonth(nextMonth); setSessions(nextSessions.items); setHours(nextHours.items); setYesterday(nextYesterday.tokens); setError(null);
      })
      .catch((value: unknown) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [api, today, revision, reloads]);
  const act = async (name: 'refresh' | 'pause', action: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    try { await action(); } catch (value) { setError(errorText(value)); } finally { setBusy(null); }
  };
  const fail = (action: () => Promise<unknown>) => () => { action().catch((value: unknown) => setError(errorText(value))); };
  return <PopoverPanel overview={overview} recent={recent} month={month} sessions={sessions} hours={hours} yesterday={yesterday} status={status} today={today} now={Date.now()} busy={busy} error={error}
    onGear={fail(() => api.gearMenu())} onOpen={fail(() => api.openDashboard('/'))} onSessions={fail(() => api.openDashboard('/tokens'))}
    onRefresh={() => void act('refresh', async () => { await api.refresh(); setReloads((value) => value + 1); })}
    onPause={() => void act('pause', async () => { if (!overview) return; const { paused } = await api.setCollectionPaused(!overview.paused); setOverview({ ...overview, paused }); })} />;
}

export function PopoverPanel({ overview, recent, month, sessions, hours, yesterday, status, today, now, busy, error, onGear, onOpen, onSessions, onRefresh, onPause }: {
  overview: MenuOverview | null; recent: UsageSummary | null; month: UsageSummary | null; sessions: SessionSummary[] | null;
  hours: HourBreakdownRow[] | null; yesterday: number | null; status: LocalStatus | null; today: string; now: number;
  busy: 'refresh' | 'pause' | null; error: string | null; onGear: () => void; onOpen: () => void; onSessions: () => void; onRefresh: () => void; onPause: () => void;
}) {
  const alias = overview?.alias ?? status?.alias ?? null;
  const days = recent ? fillRange(recent.daily, { from: addDays(today, 1 - WINDOW), to: today }) : null;
  const bars = hours ? hourBars(hours, today, now) : [];
  const max = Math.max(1, ...bars.map((bar) => bar.tokens));
  const current = bars.find((bar) => bar.when === 'now');
  const soFar = bars.reduce((sum, bar) => sum + bar.tokens, 0);
  const change = hours && yesterday !== null ? changeVsPrevious(soFar, yesterday) : null;
  const todayCost = recent ? recent.daily.find((point) => point.day === today)?.costMicrousd ?? 0 : undefined;
  // Monday's UTC day starts the week.
  const week = recent && recentTotals(recent.daily, today, ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1);
  const levels = days ? heatLevels(days.map((point) => point.tokens)) : [];
  const streak = recent && days ? streakOf(recent.activity.currentStreak, days, today) : null;
  const tools = (month?.byTool ?? []).filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const monthTotal = tools.reduce((sum, item) => sum + item.tokens, 0);
  const paused = overview?.paused ?? false;
  const sources = status?.sources.filter((source) => source.enabled).length ?? 0;
  const synced = status?.cloudLinked && status.lastSyncAt ? `Synced ${timeAgo(status.lastSyncAt)}` : `Refreshed ${timeAgo(overview?.refreshedAt ?? status?.lastRefreshAt)}`;
  return <div className="mac po-root">
    <div className="po-panel">
      <div className="po-head">
        {alias ? <Avatar alias={alias} /> : <span className="avatar" aria-hidden="true" />}
        <div className="po-who"><b>{alias ?? 'Not on the leaderboard'}</b><span>{overview?.rank ? `#${formatExact(overview.rank)} this week` : alias ? 'No rank this week yet' : 'Join from Settings'}</span></div>
        <button type="button" className="po-icon-btn" aria-label="Menu" onClick={onGear}>{ICONS.gear}</button>
      </div>
      <div className="po-body">
        {error && <p className="po-error" role="alert">{error}</p>}
        <div className="po-hero">
          <div className="po-hero-top">
            <span className="po-label">Today · {TODAY_LABEL.format(new Date(`${today}T00:00:00Z`))} · UTC</span>
            {change !== null && <span className={`po-delta${change < 0 ? ' down' : ''}`} title="Today so far against yesterday up to this time">{change < 0 ? ICONS.arrowDown : ICONS.arrowUp}{change < 0 ? '−' : '+'}{Math.abs(Math.round(change))}% vs this time yesterday</span>}
          </div>
          <div className="po-hero-num">
            <div><span className="po-hn" title={overview ? `${formatExact(overview.today)} tokens` : undefined}>{overview ? formatCompact(overview.today) : '—'}</span><span className="po-unit">tokens</span></div>
            <div className="po-cost"><b>{todayCost === undefined ? '—' : formatCost(todayCost)}</b><span>est. cost</span></div>
          </div>
          {bars.length > 0 && <div className="po-hours">
            <div className="po-bars" aria-hidden="true">{bars.map((bar) => <i key={bar.hour} className={bar.when === 'now' ? 'now' : bar.when === 'later' ? 'f' : bar.tokens ? undefined : 'z'}
              style={bar.tokens ? { height: `${Math.max(6, (bar.tokens / max) * 100)}%` } : undefined} title={`${HOUR_LABEL.format(new Date(bar.hour))}: ${formatCompact(bar.tokens)} tokens`} />)}</div>
            {current && <div className="po-now" style={{ left: `calc(${bars.indexOf(current)} * (100% + 3px) / 24)` }}>{HOUR_LABEL.format(new Date(current.hour))} · <b>{formatCompact(current.tokens)}</b> so far</div>}
            <div className="po-axis" aria-hidden="true">{[0, 6, 12, 18].map((index) => <span key={index}>{HOUR_LABEL.format(new Date(bars[index]!.hour)).slice(0, 2)}</span>)}</div>
          </div>}
        </div>
        <div className="po-sep" />
        {/* Later: the all-time cost, once the overview carries costs. */}
        <div className="po-periods">
          <div className="po-prow"><span>This week</span><b>{overview ? formatCompact(overview.week) : '—'}</b><em>{week ? periodCost(week.costMicrousd) : ''}</em></div>
          <div className="po-prow"><span>This month</span><b>{overview ? formatCompact(overview.month) : '—'}</b><em>{month ? periodCost(month.costMicrousd) : ''}</em></div>
          <div className="po-prow"><span>All time</span><b>{overview ? formatCompact(overview.allTime) : '—'}</b><em /></div>
        </div>
        {tools.length > 0 && <>
          <div className="po-sep" />
          <div className="po-mix">
            <div className="po-row-head"><span>Tool mix</span><span>This month</span></div>
            <div className="m-bar" role="img" aria-label={tools.map((item) => `${toolLabel(item.tool)} ${formatShare(item.tokens, monthTotal)}`).join(', ')}>
              {tools.map((item) => <span key={item.tool} style={{ ['--c' as string]: `var(--tool-${item.tool})`, width: `${(item.tokens / monthTotal) * 100}%` }} />)}
            </div>
            <div className="po-legend" aria-hidden="true">{tools.map((item) => <span key={item.tool}><ToolIcon id={item.tool} />{toolLabel(item.tool)} <em>{formatShare(item.tokens, monthTotal)}</em></span>)}</div>
          </div>
        </>}
        {streak && <>
          <div className="po-sep" />
          <div className="po-streak">
            <span className="po-tile flame">{ICONS.flame}</span>
            <div className="po-txt">
              <b>{streak.days ? `${streak.atLeast ? `${streak.days}+` : streak.days}-day streak` : 'No streak yet'}</b>
              <span>{streak.since ? streak.atLeast ? 'Active every day for seven weeks' : `Active every day since ${shortDay(streak.since)}` : 'Use an AI coding tool today to start one'}</span>
            </div>
            <div className="po-weeks" role="img" aria-label="Activity over the last 7 weeks">{levels.map((level, index) => <i key={index} className={`l${level}${index === levels.length - 1 ? ' today' : ''}`} />)}</div>
          </div>
        </>}
        {sessions && sessions.length > 0 && <>
          <div className="po-sep" />
          <div className="po-sessions">
            <div className="po-sec-head"><span>Recent sessions</span><button type="button" onClick={onSessions}>View all{ICONS.chevronRight}</button></div>
            {latestSessions(sessions, 3).map((session) => <div key={`${session.tool}:${session.id}`} className="po-session">
              <span className="po-tile" style={{ ['--c' as string]: `var(--tool-${session.tool})` }}><ToolIcon id={session.tool} /></span>
              <div className="po-txt"><b title={session.project ?? undefined}>{projectName(session.project)}</b><span>{session.model} · {timeAgo(session.lastUsedAt)}</span></div>
              <span className="po-tok" title={`${formatExact(session.tokens)} tokens`}>{formatCompact(session.tokens)}</span>
            </div>)}
          </div>
        </>}
      </div>
      <div className="po-status">
        <span className={`po-state${paused ? ' paused' : ''}`}>{paused ? ICONS.pause : ICONS.synced}</span>
        {synced} · {paused ? 'Paused' : status?.collecting ? 'Collecting' : 'Not tracking'}
        <span className="po-r">{sources} {sources === 1 ? 'source' : 'sources'}</span>
      </div>
      <div className="po-actions">
        <button type="button" className="po-act" onClick={onOpen}>{ICONS.dashboard}Open dashboard</button>
        <button type="button" className="po-act" disabled={busy !== null || paused || status?.refreshing} onClick={onRefresh}>{ICONS.refresh}{busy === 'refresh' || status?.refreshing ? 'Refreshing…' : 'Refresh now'}</button>
        <button type="button" className={`po-act${paused ? ' warm' : ''}`} disabled={busy !== null || !overview} onClick={onPause}>{paused ? ICONS.play : ICONS.pause}{paused ? 'Resume' : 'Pause'}</button>
      </div>
    </div>
  </div>;
}
