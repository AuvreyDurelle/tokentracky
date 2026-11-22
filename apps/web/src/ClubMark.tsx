import type { CSSProperties } from 'react';
import { CLUB_MARKS, LOCK_MARK, type ClubMark as ClubMarkId, type ClubMarkShape } from '@tokentracky/core';
import { avatarHue } from './ui';

/** One element of a mark, drawn on the 16×16 grid. */
export function MarkShape({ shape }: { shape: ClubMarkShape }) {
  if ('circle' in shape) return <circle cx={shape.circle[0]} cy={shape.circle[1]} r={shape.circle[2]} />;
  if ('rect' in shape) return <rect x={shape.rect[0]} y={shape.rect[1]} width={shape.rect[2]} height={shape.rect[3]} rx={shape.rect[4]} />;
  return <path d={shape.d} />;
}

/** The colour a club wears everywhere, from its address, as avatars take theirs from an alias. */
export const clubHue = (slug: string) => avatarHue(slug);

/** A club's emblem: a glyph in a rounded square, in the club's own colour when `slug` is given. Null draws the lock of a private club seen from outside. */
export function ClubMark({ mark, slug, size, label }: { mark: ClubMarkId | null; slug?: string; size?: 'lg' | 'xl'; label?: string }) {
  const shapes = mark ? CLUB_MARKS[mark].shapes : LOCK_MARK;
  return <span className={`club-mark${size ? ` ${size}` : ''}${slug ? ' hued' : ''}`} style={slug ? { '--h': clubHue(slug) } as CSSProperties : undefined} {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes.map((shape, index) => <MarkShape key={index} shape={shape} />)}</svg>
  </span>;
}
