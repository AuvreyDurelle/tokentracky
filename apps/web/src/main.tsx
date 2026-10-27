import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, ApiError, type Account, type Health, type LocalStatus } from './api';
import { AuthAdapter, type AuthState } from './auth';
import { forgetConnectCode, takeConnectCode } from './connect-code';
import { errorText } from './format';
import { Leaderboard } from './Leaderboard';
import { HostedAccount } from './Account';
import { Connect } from './Connect';
import { LegalPage, legalPageAt } from './Legal';
import { Notice } from './ui';
import { CommandPalette } from './Command';
import { usageRevision, useRefreshReload } from './refresh';
import { isMacPage, routePath, takeLinkTag, useRoute, type Route } from './route';
import { Join } from './Join';
import { ConnectNav, SiteFooter, SiteNav } from './Site';
import { MacShell } from './mac/Shell';
import { LeaderboardView } from './mac/LeaderboardView';
import { ProfileModal } from './mac/ProfileModal';
import { AchievementsView } from './mac/AchievementsView';
import { TokensView } from './mac/TokensView';
import { SettingsView } from './mac/SettingsView';
import { Popover } from './mac/Popover';
import { JoinPrompt, askToJoin } from './mac/JoinPrompt';
import { ProfilePage } from './Profile';
import { PasswordRecovery } from './PasswordRecovery';
import '@fontsource-variable/inter/opsz.css';
import './styles.css';
import './mac/mac.css';
import './mac/community.css';

const storage = () => { try { return window.localStorage ?? null; } catch { return null; } };

function App() {
  const auth = useMemo(() => new AuthAdapter(), []);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authRevision, setAuthRevision] = useState(0);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountDeleted, setAccountDeleted] = useState(false);
  const [deletionNotice, setDeletionNotice] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [route, navigate] = useRoute();
  const [connectCode, setConnectCode] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [joinPrompt, setJoinPrompt] = useState<boolean | null>(null);
  const [signUp, setSignUp] = useState(false);
  const accountRequest = useRef(0);
  const api = useMemo(() => new ApiClient(async () => {
    try { return await auth.accessToken(); }
    catch (error) { setAuthState('error'); setAuthError(errorText(error)); throw error; }
  }, () => {
    ++accountRequest.current; setAccount(null); setAccountLoading(false);
    setAuthState('signed_out'); setAuthError('Your session ended or was rejected. Sign in again.');
  }), [auth]);
  const refreshAuth = async () => {
    setAuthState('loading'); setAuthError(null);
    try { const state = await auth.state(); setAuthState(state); if (state === 'signed_out') setAccountDeleted(false); }
    catch (error) { setAuthState('error'); setAuthError(errorText(error)); throw error; }
  };
  const refreshAccount = async () => {
    if (health?.mode !== 'hosted' || authState !== 'signed_in' || accountDeleted) return;
    const request = ++accountRequest.current;
    setAccountLoading(true); setAccountError(null);
    try { const next = await api.account(); if (request === accountRequest.current) setAccount(next); }
    catch (error) {
      if (request === accountRequest.current) {
        setAccount(null); setAccountError(errorText(error));
        if (error instanceof ApiError && error.status === 401) { setAuthState('signed_out'); setAuthError('Your session ended or was rejected. Sign in again.'); }
      }
      throw error;
    } finally { if (request === accountRequest.current) setAccountLoading(false); }
  };
  const deleteAccount = async () => {
    await api.deleteAccount();
    ++accountRequest.current; setAccount(null); setAccountLoading(false); setAccountError(null);
    setAccountDeleted(true); setAuthError(null);
    setDeletionNotice('Your Tokentracky application data was deleted. Existing device tokens no longer work. Local history remains. Your authentication provider identity may remain until separately deleted; backups follow operator retention and copies others saved may remain.');
    try { await auth.signOut(); }
    catch (error) { throw new Error(`Tokentracky data was deleted, but sign-out failed: ${errorText(error)} Use Sign out to retry.`, { cause: error }); }
    setAuthState('signed_out'); setAccountDeleted(false);
  };
  const refreshLocal = async () => { if (health?.mode === 'local') setLocalStatus(await api.localStatus()); };
  useEffect(() => {
    let live = true; let unsubscribe = () => {};
    void api.health().then(async (next) => {
      if (!live) return;
      setHealth(next); auth.configure(next);
      if (next.mode === 'local') {
        setAuthState('unavailable');
        try { const status = await api.localStatus(); if (live) setLocalStatus(status); }
        catch (error) { if (live) setHealthError(`Tracking status could not load: ${errorText(error)}`); }
        return;
      }
      const code = takeConnectCode(window.location, window.history, storage());
      if (code) setConnectCode(code);
      const tag = takeLinkTag(window.location, window.history);
      if (tag) void api.visit(tag).catch(() => {});
      // The first event repeats the session `auth.state()` reads; only another user needs a fresh account read.
      let user: string | null | undefined;
      unsubscribe = auth.subscribe((state, next) => {
        if (!live) return;
        if (user !== undefined && next !== user) {
          ++accountRequest.current; setAccount(null); setAccountError(null); setAccountLoading(state === 'signed_in');
          setAuthRevision((value) => value + 1);
        }
        user = next;
        setAuthState(state); setAuthError(null);
        if (state === 'signed_out') setAccountDeleted(false);
      });
      try { const state = await auth.state(); if (live) setAuthState(state); }
      catch (error) { if (live) { setAuthState('error'); setAuthError(errorText(error)); } }
    }).catch((error: unknown) => { if (live) setHealthError(errorText(error)); });
    return () => { live = false; unsubscribe(); ++accountRequest.current; };
  }, [api, auth]);
  useEffect(() => {
    if (health?.mode === 'hosted' && authState === 'signed_in' && !accountDeleted) void refreshAccount().catch(() => {});
    else { ++accountRequest.current; setAccount(null); setAccountLoading(false); }
    return () => { ++accountRequest.current; };
  }, [health, authState, authRevision, accountDeleted]);
  useEffect(() => {
    const open = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette((value) => !value); } };
    window.addEventListener('keydown', open);
    return () => window.removeEventListener('keydown', open);
  }, []);
  // Keep tracking and sync state current while the local app is open.
  const reloadLocal = useMemo(() => () => { void api.localStatus().then(setLocalStatus).catch(() => {}); }, [api]);
  useEffect(() => {
    if (health?.mode !== 'local') return;
    const timer = window.setInterval(reloadLocal, 30_000);
    return () => window.clearInterval(timer);
  }, [reloadLocal, health]);
  // Fetch again as soon as the five-minute cycle has run; new status re-renders every page with fresh totals.
  useRefreshReload(health?.mode === 'local' ? localStatus : null, reloadLocal);
  // Each time the dashboard opens, a Mac that isn't linked is asked to join; Not now, or joining, closes it for this window.
  useEffect(() => { if (health?.mode === 'local') setJoinPrompt((asked) => askToJoin(asked, health, localStatus)); }, [health, localStatus]);

  if (healthError && !health) return <main className="startup"><span className="brand-mark" /><h1>Tokentracky is unavailable</h1><Notice tone="error">Could not reach the server: {healthError}</Notice><p>Start the app or server, then reload this page.</p></main>;
  if (!health) return <main className="startup"><span className="brand-mark" /><p>Connecting…</p></main>;

  const local = health.mode === 'local';
  const me = local ? localStatus?.alias ?? null : account?.publication?.alias ?? null;
  // Signed in, only a loaded account without a name can join: one still loading or that failed to load says nothing.
  const canJoin = local ? !localStatus?.cloudLinked && !!health.cloudUrl : authState === 'signed_in' ? !!account && !me : authState !== 'unavailable';
  const finishConnect = () => { forgetConnectCode(storage()); setConnectCode(null); navigate({ page: 'leaderboard' }); };
  const connectedProfile = (alias: string) => { forgetConnectCode(storage()); setConnectCode(null); navigate({ page: 'profile', alias }); };
  // Joining opens /you on Create account; every other way there opens on Sign in.
  const go = (page: 'leaderboard' | 'join' | 'you', joining = false) => () => { if (connectCode) setConnectCode(null); setSignUp(joining); navigate({ page }); };
  // `/` is the leaderboard everywhere; the Mac app's pages exist only locally.
  const page: Route['page'] | 'connect' = connectCode ? 'connect' : route.page === 'home' ? 'leaderboard' : !local && isMacPage(route.page) ? 'missing' : route.page;
  // On the website, joining starts with signing in; the app joins from its Settings page.
  const join = canJoin ? { label: 'Join the board', onClick: go('you', true) } : null;
  const home = () => { setConnectCode(null); navigate({ page: 'home' }); };
  // The Mac app's own pages bring their layout (.m-page); the website's keep the site's column.
  const ported = local && (['leaderboard', 'profile', 'achievements', 'tokens', 'you', 'settings', 'popover'] as const).some((mac) => mac === page);
  const body = <main className={ported ? undefined : 'page'}>
      {healthError && <Notice tone="error">{healthError}</Notice>}
      {authError && <Notice tone="error">Sign-in: {authError}</Notice>}
      {deletionNotice && <Notice tone="success">{deletionNotice}</Notice>}
      {authState === 'recovery' && <PasswordRecovery auth={auth} onComplete={async () => { await refreshAuth(); if (!connectCode) navigate({ page: 'you' }); }} />}
      {authState !== 'recovery' && <>
      {page === 'join' && <Join onLeaderboard={go('leaderboard')} />}
      {local && (page === 'leaderboard' || page === 'profile') && <LeaderboardView api={api} me={me} canJoin={canJoin} syncedAt={localStatus?.lastSyncAt ?? null} onProfile={(alias) => navigate({ page: 'profile', alias })} onJoin={() => navigate({ page: 'settings' })} />}
      {local && route.page === 'profile' && <ProfileModal key={route.alias} api={api} alias={route.alias} me={me} onClose={() => navigate({ page: 'leaderboard' })} />}
      {local && page === 'achievements' && <AchievementsView api={api} me={me} revision={`${usageRevision(localStatus)}|${localStatus?.lastSyncAt ?? ''}`} />}
      {!local && page === 'leaderboard' && <Leaderboard api={api} me={me} join={join} onProfile={(alias) => navigate({ page: 'profile', alias })} onGuide={go('join')} />}
      {!local && page === 'profile' && route.page === 'profile' && <ProfilePage key={route.alias} api={api} alias={route.alias} me={me} signedIn={authState === 'signed_in'} origin={window.location.origin} join={join} onLeaderboard={go('leaderboard')} />}
      {page === 'missing' && <div className="empty page-missing"><strong>This page does not exist</strong><button type="button" className="btn" onClick={go('leaderboard')}>Go to the leaderboard</button></div>}
      {(page === 'you' || page === 'tokens') && (local
        ? <TokensView api={api} status={localStatus} />
        : <HostedAccount key={authState} api={api} auth={auth} authState={authState} account={account} accountLoading={accountLoading} accountError={accountError} refreshAccount={refreshAccount} refreshAuth={refreshAuth} deleteAccount={deleteAccount} onViewBoard={go('leaderboard')} onProfile={(alias) => navigate({ page: 'profile', alias })} signUp={signUp} />)}
      {page === 'settings' && <SettingsView api={api} health={health} status={localStatus} refresh={refreshLocal} />}
      {page === 'popover' && <Popover api={api} status={localStatus} />}
      {page === 'connect' && connectCode && <Connect api={api} auth={auth} authState={authState} account={account} accountLoading={accountLoading} accountError={accountError} refreshAccount={refreshAccount} code={connectCode} origin={window.location.origin} onFinish={finishConnect} onProfile={connectedProfile} />}
      </>}
    </main>;
  const commands = palette && <CommandPalette api={api} local={local} onClose={() => setPalette(false)}
      onProject={() => navigate({ page: 'tokens' })}
      pages={[
        { id: 'leaderboard', label: 'Leaderboard', hint: 'Page', run: go('leaderboard') },
        ...(local ? [] : [{ id: 'join', label: 'Join the leaderboard', hint: 'Page', run: go('join') }]),
        { id: 'you', label: local ? 'Tokens' : 'Your profile', hint: 'Page', run: go('you') },
        ...(local ? [{ id: 'achievements', label: 'Achievements', hint: 'Page', run: () => navigate({ page: 'achievements' }) }, { id: 'settings', label: 'Settings', hint: 'Page', run: () => navigate({ page: 'settings' }) }] : []),
        ...(me ? [{ id: 'profile', label: 'Your public profile', hint: 'Page', run: () => navigate({ page: 'profile', alias: me }) }] : []),
        { id: 'privacy', label: 'Privacy policy', hint: 'Page', run: () => { window.location.href = '/privacy'; } },
        { id: 'terms', label: 'Terms of service', hint: 'Page', run: () => { window.location.href = '/terms'; } },
        { id: 'support', label: 'Support', hint: 'Page', run: () => { window.location.href = '/support'; } },
      ]} />;
  // Locally the pages sit in the Mac app's frame instead of the site's header and footer; the popover has neither.
  if (local) return <>{page === 'popover' ? body : <MacShell api={api} status={localStatus} me={me} page={page} path={routePath(route)} go={navigate} onPalette={() => setPalette(true)}>{body}
    {joinPrompt && <JoinPrompt api={api} refresh={async () => { await refreshLocal(); setJoinPrompt(false); }} onClose={() => setJoinPrompt(false)} />}</MacShell>}{commands}</>;
  return <div className="app">
    {page === 'connect' ? <ConnectNav onHome={home} onBack={finishConnect} />
      : <SiteNav api={api} page={page === 'leaderboard' || page === 'join' || page === 'you' ? page : 'other'} me={me} signedIn={authState === 'signed_in'} canJoin={canJoin}
        onHome={home} onLeaderboard={go('leaderboard')} onJoin={go('join')} onYou={go('you')} onSignUp={go('you', true)} onPalette={() => setPalette(true)} />}
    {body}{commands}<SiteFooter version={health.version} onJoin={go('join')} />
  </div>;
}

const legalPage = legalPageAt(window.location.pathname);
createRoot(document.getElementById('root')!).render(legalPage ? <LegalPage page={legalPage} /> : <App />);
