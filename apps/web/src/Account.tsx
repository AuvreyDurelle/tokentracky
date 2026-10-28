import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ProfileStats, Publication, PublicProfile } from '@tokentracky/core';
import { ApiError, type Account, type ApiClient } from './api';
import type { AuthAdapter, AuthState, SignInIdentity } from './auth';
import { draftFromPublication, publicationRequest, validAlias, type PublicationDraft } from './publication';
import { errorText, formatCost, shortDay, timeAgo } from './format';
import { AppleIcon, Avatar, Empty, Loading, Notice, Segmented, Spinner, Tokens } from './ui';
import { PasswordResetRequest } from './PasswordRecovery';
import { MAC_DOWNLOAD } from './download-config';

/** Only the providers enabled in Supabase Auth are offered; email uses a password (sign in or create an account). `signUp` opens on Create account. */
export function SignIn({ auth, signUp = false }: { auth: AuthAdapter; signUp?: boolean }) {
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>(signUp ? 'sign_up' : 'sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const oauth = auth.providers.filter((provider): provider is 'github' | 'google' => provider !== 'email');
  if (resetting) return <PasswordResetRequest auth={auth} initialEmail={email} onBack={() => setResetting(false)} />;
  if (confirming) return <Notice tone="success">Check your inbox: we sent a confirmation link to {email}. Open it, then come back and sign in.</Notice>;
  if (!auth.providers.length) return <Notice>Sign-in is not set up on this server yet.</Notice>;
  return <div className="signin">
    {oauth.includes('github') && <button type="button" className="btn lg" disabled={busy} onClick={() => void run(() => auth.github())}><GitHubIcon />Continue with GitHub</button>}
    {oauth.includes('google') && <button type="button" className="btn lg" disabled={busy} onClick={() => void run(() => auth.google())}><GoogleIcon />Continue with Google</button>}
    {oauth.length > 0 && auth.providers.includes('email') && <div className="divider">or</div>}
    {auth.providers.includes('email') && <form className="form" style={{ gap: 10 }} onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!await auth.password(email, password, mode)) setConfirming(true); }); }}>
      <label className="field"><span className="sr-only">Email</span><input className="input" type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label className="field"><span className="sr-only">Password</span><input className="input" type="password" placeholder={mode === 'sign_up' ? 'Choose a password (8+ characters)' : 'Password'} autoComplete={mode === 'sign_up' ? 'new-password' : 'current-password'} minLength={mode === 'sign_up' ? 8 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <button className="btn primary lg" disabled={busy}>{busy ? <Spinner /> : null}{mode === 'sign_up' ? 'Create account' : 'Sign in with email'}</button>
      {mode === 'sign_in' && <button type="button" className="link" disabled={busy} onClick={() => setResetting(true)}>Forgot password?</button>}
      <p className="faint signin-switch">{mode === 'sign_up' ? 'Already have an account? ' : 'New here? '}
        <button type="button" className="link" onClick={() => { setMode(mode === 'sign_up' ? 'sign_in' : 'sign_up'); setError(null); }}>{mode === 'sign_up' ? 'Sign in' : 'Create an account'}</button></p>
    </form>}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

/** Whether a valid name is taken: one with a public profile is. Undefined while checking, null when unchecked or the check failed. The server has the last word when saving. */
export function useAliasTaken(api: ApiClient, alias: string, enabled: boolean): boolean | null | undefined {
  const [checked, setChecked] = useState<{ alias: string; taken: boolean | null } | null>(null);
  const checking = enabled && validAlias(alias);
  useEffect(() => {
    if (!checking) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api.profile(alias, 'all')
        .then(() => { if (live) setChecked({ alias, taken: true }); })
        .catch((value: unknown) => { if (live) setChecked({ alias, taken: value instanceof ApiError && value.status === 404 ? false : null }); });
    }, 400);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, checking, alias]);
  return checking ? checked?.alias === alias ? checked.taken : undefined : null;
}

/** The leaderboard name. Sharing is fixed, so there is nothing else to choose. A new member sees whether the name is free and how it will look; a member renaming sees what saving costs, and Save waits for a change unless saving is the `repair` for an integrity hold. */
export function ProfileForm({ api, publication, repair = false, onSaved, children }: { api: ApiClient; publication: Publication | null; repair?: boolean; onSaved: (publication: Publication) => Promise<void> | void; children?: ReactNode }) {
  const [draft, setDraft] = useState<PublicationDraft>(() => draftFromPublication(publication));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(draftFromPublication(publication)); }, [publication]);
  const taken = useAliasTaken(api, draft.alias, !publication);
  const changed = repair || draft.alias !== publication?.alias;
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await api.publication(publicationRequest(draft));
      await onSaved(result.publication);
      setSaved(true);
    } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const field = <label className="field">Leaderboard name
    <span className="name-input">
      <input className="input" value={draft.alias} onChange={(event) => { setDraft({ alias: event.target.value }); setSaved(false); }} minLength={3} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,29}" autoComplete="nickname" placeholder="e.g. token-wizard" aria-invalid={taken === true || undefined} aria-describedby="name-hint" required />
      {taken === false && <span className="name-free"><CheckIcon />Available</span>}
    </span>
    <small id="name-hint" role="status">{taken ? 'Taken. Choose another name.' : '3–30 letters, numbers, - or _. Shown publicly; never your email.'}</small>
  </label>;
  if (!publication) return <form className="form" onSubmit={(event) => void submit(event)}>
    {field}
    {error && <Notice tone="error">{error}</Notice>}
    <button className="btn primary lg" disabled={busy || taken === true}>{busy ? <><Spinner /> Saving…</> : 'Continue'}</button>
    <div className="field name-preview">How you’ll appear
      <div className="you-row"><span className="num you-rank">—</span><Avatar alias={draft.alias || 'your-name'} /><div className="you-name"><strong><span>{draft.alias || 'your-name'}</span></strong><span className="faint">0 tokens · appears after your first sync</span></div></div>
    </div>
  </form>;
  return <form className="panel" onSubmit={(event) => void submit(event)}>
    <div className="panel-body">{field}{children}{error && <Notice tone="error">{error}</Notice>}</div>
    <div className="panel-foot form-foot">
      {changed && <span>Saving resets your public totals until your app’s next sync.</span>}
      {saved && !changed && <span className="saved" role="status"><CheckIcon />Saved</span>}
      <button className="btn primary sm" disabled={busy || !changed}>{busy ? <><Spinner /> Saving…</> : 'Save name'}</button>
    </div>
  </form>;
}

const SECTIONS = [['listing', 'Your listing'], ['computer', 'Computers'], ['signin', 'Sign-in'], ['badge', 'README badge'], ['danger', 'Danger zone']] as const;
const PROVIDERS: Record<string, string> = { github: 'GitHub', google: 'Google', email: 'Email' };
const ONBOARDING = ['Choose your name', 'Connect your Mac', 'First sync'];

/** The member's account. Without a name it is onboarding: choose a name, then connect a Mac. Then: standing, listing with board neighbours, computers, sign-in, README badge and the danger zone. There is no sharing section: sharing is fixed. */
export function HostedAccount({ api, auth, authState, account, accountLoading, accountError, refreshAccount, refreshAuth, deleteAccount, onViewBoard, onProfile, signUp = false }: { api: ApiClient; auth: AuthAdapter; authState: AuthState; account: Account | null; accountLoading: boolean; accountError: string | null; refreshAccount: () => Promise<void>; refreshAuth: () => Promise<void>; deleteAccount: () => Promise<void>; onViewBoard: () => void; onProfile: (alias: string) => void; signUp?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [neighbours, setNeighbours] = useState<PublicProfile[]>([]);
  const [identities, setIdentities] = useState<SignInIdentity[]>([]);
  // Set when the name is chosen here: connecting a Mac comes next, until one connects or the member skips.
  const [onboarding, setOnboarding] = useState(false);
  const alias = account?.publication?.alias ?? null;
  // A computer may have connected since the account was last read. On first load the app is reading it already.
  useEffect(() => { if (authState === 'signed_in' && account) void refreshAccount().catch(() => {}); }, []);
  useEffect(() => {
    if (authState !== 'signed_in') return;
    let live = true;
    auth.identities().then((value) => { if (live) setIdentities(value); }).catch(() => {});
    return () => { live = false; };
  }, [auth, authState]);
  useEffect(() => {
    if (!alias) { setStats(null); setNeighbours([]); return; }
    let live = true;
    api.profileStats(alias).then(async (value) => {
      if (!live) return;
      setStats(value);
      if (!value.periods.all.tokens) return;
      // The page of the all-time board that holds the member, cut to the rows either side.
      const board = await api.leaderboard('all', 'all', '', Math.ceil(value.periods.all.rank / NEIGHBOUR_PAGE), NEIGHBOUR_PAGE);
      const index = board.items.findIndex((item) => item.alias === value.alias);
      if (live) setNeighbours(index < 0 ? [] : board.items.slice(Math.max(0, index - 1), index + 2));
    }).catch(() => { if (live) setStats(null); });
    return () => { live = false; };
  }, [api, alias]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const rename = (device: { id: string; name: string }) => {
    const name = window.prompt('Rename this computer', device.name)?.trim();
    if (!name || name === device.name) return;
    void run(async () => { await api.renameDevice(device.id, name); await refreshAccount(); });
  };
  const removeAccount = () => {
    if (!window.confirm('Delete Tokentracky data? This permanently removes your hosted application account, publication, devices and uploaded usage. Existing device tokens will stop working. Your local history remains. Your authentication provider identity may remain until separately deleted; backups follow operator retention and copies others saved may remain. This cannot be undone.')) return;
    void run(deleteAccount);
  };
  const signOut = () => void run(async () => { await auth.signOut(); await refreshAuth(); });

  if (authState === 'loading') return <Loading>Checking your sign-in…</Loading>;
  if (authState === 'unavailable') return <div className="page-stack"><Title /><section className="panel"><Empty title="Sign-in isn’t available here">This server has no account sign-in configured. The leaderboard is still public.</Empty></section></div>;
  if (authState === 'error') return <div className="page-stack"><Title /><section className="panel"><div className="panel-body"><p className="muted">We couldn’t confirm your sign-in. Check your connection and try again.</p><div className="actions"><button type="button" className="btn" onClick={() => void run(refreshAuth)}>Retry</button></div>{error && <Notice tone="error">{error}</Notice>}</div></section></div>;
  if (authState === 'signed_out') return <section className="auth-page">
    <div className="panel auth-card">
      <h1>Join the leaderboard</h1>
      <p className="lead">Compete on how many tokens you use. Sign in, pick a name, then connect the app.</p>
      <SignIn key={String(signUp)} auth={auth} signUp={signUp} />
    </div>
    <ol className="auth-steps">
      <li><span className="num">01</span><p>Open the Tokentracky app and click <strong>Join the leaderboard</strong>.</p></li>
      <li><span className="num">02</span><p>Sign in here and pick your name.</p></li>
      <li><span className="num">03</span><p>Approve the code. Your totals sync on their own.</p></li>
    </ol>
  </section>;

  // A reload keeps the last read on screen, so a save's confirmation stays put.
  const ready = account && !accountError;
  const signedInWith = identities.find((identity) => identity.provider !== 'email') ?? identities[0];
  if (accountLoading && !account) return <Loading>Loading your account…</Loading>;
  if (ready && (!account.publication || (onboarding && !account.devices.length))) {
    const step = account.publication ? 2 : 1;
    return <div className="onboard">
      <ol className="stepper" aria-label={`Step ${step} of ${ONBOARDING.length}`}>{ONBOARDING.map((label, index) =>
        <li key={label} className={index + 1 < step ? 'done' : index + 1 === step ? 'current' : undefined} aria-current={index + 1 === step ? 'step' : undefined}><span className="num">{index + 1}</span>{label}</li>)}</ol>
      {account.moderation && <ModerationNotice moderation={account.moderation} />}
      {account.integrity && <IntegrityNotice />}
      {error && <Notice tone="error">{error}</Notice>}
      {account.publication
        ? <ConnectMac alias={account.publication.alias} refreshAccount={refreshAccount} onSkip={() => setOnboarding(false)} />
        : <>
          <h1>Pick your leaderboard name</h1>
          <p className="lead">This is how you’ll show up on the public leaderboard.</p>
          <div className="panel panel-body"><ProfileForm api={api} publication={null} onSaved={async () => { setOnboarding(true); await refreshAccount(); }} /></div>
          <div className="onboard-next" aria-hidden="true"><span className="num">2</span><div><strong>Connect your Mac</strong>Open the Tokentracky app and click Join the leaderboard to start syncing.</div><span className="badge plain">Up next</span></div>
          <ul className="onboard-privacy">
            <li><LockIcon />Prompts, code and project names never leave your computer.</li>
            <li><BarsIcon />Only daily totals are uploaded.</li>
            <li><EyeOffIcon />Your email is never shown publicly.</li>
          </ul>
        </>}
      <footer className="onboard-foot">
        {signedInWith?.detail && <span>Signed in as {signedInWith.detail}</span>}
        <button type="button" className="link-quiet" disabled={busy} onClick={signOut}>Sign out</button>
        <button type="button" className="link-quiet" disabled={busy} onClick={removeAccount}>Delete Tokentracky data</button>
      </footer>
    </div>;
  }

  const all = stats?.periods.all.tokens ? stats.periods.all : null;
  return <div className="account-layout">
    <SectionNav named={Boolean(alias)} />
    <div className="page-stack">
      <Title>{signedInWith && <p>Signed in{alias ? ` as ${alias}` : ''} with {PROVIDERS[signedInWith.provider] ?? signedInWith.provider}</p>}</Title>
      {error && <Notice tone="error">{error}</Notice>}
      {accountError && <Notice tone="error">Could not load your account: {accountError} <button type="button" className="btn sm" onClick={() => void refreshAccount().catch(() => {})}>Retry</button></Notice>}
      {account?.moderation && ready && <ModerationNotice moderation={account.moderation} />}
      {account?.integrity && ready && <IntegrityNotice />}
      {ready && alias && <fieldset className="settings" disabled={busy} aria-busy={busy}>
        <section className="panel" aria-label="Your standing">
          <div className="account-id">
            <Avatar alias={alias} size="lg" />
            <div><h2>{alias}</h2><p className="account-links"><button type="button" className="link-quiet" onClick={() => onProfile(alias)}>Public profile ↗</button><button type="button" className="link-quiet" onClick={onViewBoard}>Leaderboard ↗</button></p></div>
            <div className="actions push">{stats?.periods.week.tokens ? <span className="pill">Week <b>#{stats.periods.week.rank}</b></span> : null}{stats?.periods.month.tokens ? <span className="pill">Month <b>#{stats.periods.month.rank}</b></span> : null}</div>
          </div>
          {stats && (all
            ? <dl className="account-stats">
              <div><dt>Rank</dt><dd className="num">#{all.rank}</dd></div>
              <div><dt>Tokens</dt><dd className="num"><Tokens value={all.tokens} /></dd></div>
              <div><dt>Est. cost</dt><dd className="num">{formatCost(stats.costMicrousd)}</dd></div>
              <div><dt>Computers</dt><dd className="num">{account.devices.length}<span>/10</span></dd></div>
            </dl>
            : <p className="account-empty">No usage yet. Your totals appear after your first sync.{!account.devices.length && <a href="#computer">Connect a computer →</a>}</p>)}
        </section>
        <Setting id="listing" title="Your listing" text="How you appear on the leaderboard and your public profile.">
          <ProfileForm api={api} publication={account.publication} repair={Boolean(account.integrity)} onSaved={refreshAccount}>
            {neighbours.length > 0 && <div className="field">Preview · all time
              <ol className="board-preview">{neighbours.map((row) => <li key={row.alias} className={row.alias === alias ? 'is-you' : undefined}>
                <span className="num">{row.rank}</span><Avatar alias={row.alias} /><strong>{row.alias}{row.alias === alias && <span className="badge">You</span>}</strong><span className="num push"><Tokens value={row.tokens} /></span>
              </li>)}</ol>
            </div>}
          </ProfileForm>
        </Setting>
        <Setting id="computer" title="Computers" text="Each computer adds its daily totals to yours. Disconnecting one stops new uploads; past totals stay.">
          <div className="panel">{account.devices.length
            ? <ul className="rows">{account.devices.map((device) => <li key={device.id}><div className="device"><span className="device-icon"><LaptopIcon /></span><div><strong>{device.name}</strong><small>Synced {timeAgo(device.lastSeenAt)}</small></div></div><div className="actions"><button type="button" className="btn ghost sm" onClick={() => rename(device)}>Rename</button><button type="button" className="btn sm" onClick={() => void run(async () => { await api.revokeDevice(device.id); await refreshAccount(); })}>Disconnect</button></div></li>)}</ul>
            : <div className="empty">
              <span className="empty-icon"><LaptopIcon /></span>
              <strong>No computers connected</strong>
              <p>Open the Tokentracky app on your Mac and click <strong>Join the leaderboard</strong>.</p>
              <div className="actions"><MacDownload /><span className="faint">Up to 10 computers</span></div>
            </div>}</div>
        </Setting>
      </fieldset>}
      {/* Sign out stays reachable when the account could not be read or was just deleted. */}
      <Setting id="signin" title="Sign-in" text="How you get into this account. Never shown publicly.">
        <div className="panel"><ul className="rows">
          {identities.map((identity) => <li key={identity.provider}><div><strong>{PROVIDERS[identity.provider] ?? identity.provider}</strong>{identity.detail && <small>{identity.detail}</small>}</div><span className="badge green">Connected</span></li>)}
          <li><div><strong>Sign out</strong><small>Signs out of this browser. Your computer keeps syncing.</small></div><button type="button" className="btn sm" disabled={busy} onClick={signOut}>Sign out</button></li>
        </ul></div>
      </Setting>
      {ready && alias && <Setting id="badge" title="README badge" text="Show your standing on GitHub. It updates after every sync.">
        <BadgePicker alias={alias} />
      </Setting>}
      {ready && <Setting id="danger" title="Danger zone">
        <div className="panel danger-panel"><div className="panel-body danger-body">
          <p>Permanently deletes your account, connected computers and uploaded totals. History on your Mac stays. {account.moderation?.state === 'banned' ? 'The ban stays: this sign-in cannot rejoin the leaderboard. ' : ''}This can’t be undone.
            <small>Your sign-in identity and backups may persist for a time; see the <a href="/privacy">privacy policy</a>.</small></p>
          <button type="button" className="btn danger sm" disabled={busy} onClick={removeAccount}>Delete Tokentracky data</button>
        </div></div>
      </Setting>}
    </div>
  </div>;
}

const DEVICE_POLL_MS = 15_000;
/** Where the sticky header ends: a section is current once its top scrolls past this. */
const NAV_OFFSET = 96;

/** Onboarding step 2. The account lists the computer once the app's approval lands, so this re-reads it until one does. */
function ConnectMac({ alias, refreshAccount, onSkip }: { alias: string; refreshAccount: () => Promise<void>; onSkip: () => void }) {
  useEffect(() => {
    const timer = window.setInterval(() => void refreshAccount().catch(() => {}), DEVICE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return <>
    <p className="badge green onboard-saved"><CheckIcon />Saved as {alias}</p>
    <h1>Connect your Mac</h1>
    <p className="lead">The Mac app reads your usage locally and uploads only daily totals.</p>
    <div className="panel">
      <div className="panel-body">
        <ol className="howto">
          <li><span className="step-num">1</span><div><strong>Download Tokentracky</strong><small>{MAC_DOWNLOAD ? 'Use the button below.' : 'The Mac app is coming soon.'}</small></div></li>
          <li><span className="step-num">2</span><div><strong>Open it from the menu bar</strong><small>It lives at the top right of your screen.</small></div></li>
          <li><span className="step-num">3</span><div><strong>Click <span className="app-button">Join the leaderboard</span></strong><small>This connects the app to your account and starts syncing.</small></div></li>
        </ol>
        {MAC_DOWNLOAD && <MacDownload />}
      </div>
      <p className="panel-foot waiting-foot" role="status"><span className="dot wait" aria-hidden="true" />Waiting for your Mac…</p>
    </div>
    <button type="button" className="link-quiet onboard-skip" onClick={onSkip}>Skip for now — go to your account</button>
  </>;
}

function MacDownload() {
  return MAC_DOWNLOAD
    ? <a className="btn primary" href={MAC_DOWNLOAD} aria-label="Download Tokentracky for Apple Silicon"><AppleIcon />Download for Mac</a>
    : <span className="soon"><AppleIcon />Mac app coming soon</span>;
}

/** The settings sections; the current one is the last whose top has passed the header, or the last of all at the bottom of the page. */
function SectionNav({ named }: { named: boolean }) {
  const sections = SECTIONS.filter(([id]) => named || id === 'signin' || id === 'danger');
  const [current, setCurrent] = useState<string>(sections[0][0]);
  useEffect(() => {
    const ids = sections.map(([id]) => id);
    const update = () => {
      const bottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setCurrent((bottom ? ids : ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= NAV_OFFSET)).at(-1) ?? ids[0]);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [named]);
  return <nav className="snav" aria-label="Account sections">{sections.map(([id, label]) => <a key={id} href={`#${id}`} className={id === 'danger' ? 'danger' : undefined} aria-current={id === current ? 'location' : undefined}>{label}</a>)}
    <p className="faint"><LockIcon />Prompts, code and project names never leave your computer. Only daily totals are uploaded.</p></nav>;
}

const NEIGHBOUR_PAGE = 20;
type BadgeMetric = 'tokens' | 'rank' | 'cost';
type BadgePeriod = 'all' | 'month' | 'week';

/** The badge URL for a metric and window; the defaults (tokens, all time) add no query. */
export function badgeUrl(origin: string, alias: string, metric: BadgeMetric, period: BadgePeriod): string {
  const query = new URLSearchParams({ ...(metric === 'tokens' ? {} : { metric }), ...(period === 'all' ? {} : { period }) }).toString();
  return `${origin}/badge/${alias}.svg${query ? `?${query}` : ''}`;
}

/** The README card's address: 600×180, dark or light, in a window. */
export function cardUrl(origin: string, alias: string, theme: 'dark' | 'light', period: BadgePeriod): string {
  const query = new URLSearchParams({ ...(theme === 'dark' ? {} : { theme }), ...(period === 'all' ? {} : { period }) }).toString();
  return `${origin}/card/${alias}.svg${query ? `?${query}` : ''}`;
}

function BadgePicker({ alias }: { alias: string }) {
  const [kind, setKind] = useState<'badge' | 'card'>('badge');
  const [metric, setMetric] = useState<BadgeMetric>('tokens');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [period, setPeriod] = useState<BadgePeriod>('all');
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;
  const url = kind === 'badge' ? badgeUrl(origin, alias, metric, period) : cardUrl(origin, alias, theme, period);
  const markdown = `[![Tokentracky](${url})](${origin}/u/${alias}?ref=readme)`;
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); setCopied(false); };
  return <div className="panel panel-body">
    <div className="embed-preview"><img className={kind === 'badge' ? 'badge-preview' : 'card-preview'} src={url.slice(origin.length)} alt={`Tokentracky ${kind} for ${alias}`} /></div>
    <div className="actions">
      <Segmented label="Embed" value={kind} options={[{ value: 'badge', label: 'Badge' }, { value: 'card', label: 'Card' }]} onChange={change(setKind)} />
      {kind === 'badge'
        ? <Segmented label="Badge shows" value={metric} options={[{ value: 'tokens', label: 'Tokens' }, { value: 'rank', label: 'Rank' }, { value: 'cost', label: 'Est. cost' }]} onChange={change(setMetric)} />
        : <Segmented label="Card theme" value={theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={change(setTheme)} />}
      <Segmented label="Window" value={period} options={[{ value: 'all', label: 'All time' }, { value: 'month', label: 'This month' }, { value: 'week', label: 'This week' }]} onChange={change(setPeriod)} />
    </div>
    <div className="copy-row"><code>{markdown}</code><button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(markdown).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy'}</button></div>
  </div>;
}

/** Tells the member, and only the member, why their profile is not public. Reasons and thresholds are not shown. */
export function IntegrityNotice() {
  return <Notice tone="error">Your public profile is unavailable because its usage totals exceed the account limit. Correct the usage in your app and sync again, or save your listing below to reset its public totals before the next sync. Your local history is unchanged. This is a data error, not a ban. If it persists, contact <a href="/support">Support</a>.</Notice>;
}

export function ModerationNotice({ moderation }: { moderation: NonNullable<Account['moderation']> }) {
  if (moderation.state === 'banned') return <Notice tone="error">This account can no longer publish to the leaderboard. Your local data is not affected. Questions: <a href="/support">Support</a>.</Notice>;
  const days = moderation.days.map((day) => day === 'unknown' ? 'undated usage' : shortDay(day));
  const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : days[0];
  return <Notice>Your profile is hidden from public pages while we review unusual totals for {list}. Your local data is not affected. If this looks wrong, contact us through <a href="/support">Support</a>.</Notice>;
}

function Title({ children }: { children?: ReactNode }) {
  return <header className="page-title"><div><h1>Account</h1>{children ?? <p>How you appear on the public leaderboard</p>}</div></header>;
}

function Setting({ id, title, text, children }: { id?: string; title: string; text?: string; children: ReactNode }) {
  return <section id={id} className="setting"><div className="setting-copy"><h2>{title}</h2>{text && <p>{text}</p>}</div><div className="setting-body">{children}</div></section>;
}

function Icon({ children }: { children: ReactNode }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
function CheckIcon() { return <Icon><path d="M3.5 8.5l3 3 6-6.5" /></Icon>; }
function LockIcon() { return <Icon><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Icon>; }
function BarsIcon() { return <Icon><path d="M2.5 13.5h11M4.5 11V8M8 11V5M11.5 11V2.5" /></Icon>; }
function EyeOffIcon() { return <Icon><path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z" /><circle cx="8" cy="8" r="1.8" /><path d="M2.5 2.5l11 11" /></Icon>; }
function LaptopIcon() { return <Icon><rect x="3" y="3.5" width="10" height="7" rx="1" /><path d="M1.5 12.5h13" /></Icon>; }

export function GitHubIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>;
}
export function GoogleIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="#4285F4" d="M15.68 8.18c0-.57-.05-1.11-.15-1.64H8v3.1h4.3a3.68 3.68 0 0 1-1.6 2.41v2h2.58c1.51-1.39 2.4-3.44 2.4-5.87Z" /><path fill="#34A853" d="M8 16c2.16 0 3.97-.72 5.29-1.94l-2.58-2a4.8 4.8 0 0 1-7.15-2.52H.9v2.07A8 8 0 0 0 8 16Z" /><path fill="#FBBC05" d="M3.56 9.54a4.8 4.8 0 0 1 0-3.08V4.39H.9a8 8 0 0 0 0 7.22l2.66-2.07Z" /><path fill="#EA4335" d="M8 3.18c1.21 0 2.3.42 3.16 1.24l2.3-2.3A8 8 0 0 0 .9 4.39l2.66 2.07A4.77 4.77 0 0 1 8 3.18Z" /></svg>;
}
