import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addDays } from '../ranges';
import { personalFixtures } from './personal-fixtures';
import { PopoverPanel, latestSessions, streakOf } from './Popover';

const f = personalFixtures();
const noop = () => {};
const panel = (overrides: Partial<Parameters<typeof PopoverPanel>[0]> = {}) => renderToStaticMarkup(<PopoverPanel overview={f.overview} recent={f.recent} month={f.month} sessions={f.sessions} status={f.status}
  today={f.today} busy={null} error={null} onGear={noop} onOpen={noop} onSessions={noop} onRefresh={noop} onPause={noop} {...overrides} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('PopoverPanel', () => {
  it("leads with today's compact total and cost, under who you are and your rank", () => {
    const html = text(panel());
    expect(html).toMatch(/^EX example-builder #42 this week/);
    expect(html).toContain('186.4M tokens');
    expect(html).toMatch(/\$\d[\d,.]* est\. cost/);
  });
  it('charts the last 14 days with today lit', () => {
    const bars = [.../<div class="po-bars"[^>]*>([\s\S]*?)<\/div>/.exec(panel())![1]!.matchAll(/<i[^>]*>/g)].map((match) => match[0]);
    expect(bars).toHaveLength(14);
    expect(bars.at(-1)).toContain('class="now"');
    expect(bars.slice(0, -1).some((bar) => bar.includes('now'))).toBe(false);
  });
  it('lists this week, this month and all time from the overview', () => {
    const rows = [...panel().matchAll(/<div class="po-prow">([\s\S]*?)<\/div>/g)].map((match) => text(match[1]!));
    expect(rows).toEqual(['This week 2.1B', 'This month 6.9B', 'All time 18.4B']);
  });
  it("shows this month's tool mix, the streak and its seven weeks", () => {
    const html = panel();
    expect(text(html)).toContain('Claude Code 64%');
    expect(text(html)).toContain('34-day streak');
    expect(html.match(/<i class="l\d( today)?"/g)).toHaveLength(49);
    expect(html.match(/class="l[1-4] today"/g)).toHaveLength(1);
  });
  it('shows the three latest sessions with their tool, model, age and tokens', () => {
    const rows = [...panel().matchAll(/<div class="po-session">([\s\S]*?<span class="po-tok"[^>]*>[^<]*<\/span>)<\/div>/g)].map((match) => match[1]!);
    expect(rows).toHaveLength(3);
    expect(text(rows[0]!)).toBe('usage-dashboard claude-opus-5-5 · 4m ago 38.2M');
    expect(rows[1]).toContain('ic-codex');
  });
  it('ends with the sync state and the three actions', () => {
    const html = text(panel());
    expect(html).toContain('Synced 2m ago · Collecting');
    expect(html).toContain('5 sources');
    expect(html).toMatch(/Open dashboard Refresh now Pause$/);
    const paused = text(panel({ overview: { ...f.overview, paused: true } }));
    expect(paused).toContain('· Paused');
    expect(paused).toMatch(/Resume$/);
    expect(text(panel({ status: { ...f.status, collecting: false } }))).toContain('· Not tracking');
  });
});

describe('streakOf', () => {
  const days = (active: number[], today: string) => active.map((back) => ({ day: addDays(today, -back), tokens: 5, costMicrousd: 0 }));
  it('dates a streak from its first day, counting yesterday while today is still quiet', () => {
    expect(streakOf(3, days([0, 1, 2], '2026-10-25'), '2026-10-25')).toEqual({ days: 3, atLeast: false, since: '2026-10-23' });
    expect(streakOf(2, days([1, 2], '2026-10-25'), '2026-10-25')).toEqual({ days: 2, atLeast: false, since: '2026-10-23' });
    expect(streakOf(0, [], '2026-10-25')).toEqual({ days: 0, atLeast: false, since: null });
  });
  it('marks a streak that fills the whole window as possibly longer', () => {
    expect(streakOf(49, [], '2026-10-25', 49)).toMatchObject({ days: 49, atLeast: true });
  });
});

describe('latestSessions', () => {
  it('keeps the most recently used, newest first', () => {
    expect(latestSessions(f.sessions, 3).map((session) => session.id)).toEqual(['s1', 's2', 's3']);
    expect(latestSessions([...f.sessions].reverse(), 2).map((session) => session.id)).toEqual(['s1', 's2']);
  });
});
