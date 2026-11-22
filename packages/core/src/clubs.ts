/**
 * Clubs' shared vocabulary: what the hosted API returns and what the app and website draw. A club is a board of
 * members; the rules that rank clubs in the league, settle matchups and score challenges live with the hosted API.
 * Members share only what the public leaderboard already shows.
 */
import type { LeaderboardResponse, TokenCounts, ToolId } from './generated/index.ts';

/** A private club holds at most this many members; a public club has no limit. */
export const CLUB_PRIVATE_LIMIT = 50;
/** The Small division holds clubs of up to this many members; bigger clubs play in the Large division. */
export const LEAGUE_SMALL_MAX = 50;
/** A club needs this many members active in the week to rank in the league. */
export const LEAGUE_MIN_ACTIVE = 3;
/** 2–40 characters: letters, digits, spaces and `. & ' -`, starting with a letter or digit. */
export const CLUB_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{1,39}$/u;
export const CLUB_DESCRIPTION_MAX = 160;
/** The club's address, `/c/:slug`: lowercase words joined by single hyphens, 2–40 characters. */
export const CLUB_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;
/** An invite code, such as `NIGHT-7K2Q`: up to five letters or digits of the club's name and four random characters. */
export const INVITE_CODE_PATTERN = /^[A-Z0-9]{1,5}-[A-Z0-9]{4}$/;

export type ClubVisibility = 'private' | 'public';
export type ClubRole = 'owner' | 'admin' | 'member';
export type ClubDivision = 'small' | 'large';

export const CLUB_CATEGORIES = {efficiency: 'Efficiency', languages: 'Languages', schedules: 'Schedules', founders: 'Indie & founders', events: 'Events'} as const;
export type ClubCategory = keyof typeof CLUB_CATEGORIES;

/** One element of a 16×16 mark, drawn with a 1.5 stroke: a path, a circle `[cx, cy, r]` or a rounded rect `[x, y, width, height, rx]`. */
export type ClubMarkShape = {d: string} | {circle: [number, number, number]} | {rect: [number, number, number, number, number]};
/** A club's emblem: a monochrome line glyph, never a colour. */
export const CLUB_MARKS = {
  moon: {name: 'Moon', shapes: [{d: 'M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z'}]},
  target: {name: 'Target', shapes: [{circle: [8, 8, 5.5]}, {circle: [8, 8, 2]}]},
  gear: {name: 'Gear', shapes: [{circle: [8, 8, 2.2]}, {d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4'}]},
  plane: {name: 'Plane', shapes: [{d: 'M14 2 2 7l5 2 2 5z'}, {d: 'M7 9l7-7'}]},
  flag: {name: 'Flag', shapes: [{d: 'M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8'}]},
  tab: {name: 'Tab', shapes: [{d: 'M2 8h8.5M7.5 4.5 11 8l-3.5 3.5M13.5 3.5v9'}]},
  merge: {name: 'Merge', shapes: [{circle: [4.5, 3.5, 1.5]}, {circle: [4.5, 12.5, 1.5]}, {circle: [11.5, 8, 1.5]}, {d: 'M4.5 5v6M4.5 5c0 3 2 3 5.5 3'}]},
  box: {name: 'Box', shapes: [{d: 'M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3z'}, {d: 'M2.5 5.5 8 8.5l5.5-3M8 8.5v5'}]},
  hash: {name: 'Hash', shapes: [{d: 'M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2 10.5h11'}]},
  layers: {name: 'Layers', shapes: [{d: 'M2.5 5 8 2.5 13.5 5 8 7.5z'}, {d: 'M2.5 8 8 10.5 13.5 8M2.5 11 8 13.5 13.5 11'}]},
  bolt: {name: 'Bolt', shapes: [{d: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z'}]},
  sunrise: {name: 'Sunrise', shapes: [{d: 'M2 11.5h12M4.5 11.5a3.5 3.5 0 0 1 7 0M8 3v2.5M3.4 6.4l1.2 1.2M12.6 6.4l-1.2 1.2'}]},
  pair: {name: 'Pair', shapes: [{circle: [5.5, 8, 3]}, {circle: [10.5, 8, 3]}]},
  check: {name: 'Check', shapes: [{d: 'M3 8.5l3 3 7-7'}]},
  golf: {name: 'Golf', shapes: [{circle: [8, 11.5, 2.2]}, {d: 'M8 9.3V2l4 1.8L8 5.6'}]},
  cycle: {name: 'Cycle', shapes: [{d: 'M13 6A5 5 0 0 0 3.5 5M3 10a5 5 0 0 0 9.5 1'}, {d: 'M3.5 2v3h3M12.5 14v-3h-3'}]},
  book: {name: 'Book', shapes: [{d: 'M3 3.5h4.5v10H3zM8.5 3.5H13v10H8.5z'}]},
  star: {name: 'Star', shapes: [{d: 'M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.2l-3.7 2.1.8-4.2L2 6.2l4.2-.5z'}]},
} satisfies Record<string, {name: string; shapes: ClubMarkShape[]}>;
export type ClubMark = keyof typeof CLUB_MARKS;
export const CLUB_MARK_IDS = Object.keys(CLUB_MARKS) as ClubMark[];
/** A private club seen from outside: counted, never named. */
export const LOCK_MARK: ClubMarkShape[] = [{rect: [3.5, 7, 9, 6.5, 1.5]}, {d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'}];

/**
 * A club's weekly challenge. `value` in a standing is tokens for `tokens` and `big-day`, active days for `streak`, and
 * basis points of prompt tokens read from cache (cache reads ÷ input, cache reads and cache writes) for `cache`.
 */
export const CHALLENGES = {
  tokens: {name: 'Most tokens', option: 'Most tokens', rule: 'Most tokens this week'},
  streak: {name: 'Longest streak', option: 'Longest streak', rule: 'Most days with usage this week'},
  'big-day': {name: 'Biggest day', option: 'Biggest day', rule: 'Most tokens in one UTC day this week'},
  cache: {name: 'Cache Week', option: 'Cache hit rate', rule: 'Highest prompt-cache hit rate this week'},
} as const;
export type ChallengeKind = keyof typeof CHALLENGES;
export const CHALLENGE_KINDS = Object.keys(CHALLENGES) as ChallengeKind[];
/** Tokens a member needs in the week to qualify for the cache challenge; the other challenges qualify any activity. */
export const CACHE_CHALLENGE_MINIMUM = 50_000_000;

/** A club as lists draw it. */
export interface ClubRef {slug: string; name: string; mark: ClubMark; visibility: ClubVisibility; members: number}
/** A club's page head and settings. */
export interface ClubIdentity extends ClubRef {description: string; category: ClubCategory | null; createdAt: string; owner: string | null;
  /** Public clubs always play in the league; a private club only when its admins enter it. */
  league: boolean}

/** A club's week so far, Monday 00:00 UTC to now. Members hidden from the board still count. */
export interface ClubWeek {
  tokens: number;
  /** The same days of the week before, for "vs same days last week". */
  previousTokens: number;
  /** Members with tokens this week. */
  active: number;
  /** Tokens per active member; 0 with nobody active. */
  perMember: number;
  /** Null when any member's cost is unknown or not shared. */
  costMicrousd: number | null;
  /** The last 24 whole hours, from members whose computers send hours. */
  last24hTokens: number;
  toolTokens: Partial<Record<ToolId, number>>;
  /** Tokens per UTC day, the last 14 days ending today. */
  daily: number[];
}
/** Where a club stands in its division this week. `rank` is null until it has enough active members. */
export interface ClubStanding {division: ClubDivision; rank: number | null; previousRank: number | null; clubs: number}

/** `GET /api/clubs/mine`: the member's clubs and the matchup challenges waiting on their answer. */
export interface MyClubs {clubs: MyClub[]; requests: MatchupRequest[]; week: ClubWeekSpan}
export interface ClubWeekSpan {start: string; end: string}
export interface MyClub {
  club: ClubIdentity;
  role: ClubRole;
  /** Off the club's board; the club on their profile. */
  hidden: boolean;
  onProfile: boolean;
  /** The member's place on the club's board this week; null when they have no tokens or hide from the board. */
  you: {rank: number | null; previousRank: number | null; ranked: number};
  week: ClubWeek;
  standing: ClubStanding | null;
  challenge: ChallengeBrief;
  matchup: MatchupBrief | null;
}
export interface ChallengeBrief {kind: ChallengeKind; you: {rank: number | null; qualified: number; value: number | null; tokens: number};
  leader: {alias: string; value: number} | null}
/** This week's matchup as one of its clubs sees it. */
export interface MatchupBrief {id: string; opponent: ClubRef; perMember: number; opponentPerMember: number; daysLed: number; days: number}
/** A challenge for next week, sent by `from` to `to`, waiting on `to`'s admins. */
export interface MatchupRequest {id: string; week: string; from: ClubRef; to: ClubRef; fromStanding: ClubStanding | null; fromPerMember: number; toPerMember: number}

/** `GET /api/clubs`: public clubs to browse. Private clubs are never listed. */
export interface ClubListing extends ClubIdentity {week: {tokens: number; active: number; daily: number[]; toolTokens: Partial<Record<ToolId, number>>}; joined: boolean}
export type ClubSort = 'members' | 'active' | 'newest';
export interface ClubListResponse {items: ClubListing[]; total: number; page: number; pageSize: number}

/** `GET /api/clubs/league?division`: the week's table by tokens per active member. */
export interface LeagueResponse {division: ClubDivision; week: ClubWeekSpan; clubs: number; activeMembers: number; tokens: number;
  items: LeagueRow[]; total: number; page: number; pageSize: number;
  /** Last week's first place. */
  lastWinner: ClubRef | null;
  updatedAt: string}
export interface LeagueRow {
  rank: number;
  previousRank: number | null;
  club: ClubRef;
  /** The viewer is a member. */
  mine: boolean;
  active: number;
  tokens: number;
  perMember: number;
  /** Tokens per active member per UTC day, the last 7 days ending today. */
  daily: number[];
  /** A private club the viewer isn't in shares totals only: these are absent. */
  costMicrousd?: number | null;
  last24hTokens?: number;
  toolTokens?: Partial<Record<ToolId, number>>;
}

/** One side of a matchup, its week day by day. */
export interface MatchupSide {club: ClubRef; perMember: number; tokens: number; active: number; standing: ClubStanding | null;
  /** Tokens per active member per UTC day of the week so far, Monday first. */
  daily: number[];
  record: {won: number; lost: number};
  /** Last week's matchup, once settled. */
  last: {opponent: ClubRef; won: boolean; perMember: number; opponentPerMember: number} | null}
export interface MatchupRow {id: string; a: MatchupSide; b: MatchupSide; mine: boolean}
/** `GET /api/clubs/matchups`: this week's matchups, the viewer's first. */
export interface MatchupsResponse {week: ClubWeekSpan; items: MatchupRow[]; updatedAt: string}

/** `GET /api/clubs/vs/:a/:b`: two clubs side by side this week. */
export interface ClubCompareSide extends MatchupSide {members: number; bestDay: {day: string; perMember: number} | null; matchupsWon: number;
  topTool: ToolId | null; toolTokens: Partial<Record<ToolId, number>>}
export interface ClubCompare {week: ClubWeekSpan; a: ClubCompareSide; b: ClubCompareSide; matchup: {id: string; status: 'pending' | 'accepted'} | null}

/** The viewer's own membership in a club. */
export interface ClubMembership {role: ClubRole; hidden: boolean; onProfile: boolean}
/** `GET /api/clubs/:slug`: a club's board, summary and the viewer's place in it. */
export interface ClubPage {
  club: ClubIdentity;
  /** Null when the viewer isn't a member. */
  membership: ClubMembership | null;
  standing: ClubStanding | null;
  week: ClubWeek & {activeToday: number; median: number; busiestHour: number | null};
  /** The board, members only for a private club; null to outsiders, who see name, size and totals. */
  board: LeaderboardResponse | null;
  /** The invite code, to its members (private clubs) and to anyone (public clubs). */
  invite: string | null;
  /** True when the request carried this club's current invite code. */
  invited: boolean;
  challenge: {kind: ChallengeKind};
}

/** `GET /api/clubs/:slug/challenge`: this week's challenge, its standings and the last ones. */
export interface ClubChallenge {
  kind: ChallengeKind;
  week: ClubWeekSpan;
  /** Next week's, which admins may change until Monday. */
  next: ChallengeKind;
  standings: ChallengeStanding[];
  /** Each leader's value per UTC day of the week so far, the top four. */
  leaders: Array<{alias: string; daily: Array<number | null>}>;
  /** The club's tokens by type this week, from members whose uploads carry types. */
  types: TokenCounts;
  past: Array<{kind: ChallengeKind; week: string; winner: string | null; value: number | null}>;
}
export interface ChallengeStanding {alias: string; rank: number | null; value: number | null; tokens: number; qualified: boolean}

/** `GET /api/clubs/:slug/members`: the roster, owner and admins first, then by join date. */
export interface ClubMembers {items: ClubMember[]; limit: number | null}
export interface ClubMember {alias: string; role: ClubRole; joinedAt: string; lastSyncedAt: string | null; tokens: number; daily: number[];
  toolTokens?: Partial<Record<ToolId, number>>; hidden: boolean}

/** `GET /api/profiles/:alias/clubs`: the clubs a member shows on their profile. Private clubs are named only to their members. */
export interface ProfileClubs {items: Array<{club: ClubRef; rank: number | null; ranked: number}>; private: number}

/** `GET /api/clubs/shared?aliases=`: the viewer's clubs each listed builder is also in. */
export type SharedClubs = Record<string, ClubRef[]>;

/** `POST /api/clubs` and `PUT /api/clubs/:slug`. */
export interface ClubInput {name: string; description: string; mark: ClubMark; visibility: ClubVisibility; category: ClubCategory | null; league: boolean;
  /** Next week's challenge. */
  challenge?: ChallengeKind}

/** The week that contains `now`: Monday 00:00 UTC to the next Monday. */
export function clubWeek(now: Date): ClubWeekSpan {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return {start: start.toISOString(), end: end.toISOString()};
}

/** The code in an invite link (`…/c/night-shift?invite=NIGHT-7K2Q`) or a code typed on its own, uppercased; null for anything else. */
export function inviteCode(input: string): string | null {
  const text = input.trim();
  let code = text;
  if (/[/?=]/.test(text)) {
    try { code = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).searchParams.get('invite') ?? ''; }
    catch { return null; }
  }
  code = code.toUpperCase();
  return INVITE_CODE_PATTERN.test(code) ? code : null;
}

/** A challenge value as standings print it: a percentage for the cache challenge, days for streaks, else tokens. */
export function challengeUnit(kind: ChallengeKind): 'percent' | 'days' | 'tokens' {
  return kind === 'cache' ? 'percent' : kind === 'streak' ? 'days' : 'tokens';
}
