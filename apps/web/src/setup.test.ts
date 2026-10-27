import { describe, expect, it } from 'vitest';
import type { SourceStatus, ToolId } from '@tokentracky/core';
import type { DetectedTool, LocalStatus } from './api';
import { setupHeading } from './You';

const source = (id: ToolId, name: string, enabled: boolean): SourceStatus => ({
  id, name, enabled, state: enabled ? 'current' : 'permission_required', paths: [], lastImportedAt: null, eventCount: 0, message: '',
  capabilities: { tokens: true, models: true, projects: true, costs: false, quotas: false },
});
/** Claude Code and Codex on or off; Gemini CLI is not installed. */
const status = (extra: Partial<LocalStatus>, enabled = true): LocalStatus => ({
  sources: [source('claude', 'Claude Code', enabled), source('codex', 'Codex', enabled), source('gemini', 'Gemini CLI', false)],
  collecting: false, lastScanAt: null, cloudLinked: false, ...extra,
});
const detected: DetectedTool[] = [{ id: 'claude', name: 'Claude Code', paths: ['/home/.claude/projects'] }, { id: 'codex', name: 'Codex', paths: ['/home/.codex/sessions'] }];
const refreshed = '2026-10-25T12:00:00.000Z';

describe('setup panel heading', () => {
  it('reports the all-time total, without tool names, once the first run has read the tools it turned on', () => {
    expect(setupHeading(status({ firstRun: { tokens: 42_800_000 }, lastRefreshAt: refreshed }), detected)).toBe('Found 42.8M Tokens used');
  });
  it('names the tools turned on when they have no usage yet', () => {
    expect(setupHeading(status({ firstRun: { tokens: 0 }, lastRefreshAt: refreshed }), detected)).toBe('No usage yet in Claude Code and Codex');
    const codexOff = status({ firstRun: { tokens: 0 }, lastRefreshAt: refreshed });
    codexOff.sources[1] = source('codex', 'Codex', false);
    expect(setupHeading(codexOff, detected)).toBe('No usage yet in Claude Code');
  });
  it('is still looking until detection answers and the first cycle has run', () => {
    expect(setupHeading(status({}), null)).toBe('Looking for your AI coding tools…');
    expect(setupHeading(status({ firstRun: { tokens: 0 } }), detected)).toBe('Looking for your AI coding tools…');
  });
  it('keeps the message for no tools found, and names found tools that are all off', () => {
    expect(setupHeading(status({}, false), [])).toBe('No supported tools found in their usual folders');
    expect(setupHeading(status({}, false), detected)).toBe('Found Claude Code and Codex on this Mac');
  });
});
