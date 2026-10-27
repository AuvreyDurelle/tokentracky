import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { addDays } from '../ranges';
import { personalFixtures } from './personal-fixtures';
import { PopoverPanel, hourBars, latestSessions, sameTimeYesterday, streakOf } from './Popover';

const f = personalFixtures();
const noop = () => {};
// 10:20 UTC: hours 00 to 09 have passed, 10 is under way and 11 to 23 are to come.
const now = Date.parse(`${f.today}T10:20:00Z`);
const hour = (index: number, tokens: number) => ({ hour: new Date(Date.parse(`${f.today}T00:00:00Z`) + index * 3_600_000).toISOString(), tool: 'claude' as const, model: 'claude-opus-5-5', tokens, breakdown: { input: 0, output: tokens, cacheRead: 0, cacheWrite: 0 }, costMicrousd: null });
const hours = [hour(3, 4e6), hour(8, 10e6), hour(8, 2e6), hour(10, 6e6)];
const panel = (overrides: Partial<Parameters<typeof PopoverPanel>[0]> = {}) => renderToStaticMarkup(<PopoverPanel overview={f.overview} recent={f.recent} month={f.month} sessions={f.sessions} hours={hours} yesterday={11e6} status={f.status}
  today={f.today} now={now} busy={null} error={null} onGear={noop} onOpen={noop} onSessions={noop} onRefresh={noop} onPause={noop} {...overrides} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('PopoverPanel', () => {
  it("leads with today's compact total and cost, under who you are and your rank", () => {
    const html = text(panel());
    expect(html).toMatch(/^EX example-builder #42 this week/);
    expect(html).toContain('186.4M tokens');
    expect(html).toMatch(/\$\d[\d,.]* est\. cost/);
  });
  it("charts today's 24 UTC hours, the hour under way lit and the ones to come faint", () => {
    const bars = [.../<div class="po-bars"[^>]*>([\s\S]*?)<\/div>/.exec(panel())![1]!.matchAll(/<i[^>]*>/g)].map((match) => match[0]);
    expect(bars).toHaveLength(24);
    expect(bars[10]).toContain('class="now"');
    expect(bars.filter((bar) => bar.includes('class="f"'))).toHaveLength(13);
    expect(bars[8]).toContain('height:100%');
    expect(bars[0]).toContain('class="z"');
    expect(text(panel())).toMatch(/10:00 · 6M so far/);
  });
  it('compares today so far with yesterday up to this time', () => {
    // 22M so far against 11M: up 100%.
    expect(text(panel())).toContain('+100% vs this time yesterday');
    expect(text(panel({ yesterday: 44e6 }))).toContain('−50% vs this time yesterday');
    expect(text(panel({ yesterday: 0 }))).not.toContain('vs this time yesterday');
  });
  it('lists this week, this month and all time from the overview, with the week and month costs', () => {
    const rows = [...panel().matchAll(/<div class="po-prow">([\s\S]*?)<\/div>/g)].map((match) => text(match[1]!));
    expect(rows.map((row) => row.replace(/ \$[\d,.]+$/, ''))).toEqual(['This week 2.1B', 'This month 6.9B', 'All time 18.4B']);
    // Whole dollars from $100.
    expect(rows[1]).toMatch(/ \$2,39\d$/);
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

describe('hourBars', () => {
  it("adds each hour's rows and marks the hours passed, under way and to come", () => {
    const bars = hourBars(hours, f.today, now);
    expect(bars.map((bar) => bar.tokens).filter(Boolean)).toEqual([4e6, 12e6, 6e6]);
    expect(bars.filter((bar) => bar.when === 'past')).toHaveLength(10);
    expect(bars[10]!.when).toBe('now');
    expect(bars.filter((bar) => bar.when === 'later')).toHaveLength(13);
  });
});

describe('sameTimeYesterday', () => {
  it("runs from yesterday's UTC midnight to this time of day, up to the next quarter hour", () => {
    const midnight = Date.parse(`${f.today}T00:00:00Z`);
    expect(sameTimeYesterday(f.today, now)).toEqual({ since: midnight - 86_400_000, until: midnight + 10.5 * 3_600_000 - 86_400_000 });
    expect(sameTimeYesterday(f.today, midnight + 15 * 60_000).until).toBe(midnight + 15 * 60_000 - 86_400_000);
  });
});
