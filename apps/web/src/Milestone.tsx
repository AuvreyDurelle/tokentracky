import { useEffect, useState } from 'react';
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

function readSeen(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEEN) ?? 'null');
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null;
  } catch { return null; }
}
function writeSeen(seen: string[]) {
  try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* Without storage, the banner shows again next time. */ }
}

/**
 * A banner for the member's newest milestone, with a share action, shown once. `mac` opens the profile's share panel in
 * the browser, as the app may send links only to the hosted site; the website opens X's composer.
 */
export function MilestoneBanner({ stats, site, mac = false }: { stats: ProfileStats; site: string; mac?: boolean }) {
  const [state, setState] = useState<{ show: Milestone | null; seen: string[] } | null>(null);
  useEffect(() => {
    const stored = readSeen();
    const next = nextMilestone(milestones(stats, rankingWindow('week')!.slice(0, 10)), stored);
    if (stored === null) writeSeen(next.seen);
    setState(next);
  }, [stats]);
  if (!state?.show) return null;
  const milestone = state.show;
  const copy = milestoneCopy(milestone);
  const dismiss = () => { writeSeen([...state.seen, milestone.id]); setState({ show: null, seen: [...state.seen, milestone.id] }); };
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
