import { useId } from 'react';
import type { ApiClient, Health, LocalStatus } from '../api';
import { Spinner } from '../ui';
import { useConnectFlow } from '../You';
import { ProfileDialog } from './ProfileModal';
import './personal.css';

/** Whether the dashboard asks to join, decided once per window from its first status: a Mac that isn't linked, in a build with a leaderboard server. Null until that status loads. */
export const askToJoin = (asked: boolean | null, health: Health, status: LocalStatus | null) => asked ?? (status ? !status.cloudLinked && !!health.cloudUrl : null);

/** Asks a builder tracking privately to join the leaderboard, each time the dashboard opens. Join starts the browser sign-in from here; linking closes it. */
export function JoinPrompt({ api, refresh, onClose }: { api: ApiClient; refresh: () => Promise<void>; onClose: () => void }) {
  const headingId = useId();
  const { flow, setFlow, error, start } = useConnectFlow(api, refresh);
  return <ProfileDialog labelledBy={headingId} onClose={onClose}>
    <div className="pf-cover" />
    <div className="jp">
      <h2 className="jp-title" id={headingId}>See where you rank</h2>
      <p className="jp-sub">Join the leaderboard to put your tokens up against other builders. Sign in with GitHub or email in your browser; it takes about 30 seconds.</p>
      <p className="jp-note">Projects, prompts and code never leave this Mac.</p>
      {flow.step === 'waiting'
        ? <div className="jp-wait">
          <span className="st-code" aria-label={`Connection code ${flow.start.userCode}`}>{flow.start.userCode}</span>
          <span className="st-waiting"><Spinner />Approve this code in your browser…</span>
        </div>
        : (flow.step === 'expired' || error) && <p className="jp-error">{flow.step === 'expired' ? 'That code expired. Start again to get a new one.' : error}</p>}
      <div className="jp-actions">
        {flow.step === 'waiting'
          ? <><a className="m-btn primary" href={flow.start.verificationUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a><button type="button" className="m-btn ghost" onClick={() => setFlow({ step: 'idle' })}>Cancel</button></>
          : <><button type="button" className="m-btn primary" disabled={flow.step === 'starting'} onClick={() => void start()}>{flow.step === 'starting' ? <><Spinner /> Opening browser…</> : 'Join the leaderboard'}</button><button type="button" className="m-btn ghost" onClick={onClose}>Not now</button></>}
      </div>
    </div>
  </ProfileDialog>;
}
