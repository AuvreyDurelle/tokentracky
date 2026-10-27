import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolId } from '@tokentracky/core';
import type { ApiClient } from './api';

export function Notice({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'error' | 'success' }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined}>{children}</div>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}
export function Loading({ children }: { children: ReactNode }) { return <p className="loading" role="status">{children}</p>; }
export function Spinner() { return <span className="spinner" aria-hidden="true" />; }
/** A stable hue per alias, so the same builder always gets the same gradient. */
export function avatarHue(alias: string): number {
  let hash = 0;
  for (const char of alias.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
export function Avatar({ alias, size }: { alias: string; size?: 'lg' }) {
  const hue = avatarHue(alias);
  return <span className={`avatar${size ? ` ${size}` : ''}`} aria-hidden="true" style={{ background: `linear-gradient(135deg, hsl(${hue} 80% 74%), hsl(${hue} 72% 32%))` }}>{alias.slice(0, 2).toUpperCase()}</span>;
}
/** A builder's all-time rank; null while it loads and for anyone without one (nothing synced yet, or hidden for review). */
export function useRank(api: ApiClient, alias: string | null): number | null {
  const [rank, setRank] = useState<number | null>(null);
  useEffect(() => {
    setRank(null);
    if (!alias) return;
    let live = true;
    api.profile(alias, 'all').then((value) => { if (live) setRank(value.rank); }).catch(() => {});
    return () => { live = false; };
  }, [api, alias]);
  return rank;
}
export function ToolIcon({ id }: { id: ToolId }) { return <i className={`tool-ic ic-${id}`} aria-hidden="true" />; }
export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div className="meter" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}><i style={{ width: `${percent}%` }} /></div>;
}
export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map((option) => <button key={String(option.value)} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialogRef} className="modal" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
        .filter((element) => !element.matches(':disabled, [tabindex="-1"]') && element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header><h2>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label={`Close ${title}`}>×</button></header>{children}
  </dialog>;
}

/** The command palette's shortcut, as this platform writes it. */
export const JUMP_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
export function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.6" /><path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

export function AppleIcon() {
  return <svg width="13" height="15" viewBox="0 0 13 15" fill="currentColor" aria-hidden="true"><path d="M10.6 8c0-1.9 1.6-2.8 1.6-2.9-.9-1.3-2.2-1.4-2.7-1.5-1.1-.1-2.2.7-2.8.7-.6 0-1.5-.7-2.4-.6-1.3 0-2.4.7-3 1.8-1.3 2.3-.3 5.6.9 7.4.6.9 1.3 1.9 2.3 1.8.9 0 1.3-.6 2.4-.6 1.1 0 1.4.6 2.4.6 1 0 1.6-.9 2.2-1.8.7-1 1-2 1-2.1 0 0-1.9-.7-1.9-2.8ZM8.9 2.4c.5-.6.8-1.4.7-2.2-.7 0-1.6.5-2.1 1.1-.5.5-.9 1.4-.8 2.2.8.1 1.7-.4 2.2-1.1Z" /></svg>;
}

/** A terminal command with a copy button. */
export function CopyCommand({ text, label = 'Copy command' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => {}); };
  return <div className="cmd"><code><span className="cmd-prompt" aria-hidden="true">$ </span>{text}</code>
    <button type="button" className="btn ghost sm" onClick={copy} aria-label={label}>{copied ? 'Copied' : 'Copy'}</button></div>;
}
