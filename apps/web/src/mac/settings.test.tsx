import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProfileStats, SourceStatus } from '@tokentracky/core';
import type { ApiClient, Health, LocalStatus, ShellState } from '../api';
import { MachineContext, machine } from './machine';
import { personalFixtures } from './personal-fixtures';
import { Account, SettingsPage, menuBarTitle, sourceLine, updateLine } from './SettingsView';

const f = personalFixtures();
const health: Health = { mode: 'local', authConfigured: false, version: '1.0.0', cloudUrl: 'https://tokentracky.example', supabaseUrl: null, supabaseAnonKey: null };
/** The page as the app on `platform` shows it (macOS by default), with the words the root gives every page. */
const page = (overrides: Partial<Parameters<typeof SettingsPage>[0]> = {}, platform: ShellState['platform'] = 'macos') => {
  const shell = overrides.shell === undefined ? { ...f.shell, platform } : overrides.shell;
  return renderToStaticMarkup(<MachineContext.Provider value={machine(shell)}><SettingsPage api={{} as ApiClient} health={health} status={f.status} refresh={async () => {}}
    onShell={() => {}} detected={f.detected} paused={false} onPaused={() => {}} {...overrides} shell={shell} /></MachineContext.Provider>);
};
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
  it("names its sections as the mockup does, with Clubs and Account only for a linked Mac", () => {
    const nav = (html: string) => [...html.matchAll(/<button type="button" class="st-nav-item[^"]*"[^>]*><svg[\s\S]*?<\/svg>([^<]+)/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));
    expect(nav(page())).toEqual(['General', 'Sources', 'Leaderboard & privacy', 'Clubs', 'Menu bar', 'Pricing & data', 'Updates', 'Account']);
    expect(nav(page({ status: { ...f.status, cloudLinked: false, alias: null } }))).not.toContain('Account');
    expect(nav(page({ status: { ...f.status, cloudLinked: false, alias: null } }))).not.toContain('Clubs');
    expect(nav(page({ shell: null }))).toEqual(['Sources', 'Leaderboard & privacy', 'Clubs', 'Pricing & data', 'Account']);
  });
  it('names the price table it prices with', () => {
    expect(text(page())).toContain('Price table');
    expect(text(page())).toContain('Version litellm-2026-10-25');
    expect(text(page({ status: { ...f.status, pricingVersion: 'litellm:3f2a9c01be44' } }))).toContain('Version 3f2a9c01be44');
  });
  it('says how the account signed in and when it joined, and sends deleting to the website', () => {
    const account = (githubLogin?: string) => text(renderToStaticMarkup(<Account health={health} status={f.status} busy={null} unlink={() => {}}
      profile={{ ...({} as ProfileStats), alias: 'example-builder', memberSince: '2026-01-12', githubLogin }} />));
    expect(account('example')).toMatch(/example-builder Signed in with GitHub · joined Jan 12, 2026 · synced/);
    expect(account()).toMatch(/example-builder Joined Jan 12, 2026 · synced/);
    expect(renderToStaticMarkup(<Account health={health} status={f.status} profile={null} busy={null} unlink={() => {}} />)).toContain('href="https://tokentracky.example/you#danger"');
  });
  it('names the computer and where the icon sits as the app’s system does, and stays as it was on a Mac', () => {
    const settings = { menuBar: 'tokens', menuBarPeriod: 'today', priceRefresh: true } as const;
    const mac = text(page({ settings }));
    for (const words of ['Start Tokentracky in the menu bar when you sign in to your Mac.', 'The file is saved on this Mac.', 'Never leaves this Mac', 'Unlink this Mac', 'Stops uploads from this Mac.', 'Usage on this Mac is kept.', 'Show in the menu bar']) expect(mac).toContain(words);
    const pc = text(page({ settings }, 'windows'));
    for (const words of ['Start Tokentracky in the tray when you sign in to your PC.', 'The file is saved on this PC.', 'Never leaves this PC', 'Unlink this PC', 'Stops uploads from this PC.', 'Usage on this PC is kept.', 'Show in the tray']) expect(pc).toContain(words);
    const linux = text(page({ settings }, 'linux'));
    for (const words of ['Start Tokentracky in the tray when you sign in to your computer.', 'Never leaves this computer', 'Unlink this computer', 'Show in the tray']) expect(linux).toContain(words);
    // The CLI's dashboard has no app shell: a computer, and none of the app's rows.
    const cli = text(page({ shell: null }));
    for (const words of ['The file is saved on this computer.', 'Never leaves this computer', 'Unlink this computer']) expect(cli).toContain(words);
    for (const page of [pc, linux, cli]) expect(page).not.toMatch(/Mac|menu bar/);
  });
  it('titles the icon’s section after the menu bar on a Mac and the tray elsewhere', () => {
    const nav = (html: string) => [...html.matchAll(/<button type="button" class="st-nav-item[^"]*"[^>]*><svg[\s\S]*?<\/svg>([^<]+)/g)].map((match) => match[1]!);
    expect(nav(page())).toContain('Menu bar');
    expect(nav(page({}, 'windows'))).toContain('Tray');
    expect(page({ settings: { menuBar: 'icon', menuBarPeriod: 'today', priceRefresh: true } }, 'linux')).toContain('<h2 id="st-menubar-title">Tray</h2>');
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
  it('counts its sessions in all history when they are known', () => {
    expect(sourceLine(source({}), true, 1284).text).toBe('Detected · 1,284 sessions');
    expect(sourceLine(source({}), true, 1).text).toBe('Detected · 1 session');
    expect(sourceLine(source({}), true, 0).text).toBe('Detected · 48,210 records');
    expect(text(page({ sessions: new Map([['claude', 1284], ['codex', 807]]) }))).toContain('5 of 7 found · 5 on · 2,091 sessions');
  });
  it('passes on what needs attention, and says when collection is paused', () => {
    expect(sourceLine(source({ state: 'permission_required', message: 'Grant access to ~/.claude' }), true)).toMatchObject({ tone: 'warn', text: 'Needs folder access', note: 'Grant access to ~/.claude' });
    expect(sourceLine(source({ state: 'error', message: '' }), true)).toMatchObject({ tone: 'warn', text: 'Needs attention' });
    expect(sourceLine(source({ state: 'paused' }), true)).toMatchObject({ tone: 'off', text: 'Paused' });
  });
});

describe('updateLine', () => {
  it('describes each update state', () => {
    expect(updateLine({ state: 'idle', version: null }, 'menu bar')).toBe('Automatic checks on');
    expect(updateLine({ state: 'available', version: '1.1.0' }, 'menu bar')).toBe('Version 1.1.0 is available. Choose Download v1.1.0 from the gear menu in the menu bar.');
    expect(updateLine({ state: 'available', version: null }, 'menu bar')).toBe('A new version is available. Choose Download from the gear menu in the menu bar.');
    expect(updateLine({ state: 'ready', version: '1.1.0' }, 'menu bar')).toBe('Version 1.1.0 is downloaded. Choose Restart to install v1.1.0 from the gear menu in the menu bar.');
    expect(updateLine({ state: 'ready', version: '1.1.0' }, 'tray')).toBe('Version 1.1.0 is downloaded. Choose Restart to install v1.1.0 from the gear menu in the tray.');
    expect(updateLine({ state: 'disabled', version: null }, 'menu bar')).toBe('Updates are off in this build.');
  });
});

describe('menuBarTitle', () => {
  // The same cases as apps/mac/src/menu.rs, so the preview shows what the menu bar will.
  const overview = { ...f.overview, today: 1_234_567, week: 8_400_000, month: 20_149_999, allTime: 120e9, costs: { today: 64_800_000, week: 729_000_000, month: 2_394_000_000, allTime: null } };
  it("titles the chosen period with its tokens or cost, or just the icon", () => {
    expect(menuBarTitle(overview, { menuBar: 'tokens', menuBarPeriod: 'today', priceRefresh: true })).toBe('1.2M');
    expect(menuBarTitle(overview, { menuBar: 'tokens', menuBarPeriod: 'week', priceRefresh: true })).toBe('8.4M');
    expect(menuBarTitle(overview, { menuBar: 'tokens', menuBarPeriod: 'all', priceRefresh: true })).toBe('120B');
    expect(menuBarTitle(overview, { menuBar: 'cost', menuBarPeriod: 'today', priceRefresh: true })).toBe('$64.80');
    expect(menuBarTitle(overview, { menuBar: 'cost', menuBarPeriod: 'month', priceRefresh: true })).toBe('$2.4K');
    expect(menuBarTitle(overview, { menuBar: 'icon', menuBarPeriod: 'today', priceRefresh: true })).toBe('');
    expect(menuBarTitle(overview, { menuBar: 'cost', menuBarPeriod: 'all', priceRefresh: true })).toBe('120B');
    expect(menuBarTitle({ ...overview, costs: { ...overview.costs, today: 999_995_000 } }, { menuBar: 'cost', menuBarPeriod: 'today', priceRefresh: true })).toBe('$1K');
  });
  it('switches the daily price download and says when the table in use was fetched', () => {
    const html = text(page({ settings: { menuBar: 'tokens', menuBarPeriod: 'today', priceRefresh: false } }));
    expect(html).toContain('Refresh price table daily');
    expect(html).toMatch(/Updated \d+h ago · version litellm-2026-10-25/);
    expect(page({ settings: { menuBar: 'tokens', menuBarPeriod: 'today', priceRefresh: false } })).toMatch(/role="switch" aria-checked="false" aria-label="Refresh price table daily"/);
  });
  it('shows the choices and the item as it looks now, only in the Mac app', () => {
    const html = page({ overview, settings: { menuBar: 'cost', menuBarPeriod: 'today', priceRefresh: true } });
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">Cost<\/button>/);
    expect(html).toContain('<span class="st-mb-item"><span class="brand-mark"></span>$64.80</span>');
    expect(page({ overview, settings: { menuBar: 'cost', menuBarPeriod: 'today', priceRefresh: true }, shell: null })).not.toContain('st-mb-item');
  });
});
