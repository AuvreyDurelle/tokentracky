import { useId, type ReactNode } from 'react';
import type { BadgeId } from '@tokentracky/core';
import './emblem.css';

// The mockup's rounded hexagon (achievements.html), its inner ring, and one glyph per badge on a 24px grid.
const HEX = 'M26.80 6.00Q32.00 3.00 37.20 6.00L51.92 14.50Q57.11 17.50 57.11 23.50L57.11 40.50Q57.11 46.50 51.92 49.50L37.20 58.00Q32.00 61.00 26.80 58.00L12.08 49.50Q6.89 46.50 6.89 40.50L6.89 23.50Q6.89 17.50 12.08 14.50Z';
const HEX_IN = 'M27.67 10.00Q32.00 7.50 36.33 10.00L48.89 17.25Q53.22 19.75 53.22 24.75L53.22 39.25Q53.22 44.25 48.89 46.75L36.33 54.00Q32.00 56.50 27.67 54.00L15.11 46.75Q10.78 44.25 10.78 39.25L10.78 24.75Q10.78 19.75 15.11 17.25Z';
const GLYPHS: Record<BadgeId, ReactNode> = {
  'token-titan': <><path d="M6 3h12l4 6-10 13L2 9Z" /><path d="M11 3 8 9l4 13 4-13-3-6" /><path d="M2 9h20" /></>,
  'big-day': <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  marathoner: <><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /><path d="m9 16 2 2 4-4" /></>,
  streak: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />,
  'weekend-warrior': <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
  momentum: <><path d="M22 7 13.5 15.5 8.5 10.5 2 17" /><path d="M16 7h6v6" /></>,
  veteran: <><path d="M5 22h14" /><path d="M5 2h14" /><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" /><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" /></>,
  podium: <><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" /><path d="M5 21h14" /></>,
  multitool: <><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></>,
  polyglot: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  trendsetter: <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />,
};

/** A badge's hexagon in its tier's colour: 0 locked (grey), 1–4 bronze to diamond, null earned at a tier the data doesn't say.
 *  A `label` (a threshold such as "10B") sits under a smaller glyph. Decorative unless it has a `title`. */
export function Emblem({ id, tier, label, title }: { id: BadgeId; tier: number | null; label?: string; title?: string }) {
  const gradient = `emb-${useId().replace(/[^\w-]/g, '')}`;
  return <svg className={`m-emb ${tier === null ? 'earned' : `t${tier}`}`} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--h)', stopOpacity: 0.38 }} /><stop offset="1" style={{ stopColor: 'var(--h)', stopOpacity: 0.07 }} /></linearGradient></defs>
    <path className="hx-base" d={HEX} />
    <path className="hx" d={HEX} fill={`url(#${gradient})`} />
    <path className="hx-in" d={HEX_IN} />
    {label
      ? <><g className="gl" transform="translate(26.5 13) scale(.46)" strokeWidth="3.9">{GLYPHS[id]}</g><text x="32" y="44" textAnchor="middle" style={{ fontSize: label.length > 3 ? 12 : 14 }}>{label}</text></>
      : <g className="gl" transform="translate(20 20)" strokeWidth="1.9">{GLYPHS[id]}</g>}
  </svg>;
}
