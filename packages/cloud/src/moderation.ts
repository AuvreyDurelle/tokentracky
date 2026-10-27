// Pure upload checks. Deployments supply their own private policy; no production defaults are bundled.

export interface ModerationPolicy {
  /** Minimum day size, peer multiple, and number of other visible members required to hide a day. */
  hideFloor: number; hideRatio: number; hideCohort: number;
  /** Large-day and recent-baseline review rules. */
  volumeFloor: number; jumpRatio: number; jumpFloor: number; baselineDays: number;
  /** Minimum repeated bucket size and repetition count for a template review. */
  templateTokens: number; templateCount: number;
  /** All-time lead review and the total increment between lead queries. */
  leadRatio: number; leadFloor: number; leadStep: number;
  /** Suppress automatic hiding after this many other hides within the window. */
  breakerHides: number; breakerWindowMs: number;
  /** Growth required to reflag a cleared day, and the operator review deadline. */
  reflagGrowth: number; reviewWithinMs: number;
}
const POLICY_KEYS = [
  'hideFloor', 'hideRatio', 'hideCohort', 'volumeFloor', 'jumpRatio', 'jumpFloor', 'baselineDays',
  'templateTokens', 'templateCount', 'leadRatio', 'leadFloor', 'leadStep', 'breakerHides', 'breakerWindowMs',
  'reflagGrowth', 'reviewWithinMs',
] as const;
const RATIOS = new Set<string>(['hideRatio', 'jumpRatio', 'leadRatio', 'reflagGrowth']);

/** Strict validation with a value-free error: configuration may contain private policy values. */
function validatePolicy(value: unknown): Readonly<ModerationPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid moderation policy');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== POLICY_KEYS.length || Object.keys(input).some(key => !(POLICY_KEYS as readonly string[]).includes(key))) throw new Error('Invalid moderation policy');
  for (const key of POLICY_KEYS) {
    const number = input[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number > Number.MAX_SAFE_INTEGER
      || (RATIOS.has(key) ? number <= 1 : !Number.isSafeInteger(number) || number <= 0)) throw new Error('Invalid moderation policy');
  }
  // Bound the history query to a supported calendar window and avoid an invalid lead-check gate.
  if ((input.baselineDays as number) > 366 || (input.leadStep as number) > (input.leadFloor as number)) throw new Error('Invalid moderation policy');
  return Object.freeze({...input}) as Readonly<ModerationPolicy>;
}

export function parseModerationPolicy(raw: string | undefined): Readonly<ModerationPolicy> {
  if (!raw?.trim()) throw new Error('Missing TOKENTRACKY_MODERATION_POLICY');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid moderation policy'); }
  return validatePolicy(value);
}

export type Reason = 'peers' | 'volume' | 'jump' | 'template' | 'lead';
export type FlagStatus = 'review' | 'hidden' | 'cleared';
/** One day of one account: its total, the largest other visible member's total, how many others, and its own recent median. */
export interface DaySignals {day: string; tokens: number; rival: number; cohort: number; baseline: number | null}
export interface Finding extends DaySignals {status: 'review' | 'hidden'; reasons: Reason[]}
export interface StoredFlag {day: string; tokens: number; status: FlagStatus; reasons: Reason[]; reviewed: boolean}
/** `detected` resets when the flag is first raised, escalated or raised again; it is when the flag reached its status. */
export interface FlagWrite extends Finding {detected: boolean}
export type ModerationEvent = {event: 'moderation_flag'; status: 'review' | 'hidden'; reasons: Reason[]} | {event: 'moderation_breaker'}
  | {event: 'public_counter_overflow'; count: number} | {event: 'cost_capped'; count: number};

export function createModerationRules(policy: ModerationPolicy) {
  const LIMITS = validatePolicy(policy);
  const DAY_GATE = Math.min(LIMITS.hideFloor, LIMITS.volumeFloor, LIMITS.jumpFloor);
  /** The day's own rules, plus any account-wide reasons (`template`, `lead`) that point at this day. */
  function assess(s: DaySignals, extra: Reason[] = []): Finding | null {
    const hide = s.tokens >= LIMITS.hideFloor && s.cohort >= LIMITS.hideCohort && s.tokens >= LIMITS.hideRatio * s.rival;
    const reasons: Reason[] = [];
    if (hide) reasons.push('peers');
    if (s.tokens >= LIMITS.volumeFloor) reasons.push('volume');
    if (s.baseline !== null && s.baseline > 0 && s.tokens >= LIMITS.jumpFloor && s.tokens >= LIMITS.jumpRatio * s.baseline) reasons.push('jump');
    for (const reason of extra) if (!reasons.includes(reason)) reasons.push(reason);
    return reasons.length ? {...s, status: hide ? 'hidden' : 'review', reasons} : null;
  }

  /** Median of the member's most recent dated day totals before `day` (at most `baselineDays` of them), or null without history. */
  function median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  /**
   * The total to test a lead crossing from, or null when this upload needs no lead check. Checking only uploads that pass a
   * `leadStep` boundary, from the boundary below the old total, still covers every total the member has had.
   */
  function leadCheck(before: number, after: number): number | null {
    const step = (total: number) => Math.floor(total / LIMITS.leadStep);
    return after >= LIMITS.leadFloor && step(after) > step(before) ? step(before) * LIMITS.leadStep : null;
  }

  /** All-time lead, counted once: when the member's total crosses the line, not on every upload while ahead. */
  function crossesLead(before: number, after: number, rival: number): boolean {
    const leads = (total: number) => rival > 0 && total >= LIMITS.leadFloor && total >= LIMITS.leadRatio * rival;
    return leads(after) && !leads(before);
  }

  /**
   * What to store for a finding, given the day's existing flag. A flag only rises from review to hidden on its own;
   * a person's decision stands, except that a cleared day whose total has since grown `reflagGrowth`× is raised again.
   */
  function nextFlag(existing: StoredFlag | undefined, finding: Finding): FlagWrite | null {
    if (!existing) return {...finding, detected: true};
    if (existing.reviewed) {
      return existing.status === 'cleared' && finding.tokens >= LIMITS.reflagGrowth * existing.tokens ? {...finding, detected: true} : null;
    }
    const status = existing.status === 'hidden' || finding.status === 'hidden' ? 'hidden' : 'review';
    const reasons = [...existing.reasons, ...finding.reasons.filter(reason => !existing.reasons.includes(reason))];
    return {...finding, status, reasons, detected: status !== existing.status};
  }

  return {LIMITS, DAY_GATE, assess, median, leadCheck, crossesLead, nextFlag};
}
