import { useEffect, useState, type ReactNode } from 'react';
import { CHALLENGES, CHALLENGE_KINDS, CLUB_CATEGORIES, CLUB_MARK_IDS, CLUB_MARKS, CLUB_NAME_PATTERN, CLUB_PRIVATE_LIMIT, LEAGUE_MIN_ACTIVE, LEAGUE_SMALL_MAX, challengeUnit,
  clubWeek, inviteCode, type ChallengeKind, type ClubCategory, type ClubDivision, type ClubMark as ClubMarkId, type ClubPage, type ClubStanding, type ClubVisibility,
  type ClubWeek, type LeaderboardPeriod, type MyClub, type ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from '../api';
import { ClubMark, MarkShape } from '../ClubMark';
import { errorText, formatCompact, formatCost, formatCostCompact, formatExact, shortDay } from '../format';
import type { ClubsTab, ClubTab, Route } from '../route';
import { Avatar, Empty, Loading, Notice, SearchIcon, ToolIcon } from '../ui';
import { Board, ToolShare, TrendArea } from './LeaderboardView';
import { useLoad } from './load';
import { ProfileDialog } from './ProfileModal';
import { ToolbarActions, clubsChanged } from './Shell';

type Go = (route: Route) => void;
const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [{ value: '24h', label: '24h' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];
const plural = (count: number, word: string) => `${formatExact(count)} ${count === 1 ? word : `${word}s`}`;
const divisionName = (division: ClubDivision) => division === 'small' ? 'Small' : 'Large';
const visibilityName = (visibility: ClubVisibility) => visibility === 'private' ? 'Private' : 'Public';
const tokensTitle = (tokens: number) => `${formatExact(tokens)} tokens`;
const big = (values: Partial<Record<ToolId, number>>) => Object.fromEntries(Object.entries(values).map(([tool, tokens]) => [tool, BigInt(tokens ?? 0)])) as Partial<Record<ToolId, bigint>>;
/** "3d 6h" until the week resets. */
export function weekLeft(now = Date.now()): string {
  const minutes = Math.max(0, Math.round((Date.parse(clubWeek(new Date(now)).end) - now) / 60_000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
/** A challenge value: 89.7% (basis points), 5 days, or tokens. */
export function challengeText(kind: ChallengeKind, value: number | null): string {
  if (value === null) return '—';
  const unit = challengeUnit(kind);
  return unit === 'percent' ? `${Number((value / 100).toFixed(1))}%` : unit === 'days' ? `${value} ${value === 1 ? 'day' : 'days'}` : formatCompact(value);
}
const change = (week: Pick<ClubWeek, 'tokens' | 'previousTokens'>) => week.previousTokens ? (week.tokens - week.previousTokens) / week.previousTokens : null;

function Move({ rank, previous }: { rank: number | null; previous: number | null }) {
  if (rank === null || previous === null || previous === rank) return null;
  const by = previous - rank;
  return <span className={`move ${by > 0 ? 'up' : 'down'}`} title={`${by > 0 ? 'Up' : 'Down'} ${Math.abs(by)} since yesterday`}>{by > 0 ? '▲' : '▼'}{Math.abs(by)}</span>;
}
function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return <div className="m-seg" role="group" aria-label={label}>{options.map(([id, text]) => <button key={id} type="button" className={id === value ? 'on' : undefined} aria-pressed={id === value} onClick={() => onChange(id)}>{text}</button>)}</div>;
}
/** When the app isn't linked to the leaderboard, clubs wait for that. */
function NotLinked({ error, onJoin }: { error: unknown; onJoin: () => void }) {
  if (error instanceof ApiError && error.code === 'CLOUD_NOT_LINKED') return <section className="m-card"><Empty title="Join the leaderboard to use clubs" action={<button type="button" className="m-btn primary" onClick={onJoin}>Join the leaderboard</button>}>Clubs rank members by the totals they publish. Projects, prompts and code stay on this Mac.</Empty></section>;
  return <Notice tone="error">Clubs could not load: {errorText(error)}</Notice>;
}

/** A club's week as the leaderboard's hero: the figures, the tool mix, 14 days, then four facts. */
function ClubHero({ week, eyebrow, figures, stats }: { week: ClubWeek; eyebrow: ReactNode; figures: ReactNode; stats: ReactNode }) {
  const today = new Date();
  const days = week.daily.map((_, index) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (week.daily.length - 1 - index))).toISOString().slice(0, 10));
  return <section className="m-card lb-hero">
    <div className="hero-main">
      <div>
        <div className="hero-eyebrow">{eyebrow}</div>
        <div className="hero-figures">{figures}</div>
        <ToolShare totals={big(week.toolTokens)} />
      </div>
      <TrendArea points={week.daily.map((value) => BigInt(value))} title="Club tokens per day" note="Last 14 days · UTC"
        labels={days.flatMap((day, index) => (days.length - 1 - index) % 7 === 0 ? [{ at: index, text: shortDay(day) }] : [])}
        aria={`Club tokens per UTC day, last 14 days, ending at ${formatExact(week.daily.at(-1) ?? 0)}`} />
    </div>
    <div className="m-stat-strip hero-stats">{stats}</div>
  </section>;
}
const standingText = (standing: ClubStanding | null) => standing?.rank ? `#${standing.rank} ${divisionName(standing.division)} league` : standing ? `Not ranked: ${LEAGUE_MIN_ACTIVE} active members rank` : 'Not in the league';

/** Clubs: your clubs, Discover, the league and matchups, switched from the toolbar. */
export function ClubsView({ api, me, tab, go, onJoin }: { api: ApiClient; me: string | null; tab: ClubsTab; go: Go; onJoin: () => void }) {
  const [sheet, setSheet] = useState<'new' | 'join' | null>(null);
  return <div className="m-page m-lb mc-clubs">
    <ToolbarActions>
      <Seg label="Clubs" value={tab} options={[['mine', 'Your clubs'], ['discover', 'Discover'], ['league', 'League'], ['matchups', 'Matchups']]} onChange={(next) => go({ page: 'clubs', tab: next })} />
      <button type="button" className="m-btn primary" onClick={() => setSheet('new')}>New club</button>
    </ToolbarActions>
    {tab === 'mine' && <YourClubs api={api} me={me} go={go} onJoin={onJoin} onCode={() => setSheet('join')} />}
    {tab === 'discover' && <Discover api={api} go={go} onJoin={onJoin} />}
    {tab === 'league' && <League api={api} go={go} onJoin={onJoin} />}
    {tab === 'matchups' && <Matchups api={api} go={go} onJoin={onJoin} />}
    {sheet === 'new' && <NewClub api={api} me={me} go={go} onClose={() => setSheet(null)} />}
    {sheet === 'join' && <JoinCode api={api} go={go} onClose={() => setSheet(null)} />}
  </div>;
}

function YourClubs({ api, me, go, onJoin, onCode }: { api: ApiClient; me: string | null; go: Go; onJoin: () => void; onCode: () => void }) {
  const [round, setRound] = useState(0);
  const mine = useLoad(() => api.myClubs(), [api, me, round]);
  const [error, setError] = useState<string | null>(null);
  const answer = (id: string, value: 'accept' | 'decline') => { setError(null); api.answerMatchup(id, value).then(() => setRound((n) => n + 1), (reason: unknown) => setError(errorText(reason))); };
  return <>
    <div className="page-head"><div><h1 className="m-page-title">Your clubs</h1><p className="m-page-sub">Week of {shortDay(clubWeek(new Date()).start.slice(0, 10))}<span className="sep" />Resets in {weekLeft()}</p></div>
      <button type="button" className="m-btn" onClick={onCode}>Join with a code</button></div>
    {mine.error !== null && !mine.value && <NotLinked error={mine.error} onJoin={onJoin} />}
    {!mine.value && mine.error === null && <Loading>Loading your clubs…</Loading>}
    {error && <Notice tone="error">{error}</Notice>}
    {mine.value?.clubs.length === 0 && <section className="m-card"><Empty title="You’re not in a club yet" action={<button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'discover' })}>Discover clubs</button>}>Start a private club for your team or friends with New club, or join a public one.</Empty></section>}
    {mine.value?.clubs.map((entry) => <MyClubHero key={entry.club.slug} entry={entry} go={go} />)}
    {mine.value && mine.value.requests.length > 0 && <section className="m-card mc-requests" aria-label="Challenges waiting on you">
      <div className="lb-head"><h2>Challenges</h2><span className="m-badge lb-count">{formatExact(mine.value.requests.length)}</span></div>
      <ul className="club-list">{mine.value.requests.map((request) => <li key={request.id} className="club-row mc-request">
        <ClubMark mark={request.from.mark} slug={request.from.slug} /><span className="club-name"><strong>{request.from.name} challenged {request.to.name}</strong><small>Week of {shortDay(request.week)} · {formatCompact(request.fromPerMember)} per member to your {formatCompact(request.toPerMember)}</small></span>
        <span className="mc-actions"><button type="button" className="m-btn" onClick={() => answer(request.id, 'decline')}>Decline</button><button type="button" className="m-btn primary" onClick={() => answer(request.id, 'accept')}>Accept</button></span>
      </li>)}</ul>
    </section>}
  </>;
}

function MyClubHero({ entry, go }: { entry: MyClub; go: Go }) {
  const { club, week, you, standing, challenge, matchup } = entry;
  const delta = change(week);
  const lead = matchup ? matchup.perMember - matchup.opponentPerMember : 0;
  return <ClubHero week={week}
    eyebrow={<button type="button" className="m-eyebrow mc-club-link" onClick={() => go({ page: 'club', slug: club.slug, tab: 'board' })}><ClubMark mark={club.mark} slug={club.slug} />{club.name} · {visibilityName(club.visibility)} · {plural(club.members, 'member')}</button>}
    figures={<>
      <div><div className="hero-num mc-you">{you.rank ? `#${formatExact(you.rank)}` : '—'}</div><div className="hero-cap">{you.rank ? <>of {formatExact(you.ranked)} this week <Move rank={you.rank} previous={you.previousRank} /></> : 'no tokens from you yet'}</div></div>
      <div className="hero-divider" />
      <div><div className="hero-num second" title={tokensTitle(week.tokens)}>{formatCompact(week.tokens)}</div><div className="hero-cap">club tokens this week{delta !== null && <><br /><span className={`tk-delta sm${delta < 0 ? ' neg' : ''}`}>{delta >= 0 ? '+' : '−'}{Math.round(Math.abs(delta) * 100)}%</span> on the same days last week</>}</div></div>
    </>}
    stats={<>
      <div><div className="m-label">{standing ? `${divisionName(standing.division)} league` : 'League'}</div><div className="m-stat-value">{standing?.rank ? `#${standing.rank}` : '—'}</div><div className="sub"><Move rank={standing?.rank ?? null} previous={standing?.previousRank ?? null} /> {formatCompact(week.perMember)} per member</div></div>
      <div><div className="m-label">Active this week</div><div className="m-stat-value">{formatExact(week.active)} of {formatExact(club.members)}</div><div className="sub">{formatCompact(week.last24hTokens)} in the last 24 hours</div></div>
      <div><div className="m-label">{CHALLENGES[challenge.kind].name}</div><div className="m-stat-value">{challenge.you.rank ? `#${challenge.you.rank}` : '—'}</div><div className="sub">{challengeText(challenge.kind, challenge.you.value)}{challenge.leader && challenge.you.rank !== 1 ? ` · led by ${challenge.leader.alias}` : ''}</div></div>
      <div><div className="m-label">Matchup</div><div className="m-stat-value mc-word">{matchup ? lead > 0 ? 'Leading' : lead < 0 ? 'Trailing' : 'Level' : '—'}</div><div className="sub">{matchup ? `${matchup.opponent.name}, by ${formatCompact(Math.abs(lead))}` : 'None this week'}</div></div>
    </>} />;
}

function Discover({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const [category, setCategory] = useState<ClubCategory | null>(null);
  const [search, setSearch] = useState('');
  const query = search.trim();
  // Pages of 60, the next loaded on demand; a new search or category starts over.
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [query, category]);
  const list = useLoad(async () => {
    const loaded = await Promise.all(Array.from({ length: pages }, (_, index) => api.clubList(query, category, 'members', index + 1, 60)));
    return { ...loaded[0]!, items: loaded.flatMap((page) => page.items) };
  }, [api, query, category, pages], query ? 250 : 0);
  const [error, setError] = useState<string | null>(null);
  const join = (slug: string) => { setError(null); api.joinClub(slug).then(() => { clubsChanged(); go({ page: 'club', slug, tab: 'board' }); }, (reason: unknown) => setError(errorText(reason))); };
  return <>
    <div className="page-head"><div><h1 className="m-page-title">Discover</h1><p className="m-page-sub">Public clubs, biggest first. Private clubs are never listed.</p></div>
      <label className="lb-search"><SearchIcon /><span className="sr-only">Search clubs</span><input type="search" placeholder="Search clubs" value={search} maxLength={30} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <div className="mc-chips"><Seg<string> label="Category" value={category ?? 'all'} options={[['all', 'All'], ...(Object.entries(CLUB_CATEGORIES) as Array<[string, string]>)]} onChange={(value) => setCategory(value === 'all' ? null : value as ClubCategory)} /></div>
    {list.error !== null && !list.value && <NotLinked error={list.error} onJoin={onJoin} />}
    {error && <Notice tone="error">{error}</Notice>}
    {!list.value && list.error === null && <Loading>Loading clubs…</Loading>}
    {list.value?.items.length === 0 && <section className="m-card"><Empty title={query || category ? 'No clubs match' : 'No public clubs yet'}>{query || category ? 'Try another search or category.' : 'Start the first one with New club.'}</Empty></section>}
    {list.value && list.value.items.length > 0 && <div className="mc-grid">{list.value.items.map((club) => <section key={club.slug} className="m-card mc-card">
      <header><ClubMark mark={club.mark} slug={club.slug} /><button type="button" className="club-name mc-open" onClick={() => go({ page: 'club', slug: club.slug, tab: 'board' })}><strong>{club.name}</strong><small>{club.category ? CLUB_CATEGORIES[club.category] : 'Public club'}</small></button>
        <span className="lb-tools">{toolsOf(club.week.toolTokens).map((id) => <ToolIcon key={id} id={id} />)}</span></header>
      <p>{club.description || 'No description yet.'}</p>
      <div className="mc-fig"><b title={tokensTitle(club.week.tokens)}>{formatCompact(club.week.tokens)}</b><small>tokens this week</small></div>
      <footer><span>{plural(club.members, 'member')} · {formatExact(club.week.active)} active</span>{club.joined ? <span className="m-badge">Joined</span> : <button type="button" className="m-btn" onClick={() => join(club.slug)}>Join</button>}</footer>
    </section>)}</div>}
    {list.value && list.value.items.length < list.value.total && <div className="mc-more"><button type="button" className="m-btn" onClick={() => setPages((value) => value + 1)}>Load more clubs</button></div>}
  </>;
}
const toolsOf = (toolTokens: Partial<Record<ToolId, number>>) => (Object.entries(toolTokens) as Array<[ToolId, number]>).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);

function League({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const [division, setDivision] = useState<ClubDivision>('small');
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [division]);
  const league = useLoad(async () => {
    const loaded = await Promise.all(Array.from({ length: pages }, (_, index) => api.league(division, index + 1, 100)));
    return { ...loaded[0]!, items: loaded.flatMap((page) => page.items) };
  }, [api, division, pages]);
  const value = league.value;
  return <>
    <div className="page-head"><div><h1 className="m-page-title">League</h1><p className="m-page-sub">Ranked weekly by tokens per active member<span className="sep" />Resets in {weekLeft()}</p></div>
      <Seg label="Division" value={division} options={[['small', `Small · up to ${LEAGUE_SMALL_MAX}`], ['large', `Large · ${LEAGUE_SMALL_MAX}+`]]} onChange={setDivision} /></div>
    {league.error !== null && !value && <NotLinked error={league.error} onJoin={onJoin} />}
    {!value && league.error === null && <Loading>Loading the league…</Loading>}
    {value && <section className="m-card">
      <div className="m-stat-strip mc-overview">
        <div><div className="m-label">Clubs ranked</div><div className="m-stat-value">{formatExact(value.total)}</div><div className="sub">{LEAGUE_MIN_ACTIVE} active members to rank</div></div>
        <div><div className="m-label">Active members</div><div className="m-stat-value">{formatExact(value.activeMembers)}</div><div className="sub">synced this week</div></div>
        <div><div className="m-label">Tokens this week</div><div className="m-stat-value" title={tokensTitle(value.tokens)}>{formatCompact(value.tokens)}</div><div className="sub">{value.activeMembers ? `${formatCompact(Math.round(value.tokens / value.activeMembers))} per active member` : 'no one active yet'}</div></div>
        <div><div className="m-label">Last week’s winner</div><div className="m-stat-value mc-word">{value.lastWinner?.name ?? '—'}</div><div className="sub">{divisionName(division)} division</div></div>
      </div>
      {value.items.length === 0 ? <Empty title="No clubs ranked yet">A club ranks once {LEAGUE_MIN_ACTIVE} of its members are active in the week.</Empty> : <table className="m-table lb-table mc-league">
        <thead><tr><th scope="col" className="l">Rank</th><th scope="col" className="l">Club</th><th scope="col">Active</th><th scope="col" className="sorted" aria-sort="descending">Per member</th><th scope="col">Tokens</th><th scope="col">Est. cost</th><th scope="col">24h</th></tr></thead>
        <tbody>{value.items.map((row) => <tr key={row.club.slug} className={row.mine ? 'you' : undefined} onClick={() => (row.club.visibility === 'public' || row.mine) && go({ page: 'club', slug: row.club.slug, tab: 'board' })}>
          <td className="l"><span className="lb-rk"><span className={`rank${row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{formatExact(row.rank)}</span><Move rank={row.rank} previous={row.previousRank} /></span></td>
          <td className="l"><div className="lb-user"><ClubMark mark={row.club.mark} slug={row.club.slug} /><span className="lb-name">{row.club.name}{row.mine && <span className="m-badge accent">Yours</span>}{row.club.visibility === 'private' && <span className="m-badge">Private</span>}</span>
            <span className="lb-meta">{row.toolTokens && <span className="lb-tools">{toolsOf(row.toolTokens).map((id) => <ToolIcon key={id} id={id} />)}</span>}</span></div></td>
          <td>{formatExact(row.active)} of {formatExact(row.club.members)}</td>
          <td className="lb-total" title={`${formatExact(row.perMember)} tokens per active member`}>{formatCompact(row.perMember)}</td>
          <td title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
          <td className="lb-cost">{row.toolTokens === undefined ? <span className="zero" title="Not shared">—</span> : row.costMicrousd == null ? <span className="zero" title="Pricing unknown">—</span> : <span title={formatCost(row.costMicrousd)}>{formatCostCompact(row.costMicrousd)}</span>}</td>
          <td>{row.last24hTokens === undefined ? <span className="zero" title="Not shared">—</span> : formatCompact(row.last24hTokens)}</td>
        </tr>)}</tbody>
      </table>}
      {value.items.length < value.total && <div className="mc-more"><button type="button" className="m-btn" onClick={() => setPages((count) => count + 1)}>Load more clubs</button></div>}
    </section>}
  </>;
}

function Matchups({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const list = useLoad(() => api.matchups(), [api]);
  return <>
    <div className="page-head"><div><h1 className="m-page-title">Matchups</h1><p className="m-page-sub">Club against club, by tokens per active member<span className="sep" />Ends in {weekLeft()}</p></div></div>
    {list.error !== null && !list.value && <NotLinked error={list.error} onJoin={onJoin} />}
    {!list.value && list.error === null && <Loading>Loading matchups…</Loading>}
    {list.value?.items.length === 0 && <section className="m-card"><Empty title="No matchups this week">Admins challenge another league club for next week on the website; the other club’s admins accept.</Empty></section>}
    {list.value && list.value.items.length > 0 && <section className="m-card"><ul className="club-list">{list.value.items.map((row) => {
      const ahead = row.a.perMember >= row.b.perMember;
      return <li key={row.id} className={`mc-matchup${row.mine ? ' mine' : ''}`}>
        <button type="button" className="mc-side" onClick={() => go({ page: 'club', slug: row.a.club.slug, tab: 'board' })}><ClubMark mark={row.a.club.mark} slug={row.a.club.slug} /><span className="club-name"><strong>{row.a.club.name}</strong><small>{standingText(row.a.standing)}</small></span></button>
        <b className={ahead ? 'ahead' : undefined}>{formatCompact(row.a.perMember)}</b>
        <span className="mc-tug"><span className="tug"><i className={`${ahead ? 'ahead' : ''}${row.mine ? ' mine' : ''}`} style={{ flex: row.a.perMember || 1 }} /><i className={!ahead ? 'ahead' : undefined} style={{ flex: row.b.perMember || 1 }} /></span>
          <small>{row.a.perMember === row.b.perMember ? 'Level' : `${ahead ? row.a.club.name : row.b.club.name} by ${formatCompact(Math.abs(row.a.perMember - row.b.perMember))}`}</small></span>
        <b className={!ahead ? 'ahead' : undefined}>{formatCompact(row.b.perMember)}</b>
        <span className="mc-side b"><ClubMark mark={row.b.club.mark} slug={row.b.club.slug} /><span className="club-name"><strong>{row.b.club.name}</strong><small>{standingText(row.b.standing)}</small></span></span>
      </li>;
    })}</ul></section>}
  </>;
}

/** A club in the app: its week, your place, and its board, challenge or members. */
export function ClubView({ api, me, slug, tab, go, site, onProfile, onJoin }: { api: ApiClient; me: string | null; slug: string; tab: ClubTab; go: Go; site: string | null; onProfile: (alias: string) => void; onJoin: () => void }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');
  const [number, setNumber] = useState(1);
  const [round, setRound] = useState(0);
  const page = useLoad(() => api.club(slug, { period, page: number, pageSize: 12 }), [api, slug, period, number, round]);
  const value = page.value;
  const member = value?.membership ?? null;
  const [error, setError] = useState<string | null>(null);
  const join = () => { setError(null); api.joinClub(slug).then(() => { setRound((n) => n + 1); clubsChanged(); }, (reason: unknown) => setError(errorText(reason))); };
  return <div className="m-page m-lb mc-club">
    <ToolbarActions>
      <Seg label={value?.club.name ?? 'Club'} value={tab} options={[['board', 'Board'], ['challenge', 'Challenge'], ...(member ? [['members', 'Members'] as [ClubTab, string]] : [])]} onChange={(next) => go({ page: 'club', slug, tab: next })} />
      {tab === 'board' && <div className="m-seg" role="group" aria-label="Period">{PERIODS.map((option) => <button key={option.value} type="button" className={option.value === period ? 'on' : undefined} aria-pressed={option.value === period} onClick={() => { setPeriod(option.value); setNumber(1); }}>{option.label}</button>)}</div>}
      {value && !member && value.club.visibility === 'public' && <button type="button" className="m-btn primary" onClick={join}>Join club</button>}
    </ToolbarActions>
    {page.error !== null && !value && (page.error instanceof ApiError && page.error.status === 404 ? <section className="m-card"><Empty title="This club does not exist" action={<button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'mine' })}>Your clubs</button>}>It may have been deleted, or its address changed.</Empty></section> : <NotLinked error={page.error} onJoin={onJoin} />)}
    {!value && page.error === null && <Loading>Loading the club…</Loading>}
    {error && <Notice tone="error">{error}</Notice>}
    {value && <>
      <div className="page-head"><div className="mc-head"><ClubMark mark={value.club.mark} slug={value.club.slug} size="lg" /><div><h1 className="m-page-title">{value.club.name}</h1>
        <p className="m-page-sub">{[visibilityName(value.club.visibility), plural(value.club.members, 'member'), value.standing?.rank ? `#${value.standing.rank} in the ${divisionName(value.standing.division)} league` : null].filter(Boolean).join(' · ')}</p></div></div>
        {site && <a className="m-btn" href={`${site}/c/${slug}${tab === 'board' ? '' : `/${tab}`}`} target="_blank" rel="noopener noreferrer">Open on the web</a>}</div>
      {!value.board && <section className="m-card"><Empty title="A private club">Only members see who’s in it. Ask a member for an invite link or code.</Empty></section>}
      {value.board && tab === 'board' && <ClubBoard page={value} me={me} period={period} number={number} loading={page.loading} onPage={setNumber} onProfile={onProfile} />}
      {tab === 'challenge' && <ClubChallengeView api={api} me={me} slug={slug} />}
      {tab === 'members' && member && <ClubMembersView api={api} me={me} page={value} site={site} onChange={() => setRound((n) => n + 1)} />}
    </>}
  </div>;
}

function ClubBoard({ page, me, period, number, loading, onPage, onProfile }: { page: ClubPage; me: string | null; period: LeaderboardPeriod; number: number; loading: boolean; onPage: (page: number) => void; onProfile: (alias: string) => void }) {
  const { club, week, board } = page;
  const delta = change(week);
  const mine = board!.items.find((row) => row.alias === me) ?? null;
  const ahead = mine ? board!.items.find((row) => row.rank === mine.rank - 1) ?? null : null;
  return <>
    <ClubHero week={week}
      eyebrow={<div className="m-eyebrow"><span className="live-dot" />{club.name} · This week</div>}
      figures={<>
        <div><div className="hero-num" title={tokensTitle(week.tokens)}>{formatCompact(week.tokens)}</div><div className="hero-cap">tokens{delta !== null && ` · ${formatCompact(week.previousTokens)} by now last week`}</div></div>
        <div className="hero-divider" />
        <div><div className="hero-num second">{formatExact(week.activeToday)}<span className="mc-of"> of {formatExact(club.members)}</span></div><div className="hero-cap">members active today</div></div>
      </>}
      stats={<>
        <div><div className="m-label">Added today</div><div className="m-stat-value" title={tokensTitle(week.daily.at(-1) ?? 0)}>+{formatCompact(week.daily.at(-1) ?? 0)}</div><div className="sub">so far · UTC</div></div>
        <div><div className="m-label">Est. club spend</div><div className="m-stat-value" title={formatCost(week.costMicrousd)}>{week.costMicrousd === null ? '—' : formatCostCompact(week.costMicrousd)}</div><div className="sub">this week · API list prices</div></div>
        <div><div className="m-label">Per active member</div><div className="m-stat-value" title={tokensTitle(week.perMember)}>{formatCompact(week.perMember)}</div><div className="sub">median {formatCompact(week.median)}</div></div>
        <div><div className="m-label">Busiest hour</div><div className="m-stat-value">{week.busiestHour === null ? '—' : `${String(week.busiestHour).padStart(2, '0')}:00`}</div><div className="sub">UTC, this week</div></div>
      </>} />
    {mine && <section className="you-strip" aria-label="Your position">
      <Avatar alias={mine.alias} />
      <div className="you-id"><div className="lb-you-rank">#{formatExact(mine.rank)} <span className="m-badge accent">You</span></div><div className="you-sub">{mine.alias}{period === 'week' && board!.period === 'week' && week.tokens ? ` · ${Math.round((mine.tokens / week.tokens) * 100)}% of the club’s tokens` : ''}</div></div>
      <div className="you-vsep" />
      <div className="you-stat"><div className="m-label">{period === 'week' ? 'This week' : 'Tokens'}</div><div className="v" title={tokensTitle(mine.tokens)}>{formatCompact(mine.tokens)}</div></div>
      <div className="you-stat"><div className="m-label">Est. cost</div><div className="v">{mine.costMicrousd == null ? '—' : formatCostCompact(mine.costMicrousd)}</div></div>
      <div className="you-vsep" />
      {(ahead || mine.rank === 1) && <div className="you-chase"><div className="row"><span>{ahead ? <><b>{formatCompact(ahead.tokens - mine.tokens)}</b> behind #{ahead.rank} {ahead.alias}</> : 'You lead the club'}</span></div></div>}
    </section>}
    <section className="m-card lb-board">
      <Board period={period} windowStart={board!.windowStart} rows={board!.items} neighbours={[]} me={me} rival={ahead?.alias ?? null} total={board!.total} page={number} pageSize={board!.pageSize} loading={loading} onPage={onPage} onProfile={onProfile} />
    </section>
  </>;
}

function ClubChallengeView({ api, me, slug }: { api: ApiClient; me: string | null; slug: string }) {
  const data = useLoad(() => api.clubChallenge(slug), [api, slug]);
  const value = data.value;
  if (data.error !== null && !value) return <Notice tone="error">Could not load the challenge: {errorText(data.error)}</Notice>;
  if (!value) return <Loading>Loading the challenge…</Loading>;
  const info = CHALLENGES[value.kind];
  const mine = value.standings.find((row) => row.alias === me) ?? null;
  const leader = value.standings[0]?.qualified ? value.standings[0] : null;
  return <>
    <section className="m-card">
      <div className="lb-head"><h2>{info.name}</h2><span className="lb-reset">{info.rule} · ends in <b>{weekLeft()}</b></span></div>
      <div className="m-stat-strip mc-overview">
        <div><div className="m-label">You</div><div className="m-stat-value mc-you">{challengeText(value.kind, mine?.value ?? null)}</div><div className="sub">week to date</div></div>
        <div><div className="m-label">Your place</div><div className="m-stat-value">{mine?.rank ? `#${mine.rank}` : '—'}</div><div className="sub">of {formatExact(value.standings.filter((row) => row.qualified).length)} qualified</div></div>
        <div><div className="m-label">Leading</div><div className="m-stat-value mc-word">{leader?.alias ?? '—'}</div><div className="sub">{leader ? challengeText(value.kind, leader.value) : 'no one qualified yet'}</div></div>
        <div><div className="m-label">Next week</div><div className="m-stat-value mc-word">{CHALLENGES[value.next].name}</div><div className="sub">from Monday 00:00 UTC</div></div>
      </div>
      <table className="m-table lb-table">
        <thead><tr><th scope="col" className="l">Rank</th><th scope="col" className="l">Builder</th><th scope="col" className="sorted">{value.kind === 'cache' ? 'Hit rate' : info.name}</th><th scope="col">Tokens</th></tr></thead>
        <tbody>{value.standings.map((row) => <tr key={row.alias} className={row.alias === me ? 'you' : undefined}>
          <td className="l"><span className="lb-rk"><span className={`rank${row.rank && row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{row.rank ? formatExact(row.rank) : '–'}</span></span></td>
          <td className="l"><div className="lb-user"><Avatar alias={row.alias} /><span className="lb-name">{row.alias}{row.alias === me && <span className="m-badge accent">You</span>}</span>{!row.qualified && <span className="lb-meta mc-pending">not qualified yet</span>}</div></td>
          <td className="lb-total">{row.qualified ? challengeText(value.kind, row.value) : <span className="zero">—</span>}</td>
          <td title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <section className="m-card"><div className="lb-head"><h2>Past challenges</h2></div>
      <table className="m-table lb-table"><thead><tr><th scope="col" className="l">Challenge</th><th scope="col" className="l">Week of</th><th scope="col" className="l">Winner</th><th scope="col">Result</th></tr></thead>
        <tbody>{value.past.map((row) => <tr key={row.week}><td className="l">{CHALLENGES[row.kind].name}</td><td className="l">{shortDay(row.week)}</td><td className="l">{row.winner ?? 'No winner'}</td><td>{row.value === null ? '—' : challengeText(row.kind, row.value)}</td></tr>)}</tbody></table>
    </section>
  </>;
}

function ClubMembersView({ api, me, page, site, onChange }: { api: ApiClient; me: string | null; page: ClubPage; site: string | null; onChange: () => void }) {
  const [round, setRound] = useState(0);
  const data = useLoad(() => api.clubMembers(page.club.slug), [api, page.club.slug, round]);
  // The club's latest code; a reset shows the new one at once and reloads the club, so it stays across tabs.
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => { setFresh(null); }, [page.invite]);
  const code = fresh ?? page.invite;
  const [resetting, setResetting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (reason: unknown) => setError(errorText(reason));
  const admin = page.membership?.role === 'owner' || page.membership?.role === 'admin';
  const link = code && site ? `${site}/c/${page.club.slug}?invite=${code}` : null;
  const copy = () => { if (link) void navigator.clipboard?.writeText(link).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => {}); };
  return <>
    {code && <section className="m-card mc-invite">
      <div className="lb-head"><h2>Invite</h2>{page.club.visibility === 'private' && <span className="lb-reset">{formatExact(Math.max(0, CLUB_PRIVATE_LIMIT - page.club.members))} of {CLUB_PRIVATE_LIMIT} spots left</span>}</div>
      <div className="mc-invite-row"><code>{link ?? code}</code>{link && <button type="button" className="m-btn" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>}
        {page.club.visibility === 'private' && <span className="m-pill">Code <b>{code}</b></span>}
        {admin && page.club.visibility === 'private' && <button type="button" className="m-btn" disabled={resetting} onClick={() => { if (!resetting && window.confirm('Reset the invite link? The old link and code stop working.')) { setError(null); setResetting(true); api.resetClubInvite(page.club.slug).then((value) => { setFresh(value.invite); onChange(); }, fail).finally(() => setResetting(false)); } }}>Reset</button>}</div>
    </section>}
    {error && <Notice tone="error">{error}</Notice>}
    <section className="m-card">
      <div className="lb-head"><h2>Members</h2><span className="m-badge lb-count">{formatExact(page.club.members)}</span></div>
      {data.error !== null && <Notice tone="error">Could not load members: {errorText(data.error)}</Notice>}
      {!data.value ? data.error === null && <Loading>Loading members…</Loading> : <table className="m-table lb-table">
        <thead><tr><th scope="col" className="l">Member</th><th scope="col">Joined</th><th scope="col">This week</th>{admin && <th scope="col" aria-label="Actions" />}</tr></thead>
        <tbody>{data.value.items.map((member) => <tr key={member.alias} className={member.alias === me ? 'you' : undefined}>
          <td className="l"><div className="lb-user"><Avatar alias={member.alias} /><span className="lb-name">{member.alias}{member.alias === me && <span className="m-badge accent">You</span>}{member.role !== 'member' && <span className="m-badge">{member.role === 'owner' ? 'Owner' : 'Admin'}</span>}</span>
            <span className="lb-meta">{member.toolTokens && <span className="lb-tools">{toolsOf(member.toolTokens).map((id) => <ToolIcon key={id} id={id} />)}</span>}</span></div></td>
          <td>{shortDay(member.joinedAt.slice(0, 10))}</td>
          <td className="lb-total" title={tokensTitle(member.tokens)}>{formatCompact(member.tokens)}</td>
          {admin && <td>{member.alias !== me && member.role === 'member' && <button type="button" className="m-btn" onClick={() => { if (window.confirm(`Remove ${member.alias} from ${page.club.name}?`)) { setError(null); api.removeClubMember(page.club.slug, member.alias).then(() => setRound((n) => n + 1), fail); } }}>Remove</button>}</td>}
        </tr>)}</tbody>
      </table>}
    </section>
  </>;
}

/** The New club sheet: name, mark, who can join, the first week's challenge and the league. */
function NewClub({ api, me, go, onClose }: { api: ApiClient; me: string | null; go: Go; onClose: () => void }) {
  const [name, setName] = useState('');
  const [mark, setMark] = useState<ClubMarkId>('moon');
  const [visibility, setVisibility] = useState<ClubVisibility>('private');
  const [challenge, setChallenge] = useState<ChallengeKind>('tokens');
  const [league, setLeague] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const valid = CLUB_NAME_PATTERN.test(trimmed) && /[\p{L}\p{N}]$/u.test(trimmed);
  const create = async () => {
    setBusy(true); setError(null);
    try { const club = await api.createClub({ name: trimmed, description: '', mark, visibility, category: null, league: visibility === 'public' || league, challenge }); clubsChanged(); onClose(); go({ page: 'club', slug: club.slug, tab: 'members' }); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return <ProfileDialog labelledBy="mc-new-title" onClose={onClose}>
    <form className="mc-sheet" onSubmit={(event) => { event.preventDefault(); if (valid) void create(); }}>
      <h2 id="mc-new-title">New club</h2>
      {!me && <Notice>Join the leaderboard from Settings first: clubs rank the totals members publish.</Notice>}
      <label className="mc-field">Name<input className="m-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus /></label>
      <div className="mc-field" role="group" aria-label="Mark">Mark<div className="mc-pick">{CLUB_MARK_IDS.map((id) => <button key={id} type="button" className="club-mark" aria-pressed={mark === id} aria-label={CLUB_MARKS[id].name} onClick={() => setMark(id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{CLUB_MARKS[id].shapes.map((shape, index) => <MarkShape key={index} shape={shape} />)}</svg></button>)}</div></div>
      <div className="mc-field">Who can join<Seg label="Who can join" value={visibility} options={[['private', 'Private · invite'], ['public', 'Public · anyone']]} onChange={setVisibility} />
        <small>{visibility === 'private' ? `Up to ${CLUB_PRIVATE_LIMIT} members. Never listed or searchable.` : 'Listed in Discover. Anyone on the leaderboard can join.'}</small></div>
      <div className="mc-field">This week’s challenge<Seg label="Challenge" value={challenge} options={CHALLENGE_KINDS.map((kind) => [kind, CHALLENGES[kind].option] as [ChallengeKind, string])} onChange={setChallenge} /></div>
      {visibility === 'private' && <label className="mc-switch"><span>Enter the league<small>Other clubs see name, size and totals.</small></span><input type="checkbox" className="switch" checked={league} onChange={(event) => setLeague(event.target.checked)} /></label>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="mc-sheet-foot"><button type="button" className="m-btn" onClick={onClose}>Cancel</button><button type="submit" className="m-btn primary" disabled={!valid || busy || !me}>{busy ? 'Creating…' : 'Create club'}</button></div>
    </form>
  </ProfileDialog>;
}

/** The Join with a code sheet: an invite link or code. */
function JoinCode({ api, go, onClose }: { api: ApiClient; go: Go; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const join = async () => {
    const code = inviteCode(value);
    if (!code) { setError('Paste an invite link or a code like NIGHT-7K2Q.'); return; }
    setBusy(true); setError(null);
    try { const club = await api.joinClubByCode(code); clubsChanged(); onClose(); go({ page: 'club', slug: club.slug, tab: 'board' }); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return <ProfileDialog labelledBy="mc-join-title" onClose={onClose}>
    <form className="mc-sheet" onSubmit={(event) => { event.preventDefault(); void join(); }}>
      <h2 id="mc-join-title">Join with a code</h2>
      <label className="mc-field">Invite link or code<input className="m-input" value={value} onChange={(event) => setValue(event.target.value)} placeholder="NIGHT-7K2Q" autoFocus /></label>
      <small className="faint">{`Members see each other’s totals, tools and models, as on the public board. Projects, prompts and code stay on this Mac.`}</small>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="mc-sheet-foot"><button type="button" className="m-btn" onClick={onClose}>Cancel</button><button type="submit" className="m-btn primary" disabled={busy}>{busy ? 'Joining…' : 'Join'}</button></div>
    </form>
  </ProfileDialog>;
}
