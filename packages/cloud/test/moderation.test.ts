import {describe, expect, it} from 'vitest';
import {createModerationRules, parseModerationPolicy, type DaySignals, type StoredFlag} from '../src/moderation.ts';
import {TEST_MODERATION_POLICY as policy} from './moderation-policy.ts';

const {assess, crossesLead, DAY_GATE, leadCheck, median, nextFlag} = createModerationRules(policy);
const day = (tokens: number, extra: Partial<DaySignals> = {}): DaySignals => ({day: '2026-10-23', tokens, rival: 0, cohort: 0, baseline: null, ...extra});

describe('private moderation configuration', () => {
  it('requires a complete valid policy and never includes values in errors', () => {
    expect(() => parseModerationPolicy(undefined)).toThrow('Missing TOKENTRACKY_MODERATION_POLICY');
    for (const value of ['', 'private-invalid-json', 'null', '[]', '{}', JSON.stringify({...policy, privateUnknown: 'private-value'})]) {
      expect(() => parseModerationPolicy(value)).toThrow();
    }
    for (const [key, value] of [['hideRatio', 1], ['jumpRatio', -1], ['hideFloor', 0], ['hideCohort', 1.5], ['baselineDays', 367], ['leadStep', policy.leadFloor + 1], ['reviewWithinMs', Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => parseModerationPolicy(JSON.stringify({...policy, [key]: value}))).toThrow('Invalid moderation policy');
    }
    const parsed = parseModerationPolicy(JSON.stringify(policy));
    expect(parsed).toEqual(policy);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it('keeps policies isolated and copies injected values', () => {
    const injected = {...policy};
    const original = createModerationRules(injected);
    injected.hideFloor *= 2;
    const changed = createModerationRules(injected);
    const signals = day(policy.hideFloor, {cohort: policy.hideCohort, rival: 1});
    expect(original.assess(signals)?.status).toBe('hidden');
    expect(changed.assess(signals)).toBeNull();
  });
});

describe('upload rules with synthetic policy', () => {
  it('requires the configured floor, peer ratio and cohort before hiding', () => {
    const signals = day(policy.hideFloor, {rival: policy.hideFloor / policy.hideRatio, cohort: policy.hideCohort});
    expect(assess(signals)).toMatchObject({status: 'hidden', reasons: ['peers']});
    expect(assess({...signals, tokens: signals.tokens - 1})).toBeNull();
    expect(assess({...signals, rival: signals.rival + 1})).toBeNull();
    expect(assess({...signals, cohort: signals.cohort - 1})).toBeNull();
    expect(assess(day(policy.hideFloor))).toBeNull();
  });
  it('reviews volume, baseline jumps and extra reasons without hiding', () => {
    expect(assess(day(policy.volumeFloor))).toMatchObject({status: 'review', reasons: ['volume']});
    expect(assess(day(policy.volumeFloor - 1))).toBeNull();
    const baseline = policy.jumpFloor / policy.jumpRatio;
    expect(assess(day(policy.jumpFloor, {baseline}))).toMatchObject({status: 'review', reasons: ['jump']});
    expect(assess(day(policy.jumpFloor - 1, {baseline}))).toBeNull();
    expect(assess(day(policy.jumpFloor, {baseline: 0}))).toBeNull();
    expect(assess(day(1), ['template', 'template'])).toMatchObject({status: 'review', reasons: ['template']});
    expect(DAY_GATE).toBe(Math.min(policy.hideFloor, policy.volumeFloor, policy.jumpFloor));
  });
  it('takes the median of recent days', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('counts a lead crossing once and checks only whole configured increments', () => {
    const floor = policy.leadFloor;
    const rival = floor / policy.leadRatio;
    expect(crossesLead(floor - 1, floor, rival)).toBe(true);
    expect(crossesLead(floor, floor + 1, rival)).toBe(false);
    expect(crossesLead(floor - 1, floor, rival + 1)).toBe(false);
    expect(crossesLead(0, floor, 0)).toBe(false);
    expect(leadCheck(floor - 2, floor - 1)).toBeNull();
    expect(leadCheck(floor - 1, floor)).toBe(floor - policy.leadStep);
    expect(leadCheck(floor + 1, floor + policy.leadStep - 1)).toBeNull();
    expect(leadCheck(floor + 1, floor)).toBeNull();
    const laterLine = floor + policy.leadStep / 2;
    const before = laterLine + 1;
    const after = floor + policy.leadStep;
    expect(crossesLead(leadCheck(before, after)!, after, laterLine / policy.leadRatio)).toBe(true);
  });
});

describe('flag transitions with synthetic policy', () => {
  const finding = (status: 'review' | 'hidden', tokens = policy.hideFloor) => ({...day(tokens), status, reasons: status === 'hidden' ? ['peers' as const] : ['volume' as const]});
  const flag = (status: StoredFlag['status'], reviewed: boolean): StoredFlag => ({day: '2026-10-23', tokens: policy.hideFloor, status, reasons: ['volume'], reviewed});
  it('raises new flags, escalates review and retains automatic hidden status', () => {
    expect(nextFlag(undefined, finding('review'))).toMatchObject({status: 'review', detected: true});
    expect(nextFlag(flag('review', false), finding('hidden'))).toMatchObject({status: 'hidden', reasons: ['volume', 'peers'], detected: true});
    expect(nextFlag(flag('hidden', false), finding('review'))).toMatchObject({status: 'hidden', detected: false});
    expect(nextFlag(flag('review', false), finding('review'))).toMatchObject({status: 'review', detected: false});
  });
  it('preserves human decisions and reflags cleared days at configured growth', () => {
    const grown = policy.hideFloor * policy.reflagGrowth;
    expect(nextFlag(flag('cleared', true), finding('hidden', grown - 1))).toBeNull();
    expect(nextFlag(flag('cleared', true), finding('hidden', grown))).toMatchObject({status: 'hidden', detected: true});
    expect(nextFlag(flag('hidden', true), finding('review', grown))).toBeNull();
    expect(nextFlag(flag('review', true), finding('hidden', grown))).toBeNull();
  });
});
