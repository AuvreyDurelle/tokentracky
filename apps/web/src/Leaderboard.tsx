import { useEffect, useState } from 'react';
import { type ExactTokenCounts, type CommunityStats, type LeaderboardResponse, type Period, type PublicProfile, type TokenCounts, type ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { KINDS, TOOLS, errorText, formatCompact, formatCost, formatExact, formatShare, shortDay, timeAgo, toolLabel, topPercent } from './format';
import { toolColumns } from './columns';
import { Avatar, Empty, Loading, Notice, SearchIcon, Segmented, ToolIcon } from './ui';
import { Sparkline } from './TrendChart';
import {countShare, publicKinds, sharedCounts, sumCounts} from './public-counts';

const PERIODS: Array<{ value: Period; label: string }> = [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
const PHRASE: Record<Period, string> = { week: 'this week', month: 'this month', all: 'all time' };
const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];

/** `all` and a tool rank by tokens; `cost` reorders by estimated cost while ranks keep following tokens. */
type RankBy = 'all' | ToolId | 'cost';
/** Columns after rank, move and builder. `lifetime` is all-time tokens, shown beside a week or month total; `last24h` is
 * the last 24 whole hours. */
type ColumnId = 'tokens' | 'lifetime' | 'cost' | 'last24h' | `tool:${ToolId}`;
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

/** When the current window resets: Monday 00:00 UTC for the week, the 1st for the month. */
function resetText(period: Period, windowStart: string | null, now = Date.now()): string | null {
  if (period === 'all' || !windowStart) return null;
  const start = new Date(windowStart);
  const end = period === 'week' ? start.getTime() + 7 * 86_400_000 : Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  const minutes = Math.max(0, Math.round((end - now) / 60_000));
  const left = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${period === 'week' ? 'Week' : 'Month'} of ${shortDay(windowStart.slice(0, 10))} · resets in ${left}`;
}

/** Community tokens by type, all time, from every upload that reports types; reasoning is part of output. */
export function CommunityTypes({ breakdown, exact }: { breakdown: TokenCounts; exact?: ExactTokenCounts }) {
  const counts = publicKinds(breakdown, exact);
  const total = sumCounts(KINDS.map(kind => counts[kind.key]));
  return <p className="board-line" aria-label="Community tokens by type">{KINDS.map((kind, index) => <span key={kind.key}>
    {index > 0 && ' · '}<strong className="num" title={`${formatExact(counts[kind.key])} tokens · ${countShare(counts[kind.key], total)}`}>{formatCompact(counts[kind.key])}</strong> {kind.label.toLowerCase()}
    {kind.key === 'output' && <> (<strong className="num" title={`${formatExact(counts.reasoning)} tokens`}>{formatCompact(counts.reasoning)}</strong> reasoning)</>}
  </span>)}</p>;
}

export function Leaderboard({ api, me, join, onProfile }: { api: ApiClient; me: string | null; join: { label: string; onClick: () => void } | null; onProfile: (alias: string) => void }) {
  const [period, setPeriodState] = useState<Period>(periodFromUrl);
  const setPeriod = (next: Period) => { setPeriodState(next); periodToUrl(next); };
  const [community, setCommunity] = useState<CommunityStats | null>(null);
  const [rankBy, setRankBy] = useState<RankBy>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  // `overview` is the all-tools first page: community totals, the trend and the default rankings.
  const [overview, setOverview] = useState<LeaderboardResponse | null>(null);
  const [list, setList] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const query = search.trim();
  const custom = rankBy !== 'all' || query !== '' || page > 1 || pageSize !== 20;

  useEffect(() => { setPage(1); }, [period, rankBy, query, pageSize]);
  // The headline counts every member.
  useEffect(() => {
    let live = true;
    api.community().then((value) => { if (live) setCommunity(value); }).catch(() => { if (live) setCommunity(null); });
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    let live = true; setLoading(true);
    api.leaderboard(period, 'all', '', 1)
      .then((next) => { if (live) { setOverview(next); setError(null); } })
      .catch((value: unknown) => { if (live) { setOverview(null); setError(value); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, period]);
  useEffect(() => {
    if (!custom) { setList(null); return; }
    let live = true; setLoading(true);
    const timer = window.setTimeout(() => api.leaderboard(period, rankBy === 'cost' ? 'all' : rankBy, query, page, pageSize, rankBy === 'cost' ? 'cost' : 'tokens')
      .then((next) => { if (live) { setList(next); setError(null); } })
      .catch((value: unknown) => { if (live) setError(value); })
      .finally(() => { if (live) setLoading(false); }), query ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, period, rankBy, query, page, pageSize, custom]);
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
  const rows = shown?.items ?? [];
  const pages = shown ? Math.max(1, Math.ceil(shown.total / shown.pageSize)) : 1;
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
  const columns: ColumnId[] = ['tokens', ...(period === 'all' ? [] : ['lifetime' as const]), 'cost', 'last24h', ...tools.map((id) => `tool:${id}` as const)];
  const th = (id: ColumnId) => {
    if (id === 'lifetime') return <th key={id} scope="col" className="c-num c-life" title="All-time tokens across every tool">Lifetime</th>;
    if (id === 'last24h') return <th key={id} scope="col" className="c-num c-24h" title="Tokens in the last 24 whole hours across every tool, UTC">24h</th>;
    const tool = id.startsWith('tool:') ? id.slice(5) as ToolId : null;
    const sort: RankBy = id === 'tokens' ? 'all' : id === 'cost' ? 'cost' : tool!;
    const label = id === 'tokens' ? 'Tokens' : id === 'cost' ? 'Est. cost' : toolLabel(tool!);
    return <th key={id} scope="col" className={`c-num ${tool ? 'c-tool' : id === 'cost' ? 'c-cost' : 'c-total'}`} aria-sort={rankBy === sort ? 'descending' : undefined}>
      <button type="button" className={rankBy === sort ? 'sorted' : undefined} onClick={() => setRankBy(sort)}>{tool && <ToolIcon id={tool} />}{label}<SortIcon /></button></th>;
  };
  const cell = (item: PublicProfile, id: ColumnId) => {
    if (id === 'cost') return <td key={id} className={`c-num c-cost${rankBy === 'cost' ? ' sorted' : ''}`}>{item.costMicrousd == null ? <span className="none" title={item.costMicrousd === undefined ? 'Not shared' : 'Pricing unknown'}>—</span> : formatCost(item.costMicrousd)}</td>;
    if (id === 'tokens') return <td key={id} className={`c-num c-total${rankBy === 'all' || rankBy === 'cost' ? ' sorted' : ''}`} title={`${formatExact(allTools(item, rankBy))} tokens`}>{formatCompact(allTools(item, rankBy))}</td>;
    if (id === 'lifetime') return <td key={id} className="c-num c-life" title={item.lifetimeTokens === undefined ? undefined : `${formatExact(item.lifetimeTokens)} tokens all time`}>{item.lifetimeTokens === undefined ? <span className="none">—</span> : formatCompact(item.lifetimeTokens)}</td>;
    if (id === 'last24h') return <td key={id} className="c-num c-24h" title={item.last24hTokens === undefined ? undefined : `${formatExact(item.last24hTokens)} tokens in the last 24 hours`}>{item.last24hTokens === undefined ? <span className="none" title="Not sent by this builder’s app yet">—</span> : formatCompact(item.last24hTokens)}</td>;
    const tool = id.slice(5) as ToolId;
    return <td key={id} className={`c-num c-tool${rankBy === tool ? ' sorted' : ''}`}>{item.toolTokens ? formatCompact(item.toolTokens[tool] ?? 0) : <span className="none" title="Not shared">—</span>}</td>;
  };
  const row = (item: PublicProfile, extra?: string) => {
    const mine = item.alias === me;
    // The pinned row is the all-tools standing, so it divides by the all-tools board.
    const top = mine ? topPercent(item.rank, (extra === 'pinned' ? overview : shown)?.builders ?? 0) : null;
    const used = usedTools(item);
    return <tr key={`${extra ?? ''}${item.alias}`} className={[mine ? 'mine' : '', extra ?? ''].join(' ').trim() || undefined} onClick={() => onProfile(item.alias)}>
      <td className="c-rank num">{item.rank <= 3 ? <span className={`medal g${item.rank}`}>{item.rank}</span> : item.rank}</td>
      <td className="c-move num"><Move item={item} /></td>
      <td className="c-who"><div className="who"><Avatar alias={item.alias} />
        <div className="who-text"><span className="who-line"><button type="button" onClick={(event) => { event.stopPropagation(); onProfile(item.alias); }}>{item.alias}</button>{mine && <span className="badge">You</span>}
            {used.length > 0 && <span className="tstack" title={used.map((tool) => tool.label).join(', ')}>{used.slice(0, 5).map((tool) => <ToolIcon key={tool.id} id={tool.id} />)}</span>}</span>
          {mine && (gap || top) && <small>{[gap, top].filter(Boolean).join(' · ')}</small>}</div></div></td>
      {columns.map((id) => cell(item, id))}
    </tr>;
  };
  // Page one of a ranking shows its top three as a podium; search, cost order and later pages are plain lists.
  const podium = !custom || (page === 1 && query === '' && rankBy !== 'cost') ? rows.slice(0, 3) : [];
  const listed = rows.slice(podium.length);
  const slot = !custom && join ? ghostSlot(listed, me) : null;
  const builders = community?.builders ?? overview?.total ?? null;
  const reset = shown ? resetText(period, shown.windowStart) : null;

  return <div className="page-stack">
    <header className="board-head">
      <div>
        <p className="eyebrow">The token leaderboard for AI coding</p>
        <h1>Waste tokens, not time.</h1>
        <p className="board-line">{overview
          ? <><span className="dot" aria-hidden="true" />
            {community && <><strong className="num" title={`${formatExact(communityCounts!.totalTokens)} tokens`}>{formatCompact(communityCounts!.totalTokens)}</strong> tokens · </>}
            {builders !== null && <><strong className="num">{formatExact(builders)}</strong> {builders === 1 ? 'builder' : 'builders'} · </>}
            {(period !== 'all' || !community) && <><strong className="num up" title={`${formatExact(overviewCounts!.totalTokens)} tokens`}>{period === 'all' ? '' : '+'}{formatCompact(overviewCounts!.totalTokens)}</strong> {PHRASE[period]} · </>}
            updated {timeAgo(overview.updatedAt)}</>
          : unavailable ? 'Leaderboard not connected' : error ? 'Rankings unavailable' : 'Loading…'}</p>
        {overview && community?.breakdown && <CommunityTypes breakdown={community.breakdown} exact={community.exactAggregates?.breakdown} />}
      </div>
      {join && <button type="button" className="btn primary join-cta" onClick={join.onClick}>Sign up and start tracking</button>}
    </header>

    <div className="board-filters">
      <div className="board-controls">
        <Segmented label="Period" value={period} options={PERIODS} onChange={setPeriod} />
        <label className="rank-by"><span className="sr-only">Rank by tool</span>
          <select className="input select" value={rankBy === 'cost' ? 'all' : rankBy} onChange={(event) => setRankBy(event.target.value as RankBy)}>
            <option value="all">All tools</option>
            {rankable.map((tool) => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
          </select></label>
      </div>
      {reset && <p className="faint reset">{reset}</p>}
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
      {shown && (listed.length > 0 || pinned || slot !== null) && shown.total > 0 && <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1 }}><table className="table">
        <thead><tr>
          <th scope="col" className="c-rank">#</th>
          <th scope="col" className="c-move" title="Rank change since the end of yesterday, UTC">Move</th>
          <th scope="col" className="c-who">Builder</th>
          {columns.map(th)}
        </tr></thead>
        <tbody>
          {pinned && row(pinned, 'pinned')}
          {listed.flatMap((item, index) => index === slot && join ? [<GhostRow key="ghost" span={columns.length + 3} onJoin={join.onClick} />, row(item)] : [row(item)])}
          {slot === listed.length && join && <GhostRow key="ghost" span={columns.length + 3} onJoin={join.onClick} />}
        </tbody>
      </table></div>}
      {shown && shown.total > PAGE_SIZES[0] && <footer className="pager">
        <span className="num">{formatExact((page - 1) * shown.pageSize + 1)}–{formatExact(Math.min(page * shown.pageSize, shown.total))} of {formatExact(shown.total)}</span>
        <label className="rows-label">Rows<select className="input select" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) as PageSize)}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <span className="actions"><button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" className="btn sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></span>
      </footer>}
    </section>
  </div>;
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
  if (item.previousRank === null) return item.tokens > 0 ? <span className="move new" title={text ?? undefined}>New</span> : <span className="move">–</span>;
  const change = item.previousRank - item.rank;
  return <span className={`move${change > 0 ? ' up' : change < 0 ? ' down' : ''}`} title={text ?? undefined}>{change > 0 ? '↑' : change < 0 ? '↓' : '–'}{change ? Math.abs(change) : ''}</span>;
}

function SortIcon() {
  return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
