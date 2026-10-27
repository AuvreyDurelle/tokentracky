/** Test data for the personal pages, shaped like the mockups' numbers (6.9B over 30 days, 186.4M today, a 34-day streak, claude-opus-5-5 the favourite). Tests only; nothing in the app imports it. */
import type { MenuOverview, ProjectSummary, SessionSummary, SourceStatus, TokenCounts, ToolId, UsageBreakdownRow, UsageSummary } from '@tokentracky/core';
import type { LocalStatus, ShellState } from '../api';
import { addDays, utcToday } from '../ranges';

// Tokens per tool over the 30 days, split across each tool's models, with a price in micro-USD per token.
const TOOLS: Array<{ tool: ToolId; tokens: number; models: Array<[string, number, number]> }> = [
  { tool: 'claude', tokens: 4.6e9, models: [['claude-opus-5-5', 0.92, 0.377], ['claude-sonnet-5-5', 0.05, 0.27], ['claude-haiku-5-5', 0.03, 0.3]] },
  { tool: 'codex', tokens: 1.8e9, models: [['gpt-6.1-sol', 0.73, 0.31], ['gpt-6-astra', 0.23, 0.32], ['gpt-5.6-terra', 0.04, 0.48]] },
  { tool: 'gemini', tokens: 248.4e6, models: [['gemini-3.8-flash', 1, 0.197]] },
  { tool: 'opencode', tokens: 165.6e6, models: [['qwen-4-coder', 1, 0.31]] },
  { tool: 'cline', tokens: 75.9e6, models: [['deepseek-v4', 1, 0.266]] },
];
// A month of weekday rhythm with a big day ten days in, ending on today's 186.4M.
const SHAPE = [0.62, 0.58, 1.05, 1.12, 1.08, 1.02, 0.94, 0.41, 0.38, 1.18, 2.6, 1.55, 1.3, 1.12, 0.47, 0.44, 1.21, 1.32, 1.27, 1.19, 1.08, 0.52, 0.5, 1.4, 1.66, 1.58, 1.49, 1.3, 0.58, 0];
const TODAY = 186.4e6;
// Each hour of the day's share of the tokens, peaking at 22:00 (11.7%).
const HOURS = [0.03, 0.02, 0.01, 0.005, 0.005, 0.005, 0.01, 0.015, 0.03, 0.05, 0.06, 0.055, 0.04, 0.05, 0.06, 0.065, 0.06, 0.05, 0.04, 0.045, 0.06, 0.078, 0.117, 0.04];
// Sessions per tool over the 30 days, as the mockup counts them (1,284 in all); each model gets its share of its tool's.
const SESSIONS: Partial<Record<ToolId, number>> = { claude: 412, codex: 731, gemini: 74, opencode: 46, cline: 21 };
const modelSessions = (model: string) => {
  const tool = TOOLS.find((item) => item.models.some(([name]) => name === model));
  const part = tool?.models.find(([name]) => name === model)?.[1] ?? 0;
  return tool ? Math.max(1, Math.round((SESSIONS[tool.tool] ?? 0) * part)) : 0;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
// Mostly cache reads, as the 97% cache rate says; output takes the rounding, so the kinds add up to the tokens.
const kinds = (tokens: number): TokenCounts => {
  const cacheRead = Math.round(tokens * 0.9), input = Math.round(tokens * 0.05), cacheWrite = Math.round(tokens * 0.02);
  return { input, output: tokens - cacheRead - input - cacheWrite, cacheRead, cacheWrite };
};
/** A total with its split by kind; cost by type stays unknown in these fixtures. */
const typed = <T extends { tokens: number }>(item: T) => ({ ...item, breakdown: kinds(item.tokens), costParts: null });
const toolRows = (rows: Array<{ tool: ToolId; tokens: number; costMicrousd: number }>) => rows.map((row) => ({ ...typed(row), sessions: Math.round((SESSIONS[row.tool] ?? 0) * 0.86) }));

export function personalFixtures(now = new Date()) {
  const today = utcToday(now);
  const day = (back: number) => addDays(today, -back);
  const iso = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const share = sum(SHAPE);
  const breakdown: UsageBreakdownRow[] = [];
  SHAPE.forEach((weight, index) => {
    const date = day(29 - index);
    for (const { tool, tokens, models } of TOOLS) for (const [model, part, price] of models) {
      // Today is fixed at 186.4M; the other days share the rest of each tool's month.
      const value = Math.round(index === 29 ? (TODAY * tokens / 6.89e9) * part : (tokens - TODAY * tokens / 6.89e9) * part * (weight / share));
      breakdown.push({ day: date, tool, model, tokens: value, breakdown: kinds(value), costMicrousd: Math.round(value * price) });
    }
  });
  const group = <K extends string>(key: (row: UsageBreakdownRow) => K) => {
    const map = new Map<K, { tokens: number; costMicrousd: number }>();
    for (const row of breakdown) {
      const entry = map.get(key(row)) ?? { tokens: 0, costMicrousd: 0 };
      entry.tokens += row.tokens; entry.costMicrousd += row.costMicrousd ?? 0;
      map.set(key(row), entry);
    }
    return [...map].sort((a, b) => b[1].tokens - a[1].tokens);
  };
  const daily = group((row) => row.day).map(([date, value]) => typed({ day: date, ...value })).sort((a, b) => a.day.localeCompare(b.day));
  const tokens = sum(breakdown.map((row) => row.tokens));
  const summary: UsageSummary = {
    tokens, breakdown: kinds(tokens), costParts: null,
    costMicrousd: sum(breakdown.map((row) => row.costMicrousd ?? 0)),
    sessions: 1284,
    cacheRate: 0.971,
    activity: { activeDays: 30, currentStreak: 30, longestStreak: 30, bestDay: { day: day(19), tokens: 612.3e6 }, averagePerActiveDay: 229.7e6 },
    byTool: group((row) => row.tool).map(([tool, value]) => ({ ...typed({ tool, ...value }), sessions: SESSIONS[tool] ?? 0 })),
    byModel: group((row) => row.model).map(([model, value]) => ({ ...typed({ model, ...value }), sessions: modelSessions(model) })),
    daily,
    // An evening builder: the busiest hour is 22:00, with 11.7% of the tokens.
    byHour: HOURS.map((share) => Math.round(tokens * share)),
  };
  const before: UsageSummary = {
    tokens: 5.0e9, breakdown: kinds(5.0e9), costParts: null, costMicrousd: 1_731e6, sessions: 1102, cacheRate: 0.962,
    activity: { activeDays: 28, currentStreak: 4, longestStreak: 24, bestDay: null, averagePerActiveDay: 178e6 },
    byTool: toolRows([{ tool: 'claude', tokens: 3.26e9, costMicrousd: 1_204e6 }, { tool: 'codex', tokens: 1.39e9, costMicrousd: 441e6 }, { tool: 'opencode', tokens: 202e6, costMicrousd: 62e6 }, { tool: 'gemini', tokens: 117e6, costMicrousd: 23e6 }, { tool: 'cline', tokens: 71.6e6, costMicrousd: 19e6 }]),
    byModel: [{ model: 'claude-opus-5-5', tokens: 3.1e9, costMicrousd: 1_150e6 }, { model: 'gpt-6.1-sol', tokens: 640e6, costMicrousd: 198e6 }, { model: 'gpt-6-astra', tokens: 690e6, costMicrousd: 220e6 }, { model: 'claude-sonnet-5-5', tokens: 160e6, costMicrousd: 54e6 }, { model: 'qwen-4-coder', tokens: 202e6, costMicrousd: 62e6 }, { model: 'gemini-3.8-flash', tokens: 117e6, costMicrousd: 23e6 }, { model: 'deepseek-v4', tokens: 71.6e6, costMicrousd: 19e6 }].map((row) => ({ ...typed(row), sessions: modelSessions(row.model) })),
    daily: [],
    byHour: Array(24).fill(0),
  };
  // A year: tracking began about 290 days ago with a few quiet days, then every day for the last 34.
  const yearDaily = Array.from({ length: 365 }, (_, index) => {
    const back = 364 - index;
    const quiet = back > 289 || (back >= 34 && (back % 9 === 0 || back % 13 === 5 || back === 34));
    const inMonth = back < 30 ? daily.find((point) => point.day === day(back)) : undefined;
    const tokens = inMonth ? inMonth.tokens : quiet ? 0 : Math.round((20e6 + (290 - back) * 0.32e6) * (1 + 0.6 * Math.sin(index * 1.7)) * ((index % 7) > 4 ? 0.45 : 1));
    return typed({ day: day(back), tokens, costMicrousd: inMonth ? inMonth.costMicrousd : Math.round(tokens * 0.35) });
  });
  const year: UsageSummary = {
    ...summary, tokens: sum(yearDaily.map((point) => point.tokens)), daily: yearDaily.filter((point) => point.tokens > 0),
    activity: { activeDays: 211, currentStreak: 34, longestStreak: 58, bestDay: { day: day(19), tokens: 612.3e6 }, averagePerActiveDay: 87.2e6 },
  };
  const project = (name: string, tokens: number, sessions: number, repository: string | null): ProjectSummary => ({ name: `/Users/example/Projects/${name}`, repository, tokens, breakdown: kinds(tokens), costMicrousd: Math.round(tokens * 0.35), sessions });
  const projects = [project('usage-dashboard', 2.4e9, 412, 'example/usage-dashboard'), project('api-gateway', 1.6e9, 233, null), project('sample-editor', 1.1e9, 301, 'example/sample-editor'), project('dotfiles', 620e6, 120, null), project('notes', 330e6, 64, null)];
  const session = (id: string, name: string, tool: ToolId, model: string, tokens: number, minutes: number): SessionSummary => ({
    id, project: `/Users/example/Projects/${name}`, tool, model, models: [model], tokens,
    breakdown: { input: Math.round(tokens * 0.02), output: Math.round(tokens * 0.01), cacheRead: Math.round(tokens * 0.9), cacheWrite: Math.round(tokens * 0.07) },
    costMicrousd: Math.round(tokens * 0.35), lastUsedAt: iso(minutes),
  });
  const sessions = [session('s1', 'usage-dashboard', 'claude', 'claude-opus-5-5', 38.2e6, 4), session('s2', 'api-gateway', 'codex', 'gpt-6.1-sol', 21.7e6, 26), session('s3', 'sample-editor', 'claude', 'claude-sonnet-5-5', 9.8e6, 64), session('s4', 'usage-dashboard', 'claude', 'claude-opus-5-5', 184.2e6, 4 * 1440 + 200), session('s5', 'dotfiles', 'gemini', 'gemini-3.8-flash', 3.1e6, 2 * 1440)];
  const overview: MenuOverview = { today: TODAY, week: 2.1e9, month: 6.9e9, allTime: 18.4e9, topTool: { tool: 'claude', tokens: 1.4e9 }, rank: 42, alias: 'example-builder', paused: false, refreshing: false, refreshedAt: iso(2), nextRefreshAt: iso(-58),
    costs: { today: 64.8e6, week: 729e6, month: 2_394e6, allTime: 6_412e6 } };
  const source = (id: ToolId, name: string, enabled: boolean, paths: string[], eventCount: number, state: SourceStatus['state'] = enabled ? 'current' : 'detected'): SourceStatus => ({
    id, name, enabled, state, paths, lastImportedAt: enabled ? iso(2) : null, eventCount, message: '', capabilities: { tokens: true, models: true, projects: true, costs: true, quotas: false },
  });
  const status: LocalStatus = {
    sources: [
      source('claude', 'Claude Code', true, ['~/.claude/projects'], 48_210), source('codex', 'Codex', true, ['~/.codex/sessions'], 21_964),
      source('cursor', 'Cursor', false, [], 0, 'unsupported'), source('gemini', 'Gemini CLI', true, ['~/.gemini/tmp'], 3_120),
      source('cline', 'Cline', true, ['~/.cline/data/sessions'], 1_408), source('roo', 'Roo Code', false, ['~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline'], 0),
      source('kilo', 'Kilo Code', false, ['~/.local/share/kilo/kilo.db'], 0), source('opencode', 'OpenCode', true, ['~/.local/share/opencode/opencode.db'], 2_216),
    ],
    collecting: true, lastScanAt: iso(2), cloudLinked: true, syncError: null, lastSyncAt: iso(2), alias: 'example-builder', lastRefreshAt: iso(2), nextRefreshAt: iso(-58), refreshing: false, pricingVersion: 'litellm-2026-10-25', pricingUpdatedAt: iso(228),
  };
  const detected = status.sources.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name, paths: item.paths }));
  const shell: ShellState = { launchAtLogin: true, update: { state: 'idle', version: null }, version: '1.0.0' };
  // The popover's last 49 days, and this month so far.
  const recent: UsageSummary = { ...year, daily: yearDaily.slice(-49).filter((point) => point.tokens > 0), activity: { ...year.activity, currentStreak: 34 } };
  const month: UsageSummary = { ...summary, byTool: toolRows([{ tool: 'claude', tokens: 4.43e9, costMicrousd: 1_640e6 }, { tool: 'codex', tokens: 1.9e9, costMicrousd: 590e6 }, { tool: 'gemini', tokens: 283e6, costMicrousd: 56e6 }, { tool: 'opencode', tokens: 200e6, costMicrousd: 62e6 }, { tool: 'cline', tokens: 90e6, costMicrousd: 24e6 }]) };
  return { today, range: { from: day(29), to: today }, summary, before, breakdown, year, projects, sessions, overview, status, detected, shell, recent, month };
}
