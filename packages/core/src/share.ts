// Shared by the share card the profile page draws and the preview images the hosted API renders.

/** Active days and the longest run of consecutive active days in `daily` from the UTC day `from` on. */
export function windowActivity(daily: ReadonlyArray<{day: string; tokens: number}>, from: string): {activeDays: number; longestStreak: number} {
  let activeDays = 0, run = 0, longestStreak = 0;
  for (const {day, tokens} of daily) {
    if (day < from) continue;
    if (tokens > 0) { activeDays += 1; run += 1; longestStreak = Math.max(longestStreak, run); } else run = 0;
  }
  return {activeDays, longestStreak};
}

/** The facts joined by middots, dropping trailing ones until the line fits. */
export function fitFacts(facts: string[], fits: (text: string) => boolean): string {
  let shown = facts;
  while (shown.length > 1 && !fits(shown.join(' · '))) shown = shown.slice(0, -1);
  return shown.join(' · ');
}
