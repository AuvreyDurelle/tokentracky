import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { CommunityStats, LeaderboardPeriod, ProfileStats, PublicProfile, ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from '../api';
import { errorText, formatCompact, formatCost, formatCostCompact, formatExact, shortDay, toolLabel, topPercent } from '../format';
import { Avatar, Empty, Loading, Notice, SearchIcon, ToolIcon } from '../ui';
import { monotonePath } from './chart';
import { MAIN_TOOLS, daysToPass, gapToNext, lastSeven, pagerItems, rankMove, resetText } from './leaderboard';
import { useLoad } from './load';
import { ToolbarActions } from './Shell';
import {countRatio, countShare, cumulativeMonths, sharedCounts, sumCounts} from '../public-counts';

const PAGE_SIZE = 12;
const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [{ value: '24h', label: '24h' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
const PHRASE: Record<LeaderboardPeriod, string> = { '24h': 'Last 24 hours', week: 'This week', month: 'This month', all: 'All time' };
const UPDATED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const tokensTitle = (tokens: number | bigint) => `${formatExact(tokens)} tokens`;
const round = (value: number) => Math.round(value * 10) / 10;

/** The Mac app's leaderboard: community totals, your position and the rankings. */
export function LeaderboardView({ api, me, canJoin, syncedAt, site, onProfile, onJoin }: { api: ApiClient; me: string | null; canJoin: boolean; syncedAt: string | null; site: string | null; onProfile: (alias: string) => void; onJoin: () => void }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = search.trim();
  useEffect(() => { setPage(1); }, [period, query]);
  // Each sync can move ranks, so everything reloads after one.
  const community = useLoad(() => api.community(), [api, syncedAt]);
  const list = useLoad(() => api.leaderboard(period, 'all', query, page, PAGE_SIZE), [api, period, query, page, syncedAt], query ? 250 : 0);
  // You and the builders either side of you in the shown window: your rival is the one above. Below the first page,
  // they follow a gap row.
  const around = useLoad(me ? () => api.leaderboardAround(me, period).then((value) => ({ period, items: value.items })) : null, [api, me, period, syncedAt]);
  // Your rank in the other windows: the profile's week, month and all time, and the last 24 hours on their own.
  const periods = useLoad(me ? () => api.profileStats(me).then((stats) => stats.periods) : null, [api, me, syncedAt]);
  const lastDay = useLoad(me && period !== '24h' ? () => api.leaderboardAround(me, '24h') : null, [api, me, period, syncedAt]);
  // Like the rankings, the builders around you show only under the period they were loaded for.
  const neighbours = around.value?.period === period ? around.value.items : [];

  const unavailable = !list.value && list.error instanceof ApiError && list.error.code === 'CLOUD_UNAVAILABLE';
  // Rankings from the period being loaded are never shown under the new period's name.
  const board = list.value?.period === period ? list.value : null;
  const mine = neighbours.find((item) => item.alias === me) ?? null;
  const rival = mine && gapToNext(neighbours, mine.alias);
  const ranks = otherRanks(period, periods.value, period === '24h' ? null : lastDay.value?.items.find((item) => item.alias === me)?.rank ?? null);
  return <div className="m-page m-lb">
    <div className="page-head">
      <div>
        <h1 className="m-page-title">Leaderboard</h1>
        <p className="m-page-sub">{PHRASE[period]}{board && <><span className="sep" />Updated {UPDATED.format(new Date(board.updatedAt))}</>}</p>
      </div>
      <ToolbarActions>
        <label className="lb-search"><SearchIcon /><span className="sr-only">Search builders</span>
          <input type="search" placeholder="Search builders" value={search} maxLength={30} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="m-seg" role="group" aria-label="Period">
          {PERIODS.map((option) => <button key={option.value} type="button" className={option.value === period ? 'on' : undefined} aria-pressed={option.value === period} onClick={() => setPeriod(option.value)}>{option.label}</button>)}
        </div>
      </ToolbarActions>
    </div>

    {unavailable ? <section className="m-card lb-empty"><Empty title="Leaderboard not connected">This app has no leaderboard server configured. Your usage is still tracked privately on the Tokens page.</Empty></section> : <>
      {community.value ? <CommunityHero stats={community.value} site={site} /> : <section className="m-card lb-hero">{community.error ? <Notice tone="error">Could not load the community totals: {errorText(community.error)}</Notice> : <Loading>Loading the community…</Loading>}</section>}
      {mine ? <RivalStrip period={period} mine={mine} rows={neighbours} builders={board?.builders ?? 0} ranks={ranks} site={site} onProfile={onProfile} />
        : !me && canJoin && <JoinStrip onJoin={onJoin} />}
      <section className="m-card lb-board" aria-busy={list.loading}>
        {list.error !== null && <div className="lb-note"><Notice tone="error">Could not load the rankings: {errorText(list.error)}</Notice></div>}
        {!board ? list.error === null && <Loading>Loading rankings…</Loading>
          : board.total === 0 ? query ? <Empty title="No builders match">Try a different name.</Empty>
            : <Empty title="No one’s on the board yet" action={canJoin && <button type="button" className="m-btn primary" onClick={onJoin}>Join the leaderboard</button>}>Be the first to put your tokens up.</Empty>
          : <Board period={period} windowStart={board.windowStart} rows={board.items} neighbours={page === 1 && !query ? neighbours : []} me={me} rival={rival?.ahead.alias ?? null} total={board.total} page={page} pageSize={board.pageSize} loading={list.loading} onPage={setPage} onProfile={onProfile} />}
      </section>
    </>}
  </div>;
}

/** Community totals: the all-time figures, the tool split, a 30-day trend, the week's growth and the last 24 hours. */
export function CommunityHero({ stats, site = null }: { stats: CommunityStats; site?: string | null }) {
  const counts = sharedCounts(stats);
  const week = sumCounts(counts.trend.slice(-7).map(point => point.tokens));
  const before = sumCounts(counts.trend.slice(-14, -7).map(point => point.tokens));
  const change = before > 0n && counts.trend.length >= 14 ? week - before : null;
  return <section className="m-card lb-hero" aria-label="Community totals">
    <div className="hero-main">
      <div>
        <div className="hero-eyebrow"><div className="m-eyebrow"><span className="live-dot" />Community total · All time</div>
          {site && <a className="lb-hero-link" href={`${site}/community`} target="_blank" rel="noopener noreferrer">Community stats <ExternalIcon /></a>}</div>
        <div className="hero-figures">
          <div><div className="hero-num" title={tokensTitle(counts.totalTokens)}>{formatCompact(counts.totalTokens)}</div><div className="hero-cap">tokens used by everyone</div></div>
          <div className="hero-divider" />
          <div><div className="hero-num second">{formatExact(stats.builders)}</div><div className="hero-cap">builders on the board</div></div>
        </div>
        <ToolShare totals={counts.toolTotals} />
      </div>
      {counts.monthly ? <TrendArea points={cumulativeMonths(counts.totalTokens, counts.monthly)} title="Community tokens, cumulative" note="Last 12 months"
        labels={counts.monthly.map((point, index) => ({ at: index + 0.5, text: MONTH.format(new Date(`${point.month}-01T00:00:00Z`)) }))}
        aria={`Community tokens to date over the last 12 months, now ${formatExact(counts.totalTokens)}`} />
        : <TrendArea points={counts.trend.map((point) => point.tokens)} title="Community tokens per day" note={`Last ${counts.trend.length} days · UTC`}
          labels={counts.trend.flatMap((point, index) => (counts.trend.length - 1 - index) % 7 === 0 ? [{ at: index, text: shortDay(point.day) }] : [])}
          aria={`Community tokens per UTC day, last ${counts.trend.length} days, ending at ${formatExact(counts.trend.at(-1)?.tokens ?? 0n)}`} />}
    </div>
    <div className="m-stat-strip hero-stats">
      <div><div className="m-label">Added this week</div><div className="m-stat-value" title={tokensTitle(week)}>+{formatCompact(week)}</div>
        <div className={`sub${change !== null && change >= 0n ? ' up' : ''}`}>{change === null ? 'last 7 days' : `${change >= 0n ? '↑' : '↓'} ${countShare(change < 0n ? -change : change, before)} vs last week`}</div></div>
      <div><div className="m-label">New builders</div><div className="m-stat-value">+{formatExact(stats.newBuilders)}</div><div className="sub">joined this week</div></div>
      <div><div className="m-label">Est. community spend</div><div className="m-stat-value" title={formatCost(counts.totalCostMicrousd)}>{counts.totalCostMicrousd === null ? '—' : formatCostCompact(counts.totalCostMicrousd)}</div><div className="sub">at API list prices</div></div>
      <LastDay stats={stats} />
    </div>
  </section>;
}

/** The community's last 24 whole UTC hours against yesterday's UTC day from the same builders, once the server sends them. */
function LastDay({ stats }: { stats: CommunityStats }) {
  const { last24hTokens: last, yesterdayTokens: before } = stats;
  const change = last !== undefined && before ? last - before : null;
  return <div><div className="m-label">Last 24 hours</div><div className="m-stat-value" title={last === undefined ? undefined : tokensTitle(last)}>{last === undefined ? '—' : formatCompact(last)}</div>
    <div className={`sub${change !== null && change >= 0 ? ' up' : ''}`}>{change === null ? 'tokens, all tools' : `${change >= 0 ? '↑' : '↓'} ${countShare(BigInt(Math.abs(change)), BigInt(before!))} vs yesterday`}</div></div>;
}

const ExternalIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>;

export function ToolShare({ totals }: { totals: Partial<Record<ToolId, bigint>> }) {
  const parts = [...MAIN_TOOLS.map((id) => ({ id: id as ToolId | null, label: toolLabel(id), tokens: totals[id] ?? 0n })), { id: null, label: 'Other', tokens: sumCounts(Object.entries(totals).filter(([tool]) => !(MAIN_TOOLS as readonly string[]).includes(tool)).map(([, tokens]) => tokens ?? 0n)) }].filter((part) => part.tokens > 0n);
  const sum = sumCounts(parts.map(part => part.tokens));
  if (!sum) return null;
  const color = (id: ToolId | null) => id ? `var(--tool-${id})` : 'var(--text-4)';
  return <div className="hero-mix">
    <div className="m-bar" role="img" aria-label={parts.map((part) => `${part.label} ${countShare(part.tokens, sum)} (${tokensTitle(part.tokens)})`).join(', ')}>
      {parts.map((part) => <span key={part.label} style={{ width: `${countRatio(part.tokens, sum) * 100}%`, '--c': color(part.id) } as CSSProperties} />)}
    </div>
    <div className="lb-legend" aria-hidden="true">{parts.map((part) => <span key={part.label}>{part.id ? <ToolIcon id={part.id} /> : <i className="other-dot" />}{part.label} <b>{countShare(part.tokens, sum)}</b></span>)}</div>
  </div>;
}

// The hero chart's frame (viewBox units, one per pixel): the plot runs from x 4 to 8 short of the chart's width and from y 18 down to the baseline at 158.
const H = 188, LEFT = 4, TOP = 18, BASE = 158;
/** An area over evenly spaced points, with `labels` at fractional point positions under it. Drawn at the width the window gives it, so its labels keep their size. */
export function TrendArea({ points: values, title, note, labels, aria }: { points: bigint[]; title: string; note: string; labels: Array<{ at: number; text: string }>; aria: string }) {
  const [box, W] = useWidth(520);
  if (values.length < 2) return <div className="hero-chart" ref={box} />;
  const RIGHT = W - 8;
  const maximum = values.reduce((max, value) => value > max ? value : max, 1n);
  const top = ((maximum + 3n) / 4n) * 4n;
  const ticks = [0n, top / 4n, top / 2n, top * 3n / 4n, top];
  const y = (tokens: bigint) => BASE - countRatio(tokens, top) * (BASE - TOP);
  const x = (at: number) => round(LEFT + (at / (values.length - 1)) * (RIGHT - LEFT));
  const points = values.map((value, index) => [x(index), round(y(value))] as [number, number]);
  const line = monotonePath(points);
  const [endX, endY] = points.at(-1)!;
  return <div className="hero-chart" ref={box}>
    <div className="hero-chart-head"><span className="m-label">{title}</span><span className="hero-note">{note}</span></div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
      <defs>
        <linearGradient id="lb-hero-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#eceef0" stopOpacity=".22" /><stop offset=".7" stopColor="#eceef0" stopOpacity=".035" /><stop offset="1" stopColor="#eceef0" stopOpacity="0" /></linearGradient>
        <linearGradient id="lb-hero-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#eceef0" stopOpacity=".3" /><stop offset="1" stopColor="#eceef0" /></linearGradient>
      </defs>
      {ticks.slice(1).map((tick) => <g key={tick.toString()}><line x1="0" x2={W} y1={y(tick)} y2={y(tick)} stroke="rgba(255,255,255,.05)" /><text className="axis" x="0" y={y(tick) - 5}>{formatCompact(tick)}</text></g>)}
      <line x1="0" x2={W} y1={BASE} y2={BASE} stroke="rgba(255,255,255,.09)" />
      <path d={`${line} L${RIGHT} ${BASE} L${LEFT} ${BASE} Z`} fill="url(#lb-hero-fill)" />
      <path d={line} fill="none" stroke="url(#lb-hero-line)" strokeWidth="1.8" strokeLinecap="round" />
      <line x1={endX} x2={endX} y1={endY} y2={BASE} stroke="rgba(255,255,255,.22)" strokeDasharray="2 3" />
      <circle cx={endX} cy={endY} r="8" fill="#eceef0" opacity=".1" />
      <circle cx={endX} cy={endY} r="3.5" fill="#f7f8f8" stroke="#0f1011" strokeWidth="1.5" />
      {labels.map((label, index) => <text key={`${label.at}${label.text}`} className="axis" x={x(label.at)} y="180" textAnchor={label.at >= values.length - 1 && index === labels.length - 1 ? 'end' : 'middle'}>{label.text}</text>)}
    </svg>
  </div>;
}

/** An element's width in CSS pixels, kept current as the window resizes; `initial` until it is first measured. */
export function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const RANK_LABEL: Record<LeaderboardPeriod, string> = { '24h': '24h', week: 'Week', month: 'Month', all: 'All time' };

/** Your rank in each window other than the shown one: the profile's week, month and all time, and the last 24 hours. */
export function otherRanks(period: LeaderboardPeriod, periods: ProfileStats['periods'] | null, lastDay: number | null): Array<{ period: LeaderboardPeriod; rank: number | null }> {
  const profile = (window: 'week' | 'month' | 'all') => periods && periods[window].rank > 0 && periods[window].tokens > 0 ? periods[window].rank : null;
  const all: Array<{ period: LeaderboardPeriod; rank: number | null }> = [{ period: '24h', rank: lastDay }, { period: 'week', rank: profile('week') }, { period: 'month', rank: profile('month') }, { period: 'all', rank: profile('all') }];
  return all.filter((entry) => entry.period !== period);
}

/** A rank's move since the end of yesterday; nothing on 24-hour rows, which have no earlier standing. */
function Move({ row, period }: { row: PublicProfile; period: LeaderboardPeriod }) {
  if (period === '24h') return null;
  const move = rankMove(row);
  if (move.kind === 'new') return <span className="lb-mv lb-mv-new">New</span>;
  return <span className={`lb-mv lb-mv-${move.kind}`} title={move.kind === 'same' ? 'No change since yesterday' : `${move.kind === 'up' ? 'Up' : 'Down'} ${move.by} since yesterday`}>{move.kind === 'up' ? `▲${move.by}` : move.kind === 'down' ? `▼${move.by}` : '–'}</span>;
}

/**
 * Your standing in the shown window: your rank and its move, a race against your rival (always the builder directly above
 * you) with the builder below chasing, and your rank in the other windows.
 */
export function RivalStrip({ period, mine, rows, builders, ranks, site, onProfile }: { period: LeaderboardPeriod; mine: PublicProfile; rows: readonly PublicProfile[]; builders: number; ranks: Array<{ period: LeaderboardPeriod; rank: number | null }>; site: string | null; onProfile: (alias: string) => void }) {
  const top = topPercent(mine.rank, builders);
  const ahead = gapToNext(rows, mine.alias);
  const behind = rows.find((row) => row.rank === mine.rank + 1) ?? null;
  // A day's pace means nothing within the last 24 hours.
  const days = ahead && period !== '24h' ? daysToPass(ahead.tokens, mine.daily, ahead.ahead.daily) : null;
  // The three racers sit along the track by their tokens, from the one below at the left to your rival at the right.
  const low = behind?.tokens ?? 0, high = ahead?.ahead.tokens ?? mine.tokens;
  const at = (tokens: number) => high > low ? 10 + ((tokens - low) / (high - low)) * 78 : 50;
  const racers = [behind && { row: behind, x: at(behind.tokens) }, { row: mine, x: ahead ? at(mine.tokens) : 88 }, ahead && { row: ahead.ahead, x: 88 }].filter(Boolean) as Array<{ row: PublicProfile; x: number }>;
  const meX = racers.find((racer) => racer.row === mine)!.x;
  return <section className="you-strip rival-strip" aria-label="Your position">
    <div className="ys-col">
      <span className="ys-k">{PHRASE[period]}</span>
      <div className="ys-rank-row"><span className="ys-rank">#{formatExact(mine.rank)}</span><Move row={mine} period={period} /></div>
      <p className="ys-sub">of {formatExact(builders)}{top !== null && ` · ${top.toLowerCase()}`}</p>
    </div>
    <div className="ys-col">
      <span className="ys-k">{SWORDS}{ahead ? 'Rival · the builder directly above you' : 'You lead this board'}</span>
      <div className="race" aria-hidden="true">
        <div className="track" />
        {behind && <><div className="seg-gap gap-behind" style={{ left: `${at(behind.tokens)}%`, width: `${meX - at(behind.tokens)}%` }} /><span className="gapl gap-behind" style={{ left: `${(at(behind.tokens) + meX) / 2}%` }}>{formatCompact(mine.tokens - behind.tokens)} ahead</span></>}
        {ahead && <><div className="seg-gap gap-ahead" style={{ left: `${meX}%`, width: `${88 - meX}%` }} /><span className="gapl gap-ahead" style={{ left: `${(meX + 88) / 2}%` }}>{formatCompact(ahead.tokens)} to pass</span></>}
        {racers.map(({ row, x }) => <div key={row.alias} className={`racer${row === mine ? ' racer-me' : ''}`} style={{ left: `${x}%` }}>
          <Avatar alias={row.alias} /><span className="lab"><b>{row === mine ? `You · #${formatExact(row.rank)}` : row.alias}</b><span>{row === mine ? formatCompact(row.tokens) : `#${formatExact(row.rank)}`}</span></span>
        </div>)}
      </div>
      <p className="ys-pass">{ahead ? <><b>{formatCompact(ahead.tokens)} to pass {ahead.ahead.alias}</b>{days !== null && <span> · about {days === 1 ? 'a day' : `${formatExact(days)} days`} at your pace</span>}</>
        : behind ? <><b>{formatCompact(mine.tokens - behind.tokens)} ahead of {behind.alias}</b><span> · #{formatExact(behind.rank)}</span></> : <b>Nobody else is on this board yet</b>}</p>
    </div>
    <div className="ys-col ys-side">
      <span className="ys-k">{ranks.map((entry) => RANK_LABEL[entry.period]).join(' · ')}</span>
      <div className="ys-pills">{ranks.map((entry) => <span key={entry.period} className="m-pill">{RANK_LABEL[entry.period]} <b>{entry.rank === null ? '—' : `#${formatExact(entry.rank)}`}</b></span>)}</div>
      <div className="ys-actions">
        <button type="button" className="m-btn" onClick={() => onProfile(mine.alias)}>View profile</button>
        {ahead && site && <a className="m-btn" href={`${site}/vs/${encodeURIComponent(mine.alias)}/${encodeURIComponent(ahead.ahead.alias)}`} target="_blank" rel="noopener noreferrer">{SWORDS}Head to head</a>}
      </div>
    </div>
  </section>;
}

const SWORDS = <svg className="ys-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5" /><path d="m13 19 6-6" /><path d="m16 16 4 4" /><path d="m19 21 2-2" /><path d="M14.5 6.5 18 3h3v3l-3.5 3.5" /><path d="m5 14 4 4" /><path d="m7 17-3 3" /><path d="m3 19 2 2" /></svg>;

export function JoinStrip({ onJoin }: { onJoin: () => void }) {
  return <section className="you-strip you-join" aria-label="Join the leaderboard">
    <div className="you-id"><div className="lb-you-rank">You’re tracking privately</div><div className="you-sub">Join to put your tokens on the board. Projects, prompts and code stay on this Mac.</div></div>
    <button type="button" className="m-btn primary" onClick={onJoin}>Join the leaderboard</button>
  </section>;
}

/** The rankings: when the window resets, one page of rows, then (when you are further down) a gap and the builders around you. */
export function Board({ period = 'all', windowStart = null, rows, neighbours, me, rival = null, total, page, pageSize, loading, onPage, onProfile }: { period?: LeaderboardPeriod; windowStart?: string | null; rows: PublicProfile[]; neighbours: PublicProfile[]; me: string | null; rival?: string | null; total: number; page: number; pageSize: number; loading: boolean; onPage: (page: number) => void; onProfile: (alias: string) => void }) {
  const last = rows.at(-1)?.rank ?? 0;
  const after = rows.some((row) => row.alias === me) ? [] : neighbours.filter((row) => row.rank > last);
  const skipped = after.length ? after[0]!.rank - last - 1 : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  // The last 24 hours carry no cost, and their total is the 24-hour figure.
  const daily = period !== '24h';
  const reset = resetText(period, windowStart);
  const row = (item: PublicProfile, key: string) => <BoardRow key={key} row={item} period={period} me={me} rival={rival} onProfile={onProfile} />;
  return <>
    <div className="lb-head">
      <h2>Rankings</h2><span className="m-badge lb-count">{formatExact(total)}</span>
      {reset && <span className="lb-reset">{CLOCK}{reset.window} · {reset.verb} in <b>{reset.left}</b></span>}
    </div>
    <table className={`m-table lb-table${daily ? '' : ' lb-hours'}`} style={{ opacity: loading ? 0.6 : 1 }}>
      <colgroup><col className="lbc-rank" /><col /><col className="lbc-total" />{daily && <col className="lbc-cost" />}{daily && <col className="lbc-24h" />}<col className="lbc-spark" /></colgroup>
      <thead><tr>
        <th scope="col" className="l">Rank</th>
        <th scope="col" className="l">Builder</th>
        <th scope="col" className="sorted" aria-sort="descending">Tokens <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg></th>
        {daily && <th scope="col">Est. cost</th>}
        {daily && <th scope="col" title="Tokens in the last 24 whole hours, UTC">24h</th>}
        <th scope="col">{daily ? '7 days' : 'By hour'}</th>
      </tr></thead>
      <tbody>
        {rows.map((item) => row(item, item.alias))}
        {skipped > 0 && <tr className="lb-gap"><td colSpan={daily ? 6 : 4}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r=".6" /><circle cx="12" cy="12" r=".6" /><circle cx="19" cy="12" r=".6" /></svg>{formatExact(skipped)} more {skipped === 1 ? 'builder' : 'builders'} between #{formatExact(last)} and #{formatExact(after[0]!.rank)}</td></tr>}
        {after.map((item) => row(item, `near-${item.alias}`))}
      </tbody>
    </table>
    <div className="lb-foot">
      <span>Showing {formatExact(first)}–{formatExact(Math.min(first + rows.length - 1, total))} of {formatExact(total)} {total === 1 ? 'builder' : 'builders'}</span>
      {pages > 1 && <nav className="lb-pager" aria-label="Pages">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><Chevron d="m15 18-6-6 6-6" /></button>
        {pagerItems(page, pages).map((item, index) => item === '…' ? <span key={`gap${index}`} className="ell">…</span>
          : <button key={item} type="button" className={item === page ? 'on' : undefined} aria-current={item === page ? 'page' : undefined} onClick={() => onPage(item)}>{formatExact(item)}</button>)}
        <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><Chevron d="m9 18 6-6-6-6" /></button>
      </nav>}
    </div>
  </>;
}

const CLOCK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const FLAME = <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.6 3.2-1.4 5-2.9 6.6C7.6 10.2 6 12 6 14.6A6 6 0 0 0 12 21a6 6 0 0 0 6-6.2c0-2.6-1.4-4.3-2.5-5.6-.3 1.5-1 2.5-2.1 3 .4-3.3-.3-6.5-1.4-9.2Z" /></svg>;

const Chevron = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

/** A row's tools, largest first, as icons: the three it uses most. */
function topTools(toolTokens: PublicProfile['toolTokens']): ToolId[] {
  return Object.entries(toolTokens ?? {}).filter(([, tokens]) => tokens).sort(([, a], [, b]) => b! - a!).slice(0, 3).map(([tool]) => tool as ToolId);
}

function BoardRow({ row, period, me, rival, onProfile }: { row: PublicProfile; period: LeaderboardPeriod; me: string | null; rival: string | null; onProfile: (alias: string) => void }) {
  const mine = row.alias === me;
  const open = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); onProfile(row.alias); };
  const tools = topTools(row.toolTokens);
  return <tr className={mine ? 'you' : row.alias === rival ? 'rival' : undefined} onClick={open}>
    <td className="l"><span className="lb-rk"><span className={`rank${row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{formatExact(row.rank)}</span><Move row={row} period={period} /></span></td>
    <td className="l"><div className="lb-user">
      <Avatar alias={row.alias} />
      <span className="lb-name"><a href={`/u/${row.alias}`} onClick={open}>{row.alias}</a>{mine && <span className="m-badge accent">You</span>}{row.alias === rival && <span className="m-badge rival">Rival</span>}</span>
      <span className="lb-meta">
        {tools.length > 0 && <span className="lb-tools" title={tools.map(toolLabel).join(', ')}>{tools.map((id) => <ToolIcon key={id} id={id} />)}</span>}
        {row.streak ? <span className="lb-flame" title={`${formatExact(row.streak)}-day streak`}>{FLAME}{formatExact(row.streak)}</span> : null}
      </span>
    </div></td>
    <td className="lb-total" title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
    {period !== '24h' && <td className="lb-cost">{row.costMicrousd == null ? <span className="zero" title={row.costMicrousd === undefined ? 'Not shared' : 'Pricing unknown'}>—</span> : <span title={formatCost(row.costMicrousd)}>{formatCostCompact(row.costMicrousd)}</span>}</td>}
    {period !== '24h' && <td title={row.last24hTokens ? tokensTitle(row.last24hTokens) : undefined}>{row.last24hTokens ? formatCompact(row.last24hTokens)
      : <span className="zero" title={row.last24hTokens === undefined ? 'Not sent by this builder’s app yet' : undefined}>—</span>}</td>}
    <td><Spark values={period === '24h' && row.hourly ? row.hourly : lastSeven(row.daily)} /></td>
  </tr>;
}

/** The last seven days as a small smooth line, ending in a dot. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const points = values.map((value, index) => [round(2 + (index / (values.length - 1)) * 72), round(21 - (max ? value / max : 0) * 18)] as [number, number]);
  const [x, y] = points.at(-1)!;
  return <span className="lb-spark"><svg viewBox="0 0 76 24" aria-hidden="true"><path d={monotonePath(points)} fill="none" stroke="var(--text-3)" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" /><circle cx={x} cy={y} r="2.2" fill="var(--text-2)" /></svg></span>;
}
