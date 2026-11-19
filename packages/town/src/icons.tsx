import type { ReactNode } from 'react';
import type { ResourceId } from '@tokentracky/core';
import { GLYPHS, type Glyph } from './art.ts';

/** A resource or streak glyph. The markup is a fixed constant. */
export function GlyphIcon({id, size = 20, className}: {id: Glyph; size?: number; className?: string}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{__html: GLYPHS[id]}} />;
}
export const ResourceIcon = ({id, size}: {id: ResourceId; size?: number}) => <GlyphIcon id={id} size={size} />;

const line = (paths: ReactNode) => ({size = 20}: {size?: number}) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
export const MapIcon = line(<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20zM9 4v13.5M15 6.5V20" />);
export const BuildIcon = line(<path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M12 11.5v6M9 14.5h6" />);
export const FlagIcon = line(<path d="M5 21V4M5 4.5h12l-2.5 4 2.5 4H5" />);
export const SparkIcon = line(<path d="M12 3l2.2 6.3L20.5 12l-6.3 2.7L12 21l-2.2-6.3L3.5 12l6.3-2.7z" />);
export const ClockIcon = line(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const HomeIcon = line(<path d="M3.5 11 12 4l8.5 7M6 9v11h12V9M10 20v-5h4v5" />);
export const MoveIcon = line(<path d="M3 12h14M12.5 6.5 18 12l-5.5 5.5M21 5v14" />);
export const CloseIcon = line(<path d="M6 6l12 12M18 6 6 18" />);
export const PlusIcon = line(<path d="M12 5v14M5 12h14" />);
export const MinusIcon = line(<path d="M5 12h14" />);
export const HeartIcon = ({filled, size = 16}: {filled: boolean; size?: number}) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" /></svg>;
