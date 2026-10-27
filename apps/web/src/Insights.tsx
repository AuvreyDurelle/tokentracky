import type { UsageBreakdownRow } from '@tokentracky/core';

interface CostGroup { key: string; label: string; tokens: number; cost: number; unpriced: number }
/** Known cost and the tokens whose model has no price, grouped by `key`; largest cost first. */
export function costGroups(rows: UsageBreakdownRow[], key: (row: UsageBreakdownRow) => string, label: (key: string) => string = (value) => value): CostGroup[] {
  const groups = new Map<string, CostGroup>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id) ?? { key: id, label: label(id), tokens: 0, cost: 0, unpriced: 0 };
    group.tokens += row.tokens;
    if (row.costMicrousd === null) group.unpriced += row.tokens; else group.cost += row.costMicrousd;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label));
}
