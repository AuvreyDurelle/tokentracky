import type { ReactNode } from 'react';
import { BADGE_TIERS, type AchievementRarity, type BadgeProgress } from '@tokentracky/core';
import type { ApiClient } from '../api';
import { errorText, formatExact } from '../format';
import { utcToday } from '../ranges';
import { Loading, Notice } from '../ui';
import { ACHIEVEMENT_COPY, TIER_NAMES, formatBadgeValue, rarityText } from './achievement-copy';
import { GROUPS, JOIN_TO_EARN, localBadges, nextRatio, progressOf, shortValue, tierCounts, toGo, upNext } from './achievements';
import { Emblem } from './Emblem';
import { useLoad } from './load';

/** The Mac app's Achievements page with achievement badges: yours from the board once you've joined, worked out on this Mac before. */
export function AchievementsView({ api, me, revision }: { api: ApiClient; me: string | null; revision: string }) {
  const joined = useLoad(me ? () => api.profileStats(me).then((stats) => stats.badges) : null, [api, me, revision]);
  const local = useLoad(me ? null : () => api.localSummary({ days: 365 }), [api, me, revision]);
  // Rarity is optional: without the board the page still shows your progress.
  const rarity = useLoad(() => api.achievementRarity(), [api, revision]);
  const source = me ? joined : local;
  const badges = me ? joined.value : local.value && localBadges(local.value, utcToday());
  return <div className="m-page m-ach">
    <div className="page-head"><div>
      <h1 className="m-page-title">Achievements</h1>
      <p className="m-page-sub">Badges for how you build with AI, each in bronze, silver, gold and diamond.{rarity.value && rarity.value.builders > 0 && ` Rarity is the share of the ${formatExact(rarity.value.builders)} builders on the leaderboard who hold each one.`}</p>
    </div></div>
    {badges ? <AchievementsBody badges={badges} rarity={rarity.value} joined={me !== null} />
      : source.error ? <Notice tone="error">Could not load your badges: {errorText(source.error)}</Notice> : <Loading>Loading your badges…</Loading>}
  </div>;
}

/** The summary, "Up next" and every badge by group. `joined` false means the badges were worked out locally and podium and trendsetter can't be earned yet. */
export function AchievementsBody({ badges, rarity, joined }: { badges: BadgeProgress[]; rarity: AchievementRarity | null; joined: boolean }) {
  const counts = tierCounts(badges);
  const earned = badges.length - counts[0]!;
  const next = upNext(badges, joined ? [] : JOIN_TO_EARN);
  // Highest tiers first; the sort is stable, so ties keep display order.
  const best = badges.filter((badge) => badge.tier > 0).sort((a, b) => b.tier - a.tier).slice(0, 2);
  const byId = new Map(badges.map((badge) => [badge.id, badge]));
  const rarityOf = (badge: BadgeProgress) => rarity ? rarityText(rarity.holders[badge.id]?.[Math.max(badge.tier, 1) - 1] ?? 0, rarity.builders) : null;
  return <>
    <section className="m-card ach-hero" aria-label="Summary">
      <div className="hero-left">
        <Ring badges={badges} earned={earned} />
        <div className="cats">{[4, 3, 2, 1, 0].map((tier) => <div key={tier} className={`cat-row t${tier}`}>
          <span className="cat-dot" /><span className="cat-name">{tier ? TIER_NAMES[tier] : 'Not yet'}</span>
          <div className="cat-bar"><span style={{ width: `${(counts[tier]! / badges.length) * 100}%` }} /></div>
          <span className="cat-num num">{counts[tier]}<span className="of">/{badges.length}</span></span>
        </div>)}</div>
      </div>
      <div className="hero-right">
        <div className="hero-right-head"><span className="m-eyebrow">Your best</span>{best.length > 0 && <span className="note">Highest tiers so far</span>}</div>
        {best.length > 0
          ? <div className="feats">{best.map((badge) => <div key={badge.id} className={`feat t${badge.tier}`}>
            <div className="feat-art"><Sparkles /><Emblem id={badge.id} tier={badge.tier} /></div>
            <div className="feat-text">
              <span className="tier-chip">{TIER_NAMES[badge.tier]}</span>
              <div className="feat-name">{ACHIEVEMENT_COPY[badge.id].name}</div>
              <div className="feat-desc">{ACHIEVEMENT_COPY[badge.id].description}</div>
              <div className="feat-meta num">{formatBadgeValue(badge.id, badge.value)}{rarityOf(badge) && <> · <span>{rarityOf(badge)}</span></>}</div>
            </div>
          </div>)}</div>
          : <p className="feat-empty">No badges yet.{next[0] && ` ${ACHIEVEMENT_COPY[next[0].id].name} is closest: ${toGo(next[0])}.`}</p>}
      </div>
      <div className="hero-foot">{INFO}{joined
        ? 'Worked out on the leaderboard from the daily totals you publish, and updated as you sync.'
        : 'Worked out on this Mac from your last 365 days. They only count once you join the leaderboard.'}</div>
    </section>

    {next.length > 0 && <section className="ach-section">
      <div className="sec-head"><h2>Up next</h2><span className="sec-count">Closest to the next tier</span></div>
      <div className="next-grid">{next.map((badge) => {
        const percent = Math.floor((nextRatio(badge) ?? 1) * 100);
        return <div key={badge.id} className={`next-card t${badge.tier + 1}`}>
          <div className="next-top">
            <span className="next-emb"><Emblem id={badge.id} tier={badge.tier + 1} /></span>
            <div><div className="next-name">{ACHIEVEMENT_COPY[badge.id].name} <span className="tier-word">{TIER_NAMES[badge.tier + 1]}</span></div><div className="next-of num">{progressOf(badge)}</div></div>
            <div className="next-pct num">{percent}%</div>
          </div>
          <div className="next-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
          <div className="next-eta">{toGo(badge)}</div>
        </div>;
      })}</div>
    </section>}

    {GROUPS.map((group) => <section key={group.title} className="ach-section">
      <div className="sec-head"><h2>{group.title}</h2><span className="sec-count num">{group.ids.filter((id) => byId.get(id)!.tier > 0).length} of {group.ids.length} earned</span><p>{group.note}</p></div>
      <div className="grid3">{group.ids.map((id) => <BadgeCard key={id} badge={byId.get(id)!} rarity={rarityOf(byId.get(id)!)} blocked={!joined && JOIN_TO_EARN.includes(id)} />)}</div>
    </section>)}
  </>;
}

/** One badge: emblem, name and tier, its four thresholds, and progress to the next. `blocked`: it can't be earned before joining. */
function BadgeCard({ badge, rarity, blocked }: { badge: BadgeProgress; rarity: string | null; blocked: boolean }) {
  const { id, tier } = badge;
  const ratio = nextRatio(badge);
  return <div className={`ach-card t${tier}${tier ? '' : ' locked'}`}>
    <span className="emb-wrap"><Emblem id={id} tier={tier} />{!tier && <span className="lock">{LOCK}</span>}</span>
    <div className="ach-body">
      <div className="ach-name">{ACHIEVEMENT_COPY[id].name}{tier > 0 && <span className="tier-chip">{TIER_NAMES[tier]}</span>}</div>
      <div className="ach-desc">{ACHIEVEMENT_COPY[id].description}</div>
      <div className="ach-tiers">{BADGE_TIERS[id].map((threshold, index) => <span key={index} className={`tier-step t${index + 1}${tier > index ? ' on' : ''}`} title={`${TIER_NAMES[index + 1]}: ${shortValue(id, threshold)}`}><i />{shortValue(id, threshold)}</span>)}</div>
      {!blocked && ratio !== null && <div className="ach-bar" aria-hidden="true"><span style={{ width: `${ratio * 100}%` }} /></div>}
      <div className="ach-meta num">
        <span>{blocked ? 'Join the leaderboard to earn' : `${formatBadgeValue(id, badge.value)} · ${toGo(badge)}`}</span>
        {rarity && <span title={`Builders with ${TIER_NAMES[Math.max(tier, 1)]} or better`}>{rarity}</span>}
      </div>
    </div>
  </div>;
}

// Eleven arcs around the ring, highest tiers first, then the ones not yet earned.
const R = 56, GAP = 9;
const point = (degrees: number) => [64 + R * Math.cos((degrees * Math.PI) / 180), 64 + R * Math.sin((degrees * Math.PI) / 180)].map((value) => value.toFixed(2)).join(' ');
function Ring({ badges, earned }: { badges: BadgeProgress[]; earned: number }) {
  const step = 360 / badges.length;
  const tiers = badges.map((badge) => badge.tier).sort((a, b) => b - a);
  return <div className="ring" role="img" aria-label={`${earned} of ${badges.length} badges earned`}>
    <svg viewBox="0 0 128 128" aria-hidden="true">{tiers.map((tier, index) => {
      const from = -90 + index * step + GAP / 2, to = from + step - GAP;
      return <path key={index} className={`t${tier}`} d={`M${point(from)} A${R} ${R} 0 0 1 ${point(to)}`} />;
    })}</svg>
    <div className="ring-center" aria-hidden="true"><b className="num">{earned}</b><span>of {badges.length}</span></div>
  </div>;
}

const SPARKLE = 'M0-6Q.7-.7 6 0 .7.7 0 6-.7.7-6 0-.7-.7 0-6z';
function Sparkles() {
  return <svg className="sparkles" viewBox="0 0 140 120" aria-hidden="true">{[[18, 30, 0.9, 1], [122, 22, 0.6, 0.8], [116, 92, 1.1, 1], [26, 98, 0.55, 0.7], [70, 8, 0.45, 0.6]].map(([x, y, scale, opacity]) =>
    <path key={`${x}${y}`} transform={`translate(${x} ${y}) scale(${scale})`} d={SPARKLE} opacity={opacity} />)}</svg>;
}

const icon = (paths: ReactNode, width: number) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
const LOCK = icon(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, 2.6);
const INFO = icon(<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>, 2);
