import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SourceStatus } from '@tokentracky/core';
import type { ApiClient, Health, LocalStatus } from '../api';
import { personalFixtures } from './personal-fixtures';
import { SettingsPage, sourceLine, updateLine } from './SettingsView';

const f = personalFixtures();
const health: Health = { mode: 'local', authConfigured: false, version: '1.0.0', cloudUrl: 'https://tokentracky.example', supabaseUrl: null, supabaseAnonKey: null };
const page = (overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}) => renderToStaticMarkup(<SettingsPage api={{} as ApiClient} health={health} status={f.status} refresh={async () => {}}
  shell={f.shell} onShell={() => {}} detected={f.detected} paused={false} onPaused={() => {}} {...overrides} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = (html: string, list: string) => [...(new RegExp(`<ul class="${list}">([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? '').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => text(match[1]!));

describe('SettingsPage', () => {
  it('lists every source except Cursor, in a fixed order, with its folder, status and switch', () => {
    const html = page();
    const rows = [...html.matchAll(/<div class="st-row st-src[^"]*">([\s\S]*?)<\/button><\/div><\/div>/g)].map((match) => match[1]!);
    expect(rows.map((row) => /<div class="st-row-label">([^<]+)</.exec(row)?.[1])).toEqual(['Claude Code', 'Codex', 'Gemini CLI', 'Cline', 'Roo Code', 'Kilo Code', 'OpenCode']);
    expect(rows[0]).toContain('~/.claude/projects');
    expect(text(rows[0]!)).toContain('Detected · 48,210 records');
    expect(rows[0]).toMatch(/role="switch" aria-checked="true" aria-label="Read Claude Code"/);
    expect(text(rows[5]!)).toContain('Not found');
    expect(rows[5]).toContain('Locate…');
    expect(rows[5]).toMatch(/role="switch" aria-checked="false"/);
    expect(html).not.toContain('>Cursor<');
    for (const label of ['Read-only collection.', 'Grant folder access…', 'Pause collection']) expect(html).toContain(label);
  });
  it('shows the Mac app rows only inside the Mac app', () => {
    const inApp = text(page());
    for (const label of ['Launch at login', 'Tokentracky 1.0.0', 'Automatic checks on', 'Check now', 'Quit Tokentracky']) expect(inApp).toContain(label);
    const cli = text(page({ shell: null }));
    for (const label of ['Launch at login', 'Check now', 'Quit Tokentracky', 'General', 'Updates']) expect(cli).not.toContain(label);
    expect(cli).toContain('Export CSV');
  });
  it('says exactly what joining shares and what never leaves this Mac', () => {
    const html = page();
    expect(items(html, 'st-yes')).toEqual(['All history: daily token totals', 'Tool split', 'Model mix', 'Estimated cost', 'Achievements computed from those totals', 'GitHub username, if you signed in with GitHub']);
    expect(items(html, 'st-no')).toEqual(['Projects', 'Prompts', 'Code', 'File paths']);
  });
  it('manages a linked Mac on the web, and only unlinks it here', () => {
    const html = page();
    expect(text(html)).toContain('example-builder');
    expect(html).toMatch(/href="https:\/\/tokentracky.example\/you" target="_blank" rel="noopener noreferrer"[^>]*>[\s\S]*?Manage on the web/);
    expect(text(html)).toContain('Unlink this Mac');
    expect(text(html)).not.toMatch(/Leave the leaderboard/i);
  });
  it('offers joining when this Mac is not linked, or no leaderboard when the build has none', () => {
    const unlinked: LocalStatus = { ...f.status, cloudLinked: false, alias: null };
    expect(text(page({ status: unlinked }))).toContain('Join the leaderboard');
    expect(text(page({ status: unlinked }))).not.toContain('Unlink this Mac');
    expect(text(page({ status: unlinked, health: { ...health, cloudUrl: null } }))).toContain('isn’t connected to a leaderboard');
  });
});

describe('sourceLine', () => {
  const source = (overrides: Partial<SourceStatus>): SourceStatus => ({ ...f.status.sources[0]!, ...overrides });
  it('reports a found source with its records, and one missing from its usual folder', () => {
    expect(sourceLine(source({}), true)).toEqual({ tone: 'ok', text: 'Detected · 48,210 records', found: true });
    expect(sourceLine(source({ enabled: false, eventCount: 0, state: 'detected' }), false)).toEqual({ tone: 'off', text: 'Not found', found: false });
    expect(sourceLine(source({ enabled: false, eventCount: 0, state: 'detected' }), true)).toEqual({ tone: 'off', text: 'Detected', found: true });
  });
  it('passes on what needs attention, and says when collection is paused', () => {
    expect(sourceLine(source({ state: 'permission_required', message: 'Grant access to ~/.claude' }), true)).toMatchObject({ tone: 'warn', text: 'Needs folder access', note: 'Grant access to ~/.claude' });
    expect(sourceLine(source({ state: 'error', message: '' }), true)).toMatchObject({ tone: 'warn', text: 'Needs attention' });
    expect(sourceLine(source({ state: 'paused' }), true)).toMatchObject({ tone: 'off', text: 'Paused' });
  });
});

describe('updateLine', () => {
  it('describes each update state', () => {
    expect(updateLine({ state: 'idle', version: null })).toBe('Automatic checks on');
    expect(updateLine({ state: 'available', version: '1.1.0' })).toBe('Version 1.1.0 is available. Choose Download v1.1.0 from the gear menu in the menu bar.');
    expect(updateLine({ state: 'available', version: null })).toBe('A new version is available. Choose Download from the gear menu in the menu bar.');
    expect(updateLine({ state: 'ready', version: '1.1.0' })).toBe('Version 1.1.0 is downloaded. Choose Restart to install v1.1.0 from the gear menu in the menu bar.');
    expect(updateLine({ state: 'disabled', version: null })).toBe('Updates are off in this build.');
  });
});
