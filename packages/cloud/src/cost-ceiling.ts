import type { PublicBucket, ToolId } from '@tokentracky/core';
import { PRICE_CEILINGS, type Ceiling } from './generated/price-ceilings.ts';

/**
 * The hosted check on published costs. The app prices each event and uploads the totals; this keeps a total only when
 * its tokens could cost that much at the model's dearest list rates. The lookup mirrors `candidates` in
 * `crates/pricing/src/table.rs`, and `cost-ceiling.test.ts` checks it against the Rust table.
 */

/** Model families whose provider's own entries carry a prefix only, and that prefix. */
const PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['glm-', 'zai/'], ['kimi-', 'moonshot/'], ['minimax-', 'minimax/'], ['qwen', 'dashscope/'],
  ['grok-', 'xai/'], ['deepseek-', 'deepseek/'], ['mimo-', 'xiaomi_mimo/'], ['gemini-', 'gemini/'],
];
const REGIONS = ['us.', 'eu.', 'apac.', 'global.', 'jp.', 'au.'];
/** Room for each event's half-up rounding and for an app on a newer price table: 10% plus one cent. */
const MARGIN_PERCENT = 10n;
const SLACK_MICROUSD = 10_000n;

const digits = (s: string): boolean => /^[0-9]+$/.test(s);

/** Removes a trailing `shape`, where `#` stands for one ASCII digit. */
function stripShape(s: string, shape: string): string | undefined {
  const at = s.length - shape.length;
  if (at < 0) return undefined;
  for (let i = 0; i < shape.length; i++) {
    const c = s[at + i]!;
    if (shape[i] === '#' ? !digits(c) : c !== shape[i]) return undefined;
  }
  return s.slice(0, at);
}

/** Removes a trailing Bedrock version such as `-v1` or `-v1:0`. */
function stripBedrockVersion(s: string): string {
  for (let at = s.indexOf('-v'); at !== -1; at = s.indexOf('-v', at + 1)) {
    const version = s.slice(at + 2);
    const colon = version.indexOf(':');
    if (colon === -1 ? digits(version) : digits(version.slice(0, colon)) && digits(version.slice(colon + 1))) return s.slice(0, at);
  }
  return s;
}

/** Normalized candidates, most specific first. Logged ids may carry dates, regions, provider prefixes or Claude Code's context suffix. */
function candidates(model: string, tool: ToolId | 'all'): string[] {
  const lowered = model.trim().toLowerCase();
  // A trailing `[...]` group, such as Claude Code's `[1m]`.
  let id = lowered;
  if (lowered.endsWith(']')) {
    const body = lowered.slice(0, -1);
    const at = body.indexOf('[', body.lastIndexOf(']') + 1);
    if (at !== -1) id = lowered.slice(0, at);
  }
  const bare = id.slice(id.lastIndexOf('/') + 1);
  let unwrapped = bare;
  const region = REGIONS.find(prefix => unwrapped.startsWith(prefix));
  if (region) unwrapped = unwrapped.slice(region.length);
  if (unwrapped.startsWith('anthropic.')) unwrapped = unwrapped.slice('anthropic.'.length);
  unwrapped = stripBedrockVersion(unwrapped);
  unwrapped = stripShape(unwrapped, '@########') ?? unwrapped;
  const undated = stripShape(unwrapped, '-####-##-##') ?? stripShape(unwrapped, '-########') ?? unwrapped;
  const list: string[] = [];
  if (tool === 'gemini') list.push(`gemini/${bare}`, `gemini/${undated}`);
  if (tool === 'grok' && bare.endsWith('-build')) {
    const grok = bare.slice(0, -'-build'.length);
    list.push(`xai/${grok}`, grok);
  }
  list.push(id, bare, unwrapped, undated);
  if (unwrapped.startsWith('claude-') && unwrapped.includes('.')) list.push(unwrapped.replaceAll('.', '-'), undated.replaceAll('.', '-'));
  const provider = PROVIDERS.find(([family]) => bare.startsWith(family))?.[1];
  if (provider) list.push(`${provider}${bare}`, `${provider}${unwrapped}`, `${provider}${undated}`);
  return list;
}

/** The ceiling the bundled price table has for a logged model id, or `undefined` when it has no price for it. */
export function ceiling(model: string, tool: ToolId | 'all'): Ceiling | undefined {
  for (const candidate of candidates(model, tool)) {
    const found = PRICE_CEILINGS.get(candidate);
    if (found) return found;
  }
  return undefined;
}

/**
 * The cost a bucket may publish: its own, or `null` (unknown) when that is above what its tokens could cost at the
 * model's dearest rates, or when there is no price here to check it against. A cost of 0 always stands. A bucket from
 * an older app has no token kinds, so every token may be the dearest kind.
 */
export function checkedCost(bucket: PublicBucket): number | null {
  const cost = bucket.costMicrousd;
  if (!cost) return cost;
  const rates = bucket.model === undefined ? undefined : ceiling(bucket.model, bucket.tool);
  if (!rates) return null;
  const k = bucket.breakdown;
  const priced: Array<[number, number | null]> = k
    ? [[k.input, rates[0]], [k.output, rates[1]], [k.cacheRead, rates[2]], [k.cacheWrite, rates[3]]]
    : [[bucket.tokens, Math.max(...rates.map(rate => rate ?? 0))]];
  let picodollars = 0n;
  for (const [count, rate] of priced) {
    if (count === 0) continue;
    // The app cannot price a kind the model has no rate for.
    if (rate === null) return null;
    picodollars += BigInt(count) * BigInt(rate);
  }
  const limit = (picodollars * (100n + MARGIN_PERCENT) + 99_999_999n) / 100_000_000n + SLACK_MICROUSD;
  return BigInt(cost) <= limit ? cost : null;
}
