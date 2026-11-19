import { heatLevels, TOOL_NAMES, type Period, type ToolId } from '@tokentracky/core';
import { invalid } from './errors.ts';

/** Compact token count for small surfaces: 950, 12.3K, 4.5M, 1.2B. */
export function compactCount(value: number): string {
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (value >= size) return `${(value / size).toFixed(value < size * 10 ? 1 : 0).replace(/\.0$/, '')}${suffix}`;
  }
  return String(value);
}

/** Whole dollars from $100, cents below: $1,234 or $12.34. */
export function formatUsd(microusd: number): string {
  const dollars = microusd / 1_000_000;
  return dollars >= 100 ? `$${Math.round(dollars).toLocaleString('en-US')}` : `$${dollars.toFixed(2)}`;
}

const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
/** Approximate Verdana 11px advance, enough to size a two-part badge without a font. */
const width = (text: string) => Math.round(text.length * 6.6) + 12;

export interface BadgeOptions { style: 'flat' | 'flat-square'; label: string; color: string }

/** Badge query options: `style=flat|flat-square`, `label=` (1–30 characters) and `color=` (six-digit hex, no #). */
export function badgeOptions(query: {style?: unknown; label?: unknown; color?: unknown}): BadgeOptions {
  const style = query.style ?? 'flat';
  if (style !== 'flat' && style !== 'flat-square') invalid('Badge style must be flat or flat-square');
  const label = query.label ?? 'tokentracky';
  // Control characters are not allowed in XML, so they cannot be escaped into the SVG.
  if (typeof label !== 'string' || label.length < 1 || [...label].length > 30 || [...label].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid('Badge label must be 1–30 printable characters');
  const color = query.color ?? '4f56b8';
  if (typeof color !== 'string' || !/^[0-9a-fA-F]{6}$/.test(color)) invalid('Badge color must be six hex digits');
  return {style, label, color: color.toLowerCase()};
}

/** A shields-style SVG: "tokentracky | 1.2M tokens". `flat` has rounded corners; `flat-square` does not. */
export function badgeSvg(value: string, options: BadgeOptions = {style: 'flat', label: 'tokentracky', color: '4f56b8'}): string {
  const left = width(options.label);
  const right = width(value);
  const title = escape(`${options.label}: ${value}`);
  const radius = options.style === 'flat' ? 3 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${left + right}" height="20" role="img" aria-label="${title}"><title>${title}</title>`
    + `<clipPath id="r"><rect width="${left + right}" height="20" rx="${radius}" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#24262b"/><rect x="${left}" width="${right}" height="20" fill="#${options.color}"/></g>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`
    + `<text x="${left / 2}" y="14">${escape(options.label)}</text><text x="${left + right / 2}" y="14">${escape(value)}</text></g></svg>`;
}

export interface CardData { alias: string; rank: number; tokens: number; costMicrousd?: number | null; tools?: Partial<Record<ToolId, number>> }
export type CardTheme = 'dark' | 'light';

const THEMES = {
  dark: {background: '#111113', border: '#26262b', text: '#ededef', muted: '#8b8b94', track: '#202024'},
  light: {background: '#ffffff', border: '#e4e4e7', text: '#18181b', muted: '#71717a', track: '#f0f0f2'},
};
// The website's tool hues; Codex's near-white needs a dark stand-in on the light theme.
const TOOL_COLORS: Record<ToolId, string> = {"claude": "#d97757", "codex": "#e6e6e9", "cursor": "#9a9ea5", "gemini": "#4c8df6", "cline": "#2dd4bf", "roo": "#f472b6", "kilo": "#f5c84c", "opencode": "#a78bfa", "everycode": "#fb923c", "mimo": "#a3e635", "dumate": "#22d3ee", "pi": "#e879f9", "omp": "#ffb4a2", "omo": "#4ade80", "primeagent": "#c8a27a", "minimax": "#ff8386", "codebuddy": "#93c5fd", "kimi": "#cfc6ff", "commandcode": "#8b9b5a", "deepseek": "#06aac7", "lmstudio": "#e4e98a", "copilot": "#86efac", "unsloth": "#bba500", "zcode": "#f0abfc", "zed": "#67e8f9", "openclaw": "#d946ef", "reasonix": "#b4a7d6", "hermes": "#30a100", "goose": "#b5cbb4", "grok": "#e5484d"};
const WINDOW_LABELS: Record<Period, string> = {week: 'This week', month: 'This month', all: 'All time'};

/** A 600×180 README card: name, rank, tokens, cost when known, and the top three tools as bars. `null` draws the private placeholder. */
export function cardSvg(data: CardData | null, theme: CardTheme, window: Period): string {
  const t = THEMES[theme];
  const font = 'font-family="Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"';
  const title = escape(data ? `${data.alias}: #${data.rank}, ${compactCount(data.tokens)} tokens, ${WINDOW_LABELS[window].toLowerCase()}` : 'Tokentracky: private');
  let body: string;
  if (!data) body = `<text x="24" y="100" fill="${t.muted}" font-size="16">private</text>`;
  else {
    const facts = [`${compactCount(data.tokens)} tokens`, ...(typeof data.costMicrousd === 'number' ? [`${formatUsd(data.costMicrousd)} est.`] : [])].join(' · ');
    const tools = Object.entries(data.tools ?? {}).filter(([, tokens]) => tokens! > 0).sort((a, b) => b[1]! - a[1]! || a[0].localeCompare(b[0])).slice(0, 3) as Array<[ToolId, number]>;
    const top = tools[0]?.[1] ?? 0;
    body = `<text x="24" y="86" fill="${t.text}" font-size="24" font-weight="600">${escape(data.alias)}</text>`
      + `<text x="24" y="124" fill="${t.text}" font-size="20" font-weight="600">#${data.rank}</text>`
      + `<text x="${34 + Math.round(`#${data.rank}`.length * 12.5)}" y="124" fill="${t.muted}" font-size="15">${escape(facts)}</text>`
      + tools.map(([tool, tokens], index) => {
        const y = 66 + index * 34;
        const color = theme === 'light' && tool === 'codex' ? '#3f3f46' : TOOL_COLORS[tool];
        return `<text x="340" y="${y}" fill="${t.muted}" font-size="12">${escape(TOOL_NAMES[tool])}</text>`
          + `<text x="576" y="${y}" fill="${t.muted}" font-size="12" text-anchor="end">${compactCount(tokens)}</text>`
          + `<rect x="340" y="${y + 6}" width="236" height="6" rx="3" fill="${t.track}"/><rect x="340" y="${y + 6}" width="${Math.max(3, Math.round(236 * tokens / top))}" height="6" rx="3" fill="${color}"/>`;
      }).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="180" viewBox="0 0 600 180" role="img" aria-label="${title}"><title>${title}</title>`
    + `<rect x="0.5" y="0.5" width="599" height="179" rx="10" fill="${t.background}" stroke="${t.border}"/><g ${font}>`
    + `<text x="24" y="38" fill="${t.muted}" font-size="13" font-weight="600">tokentracky</text>`
    + `<text x="576" y="38" fill="${t.muted}" font-size="13" text-anchor="end">${WINDOW_LABELS[window]}</text>`
    + `${body}<text x="24" y="160" fill="${t.muted}" font-size="11">Client-reported usage</text></g></svg>`;
}

const HEAT: Record<CardTheme, string[]> = {dark: ['#161719', '#2c2e31', '#55585d', '#9a9ea5', '#eceef0'], light: ['#ebedf0', '#c6c8cc', '#9a9ea5', '#55585d', '#18181b']};

export interface HeatmapData { alias: string; daily: Array<{day: string; tokens: number}>; currentStreak: number }

/**
 * A README heatmap like the profile's: a year of daily tokens as Monday-first UTC weeks in the site's quartile levels, the
 * year's total and the current streak. `null` draws the private placeholder.
 */
export function heatmapSvg(data: HeatmapData | null, theme: CardTheme): string {
  const t = THEMES[theme];
  const font = 'font-family="Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"';
  const days = data?.daily ?? [];
  const lead = days.length ? (new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const weeks = Math.max(53, Math.ceil((lead + days.length) / 7));
  const width = 52 + weeks * 13 + 20;
  const total = days.reduce((sum, day) => sum + day.tokens, 0);
  const title = escape(data ? `${data.alias}: ${compactCount(total)} tokens in the last year` : 'Tokentracky: private');
  let body: string;
  if (!data) body = `<text x="20" y="110" fill="${t.muted}" font-size="16">private</text>`;
  else {
    const levels = heatLevels(days.map(day => day.tokens));
    const cells = days.map((day, index) => `<rect x="${52 + Math.floor((lead + index) / 7) * 13}" y="${64 + ((lead + index) % 7) * 13}" width="10" height="10" rx="2" fill="${HEAT[theme][levels[index]!]}"><title>${day.day}: ${day.tokens.toLocaleString('en-US')} tokens</title></rect>`).join('');
    const months = days.flatMap((day, index) => day.day.endsWith('-01') || index === 0
      ? [{column: Math.floor((lead + index) / 7), name: new Date(`${day.day}T00:00:00Z`).toLocaleString('en-US', {month: 'short', timeZone: 'UTC'})}] : [])
      .filter((month, index, all) => index + 1 >= all.length || all[index + 1]!.column - month.column >= 3)
      .map(month => `<text x="${52 + month.column * 13}" y="56" fill="${t.muted}" font-size="11">${month.name}</text>`).join('');
    const weekdays = [['Mon', 0], ['Wed', 2], ['Fri', 4]].map(([name, row]) => `<text x="20" y="${73 + (row as number) * 13}" fill="${t.muted}" font-size="10">${name}</text>`).join('');
    const legend = HEAT[theme].map((color, index) => `<rect x="${width - 20 - 34 - (5 - index) * 13}" y="170" width="10" height="10" rx="2" fill="${color}"/>`).join('');
    body = `<text x="20" y="32" fill="${t.text}" font-size="14" font-weight="600">${escape(data.alias)}<tspan fill="${t.muted}" font-weight="400"> · ${compactCount(total)} tokens in the last year</tspan></text>`
      + months + weekdays + cells
      + `<text x="20" y="179" fill="${t.muted}" font-size="11">${data.currentStreak > 0 ? `${data.currentStreak}-day streak` : 'No current streak'}</text>`
      + `<text x="${width - 20 - 34 - 5 * 13 - 6}" y="179" fill="${t.muted}" font-size="11" text-anchor="end">Less</text>${legend}`
      + `<text x="${width - 20}" y="179" fill="${t.muted}" font-size="11" text-anchor="end">More</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="196" viewBox="0 0 ${width} 196" role="img" aria-label="${title}"><title>${title}</title>`
    + `<rect x="0.5" y="0.5" width="${width - 1}" height="195" rx="10" fill="${t.background}" stroke="${t.border}"/><g ${font}>`
    + `<text x="${width - 20}" y="32" fill="${t.muted}" font-size="13" font-weight="600" text-anchor="end">tokentracky</text>${body}</g></svg>`;
}
