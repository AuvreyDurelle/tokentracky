import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('web HTTP boundary', () => {
  it('starts and polls browser approval with only the local session cookie', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ status: 'pending' })));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient();
    await api.connectStart(); await api.connectPoll();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([['/api/local/connect', 'POST'], ['/api/local/connect/poll', 'POST']]);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(init.body).toBeUndefined();
    }
  });
  it('uses safe errors when a proxy returns an unexpected body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 502 })));
    await expect(new ApiClient().health()).rejects.toEqual(new ApiError(502, 'request_failed', 'Request failed (502).'));
  });
  it('reads the Mac pages and gives likes with only the local session, never an account token', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => init.method ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ liked: true })));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient();
    await api.localOverview(); await api.leaderboardAround('x y', 'month'); await api.achievementRarity();
    await expect(api.likeStatus('builder_1')).resolves.toEqual({ liked: true });
    await expect(api.like('builder_1')).resolves.toBeUndefined();
    await expect(api.unlike('a/b')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['/api/local/overview', undefined], ['/api/leaderboard/around/x%20y?period=month', undefined], ['/api/achievements/rarity', undefined],
      ['/api/local/likes/builder_1', undefined], ['/api/local/likes/builder_1', 'PUT'], ['/api/local/likes/a%2Fb', 'DELETE'],
    ]);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe('include');
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(init.body).toBeUndefined();
    }
  });
  it('asks the Mac shell for its state and actions', async () => {
    const state = { launchAtLogin: true, update: { state: 'available', version: '0.2.0' }, version: '0.1.0' };
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ['/api/shell/state', '/api/shell/launch-at-login', '/api/shell/check-updates'].includes(url) ? new Response(JSON.stringify(state)) : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient();
    await expect(api.shellState()).resolves.toEqual(state);
    await expect(api.setLaunchAtLogin(false)).resolves.toEqual(state);
    await expect(api.openDashboard('/settings')).resolves.toBeUndefined();
    await expect(api.checkForUpdates()).resolves.toEqual(state);
    await api.gearMenu(); await api.quitApp();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, (init as RequestInit).body])).toEqual([
      ['/api/shell/state', undefined, undefined], ['/api/shell/launch-at-login', 'PUT', '{"enabled":false}'], ['/api/shell/open-dashboard', 'POST', '{"page":"/settings"}'],
      ['/api/shell/check-updates', 'POST', undefined], ['/api/shell/menu', 'POST', undefined], ['/api/shell/quit', 'POST', undefined],
    ]);
    const [, put] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(put.headers).get('content-type')).toBe('application/json');
  });
  it('reads no shell state where there is no app shell, and still reports other failures', async () => {
    const notFound = { error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(notFound), { status: 404 })));
    await expect(new ApiClient().shellState()).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Failed' } }), { status: 500 })));
    await expect(new ApiClient().shellState()).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});

describe('local collection', () => {
  it('pauses and resumes collection with exactly {paused}', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => new Response(init.body as string));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient();
    await expect(api.setCollectionPaused(true)).resolves.toEqual({ paused: true });
    await expect(api.setCollectionPaused(false)).resolves.toEqual({ paused: false });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method, (init as RequestInit).body])).toEqual([
      ['/api/local/collection', 'PUT', '{"paused":true}'], ['/api/local/collection', 'PUT', '{"paused":false}'],
    ]);
  });
});
