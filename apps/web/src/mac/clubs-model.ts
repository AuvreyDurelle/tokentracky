/** The figures the clubs pages compete on: who leads a matchup day by day, who has the edge in a comparison, and the clock. */
import { clubWeek } from '@tokentracky/core';

/** Running totals: each day's value plus every day before it. */
export function cumulative(daily: readonly number[]): number[] {
  let sum = 0;
  return daily.map((value) => (sum += value));
}

export type Side = 'a' | 'b';
/** Which side led after each day of a matchup, from each side's tokens per active member per day; null on a level day. */
export function leadByDay(a: readonly number[], b: readonly number[]): Array<Side | null> {
  const totalB = cumulative(b);
  return cumulative(a).map((value, index) => value > (totalB[index] ?? 0) ? 'a' : value < (totalB[index] ?? 0) ? 'b' : null);
}

/** The side a figure favours: the bigger one, or the smaller when `lower` wins (a rank); null when level or either is missing. */
export function edge(a: number | null | undefined, b: number | null | undefined, lower = false): Side | null {
  if (a == null || b == null || a === b) return null;
  return (a > b) !== lower ? 'a' : 'b';
}

/** Whole days, hours, minutes and seconds from `now` to `end`, never below zero. */
export function timeLeft(end: number, now: number): { days: number; hours: number; minutes: number; seconds: number } {
  const seconds = Math.max(0, Math.floor((end - now) / 1000));
  return { days: Math.floor(seconds / 86_400), hours: Math.floor((seconds % 86_400) / 3600), minutes: Math.floor((seconds % 3600) / 60), seconds: seconds % 60 };
}

/** How far through its club week `now` is, 0 to 1, and today's place in it, Monday 0. */
export function weekProgress(now: Date): { done: number; day: number } {
  const { start, end } = clubWeek(now);
  const from = Date.parse(start), to = Date.parse(end);
  return { done: (now.getTime() - from) / (to - from), day: Math.floor((now.getTime() - from) / 86_400_000) };
}

/** A club busy enough to call hot: at least 3 members and three in four of them active this week. */
export function isHot(active: number, members: number): boolean {
  return members >= 3 && active / members >= 0.75;
}

/** The address a name will likely get, lowercase words joined by hyphens, so a new club's preview wears its colour. */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The y range a race chart draws: from zero, or snug around the values with room above and below. Never empty. */
export function raceDomain(values: readonly number[], zero: boolean): [number, number] {
  if (values.length === 0) return [0, 1];
  const max = Math.max(...values), min = zero ? 0 : Math.min(...values);
  const pad = zero ? max * 0.08 : (max - min) * 0.15 || Math.abs(max) * 0.05 || 1;
  return [zero ? 0 : min - pad, max + pad || 1];
}
