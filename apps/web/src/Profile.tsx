import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rankingWindow, totalTokens, type BadgeProgress, type Period, type ProfileStats, type TokenCounts } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { INSTALL_COMMAND, MAC_DOWNLOAD } from './download-config';
import { KINDS, TOOLS, errorText, formatCompact, formatCost, formatCostCompact, formatExact, formatShare, shortDay, topPercent } from './format';
import { Heatmap } from './Heatmap';
import { ProfileUsage } from './ProfileUsage';
import { AppleIcon, Avatar, CopyCommand, Empty, Loading, Notice, Segmented, ToolIcon } from './ui';
import { ACHIEVEMENT_COPY, TIER_NAMES } from './mac/achievement-copy';
import { nextRatio, tierProgress } from './mac/achievements';
import { Emblem } from './mac/Emblem';
import { ICONS } from './mac/icons';
import { CROWN, GITHUB, Heart, ZAP, modelBars, toggleLike } from './mac/ProfileModal';

/** README markdown for a profile badge that links back to the profile. */
export function badgeMarkdown(origin: string, alias: string): string {
  return `[![Tokentracky](${origin}/badge/${alias}.svg)](${origin}/u/${alias}?ref=readme)`;
}

const WINDOWS: Record<Period, string> = { week: 'this week', month: 'this month', all: 'all time' };

/** X's post composer with the window's rank and tokens and the tagged profile link. A link cannot attach the card, so the member pastes it. */
export function xShareUrl(stats: ProfileStats, origin: string, period: Period): string {
  const { rank, tokens } = stats.periods[period];
  const text = `${stats.alias} is #${rank} on the Tokentracky leaderboard ${WINDOWS[period]}, with ${formatCompact(tokens)} tokens.`;
  return `https://x.com/intent/post?${new URLSearchParams({ text, url: `${origin}/u/${stats.alias}?ref=share` }).toString()}`;
}

/** A shareable `/u/:alias` page with everything the builder publishes. A signed-in visitor can like it. */
export function ProfilePage({ api, alias, me, signedIn, origin, join, onLeaderboard }: { api: ApiClient; alias: string; me: string | null; signedIn: boolean; origin: string | null; join: JoinAction | null; onLeaderboard: () => void }) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Null: no like button, signed out, on your own profile or while the state loads.
  const [liked, setLiked] = useState<boolean | null>(null);
  const [likes, setLikes] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    api.profileStats(alias).then((value) => { if (live) setStats(value); }).catch((value: unknown) => { if (live) setError(value); });
    return () => { live = false; };
  }, [api, alias]);
  useEffect(() => {
    setLiked(null); setLikes(null);
    if (!signedIn || alias === me) return;
    let live = true;
    api.profileLikeStatus(alias).then((status) => { if (live) setLiked(status.liked); }, () => {});
    return () => { live = false; };
  }, [api, alias, me, signedIn]);
  const toggle = () => {
    if (liked === null || !stats || pending) return;
    const before = { liked, likes: likes ?? stats.likes };
    const after = toggleLike(before);
    setLiked(after.liked); setLikes(after.likes); setPending(true);
    (after.liked ? api.likeProfile(alias) : api.unlikeProfile(alias))
      .catch(() => { setLiked(before.liked); setLikes(before.likes); })
      .finally(() => setPending(false));
  };
  if (error instanceof ApiError && error.status === 404) return <div className="page-stack"><Empty title={`${alias} isn’t on the leaderboard`} action={<button type="button" className="btn" onClick={onLeaderboard}>See the leaderboard</button>}>They may have deleted their account, or the name is mistyped.</Empty></div>;
  if (error) return <div className="page-stack"><Notice tone="error">Could not load this profile: {errorText(error)}</Notice></div>;
  if (!stats) return <Loading>Loading profile…</Loading>;
  return <ProfileView stats={stats} me={me} origin={origin} join={join} onLeaderboard={onLeaderboard} likes={likes ?? stats.likes} like={liked === null ? null : { liked, pending }} onLike={toggle} />;
}

type JoinAction = { label: string; onClick: () => void };
const plural = (count: number, word: string) => `${formatExact(count)} ${word}${count === 1 ? '' : 's'}`;

const MEMBER_SINCE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
/** Models listed before "Show all". */
const SHOWN_MODELS = 6;

/** Identity with likes, stats, highlights and the usage chart; the year of activity, tool mix, top models and badges. The aside holds the join card (only for a viewer who can still join) and the share card.
 *  `like` is null where you can't like (signed out, or your own profile); the count still shows. */
export function ProfileView({ stats, me, origin, join, onLeaderboard, likes = stats.likes, like = null, onLike = () => {} }: {
  stats: ProfileStats; me: string | null; origin: string | null; join: JoinAction | null; onLeaderboard: () => void;
  likes?: number; like?: { liked: boolean; pending: boolean } | null; onLike?: () => void;
}) {
  const { all, week } = stats.periods;
  const { activity } = stats;
  const favourite = stats.models?.[0] ?? null;
  const showCost = stats.costMicrousd !== undefined;
  const top = topPercent(all.rank, all.builders);
  const share = () => document.getElementById('share')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return <div className="page-stack">
    <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="link" onClick={onLeaderboard}>Leaderboard</button><span aria-hidden="true">/</span><strong>{stats.alias}</strong><span className="push">Client-reported usage · UTC days</span></nav>
    <div className="profile-layout">
      <section className="panel profile-card" aria-label="Profile">
        <div className="profile-cover" aria-hidden="true" />
        <div className="profile-id">
          <span className="profile-avatar"><Avatar alias={stats.alias} /></span>
          <div className="profile-who">
            <h1>{stats.alias}{stats.alias === me && <span className="badge">You</span>}
              {all.rank > 0 && <span className={`badge${all.rank <= 3 ? ' gold' : ' plain'}`}>{CROWN}#{formatExact(all.rank)} All time</span>}
              {week.rank > 0 && <span className="badge plain">#{formatExact(week.rank)} This week</span>}</h1>
            <p className="profile-meta">
              {stats.githubLogin && <><a href={`https://github.com/${encodeURIComponent(stats.githubLogin)}`} target="_blank" rel="noreferrer">{GITHUB}@{stats.githubLogin}</a><i className="profile-sep" aria-hidden="true" /></>}
              <span>Member since {MEMBER_SINCE.format(new Date(`${stats.memberSince}T00:00:00Z`))}</span>
            </p>
          </div>
          <div className="profile-btns">
            {like
              ? <button type="button" className="btn profile-like" aria-pressed={like.liked} disabled={like.pending} onClick={onLike}><Heart /><span className="sr-only">Like {stats.alias}, </span><b className="num">{formatExact(likes)}</b></button>
              : <span className="btn profile-like" title={`${formatExact(likes)} ${likes === 1 ? 'like' : 'likes'}${me === stats.alias ? '' : ' · sign in to like'}`}><Heart /><b className="num">{formatExact(likes)}</b></span>}
            <button type="button" className="btn" onClick={share}>Share</button>
          </div>
        </div>
        <dl className="stats profile-stats">
          <div><dt>Total tokens</dt><dd title={`${formatExact(all.tokens)} tokens`}>{formatCompact(all.tokens)}</dd><small>{top ?? 'All time'}</small></div>
          <div><dt>Est. cost</dt><dd title={stats.costMicrousd == null ? undefined : formatCost(stats.costMicrousd)}>{stats.costMicrousd == null ? '—' : formatCostCompact(stats.costMicrousd)}</dd><small>{!showCost ? 'Not shared' : stats.costMicrousd === null ? 'Pricing unknown' : 'API list prices'}</small></div>
          <div><dt>Active days</dt><dd>{formatExact(activity.activeDays)}</dd><small>Last 12 months</small></div>
          <div><dt>Avg / day</dt><dd>{activity.activeDays ? formatCompact(activity.averagePerActiveDay) : '—'}</dd><small>Per active day</small></div>
        </dl>
        <div className="profile-high">
          <Highlight icon={ICONS.flame} tone="flame" label="Current streak">{plural(activity.currentStreak, 'day')}{activity.longestStreak > 0 && <small>{activity.currentStreak === activity.longestStreak ? ' · best ever' : ` · best ${plural(activity.longestStreak, 'day')}`}</small>}</Highlight>
          <Highlight icon={ZAP} tone="zap" label="Best day">{activity.bestDay ? <>{formatCompact(activity.bestDay.tokens)}<small> · {shortDay(activity.bestDay.day)}</small></> : '—'}</Highlight>
          <Highlight icon={ICONS.star} tone="star" label={`Favourite${stats.models && stats.models.length > 1 ? ` · ${stats.models.length} models used` : ''}`}><span className="mono" title={favourite?.model}>{favourite?.model ?? '—'}</span></Highlight>
        </div>
        <ProfileUsage daily={stats.daily} />
      </section>
      <aside className="profile-aside">
        {join && <JoinCard alias={stats.alias} join={join} />}
        <ShareCard stats={stats} origin={origin} />
      </aside>
      <div className="profile-rest">
        {stats.breakdown && <ProfileTypes breakdown={stats.breakdown} />}
        <section className="panel" aria-label="Activity">
          <header className="panel-head"><h2>Activity</h2><span className="push faint">Last 52 weeks · UTC</span></header>
          <div className="panel-body"><Heatmap days={stats.daily} label="Tokens per UTC day, last 12 months" /></div>
        </section>
        <ProfileMix toolTokens={stats.toolTokens} />
        <ProfileModels models={stats.models} showCost={showCost} />
        {stats.badges.length > 0 && <section className="panel" aria-label="Achievements">
          <header className="panel-head"><h2>Achievements</h2><span className="push faint">{stats.badges.filter((badge) => badge.tier > 0).length} of {stats.badges.length} earned</span></header>
          <div className="panel-body profile-badges">{stats.badges.map((badge) => <ProfileBadge key={badge.id} badge={badge} />)}</div>
        </section>}
      </div>
    </div>
    <p className="privacy-line">Profiles show each builder’s daily token totals, tool split, model mix and estimated cost; deleting the account removes them. Prompts, code and project names never leave their computer.</p>
  </div>;
}

function Highlight({ icon, tone, label, children }: { icon: ReactNode; tone: string; label: string; children: ReactNode }) {
  return <div className="profile-hl"><span className={`profile-hl-ic ${tone}`}>{icon}</span><div><div className="profile-hl-label">{label}</div><div className="profile-hl-value">{children}</div></div></div>;
}

/** The tool split: one bar, and each tool's tokens and share, largest first. */
function ProfileMix({ toolTokens }: { toolTokens: ProfileStats['toolTokens'] }) {
  const tools = TOOLS.map((tool) => ({ ...tool, tokens: toolTokens?.[tool.id] ?? 0 })).filter((tool) => tool.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const sum = tools.reduce((total, tool) => total + tool.tokens, 0);
  return <section className="panel" aria-label="Tool mix">
    <header className="panel-head"><h2>Tool mix</h2>{tools.length > 0 && <span className="push faint">{plural(tools.length, 'tool')}</span>}</header>
    <div className="panel-body">{!toolTokens ? <p className="muted">No tool split synced yet.</p> : !sum ? <p className="muted">No tool usage yet.</p> : <>
      <div className="mix-bar" role="img" aria-label={tools.map((tool) => `${tool.label} ${formatShare(tool.tokens, sum)}`).join(', ')}>
        {tools.map((tool) => <i key={tool.id} className={`tool-${tool.id}`} style={{ width: `${(tool.tokens / sum) * 100}%` }} />)}
      </div>
      <ul className="profile-legend" aria-hidden="true">{tools.map((tool) => <li key={tool.id}><ToolIcon id={tool.id} />{tool.label}<em><b>{formatCompact(tool.tokens)}</b> · {formatShare(tool.tokens, sum)}</em></li>)}</ul>
    </>}</div>
  </section>;
}

/** Models by tokens, each with a bar against the largest; the first six until "Show all". */
function ProfileModels({ models, showCost }: { models: ProfileStats['models']; showCost: boolean }) {
  const [all, setAll] = useState(false);
  const rows = modelBars(models ?? []);
  return <section className="panel" aria-label="Top models">
    <header className="panel-head"><h2>Top models</h2>{rows.length > 0 && <span className="push faint">Tokens{showCost && ' · Est. cost'}</span>}</header>
    {rows.length ? <div className="profile-models">
      {rows.slice(0, all ? undefined : SHOWN_MODELS).map((model, index) => <div key={model.model} className="profile-model">
        <span className="profile-idx num">{index + 1}</span>
        <span className="profile-model-name mono" title={model.model}>{model.model}</span>
        <div className="profile-track" aria-hidden="true"><span style={{ width: `${model.width}%` }} /></div>
        <span className="profile-tok num" title={`${formatExact(model.tokens)} tokens`}>{formatCompact(model.tokens)}</span>
        {showCost && <span className="profile-cost num" title={model.costMicrousd == null ? undefined : formatCost(model.costMicrousd)}>{model.costMicrousd == null ? '—' : formatCostCompact(model.costMicrousd)}</span>}
      </div>)}
      {rows.length > SHOWN_MODELS && <button type="button" className="profile-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>{all ? 'Show fewer' : `Show all ${formatExact(rows.length)} models`}</button>}
    </div> : <p className="panel-empty">No model usage synced yet.</p>}
  </section>;
}

/** One badge: its emblem in the tier's colour, and how far it is to the next tier. */
function ProfileBadge({ badge }: { badge: BadgeProgress }) {
  const progress = tierProgress(badge);
  return <div className={`profile-badge${badge.tier ? '' : ' profile-locked'}`} title={ACHIEVEMENT_COPY[badge.id].description}>
    <Emblem id={badge.id} tier={badge.tier} />
    <div className="profile-badge-body">
      <div className="profile-badge-name"><b>{ACHIEVEMENT_COPY[badge.id].name}</b>{badge.tier > 0 && <span className={`profile-tier t${badge.tier}`}>{TIER_NAMES[badge.tier]}</span>}</div>
      <div className="profile-badge-meta" title={progress}>{progress}</div>
      <div className="profile-badge-bar" aria-hidden="true"><span style={{ width: `${(nextRatio(badge) ?? 1) * 100}%` }} /></div>
    </div>
  </div>;
}

/** The all-time split by token type, present only when every published day carries its types. Reasoning is part of output, never added again. */
export function ProfileTypes({ breakdown }: { breakdown: TokenCounts }) {
  const total = totalTokens(breakdown);
  const shown = KINDS.filter((kind) => breakdown[kind.key] > 0);
  return <section className="panel" aria-labelledby="types-title">
    <header className="panel-head"><h2 id="types-title">Token types</h2><span className="push faint">All time · share of {formatExact(total)} tokens</span></header>
    {total > 0 && <div className="types-bar"><div className="mix-bar" role="img" aria-label={shown.map((kind) => `${kind.label} ${formatShare(breakdown[kind.key], total)}`).join(', ')}>
      {shown.map((kind) => <i key={kind.key} className={`kind-${kind.key}`} style={{ width: `${(breakdown[kind.key] / total) * 100}%` }} />)}
    </div></div>}
    <dl className="stats">{KINDS.map((kind) => <div key={kind.key}>
      <dt><span className={`key kind-${kind.key}`} aria-hidden="true" />{kind.label}</dt><dd title={`${formatExact(breakdown[kind.key])} tokens`}>{formatCompact(breakdown[kind.key])}</dd>
      <small>{formatShare(breakdown[kind.key], total)} of tokens</small>
      {kind.key === 'output' && <small>Of which reasoning {formatCompact(breakdown.reasoning ?? 0)}</small>}
    </div>)}</dl>
  </section>;
}

function JoinCard({ alias, join }: { alias: string; join: JoinAction }) {
  return <section className="panel panel-body profile-join" aria-label="Join">
    <p className="eyebrow">Your turn</p>
    <h2>Think you can catch {alias}?</h2>
    <p className="muted">Join in about a minute. Tokentracky counts the tokens your AI coding tools already log. Prompts, code and project names never leave your computer.</p>
    {INSTALL_COMMAND && <CopyCommand text={INSTALL_COMMAND} />}
    {INSTALL_COMMAND && MAC_DOWNLOAD && <p className="join-or">or</p>}
    {MAC_DOWNLOAD && <><a className="btn primary" href={MAC_DOWNLOAD} aria-label="Download Tokentracky for Apple Silicon"><AppleIcon />Download for Mac</a>
      <small className="profile-fine">Free · Apple Silicon · macOS 13 or later</small></>}
    <button type="button" className="btn" onClick={join.onClick}>{join.label}</button>
    <p className="profile-tools"><span aria-hidden="true">{TOOLS.slice(0, 7).map((tool) => <ToolIcon key={tool.id} id={tool.id} />)}</span>Works with {TOOLS.length} tools</p>
  </section>;
}

function ShareCard({ stats, origin }: { stats: ProfileStats; origin: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  useEffect(() => { if (canvas.current) void drawShareCard(canvas.current, stats, origin, period); }, [stats, origin, period]);
  const blob = () => new Promise<Blob>((resolve, reject) => canvas.current!.toBlob((value) => value ? resolve(value) : reject(new Error('The image could not be created.')), 'image/png'));
  const save = async () => {
    const link = document.createElement('a'); link.href = URL.createObjectURL(await blob()); link.download = `tokentracky-${stats.alias}.png`; link.click(); URL.revokeObjectURL(link.href);
  };
  const copy = async (action: () => Promise<void>, done: string) => {
    try { await action(); setMessage(done); } catch (value) { setMessage(`Copying failed: ${errorText(value)}`); }
  };
  const markdown = origin ? badgeMarkdown(origin, stats.alias) : null;
  const canCopyImage = typeof ClipboardItem !== 'undefined';
  // Opened in the click itself so the browser allows the window; the image copy runs alongside.
  const postOnX = () => {
    if (!origin) return;
    const copied = canCopyImage ? navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]) : Promise.reject(new Error('unavailable'));
    window.open(xShareUrl(stats, origin, period), '_blank', 'noopener');
    copied.then(() => setMessage('Image copied. Paste it into your post.'), () => setMessage('Save the image, then attach it to your post.'));
  };
  // The badge image is served by the hosted site, so the preview shows only there.
  const hosted = typeof window !== 'undefined' && origin === window.location.origin;
  return <section className="panel" id="share" aria-label="Share this profile">
    <header className="panel-head"><h2>Share this profile</h2></header>
    <div className="panel-body form">
      <Segmented label="Card shows" value={period} options={[{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All time' }]} onChange={setPeriod} />
      <canvas ref={canvas} className="share-card" width={1200} height={630} role="img" aria-label={`Share card: ${stats.alias}, ${formatExact(stats.periods[period].tokens)} tokens, rank ${stats.periods[period].rank} ${WINDOWS[period]}`} />
      <div className="actions">
        <button type="button" className="btn sm" onClick={() => void save()}>Save image</button>
        {canCopyImage && <button type="button" className="btn sm" onClick={() => void copy(async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]); }, 'Image copied.')}>Copy image</button>}
        {origin && <button type="button" className="btn sm" onClick={() => void copy(() => navigator.clipboard.writeText(`${origin}/u/${stats.alias}?ref=share`), 'Link copied.')}>Copy link</button>}
        {origin && <button type="button" className="btn sm" onClick={postOnX}>Post on X</button>}
      </div>
      {markdown && <div className="field">README badge
        {hosted && <img className="badge-preview" src={`/badge/${stats.alias}.svg`} alt={`Tokentracky badge for ${stats.alias}`} />}
        <div className="copy-row"><code>{markdown}</code><button type="button" className="btn sm" onClick={() => void copy(() => navigator.clipboard.writeText(markdown), 'Badge markdown copied.')}>Copy</button></div>
        <small>Add <code>?metric=cost</code> or <code>?metric=rank</code>, and <code>&amp;period=week</code> or <code>month</code>, to change what it shows.</small>
      </div>}
      {message && <p className="faint" role="status">{message}</p>}
    </div>
  </section>;
}

/** Active days and the longest run of consecutive active days in `daily` from the UTC day `from` on. */
export function windowActivity(daily: ProfileStats['daily'], from: string): { activeDays: number; longestStreak: number } {
  let activeDays = 0, run = 0, longestStreak = 0;
  for (const { day, tokens } of daily) {
    if (day < from) continue;
    if (tokens > 0) { activeDays += 1; run += 1; longestStreak = Math.max(longestStreak, run); } else run = 0;
  }
  return { activeDays, longestStreak };
}

/** The facts joined by middots, dropping trailing ones until the line fits. */
export function fitFacts(facts: string[], fits: (text: string) => boolean): string {
  let shown = facts;
  while (shown.length > 1 && !fits(shown.join(' · '))) shown = shown.slice(0, -1);
  return shown.join(' · ');
}

/** 1200×630 Open Graph-sized card in the graphite theme: name, rank and tokens in the chosen window, and a year of activity. */
async function drawShareCard(canvas: HTMLCanvasElement, stats: ProfileStats, origin: string | null, period: Period) {
  await document.fonts?.ready;
  const context = canvas.getContext('2d');
  if (!context) return;
  const font = (weight: number, size: number) => `${weight} ${size}px "Inter Variable", Inter, ui-sans-serif, sans-serif`;
  context.fillStyle = '#0a0a0b'; context.fillRect(0, 0, 1200, 630);
  context.fillStyle = '#111113'; context.fillRect(40, 40, 1120, 550);
  context.fillStyle = '#ededef'; context.font = font(600, 28); context.fillText('Tokentracky', 88, 110);
  context.fillStyle = '#7c7c85'; context.font = font(500, 24); context.textAlign = 'right'; context.fillText(`#${stats.periods[period].rank} ${WINDOWS[period]}`, 1112, 110); context.textAlign = 'left';
  context.fillStyle = '#ededef'; context.font = font(600, 56); context.fillText(stats.alias, 88, 205);
  context.font = font(600, 120); context.fillText(formatCompact(stats.periods[period].tokens), 82, 340);
  context.fillStyle = '#a1a1a8'; context.font = font(500, 26);
  // Week and month count their own days; all time matches the profile's last 12 months.
  const from = rankingWindow(period)?.slice(0, 10);
  const { activeDays, longestStreak } = from ? windowActivity(stats.daily, from) : stats.activity;
  const facts = [`tokens ${WINDOWS[period]}`, plural(activeDays, 'active day'), `longest streak ${plural(longestStreak, 'day')}`, ...(stats.models?.[0] ? [`favourite ${stats.models[0].model}`] : [])];
  context.fillText(fitFacts(facts, (text) => context.measureText(text).width <= 1024), 88, 390);
  // A year of daily activity as thin columns, brightness by volume.
  const max = Math.max(1, ...stats.daily.map((day) => day.tokens));
  const width = 1024 / stats.daily.length;
  stats.daily.forEach((day, index) => {
    const height = day.tokens ? Math.max(4, (day.tokens / max) * 110) : 2;
    context.fillStyle = day.tokens ? `rgba(228, 228, 231, ${0.35 + 0.65 * (day.tokens / max)})` : '#202024';
    context.fillRect(88 + index * width, 540 - height, Math.max(1, width - 0.6), height);
  });
  context.fillStyle = '#7c7c85'; context.font = font(500, 22); context.fillText('Waste tokens, not time.', 88, 575);
  if (origin) { context.textAlign = 'right'; context.fillText(`${origin.replace(/^https?:\/\//, '')}/u/${stats.alias}`, 1112, 575); context.textAlign = 'left'; }
}
