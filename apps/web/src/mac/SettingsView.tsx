import { useEffect, useState, type ReactNode } from 'react';
import type { LocalSettings, MenuBarPeriod, MenuBarShows, MenuOverview, ProfileStats, SourceStatus, ToolId } from '@tokentracky/core';
import type { ApiClient, DetectedTool, Health, LocalStatus, ShellState } from '../api';
import { TOOLS, errorText, formatCompact, formatCost, formatExact, timeAgo, timeUntil } from '../format';
import { utcToday } from '../ranges';
import { usageRevision } from '../refresh';
import { Avatar, Loading, Notice, Spinner, ToolIcon } from '../ui';
import { FolderModal, downloadCsv, setupHeading, useConnectFlow } from '../You';
import { useLoad } from './load';
import { GITHUB } from './ProfileModal';
import { ICONS } from './icons';
import './personal.css';

type Tone = 'ok' | 'off' | 'warn';
const ATTENTION: Partial<Record<SourceStatus['state'], string>> = { permission_required: 'Needs folder access', error: 'Needs attention', stale: 'Needs a scan' };

/** One source's status line: whether its records were found, with its sessions in all history when known, or what it needs. `note` carries the collector's own message. */
export function sourceLine(source: SourceStatus, detected: boolean, sessions?: number): { tone: Tone; text: string; found: boolean; note?: string } {
  const note = source.message || undefined;
  if (source.state === 'unsupported') return { tone: 'off', text: 'Not supported here', found: false, note };
  if (source.enabled && ATTENTION[source.state]) return { tone: 'warn', text: ATTENTION[source.state]!, found: true, note };
  if (source.enabled && source.state === 'paused') return { tone: 'off', text: 'Paused', found: true, note };
  if (source.enabled && source.state === 'importing') return { tone: 'ok', text: 'Importing…', found: true, note };
  if (!detected && !source.eventCount && !(source.enabled && source.state === 'current')) return { tone: 'off', text: 'Not found', found: false, note };
  const count = sessions ? `${formatExact(sessions)} ${sessions === 1 ? 'session' : 'sessions'}` : source.eventCount ? `${formatExact(source.eventCount)} records` : null;
  return { tone: source.enabled ? 'ok' : 'off', text: count ? `Detected · ${count}` : 'Detected', found: true, note };
}

/** The Mac app checks automatically; its native prompts and gear menu let the user update and restart. */
export function updateLine(update: ShellState['update']): string {
  const named = update.version ? `Version ${update.version}` : 'A new version';
  const v = update.version ? ` v${update.version}` : '';
  switch (update.state) {
    case 'disabled': return 'Updates are off in this build.';
    case 'checking': return 'Checking for updates…';
    case 'available': return `${named} is available. Choose Download${v} from the gear menu in the menu bar.`;
    case 'downloading': return `Downloading${v}…`;
    case 'ready': return `${named} is downloaded. Choose Restart to install${v} from the gear menu in the menu bar.`;
    default: return 'Automatic checks on';
  }
}

/** What the menu bar item shows under `settings`, as the app titles it (`apps/mac/src/menu.rs` `title`): the period's tokens
 *  or cost, or nothing beside the icon. A period with an unpriced model shows its tokens rather than a made-up amount. */
export function menuBarTitle(overview: MenuOverview, settings: LocalSettings): string {
  const periods: Record<MenuBarPeriod, [number, number | null]> = {
    today: [overview.today, overview.costs.today], week: [overview.week, overview.costs.week],
    month: [overview.month, overview.costs.month], all: [overview.allTime, overview.costs.allTime],
  };
  const [tokens, cost] = periods[settings.menuBarPeriod];
  if (settings.menuBar === 'icon') return '';
  if (settings.menuBar === 'tokens' || cost === null) return formatCompact(tokens);
  // Cents below $1,000, then K, M, B and T as for tokens.
  return cost < 999_995_000 ? formatCost(cost) : `$${formatCompact(Math.round(cost / 1e6))}`;
}

/** Settings: the app's own switches where there is an app shell, the sources it reads, the leaderboard link, export and version. */
export function SettingsView({ api, health, status, refresh }: { api: ApiClient; health: Health; status: LocalStatus | null; refresh: () => Promise<void> }) {
  const [shell, setShell] = useState<ShellState | null | undefined>(undefined);
  const [detected, setDetected] = useState<DetectedTool[] | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<MenuOverview | null>(null);
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  // Each source's sessions in all history, read again when usage changes.
  const history = useLoad(() => api.localSummary({ from: '2000-01-01', to: utcToday() }), [api, usageRevision(status)]);
  const sessions = history.value ? new Map(history.value.byTool.map((item) => [item.tool, item.sessions])) : null;
  useEffect(() => {
    let live = true;
    api.shellState().then((value) => { if (live) setShell(value); }).catch(() => { if (live) setShell(null); });
    api.localDetect().then((value) => { if (live) setDetected(value.tools); }).catch(() => { if (live) setDetected([]); });
    api.localSettings().then((value) => { if (live) setSettings(value); }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  // The overview knows whether collection is paused even when no source is on to show it, and gives the menu bar preview its totals.
  useEffect(() => {
    let live = true;
    api.localOverview().then((value) => { if (live) { setOverview(value); setPaused(value.paused); } }).catch(() => {});
    return () => { live = false; };
  }, [api, status?.collecting, usageRevision(status)]);
  return <SettingsPage api={api} health={health} status={status} refresh={refresh} shell={shell ?? null} onShell={setShell} detected={detected} paused={paused} onPaused={setPaused} sessions={sessions}
    overview={overview} settings={settings} onSettings={setSettings} />;
}

const SECTIONS = [
  { id: 'general', label: 'General', icon: ICONS.gear, shell: true },
  { id: 'sources', label: 'Sources', icon: ICONS.folder },
  { id: 'privacy', label: 'Leaderboard & privacy', icon: ICONS.shield },
  { id: 'menubar', label: 'Menu bar', icon: ICONS.panelTop, shell: true },
  { id: 'pricing', label: 'Pricing & data', icon: ICONS.database },
  { id: 'updates', label: 'Updates', icon: ICONS.refresh, shell: true },
  { id: 'account', label: 'Account', icon: ICONS.user, linked: true },
] as const;
const JOINED = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

export function SettingsPage({ api, health, status, refresh, shell, onShell, detected, paused, onPaused, sessions = null, overview = null, settings = null, onSettings = () => {} }: {
  api: ApiClient; health: Health; status: LocalStatus | null; refresh: () => Promise<void>;
  shell: ShellState | null; onShell: (shell: ShellState) => void; detected: DetectedTool[] | null; paused: boolean | null; onPaused: (paused: boolean) => void;
  sessions?: Map<ToolId, number> | null; overview?: MenuOverview | null; settings?: LocalSettings | null; onSettings?: (settings: LocalSettings) => void;
}) {
  const [chosen, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsReconnect = status?.syncError === 'RELINK_REQUIRED' || status?.syncError === 'LOCAL_STATE_RESET';
  const linked = !!health.cloudUrl && !!status?.cloudLinked && !needsReconnect;
  // GitHub login and join date come from your public profile.
  const profile = useLoad(linked && status?.alias ? () => api.profileStats(status.alias!) : null, [api, linked, status?.alias]);
  const sections = SECTIONS.filter((section) => (!('shell' in section) || shell) && (!('linked' in section) || linked));
  // The first section is current until one is chosen; General appears once the shell answers.
  const current = chosen ?? sections[0]!.id;
  const sources = TOOLS.flatMap((tool) => status?.sources.filter((source) => source.id === tool.id) ?? []);
  const on = sources.filter((source) => source.enabled).length;
  /** Runs one action at a time, reporting its failure on the page. */
  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    try { await action(); } catch (value) { setError(errorText(value)); } finally { setBusy(null); }
  };
  const jump = (id: string) => { setCurrent(id); document.getElementById(`st-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return <div className="m-page st-page">
    <nav className="st-nav" aria-label="Settings sections">
      <div className="st-nav-title">Settings</div>
      {sections.map((section) => <button key={section.id} type="button" className={`st-nav-item${current === section.id ? ' on' : ''}`} aria-current={current === section.id ? 'true' : undefined} onClick={() => jump(section.id)}>
        {section.icon}{section.label}{section.id === 'sources' && sources.length > 0 && <span className="st-count">{on}/{sources.length}</span>}
      </button>)}
      <div className="st-nav-foot">Tokentracky {shell?.version ?? health.version}<br />Reads locally, ranks publicly.</div>
    </nav>
    <div className="st-col">
      <div className="st-intro"><h1 className="m-page-title">Settings</h1><p className="m-page-sub">Changes save automatically. Nothing here alters how your coding tools work.</p></div>
      {error && <Notice tone="error">{error}</Notice>}
      {shell && <Section id="general" title="General">
        <div className="st-group">
          <Row label="Launch at login" desc="Start Tokentracky in the menu bar when you sign in to your Mac.">
            <Toggle label="Launch at login" on={shell.launchAtLogin} disabled={busy === 'login'} onChange={() => void act('login', async () => onShell(await api.setLaunchAtLogin(!shell.launchAtLogin)))} />
          </Row>
          <Row label="Quit Tokentracky" desc="Stops reading your tools until you open the app again.">
            <button type="button" className="m-btn st-sm" onClick={() => void act('quit', () => api.quitApp())}>{ICONS.power}Quit</button>
          </Row>
        </div>
      </Section>}
      {status ? <Sources api={api} status={status} sources={sources} detected={detected} sessions={sessions} paused={paused} busy={busy} act={act} refresh={refresh} onPaused={onPaused} /> : <Loading>Loading sources…</Loading>}
      <Section id="privacy" title="Leaderboard & privacy" note="Ranks are client-reported usage, not verified spending.">
        <Leaderboard api={api} health={health} status={status} profile={profile.value} refresh={refresh} busy={busy} act={act} />
      </Section>
      {shell && settings && <MenuBar settings={settings} overview={overview} busy={busy} change={(next) => void act('menubar', async () => onSettings(await api.setLocalSettings(next)))} />}
      <Section id="pricing" title="Pricing & data" note="Costs are estimates from a public price table. Models without a known price show as unknown, never $0.">
        <div className="st-group">
          {settings && <Row label="Refresh price table daily" desc="Downloads LiteLLM’s public price table from GitHub once a day. Turn off to keep the snapshot that came with the app and make no downloads."
            meta={status?.pricingUpdatedAt ? `Updated ${timeAgo(status.pricingUpdatedAt)}${status.pricingVersion ? ` · version ${status.pricingVersion.replace(/^litellm:/, '')}` : ''}` : undefined}>
            <Toggle label="Refresh price table daily" on={settings.priceRefresh} disabled={busy === 'pricing'} onChange={() => void act('pricing', async () => { onSettings(await api.setLocalSettings({ ...settings, priceRefresh: !settings.priceRefresh })); await refresh(); })} />
          </Row>}
          {!settings && status?.pricingVersion && <Row label="Price table" desc="LiteLLM’s public table of API list prices, applied to every model it lists." meta={`Version ${status.pricingVersion.replace(/^litellm:/, '')}`} />}
          <Row label="Export data" desc="Every usage record with its tool, model, project and token counts, for all your history. The file is saved on this Mac.">
            <button type="button" className="m-btn st-sm" disabled={busy === 'export'} onClick={() => void act('export', () => downloadCsv(api, { from: '2000-01-01', to: utcToday() }, 'all', `tokentracky-usage-${utcToday()}.csv`))}>{ICONS.download}Export CSV</button>
          </Row>
        </div>
      </Section>
      {shell && <Section id="updates" title="Updates">
        <div className="st-group">
          <Row label={`Tokentracky ${shell.version}`} desc={shell.update.state === 'idle' ? 'Checks automatically after launch and every 6 hours. You choose when to update and restart.' : updateLine(shell.update)}>
            {shell.update.state === 'idle' && <span className="st-ok">{ICONS.check}Automatic checks on</span>}
            <button type="button" className="m-btn st-sm" disabled={busy === 'update' || ['disabled', 'checking', 'downloading'].includes(shell.update.state)} onClick={() => void act('update', async () => onShell(await api.checkForUpdates()))}>{shell.update.state === 'checking' ? <><Spinner /> Checking…</> : 'Check now'}</button>
          </Row>
        </div>
      </Section>}
      {linked && <Account health={health} status={status!} profile={profile.value} busy={busy} unlink={() => { if (window.confirm(UNLINK)) void act('unlink', async () => { await api.unlinkCloud(); await refresh(); }); }} />}
    </div>
  </div>;
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return <section className="st-section" id={`st-${id}`} aria-labelledby={`st-${id}-title`}>
    <div className="st-head"><h2 id={`st-${id}-title`}>{title}</h2>{note && <p>{note}</p>}</div>
    {children}
  </section>;
}

function Row({ label, desc, meta, lead, className, children }: { label: ReactNode; desc?: ReactNode; meta?: ReactNode; lead?: ReactNode; className?: string; children?: ReactNode }) {
  return <div className={`st-row${className ? ` ${className}` : ''}`}>
    {lead}<div className="st-row-text"><div className="st-row-label">{label}</div>{desc && <div className="st-row-desc">{desc}</div>}{meta && <div className="st-row-meta">{meta}</div>}</div>
    {children && <div className="st-row-ctl">{children}</div>}
  </div>;
}

function Toggle({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`m-toggle${on ? ' on' : ''}`} disabled={disabled} onClick={onChange} />;
}

function Sources({ api, status, sources, detected, sessions, paused, busy, act, refresh, onPaused }: {
  api: ApiClient; status: LocalStatus; sources: SourceStatus[]; detected: DetectedTool[] | null; sessions: Map<ToolId, number> | null; paused: boolean | null; busy: string | null;
  act: (name: string, action: () => Promise<unknown>) => Promise<void>; refresh: () => Promise<void>; onPaused: (paused: boolean) => void;
}) {
  const [editing, setEditing] = useState<SourceStatus | null>(null);
  const lines = new Map(sources.map((source) => [source.id, sourceLine(source, detected?.some((tool) => tool.id === source.id) ?? false, sessions?.get(source.id))]));
  const total = sessions ? [...sessions.values()].reduce((sum, count) => sum + count, 0) : null;
  const found = sources.filter((source) => lines.get(source.id)!.found);
  const choosable = sources.filter((source) => source.state !== 'unsupported');
  const isPaused = paused ?? status.sources.some((source) => source.state === 'paused');
  return <Section id="sources" title="Sources" note="The tools Tokentracky reads usage from.">
    {status.firstRun && <div className="st-callout">{ICONS.check}<div><b>{setupHeading(status, detected)}</b></div></div>}
    <div className="st-callout">{ICONS.shieldCheck}<div><b>Read-only collection.</b> Tokentracky reads the records each tool already keeps. It never installs hooks or changes a tool’s settings, and only opens the folders listed here.</div></div>
    <div className="st-group">
      {sources.map((source) => {
        const line = lines.get(source.id)!;
        return <Row key={source.id} className={`st-src${line.found ? '' : ' missing'}`} label={source.name} lead={<span className="st-src-ic"><ToolIcon id={source.id} /></span>}
          desc={<span className="st-path" title={source.paths.join(', ')}>{source.paths.join(', ') || 'No folder chosen'}</span>}
          meta={line.tone === 'warn' || (line.note && source.enabled) ? line.note : undefined}>
          <span className={`st-status ${line.tone}`}><span className="st-dot" />{line.text}</span>
          {!line.found && source.state !== 'unsupported' && <button type="button" className="m-btn ghost st-sm" onClick={() => setEditing(source)}>Locate…</button>}
          <Toggle label={`Read ${source.name}`} on={source.enabled} disabled={busy !== null || source.state === 'unsupported'}
            onChange={() => void act(`source:${source.id}`, async () => { await api.updateSource(source.id, { enabled: !source.enabled, paths: source.paths }); await refresh(); })} />
        </Row>;
      })}
      <div className="st-group-foot">
        <span className="st-grow">{found.length} of {sources.length} found · {sources.filter((source) => source.enabled).length} on{total !== null && ` · ${formatExact(total)} ${total === 1 ? 'session' : 'sessions'}`}</span>
        {choosable.length > 0 && <button type="button" className="m-btn st-sm" onClick={() => setEditing(choosable.find((source) => !lines.get(source.id)!.found) ?? choosable[0]!)}>{ICONS.folderPlus}Grant folder access…</button>}
      </div>
    </div>
    <div className="st-group">
      <Row label="Pause collection" desc="Stop reading new records until you resume. Nothing is deleted.">
        <Toggle label="Pause collection" on={isPaused} disabled={busy !== null || paused === null}
          onChange={() => void act('pause', async () => { onPaused((await api.setCollectionPaused(!isPaused)).paused); await refresh(); })} />
      </Row>
      <Row label="Last refresh" desc={`${status.lastRefreshAt ?? status.lastScanAt ? `Refreshed ${timeAgo(status.lastRefreshAt ?? status.lastScanAt)}` : 'Not refreshed yet'}${status.nextRefreshAt && !isPaused ? ` · next ${timeUntil(status.nextRefreshAt)}` : ''} · every 5 minutes`}>
        <button type="button" className="m-btn st-sm" disabled={busy !== null || isPaused || status.refreshing || !sources.some((source) => source.enabled)}
          onClick={() => void act('refresh', async () => { await api.refresh(); await refresh(); })}>{busy === 'refresh' || status.refreshing ? 'Refreshing…' : 'Refresh now'}</button>
      </Row>
    </div>
    {editing && <FolderModal api={api} source={editing} sources={choosable} refresh={refresh} onClose={() => setEditing(null)} />}
  </Section>;
}

const SHARED = ['All history: daily token totals', 'Tool split', 'Model mix', 'Estimated cost', 'Achievements computed from those totals', 'GitHub username, if you signed in with GitHub'];
const PRIVATE = ['Projects', 'Prompts', 'Code', 'File paths'];

/** What the leaderboard gets, and what it never does. Joining publishes all of it; there are no sharing switches. */
function Privacy({ joined }: { joined: boolean }) {
  return <div className="st-shared">
    <div><h3><span className="st-hico yes">{ICONS.check}</span>{joined ? 'Shared with the leaderboard' : 'Shared once you join'}</h3>
      <ul className="st-yes">{SHARED.map((item) => <li key={item}>{ICONS.check}{item}</li>)}</ul></div>
    <div><h3><span className="st-hico no">{ICONS.lock}</span>Never leaves this Mac</h3>
      <ul className="st-no">{PRIVATE.map((item) => <li key={item}>{ICONS.lock}{item}</li>)}</ul></div>
  </div>;
}

const UNLINK = 'Unlink this Mac from the leaderboard? Uploads from this Mac stop. What is already published stays until you delete your account on the web.';

function Leaderboard({ api, health, status, profile, refresh, busy, act }: { api: ApiClient; health: Health; status: LocalStatus | null; profile: ProfileStats | null; refresh: () => Promise<void>; busy: string | null; act: (name: string, action: () => Promise<unknown>) => Promise<void> }) {
  const { flow, setFlow, error, start } = useConnectFlow(api, refresh);
  const needsReconnect = status?.syncError === 'RELINK_REQUIRED' || status?.syncError === 'LOCAL_STATE_RESET';
  const linked = !!status?.cloudLinked && !needsReconnect;
  if (!health.cloudUrl) return <div className="st-group"><Row label="Leaderboard" desc="This build isn’t connected to a leaderboard server. Your usage is still tracked on this Mac." /></div>;
  const unlink = () => {
    if (!window.confirm(UNLINK)) return;
    void act('unlink', async () => { await api.unlinkCloud(); await refresh(); });
  };
  if (linked) return <div className="st-group">
    <Row label="Display name" desc="Shown on the leaderboard and your profile card."><span className="st-value">{status.alias ?? '—'}</span></Row>
    <Row label="GitHub" desc={profile?.githubLogin ? 'Shown on your profile, with a link to it.' : 'Shown on your profile when you sign in with GitHub.'}>
      {profile?.githubLogin && <span className="st-value">{GITHUB}@{profile.githubLogin}</span>}
    </Row>
    <Privacy joined />
  </div>;
  return <div className="st-group">
    {flow.step === 'waiting'
      ? <Row label="Finish in your browser" desc="Sign in, pick your name and approve this code. This page updates by itself." meta={<span className="st-waiting"><Spinner />Waiting for approval…</span>}>
        <span className="st-code" aria-label={`Connection code ${flow.start.userCode}`}>{flow.start.userCode}</span>
        <a className="m-btn primary st-sm" href={flow.start.verificationUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a>
        <button type="button" className="m-btn ghost st-sm" onClick={() => setFlow({ step: 'idle' })}>Cancel</button>
      </Row>
      : <Row label={needsReconnect ? 'Reconnect to keep syncing' : 'Join the leaderboard'}
        desc={needsReconnect
          ? status?.syncError === 'LOCAL_STATE_RESET' ? 'Your local history was reset or restored. Reconnect to upload your totals again.' : 'Your link to the leaderboard needs approving again on this Mac.'
          : 'See how your usage stacks up. Sign in with GitHub or email in your browser; it takes about 30 seconds.'}
        meta={flow.step === 'expired' ? 'That code expired. Start again to get a new one.' : error ?? undefined}>
        <button type="button" className="m-btn primary st-sm" disabled={flow.step === 'starting'} onClick={() => void start()}>{flow.step === 'starting' ? <><Spinner /> Opening browser…</> : needsReconnect ? 'Reconnect' : 'Join…'}</button>
      </Row>}
    <Privacy joined={false} />
    {needsReconnect && <Row label="Unlink this Mac" desc="Stops uploads from this Mac. What is already published stays on the leaderboard until you delete your account on the web.">
      <button type="button" className="m-btn danger st-sm" disabled={busy === 'unlink'} onClick={unlink}>Unlink…</button>
    </Row>}
  </div>;
}

/** The linked account: who you are on the board, unlinking this Mac, and deleting the profile, which is done on the website. */
export function Account({ health, status, profile, busy, unlink }: { health: Health; status: LocalStatus; profile: ProfileStats | null; busy: string | null; unlink: () => void }) {
  const joined = profile ? `joined ${JOINED.format(new Date(`${profile.memberSince}T00:00:00Z`))}` : null;
  const how = profile?.githubLogin ? `Signed in with GitHub${joined ? ` · ${joined}` : ''}` : joined && joined[0]!.toUpperCase() + joined.slice(1);
  return <Section id="account" title="Account">
    <div className="st-group">
      <Row label={<span className="st-acct">{status.alias ? <Avatar alias={status.alias} /> : <span className="avatar" aria-hidden="true" />}<span><b>{status.alias ?? 'Linked'}</b><span>{[how, `synced ${timeAgo(status.lastSyncAt)}`].filter(Boolean).join(' · ')}</span></span></span>}
        meta={status.syncError ? 'The last sync failed. Tracking continues on this Mac and sync retries on its own.' : undefined}>
        <a className="m-btn st-sm" href={`${health.cloudUrl}/you`} target="_blank" rel="noopener noreferrer">Manage on the web{ICONS.external}</a>
      </Row>
      <Row label="Unlink this Mac" desc="Stops uploads from this Mac. What is already published stays on the leaderboard until you delete your account on the web.">
        <button type="button" className="m-btn st-sm" disabled={busy === 'unlink'} onClick={unlink}>Unlink…</button>
      </Row>
      <Row label="Delete leaderboard profile" desc="Removes your public profile, rank and achievements from the website. Usage on this Mac is kept.">
        <a className="m-btn danger st-sm" href={`${health.cloudUrl}/you#danger`} target="_blank" rel="noopener noreferrer">Delete on the web{ICONS.external}</a>
      </Row>
    </div>
  </Section>;
}

const SHOWS: Array<{ value: MenuBarShows; label: string }> = [{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }, { value: 'icon', label: 'Icon only' }];
const PERIODS: Array<{ value: MenuBarPeriod; label: string }> = [{ value: 'today', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All time' }];

function Choice<T extends string>({ label, value, options, disabled, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; disabled?: boolean; onChange: (value: T) => void }) {
  return <div className="m-seg" role="group" aria-label={label}>{options.map((option) => <button key={option.value} type="button" className={option.value === value ? 'on' : undefined}
    aria-pressed={option.value === value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

/** What the menu bar item shows, with the item as it looks now. */
function MenuBar({ settings, overview, busy, change }: { settings: LocalSettings; overview: MenuOverview | null; busy: string | null; change: (settings: LocalSettings) => void }) {
  const shown = overview ? menuBarTitle(overview, settings) : '';
  return <Section id="menubar" title="Menu bar">
    <div className="st-group">
      <Row label="Show in the menu bar" desc="Beside the Tokentracky icon. Large numbers are shortened to K, M, B and T.">
        <Choice label="Show in the menu bar" value={settings.menuBar} options={SHOWS} disabled={busy === 'menubar'} onChange={(menuBar) => change({ ...settings, menuBar })} />
      </Row>
      <Row label="Period" desc="Which total it shows, in your computer’s time zone.">
        <Choice label="Period" value={settings.menuBarPeriod} options={PERIODS} disabled={busy === 'menubar' || settings.menuBar === 'icon'} onChange={(menuBarPeriod) => change({ ...settings, menuBarPeriod })} />
      </Row>
      <div className="st-mb-preview" aria-hidden="true"><span className="st-mb-item"><span className="brand-mark" />{shown}</span></div>
    </div>
  </Section>;
}
