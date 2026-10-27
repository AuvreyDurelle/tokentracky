import type {
  AchievementRarity,
  CommunityStats,
  HourBreakdownRow,
  LeaderboardNeighbours,
  LeaderboardResponse,
  MenuOverview,
  Period,
  ProfileStats,
  ProjectSummary,
  PublicProfile,
  Publication,
  SessionSummary,
  SourceStatus,
  ToolId,
  UsageBreakdownRow,
  UsageSummary,
} from '@tokentracky/core';
import type { PublicationRequest } from './publication';
import type { LinkTag } from './route';

export interface Health {
  mode: 'local' | 'hosted';
  authConfigured: boolean;
  version: string;
  cloudUrl: string | null;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  /** Sign-in methods the hosted auth project has enabled. Older servers omit it: email only. */
  authProviders?: Array<'email' | 'github' | 'google'>;
}

export interface Account {
  publication: Publication | null;
  devices: Array<{ id: string; name: string; lastSeenAt: string | null }>;
  /** Absent unless the profile is hidden for review or the account is banned. */
  moderation?: { state: 'banned' } | { state: 'hidden'; days: string[] };
  /** An automatic data integrity hold; corrected totals restore publication without a moderation decision. */
  integrity?: {state: 'unavailable'; reason: 'COUNTER_OVERFLOW'};
}

export interface LocalStatus {
  sources: SourceStatus[];
  collecting: boolean;
  lastScanAt: string | null;
  cloudLinked: boolean;
  syncError?: string | null;
  lastSyncAt?: string | null;
  /** Published alias, known once the hosted policy has been read. */
  alias?: string | null;
  /** The five-minute refresh cycle. */
  lastRefreshAt?: string | null;
  nextRefreshAt?: string | null;
  refreshing?: boolean;
  /** The price table applied to costs; it can change after a cycle's scan. */
  pricingVersion?: string;
  /** Only in the launch that turned on the tools it found (the Rust app's first run): every token counted so far. */
  firstRun?: { tokens: number };
}
export interface DetectedTool { id: ToolId; name: string; paths: string[] }
/** A rolling window of days, inclusive UTC days (today is `from` = `to` = today), or instants `[since, until)` on whole quarter hours. */
export type UsageRange = { days: 7 | 30 | 90 | 365 } | { from: string; to: string } | { since: number; until: number };
export type LeaderboardSort = 'tokens' | 'cost';

export interface DeviceAuthorization {
  userCode: string;
  deviceName: string;
  expiresAt: string;
  approved: boolean;
  replaces: string | null;
}
export interface ConnectStart { userCode: string; verificationUrl: string; expiresAt: string }
export type ConnectStatus = { status: 'pending' } | { status: 'expired' } | { status: 'connected'; alias: string };

/** `GET /api/shell/state` of the Mac app (`apps/mac/src/shell.rs`); `update.version` is the update's while one is available, downloading or ready. */
export interface ShellState {
  launchAtLogin: boolean;
  update: { state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready'; version: string | null };
  version: string;
}

export interface ApiErrorShape {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type AccessToken = () => Promise<string | null>;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value));
  });
  return search.toString();
}

async function readError(response: Response): Promise<ApiError> {
  let body: ApiErrorShape | undefined;
  try {
    body = (await response.json()) as ApiErrorShape;
  } catch {
    // The contract specifies JSON errors, but retain a safe error for broken proxies.
  }
  return new ApiError(response.status, body?.error?.code ?? 'request_failed', body?.error?.message ?? `Request failed (${response.status}).`);
}

/** HTTP boundary. Bearer credentials are allowlisted to hosted account routes only. */
export class ApiClient {
  constructor(private readonly accessToken: AccessToken = async () => null, private readonly onUnauthorized: (error: ApiError) => void = () => {}) {}

  private async request<T>(path: string, init: RequestInit = {}, accountAuth = false): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    if (accountAuth) {
      const token = await this.accessToken();
      if (!token) {
        const error = new ApiError(401, 'SIGN_IN_REQUIRED', 'Your session ended. Sign in again to manage publication.');
        this.onUnauthorized(error);
        throw error;
      }
      headers.set('authorization', `Bearer ${token}`);
    }
    const response = await fetch(path, { ...init, headers, credentials: 'include' });
    if (!response.ok) {
      const error = await readError(response);
      if (accountAuth && response.status === 401) this.onUnauthorized(error);
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  health() { return this.request<Health>('/api/health'); }
  leaderboard(period: Period, tool: 'all' | ToolId, q: string, page: number, pageSize = 20, sort: LeaderboardSort = 'tokens') {
    return this.request<LeaderboardResponse>(`/api/leaderboard?${query({ period, tool, q, page, pageSize, sort: sort === 'tokens' ? undefined : sort })}`);
  }
  profile(alias: string, period: Period) { return this.request<PublicProfile>(`/api/profiles/${encodeURIComponent(alias)}?${query({ period })}`); }
  profileStats(alias: string) { return this.request<ProfileStats>(`/api/profiles/${encodeURIComponent(alias)}/stats`); }
  community() { return this.request<CommunityStats>('/api/community'); }
  leaderboardAround(alias: string, period: Period) { return this.request<LeaderboardNeighbours>(`/api/leaderboard/around/${encodeURIComponent(alias)}?${query({ period })}`); }
  achievementRarity() { return this.request<AchievementRarity>('/api/achievements/rarity'); }
  /** Counts one arrival from a tagged link; nothing about the visitor is sent. */
  visit(tag: LinkTag) { return this.request<void>('/api/visits', { method: 'POST', body: JSON.stringify({ tag }) }); }

  account() { return this.request<Account>('/api/account', {}, true); }
  deleteAccount() { return this.request<void>('/api/account', { method: 'DELETE' }, true); }
  publication(value: PublicationRequest) {
    return this.request<{ publication: Publication }>('/api/publication', { method: 'PUT', body: JSON.stringify(value) }, true);
  }
  renameDevice(id: string, name: string) { return this.request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name }) }, true); }
  revokeDevice(id: string) { return this.request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, true); }
  deviceAuthorization(code: string) { return this.request<DeviceAuthorization>(`/api/device-auth/${encodeURIComponent(code)}`, {}, true); }
  approveDevice(code: string) { return this.request<void>(`/api/device-auth/${encodeURIComponent(code)}/approve`, { method: 'POST' }, true); }

  localStatus() { return this.request<LocalStatus>('/api/local/status'); }
  localSummary(range: UsageRange, tool: 'all' | ToolId = 'all') { return this.request<UsageSummary>(`/api/local/summary?${query({ ...range, tool })}`); }
  localProjects(range: UsageRange, tool: 'all' | ToolId = 'all') { return this.request<{ items: ProjectSummary[] }>(`/api/local/projects?${query({ ...range, tool })}`); }
  localSessions(range: UsageRange, tool: 'all' | ToolId = 'all', q = '') { return this.request<{ items: SessionSummary[] }>(`/api/local/sessions?${query({ ...range, tool, q })}`); }
  localBreakdown(range: UsageRange, tool: 'all' | ToolId = 'all') { return this.request<{ items: UsageBreakdownRow[] }>(`/api/local/breakdown?${query({ ...range, tool })}`); }
  /** Whole hours, at most a day, by hour, tool and model. */
  localHours(window: { since: number; until: number }, tool: 'all' | ToolId = 'all') { return this.request<{ items: HourBreakdownRow[] }>(`/api/local/hours?${query({ ...window, tool })}`); }
  localDetect() { return this.request<{ tools: DetectedTool[] }>('/api/local/detect'); }
  updateSource(id: ToolId, value: { enabled: boolean; paths: string[] }) { return this.request<LocalStatus>(`/api/local/sources/${id}`, { method: 'PUT', body: JSON.stringify(value) }); }
  /** One full refresh cycle: scan, totals, sync when linked. */
  refresh() { return this.request<LocalStatus>('/api/local/refresh', { method: 'POST' }); }
  connectStart() { return this.request<ConnectStart>('/api/local/connect', { method: 'POST' }); }
  connectPoll() { return this.request<ConnectStatus>('/api/local/connect/poll', { method: 'POST' }); }
  unlinkCloud() { return this.request<void>('/api/local/cloud', { method: 'DELETE' }); }
  /** The menu bar's totals and rank from the last refresh cycle. */
  localOverview() { return this.request<MenuOverview>('/api/local/overview'); }
  /** Likes go through the linked device's credential, never an account token. */
  likeStatus(alias: string) { return this.request<{ liked: boolean }>(`/api/local/likes/${encodeURIComponent(alias)}`); }
  like(alias: string) { return this.request<void>(`/api/local/likes/${encodeURIComponent(alias)}`, { method: 'PUT' }); }
  unlike(alias: string) { return this.request<void>(`/api/local/likes/${encodeURIComponent(alias)}`, { method: 'DELETE' }); }
  async exportCsv(range: UsageRange, tool: 'all' | ToolId = 'all'): Promise<Blob> {
    const response = await fetch(`/api/local/export?${query({ ...range, tool })}`, { credentials: 'include' });
    if (!response.ok) throw await readError(response);
    return response.blob();
  }

  /** The Mac app's own state; null where there is no app shell (the CLI's server answers 404). */
  async shellState(): Promise<ShellState | null> {
    try {
      return await this.request<ShellState>('/api/shell/state');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  setLaunchAtLogin(enabled: boolean) { return this.request<ShellState>('/api/shell/launch-at-login', { method: 'PUT', body: JSON.stringify({ enabled }) }); }
  openDashboard(page: '/' | '/tokens' | '/achievements' | '/settings' | '/leaderboard') { return this.request<void>('/api/shell/open-dashboard', { method: 'POST', body: JSON.stringify({ page }) }); }
  checkForUpdates() { return this.request<ShellState>('/api/shell/check-updates', { method: 'POST' }); }
  gearMenu() { return this.request<void>('/api/shell/menu', { method: 'POST' }); }
  quitApp() { return this.request<void>('/api/shell/quit', { method: 'POST' }); }
  /** Pauses or resumes reading new records; answers once the change has applied. */
  setCollectionPaused(paused: boolean) { return this.request<{ paused: boolean }>('/api/local/collection', { method: 'PUT', body: JSON.stringify({ paused }) }); }
}
