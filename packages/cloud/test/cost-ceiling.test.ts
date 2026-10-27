import { describe, expect, it } from 'vitest';
import type { PublicBucket } from '@tokentracky/core';
import { ceiling, checkedCost } from '../src/cost-ceiling.ts';
import { CEILING_CASES } from '../src/generated/price-ceiling-cases.ts';

const bucket = (extra: Partial<PublicBucket>): PublicBucket => ({day: '2026-10-23', tool: 'claude', model: 'claude-sonnet-4-5', tokens: 0, costMicrousd: null, revision: 1, ...extra});
const kinds = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({input, output, cacheRead, cacheWrite, reasoning: 0});

describe('cost ceiling', () => {
  it('finds the ceiling the Rust table finds for every logged id', () => {
    for (const [model, tool, expected] of CEILING_CASES) expect(ceiling(model, tool), `${model} ${tool}`).toEqual(expected ?? undefined);
  });

  it('keeps every cost the Rust table gives, on its dearest tier', () => {
    for (const [model, tool, , priced] of CEILING_CASES) {
      for (const [input, output, cacheRead, cacheWrite, cost] of priced) {
        const b = bucket({tool, model, tokens: input + output + cacheRead + cacheWrite, costMicrousd: cost, breakdown: kinds(input, output, cacheRead, cacheWrite)});
        expect(checkedCost(b), `${model} ${tool} ${cost}`).toBe(cost);
      }
    }
  });

  it('allows 10% and one cent over the dearest rates, and no more', () => {
    // One million Sonnet output tokens at $15 per million, plus 10%, plus one cent.
    const output = bucket({tokens: 1_000_000, breakdown: kinds(0, 1_000_000, 0, 0)});
    expect(checkedCost({...output, costMicrousd: 16_510_000})).toBe(16_510_000);
    expect(checkedCost({...output, costMicrousd: 16_510_001})).toBeNull();
    expect(checkedCost(bucket({tokens: 1_000, costMicrousd: 50_000_000_000, breakdown: kinds(0, 1_000, 0, 0)}))).toBeNull();
  });

  it('bounds a bucket without token kinds by its dearest rate', () => {
    const older = bucket({tokens: 1_000_000});
    expect(checkedCost({...older, costMicrousd: 16_510_000})).toBe(16_510_000);
    expect(checkedCost({...older, costMicrousd: 16_510_001})).toBeNull();
  });

  it('drops a cost it cannot check', () => {
    const priced = {tokens: 100, costMicrousd: 5, breakdown: kinds(100, 0, 0, 0)};
    for (const model of ['other', 'unknown-model-x', 'constructor', '__proto__', undefined]) expect(checkedCost(bucket({...priced, model})), String(model)).toBeNull();
    // gpt-5-codex has no cache write rate, so no app could have priced one.
    expect(checkedCost(bucket({model: 'gpt-5-codex', tool: 'codex', tokens: 100, costMicrousd: 5, breakdown: kinds(0, 0, 0, 100)}))).toBeNull();
  });

  it('keeps unknown and zero costs whatever the model', () => {
    expect(checkedCost(bucket({model: 'other', tokens: 100, costMicrousd: null}))).toBeNull();
    expect(checkedCost(bucket({model: 'local/qwen3', tool: 'unsloth', tokens: 100, costMicrousd: 0}))).toBe(0);
  });
});
