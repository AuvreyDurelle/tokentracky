import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { fitFacts, rankingWindow, windowActivity, type Period, type ProfileStats } from '@tokentracky/core';
import { compactCount } from './badge.ts';

/** Inter Medium and SemiBold, beside the source in development and copied beside the bundle (`dist/fonts`) by the server build. */
export function fontsDirectory(): string {
  const found = ['../fonts/', './fonts/'].map(path => fileURLToPath(new URL(path, import.meta.url))).find(path => existsSync(join(path, 'Inter-SemiBold.ttf')));
  if (!found) throw new Error('Card fonts are missing');
  return found;
}

/** Renders a card SVG to PNG with the bundled fonts only, so the image is the same on every host. */
export function pngFromSvg(svg: string): Buffer {
  const fonts = fontsDirectory();
  const renderer = new Resvg(svg, {font: {fontFiles: [join(fonts, 'Inter-Medium.ttf'), join(fonts, 'Inter-SemiBold.ttf')], loadSystemFonts: false, defaultFontFamily: 'Inter'}});
  return renderer.render().asPng();
}

const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/i;

/**
 * The visitor-facing origin for absolute links in previews: the host the signing gateway forwards (`x-tokentracky-host`),
 * else the request's own. Loopback hosts keep plain HTTP for development; anything that is not a plain host name falls
 * back to `fallback`.
 */
export function publicSite(headers: Record<string, string | string[] | undefined>, fallback = 'https://tokentracky.com'): string {
  for (const name of ['x-tokentracky-host', 'host']) {
    const value = headers[name];
    if (typeof value !== 'string' || value.length > 253 || !HOST.test(value)) continue;
    const loopback = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(value);
    return `${loopback ? 'http' : 'https'}://${value.toLowerCase()}`;
  }
  return fallback;
}

const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const WINDOWS: Record<Period, string> = {week: 'this week', month: 'this month', all: 'all time'};
const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
/** Inter Medium at 26px averages about 12px a character in these facts (measured with resvg); the card has 1024px for them. */
const factsFit = (text: string) => text.length * 12.2 <= 1024;

function frame(content: string, site: string, path: string, label: string): string {
  const font = 'font-family="Inter"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escape(label)}"><title>${escape(label)}</title>`
    + `<rect width="1200" height="630" fill="#0a0a0b"/><rect x="40" y="40" width="1120" height="550" fill="#111113"/><g ${font}>`
    + `<text x="88" y="110" fill="#ededef" font-size="28" font-weight="600">Tokentracky</text>${content}`
    + `<text x="88" y="575" fill="#7c7c85" font-size="22" font-weight="500">Waste tokens, not time.</text>`
    + `<text x="1112" y="575" fill="#7c7c85" font-size="22" font-weight="500" text-anchor="end">${escape(site.replace(/^https?:\/\//, '') + path)}</text></g></svg>`;
}

/**
 * The 1200×630 preview card, as the profile page draws it: name, rank and tokens in the window, its activity, and a year of
 * daily totals as columns. `null` draws the leaderboard card used for private or unknown names.
 */
export function profileCardSvg(stats: ProfileStats | null, period: Period, site: string): string {
  if (!stats) return frame(`<text x="88" y="300" fill="#ededef" font-size="64" font-weight="600">The token leaderboard</text>`
    + `<text x="88" y="360" fill="#a1a1a8" font-size="30" font-weight="500">How many AI coding tokens do you burn?</text>`, site, '', 'Tokentracky: the token leaderboard');
  const {rank, tokens} = stats.periods[period];
  const today = stats.daily.at(-1)?.day;
  // Week and month count their own days; all time matches the profile's last 12 months.
  const from = today ? rankingWindow(period, new Date(`${today}T12:00:00.000Z`))?.slice(0, 10) : undefined;
  const {activeDays, longestStreak} = from ? windowActivity(stats.daily, from) : stats.activity;
  const facts = [`tokens ${WINDOWS[period]}`, plural(activeDays, 'active day'), `longest streak ${plural(longestStreak, 'day')}`, ...(stats.models?.[0] ? [`favourite ${stats.models[0].model}`] : [])];
  const max = Math.max(1, ...stats.daily.map(day => day.tokens));
  const width = 1024 / Math.max(1, stats.daily.length);
  const bars = stats.daily.map((day, index) => {
    const height = day.tokens ? Math.max(4, (day.tokens / max) * 110) : 2;
    const fill = day.tokens ? `rgba(228,228,231,${(0.35 + 0.65 * (day.tokens / max)).toFixed(3)})` : '#202024';
    return `<rect x="${(88 + index * width).toFixed(2)}" y="${(540 - height).toFixed(2)}" width="${Math.max(1, width - 0.6).toFixed(2)}" height="${height.toFixed(2)}" fill="${fill}"/>`;
  }).join('');
  return frame((rank > 0 ? `<text x="1112" y="110" fill="#7c7c85" font-size="24" font-weight="500" text-anchor="end">#${rank} ${WINDOWS[period]}</text>` : '')
    + `<text x="88" y="205" fill="#ededef" font-size="56" font-weight="600">${escape(stats.alias)}</text>`
    + `<text x="82" y="340" fill="#ededef" font-size="120" font-weight="600">${compactCount(tokens)}</text>`
    + `<text x="88" y="390" fill="#a1a1a8" font-size="26" font-weight="500">${escape(fitFacts(facts, factsFit))}</text>${bars}`,
  site, `/u/${stats.alias}`, `${stats.alias}: ${compactCount(tokens)} tokens ${WINDOWS[period]}${rank > 0 ? `, #${rank}` : ''}`);
}
