import { useEffect, useRef, useState } from 'react';
import type { SourceStatus, ToolId } from '@tokentracky/core';
import { ApiError, type ApiClient, type ConnectStart, type DetectedTool, type LocalStatus } from './api';
import { errorText, formatCompact } from './format';
import type { DayRange, HourWindow } from './ranges';
import { Modal, Notice } from './ui';

/** Saves the range's usage as a CSV, named for its UTC days (or as the last 24 hours) unless given a name. */
export async function downloadCsv(api: ApiClient, range: DayRange | HourWindow, tool: 'all' | ToolId, name = 'since' in range ? 'tokentracky-last-24-hours.csv' : `tokentracky-${range.from}-to-${range.to}.csv`) {
  const blob = await api.exportCsv(range, tool);
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); URL.revokeObjectURL(link.href);
}

/** Choose a tool's log folders; saving turns it on and refreshes. */
export function FolderModal({ api, source, sources, refresh, onClose }: { api: ApiClient; source: SourceStatus; sources: SourceStatus[]; refresh: () => Promise<void>; onClose: () => void }) {
  const [id, setId] = useState<ToolId>(source.id);
  const [paths, setPaths] = useState(source.paths.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.updateSource(id, { enabled: true, paths: paths.split('\n').map((path) => path.trim()).filter(Boolean) }); await api.refresh(); await refresh(); onClose(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  return <Modal title="Choose log folders" onClose={onClose}>
    <div className="form">
      {sources.length > 1 && <label className="field">Tool<select className="input select" value={id} onChange={(event) => { const next = event.target.value as ToolId; setId(next); setPaths(sources.find((item) => item.id === next)?.paths.join('\n') ?? ''); }}>
        {sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <label className="field">Folders, one per line<textarea className="input" rows={4} value={paths} onChange={(event) => setPaths(event.target.value)} /><small>Absolute paths. Saving turns tracking on for this tool and refreshes.</small></label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save and refresh'}</button><button type="button" className="btn ghost" onClick={onClose}>Cancel</button></div>
    </div>
  </Modal>;
}

export type ConnectFlow = { step: 'idle' } | { step: 'starting' } | { step: 'waiting'; start: ConnectStart } | { step: 'expired' };

/** Linking this computer: `start` opens the browser's sign-in and approval page, then polling finishes by itself and refreshes. */
export function useConnectFlow(api: ApiClient, refresh: () => Promise<void>) {
  const [flow, setFlow] = useState<ConnectFlow>({ step: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (flow.step !== 'waiting') return;
    let live = true;
    const timer = window.setInterval(() => {
      api.connectPoll().then(async (result) => {
        if (!live || result.status === 'pending') return;
        if (result.status === 'expired') { setFlow({ step: 'expired' }); return; }
        setFlow({ step: 'idle' }); await refreshRef.current();
      }).catch((value: unknown) => {
        if (!live) return;
        if (value instanceof ApiError && value.code === 'CONNECT_NOT_STARTED') setFlow({ step: 'expired' });
        else setError(errorText(value));
      });
    }, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [api, flow]);
  const start = async () => {
    setError(null); setFlow({ step: 'starting' });
    try {
      const next = await api.connectStart();
      setFlow({ step: 'waiting', start: next });
      window.open(next.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (value) { setFlow({ step: 'idle' }); setError(errorText(value)); }
  };
  return { flow, setFlow, error, setError, start };
}

const supported = (status: LocalStatus | null) => status?.sources.filter((source) => source.state !== 'unsupported') ?? [];

const names = (items: SourceStatus[]) => items.length > 1 ? `${items.slice(0, -1).map((item) => item.name).join(', ')} and ${items.at(-1)!.name}` : items[0]?.name ?? '';

/** The setup panel's heading. Once the first run has read the tools it turned on: their all-time total, or that they have no usage yet. */
export function setupHeading(status: LocalStatus, detected: DetectedTool[] | null): string {
  const found = supported(status).filter((source) => detected?.some((tool) => tool.id === source.id));
  const tracked = found.filter((source) => source.enabled);
  if (detected === null || (status.firstRun && !status.lastRefreshAt)) return 'Looking for your AI coding tools…';
  if (status.firstRun && tracked.length) return status.firstRun.tokens ? `Found ${formatCompact(status.firstRun.tokens)} Tokens used` : `No usage yet in ${names(tracked)}`;
  return found.length ? `Found ${names(found)} on this Mac` : 'No supported tools found in their usual folders';
}
