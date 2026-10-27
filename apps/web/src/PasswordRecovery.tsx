import { useState, type FormEvent } from 'react';
import type { AuthAdapter } from './auth';
import { errorText } from './format';
import { Notice, Spinner } from './ui';

export function PasswordResetRequest({ auth, initialEmail, onBack }: { auth: AuthAdapter; initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try { await auth.requestPasswordReset(email); setSent(true); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };
  return <div className="signin">
    {sent ? <Notice tone="success">If an account exists for that email, you’ll receive a password-reset link. Check your inbox and spam folder.</Notice>
      : <form className="form" onSubmit={(event) => void submit(event)}>
        <label className="field">Email<input className="input" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button className="btn primary" disabled={busy}>{busy && <Spinner />}Send reset link</button>
      </form>}
    {error && <Notice tone="error">{error}</Notice>}
    <button type="button" className="link" disabled={busy} onClick={onBack}>Back to sign in</button>
  </div>;
}

export function PasswordRecovery({ auth, onComplete }: { auth: AuthAdapter; onComplete: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try { await auth.updateRecoveredPassword(password); setPassword(''); setConfirmation(''); setSaved(true); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true); setError(null);
    try { await onComplete(); } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  return <section className="panel">
    <header className="panel-head"><h1>Reset your password</h1></header>
    <div className="panel-body">
      {saved ? <><Notice tone="success">Your password has been updated.</Notice><button className="btn primary" disabled={busy} onClick={() => void finish()}>Continue</button></>
        : <form className="form" onSubmit={(event) => void submit(event)}>
          <label className="field">New password<input className="input" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <label className="field">Confirm new password<input className="input" type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <button className="btn primary" disabled={busy}>{busy && <Spinner />}Save password</button>
        </form>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  </section>;
}
