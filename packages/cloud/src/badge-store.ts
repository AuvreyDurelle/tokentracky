// Stored achievements (F7): the SQL that computes, stores and reads badges. The rules are in @tokentracky/core (badges.ts);
// the repository decides when they run. `schema` is the repository's quoted schema.
import type { Pool, PoolClient } from 'pg';
import { BADGE_IDS, badgeInputs, badgeProgress, type AchievementRarity, type BadgeId } from '@tokentracky/core';
import { safe } from './errors.ts';

/** A member's buckets for badges: the `cloud_account_buckets` view (0012), where a bucket copied between computers counts once. */
const ACCOUNT_BUCKETS = 'cloud_account_buckets';
/** For buckets `b` of publications `p`: only history the member published (`history_start`). */
const PUBLISHED_DAY = `(p.history_start IS NULL OR (b.day_key <> 'unknown' AND b.day_key >= to_char(p.history_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')))`;
/** For publications `p`: hidden and banned accounts are absent, as in the repository's `visible`. */
const visible = (schema: string) => `NOT EXISTS (SELECT 1 FROM ${schema}.cloud_public_exclusions h WHERE h.account_id = p.account_id)`;

/**
 * Achievements for one account from its published buckets, stored so public reads never compute them. Callers hold the
 * account lock and have written the buckets. Tool, model and trendsetter badges need that mix shared.
 */
export async function storeBadges(client: PoolClient, schema: string, accountId: string, today: string): Promise<void> {
  const mine = `FROM cloud_publications p JOIN ${ACCOUNT_BUCKETS} b ON b.account_id = p.account_id WHERE p.account_id = $1 AND ${PUBLISHED_DAY}`;
  const daily = await client.query<{day: string; tokens: string}>(`SELECT b.day_key AS day, sum(b.tokens) AS tokens ${mine} GROUP BY b.day_key`, [accountId]);
  const mix = await client.query<{tools: number; models: number}>(`SELECT count(DISTINCT b.tool) FILTER (WHERE p.share_tools AND b.tool <> 'all')::int AS tools,
    count(DISTINCT b.model) FILTER (WHERE p.share_models AND b.model <> '')::int AS models ${mine} AND b.tokens > 0`, [accountId]);
  // Trendsetter: models this member used within 7 days of the model's first day across visible members.
  const trend = await client.query<{models: number}>(`
    WITH firsts AS (SELECT b.model, min(b.day_key)::date AS day ${mine} AND p.share_models AND b.model <> '' AND b.day_key <> 'unknown' AND b.tokens > 0 GROUP BY b.model),
      board AS (SELECT b.model, min(b.day_key)::date AS day FROM cloud_publications p JOIN ${ACCOUNT_BUCKETS} b ON b.account_id = p.account_id
        WHERE b.model IN (SELECT model FROM firsts) AND b.day_key <> 'unknown' AND b.tokens > 0 AND ${PUBLISHED_DAY} AND ${visible(schema)} GROUP BY b.model)
    SELECT count(*)::int AS models FROM firsts JOIN board USING (model) WHERE firsts.day <= board.day + 7`, [accountId]);
  // Podium: the all-time rank exactly as `rankings` orders it (tokens, then alias by code point, like its JS comparison),
  // on this transaction so it sees this upload. A hidden member or one without tokens has no rank, so `least` keeps the
  // stored one. Others' uploads can only push a rank down; it rises through the member's own uploads, or when someone
  // above leaves, which the next upload records. `rankings` reads the same view.
  const best = await client.query<{best_rank: number | null}>(`
    WITH totals AS (SELECT p.account_id, p.alias, coalesce(sum(b.tokens), 0) AS tokens FROM cloud_publications p
        LEFT JOIN ${ACCOUNT_BUCKETS} b ON b.account_id = p.account_id AND ${PUBLISHED_DAY} WHERE ${visible(schema)} GROUP BY p.account_id, p.alias),
      me AS (SELECT tokens, alias FROM totals WHERE account_id = $1 AND tokens > 0)
    UPDATE cloud_publications SET best_rank = least(best_rank, (SELECT 1 + (count(*) FILTER (WHERE t.tokens > me.tokens
        OR (t.tokens = me.tokens AND t.alias COLLATE "C" < me.alias COLLATE "C")))::int FROM me CROSS JOIN totals t GROUP BY me.tokens, me.alias))
    WHERE account_id = $1 RETURNING best_rank`, [accountId]);
  const totals = daily.rows.map(row => ({day: row.day, tokens: safe(row.tokens)}));
  const inputs = badgeInputs(totals.filter(row => row.day !== 'unknown'), today);
  const values: Record<BadgeId, number> = {
    // Undated usage counts toward the total, as on the all-time leaderboard.
    'token-titan': safe(totals.reduce((sum, row) => sum + row.tokens, 0)), 'big-day': inputs.bestDay, marathoner: inputs.activeDays, streak: inputs.longestStreak,
    'weekend-warrior': inputs.weekendDays, momentum: inputs.momentum, veteran: inputs.veteran, podium: best.rows[0]!.best_rank ?? 0,
    multitool: mix.rows[0]!.tools, polyglot: mix.rows[0]!.models, trendsetter: trend.rows[0]!.models,
  };
  const badges = BADGE_IDS.map(id => badgeProgress(id, values[id]));
  await client.query(`INSERT INTO cloud_badges(account_id, badge, tier, value) SELECT $1::text, * FROM unnest($2::text[], $3::smallint[], $4::bigint[])
    ON CONFLICT (account_id, badge) DO UPDATE SET tier = EXCLUDED.tier, value = EXCLUDED.value, computed_at = now()`,
  [accountId, badges.map(badge => badge.id), badges.map(badge => badge.tier), badges.map(badge => badge.value)]);
}

/** Each alias's three highest stored badges, ties in display order: one query for a page of rows; nothing is computed. */
export async function topBadges(client: PoolClient, schema: string, aliases: string[]): Promise<Map<string, BadgeId[]>> {
  const top = await client.query<{alias: string; badges: BadgeId[]}>(`
    SELECT p.alias, (array_agg(b.badge ORDER BY b.tier DESC, array_position($2::text[], b.badge)))[1:3] AS badges
    FROM ${schema}.cloud_publications p JOIN ${schema}.cloud_badges b ON b.account_id = p.account_id
    WHERE p.alias = ANY($1) AND b.tier > 0 GROUP BY p.alias`, [aliases, BADGE_IDS]);
  return new Map(top.rows.map(row => [row.alias, row.badges]));
}

/** How many visible members hold each badge at each tier, from stored badges. The rollup row counts the members. */
export async function rarity(pool: Pool, schema: string): Promise<AchievementRarity> {
  const result = await pool.query<{badge: BadgeId | null; everyone: boolean; members: number; holders: number[]}>(`
    SELECT b.badge, GROUPING(b.badge) = 1 AS everyone, count(DISTINCT p.account_id)::int AS members,
      ARRAY[count(*) FILTER (WHERE b.tier >= 1), count(*) FILTER (WHERE b.tier >= 2), count(*) FILTER (WHERE b.tier >= 3), count(*) FILTER (WHERE b.tier >= 4)]::int[] AS holders
    FROM ${schema}.cloud_publications p LEFT JOIN ${schema}.cloud_badges b ON b.account_id = p.account_id
    WHERE ${visible(schema)} GROUP BY ROLLUP (b.badge)`);
  const holders: AchievementRarity['holders'] = {};
  for (const row of result.rows) if (!row.everyone && row.badge) holders[row.badge] = row.holders;
  return {builders: result.rows.find(row => row.everyone)?.members ?? 0, holders};
}
