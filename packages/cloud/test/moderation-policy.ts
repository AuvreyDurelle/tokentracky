import type {ModerationPolicy} from '../src/moderation.ts';

/** Deliberately synthetic policy for tests; these values are not deployment recommendations. */
export const TEST_MODERATION_POLICY: ModerationPolicy = {
  hideFloor: 50e6, hideRatio: 8, hideCohort: 4,
  volumeFloor: 100e6, jumpRatio: 16, jumpFloor: 10e6, baselineDays: 9,
  templateTokens: 10_000, templateCount: 4,
  leadRatio: 2.5, leadFloor: 100e6, leadStep: 10e6,
  breakerHides: 2, breakerWindowMs: 1_800_000,
  reflagGrowth: 3, reviewWithinMs: 36 * 3_600_000,
};
