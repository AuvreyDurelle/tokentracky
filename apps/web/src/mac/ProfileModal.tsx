import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { totalTokens, type BadgeProgress, type ProfileStats, type TokenCounts } from '@tokentracky/core';
import { ApiError, type ApiClient } from '../api';
import { KINDS, TOOLS, errorText, formatCompact, formatCost, formatCostCompact, formatExact, formatShare, shortDay } from '../format';
import { ProfileUsage } from '../ProfileUsage';
import { Avatar, Empty, Loading, Notice, ToolIcon } from '../ui';
import { ActivityGrid } from './ActivityGrid';
import { ACHIEVEMENT_COPY, TIER_NAMES } from './achievement-copy';
import { nextRatio, tierProgress } from './achievements';
import { Emblem } from './Emblem';
import { useLoad } from './load';

const MEMBER_SINCE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const SHOWN_MODELS = 6;
const tokensTitle = (tokens: number) => `${formatExact(tokens)} tokens`;
const days = (count: number) => `${formatExact(count)} ${count === 1 ? 'day' : 'days'}`;
const KIND_COLORS: Record<keyof Omit<TokenCounts, 'reasoning' | 'cacheWrite1h'>, string> = { input: 'var(--kind-input)', output: 'var(--kind-output)', cacheRead: 'var(--kind-cache-read)', cacheWrite: 'var(--kind-cache-write)' };

/** Each model with its bar width in percent of the largest (to one decimal). */
export function modelBars<T extends { tokens: number }>(models: T[]): Array<T & { width: number }> {
  const max = Math.max(0, ...models.map((model) => model.tokens));
  return models.map((model) => ({ ...model, width: max ? Math.round((model.tokens / max) * 1000) / 10 : 0 }));
}

/** A like flipped, with its count; flipping again rolls it back. */
export function toggleLike({ liked, likes }: { liked: boolean; likes: number }) { return { liked: !liked, likes: likes + (liked ? -1 : 1) }; }

/** A builder's profile over the leaderboard (leaderboard.html#profile), with likes through this Mac's link. */
export function ProfileModal({ api, alias, me, onClose }: { api: ApiClient; alias: string; me: string | null; onClose: () => void }) {
  const headingId = useId();
  const stats = useLoad(() => api.profileStats(alias), [api, alias]);
  // Null: no like button, on your own profile, on a Mac that isn't linked (409 CLOUD_NOT_LINKED) or while the state is unknown.
  const [liked, setLiked] = useState<boolean | null>(null);
  const [likes, setLikes] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    setLiked(null); setLikes(null);
    if (alias === me) return;
    let live = true;
    api.likeStatus(alias).then((status) => { if (live) setLiked(status.liked); }, () => {});
    return () => { live = false; };
  }, [api, alias, me]);
  const toggle = () => {
    if (liked === null || !stats.value || pending) return;
    const before = { liked, likes: likes ?? stats.value.likes };
    const after = toggleLike(before);
    setLiked(after.liked); setLikes(after.likes); setPending(true);
    (after.liked ? api.like(alias) : api.unlike(alias))
      .catch((error: unknown) => { setLiked(error instanceof ApiError && error.code === 'CLOUD_NOT_LINKED' ? null : before.liked); setLikes(before.likes); })
      .finally(() => setPending(false));
  };
  const missing = stats.error instanceof ApiError && stats.error.status === 404;
  return <ProfileDialog labelledBy={headingId} onClose={onClose}>
    {stats.value
      ? <ProfileCard stats={stats.value} likes={likes ?? stats.value.likes} like={liked === null ? null : { liked, pending }} onLike={toggle} onClose={onClose} headingId={headingId} />
      : <div className="pf-state">
        <div className="pf-actions"><CloseButton onClose={onClose} /></div>
        <h2 className="sr-only" id={headingId}>{alias}</h2>
        {missing ? <Empty title={`${alias} isn’t on the leaderboard`}>They may have left, or the name is mistyped.</Empty>
          : stats.error ? <Notice tone="error">Could not load this profile: {errorText(stats.error)}</Notice> : <Loading>Loading {alias}…</Loading>}
      </div>}
  </ProfileDialog>;
}

/** A modal dialog: Esc and a click outside the panel close it, Tab stays inside, and focus returns to what opened it. */
export function ProfileDialog({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { dialog?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  const trap = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]'))
      .filter((element) => !element.matches(':disabled, [tabindex="-1"]') && element.getClientRects().length > 0);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <dialog ref={ref} className="m-pf" role="dialog" aria-modal="true" aria-labelledby={labelledBy} onKeyDown={trap}
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="pf-panel">{children}</div>
  </dialog>;
}

/** The profile itself, from `profileStats`. `like` is null where you can't like (your profile, or this Mac isn't linked); the count still shows. */
export function ProfileCard({ stats, likes, like, onLike, onClose, headingId }: { stats: ProfileStats; likes: number; like: { liked: boolean; pending: boolean } | null; onLike: () => void; onClose: () => void; headingId: string }) {
  const [allModels, setAllModels] = useState(false);
  const rank = stats.periods.all.rank;
  const { activity } = stats;
  const favourite = stats.models?.[0] ?? null;
  const tools = TOOLS.map((tool) => ({ ...tool, tokens: stats.toolTokens?.[tool.id] ?? 0 })).filter((tool) => tool.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const toolSum = tools.reduce((sum, tool) => sum + tool.tokens, 0);
  const models = modelBars(stats.models ?? []);
  const modelCost = models.some((model) => model.costMicrousd !== undefined);
  const earned = stats.badges.filter((badge) => badge.tier > 0).length;
  return <>
    <div className="pf-cover">
      <div className="pf-actions">
        {like
          ? <button type="button" className={`pf-like${like.liked ? ' liked' : ''}`} aria-pressed={like.liked} disabled={like.pending} onClick={onLike}><Heart /><span className="sr-only">Like {stats.alias}, </span>{formatExact(likes)}</button>
          : <span className="pf-like" title={`${formatExact(likes)} ${likes === 1 ? 'like' : 'likes'}`}><Heart />{formatExact(likes)}</span>}
        <CloseButton onClose={onClose} />
      </div>
    </div>

    <div className="pf-id">
      <span className="pf-avatar"><Avatar alias={stats.alias} /></span>
      <div className="pf-who">
        <h2 className="pf-name" id={headingId}>{stats.alias}{rank > 0 && <span className={`m-badge${rank <= 3 ? ' gold' : ''}`}>{CROWN}#{formatExact(rank)} All time</span>}</h2>
        <div className="pf-meta">
          {stats.githubLogin && <><span>{GITHUB}@{stats.githubLogin}</span><i className="sep" /></>}
          <span>Member since {MEMBER_SINCE.format(new Date(`${stats.memberSince}T00:00:00Z`))}</span>
        </div>
      </div>
      {stats.githubLogin && <a className="m-btn" href={`https://github.com/${encodeURIComponent(stats.githubLogin)}`} target="_blank" rel="noreferrer">{EXTERNAL}GitHub</a>}
    </div>

    <div className="pf-stats">
      <div><div className="m-label">Total tokens</div><div className="v" title={tokensTitle(stats.periods.all.tokens)}>{formatCompact(stats.periods.all.tokens)}</div><div className="s">all time</div></div>
      <div><div className="m-label">Est. cost</div><div className="v" title={stats.costMicrousd == null ? undefined : formatCost(stats.costMicrousd)}>{stats.costMicrousd == null ? '—' : formatCostCompact(stats.costMicrousd)}</div>
        <div className="s">{stats.costMicrousd === undefined ? 'Not shared' : stats.costMicrousd === null ? 'Pricing unknown' : 'API list prices'}</div></div>
      <div><div className="m-label">Active days</div><div className="v">{formatExact(activity.activeDays)}</div><div className="s">days with usage</div></div>
      <div><div className="m-label">Avg / day</div><div className="v" title={tokensTitle(activity.averagePerActiveDay)}>{activity.activeDays ? formatCompact(activity.averagePerActiveDay) : '—'}</div><div className="s">per active day</div></div>
    </div>

    <div className="pf-high">
      <Highlight icon={FLAME} tone="flame" label="Current streak">{days(activity.currentStreak)} <small>· {activity.currentStreak > 0 && activity.currentStreak === activity.longestStreak ? 'best ever' : `best ${formatExact(activity.longestStreak)}`}</small></Highlight>
      <Highlight icon={ZAP} tone="zap" label="Best day">{activity.bestDay ? <><span title={tokensTitle(activity.bestDay.tokens)}>{formatCompact(activity.bestDay.tokens)}</span> <small>· {shortDay(activity.bestDay.day)}</small></> : '—'}</Highlight>
      <Highlight icon={STAR} tone="star" label={stats.models ? `Favourite · ${formatExact(stats.models.length)} ${stats.models.length === 1 ? 'model' : 'models'} used` : 'Favourite model'}>
        {favourite ? <span className="fav-model">{favourite.model}</span> : <small>{stats.models ? 'None yet' : 'Not shared'}</small>}</Highlight>
    </div>

    <div className="pf-sec"><ProfileUsage daily={stats.daily} hours={stats.hours} /></div>

    {stats.breakdown && <TokenTypes breakdown={stats.breakdown} />}

    <div className="pf-sec"><ActivityGrid days={stats.daily} stats={activity} label="Activity · last 12 months" /></div>

    <div className="pf-sec pf-mix">
      <div className="pf-sec-head"><h3>Tool mix</h3>{tools.length > 0 && <span>{tools.length} {tools.length === 1 ? 'tool' : 'tools'}</span>}</div>
      {!stats.toolTokens ? <p className="pf-none">{stats.alias} doesn’t share a tool split.</p> : !toolSum ? <p className="pf-none">No tool usage yet.</p> : <>
        <div className="m-bar" role="img" aria-label={tools.map((tool) => `${tool.label} ${formatShare(tool.tokens, toolSum)}`).join(', ')}>
          {tools.map((tool) => <span key={tool.id} style={{ width: `${(tool.tokens / toolSum) * 100}%`, '--c': `var(--tool-${tool.id})` } as CSSProperties} />)}
        </div>
        <div className="pf-legend" aria-hidden="true">{tools.map((tool) => <span key={tool.id}><ToolIcon id={tool.id} />{tool.label}<em><b>{formatCompact(tool.tokens)}</b> · {formatShare(tool.tokens, toolSum)}</em></span>)}</div>
      </>}
    </div>

    <div className="pf-sec">
      <div className="pf-sec-head"><h3>Top models</h3>{models.length > 0 && <span>Tokens{modelCost && ' · Est. cost'}</span>}</div>
      {!stats.models ? <p className="pf-none">{stats.alias} doesn’t share a model mix.</p> : !models.length ? <p className="pf-none">No model usage yet.</p>
        : <div className="pf-models">
          {models.slice(0, allModels ? undefined : SHOWN_MODELS).map((model, index) => <div key={model.model} className="pf-model">
            <span className="idx">{index + 1}</span>
            <span className="model" title={model.model}>{model.model}</span>
            <div className="bar-track" aria-hidden="true"><span style={{ width: `${model.width}%` }} /></div>
            <span className="tok" title={tokensTitle(model.tokens)}>{formatCompact(model.tokens)}</span>
            {modelCost && <span className="usd" title={model.costMicrousd == null ? undefined : formatCost(model.costMicrousd)}>{model.costMicrousd == null ? '—' : formatCostCompact(model.costMicrousd)}</span>}
          </div>)}
          {models.length > SHOWN_MODELS && <button type="button" className="pf-more" aria-expanded={allModels} onClick={() => setAllModels((value) => !value)}>{allModels ? 'Show fewer' : `Show all ${formatExact(models.length)} models`}</button>}
        </div>}
    </div>

    <div className="pf-sec">
      <div className="pf-sec-head"><h3>Badges</h3><span>{earned} of {stats.badges.length} earned</span></div>
      <div className="pf-badges">{stats.badges.map((badge) => <BadgeTile key={badge.id} badge={badge} />)}</div>
    </div>

    <div className="pf-foot"><button type="button" className="m-btn" onClick={onClose}>Close</button></div>
  </>;
}

/** The all-time split by token type, drawn like the tool mix. Reasoning is part of output, never added again. */
function TokenTypes({ breakdown }: { breakdown: TokenCounts }) {
  const total = totalTokens(breakdown);
  const shown = KINDS.filter((kind) => breakdown[kind.key] > 0);
  return <div className="pf-sec pf-mix">
    <div className="pf-sec-head"><h3>Token types</h3><span>All time · share of {formatExact(total)} tokens</span></div>
    {!total ? <p className="pf-none">No token usage yet.</p> : <>
      <div className="m-bar" role="img" aria-label={shown.map((kind) => `${kind.label} ${formatShare(breakdown[kind.key], total)}`).join(', ')}>
        {shown.map((kind) => <span key={kind.key} style={{ width: `${(breakdown[kind.key] / total) * 100}%`, '--c': KIND_COLORS[kind.key] } as CSSProperties} />)}
      </div>
      <div className="pf-legend" aria-hidden="true">{KINDS.map((kind) => <span key={kind.key}><i className="pf-key" style={{ background: KIND_COLORS[kind.key] }} />{kind.label}
        <em title={tokensTitle(breakdown[kind.key])}><b>{formatCompact(breakdown[kind.key])}</b> · {formatShare(breakdown[kind.key], total)}</em>
        {kind.key === 'output' && <em>Of which reasoning {formatCompact(breakdown.reasoning ?? 0)}</em>}</span>)}</div>
    </>}
  </div>;
}

/** One badge: its emblem in the tier's colour, and how far it is to the next tier. */
function BadgeTile({ badge }: { badge: BadgeProgress }) {
  const ratio = nextRatio(badge);
  const progress = tierProgress(badge);
  return <div className={`pf-badge${badge.tier ? '' : ' locked'}`} title={ACHIEVEMENT_COPY[badge.id].description}>
    <Emblem id={badge.id} tier={badge.tier} />
    <div className="pf-badge-body">
      <div className="pf-badge-name"><b>{ACHIEVEMENT_COPY[badge.id].name}</b>{badge.tier > 0 && <span className={`pf-tier t${badge.tier}`}>{TIER_NAMES[badge.tier]}</span>}</div>
      <div className="pf-badge-meta" title={progress}>{progress}</div>
      <div className="pf-badge-bar" aria-hidden="true"><span style={{ width: `${(ratio ?? 1) * 100}%` }} /></div>
    </div>
  </div>;
}

function Highlight({ icon, tone, label, children }: { icon: ReactNode; tone: string; label: string; children: ReactNode }) {
  return <div className="hl"><span className={`hl-ic ${tone}`}>{icon}</span><div className="hl-text"><div className="k">{label}</div><div className="v">{children}</div></div></div>;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return <button type="button" className="pf-x" aria-label="Close" onClick={onClose}>{svg(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, 2)}</button>;
}

const svg = (paths: ReactNode, width = 1.8) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
export const Heart = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /></svg>;
export const CROWN = svg(<><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" /><path d="M5 21h14" /></>, 2);
export const GITHUB = svg(<><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /><path d="M9 18c-4.51 2-5-2-7-2" /></>);
const EXTERNAL = svg(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>);
const FLAME = svg(<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />);
export const ZAP = svg(<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />);
const STAR = svg(<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />);
