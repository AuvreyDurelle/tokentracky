import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { CACHE_CHALLENGE_MINIMUM, CHALLENGES, CHALLENGE_KINDS, CLUB_CATEGORIES, CLUB_DESCRIPTION_MAX, CLUB_MARK_IDS, CLUB_MARKS, CLUB_NAME_PATTERN, CLUB_PRIVATE_LIMIT, LEAGUE_MIN_ACTIVE, LEAGUE_SMALL_MAX, challengeUnit,
  clubWeek, inviteCode, type ChallengeKind, type ClubCategory, type ClubDivision, type ClubIdentity, type ClubMark as ClubMarkId, type ClubPage, type ClubStanding, type ClubVisibility,
  type ClubMember, type ClubRef, type ClubSort, type LeagueRow, type ClubWeek, type LeaderboardPeriod, type MatchupRequest, type MatchupSide, type MyClub, type MyClubs, type ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient } from '../api';
import { ClubMark, MarkShape, clubHue } from '../ClubMark';
import { errorText, formatCompact, formatCost, formatCostCompact, formatExact, shortDay, toolLabel, topPercent } from '../format';
import type { ClubsTab, ClubTab, Route } from '../route';
import { Avatar, Empty, Loading, Notice, SearchIcon, ToolIcon, avatarHue } from '../ui';
import { Board, RivalStrip, ToolShare, TrendArea } from './LeaderboardView';
import { cumulative, edge, isHot, leadByDay, slugOf, type Side } from './clubs-model';
import { useLoad } from './load';
import { Bars, CHALLENGE_ICON, CROWN, DAYS, DayPips, FLAME, LineRace, Meter, Podium, Rope, SWORDS, TROPHY, Verdict, WeekClock, hue, place, useWeekStart } from './ClubParts';
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
  // A new week loads each tab afresh; an open sheet stays as it is.
  const week = useWeekStart();
  return <div className="m-page m-lb mc-clubs">
    <ToolbarActions>
      <Seg label="Clubs" value={tab} options={[['mine', 'Your clubs'], ['discover', 'Discover'], ['league', 'League'], ['matchups', 'Matchups']]} onChange={(next) => go({ page: 'clubs', tab: next })} />
      <button type="button" className="m-btn primary" onClick={() => setSheet('new')}>New club</button>
    </ToolbarActions>
    <Fragment key={week}>
      {tab === 'mine' && <YourClubs api={api} me={me} go={go} onJoin={onJoin} onCode={() => setSheet('join')} onNew={() => setSheet('new')} />}
      {tab === 'discover' && <Discover api={api} go={go} onJoin={onJoin} />}
      {tab === 'league' && <League api={api} go={go} onJoin={onJoin} />}
      {tab === 'matchups' && <Matchups api={api} go={go} onJoin={onJoin} />}
    </Fragment>
    {sheet === 'new' && <NewClub api={api} me={me} go={go} onClose={() => setSheet(null)} />}
    {sheet === 'join' && <JoinCode api={api} go={go} onClose={() => setSheet(null)} />}
  </div>;
}

function YourClubs({ api, me, go, onJoin, onCode, onNew }: { api: ApiClient; me: string | null; go: Go; onJoin: () => void; onCode: () => void; onNew: () => void }) {
  const [round, setRound] = useState(0);
  const mine = useLoad(() => api.myClubs(), [api, me, round]);
  const [error, setError] = useState<string | null>(null);
  // From an answer until the list has reloaded, none of the challenges can be answered again.
  const [answering, setAnswering] = useState(false);
  useEffect(() => { setAnswering(false); }, [mine.value]);
  const answer = (id: string, value: 'accept' | 'decline') => { setError(null); setAnswering(true); api.answerMatchup(id, value).then(() => setRound((n) => n + 1), (reason: unknown) => { setError(errorText(reason)); setAnswering(false); }); };
  const [open, setOpen] = useState<[string, string] | null>(null);
  const fights = mine.value?.clubs.flatMap((entry) => entry.matchup ? [entry.matchup] : []) ?? [];
  const leading = fights.filter((fight) => fight.perMember > fight.opponentPerMember).length;
  return <>
    <div className="page-head mc-page-head"><div><h1 className="m-page-title">Your clubs</h1><p className="m-page-sub">Week of {shortDay(clubWeek(new Date()).start.slice(0, 10))}
      {fights.length > 0 && <><span className="sep" />Leading {formatExact(leading)} of {plural(fights.length, 'matchup')}</>}</p>
      <button type="button" className="m-btn mc-code" onClick={onCode}>Join with a code</button></div>
      <WeekClock /></div>
    {mine.error !== null && !mine.value && <NotLinked error={mine.error} onJoin={onJoin} />}
    {!mine.value && mine.error === null && <Loading>Loading your clubs…</Loading>}
    {mine.error !== null && mine.value && <Notice tone="error">Could not refresh your clubs: {errorText(mine.error)} <button type="button" className="m-btn st-sm" onClick={() => setRound((n) => n + 1)}>Retry</button></Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {mine.value && mine.value.requests.length > 0 && <section className="mc-stack" aria-label="Challenges waiting on you">{mine.value.requests.map((request) => <Incoming key={request.id} request={request} busy={answering || mine.loading} onAnswer={answer} onScout={() => setOpen([request.to.slug, request.from.slug])} />)}</section>}
    {mine.value?.clubs.length === 0 && <section className="m-card mc-empty"><Empty title="No club, no rivals" action={<span className="mc-actions"><button type="button" className="m-btn primary" onClick={onNew}>Start a club</button><button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'discover' })}>Discover clubs</button></span>}>Start a private club for your team or friends, or join a public one. Every week your club climbs the league, takes on another club and plays a challenge.</Empty></section>}
    {mine.value?.clubs.map((entry) => <BattleCard key={entry.club.slug} entry={entry} go={go} />)}
    {open && <HeadToHead api={api} a={open[0]} b={open[1]} mine={mine.value} go={go} onClose={() => setOpen(null)} onChanged={() => setRound((n) => n + 1)} onBusy={setAnswering} hold={answering} />}
  </>;
}

/** A challenge for next week waiting on your answer: both clubs face to face, with this week's pace. */
function Incoming({ request, busy, onAnswer, onScout }: { request: MatchupRequest; busy: boolean; onAnswer: (id: string, value: 'accept' | 'decline') => void; onScout: () => void }) {
  const gap = request.toPerMember - request.fromPerMember;
  return <section className="m-card mc-incoming">
    <div className="mc-incoming-k"><span className="mc-ping" />{SWORDS}<b>{request.from.name}</b> wants a matchup for the week of {shortDay(request.week)}</div>
    <div className="mc-versus">
      <VersusSide club={request.from} note={standingText(request.fromStanding)} value={request.fromPerMember} ahead={gap < 0} />
      <span className="mc-vs">VS</span>
      <VersusSide club={request.to} note="Your club" value={request.toPerMember} ahead={gap > 0} />
      <div className="mc-incoming-act">
        <p>{gap > 0 ? <>You’re <b className="up">{formatCompact(gap)}</b> per member ahead on this week’s pace. Favourites.</> : gap < 0 ? <>They’re <b className="down">{formatCompact(-gap)}</b> per member ahead on this week’s pace. Fancy an upset?</> : 'Dead level on this week’s pace.'}</p>
        <span className="mc-actions"><button type="button" className="m-btn" disabled={busy} onClick={onScout}>Tale of the tape</button><button type="button" className="m-btn" disabled={busy} onClick={() => onAnswer(request.id, 'decline')}>Decline</button><button type="button" className="m-btn primary mc-fight-btn" disabled={busy} onClick={() => onAnswer(request.id, 'accept')}>{SWORDS}Accept</button></span>
      </div>
    </div>
  </section>;
}
function VersusSide({ club, note, value, ahead }: { club: ClubRef; note: string; value: number; ahead: boolean }) {
  return <div className={`mc-vside${ahead ? ' ahead' : ''}`} style={hue(club.slug)}>
    <ClubMark mark={club.mark} slug={club.slug} size="lg" />
    <span className="club-name"><strong>{club.name}</strong><small>{note}</small></span>
    <span className="mc-vfig"><b title={tokensTitle(value)}>{formatCompact(value)}</b><small>per member</small></span>
  </div>;
}

/** One of your clubs this week: your place, the matchup, the league and the challenge. */
function BattleCard({ entry, go }: { entry: MyClub; go: Go }) {
  const { club, role, week, you, standing, challenge, matchup } = entry;
  const delta = change(week);
  const top = you.rank ? topPercent(you.rank, you.ranked) : null;
  const open = (tab: ClubTab) => go({ page: 'club', slug: club.slug, tab });
  const lead = matchup ? matchup.perMember - matchup.opponentPerMember : 0;
  const info = CHALLENGES[challenge.kind];
  return <section className="m-card mc-battle" style={hue(club.slug)}>
    <header className="mc-battle-head">
      <ClubMark mark={club.mark} slug={club.slug} size="lg" />
      <button type="button" className="club-name mc-open" onClick={() => open('board')}><strong>{club.name}</strong><small>{visibilityName(club.visibility)} · {plural(club.members, 'member')}{role !== 'member' && ` · ${role === 'owner' ? 'Owner' : 'Admin'}`}</small></button>
      <span className="mc-battle-week"><Bars values={week.daily} label={`Club tokens per UTC day, last ${week.daily.length} days`} /><span><b title={tokensTitle(week.tokens)}>{formatCompact(week.tokens)}</b>{delta !== null && <span className={`mc-delta${delta < 0 ? ' neg' : ''}`}>{delta >= 0 ? '▲' : '▼'}{Math.round(Math.abs(delta) * 100)}%</span>}<small>club tokens this week</small></span></span>
    </header>
    <div className="mc-battle-body">
      <button type="button" className="mc-tile mc-rank" onClick={() => open('board')}>
        <span className="m-label">Your rank</span>
        <span className={`mc-big${place(you.rank)}`}>{you.rank === 1 && CROWN}{you.rank ? `#${formatExact(you.rank)}` : '—'}</span>
        <span className="sub">{you.rank ? <>of {formatExact(you.ranked)}{top && ` · ${top.toLowerCase()}`}<Move rank={you.rank} previous={you.previousRank} /></> : 'No tokens from you yet'}</span>
      </button>
      <div className="mc-tile mc-fight">
        {matchup ? <>
          <div className="mc-fight-head"><span className="m-label">Matchup · vs {matchup.opponent.name}</span><Verdict us={matchup.perMember} them={matchup.opponentPerMember} /></div>
          <div className="mc-fight-row">
            <b className={lead >= 0 ? 'ahead' : undefined} title={`${tokensTitle(matchup.perMember)} per active member`}>{formatCompact(matchup.perMember)}</b>
            <Rope a={club.slug} b={matchup.opponent.slug} aValue={matchup.perMember} bValue={matchup.opponentPerMember} label={`${club.name} ${formatCompact(matchup.perMember)} to ${matchup.opponent.name} ${formatCompact(matchup.opponentPerMember)} per member`} />
            <b className={lead <= 0 ? 'ahead' : undefined} title={`${tokensTitle(matchup.opponentPerMember)} per active member`}>{formatCompact(matchup.opponentPerMember)}</b>
          </div>
          <div className="mc-fight-foot"><span>{lead === 0 ? 'Dead level' : <>{lead > 0 ? 'Up' : 'Down'} <b>{formatCompact(Math.abs(lead))}</b> per member</>}</span><span className="mc-led">Led {formatExact(matchup.daysLed)} of {plural(matchup.days, 'day')}<DayPips led={matchup.daysLed} days={matchup.days} /></span></div>
        </> : <div className="mc-fight-none"><span className="m-label">Matchup</span><p>No matchup this week.{role !== 'member' && standing ? ' Pick a rival from the league for next week.' : ''}</p>
          {role !== 'member' && standing && <button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'league' })}>{SWORDS}Find a rival</button>}</div>}
      </div>
      <div className="mc-tile mc-pair">
        <button type="button" onClick={() => go({ page: 'clubs', tab: 'league' })}>
          <span className="m-label">{standing ? `${divisionName(standing.division)} league` : 'League'}</span>
          <span className={`mc-mid${place(standing?.rank)}`}>{standing?.rank ? `#${formatExact(standing.rank)}` : '—'}<Move rank={standing?.rank ?? null} previous={standing?.previousRank ?? null} /></span>
          <span className="sub">{standing?.rank ? `${formatCompact(week.perMember)} per member` : standing ? `${LEAGUE_MIN_ACTIVE} active members to rank` : 'Not in the league'}</span>
        </button>
        <button type="button" onClick={() => open('challenge')}>
          <span className={`m-label mc-kind k-${challenge.kind}`}>{CHALLENGE_ICON[challenge.kind]}{info.name}</span>
          <span className={`mc-mid${place(challenge.you.rank)}`}>{challenge.you.rank ? `#${formatExact(challenge.you.rank)}` : '—'}<small>{challengeText(challenge.kind, challenge.you.value)}</small></span>
          <span className="sub">{challenge.you.rank === 1 ? 'You lead the challenge' : challenge.leader ? `${challenge.leader.alias} leads · ${challengeText(challenge.kind, challenge.leader.value)}` : 'No one has qualified yet'}</span>
        </button>
      </div>
    </div>
    <footer className="mc-battle-foot">
      <span><b>{formatExact(week.active)}</b> of {formatExact(club.members)} active<Meter value={week.active} of={club.members} tone="hue" /></span>
      <span><b title={tokensTitle(week.last24hTokens)}>{formatCompact(week.last24hTokens)}</b> in the last 24 hours</span>
      <span><b title={tokensTitle(week.perMember)}>{formatCompact(week.perMember)}</b> per active member</span>
    </footer>
  </section>;
}

const SORTS: Array<[ClubSort, string]> = [['members', 'Biggest'], ['active', 'Most active'], ['newest', 'Newest']];
function Discover({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const [category, setCategory] = useState<ClubCategory | null>(null);
  const [sort, setSort] = useState<ClubSort>('members');
  const [search, setSearch] = useState('');
  const query = search.trim();
  // Pages of 60, the next loaded on demand; a new search, category or order starts over.
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [query, category, sort]);
  const list = useLoad(async () => {
    const loaded = await Promise.all(Array.from({ length: pages }, (_, index) => api.clubList(query, category, sort, index + 1, 60)));
    return { ...loaded[0]!, items: loaded.flatMap((page) => page.items) };
  }, [api, query, category, sort, pages], query ? 250 : 0);
  const [error, setError] = useState<string | null>(null);
  const join = (slug: string) => { setError(null); api.joinClub(slug).then(() => { clubsChanged(); go({ page: 'club', slug, tab: 'board' }); }, (reason: unknown) => setError(errorText(reason))); };
  return <>
    <div className="page-head"><div><h1 className="m-page-title">Discover</h1><p className="m-page-sub">Public clubs to join. Private clubs are never listed.</p></div>
      <label className="lb-search"><SearchIcon /><span className="sr-only">Search clubs</span><input type="search" placeholder="Search clubs" value={search} maxLength={30} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <div className="mc-chips"><Seg<string> label="Category" value={category ?? 'all'} options={[['all', 'All'], ...(Object.entries(CLUB_CATEGORIES) as Array<[string, string]>)]} onChange={(value) => setCategory(value === 'all' ? null : value as ClubCategory)} />
      <Seg label="Order" value={sort} options={SORTS} onChange={setSort} /></div>
    {list.error !== null && !list.value && <NotLinked error={list.error} onJoin={onJoin} />}
    {error && <Notice tone="error">{error}</Notice>}
    {!list.value && list.error === null && <Loading>Loading clubs…</Loading>}
    {list.value?.items.length === 0 && <section className="m-card"><Empty title={query || category ? 'No clubs match' : 'No public clubs yet'}>{query || category ? 'Try another search or category.' : 'Start the first one with New club.'}</Empty></section>}
    {list.value && list.value.items.length > 0 && <div className="mc-grid">{list.value.items.map((club) => <section key={club.slug} className="m-card mc-card" style={hue(club.slug)}>
      <header><ClubMark mark={club.mark} slug={club.slug} size="lg" /><button type="button" className="club-name mc-open" onClick={() => go({ page: 'club', slug: club.slug, tab: 'board' })}><strong>{club.name}</strong><small>{club.category ? CLUB_CATEGORIES[club.category] : 'Public club'}</small></button>
        {isHot(club.week.active, club.members) && <span className="mc-hot" title="Most of its members are active this week">{FLAME}Hot</span>}</header>
      <p>{club.description || 'No description yet.'}</p>
      <div className="mc-card-fig"><span><b title={tokensTitle(club.week.tokens)}>{formatCompact(club.week.tokens)}</b><small>tokens this week</small></span><Bars values={club.week.daily} label={`${club.name}: tokens per UTC day, last ${club.week.daily.length} days`} /></div>
      <div className="mc-card-active"><span><b>{formatExact(club.week.active)}</b> of {plural(club.members, 'member')} active</span><Meter value={club.week.active} of={club.members} tone="hue" /></div>
      <footer><span className="lb-tools">{toolsOf(club.week.toolTokens).map((id) => <ToolIcon key={id} id={id} />)}</span>{club.joined ? <span className="m-badge accent">Joined</span> : <button type="button" className="m-btn primary" onClick={() => join(club.slug)}>Join</button>}</footer>
    </section>)}</div>}
    {list.value && list.value.items.length < list.value.total && <div className="mc-more"><button type="button" className="m-btn" onClick={() => setPages((value) => value + 1)}>Load more clubs</button></div>}
  </>;
}
const toolsOf = (toolTokens: Partial<Record<ToolId, number>>) => (Object.entries(toolTokens) as Array<[ToolId, number]>).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);

function League({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const [division, setDivision] = useState<ClubDivision>('small');
  const [pages, setPages] = useState(1);
  const [round, setRound] = useState(0);
  useEffect(() => { setPages(1); }, [division]);
  const league = useLoad(async () => {
    const loaded = await Promise.all(Array.from({ length: pages }, (_, index) => api.league(division, index + 1, 100)));
    return { ...loaded[0]!, items: loaded.flatMap((page) => page.items) };
  }, [api, division, pages]);
  const mine = useLoad(() => api.myClubs(), [api, round]);
  const [open, setOpen] = useState<[string, string] | null>(null);
  const value = league.value;
  // The club you'd challenge from: one you run in this division, ranked if you have one.
  const runs = mine.value?.clubs.filter((entry) => entry.standing?.division === division && entry.role !== 'member') ?? [];
  const challenger = runs.find((entry) => entry.standing?.rank) ?? runs[0] ?? null;
  const ours = new Set(mine.value?.clubs.map((entry) => entry.club.slug) ?? []);
  const reachable = (row: LeagueRow) => row.club.visibility === 'public' || row.mine;
  const top = value?.items.filter((row) => row.rank <= 3) ?? [];
  return <>
    <div className="page-head mc-page-head"><div><h1 className="m-page-title">League</h1><p className="m-page-sub">Ranked weekly by tokens per active member. {LEAGUE_MIN_ACTIVE} active members to rank.</p>
      <div className="mc-code"><Seg label="Division" value={division} options={[['small', `Small · up to ${LEAGUE_SMALL_MAX}`], ['large', `Large · ${LEAGUE_SMALL_MAX}+`]]} onChange={setDivision} /></div></div>
      <WeekClock label="League week ends in" /></div>
    {league.error !== null && !value && <NotLinked error={league.error} onJoin={onJoin} />}
    {!value && league.error === null && <Loading>Loading the league…</Loading>}
    {value && <>
      {value.lastWinner && <section className="mc-champ" style={hue(value.lastWinner.slug)}>
        <span className="mc-champ-cup">{TROPHY}</span>
        <span className="mc-champ-k">Last week’s {divisionName(division)} champion</span>
        <ClubMark mark={value.lastWinner.mark} slug={value.lastWinner.slug} />
        {value.lastWinner.visibility === 'public' || ours.has(value.lastWinner.slug) ? <button type="button" className="mc-open" onClick={() => go({ page: 'club', slug: value.lastWinner!.slug, tab: 'board' })}><strong>{value.lastWinner.name}</strong></button> : <strong>{value.lastWinner.name}</strong>}
      </section>}
      {top.length > 0 && <Podium label={`${divisionName(division)} league top ${top.length}`} places={top.map((row) => ({ key: row.club.slug, name: row.club.name, value: formatCompact(row.perMember), title: `${tokensTitle(row.perMember)} per active member`, face: <ClubMark mark={row.club.mark} slug={row.club.slug} size="xl" />,
        you: row.mine, sub: `per member · ${formatExact(row.active)} of ${formatExact(row.club.members)} active`, onOpen: reachable(row) ? () => go({ page: 'club', slug: row.club.slug, tab: 'board' }) : undefined }))} />}
      {value.items.filter((row) => row.mine).map((row) => {
        const above = value.items.find((other) => other.rank === row.rank - 1) ?? null;
        const below = value.items.find((other) => other.rank === row.rank + 1) ?? null;
        const runsIt = runs.some((entry) => entry.club.slug === row.club.slug);
        return <section key={row.club.slug} className="m-card mc-chase" style={hue(row.club.slug)}>
          <ClubMark mark={row.club.mark} slug={row.club.slug} size="lg" />
          <div className="mc-chase-id"><span className="m-label">Your club</span><strong><span className={place(row.rank)}>#{formatExact(row.rank)}</span> {row.club.name}<Move rank={row.rank} previous={row.previousRank} /></strong></div>
          <div className="mc-chase-gap">
            <span>{above ? <><b>{formatCompact(above.perMember - row.perMember)}</b> per member to pass <b>{above.club.name}</b> for #{formatExact(above.rank)}</> : <>{CROWN}<b>Top of the {divisionName(division)} league</b></>}</span>
            <Meter value={row.perMember} of={above?.perMember ?? row.perMember} tone="hue" />
            {below && <small>{formatCompact(row.perMember - below.perMember)} per member ahead of {below.club.name}</small>}
          </div>
          {runsIt && above && !above.mine && <button type="button" className="m-btn mc-fight-btn" onClick={() => setOpen([row.club.slug, above.club.slug])}>{SWORDS}Challenge {above.club.name}</button>}
        </section>;
      })}
      <section className="m-card">
        <div className="m-stat-strip mc-overview">
          <div><div className="m-label">Clubs ranked</div><div className="m-stat-value">{formatExact(value.total)}</div><div className="sub">{LEAGUE_MIN_ACTIVE} active members to rank</div></div>
          <div><div className="m-label">Active members</div><div className="m-stat-value">{formatExact(value.activeMembers)}</div><div className="sub">synced this week</div></div>
          <div><div className="m-label">Tokens this week</div><div className="m-stat-value" title={tokensTitle(value.tokens)}>{formatCompact(value.tokens)}</div><div className="sub">{value.activeMembers ? `${formatCompact(Math.round(value.tokens / value.activeMembers))} per active member` : 'no one active yet'}</div></div>
          <div><div className="m-label">Last week’s winner</div><div className="m-stat-value mc-word">{value.lastWinner?.name ?? '—'}</div><div className="sub">{divisionName(division)} division</div></div>
        </div>
        {value.items.length === 0 ? <Empty title="No clubs ranked yet">A club ranks once {LEAGUE_MIN_ACTIVE} of its members are active in the week.</Empty> : <table className="m-table lb-table mc-league">
          <colgroup><col className="mcl-rank" /><col /><col className="mcl-active" /><col className="mcl-per" /><col className="mcl-days x2" /><col className="mcl-num x2" /><col className="mcl-num x1" /><col className="mcl-num x1" />{challenger && <col className="mcl-act" />}</colgroup>
          <thead><tr><th scope="col" className="l">Rank</th><th scope="col" className="l">Club</th><th scope="col">Active</th><th scope="col" className="sorted" aria-sort="descending">Per member</th><th scope="col" className="x2">7 days</th><th scope="col" className="x2">Tokens</th><th scope="col" className="x1">Est. cost</th><th scope="col" className="x1">24h</th>{challenger && <th scope="col" aria-label="Challenge" />}</tr></thead>
          <tbody>{value.items.map((row) => <tr key={row.club.slug} className={`${row.mine ? 'you' : ''}${reachable(row) ? '' : ' mc-locked'}`} onClick={() => reachable(row) && go({ page: 'club', slug: row.club.slug, tab: 'board' })}>
            <td className="l"><span className="lb-rk"><span className={`rank${row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{formatExact(row.rank)}</span><Move rank={row.rank} previous={row.previousRank} /></span></td>
            <td className="l"><div className="lb-user"><ClubMark mark={row.club.mark} slug={row.club.slug} /><span className="lb-name"><span className="mc-name">{row.club.name}</span>{row.mine && <span className="m-badge accent">Yours</span>}{row.club.visibility === 'private' && <span className="m-badge">Private</span>}</span></div></td>
            <td><span className="mc-active-cell">{formatExact(row.active)} of {formatExact(row.club.members)}<Meter value={row.active} of={row.club.members} /></span></td>
            <td className="lb-total" title={`${formatExact(row.perMember)} tokens per active member`}>{formatCompact(row.perMember)}</td>
            <td className="x2" style={hue(row.club.slug)}><Bars values={row.daily} label={`${row.club.name}: tokens per active member per UTC day, last ${row.daily.length} days`} /></td>
            <td className="x2" title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
            <td className="lb-cost x1">{row.toolTokens === undefined ? <span className="zero" title="Not shared">—</span> : row.costMicrousd == null ? <span className="zero" title="Pricing unknown">—</span> : <span title={formatCost(row.costMicrousd)}>{formatCostCompact(row.costMicrousd)}</span>}</td>
            <td className="x1">{row.last24hTokens === undefined ? <span className="zero" title="Not shared">—</span> : formatCompact(row.last24hTokens)}</td>
            {challenger && <td>{!row.mine && !ours.has(row.club.slug) && <button type="button" className="m-btn mc-fight-sm" title={`${challenger.club.name} against ${row.club.name}`} onClick={(event) => { event.stopPropagation(); setOpen([challenger.club.slug, row.club.slug]); }} aria-label={`Challenge ${row.club.name}`}>{SWORDS}<span>Challenge</span></button>}</td>}
          </tr>)}</tbody>
        </table>}
        {value.items.length < value.total && <div className="mc-more"><button type="button" className="m-btn" onClick={() => setPages((count) => count + 1)}>Load more clubs</button></div>}
      </section>
    </>}
    {open && <HeadToHead api={api} a={open[0]} b={open[1]} mine={mine.value} go={go} onClose={() => setOpen(null)} onChanged={() => setRound((n) => n + 1)} />}
  </>;
}

function Matchups({ api, go, onJoin }: { api: ApiClient; go: Go; onJoin: () => void }) {
  const [round, setRound] = useState(0);
  const list = useLoad(() => api.matchups(), [api, round]);
  const mine = useLoad(() => api.myClubs(), [api, round]);
  const [open, setOpen] = useState<[string, string] | null>(null);
  const ours = new Set(mine.value?.clubs.map((entry) => entry.club.slug) ?? []);
  const yours = list.value?.items.filter((row) => row.mine) ?? [];
  const others = list.value?.items.filter((row) => !row.mine) ?? [];
  return <>
    <div className="page-head mc-page-head"><div><h1 className="m-page-title">Matchups</h1><p className="m-page-sub">Club against club, by tokens per active member. The week’s total decides it.</p></div><WeekClock label="Matchups end in" /></div>
    {list.error !== null && !list.value && <NotLinked error={list.error} onJoin={onJoin} />}
    {!list.value && list.error === null && <Loading>Loading matchups…</Loading>}
    {list.value?.items.length === 0 && <section className="m-card"><Empty title="No matchups this week" action={<button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'league' })}>{SWORDS}Find a rival in the league</button>}>Admins challenge another league club for next week from the League; the other club’s admins accept.</Empty></section>}
    {yours.map((row) => {
      // Your club on the left, whichever side the server put it.
      const [us, them] = ours.has(row.b.club.slug) && !ours.has(row.a.club.slug) ? [row.b, row.a] : [row.a, row.b];
      return <MatchupCard key={row.id} us={us} them={them} go={go} onTape={() => setOpen([us.club.slug, them.club.slug])} />;
    })}
    {others.length > 0 && <section className="m-card mc-others"><div className="lb-head"><h2>Around the league</h2><span className="m-badge lb-count">{formatExact(others.length)}</span></div>
      <ul className="club-list">{others.map((row) => {
        const lead = edge(row.a.perMember, row.b.perMember);
        return <li key={row.id}><button type="button" className="mc-matchup" onClick={() => setOpen([row.a.club.slug, row.b.club.slug])} aria-label={`${row.a.club.name} against ${row.b.club.name}: tale of the tape`}>
          <span className="mc-side"><ClubMark mark={row.a.club.mark} slug={row.a.club.slug} /><span className="club-name"><strong>{row.a.club.name}</strong><small>{standingText(row.a.standing)} · {row.a.record.won}W–{row.a.record.lost}L</small></span></span>
          <b className={lead === 'a' ? 'ahead' : undefined}>{formatCompact(row.a.perMember)}</b>
          <span className="mc-tug"><Rope a={row.a.club.slug} b={row.b.club.slug} aValue={row.a.perMember} bValue={row.b.perMember} label={`${row.a.club.name} ${formatCompact(row.a.perMember)} to ${row.b.club.name} ${formatCompact(row.b.perMember)} per member`} />
            <small>{lead === null ? 'Level' : `${lead === 'a' ? row.a.club.name : row.b.club.name} by ${formatCompact(Math.abs(row.a.perMember - row.b.perMember))}`}</small></span>
          <b className={lead === 'b' ? 'ahead' : undefined}>{formatCompact(row.b.perMember)}</b>
          <span className="mc-side b"><ClubMark mark={row.b.club.mark} slug={row.b.club.slug} /><span className="club-name"><strong>{row.b.club.name}</strong><small>{standingText(row.b.standing)} · {row.b.record.won}W–{row.b.record.lost}L</small></span></span>
        </button></li>;
      })}</ul></section>}
    {open && <HeadToHead api={api} a={open[0]} b={open[1]} mine={mine.value} go={go} onClose={() => setOpen(null)} onChanged={() => setRound((n) => n + 1)} />}
  </>;
}

/** Your matchup as a scoreboard: both clubs, the rope, who led after each day, the race so far and last week's results. */
function MatchupCard({ us, them, go, onTape }: { us: MatchupSide; them: MatchupSide; go: Go; onTape: () => void }) {
  const led = leadByDay(us.daily, them.daily);
  const lead = us.perMember - them.perMember;
  const last = [us, them].filter((side) => side.last);
  return <section className="m-card mc-score" style={{ '--ha': clubHue(us.club.slug), '--hb': clubHue(them.club.slug) } as CSSProperties}>
    <div className="mc-score-top">
      <ScoreSide side={us} go={go} ahead={lead > 0} open />
      <div className="mc-score-mid"><span className="mc-vs">VS</span><Verdict us={us.perMember} them={them.perMember} /><small>{lead === 0 ? 'Dead level' : `by ${formatCompact(Math.abs(lead))} per member`}</small></div>
      <ScoreSide side={them} go={go} ahead={lead < 0} open={them.club.visibility === 'public'} right />
    </div>
    <Rope a={us.club.slug} b={them.club.slug} aValue={us.perMember} bValue={them.perMember} label={`${us.club.name} ${formatCompact(us.perMember)} to ${them.club.name} ${formatCompact(them.perMember)} per member`} />
    <div className="mc-score-days" aria-label="Who led after each day">{led.map((side, index) => <span key={index} className={side === 'a' ? 'a' : side === 'b' ? 'b' : undefined} title={`${DAYS[index]}: ${side === 'a' ? us.club.name : side === 'b' ? them.club.name : 'level'}`}><i />{DAYS[index]}</span>)}</div>
    <LineRace label={`Tokens per active member so far this week: ${us.club.name} against ${them.club.name}`} days={DAYS.slice(0, Math.max(us.daily.length, them.daily.length))} zero format={(tick) => formatCompact(Math.round(tick))}
      lines={[{ key: 'us', label: us.club.name, hue: clubHue(us.club.slug), values: cumulative(us.daily), you: true }, { key: 'them', label: them.club.name, hue: clubHue(them.club.slug), values: cumulative(them.daily) }]} />
    <footer className="mc-score-foot">
      <span>{last.length ? last.map((side) => <span key={side.club.slug} className={side.last!.won ? 'won' : 'lost'}>{side.last!.won ? TROPHY : null}<b>{side.club.name}</b> {side.last!.won ? 'beat' : 'lost to'} {side.last!.opponent.name} {formatCompact(side.last!.perMember)}–{formatCompact(side.last!.opponentPerMember)} last week</span>) : 'Neither club played last week.'}</span>
      <button type="button" className="m-btn" onClick={onTape}>Tale of the tape</button>
    </footer>
  </section>;
}
function ScoreSide({ side, go, ahead, open, right = false }: { side: MatchupSide; go: Go; ahead: boolean; open: boolean; right?: boolean }) {
  return <div className={`mc-score-side${right ? ' right' : ''}${ahead ? ' ahead' : ''}`}>
    <ClubMark mark={side.club.mark} slug={side.club.slug} size="xl" />
    <div className="mc-score-id">
      {open ? <button type="button" className="mc-open" onClick={() => go({ page: 'club', slug: side.club.slug, tab: 'board' })}><strong>{side.club.name}</strong></button> : <strong>{side.club.name}</strong>}
      <small>{standingText(side.standing)} · <b>{side.record.won}W–{side.record.lost}L</b></small>
      <span className="mc-score-num" title={`${tokensTitle(side.perMember)} per active member`}>{formatCompact(side.perMember)}</span>
      <small>per member · {formatExact(side.active)} active</small>
    </div>
  </div>;
}

/** Two clubs side by side, every category scored, and the way to start, withdraw or answer a matchup between them. */
function HeadToHead({ api, a, b, mine, go, onClose, onChanged, onBusy, hold = false }: { api: ApiClient; a: string; b: string; mine: MyClubs | null; go: Go; onClose: () => void; onChanged: () => void;
  /** Told when an action starts, and when one fails: the page behind shares the lock, so closing the dialog can't answer twice. */
  onBusy?: (busy: boolean) => void;
  /** The page behind still waits for its list after an answer: no action until it has it. */
  hold?: boolean }) {
  const [round, setRound] = useState(0);
  const data = useLoad(() => api.clubCompare(a, b), [api, a, b, round]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = data.value;
  // From an action until the refreshed comparison arrives, the buttons would offer the same action again.
  useEffect(() => { setBusy(false); }, [value]);
  const locked = busy || hold || data.loading || data.error !== null;
  const act = (action: () => Promise<unknown>) => { setBusy(true); setError(null); onBusy?.(true); action().then(() => { setRound((n) => n + 1); onChanged(); }, (reason: unknown) => { setError(errorText(reason)); setBusy(false); onBusy?.(false); }); };
  const role = (slug: string) => mine?.clubs.find((entry) => entry.club.slug === slug)?.role ?? null;
  const admin = (slug: string) => { const value = role(slug); return value === 'owner' || value === 'admin'; };
  // You challenge from your side; with both clubs yours, there's no one to challenge.
  const challenger = admin(a) && role(b) === null ? a : admin(b) && role(a) === null ? b : null;
  const request = value?.matchup ? mine?.requests.find((entry) => entry.id === value.matchup!.id) ?? null : null;
  const rows: Array<{ label: string; a: ReactNode; b: ReactNode; edge: Side | null }> = value ? [
    { label: 'Per member', a: formatCompact(value.a.perMember), b: formatCompact(value.b.perMember), edge: edge(value.a.perMember, value.b.perMember) },
    { label: 'Tokens', a: formatCompact(value.a.tokens), b: formatCompact(value.b.tokens), edge: edge(value.a.tokens, value.b.tokens) },
    { label: 'Active', a: `${formatExact(value.a.active)} of ${formatExact(value.a.members)}`, b: `${formatExact(value.b.active)} of ${formatExact(value.b.members)}`, edge: edge(value.a.active / Math.max(1, value.a.members), value.b.active / Math.max(1, value.b.members)) },
    { label: 'League', a: value.a.standing?.rank ? `#${formatExact(value.a.standing.rank)} ${divisionName(value.a.standing.division)}` : '—', b: value.b.standing?.rank ? `#${formatExact(value.b.standing.rank)} ${divisionName(value.b.standing.division)}` : '—',
      edge: value.a.standing?.division === value.b.standing?.division ? edge(value.a.standing?.rank, value.b.standing?.rank, true) : null },
    { label: 'Best day', a: value.a.bestDay ? `${formatCompact(value.a.bestDay.perMember)} · ${weekday(value.a.bestDay.day)}` : '—', b: value.b.bestDay ? `${formatCompact(value.b.bestDay.perMember)} · ${weekday(value.b.bestDay.day)}` : '—', edge: edge(value.a.bestDay?.perMember, value.b.bestDay?.perMember) },
    { label: 'Matchups won', a: formatExact(value.a.matchupsWon), b: formatExact(value.b.matchupsWon), edge: edge(value.a.matchupsWon, value.b.matchupsWon) },
    { label: 'Top tool', a: value.a.topTool ? <><ToolIcon id={value.a.topTool} />{toolLabel(value.a.topTool)}</> : '—', b: value.b.topTool ? <><ToolIcon id={value.b.topTool} />{toolLabel(value.b.topTool)}</> : '—', edge: null },
  ] : [];
  const wins = { a: rows.filter((row) => row.edge === 'a').length, b: rows.filter((row) => row.edge === 'b').length };
  return <ProfileDialog labelledBy="mc-h2h-title" onClose={onClose}>
    <div className="mc-h2h" style={value ? { '--ha': clubHue(value.a.club.slug), '--hb': clubHue(value.b.club.slug) } as CSSProperties : undefined}>
      <button type="button" className="mc-close" aria-label="Close" onClick={onClose}>×</button>
      <h2 id="mc-h2h-title" className="sr-only">Tale of the tape</h2>
      {data.error !== null && !value && <Notice tone="error">Could not compare the clubs: {errorText(data.error)}</Notice>}
      {!value && data.error === null && <Loading>Sizing them up…</Loading>}
      {value && <>
        <div className="mc-h2h-top">
          {[value.a, value.b].map((side, index) => <div key={side.club.slug} className={`mc-h2h-side${index ? ' right' : ''}`} style={hue(side.club.slug)}>
            <ClubMark mark={side.club.mark} slug={side.club.slug} size="xl" />
            <strong>{side.club.name}</strong><small>{side.record.won}W–{side.record.lost}L all time</small>
            <span className={`mc-h2h-score${(index ? wins.b > wins.a : wins.a > wins.b) ? ' ahead' : ''}`}>{index ? wins.b : wins.a}</span>
          </div>)}
          <span className="mc-vs">VS</span>
        </div>
        <p className="mc-h2h-k">Tale of the tape · this week</p>
        <table className="mc-tape"><tbody>{rows.map((row) => <tr key={row.label}>
          <td className={row.edge === 'a' ? 'win' : undefined}>{row.edge === 'a' && <i aria-label="Edge" />}{row.a}</td>
          <th scope="row">{row.label}</th>
          <td className={row.edge === 'b' ? 'win' : undefined}>{row.b}{row.edge === 'b' && <i aria-label="Edge" />}</td>
        </tr>)}</tbody></table>
        <LineRace label={`Tokens per active member so far this week: ${value.a.club.name} against ${value.b.club.name}`} days={DAYS.slice(0, Math.max(value.a.daily.length, value.b.daily.length))} zero format={(tick) => formatCompact(Math.round(tick))}
          lines={[{ key: 'a', label: value.a.club.name, hue: clubHue(value.a.club.slug), values: cumulative(value.a.daily) }, { key: 'b', label: value.b.club.name, hue: clubHue(value.b.club.slug), values: cumulative(value.b.daily) }]} />
        {error && <Notice tone="error">{error}</Notice>}
        {data.error !== null && <Notice tone="error">Could not refresh the matchup: {errorText(data.error)} <button type="button" className="m-btn st-sm" onClick={() => setRound((n) => n + 1)}>Retry</button></Notice>}
        <footer className="mc-h2h-foot">
          {value.matchup?.status === 'accepted' ? <span className="mc-verdict lead">Matchup on</span>
            : value.matchup && request ? <><span>{request.from.name} challenged {request.to.name} for the week of {shortDay(request.week)}.</span>
              <span className="mc-actions"><button type="button" className="m-btn" disabled={locked} onClick={() => act(() => api.answerMatchup(request.id, 'decline'))}>Decline</button><button type="button" className="m-btn mc-fight-btn" disabled={locked} onClick={() => act(() => api.answerMatchup(request.id, 'accept'))}>{SWORDS}Accept</button></span></>
            : value.matchup ? <><span><span className="mc-ping" /> Challenge sent. Waiting on the other club’s admins.</span>{challenger && <button type="button" className="m-btn" disabled={locked} onClick={() => act(() => api.answerMatchup(value.matchup!.id, 'withdraw'))}>Withdraw</button>}</>
            : challenger ? <><span>Next week, {challenger === a ? value.a.club.name : value.b.club.name} against {challenger === a ? value.b.club.name : value.a.club.name}. Their admins have to accept.</span>
              <button type="button" className="m-btn mc-fight-btn" disabled={locked} onClick={() => act(() => api.challengeClub(challenger, challenger === a ? b : a))}>{SWORDS}{busy ? 'Sending…' : 'Challenge for next week'}</button></>
            : <span className="faint">Admins of a league club can challenge another club for next week.</span>}
          {value.a.club.visibility === 'public' && <button type="button" className="m-btn" onClick={() => { onClose(); go({ page: 'club', slug: value.a.club.slug, tab: 'board' }); }}>Open {value.a.club.name}</button>}
        </footer>
      </>}
    </div>
  </ProfileDialog>;
}
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
const weekday = (day: string) => WEEKDAY.format(new Date(`${day}T00:00:00Z`));

/** A club in the app: its banner, then its board, challenge or members, all in the club's colour. */
export function ClubView({ api, me, slug, tab, go, site, onProfile, onJoin }: { api: ApiClient; me: string | null; slug: string; tab: ClubTab; go: Go; site: string | null; onProfile: (alias: string) => void; onJoin: () => void }) {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');
  const [number, setNumber] = useState(1);
  const [round, setRound] = useState(0);
  const week = useWeekStart();
  const page = useLoad(() => api.club(slug, { period, page: number, pageSize: 12 }), [api, slug, period, number, round, week]);
  const value = page.value;
  const member = value?.membership ?? null;
  const [error, setError] = useState<string | null>(null);
  const join = () => { setError(null); api.joinClub(slug).then(() => { setRound((n) => n + 1); clubsChanged(); }, (reason: unknown) => setError(errorText(reason))); };
  return <div className="m-page m-lb mc-club" style={hue(slug)}>
    <ToolbarActions>
      <Seg label={value?.club.name ?? 'Club'} value={tab} options={[['board', 'Board'], ['challenge', 'Challenge'], ...(member ? [['members', 'Members'] as [ClubTab, string]] : [])]} onChange={(next) => go({ page: 'club', slug, tab: next })} />
      {tab === 'board' && <div className="m-seg" role="group" aria-label="Period">{PERIODS.map((option) => <button key={option.value} type="button" className={option.value === period ? 'on' : undefined} aria-pressed={option.value === period} onClick={() => { setPeriod(option.value); setNumber(1); }}>{option.label}</button>)}</div>}
      {value && !member && value.club.visibility === 'public' && <button type="button" className="m-btn primary" onClick={join}>Join club</button>}
    </ToolbarActions>
    {page.error !== null && !value && (page.error instanceof ApiError && page.error.status === 404 ? <section className="m-card"><Empty title="This club does not exist" action={<button type="button" className="m-btn" onClick={() => go({ page: 'clubs', tab: 'mine' })}>Your clubs</button>}>It may have been deleted, or its address changed.</Empty></section> : <NotLinked error={page.error} onJoin={onJoin} />)}
    {!value && page.error === null && <Loading>Loading the club…</Loading>}
    {page.error !== null && value && <Notice tone="error">Could not refresh the club, so this may be out of date: {errorText(page.error)} <button type="button" className="m-btn st-sm" onClick={() => setRound((n) => n + 1)}>Retry</button></Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {value && <>
      <header className="mc-banner">
        <ClubMark mark={value.club.mark} slug={value.club.slug} size="xl" />
        <div className="mc-banner-id">
          <h1 className="m-page-title">{value.club.name}</h1>
          <p className="m-page-sub">{[visibilityName(value.club.visibility), plural(value.club.members, 'member'), value.club.category ? CLUB_CATEGORIES[value.club.category] : null].filter(Boolean).join(' · ')}</p>
          {value.club.description && <p className="mc-banner-desc">{value.club.description}</p>}
          <div className="mc-chips-row">
            {value.standing && <span className={`mc-chip${place(value.standing.rank)}`}>{TROPHY}{value.standing.rank ? `#${formatExact(value.standing.rank)} ${divisionName(value.standing.division)} league` : `${divisionName(value.standing.division)} league · unranked`}<Move rank={value.standing.rank} previous={value.standing.previousRank} /></span>}
            <button type="button" className={`mc-chip k-${value.challenge.kind}`} onClick={() => go({ page: 'club', slug, tab: 'challenge' })}>{CHALLENGE_ICON[value.challenge.kind]}{CHALLENGES[value.challenge.kind].name}</button>
            <span className="mc-chip"><span className="mc-ping live" />{formatExact(value.week.activeToday)} of {formatExact(value.club.members)} active today</span>
          </div>
        </div>
        <div className="mc-banner-side"><WeekClock />{site && <a className="m-btn" href={`${site}/c/${slug}${tab === 'board' ? '' : `/${tab}`}`} target="_blank" rel="noopener noreferrer">Open on the web</a>}</div>
      </header>
      {!value.board && <section className="m-card"><Empty title="A private club">Only members see who’s in it. Ask a member for an invite link or code.</Empty></section>}
      <Fragment key={week}>
      {value.board && tab === 'board' && <ClubBoard page={value} me={me} period={period} number={number} loading={page.loading} site={site} onPage={setNumber} onProfile={onProfile} />}
      {tab === 'challenge' && <ClubChallengeView api={api} me={me} club={value.club} admin={member?.role === 'owner' || member?.role === 'admin'} />}
      {tab === 'members' && member && <ClubMembersView api={api} me={me} page={value} site={site} onChange={() => setRound((n) => n + 1)} />}
      </Fragment>
    </>}
  </div>;
}

export function ClubBoard({ page, me, period, number, loading, site, onPage, onProfile }: { page: ClubPage; me: string | null; period: LeaderboardPeriod; number: number; loading: boolean; site: string | null; onPage: (page: number) => void; onProfile: (alias: string) => void }) {
  const { club, week, board } = page;
  const delta = change(week);
  const mine = board!.items.find((row) => row.alias === me) ?? null;
  const ahead = mine ? board!.items.find((row) => row.rank === mine.rank - 1) ?? null : null;
  const top = number === 1 ? board!.items.filter((row) => row.rank <= 3) : [];
  return <>
    {top.length > 0 && <Podium label={`Top ${top.length} of ${club.name}`} places={top.map((row) => ({ key: row.alias, name: row.alias, value: formatCompact(row.tokens), title: tokensTitle(row.tokens), face: <Avatar alias={row.alias} size="lg" />, you: row.alias === me,
      sub: period === 'week' && board!.period === 'week' && week.tokens ? `${Math.round((row.tokens / week.tokens) * 100)}% of the club` : 'tokens', onOpen: () => onProfile(row.alias) }))} />}
    {/* The builder above you may sit on the page before; without them the strip would claim the lead. */}
    {mine && (ahead || mine.rank === 1) && <RivalStrip period={period} mine={mine} rows={board!.items} builders={board!.builders} ranks={[]} site={site} onProfile={onProfile} />}
    <section className="m-card lb-board">
      <Board period={period} windowStart={board!.windowStart} rows={board!.items} neighbours={[]} me={me} rival={ahead?.alias ?? null} total={board!.total} page={number} pageSize={board!.pageSize} loading={loading} onPage={onPage} onProfile={onProfile} />
    </section>
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
  </>;
}

/** How far one challenge value is behind another: points of hit rate, days, or tokens. */
function gapText(kind: ChallengeKind, gap: number): string {
  const unit = challengeUnit(kind);
  return unit === 'percent' ? `${Number((gap / 100).toFixed(1))} pts` : unit === 'days' ? `${gap} ${gap === 1 ? 'day' : 'days'}` : formatCompact(gap);
}

/** This week's challenge as a game: your place and the gap, the podium, the leaders' race, the table, past winners; admins pick next week's. */
function ClubChallengeView({ api, me, club, admin }: { api: ApiClient; me: string | null; club: ClubIdentity; admin: boolean }) {
  const [round, setRound] = useState(0);
  const data = useLoad(() => api.clubChallenge(club.slug), [api, club.slug, round]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = data.value;
  if (data.error !== null && !value) return <Notice tone="error">Could not load the challenge: {errorText(data.error)}</Notice>;
  if (!value) return <Loading>Loading the challenge…</Loading>;
  const info = CHALLENGES[value.kind];
  const qualified = value.standings.filter((row) => row.qualified);
  const mine = value.standings.find((row) => row.alias === me) ?? null;
  const above = mine?.rank ? value.standings.find((row) => row.rank === mine.rank! - 1) ?? null : null;
  const trophies = value.past.filter((row) => row.winner !== null && row.winner === me).length;
  const pick = (next: ChallengeKind) => {
    setBusy(true); setError(null);
    api.updateClub(club.slug, { name: club.name, description: club.description, mark: club.mark, visibility: club.visibility, category: club.category, league: club.league, challenge: next })
      .then(() => setRound((n) => n + 1), (reason: unknown) => setError(errorText(reason))).finally(() => setBusy(false));
  };
  return <>
    <section className={`m-card mc-challenge k-${value.kind}`}>
      <div className="mc-challenge-badge">{CHALLENGE_ICON[value.kind]}</div>
      <div className="mc-challenge-id">
        <span className="m-label">This week’s challenge</span>
        <h2>{info.name}</h2>
        <p>{info.rule}{value.kind === 'cache' && ` · ${formatCompact(CACHE_CHALLENGE_MINIMUM)} tokens to qualify`}</p>
      </div>
      <div className="mc-challenge-you">
        <span className="m-label">You</span>
        <span className={`mc-big${place(mine?.rank)}`}>{mine?.rank === 1 && CROWN}{mine?.rank ? `#${formatExact(mine.rank)}` : '—'}</span>
        <span className="sub">{!mine ? 'Not on this challenge' : !mine.qualified ? 'Not qualified yet' : mine.rank === 1 ? <>In front with <b>{challengeText(value.kind, mine.value)}</b>. Hold on.</> : above ? <><b>{gapText(value.kind, (above.value ?? 0) - (mine.value ?? 0))}</b> behind {above.alias} for #{formatExact(above.rank!)}</> : challengeText(value.kind, mine.value)}</span>
        {mine && !mine.qualified && value.kind === 'cache' && <span className="mc-qualify"><Meter value={mine.tokens} of={CACHE_CHALLENGE_MINIMUM} tone="gold" />{formatCompact(mine.tokens)} of {formatCompact(CACHE_CHALLENGE_MINIMUM)}</span>}
      </div>
    </section>
    {qualified.length > 0 && <Podium label={`${info.name} leaders`} places={qualified.slice(0, 3).map((row) => ({ key: row.alias, name: row.alias, value: challengeText(value.kind, row.value), face: <Avatar alias={row.alias} size="lg" />, you: row.alias === me, sub: `${formatCompact(row.tokens)} tokens` }))} />}
    <section className="m-card">
      <div className="lb-head"><h2>Standings</h2><span className="m-badge lb-count">{formatExact(qualified.length)} qualified</span><span className="lb-reset">ends in <b>{weekLeft()}</b></span></div>
      {value.leaders.length > 0 && <LineRace label={`${info.name}: the leaders day by day`} days={DAYS.slice(0, Math.max(...value.leaders.map((row) => row.daily.length)))} zero={challengeUnit(value.kind) !== 'percent'}
        format={(tick) => challengeText(value.kind, Math.round(tick))} lines={value.leaders.map((row) => ({ key: row.alias, label: row.alias, hue: avatarHue(row.alias), values: row.daily, you: row.alias === me }))} />}
      <table className="m-table lb-table mc-standings">
        <thead><tr><th scope="col" className="l">Rank</th><th scope="col" className="l">Builder</th><th scope="col" className="sorted">{value.kind === 'cache' ? 'Hit rate' : info.name}</th><th scope="col">Tokens</th></tr></thead>
        <tbody>{value.standings.map((row) => <tr key={row.alias} className={row.alias === me ? 'you' : undefined}>
          <td className="l"><span className="lb-rk"><span className={`rank${row.rank && row.rank <= 3 ? ` medal g${row.rank}` : ''}`}>{row.rank ? formatExact(row.rank) : '–'}</span></span></td>
          <td className="l"><div className="lb-user"><Avatar alias={row.alias} /><span className="lb-name">{row.alias}{row.alias === me && <span className="m-badge accent">You</span>}</span>{!row.qualified && <span className="lb-meta mc-pending">{value.kind === 'cache' ? `${formatCompact(row.tokens)} of ${formatCompact(CACHE_CHALLENGE_MINIMUM)} to qualify` : 'not qualified yet'}</span>}</div></td>
          <td className="lb-total">{row.qualified ? challengeText(value.kind, row.value) : <span className="zero">—</span>}</td>
          <td title={tokensTitle(row.tokens)}>{formatCompact(row.tokens)}</td>
        </tr>)}</tbody>
      </table>
    </section>
    <section className="m-card mc-next">
      <div><span className="m-label">Next week · from Monday 00:00 UTC</span><h2 className={`mc-kind k-${value.next}`}>{CHALLENGE_ICON[value.next]}{CHALLENGES[value.next].name}</h2><p>{CHALLENGES[value.next].rule}.</p></div>
      {admin ? <div className="mc-next-pick"><Seg label="Next week’s challenge" value={value.next} options={CHALLENGE_KINDS.map((kind) => [kind, CHALLENGES[kind].option] as [ChallengeKind, string])} onChange={(next) => { if (!busy && next !== value.next) pick(next); }} /><small>{busy ? 'Saving…' : 'Admins can change it until Monday.'}</small></div>
        : <small className="faint">Admins choose next week’s challenge.</small>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
    {value.past.length > 0 && <section className="m-card mc-trophies">
      <div className="lb-head"><h2>Trophy wall</h2>{trophies > 0 && <span className="m-badge gold">{TROPHY}{trophies} yours</span>}</div>
      <ul>{value.past.map((row) => <li key={row.week} className={`${row.winner ? 'won' : 'none'}${row.winner && row.winner === me ? ' you' : ''}`}>
        <span className="mc-cup">{row.winner ? TROPHY : CHALLENGE_ICON[row.kind]}</span>
        <span className="mc-cup-k">{CHALLENGES[row.kind].name} · week of {shortDay(row.week)}</span>
        {row.winner ? <span className="mc-cup-who"><Avatar alias={row.winner} /><b>{row.winner}</b>{row.winner === me && <span className="m-badge accent">You</span>}</span> : <span className="mc-cup-who faint">No winner</span>}
        <span className="mc-cup-v">{row.value === null ? '—' : challengeText(row.kind, row.value)}</span>
      </li>)}</ul>
    </section>}
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
  const full = page.club.visibility === 'private' ? Math.max(0, CLUB_PRIVATE_LIMIT - page.club.members) : null;
  const mvp = data.value?.items.reduce<ClubMember | null>((best, row) => row.tokens > (best?.tokens ?? 0) ? row : best, null) ?? null;
  return <>
    {code && <section className="m-card mc-invite">
      <div className="mc-invite-main">
        <div><h2>Bring your crew</h2><p>More members, more firepower: the league ranks clubs by tokens per active member, so every active coder counts.</p></div>
        <div className="mc-code-tiles" aria-label={`Invite code ${code}`}>{[...code].map((char, index) => <span key={index} className={char === '-' ? 'dash' : undefined}>{char}</span>)}</div>
        <div className="mc-actions">{link && <button type="button" className="m-btn primary" onClick={copy}>{copied ? 'Copied' : 'Copy invite link'}</button>}
          {admin && page.club.visibility === 'private' && <button type="button" className="m-btn" disabled={resetting} onClick={() => { if (!resetting && window.confirm('Reset the invite link? The old link and code stop working.')) { setError(null); setResetting(true); api.resetClubInvite(page.club.slug).then((value) => { setFresh(value.invite); onChange(); }, fail).finally(() => setResetting(false)); } }}>Reset</button>}</div>
      </div>
      {link && <code>{link}</code>}
      {full !== null && <div className="mc-spots"><span><b>{formatExact(full)}</b> of {CLUB_PRIVATE_LIMIT} spots left</span><Meter value={page.club.members} of={CLUB_PRIVATE_LIMIT} tone="hue" /></div>}
    </section>}
    {error && <Notice tone="error">{error}</Notice>}
    <section className="m-card">
      <div className="lb-head"><h2>Members</h2><span className="m-badge lb-count">{formatExact(page.club.members)}</span></div>
      {data.error !== null && <Notice tone="error">Could not load members: {errorText(data.error)}</Notice>}
      {!data.value ? data.error === null && <Loading>Loading members…</Loading> : <table className="m-table lb-table mc-roster">
        <thead><tr><th scope="col" className="l">Member</th><th scope="col">Joined</th><th scope="col">Last 7 days</th><th scope="col">This week</th>{admin && <th scope="col" aria-label="Actions" />}</tr></thead>
        <tbody>{data.value.items.map((member) => <tr key={member.alias} className={member.alias === me ? 'you' : undefined}>
          <td className="l"><div className="lb-user"><Avatar alias={member.alias} /><span className="lb-name">{member.alias}{member.alias === me && <span className="m-badge accent">You</span>}{member.role !== 'member' && <span className="m-badge">{member.role === 'owner' ? 'Owner' : 'Admin'}</span>}{member === mvp && <span className="m-badge gold mc-mvp" title="Most tokens in the club this week">{CROWN}MVP</span>}</span>
            <span className="lb-meta">{member.toolTokens && <span className="lb-tools">{toolsOf(member.toolTokens).map((id) => <ToolIcon key={id} id={id} />)}</span>}</span></div></td>
          <td>{shortDay(member.joinedAt.slice(0, 10))}</td>
          <td><Bars values={member.daily.slice(-7)} label={`${member.alias}’s tokens per UTC day, last 7 days`} /></td>
          <td className="lb-total" title={tokensTitle(member.tokens)}>{formatCompact(member.tokens)}</td>
          {admin && <td>{member.alias !== me && member.role === 'member' && <button type="button" className="m-btn" onClick={() => { if (window.confirm(`Remove ${member.alias} from ${page.club.name}?`)) { setError(null); api.removeClubMember(page.club.slug, member.alias).then(() => setRound((n) => n + 1), fail); } }}>Remove</button>}</td>}
        </tr>)}</tbody>
      </table>}
    </section>
  </>;
}

/** The New club sheet: a preview in the club's colour, then name, mark, who can join, the first week's challenge and the league. */
function NewClub({ api, me, go, onClose }: { api: ApiClient; me: string | null; go: Go; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mark, setMark] = useState<ClubMarkId>('moon');
  const [visibility, setVisibility] = useState<ClubVisibility>('private');
  const [category, setCategory] = useState<ClubCategory | null>(null);
  const [challenge, setChallenge] = useState<ChallengeKind>('tokens');
  const [league, setLeague] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const valid = CLUB_NAME_PATTERN.test(trimmed) && /[\p{L}\p{N}]$/u.test(trimmed);
  const preview = slugOf(trimmed) || 'your-club';
  const create = async () => {
    setBusy(true); setError(null);
    try { const club = await api.createClub({ name: trimmed, description: description.trim(), mark, visibility, category: visibility === 'public' ? category : null, league: visibility === 'public' || league, challenge }); clubsChanged(); onClose(); go({ page: 'club', slug: club.slug, tab: 'members' }); }
    catch (reason) { setError(errorText(reason)); setBusy(false); }
  };
  return <ProfileDialog labelledBy="mc-new-title" onClose={onClose}>
    <form className="mc-sheet" onSubmit={(event) => { event.preventDefault(); if (valid) void create(); }}>
      <h2 id="mc-new-title">New club</h2>
      <div className="mc-preview" style={hue(preview)} aria-hidden="true">
        <ClubMark mark={mark} slug={preview} size="xl" />
        <span className="club-name"><strong>{trimmed || 'Your club'}</strong><small>{visibilityName(visibility)} · 1 member{visibility === 'public' || league ? ` · ${divisionName('small')} league` : ''}</small></span>
        <span className={`mc-chip k-${challenge}`}>{CHALLENGE_ICON[challenge]}{CHALLENGES[challenge].name}</span>
      </div>
      {!me && <Notice>Join the leaderboard from Settings first: clubs rank the totals members publish.</Notice>}
      <label className="mc-field">Name<input className="m-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus /></label>
      <label className="mc-field">Description <small>Optional. What the club is about.</small><input className="m-input" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={CLUB_DESCRIPTION_MAX} /></label>
      <div className="mc-field" role="group" aria-label="Mark">Mark<div className="mc-pick" style={hue(preview)}>{CLUB_MARK_IDS.map((id) => <button key={id} type="button" className="club-mark hued" aria-pressed={mark === id} aria-label={CLUB_MARKS[id].name} onClick={() => setMark(id)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{CLUB_MARKS[id].shapes.map((shape, index) => <MarkShape key={index} shape={shape} />)}</svg></button>)}</div></div>
      <div className="mc-field">Who can join<Seg label="Who can join" value={visibility} options={[['private', 'Private · invite'], ['public', 'Public · anyone']]} onChange={setVisibility} />
        <small>{visibility === 'private' ? `Up to ${CLUB_PRIVATE_LIMIT} members. Never listed or searchable.` : 'Listed in Discover. Anyone on the leaderboard can join, and it plays in the league.'}</small></div>
      {visibility === 'public' && <div className="mc-field">Category<Seg<string> label="Category" value={category ?? 'none'} options={[['none', 'None'], ...(Object.entries(CLUB_CATEGORIES) as Array<[string, string]>)]} onChange={(value) => setCategory(value === 'none' ? null : value as ClubCategory)} /></div>}
      <div className="mc-field">This week’s challenge<Seg label="Challenge" value={challenge} options={CHALLENGE_KINDS.map((kind) => [kind, CHALLENGES[kind].option] as [ChallengeKind, string])} onChange={setChallenge} /></div>
      {visibility === 'private' && <label className="mc-switch"><span>Enter the league<small>Other clubs see name, size and totals, and can challenge you.</small></span><input type="checkbox" className="switch" checked={league} onChange={(event) => setLeague(event.target.checked)} /></label>}
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
