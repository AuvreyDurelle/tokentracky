import {wrapLabel, type Period} from '@tokentracky/core';
import {compactCount, leadText, type PostgresCloudRepository} from '@tokentracky/cloud';

/** What a link preview shows for a shareable page: its title, a line of text, the 1200×630 image and the page's address. */
export interface ShareMeta {title: string; description: string; image: string; url: string}

const attribute = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/** The web app's index.html with the page's title, description, and Open Graph and X card tags, which link previews read. */
export function withShareMeta(html: string, meta: ShareMeta): string {
  const tags = [
    `<title>${attribute(meta.title)}</title>`,
    `<meta name="description" content="${attribute(meta.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Tokentracky" />`,
    `<meta property="og:title" content="${attribute(meta.title)}" />`,
    `<meta property="og:description" content="${attribute(meta.description)}" />`,
    `<meta property="og:url" content="${attribute(meta.url)}" />`,
    `<meta property="og:image" content="${attribute(meta.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attribute(meta.title)}" />`,
    `<meta name="twitter:description" content="${attribute(meta.description)}" />`,
    `<meta name="twitter:image" content="${attribute(meta.image)}" />`,
  ].join('\n    ');
  return html.replace(/\s*<meta name="description"[^>]*>/, '').replace(/<title>[^<]*<\/title>/, tags);
}

const SITE_DESCRIPTION = 'The token leaderboard. See how many AI coding tokens the community burns, and where you rank.';

/** A profile's preview: its all-time rank and tokens, or the site's own text for a private or unknown name. */
export async function profileMeta(repository: Pick<PostgresCloudRepository, 'profile'>, alias: string, site: string): Promise<ShareMeta> {
  const name = alias.toLowerCase();
  const page = {image: `${site}/og/${name}.png`, url: `${site}/u/${name}`};
  try {
    const profile = await repository.profile(name, 'all');
    return {...page, title: `${profile.alias} on Tokentracky`, description: `#${profile.rank} all time with ${compactCount(profile.tokens)} AI coding tokens. See where you rank on the token leaderboard.`};
  } catch {
    // The page still loads for people; only the preview falls back to the site's text.
    return {...page, title: 'Tokentracky — the token leaderboard', description: SITE_DESCRIPTION};
  }
}

/** A wrap's preview: its tokens and rank in the month or year, or the site's own text when it cannot be read. */
export async function wrappedMeta(repository: Pick<PostgresCloudRepository, 'wrapped'>, alias: string, period: string, site: string): Promise<ShareMeta> {
  const name = alias.toLowerCase();
  const label = wrapLabel(period);
  const page = {image: `${site}/og/wrapped/${name}/${period}.png`, url: `${site}/wrapped/${name}/${period}`};
  try {
    const wrap = await repository.wrapped(name, period);
    return {...page, title: `${wrap.alias}'s ${label} on Tokentracky`, description: `${compactCount(wrap.tokens)} AI coding tokens${wrap.rank > 0 ? `, #${wrap.rank} of ${wrap.builders} builders` : ''} in ${label}. See where you rank on the token leaderboard.`};
  } catch {
    return {...page, title: 'Tokentracky — the token leaderboard', description: SITE_DESCRIPTION};
  }
}

const WINDOWS: Record<Period, string> = {week: 'this week', month: 'this month', all: 'all time'};

/** A head-to-head preview in a window: both totals and ranks and who leads, or the site's own text when either is not public. */
export async function compareMeta(repository: Pick<PostgresCloudRepository, 'profile'>, a: string, b: string, period: Period, site: string): Promise<ShareMeta> {
  const [left, right] = [a.toLowerCase(), b.toLowerCase()];
  const query = period === 'all' ? '' : `?period=${period}`;
  const page = {image: `${site}/og/vs/${left}/${right}.png${query}`, url: `${site}/vs/${left}/${right}${query}`};
  try {
    const [one, two] = await Promise.all([repository.profile(left, period), repository.profile(right, period)]);
    return {...page, title: `${one.alias} vs ${two.alias} on Tokentracky`,
      description: `${one.alias}: ${compactCount(one.tokens)} tokens (#${one.rank}) · ${two.alias}: ${compactCount(two.tokens)} tokens (#${two.rank}), ${WINDOWS[period]}. ${leadText(one, two)}.`};
  } catch {
    return {...page, title: 'Tokentracky — the token leaderboard', description: SITE_DESCRIPTION};
  }
}
