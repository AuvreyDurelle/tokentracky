import { useState } from 'react';
import { wrapLabel } from '@tokentracky/core';
import { errorText } from '../format';
import { badgeMarkdown } from '../Profile';

/** What the app shares, all on the hosted site: links leave the app for the browser only at that origin. */
export function shareLinks(site: string, alias: string, today: string) {
  return {
    profile: `${site}/u/${alias}?ref=share`,
    badge: badgeMarkdown(site, alias),
    // The profile's share panel: the card to save or copy, and Post on X.
    card: `${site}/u/${alias}#share`,
    wrap: `${site}/wrapped/${alias}/${today.slice(0, 7)}`,
  };
}

/** The popover's share actions: copy the profile link or README badge, or open the card or this month's wrap in the browser. */
export function ShareMenu({ site, alias, today }: { site: string; alias: string; today: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const links = shareLinks(site, alias, today);
  const copy = (text: string, done: string) => {
    navigator.clipboard.writeText(text).then(() => setMessage(done), (value: unknown) => setMessage(`Copying failed: ${errorText(value)}`));
  };
  return <div className="po-share" role="group" aria-label="Share">
    <button type="button" onClick={() => copy(links.profile, 'Profile link copied. Its preview shows your card.')}>Copy profile link</button>
    <button type="button" onClick={() => copy(links.badge, 'README badge copied.')}>Copy README badge</button>
    <button type="button" onClick={() => window.open(links.card, '_blank')}>Card and Post on X</button>
    <button type="button" onClick={() => window.open(links.wrap, '_blank')}>{wrapLabel(today.slice(0, 7))} wrap</button>
    {message && <p role="status">{message}</p>}
  </div>;
}
