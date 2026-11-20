import {wrapLabel, type Period} from '@tokentracky/core';
import {compactCount, leadText, type PostgresCloudRepository} from '@tokentracky/cloud';

import type {ShareMeta} from './public-html.ts';

const WINDOWS: Record<Period, string> = {week: 'this week', month: 'this month', all: 'all time'};

/** A profile's preview in a window: its rank and tokens there. */
export async function profileMeta(repository: Pick<PostgresCloudRepository, 'profile'>, alias: string, period: Period, site: string): Promise<ShareMeta> {
  const name = alias.toLowerCase();
  const query = period === 'all' ? '' : `?period=${period}`;
  const page = {image: `${site}/og/${name}.png${query}`, url: `${site}/u/${name}${query}`};
  const profile = await repository.profile(name, period);
  return {...page, title: `${profile.alias} on Tokentracky`, description: `#${profile.rank} ${WINDOWS[period]} with ${compactCount(profile.tokens)} AI coding tokens. See where you rank on the token leaderboard.`};
}

/** A wrap's preview: its tokens and rank in the month or year. */
export async function wrappedMeta(repository: Pick<PostgresCloudRepository, 'wrapped'>, alias: string, period: string, site: string): Promise<ShareMeta> {
  const name = alias.toLowerCase();
  const label = wrapLabel(period);
  const page = {image: `${site}/og/wrapped/${name}/${period}.png`, url: `${site}/wrapped/${name}/${period}`};
  const wrap = await repository.wrapped(name, period);
  return {...page, title: `${wrap.alias}'s ${label} on Tokentracky`, description: `${compactCount(wrap.tokens)} AI coding tokens${wrap.rank > 0 ? `, #${wrap.rank} of ${wrap.builders} builders` : ''} in ${label}. See where you rank on the token leaderboard.`};
}

/** A head-to-head preview in a window: both totals and ranks and who leads. */
export async function compareMeta(repository: Pick<PostgresCloudRepository, 'profile'>, a: string, b: string, period: Period, site: string): Promise<ShareMeta> {
  const [left, right] = [a.toLowerCase(), b.toLowerCase()];
  const query = period === 'all' ? '' : `?period=${period}`;
  const page = {image: `${site}/og/vs/${left}/${right}.png${query}`, url: `${site}/vs/${left}/${right}${query}`};
  const [one, two] = await Promise.all([repository.profile(left, period), repository.profile(right, period)]);
  return {...page, title: `${one.alias} vs ${two.alias} on Tokentracky`,
    description: `${one.alias}: ${compactCount(one.tokens)} tokens (#${one.rank}) · ${two.alias}: ${compactCount(two.tokens)} tokens (#${two.rank}), ${WINDOWS[period]}. ${leadText(one, two)}.`};
}
