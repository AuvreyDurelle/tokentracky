import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clubWeek } from '@tokentracky/core';
import { ApiClient, type Health, type LocalStatus } from './api';
import { errorText } from './format';
import { LegalPage, legalPageAt } from './Legal';
import { Notice } from './ui';
import { CommandPalette } from './Command';
import { usageRevision, useRefreshReload } from './refresh';
import { routePath, useRoute, type Route } from './route';
import { MacShell } from './mac/Shell';
import { LeaderboardView } from './mac/LeaderboardView';
import { ProfileModal } from './mac/ProfileModal';
import { AchievementsView } from './mac/AchievementsView';
import { TokensView } from './mac/TokensView';
import { SettingsView } from './mac/SettingsView';
import { Popover } from './mac/Popover';
import { TownView } from './mac/TownView';
import { ClubView, ClubsView } from './mac/ClubsView';
import { JoinPrompt, askToJoin } from './mac/JoinPrompt';
import '@fontsource-variable/inter/opsz.css';
import './styles.css';
import './mac/mac.css';
import './mac/community.css';
import './mac/clubs.css';

function App() {
  const api = useMemo(() => new ApiClient(), []);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalStatus | null>(null);
  const [route, navigate] = useRoute();
  const [palette, setPalette] = useState(false);
  const [joinPrompt, setJoinPrompt] = useState<boolean | null>(null);
  const refreshLocal = async () => { setLocalStatus(await api.localStatus()); };
  useEffect(() => {
    let live = true;
    void api.health().then(async (next) => {
      if (!live) return;
      setHealth(next);
      try { const status = await api.localStatus(); if (live) setLocalStatus(status); }
      catch (error) { if (live) setHealthError(`Tracking status could not load: ${errorText(error)}`); }
    }).catch((error: unknown) => { if (live) setHealthError(errorText(error)); });
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    const open = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette((value) => !value); } };
    window.addEventListener('keydown', open);
    return () => window.removeEventListener('keydown', open);
  }, []);
  // Keep tracking and sync state current while the app is open.
  const reloadLocal = useMemo(() => () => { void api.localStatus().then(setLocalStatus).catch(() => {}); }, [api]);
  useEffect(() => {
    if (!health) return;
    const timer = window.setInterval(reloadLocal, 30_000);
    return () => window.clearInterval(timer);
  }, [reloadLocal, health]);
  // Fetch again as soon as the five-minute cycle has run; new status re-renders every page with fresh totals.
  useRefreshReload(health ? localStatus : null, reloadLocal);
  // Each time the dashboard opens, a Mac that isn't linked is asked to join; Not now, or joining, closes it for this window.
  useEffect(() => { if (health) setJoinPrompt((asked) => askToJoin(asked, health, localStatus)); }, [health, localStatus]);

  if (healthError && !health) return <main className="startup"><span className="brand-mark" /><h1>Tokentracky is unavailable</h1><Notice tone="error">Could not reach the server: {healthError}</Notice><p>Start the app or server, then reload this page.</p></main>;
  if (!health) return <main className="startup"><span className="brand-mark" /><p>Connecting…</p></main>;

  const me = localStatus?.alias ?? null;
  const canJoin = !localStatus?.cloudLinked && !!health.cloudUrl;
  const leaderboard = () => navigate({ page: 'leaderboard' });
  // `/` is the leaderboard; the website's own pages exist only on the website.
  const page: Route['page'] = route.page === 'home' ? 'leaderboard' : route.page === 'join' || route.page === 'wrapped' || route.page === 'vs' ? 'missing' : route.page;
  // The Mac app's own pages bring their layout (.m-page); the rest keep the site's column.
  const ported = (['leaderboard', 'profile', 'achievements', 'tokens', 'you', 'settings', 'popover', 'town', 'town-map', 'town-visit', 'clubs', 'club'] as const).some((mac) => mac === page);
  // A new club week (Monday 00:00 UTC) mounts the clubs pages afresh, so their standings follow the clock.
  const body = <main className={ported ? undefined : 'page'}>
      {healthError && <Notice tone="error">{healthError}</Notice>}
      {(page === 'leaderboard' || page === 'profile') && <LeaderboardView api={api} me={me} canJoin={canJoin} syncedAt={localStatus?.lastSyncAt ?? null} site={health.cloudUrl} onProfile={(alias) => navigate({ page: 'profile', alias })} onJoin={() => navigate({ page: 'settings' })} />}
      {route.page === 'profile' && <ProfileModal key={route.alias} api={api} alias={route.alias} me={me} onClose={leaderboard} />}
      {page === 'achievements' && <AchievementsView api={api} me={me} revision={`${usageRevision(localStatus)}|${localStatus?.lastSyncAt ?? ''}`} />}
      {page === 'missing' && <div className="empty page-missing"><strong>This page does not exist</strong><button type="button" className="btn" onClick={leaderboard}>Go to the leaderboard</button></div>}
      {(page === 'you' || page === 'tokens') && <TokensView api={api} status={localStatus} />}
      {page === 'settings' && <SettingsView api={api} health={health} status={localStatus} refresh={refreshLocal} />}
      {page === 'popover' && <Popover api={api} status={localStatus} site={health.cloudUrl} />}
      {(page === 'town' || page === 'town-map' || page === 'town-visit') && <TownView api={api} route={route} me={me} go={navigate} />}
      {route.page === 'clubs' && <ClubsView key={`${route.tab}|${clubWeek(new Date()).start}`} api={api} me={me} tab={route.tab} go={navigate} onJoin={() => navigate({ page: 'settings' })} />}
      {route.page === 'club' && <ClubView key={`${route.slug}|${clubWeek(new Date()).start}`} api={api} me={me} slug={route.slug} tab={route.tab} go={navigate} site={health.cloudUrl} onProfile={(alias) => navigate({ page: 'profile', alias })} onJoin={() => navigate({ page: 'settings' })} />}
    </main>;
  const commands = palette && <CommandPalette api={api} local onClose={() => setPalette(false)}
      onProject={() => navigate({ page: 'tokens' })}
      pages={[
        { id: 'leaderboard', label: 'Leaderboard', hint: 'Page', run: leaderboard },
        { id: 'you', label: 'Tokens', hint: 'Page', run: () => navigate({ page: 'you' }) },
        { id: 'achievements', label: 'Achievements', hint: 'Page', run: () => navigate({ page: 'achievements' }) },
        { id: 'clubs', label: 'Clubs', hint: 'Page', run: () => navigate({ page: 'clubs', tab: 'mine' }) },
        { id: 'league', label: 'Club league', hint: 'Page', run: () => navigate({ page: 'clubs', tab: 'league' }) },
        { id: 'town', label: 'Town', hint: 'Page', run: () => navigate({ page: 'town' }) },
        { id: 'town-map', label: 'Town map', hint: 'Page', run: () => navigate({ page: 'town-map' }) },
        { id: 'settings', label: 'Settings', hint: 'Page', run: () => navigate({ page: 'settings' }) },
        ...(me ? [{ id: 'profile', label: 'Your public profile', hint: 'Page', run: () => navigate({ page: 'profile', alias: me }) }] : []),
        { id: 'privacy', label: 'Privacy policy', hint: 'Page', run: () => { window.location.href = '/privacy'; } },
        { id: 'terms', label: 'Terms of service', hint: 'Page', run: () => { window.location.href = '/terms'; } },
        { id: 'support', label: 'Support', hint: 'Page', run: () => { window.location.href = '/support'; } },
      ]} />;
  // The pages sit in the Mac app's frame; the popover has none.
  return <>{page === 'popover' ? body : <MacShell api={api} status={localStatus} me={me} page={page} path={routePath(route)} go={navigate} onPalette={() => setPalette(true)}>{body}
    {joinPrompt && <JoinPrompt api={api} refresh={async () => { await refreshLocal(); setJoinPrompt(false); }} onClose={() => setJoinPrompt(false)} />}</MacShell>}{commands}</>;
}

const legalPage = legalPageAt(window.location.pathname);
createRoot(document.getElementById('root')!).render(legalPage ? <LegalPage page={legalPage} /> : <App />);
