import { useEffect, useRef, useState } from 'react';
import { rankingWindow, totalTokens, type Period, type ProfileStats, type TokenCounts } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { INSTALL_COMMAND, MAC_DOWNLOAD } from './download-config';
import { KINDS, errorText, formatCompact, formatCost, formatExact, formatShare, shortDay, topPercent } from './format';
import { Heatmap } from './Heatmap';
import { AppleIcon, Avatar, CopyCommand, Empty, Loading, Notice, Segmented, ToolMix } from './ui';

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

/** A shareable `/u/:alias` page with everything the builder publishes. */
export function ProfilePage({ api, alias, me, origin, join, onLeaderboard }: { api: ApiClient; alias: string; me: string | null; origin: string | null; join: JoinAction | null; onLeaderboard: () => void }) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api.profileStats(alias).then((value) => { if (live) setStats(value); }).catch((value: unknown) => { if (live) setError(value); });
    return () => { live = false; };
  }, [api, alias]);
  if (error instanceof ApiError && error.status === 404) return <div className="page-stack"><Empty title={`${alias} isn’t on the leaderboard`} action={<button type="button" className="btn" onClick={onLeaderboard}>See the leaderboard</button>}>They may have deleted their account, or the name is mistyped.</Empty></div>;
  if (error) return <div className="page-stack"><Notice tone="error">Could not load this profile: {errorText(error)}</Notice></div>;
  if (!stats) return <Loading>Loading profile…</Loading>;
  return <ProfileView stats={stats} me={me} origin={origin} join={join} onLeaderboard={onLeaderboard} />;
}

type JoinAction = { label: string; onClick: () => void };
const plural = (count: number, word: string) => `${formatExact(count)} ${word}${count === 1 ? '' : 's'}`;

/** Identity, stats and highlights, the year of activity, tool mix and top models; the aside holds the join card (only for a viewer who can still join) and the share card. */
export function ProfileView({ stats, me, origin, join, onLeaderboard }: { stats: ProfileStats; me: string | null; origin: string | null; join: JoinAction | null; onLeaderboard: () => void }) {
  const { all, week } = stats.periods;
  const { activity } = stats;
  const favourite = stats.models?.[0] ?? null;
  const modelTotal = stats.models?.reduce((sum, model) => sum + model.tokens, 0) ?? 0;
  const showCost = stats.costMicrousd !== undefined;
  const top = topPercent(all.rank, all.builders);
  return <div className="page-stack">
    <nav className="crumbs" aria-label="Breadcrumb"><button type="button" className="link" onClick={onLeaderboard}>Leaderboard</button><span aria-hidden="true">/</span><strong>{stats.alias}</strong></nav>
    <div className="profile-layout">
      <section className="panel profile-card" aria-label="Profile">
        <div className="profile-id">
          <Avatar alias={stats.alias} size="lg" />
          <div>
            <h1>{stats.alias}{stats.alias === me && <span className="badge">You</span>}</h1>
            <p className="profile-ranks"><span className="badge plain">#{all.rank} All time</span>{top && <span className="badge">{top}</span>}<span className="badge plain">#{week.rank} This week</span></p>
          </div>
        </div>
        <dl className="stats">
          <div><dt>Total tokens</dt><dd title={`${formatExact(all.tokens)} tokens`}>{formatCompact(all.tokens)}</dd><small>All time</small></div>
          <div><dt>Est. cost</dt><dd>{showCost ? formatCost(stats.costMicrousd ?? null) : '—'}</dd><small>API list prices</small></div>
          <div><dt>Active days</dt><dd>{formatExact(activity.activeDays)}</dd><small>Last 12 months</small></div>
          <div><dt>Avg / day</dt><dd>{activity.activeDays ? formatCompact(activity.averagePerActiveDay) : '—'}</dd><small>Per active day</small></div>
        </dl>
        <dl className="highlights">
          <div><dt>Current streak</dt><dd>{plural(activity.currentStreak, 'day')}{activity.longestStreak > 0 && <small>{activity.currentStreak === activity.longestStreak ? ' · best ever' : ` · best ${plural(activity.longestStreak, 'day')}`}</small>}</dd></div>
          <div><dt>Best day</dt><dd>{activity.bestDay ? <>{formatCompact(activity.bestDay.tokens)}<small> · {shortDay(activity.bestDay.day)}</small></> : '—'}</dd></div>
          <div><dt>Favourite{stats.models && stats.models.length > 1 ? ` · ${stats.models.length} models used` : ''}</dt><dd className="mono" title={favourite?.model}>{favourite?.model ?? '—'}</dd></div>
        </dl>
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
        <section className="panel" aria-label="Tool mix">
          <header className="panel-head"><h2>Tool mix</h2></header>
          <div className="panel-body">{stats.toolTokens ? <ToolMix totals={stats.toolTokens} /> : <p className="muted">No tool split synced yet.</p>}</div>
        </section>
        <section className="panel" aria-label="Top models">
          <header className="panel-head"><h2>Top models</h2></header>
          {stats.models?.length ? <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">Model</th>{showCost && <th scope="col" className="c-num">Est. cost</th>}<th scope="col" className="c-num">Tokens</th><th scope="col" className="c-num c-share">Share</th></tr></thead>
            <tbody>{stats.models.map((model) => <tr key={model.model}>
              <td className="c-name mono" title={model.model}>{model.model}</td>
              {showCost && <td className="c-num">{formatCost(model.costMicrousd)}</td>}
              <td className="c-num c-total" title={`${formatExact(model.tokens)} tokens`}>{formatCompact(model.tokens)}</td>
              <td className="c-num c-share">{formatShare(model.tokens, modelTotal)}</td>
            </tr>)}</tbody>
          </table></div> : <p className="panel-empty">No model usage synced yet.</p>}
        </section>
      </div>
    </div>
    <p className="privacy-line">Profiles show each builder’s daily token totals, tool split, model mix and estimated cost; deleting the account removes them. Prompts, code and project names never leave their computer.</p>
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
    {MAC_DOWNLOAD && <a className="btn primary" href={MAC_DOWNLOAD} aria-label="Download Tokentracky for Apple Silicon"><AppleIcon />Download for Mac</a>}
    <button type="button" className="btn" onClick={join.onClick}>{join.label}</button>
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
  return <section className="panel" aria-label="Share this profile">
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
