import { useEffect, useRef, useState } from 'react';
import { type ExactTokenCounts, type CommunityStats, type LeaderboardResponse, type Period, type PublicProfile, type TokenCounts, type ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { KINDS, TOOLS, errorText, formatCompact, formatCost, formatExact, formatShare, shortDay, timeAgo, toolLabel, topPercent } from './format';
import { toolColumns } from './columns';
import { INSTALL_COMMAND, MAC_DOWNLOAD } from './download-config';
import { AppleIcon, Avatar, CopyCommand, Empty, Loading, Notice, SearchIcon, Segmented, ToolIcon, Tokens } from './ui';
import { Sparkline } from './TrendChart';
import {countShare, publicKinds, sharedCounts, sumCounts} from './public-counts';
import { lastSeven, otherTokens } from './mac/leaderboard';

const PERIODS: Array<{ value: Period; label: string }> = [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
const PHRASE: Record<Period, string> = { week: 'this week', month: 'this month', all: 'all time' };
/** Builders per load; reaching the end of the list loads the next page. */
const PAGE_SIZE = 50;
const STEPS = [
  { title: 'Install', text: `The Mac app or one terminal command. It finds Claude Code, Codex and ${TOOLS.length - 2} more tools on its own.` },
  { title: 'Approve the code in your browser', text: 'Sign in, check the short code matches, done. Nothing to copy or paste.' },
  { title: 'You’re ranked', text: 'The history already on your computer counts right away. Daily totals sync on their own.' },
];

/** `all` and a tool rank by tokens; `cost` reorders by estimated cost while ranks keep following tokens. */
type RankBy = 'all' | ToolId | 'cost';
/** Columns after rank and builder. `lifetime` is all-time tokens, shown beside a week or month total; `last24h` is
 * the last 24 whole hours; `other` adds up the tools without a column; `last7` is the last 7 days' daily tokens. */
type ColumnId = 'tokens' | 'lifetime' | 'cost' | 'last24h' | `tool:${ToolId}` | 'other' | 'last7';
type Join = { label: string; onClick: () => void };
interface Standing { mine: PublicProfile; ahead: PublicProfile | null }

const toolSum = (item: PublicProfile) => item.toolTokens ? Object.values(item.toolTokens).reduce((sum, value) => sum + (value ?? 0), 0) : item.tokens;
/** Total across tools; a tool-ranked row's `tokens` holds only that tool. */
const allTools = (item: PublicProfile, rankBy: RankBy) => rankBy === 'all' || rankBy === 'cost' ? item.tokens : toolSum(item);
/** Tools a builder used, largest first: the small glyph stack beside their name. */
const usedTools = (item: PublicProfile) => TOOLS.filter((tool) => (item.toolTokens?.[tool.id] ?? 0) > 0).sort((a, b) => item.toolTokens![b.id]! - item.toolTokens![a.id]!);

/** The period is part of the address, so a shared link opens the same board. Week is the default and stays out of the URL. */
function periodFromUrl(): Period {
  const value = new URLSearchParams(window.location.search ?? '').get('period');
  return value === 'month' || value === 'all' ? value : 'week';
}
function periodToUrl(period: Period) {
  const url = new URL(window.location.href);
  if (period === 'week') url.searchParams.delete('period'); else url.searchParams.set('period', period);
  window.history?.replaceState(null, '', url.pathname + url.search + url.hash);
}

/**
 * This week so far against the same weekdays last week, from the 14 daily totals ending today (UTC).
 * Null when last week had nothing to compare with.
 */
export function weekOverWeek(daily: number[], now = new Date()): number | null {
  if (daily.length < 14) return null;
  const days = ((now.getUTCDay() + 6) % 7) + 1;
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const current = sum(daily.slice(14 - days)); const previous = sum(daily.slice(7 - days, 7));
  return previous > 0 ? (current - previous) / previous : null;
}

/** Where the "see where you'd land" row goes for a visitor who hasn't joined: after rank 9, or at the end of a shorter page. Never for members. */
export function ghostSlot(rows: PublicProfile[], me: string | null): number | null {
  if (me) return null;
  const after = rows.findIndex((item) => item.rank > 9);
  return after === -1 ? rows.length : after;
}

/** The first page, then each page loaded since. A builder already listed is skipped, as rankings can move between loads. */
export function mergeRows(first: PublicProfile[], more: PublicProfile[][]): PublicProfile[] {
  const rows = [...first];
  const seen = new Set(first.map((item) => item.alias));
  for (const item of more.flat()) if (!seen.has(item.alias)) { seen.add(item.alias); rows.push(item); }
  return rows;
}

/** When the current window resets: Monday 00:00 UTC for the week, the 1st for the month. */
function resetText(period: Period, windowStart: string | null, now = Date.now()): { window: string; left: string } | null {
  if (period === 'all' || !windowStart) return null;
  const start = new Date(windowStart);
  const end = period === 'week' ? start.getTime() + 7 * 86_400_000 : Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  const minutes = Math.max(0, Math.round((end - now) / 60_000));
  const left = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return { window: `${period === 'week' ? 'Week' : 'Month'} of ${shortDay(windowStart.slice(0, 10))}`, left };
}

/** Community tokens by type, all time, from every upload that reports types; reasoning is part of output. */
export function CommunityTypes({ breakdown, exact }: { breakdown: TokenCounts; exact?: ExactTokenCounts }) {
  const counts = publicKinds(breakdown, exact);
  const total = sumCounts(KINDS.map(kind => counts[kind.key]));
  return <p className="board-line" aria-label="Community tokens by type">{KINDS.map((kind, index) => <span key={kind.key}>
    {index > 0 && ' · '}<strong className="num"><Tokens value={counts[kind.key]} title={`${formatExact(counts[kind.key])} tokens · ${countShare(counts[kind.key], total)}`} /></strong> {kind.label.toLowerCase()}
    {kind.key === 'output' && <> (<strong className="num"><Tokens value={counts.reasoning} /></strong> reasoning)</>}
  </span>)}</p>;
}

export function Leaderboard({ api, me, join, onProfile, onGuide }: { api: ApiClient; me: string | null; join: Join | null; onProfile: (alias: string) => void; onGuide: () => void }) {
  const [period, setPeriodState] = useState<Period>(periodFromUrl);
  const setPeriod = (next: Period) => { setPeriodState(next); periodToUrl(next); };
  const [community, setCommunity] = useState<CommunityStats | null>(null);
  const [rankBy, setRankBy] = useState<RankBy>('all');
  const [search, setSearch] = useState('');
  // `overview` is the all-tools first page: community totals, the trend and the default rankings.
  const [overview, setOverview] = useState<LeaderboardResponse | null>(null);
  const [list, setList] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  // Pages loaded by scrolling, kept with the first page they continue: a new period, tool or search starts over.
  const [more, setMore] = useState<{ base: LeaderboardResponse; pages: PublicProfile[][]; failed: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const busy = useRef(false);
  const foot = useRef<HTMLElement>(null);
  const query = search.trim();
  const custom = rankBy !== 'all' || query !== '';

  // The headline counts every member.
  useEffect(() => {
    let live = true;
    api.community().then((value) => { if (live) setCommunity(value); }).catch(() => { if (live) setCommunity(null); });
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    let live = true; setLoading(true);
    api.leaderboard(period, 'all', '', 1, PAGE_SIZE)
      .then((next) => { if (live) { setOverview(next); setError(null); } })
      .catch((value: unknown) => { if (live) { setOverview(null); setError(value); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, period]);
  useEffect(() => {
    if (!custom) { setList(null); return; }
    let live = true; setLoading(true);
    const timer = window.setTimeout(() => api.leaderboard(period, rankBy === 'cost' ? 'all' : rankBy, query, 1, PAGE_SIZE, rankBy === 'cost' ? 'cost' : 'tokens')
      .then((next) => { if (live) { setList(next); setError(null); } })
      .catch((value: unknown) => { if (live) setError(value); })
      .finally(() => { if (live) setLoading(false); }), query ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, period, rankBy, query, custom]);
  useEffect(() => {
    if (!me) { setStanding(null); return; }
    let live = true;
    void (async () => {
      try {
        const mine = await api.profile(me, period);
        let ahead: PublicProfile | null = null;
        if (mine.rank > 1) ahead = (await api.leaderboard(period, 'all', '', Math.ceil((mine.rank - 1) / 20))).items.find((item) => item.rank === mine.rank - 1) ?? null;
        if (live) setStanding({ mine, ahead });
      } catch { if (live) setStanding(null); }
    })();
    return () => { live = false; };
  }, [api, me, period, overview?.updatedAt]);

  const shown = custom ? list : overview;
  const extra = more && more.base === shown ? more.pages : [];
  const rows = shown ? mergeRows(shown.items, extra) : [];
  const hasMore = shown !== null && (extra.length + 1) * shown.pageSize < shown.total;
  const failed = more !== null && more.base === shown && more.failed;
  const loadMore = () => {
    if (!shown || !hasMore || loading || busy.current) return;
    busy.current = true; setLoadingMore(true);
    const base = shown;
    const kept = (current: typeof more) => current?.base === base ? current.pages : [];
    api.leaderboard(period, rankBy === 'cost' ? 'all' : rankBy, query, extra.length + 2, PAGE_SIZE, rankBy === 'cost' ? 'cost' : 'tokens')
      .then((next) => setMore((current) => ({ base, pages: [...kept(current), next.items], failed: false })))
      .catch(() => setMore((current) => ({ base, pages: kept(current), failed: true })))
      .finally(() => { busy.current = false; setLoadingMore(false); });
  };
  const loadLatest = useRef(loadMore);
  loadLatest.current = loadMore;
  // Reaching the foot of the list loads the next page. Observing again after each load re-checks a foot that is still in view;
  // after a failure it waits for "Try again".
  useEffect(() => {
    const node = foot.current;
    if (!node || !hasMore || loading || loadingMore || failed || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadLatest.current(); }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown, extra.length, hasMore, loading, loadingMore, failed]);
  const unavailable = error instanceof ApiError && error.code === 'CLOUD_UNAVAILABLE';
  // Your all-tools standing, pinned above the list when you are not already on this page.
  const pinned = standing && !custom && !rows.some((item) => item.alias === me) ? standing.mine : null;
  const gap = standing && (rankBy === 'all' || rankBy === 'cost') ? standing.ahead ? `${formatCompact(standing.ahead.tokens - standing.mine.tokens + 1)} to pass ${standing.ahead.alias}` : 'Leading' : null;
  // The three tools with the most community tokens get a column; the tool being ranked by always has one.
  const overviewCounts = overview ? sharedCounts(overview) : null;
  const communityCounts = community ? sharedCounts(community) : null;
  const tools = toolColumns(overviewCounts?.toolTotals ?? {}, rankBy);
  // Every shared tool can be ranked by, in the fixed tool order.
  const rankable = TOOLS.filter((tool) => (overviewCounts?.toolTotals[tool.id] ?? 0n) > 0 || tools.includes(tool.id));
  // Shared tools without a column of their own add up in Other.
  const others = rankable.filter((tool) => !tools.includes(tool.id));
  const columns: ColumnId[] = ['tokens', ...(period === 'all' ? [] : ['lifetime' as const]), 'cost', 'last24h', ...tools.map((id) => `tool:${id}` as const), ...(others.length ? ['other' as const] : []), 'last7'];
  const end = shown?.updatedAt ?? new Date().toISOString();
  const th = (id: ColumnId) => {
    if (id === 'lifetime') return <th key={id} scope="col" className="c-num c-life" title="All-time tokens across every tool">Lifetime</th>;
    if (id === 'last24h') return <th key={id} scope="col" className="c-num c-24h" title="Tokens in the last 24 whole hours across every tool, UTC">24h</th>;
    if (id === 'other') return <th key={id} scope="col" className="c-num c-tool" title={others.map((tool) => tool.label).join(', ')}><span className="th-others">{others.slice(0, 3).map((tool) => <ToolIcon key={tool.id} id={tool.id} />)}</span>Other</th>;
    if (id === 'last7') return <th key={id} scope="col" className="c-num c-days" title="Daily tokens over the last 7 days, UTC">7 days</th>;
    const tool = id.startsWith('tool:') ? id.slice(5) as ToolId : null;
    const sort: RankBy = id === 'tokens' ? 'all' : id === 'cost' ? 'cost' : tool!;
    const label = id === 'tokens' ? 'Tokens' : id === 'cost' ? 'Est. cost' : toolLabel(tool!);
    return <th key={id} scope="col" className={`c-num ${tool ? 'c-tool' : id === 'cost' ? 'c-cost' : 'c-total'}`} aria-sort={rankBy === sort ? 'descending' : undefined}>
      <button type="button" className={rankBy === sort ? 'sorted' : undefined} onClick={() => setRankBy(sort)}>{tool && <ToolIcon id={tool} />}{label}<SortIcon /></button></th>;
  };
  const cell = (item: PublicProfile, id: ColumnId) => {
    if (id === 'cost') return <td key={id} className={`c-num c-cost${rankBy === 'cost' ? ' sorted' : ''}`}>{item.costMicrousd == null ? <span className="none" title={item.costMicrousd === undefined ? 'Not shared' : 'Pricing unknown'}>—</span> : formatCost(item.costMicrousd)}</td>;
    if (id === 'tokens') return <td key={id} className={`c-num c-total${rankBy === 'all' || rankBy === 'cost' ? ' sorted' : ''}`}><Tokens value={allTools(item, rankBy)} /></td>;
    if (id === 'lifetime') return <td key={id} className="c-num c-life">{item.lifetimeTokens === undefined ? <span className="none">—</span> : <Tokens value={item.lifetimeTokens} title={`${formatExact(item.lifetimeTokens)} tokens all time`} />}</td>;
    if (id === 'last24h') return <td key={id} className="c-num c-24h">{item.last24hTokens === undefined ? <span className="none" title="Not sent by this builder’s app yet">—</span> : <Tokens value={item.last24hTokens} title={`${formatExact(item.last24hTokens)} tokens in the last 24 hours`} />}</td>;
    if (id === 'last7') return <td key={id} className="c-days"><Sparkline values={lastSeven(item.daily)} end={end} mine={item.alias === me} /></td>;
    const tool = id === 'other' ? null : id.slice(5) as ToolId;
    const value = item.toolTokens ? tool ? item.toolTokens[tool] ?? 0 : otherTokens(item.toolTokens, tools)! : null;
    return <td key={id} className={`c-num c-tool${tool && rankBy === tool ? ' sorted' : ''}`}>{value ? <Tokens value={value} /> : <span className="none" title={value === null ? 'Not shared' : undefined}>—</span>}</td>;
  };
  const row = (item: PublicProfile, extra?: string) => {
    const mine = item.alias === me;
    // The pinned row is the all-tools standing, so it divides by the all-tools board.
    const top = mine ? topPercent(item.rank, (extra === 'pinned' ? overview : shown)?.builders ?? 0) : null;
    const used = usedTools(item);
    return <tr key={`${extra ?? ''}${item.alias}`} className={[mine ? 'mine' : '', extra ?? ''].join(' ').trim() || undefined} onClick={() => onProfile(item.alias)}>
      <td className="c-rank num"><span className="rk">{item.rank <= 3 ? <span className={`medal g${item.rank}`}>{item.rank}</span> : item.rank}<Move item={item} /></span></td>
      <td className="c-who"><div className="who"><Avatar alias={item.alias} />
        <div className="who-text"><span className="who-line"><button type="button" onClick={(event) => { event.stopPropagation(); onProfile(item.alias); }}>{item.alias}</button>{mine && <span className="badge">You</span>}
            {used.length > 0 && <span className="tstack" title={used.map((tool) => tool.label).join(', ')}>{used.slice(0, 5).map((tool) => <ToolIcon key={tool.id} id={tool.id} />)}</span>}</span>
          {mine && (gap || top) && <small>{[gap, top].filter(Boolean).join(' · ')}</small>}</div></div></td>
      {columns.map((id) => cell(item, id))}
    </tr>;
  };
  // Page one of a ranking shows its top three as a podium, and the table still lists them; search, cost order and
  // later pages are plain lists.
  const podium = query === '' && rankBy !== 'cost' ? rows.slice(0, 3) : [];
  const slot = !custom && join ? ghostSlot(rows, me) : null;
  const builders = community?.builders ?? overview?.total ?? null;
  const reset = shown ? resetText(period, shown.windowStart) : null;

  return <div className="page-stack">
    <header className="board-head">
      <div>
        <p className="eyebrow">The token leaderboard for AI coding</p>
        <h1>Waste tokens, not time.</h1>
        <p className="board-line">{overview
          ? <><span className="dot" aria-hidden="true" />
            {community && <><strong className="num"><Tokens value={communityCounts!.totalTokens} /></strong> tokens · </>}
            {builders !== null && <><strong className="num">{formatExact(builders)}</strong> {builders === 1 ? 'builder' : 'builders'} · </>}
            {(period !== 'all' || !community) && <><strong className="num up">{period === 'all' ? '' : '+'}<Tokens value={overviewCounts!.totalTokens} /></strong> {PHRASE[period]} · </>}
            updated {timeAgo(overview.updatedAt)}</>
          : unavailable ? 'Leaderboard not connected' : error ? 'Rankings unavailable' : 'Loading…'}</p>
        {overview && community?.breakdown && <CommunityTypes breakdown={community.breakdown} exact={community.exactAggregates?.breakdown} />}
      </div>
      <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
    </header>

    {join && <JoinStrip join={join} />}

    <div className="board-filters">
      <div className="chips" role="group" aria-label="Rank by tool">
        <button type="button" className="chip" aria-pressed={rankBy === 'all' || rankBy === 'cost'} onClick={() => setRankBy('all')}>All tools</button>
        {rankable.map((tool) => <button key={tool.id} type="button" className="chip" aria-pressed={rankBy === tool.id} onClick={() => setRankBy(tool.id)}><ToolIcon id={tool.id} />{tool.label}</button>)}
      </div>
      {reset && <p className="reset"><ClockIcon />{reset.window} · resets in <b>{reset.left}</b></p>}
    </div>

    {podium.length > 0 && <ol className="podium" aria-label={`Top ${podium.length}`}>
      {podium.map((item, index) => <PodiumCard key={item.alias} item={item} above={index ? podium[index - 1]! : null} next={podium[1] ?? null} period={period} rankBy={rankBy} mine={item.alias === me} end={shown?.updatedAt ?? new Date().toISOString()} onProfile={onProfile} />)}
    </ol>}

    <section className="panel board" aria-busy={loading}>
      <div className="panel-head">
        <h2>Rankings{shown && <span className="count num">{formatExact(shown.total)}</span>}</h2>
        {rankBy !== 'all' && <p className="board-note">{rankBy === 'cost' ? 'By estimated cost · unknown cost last' : `By ${toolLabel(rankBy)} · builders sharing a tool split`} <button type="button" className="link" onClick={() => setRankBy('all')}>Rank by tokens</button></p>}
        <label className="search"><SearchIcon /><span className="sr-only">Search builders</span><input className="input" type="search" placeholder="Search builders" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={30} /></label>
      </div>
      {error !== null && !unavailable && <div className="card-pad"><Notice tone="error">Could not load rankings: {errorText(error)}</Notice></div>}
      {unavailable && <Empty title="Leaderboard not connected">This app has no leaderboard server configured. Your usage is still tracked privately on the You page.</Empty>}
      {!shown && error === null && <Loading>Loading rankings…</Loading>}
      {shown && shown.total === 0 && (query
        ? <Empty title="No builders match">Try a different name.</Empty>
        : <Empty title="No one’s on the board yet" action={join && <button type="button" className="btn primary" onClick={join.onClick}>{join.label}</button>}>Be the first to put your tokens up.</Empty>)}
      {shown && (rows.length > 0 || pinned || slot !== null) && shown.total > 0 && <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1 }}><table className="table">
        <thead><tr>
          <th scope="col" className="c-rank" title="▲ ▼ rank change since the end of yesterday, UTC">Rank</th>
          <th scope="col" className="c-who">Builder</th>
          {columns.map(th)}
        </tr></thead>
        <tbody>
          {pinned && row(pinned, 'pinned')}
          {rows.flatMap((item, index) => index === slot && join ? [<GhostRow key="ghost" span={columns.length + 2} onJoin={join.onClick} />, row(item)] : [row(item)])}
          {slot === rows.length && join && <GhostRow key="ghost" span={columns.length + 2} onJoin={join.onClick} />}
        </tbody>
      </table></div>}
      {/* What the headers' tooltips say, for touch screens that can't hover them. */}
      {shown && shown.total > 0 && <p className="board-key">Tap a number for its exact value · ▲▼ rank change since the end of yesterday · 24h: the last 24 whole hours · 7 days: tokens per day{others.length > 0 && ` · Other: ${others.map((tool) => tool.label).join(', ')}`} · — not shared or unknown · UTC</p>}
      {shown && shown.total > 0 && <footer className="board-foot" ref={foot}>
        <span className="num">Showing 1–{formatExact(rows.length)} of {formatExact(shown.total)} {shown.total === 1 ? 'builder' : 'builders'}</span>
        {hasMore && <span className="actions">{failed && !loadingMore && <span>Couldn’t load more.</span>}
          <button type="button" className="btn sm" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : failed ? 'Try again' : 'Load more'}</button></span>}
      </footer>}
    </section>

    {join && <section className="how" aria-labelledby="how-title">
      <header className="how-head"><h2 id="how-title">How joining works</h2><button type="button" className="link-quiet" onClick={onGuide}>Full guide →</button></header>
      <ol className="how-steps">{STEPS.map((step, index) => <li key={step.title}><span className="step-num">{index + 1}</span><div><strong>{step.title}</strong><p>{step.text}</p></div></li>)}</ol>
    </section>}
  </div>;
}

/** For visitors: how to get on the board, with the install command and the Mac app when this deploy offers them. */
function JoinStrip({ join }: { join: Join }) {
  return <section className="join-strip" aria-label="Join the leaderboard">
    <div className="join-q"><span className="join-ic" aria-hidden="true"><TrophyIcon /></span>
      <div><strong>Where would you rank?</strong><small>{INSTALL_COMMAND ? 'One command, about a minute.' : 'It takes about a minute.'}</small></div></div>
    <div>
      {INSTALL_COMMAND && <CopyCommand text={INSTALL_COMMAND} />}
      <p className="join-cap"><LockIcon />Prompts, code and project names never leave your computer.</p>
    </div>
    <div className="join-actions">
      {MAC_DOWNLOAD
        ? <>{INSTALL_COMMAND && <span className="faint">or</span>}<a className="btn" href={MAC_DOWNLOAD}><AppleIcon />Download for Mac</a></>
        : <button type="button" className="btn primary" onClick={join.onClick}>{join.label}</button>}
    </div>
  </section>;
}

/** One of the top three. The gap is to the builder above; first place shows its lead. Week-over-week appears only for the week, where 14 days cover both. */
export function PodiumCard({ item, above, next, period, rankBy, mine, end, onProfile, now = new Date() }: { item: PublicProfile; above: PublicProfile | null; next: PublicProfile | null; period: Period; rankBy: RankBy; mine: boolean; end: string; onProfile: (alias: string) => void; now?: Date }) {
  const change = period === 'week' ? weekOverWeek(item.daily, now) : null;
  const used = usedTools(item);
  const gap = above ? `${formatCompact(above.tokens - item.tokens)} behind #${above.rank}` : next ? `Leads by ${formatCompact(item.tokens - next.tokens)}` : 'Leading';
  return <li className={`podium-card p${item.rank}${mine ? ' mine' : ''}`}>
    <button type="button" className="podium-main" onClick={() => onProfile(item.alias)} aria-label={`${item.alias}, rank ${item.rank}, ${formatExact(item.tokens)} tokens`}>
      <span className="podium-who"><span className={`medal g${item.rank}`}>{item.rank}</span><Avatar alias={item.alias} size="lg" /><span className="podium-name"><strong>{item.alias}</strong>{mine && <span className="badge">You</span>}</span>
        {used.length > 0 && <span className="tstack" aria-hidden="true">{used.slice(0, 5).map((tool) => <ToolIcon key={tool.id} id={tool.id} />)}</span>}</span>
      <span className="podium-figures">
        <span><strong className="podium-total num" title={`${formatExact(item.tokens)} tokens`}>{formatCompact(item.tokens)}</strong>
          <small>{rankBy !== 'all' && rankBy !== 'cost' ? `${toolLabel(rankBy)} tokens` : change === null ? `tokens ${PHRASE[period]}` : <span className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '↑' : '↓'} {formatShare(Math.abs(change), 1)} <span className="faint">vs same days last week</span></span>}</small></span>
        <Sparkline values={item.daily} end={end} size="lg" mine={mine} />
      </span>
    </button>
    <footer><span className="num">{gap}</span>{item.costMicrousd != null && <span className="num">{formatCost(item.costMicrousd)} est.</span>}</footer>
  </li>;
}

/** A visitor's placeholder in the ranking, pointing at sign-in. */
function GhostRow({ span, onJoin }: { span: number; onJoin: () => void }) {
  return <tr className="ghost" onClick={onJoin}>
    <td className="c-rank"><span className="ghost-rank" aria-hidden="true">?</span></td>
    <td colSpan={span - 1}><div className="ghost-body"><span className="ghost-avatar" aria-hidden="true" /><span className="who-text"><strong>You</strong><small>see where you’d land</small></span>
      <span className="ghost-note">Already on Claude Code or Codex? Your history counts the moment you join.</span>
      <button type="button" className="btn primary sm" onClick={(event) => { event.stopPropagation(); onJoin(); }}>Join</button></div></td>
  </tr>;
}

/** Rank change since the end of yesterday; builders with no earlier tokens are new. */
const moveText = (item: PublicProfile) => {
  if (item.previousRank === null) return item.tokens > 0 ? 'New today' : null;
  const change = item.previousRank - item.rank;
  return change ? `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change)} since yesterday` : 'Same as yesterday';
};

function Move({ item }: { item: PublicProfile }) {
  const text = moveText(item);
  if (item.previousRank === null) return item.tokens > 0 ? <span className="move new" title={text ?? undefined}>New</span> : null;
  const change = item.previousRank - item.rank;
  return change ? <span className={`move ${change > 0 ? 'up' : 'down'}`} title={text ?? undefined}>{change > 0 ? '▲' : '▼'}{Math.abs(change)}</span> : null;
}

function SortIcon() {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
}

function TrophyIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>;
}
