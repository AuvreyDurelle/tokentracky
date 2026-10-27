import { useEffect, useState, type FormEvent } from 'react';
import type { ProfileStats } from '@tokentracky/core';
import { ApiError, type Account, type ApiClient, type DeviceAuthorization } from './api';
import type { AuthAdapter, AuthState } from './auth';
import { errorText, formatCompact } from './format';
import { Avatar, Loading, Notice, Spinner } from './ui';
import { IntegrityNotice, SignIn, useAliasTaken } from './Account';
import { badgeMarkdown } from './Profile';
import { CONNECT_NOTICE, publicationRequest, validAlias } from './publication';

export interface NameDraft { alias: string; typed: boolean }

/** The suggested name fills the field only until the member types in it. */
export function prefill(name: NameDraft, suggestion: string | null): NameDraft {
  return name.typed || !suggestion ? name : { alias: suggestion, typed: false };
}

/** Saves the publication with server defaults when there is none yet, then approves the computer. Returns the name it joins as. A failure approves nothing, so the code still works. */
export async function connectComputer(api: Pick<ApiClient, 'publication' | 'approveDevice'>, code: string, joined: string | null, alias: string): Promise<string> {
  const name = joined ?? (await api.publication(publicationRequest({ alias }))).publication.alias;
  await api.approveDevice(code);
  return name;
}

/** Hosted approval for `/?connect=CODE` in two steps: sign in, then name and connect. */
export function Connect({ api, auth, authState, account, accountLoading, accountError, refreshAccount, code, origin, onFinish, onProfile }: { api: ApiClient; auth: AuthAdapter; authState: AuthState; account: Account | null; accountLoading: boolean; accountError: string | null; refreshAccount: () => Promise<void>; code: string; origin: string; onFinish: () => void; onProfile: (alias: string) => void }) {
  const [request, setRequest] = useState<DeviceAuthorization | null>(null);
  const [state, setState] = useState<'review' | 'connecting' | 'gone'>('review');
  const [connected, setConnected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<NameDraft>({ alias: '', typed: false });
  const signedIn = authState === 'signed_in';
  const joined = account?.publication?.alias ?? null;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api.deviceAuthorization(code)
      .then((value) => { if (live) setRequest(value); })
      .catch((value: unknown) => { if (!live) return; if (value instanceof ApiError && value.status === 404) setState('gone'); else setError(errorText(value)); });
    return () => { live = false; };
  }, [api, code, signedIn]);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    auth.suggestedAlias().then((value) => { if (live) setName((current) => prefill(current, value)); }).catch(() => {});
    return () => { live = false; };
  }, [auth, signedIn]);
  const taken = useAliasTaken(api, name.alias, !joined);
  const connect = async (event: FormEvent) => {
    event.preventDefault(); setState('connecting'); setError(null);
    try {
      setConnected(await connectComputer(api, code, joined, name.alias));
    } catch (value) {
      if (value instanceof ApiError && value.status === 404) setState('gone');
      else { setError(errorText(value)); setState('review'); }
    }
    // The publication may be saved even when approval failed; a retry then only approves.
    await refreshAccount().catch(() => {});
  };
  const done = connected ?? (request?.approved ? joined : null);

  let body;
  if (done) body = <Connected api={api} alias={done} origin={origin} onFinish={onFinish} onProfile={onProfile} />;
  else if (state === 'gone') body = <>
    <h1>This code has expired</h1>
    <p className="lead">Codes last 10 minutes and work once. Go back to the app and click <strong>Join the leaderboard</strong> again.</p>
    <button type="button" className="btn lg" onClick={onFinish}>View the leaderboard</button>
  </>;
  else if (authState === 'loading' || (signedIn && accountLoading)) body = <Loading>Checking your account…</Loading>;
  else if (authState === 'unavailable' || authState === 'error') body = <>
    <h1>Sign-in is unavailable</h1>
    <p className="lead">{authState === 'error' ? 'We couldn’t confirm your sign-in. Check your connection and reload this page.' : 'This server has no account sign-in configured.'}</p>
  </>;
  else if (authState === 'signed_out') body = <>
    <Waiting code={code} />
    <h1>Join the leaderboard</h1>
    <p className="lead">Sign in to connect your computer. It takes about a minute.</p>
    <SignIn auth={auth} />
  </>;
  else if (accountError) body = <Notice tone="error">Could not load your account: {accountError} <button type="button" className="btn sm" onClick={() => void refreshAccount().catch(() => {})}>Retry</button></Notice>;
  else body = <form className="form" onSubmit={(event) => void connect(event)}>
    <div>
      <Waiting code={code} />
      <h1>{joined ? 'Connect this computer' : 'Name and connect'}</h1>
      <p className="lead" style={{ marginBottom: 0 }}>Check that this code matches the one in your Tokentracky app.</p>
    </div>
    <div className="code">{request?.userCode ?? code}</div>
    {account?.integrity && <><IntegrityNotice /><a href="/you">Open your account to repair the listing</a></>}
    {!joined && <label className="field">Leaderboard name
      <input className="input" value={name.alias} onChange={(event) => setName({ alias: event.target.value, typed: true })} maxLength={30} autoComplete="nickname" placeholder="e.g. token-wizard" aria-describedby="name-hint" required />
      <small id="name-hint" role="status">{taken === true ? 'Taken. Choose another name.' : taken === false ? 'Looks available.' : taken === undefined ? 'Checking…' : '3–30 letters, numbers, - or _. Shown publicly; never your email.'}</small>
    </label>}
    {request ? <dl className="kv">
      <div><dt>Computer</dt><dd>{request.deviceName}</dd></div>
      {joined && <div><dt>Joins as</dt><dd>{joined}</dd></div>}
    </dl> : !error && <Loading>Looking up this code…</Loading>}
    {request && <Notice>{request.replaces
      ? <>This computer was connected before as <strong>{request.replaces}</strong>. It replaces that connection and re-syncs its totals.</>
      : 'This computer adds its totals to those of your other computers.'}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    <p className="faint" style={{ fontSize: 12 }}>{CONNECT_NOTICE}</p>
    <div className="actions"><button className="btn primary lg" disabled={!request || state === 'connecting' || (!joined && !validAlias(name.alias))}>{state === 'connecting' ? <><Spinner /> Connecting…</> : 'Connect'}</button><button type="button" className="btn ghost" onClick={onFinish}>Cancel</button></div>
  </form>;

  const step = signedIn ? 2 : 1;
  return <section className="auth-page"><div className="panel auth-card">
    {!done && state !== 'gone' && <ol className="stepper" aria-label={`Step ${step} of 2`}>{['Sign in', 'Name and connect'].map((label, index) =>
      <li key={label} className={index + 1 < step ? 'done' : index + 1 === step ? 'current' : undefined} aria-current={index + 1 === step ? 'step' : undefined}><span className="num">{index + 1}</span>{label}</li>)}</ol>}
    {body}
  </div></section>;
}

function Waiting({ code }: { code: string }) {
  return <p className="waiting"><span className="dot" aria-hidden="true" />Your app is waiting with code <strong className="num">{code}</strong></p>;
}

const POLL_MS = 15_000;

/** Done: the member's own board row, filled once the app's first upload lands, and the README badge. */
function Connected({ api, alias, origin, onFinish, onProfile }: { api: ApiClient; alias: string; origin: string; onFinish: () => void; onProfile: (alias: string) => void }) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    let timer = 0;
    const poll = () => {
      api.profileStats(alias)
        .then((value) => { if (!live) return; setStats(value); if (!value.periods.all.tokens) timer = window.setTimeout(poll, POLL_MS); })
        .catch(() => { if (live) timer = window.setTimeout(poll, POLL_MS); });
    };
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, alias]);
  const all = stats?.periods.all.tokens ? stats.periods.all : null;
  const week = stats?.periods.week.tokens ? stats.periods.week : null;
  const markdown = badgeMarkdown(origin, alias);
  return <>
    <div className="success-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
    <h1>You’re on the board</h1>
    <p className="lead">Head back to the Tokentracky app; it finishes on its own. Your tokens appear after its first sync.</p>
    <div className="you-row" role="status">
      {all ? <span className="num you-rank">{all.rank}</span> : null}
      <Avatar alias={alias} />
      <div className="you-name">
        <strong><span>{alias}</span> <span className="badge">You</span></strong>
        {!all && <span className="faint"><Spinner /> Waiting for the first sync…</span>}
      </div>
      {all && <span className="num you-total">{formatCompact(all.tokens)}</span>}
    </div>
    {all && <div className="actions"><span className="pill">All time <b>#{all.rank}</b></span>{week && <span className="pill">This week <b>#{week.rank}</b></span>}</div>}
    <div className="done-actions">
      <button type="button" className="btn primary lg" onClick={onFinish}>See yourself on the leaderboard</button>
      <button type="button" className="btn lg" onClick={() => onProfile(alias)}>View your profile</button>
    </div>
    <div className="field" style={{ marginTop: 24 }}>Add the badge to your README
      <div className="copy-row"><code>{markdown}</code><button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(markdown).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy'}</button></div>
    </div>
  </>;
}
