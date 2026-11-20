// Shared by Fastify and the Vercel page function. Each host supplies its own built HTML and assets.
import {boardPeriod} from '../../../packages/core/src/ranking.js';
import type {LeaderboardPeriod, LeaderboardResponse} from '@tokentracky/core';

export interface ShareMeta {title: string; description: string; image: string; url: string}
export const SHARE_META_TYPE = 'application/vnd.tokentracky.share+json';
export function standingsQuery(params: URLSearchParams) {
  return {period:boardPeriod(params.get('period')), tool:'all', q:'', page:1, pageSize:5} as const;
}

const headings: Record<LeaderboardPeriod,string> = {
  week:'This week’s leaders', month:'This month’s leaders', all:'All-time leaders', '24h':'Leaders in the last 24 hours',
};

const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
export function accountCallback(query: URLSearchParams): boolean {
  return ['connect','code','token_hash','error','error_description'].some(key => query.has(key));
}

export function withStandings(template: string, period: LeaderboardPeriod, board: Pick<LeaderboardResponse,'updatedAt'|'items'> | null): string {
  let body = '<p>The standings are temporarily unavailable.</p>';
  if (board) {
    const timestamp = escape(board.updatedAt);
    const entries = board.items.map(row => `<li value="${row.rank}"><a href="/u/${encodeURIComponent(row.alias)}">${escape(row.alias)}</a> · ${row.tokens.toLocaleString('en-US')} tokens</li>`);
    body = entries.length
      ? `<ol>${entries.join('')}</ol><p>Updated <time datetime="${timestamp}">${timestamp.replace('T',' ').slice(0,16)} UTC</time></p>`
      : '<p>No public standings are available for this period yet.</p>';
  }
  return template.replace('<!--public-standings-->', () => `<section><h2>${headings[period]}</h2>${body}</section>`);
}

/** A direct request gets a readable summary. The app then opens the full interactive profile. */
export function shareDocument(template: string, title: string, description: string, meta?: ShareMeta): string {
  const tags = [`<title>${escape(title)}</title>`, `<meta name="description" content="${escape(description)}" />`];
  if (meta) {
    const properties = {'og:type':'website','og:site_name':'Tokentracky','og:title':title,'og:description':description,'og:url':meta.url,'og:image':meta.image,'og:image:width':'1200','og:image:height':'630'};
    for (const [key,value] of Object.entries(properties)) tags.push(`<meta property="${key}" content="${escape(value)}" />`);
    const card = {card:'summary_large_image',title,description,image:meta.image};
    for (const [key,value] of Object.entries(card)) tags.push(`<meta name="twitter:${key}" content="${escape(value)}" />`);
  }
  return template.replace(/\s*<meta name="description"[^>]*>/, '').replace(/<title>[^<]*<\/title>/, () => tags.join('\n    '))
    .replace('<div id="root"></div>', () => `<div id="public-page"><main class="page board-intro"><h1>${escape(title)}</h1><p>${escape(description)}</p><a href="/">Leaderboard</a></main></div><div id="root"></div>`);
}

export function unavailableShare(template: string, status: number): string {
  return status === 404
    ? shareDocument(template, 'Page unavailable', 'This page is private or could not be found.')
    : shareDocument(template, 'Page temporarily unavailable', 'Please try again shortly.');
}
