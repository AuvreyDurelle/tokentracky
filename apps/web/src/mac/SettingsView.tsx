import { useEffect, useState, type ReactNode } from 'react';
import type { SourceStatus } from '@tokentracky/core';
import type { ApiClient, DetectedTool, Health, LocalStatus, ShellState } from '../api';
import { TOOLS, errorText, formatExact, timeAgo, timeUntil } from '../format';
import { utcToday } from '../ranges';
import { Avatar, Loading, Notice, Spinner, ToolIcon } from '../ui';
import { FolderModal, downloadCsv, setupHeading, useConnectFlow } from '../You';
import { ICONS } from './icons';
import './personal.css';

type Tone = 'ok' | 'off' | 'warn';
const ATTENTION: Partial<Record<SourceStatus['state'], string>> = { permission_required: 'Needs folder access', error: 'Needs attention', stale: 'Needs a scan' };

/** One source's status line: whether its records were found, or what it needs. `note` carries the collector's own message. */
export function sourceLine(source: SourceStatus, detected: boolean): { tone: Tone; text: string; found: boolean; note?: string } {
  const note = source.message || undefined;
  if (source.state === 'unsupported') return { tone: 'off', text: 'Not supported here', found: false, note };
  if (source.enabled && ATTENTION[source.state]) return { tone: 'warn', text: ATTENTION[source.state]!, found: true, note };
  if (source.enabled && source.state === 'paused') return { tone: 'off', text: 'Paused', found: true, note };
  if (source.enabled && source.state === 'importing') return { tone: 'ok', text: 'Importing…', found: true, note };
  if (!detected && !source.eventCount && !(source.enabled && source.state === 'current')) return { tone: 'off', text: 'Not found', found: false, note };
  // Later: "N sessions" per source needs sessions per tool (Task 1.4); `eventCount` counts usage records.
  return { tone: source.enabled ? 'ok' : 'off', text: source.eventCount ? `Detected · ${formatExact(source.eventCount)} records` : 'Detected', found: true, note };
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

/** Settings: the app's own switches where there is an app shell, the sources it reads, the leaderboard link, export and version. */
export function SettingsView({ api, health, status, refresh }: { api: ApiClient; health: Health; status: LocalStatus | null; refresh: () => Promise<void> }) {
  const [shell, setShell] = useState<ShellState | null | undefined>(undefined);
  const [detected, setDetected] = useState<DetectedTool[] | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.shellState().then((value) => { if (live) setShell(value); }).catch(() => { if (live) setShell(null); });
    api.localDetect().then((value) => { if (live) setDetected(value.tools); }).catch(() => { if (live) setDetected([]); });
    return () => { live = false; };
  }, [api]);
  // The overview knows whether collection is paused even when no source is on to show it.
  useEffect(() => {
    let live = true;
    api.localOverview().then((value) => { if (live) setPaused(value.paused); }).catch(() => {});
    return () => { live = false; };
  }, [api, status?.collecting]);
  return <SettingsPage api={api} health={health} status={status} refresh={refresh} shell={shell ?? null} onShell={setShell} detected={detected} paused={paused} onPaused={setPaused} />;
}

const SECTIONS = [
  { id: 'general', label: 'General', icon: ICONS.gear, shell: true },
  { id: 'sources', label: 'Sources', icon: ICONS.folder },
  { id: 'leaderboard', label: 'Leaderboard', icon: ICONS.shield },
  { id: 'data', label: 'Data', icon: ICONS.database },
  { id: 'updates', label: 'Updates', icon: ICONS.refresh, shell: true },
  { id: 'about', label: 'About', icon: ICONS.info },
] as const;

export function SettingsPage({ api, health, status, refresh, shell, onShell, detected, paused, onPaused }: {
  api: ApiClient; health: Health; status: LocalStatus | null; refresh: () => Promise<void>;
  shell: ShellState | null; onShell: (shell: ShellState) => void; detected: DetectedTool[] | null; paused: boolean | null; onPaused: (paused: boolean) => void;
}) {
  const [chosen, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sections = SECTIONS.filter((section) => !('shell' in section) || shell);
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
        </div>
      </Section>}
      {status ? <Sources api={api} status={status} sources={sources} detected={detected} paused={paused} busy={busy} act={act} refresh={refresh} onPaused={onPaused} /> : <Loading>Loading sources…</Loading>}
      <Section id="leaderboard" title="Leaderboard">
        <Leaderboard api={api} health={health} status={status} refresh={refresh} busy={busy} act={act} />
      </Section>
      <Section id="data" title="Data">
        <div className="st-group">
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
      <Section id="about" title="About">
        <div className="st-group">
          <Row label={`Tokentracky ${shell?.version ?? health.version}`} desc="Reads the logs your AI coding tools already keep, and ranks your usage on the public leaderboard if you join.">
            {shell && <button type="button" className="m-btn st-sm" onClick={() => void act('quit', () => api.quitApp())}>{ICONS.power}Quit Tokentracky</button>}
          </Row>
        </div>
      </Section>
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

function Sources({ api, status, sources, detected, paused, busy, act, refresh, onPaused }: {
  api: ApiClient; status: LocalStatus; sources: SourceStatus[]; detected: DetectedTool[] | null; paused: boolean | null; busy: string | null;
  act: (name: string, action: () => Promise<unknown>) => Promise<void>; refresh: () => Promise<void>; onPaused: (paused: boolean) => void;
}) {
  const [editing, setEditing] = useState<SourceStatus | null>(null);
  const lines = new Map(sources.map((source) => [source.id, sourceLine(source, detected?.some((tool) => tool.id === source.id) ?? false)]));
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
        <span className="st-grow">{found.length} of {sources.length} found · {sources.filter((source) => source.enabled).length} on</span>
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

function Leaderboard({ api, health, status, refresh, busy, act }: { api: ApiClient; health: Health; status: LocalStatus | null; refresh: () => Promise<void>; busy: string | null; act: (name: string, action: () => Promise<unknown>) => Promise<void> }) {
  const { flow, setFlow, error, start } = useConnectFlow(api, refresh);
  const needsReconnect = status?.syncError === 'RELINK_REQUIRED' || status?.syncError === 'LOCAL_STATE_RESET';
  const linked = !!status?.cloudLinked && !needsReconnect;
  if (!health.cloudUrl) return <div className="st-group"><Row label="Leaderboard" desc="This build isn’t connected to a leaderboard server. Your usage is still tracked on this Mac." /></div>;
  const unlink = () => {
    if (!window.confirm('Unlink this Mac from the leaderboard? Uploads from this Mac stop. What is already published stays until you delete your account on the web.')) return;
    void act('unlink', async () => { await api.unlinkCloud(); await refresh(); });
  };
  if (linked) return <div className="st-group">
    <Row label={<span className="st-acct">{status.alias ? <Avatar alias={status.alias} /> : <span className="avatar" aria-hidden="true" />}<span><b>{status.alias ?? 'Linked'}</b><span>Public on the leaderboard · synced {timeAgo(status.lastSyncAt)}</span></span></span>}
      meta={status.syncError ? 'The last sync failed. Tracking continues on this Mac and sync retries on its own.' : undefined}>
      <a className="m-btn st-sm" href={`${health.cloudUrl}/you`} target="_blank" rel="noopener noreferrer">Manage on the web{ICONS.external}</a>
    </Row>
    <Privacy joined />
    <Row label="Unlink this Mac" desc="Stops uploads from this Mac. What is already published stays on the leaderboard until you delete your account on the web.">
      <button type="button" className="m-btn danger st-sm" disabled={busy === 'unlink'} onClick={unlink}>Unlink…</button>
    </Row>
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
