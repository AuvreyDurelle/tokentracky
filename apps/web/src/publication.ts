import { rankingWindow, type Publication } from '@tokentracky/core';

export interface PublicationDraft {
  alias: string;
}

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
export function validAlias(alias: string): boolean { return ALIAS.test(alias); }

/** A sign-in handle made into a leaderboard name, or null when nothing usable is left. */
export function aliasFromHandle(handle: unknown): string | null {
  if (typeof handle !== 'string') return null;
  const name = handle.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 30);
  return validAlias(name) ? name : null;
}

/** The current UTC Monday. */
export function weekStart(now = new Date()): string {
  return rankingWindow('week', now)!.slice(0, 10);
}

/** Shown on the connect screen and the join page in place of a consent checkbox. */
export const CONNECT_NOTICE = 'Connecting puts your daily token totals, tool split, model mix and estimated cost on the public leaderboard. Delete your account to remove them.';

/** Sharing is fixed: the server publishes all history with the tool split, model mix and cost, so only the name is sent. */
export type PublicationRequest = { alias: string };
export function publicationRequest(draft: PublicationDraft): PublicationRequest {
  if (!validAlias(draft.alias)) throw new Error('Alias must contain 3–30 letters, numbers, underscores, or hyphens and begin with a letter or number.');
  return { alias: draft.alias };
}

export function draftFromPublication(publication: Publication | null): PublicationDraft {
  return { alias: publication?.alias ?? '' };
}
