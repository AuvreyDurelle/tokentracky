import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { CommunityStats, Period, ProfileStats, PublicProfile, ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from '../api';
import { errorText, formatCompact, formatCost, formatCostCompact, formatExact, shortDay, toolLabel, topPercent } from '../format';
import { Avatar, Empty, Loading, Notice, SearchIcon, ToolIcon } from '../ui';
import { ACHIEVEMENT_COPY } from './achievement-copy';
import { monotonePath } from './chart';
import { Emblem } from './Emblem';
import { MAIN_TOOLS, gapToNext, lastSeven, otherTokens, pagerItems } from './leaderboard';
import { useLoad } from './load';
import { ToolbarActions } from './Shell';
import {averageCount, countRatio, countShare, cumulativeMonths, sharedCounts, sumCounts} from '../public-counts';

const PAGE_SIZE = 12;
const PERIODS: Array<{ value: Period; label: string }> = [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All' }];
const PHRASE: Record<Period, string> = { week: 'This week', month: 'This month', all: 'All time' };
const SHORT: Record<(typeof MAIN_TOOLS)[number], string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' };
const UPDATED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const tokensTitle = (tokens: number | bigint) => `${formatExact(tokens)} tokens`;
const round = (value: number) => Math.round(value * 10) / 10;

/** The Mac app's leaderboard: community totals, your position and the rankings. */
export function LeaderboardView({ api, me, canJoin, syncedAt, onProfile, onJoin }: { api: ApiClient; me: string | null; canJoin: boolean; syncedAt: string | null; onProfile: (alias: string) => void; onJoin: () => void }) {
  const [period, setPeriod] = useState<Period>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = search.trim();
  useEffect(() => { setPage(1); }, [period, query]);
  // Each sync can move ranks, so everything reloads after one.
  const community = useLoad(() => api.community(), [api, syncedAt]);
  const list = useLoad(() => api.leaderboard(period, 'all', query, page, PAGE_SIZE), [api, period, query, page, syncedAt], query ? 250 : 0);
  const around = useLoad(me ? () => api.leaderboardAround(me, 'all') : null, [api, me, syncedAt]);
  const periods = useLoad(me ? () => api.profileStats(me).then((stats) => stats.periods) : null, [api, me, syncedAt]);
  // Below the first page of the full board, your neighbours in the shown window follow a gap row.
  const nearby = useLoad(me && period !== 'all' ? () => api.leaderboardAround(me, period) : null, [api, me, period, syncedAt]);
  const neighbours = (period === 'all' ? around.value : nearby.value)?.items ?? [];

  const unavailable = !list.value && list.error instanceof ApiError && list.error.code === 'CLOUD_UNAVAILABLE';
  const board = list.value;
  const mine = around.value?.items.find((item) => item.alias === me) ?? null;
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
      {community.value ? <CommunityHero stats={community.value} /> : <section className="m-card lb-hero">{community.error ? <Notice tone="error">Could not load the community totals: {errorText(community.error)}</Notice> : <Loading>Loading the community…</Loading>}</section>}
      {mine ? <YouStrip mine={mine} gap={gapToNext(around.value!.items, mine.alias)} periods={periods.value} builders={community.value?.builders ?? 0} onProfile={onProfile} />
        : !me && canJoin && <JoinStrip onJoin={onJoin} />}
      <section className="m-card lb-board" aria-busy={list.loading}>
        {list.error !== null && <div className="lb-note"><Notice tone="error">Could not load the rankings: {errorText(list.error)}</Notice></div>}
        {!board ? list.error === null && <Loading>Loading rankings…</Loading>
          : board.total === 0 ? query ? <Empty title="No builders match">Try a different name.</Empty>
            : <Empty title="No one’s on the board yet" action={canJoin && <button type="button" className="m-btn primary" onClick={onJoin}>Join the leaderboard</button>}>Be the first to put your tokens up.</Empty>
          : <Board rows={board.items} neighbours={page === 1 && !query ? neighbours : []} me={me} total={board.total} page={page} pageSize={board.pageSize} loading={list.loading} onPage={setPage} onProfile={onProfile} />}
      </section>
    </>}
  </div>;
}

/** Community totals: the all-time figures, the tool split, a 30-day trend and the week's growth. */
export function CommunityHero({ stats }: { stats: CommunityStats }) {
  const counts = sharedCounts(stats);
  const week = sumCounts(counts.trend.slice(-7).map(point => point.tokens));
  const before = sumCounts(counts.trend.slice(-14, -7).map(point => point.tokens));
  const change = before > 0n && counts.trend.length >= 14 ? week - before : null;
  return <section className="m-card lb-hero" aria-label="Community totals">
    <div className="hero-main">
      <div>
        <div className="m-eyebrow"><span className="live-dot" />Community total · All time</div>
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
      <div><div className="m-label">Average per builder</div><div className="m-stat-value" title={stats.builders ? tokensTitle(averageCount(counts.totalTokens, stats.builders)) : undefined}>{stats.builders ? formatCompact(averageCount(counts.totalTokens, stats.builders)) : '—'}</div>
        <div className="sub" title={counts.medianTokens === null ? undefined : `The middle builder: ${tokensTitle(counts.medianTokens)}`}>{counts.medianTokens === null ? 'all time' : `median ${formatCompact(counts.medianTokens)}`}</div></div>
    </div>
  </section>;
}

function ToolShare({ totals }: { totals: Partial<Record<ToolId, bigint>> }) {
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
function TrendArea({ points: values, title, note, labels, aria }: { points: bigint[]; title: string; note: string; labels: Array<{ at: number; text: string }>; aria: string }) {
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
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Your all-time standing: rank, totals, the chase to the next rank and your week and month ranks. */
export function YouStrip({ mine, gap, periods, builders, onProfile }: { mine: PublicProfile; gap: ReturnType<typeof gapToNext>; periods: ProfileStats['periods'] | null; builders: number; onProfile: (alias: string) => void }) {
  const top = topPercent(mine.rank, builders);
  const progress = gap && gap.ahead.tokens > 0 ? Math.min(100, Math.floor((mine.tokens / gap.ahead.tokens) * 100)) : 100;
  const periodRank = (window: 'week' | 'month') => periods && periods[window].rank > 0 && periods[window].tokens > 0 ? `#${formatExact(periods[window].rank)}` : '—';
  return <section className="you-strip" aria-label="Your position">
    <Avatar alias={mine.alias} />
    <div className="you-id"><div className="lb-you-rank">#{formatExact(mine.rank)} <span className="m-badge accent">You</span></div><div className="you-sub">{mine.alias}{top !== null && ` · ${top}`}</div></div>
    <div className="you-vsep" />
    <div className="you-stat"><div className="m-label">Total</div><div className="v" title={tokensTitle(mine.tokens)}>{formatCompact(mine.tokens)}</div></div>
    <div className="you-stat"><div className="m-label">Est. cost</div><div className="v" title={formatCost(mine.costMicrousd)}>{mine.costMicrousd == null ? '—' : formatCostCompact(mine.costMicrousd)}</div></div>
    <div className="you-vsep" />
    <div className="you-chase">
      <div className="row">{gap ? <><span><b>{formatCompact(gap.tokens)}</b> behind #{formatExact(gap.ahead.rank)} {gap.ahead.alias}</span><span className="num">{progress}%</span></> : mine.rank === 1 && <span>You lead the board</span>}</div>
      <div className="chase-bar" aria-hidden="true"><span style={{ width: `${progress}%` }} /><i /></div>
    </div>
    <div className="you-periods"><span className="m-pill">Week <b>{periodRank('week')}</b></span><span className="m-pill">Month <b>{periodRank('month')}</b></span></div>
    <button type="button" className="m-btn" onClick={() => onProfile(mine.alias)}>View profile</button>
  </section>;
}

export function JoinStrip({ onJoin }: { onJoin: () => void }) {
  return <section className="you-strip you-join" aria-label="Join the leaderboard">
    <div className="you-id"><div className="lb-you-rank">You’re tracking privately</div><div className="you-sub">Join to put your tokens on the board. Projects, prompts and code stay on this Mac.</div></div>
    <button type="button" className="m-btn primary" onClick={onJoin}>Join the leaderboard</button>
  </section>;
}

/** The rankings: one page of rows, then (when you are further down) a gap and the builders around you. */
export function Board({ rows, neighbours, me, total, page, pageSize, loading, onPage, onProfile }: { rows: PublicProfile[]; neighbours: PublicProfile[]; me: string | null; total: number; page: number; pageSize: number; loading: boolean; onPage: (page: number) => void; onProfile: (alias: string) => void }) {
  const last = rows.at(-1)?.rank ?? 0;
  const after = rows.some((row) => row.alias === me) ? [] : neighbours.filter((row) => row.rank > last);
  const skipped = after.length ? after[0]!.rank - last - 1 : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  return <>
    <table className="m-table lb-table" style={{ opacity: loading ? 0.6 : 1 }}>
      <colgroup><col className="lbc-rank" /><col /><col className="lbc-total" /><col className="lbc-cost" />{MAIN_TOOLS.map((id) => <col key={id} className={`lbc-${id}`} />)}<col className="lbc-other" /><col className="lbc-spark" /><col className="lbc-24h" /></colgroup>
      <thead><tr>
        <th scope="col" className="l">Rank</th>
        <th scope="col" className="l">Builder</th>
        <th scope="col" className="sorted" aria-sort="descending">Total <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg></th>
        <th scope="col">Est. cost</th>
        {MAIN_TOOLS.map((id) => <th key={id} scope="col"><span className="th"><ToolIcon id={id} />{SHORT[id]}</span></th>)}
        <th scope="col"><span className="th"><span className="other-ics"><ToolIcon id="cline" /><ToolIcon id="roo" /><ToolIcon id="kilo" /></span>Other</span></th>
        <th scope="col">7 days</th>
        <th scope="col" title="Tokens in the last 24 whole hours, UTC">24h</th>
      </tr></thead>
      <tbody>
        {rows.map((row) => <BoardRow key={row.alias} row={row} me={me} onProfile={onProfile} />)}
        {skipped > 0 && <tr className="lb-gap"><td colSpan={11}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r=".6" /><circle cx="12" cy="12" r=".6" /><circle cx="19" cy="12" r=".6" /></svg>{formatExact(skipped)} more {skipped === 1 ? 'builder' : 'builders'} between #{formatExact(last)} and #{formatExact(after[0]!.rank)}</td></tr>}
        {after.map((row) => <BoardRow key={`near-${row.alias}`} row={row} me={me} onProfile={onProfile} />)}
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

const Chevron = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

/** A tool's tokens: "—" when zero, and "—" titled "Not shared" when the builder keeps the split private. */
function ToolCell({ tokens }: { tokens: number | null }) {
  if (tokens === null) return <td><span className="zero" title="Not shared">—</span></td>;
  return <td title={tokens ? tokensTitle(tokens) : undefined}>{tokens ? formatCompact(tokens) : <span className="zero">—</span>}</td>;
}

function BoardRow({ row, me, onProfile }: { row: PublicProfile; me: string | null; onProfile: (alias: string) => void }) {
  const mine = row.alias === me;
  const open = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); onProfile(row.alias); };
  return <tr className={mine ? 'you' : undefined} onClick={open}>
    <td className="l"><span className={`rank${row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{formatExact(row.rank)}</span></td>
    <td className="l"><div className="lb-user">
      <Avatar alias={row.alias} />
      <span className="lb-name"><a href={`/u/${row.alias}`} onClick={open}>{row.alias}</a>{mine && <span className="m-badge accent">You</span>}</span>
      {row.topBadges && row.topBadges.length > 0 && <span className="lb-badges">{row.topBadges.map((id) => <span key={id} className="ts"><Emblem id={id} tier={null} title={ACHIEVEMENT_COPY[id].name} /></span>)}</span>}
    </div></td>
    <td className="lb-total" title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
    <td className="lb-cost">{row.costMicrousd == null ? <span className="zero" title={row.costMicrousd === undefined ? 'Not shared' : 'Pricing unknown'}>—</span> : <span title={formatCost(row.costMicrousd)}>{formatCostCompact(row.costMicrousd)}</span>}</td>
    {MAIN_TOOLS.map((id) => <ToolCell key={id} tokens={row.toolTokens ? row.toolTokens[id] ?? 0 : null} />)}
    <ToolCell tokens={otherTokens(row.toolTokens)} />
    <td><Spark values={lastSeven(row.daily)} /></td>
    <td title={row.last24hTokens ? tokensTitle(row.last24hTokens) : undefined}>{row.last24hTokens ? formatCompact(row.last24hTokens)
      : <span className="zero" title={row.last24hTokens === undefined ? 'Not sent by this builder’s app yet' : undefined}>—</span>}</td>
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
