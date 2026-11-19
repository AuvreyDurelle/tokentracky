import { useEffect, useRef, useState } from 'react';
import { milestones, nextMilestone, rankingWindow, type Milestone, type ProfileStats } from '@tokentracky/core';
import { formatCompact } from './format';
import { ACHIEVEMENT_COPY, TIER_NAMES } from './mac/achievement-copy';

/** Milestone ids this browser or app window has shown, so each one shows once. */
const SEEN = 'tokentracky.milestones.seen';

/** The banner's line and the text of a post about it. */
export function milestoneCopy(milestone: Milestone): { title: string; post: string } {
  if (milestone.kind === 'week') return milestone.rank === 1
    ? { title: 'You’re #1 on the leaderboard this week', post: 'I’m #1 on the Tokentracky leaderboard this week.' }
    : { title: `You’re in the top ${milestone.rank} this week`, post: `I’m in the top ${milestone.rank} on the Tokentracky leaderboard this week.` };
  if (milestone.kind === 'tokens') return { title: `You’ve passed ${formatCompact(milestone.tokens)} tokens`, post: `I’ve passed ${formatCompact(milestone.tokens)} AI coding tokens on Tokentracky.` };
  const name = `${TIER_NAMES[milestone.tier]} ${ACHIEVEMENT_COPY[milestone.badge].name}`;
  return { title: `You earned ${name}`, post: `I earned the ${name} badge on Tokentracky.` };
}

/** Where the milestone ids shown are kept: this browser's storage on the website, the app itself in the Mac app. */
export interface SeenStore { read(): Promise<string[] | null>; write(seen: string[]): Promise<unknown> }

export const browserSeen: SeenStore = {
  read: async () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(SEEN) ?? 'null');
      return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null;
    } catch { return null; }
  },
  write: async (seen) => {
    try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* Without storage, the banner shows again next time. */ }
  },
};

/**
 * A banner for the member's newest milestone, with a share action, shown once: it counts as seen as soon as it shows,
 * and Dismiss or Share only hide it. `mac` opens the profile's share panel in
 * the browser, as the app may send links only to the hosted site; the website opens X's composer.
 */
export function MilestoneBanner({ stats, site, mac = false, store = browserSeen }: { stats: ProfileStats; site: string; mac?: boolean; store?: SeenStore }) {
  const [milestone, setMilestone] = useState<Milestone | null>(null);
  // Checked once a mount: the profile is read again as it refreshes, and a second check would find this one seen.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    // Without the ids shown, nothing shows: an unreadable store must not bring every milestone back.
    store.read().then((stored) => {
      const next = nextMilestone(milestones(stats, rankingWindow('week')!.slice(0, 10)), stored);
      // Shown once: one write records it as it appears, so closing the popover or opening the browser loses nothing.
      if (stored === null || next.show) void store.write(next.show ? [...next.seen, next.show.id] : next.seen).catch(() => {});
      setMilestone(next.show);
    }, () => {});
  }, [stats, store]);
  if (!milestone) return null;
  const copy = milestoneCopy(milestone);
  const dismiss = () => setMilestone(null);
  const share = () => {
    const profile = `${site}/u/${stats.alias}`;
    window.open(mac ? `${profile}#share` : `https://x.com/intent/post?${new URLSearchParams({ text: copy.post, url: `${profile}?ref=share` }).toString()}`, '_blank', 'noopener');
    dismiss();
  };
  return <div className={mac ? 'po-milestone' : 'panel milestone'} role="status">
    <span className="milestone-mark" aria-hidden="true">★</span>
    <b>{copy.title}</b>
    <span className="milestone-actions">
      <button type="button" className={mac ? undefined : 'btn sm primary'} onClick={share}>{mac ? 'Share' : 'Post on X'}</button>
      <button type="button" className={mac ? undefined : 'btn sm'} onClick={dismiss}>Dismiss</button>
    </span>
  </div>;
}
