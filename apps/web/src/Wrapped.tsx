import { usePublicPageReady } from './public-page';
import { useEffect, useState } from 'react';
import { adjacentWrap, TOOL_NAMES, wrapLabel, wrapRange, type ToolId, type Wrapped } from '@tokentracky/core';
import { ApiError, type ApiClient } from './api';
import { errorText, formatCompact, formatCost, formatExact, shortDay } from './format';
import { Empty, Loading, Notice, ToolIcon, Tokens } from './ui';

/** X's post composer with the wrap's headline and its tagged link, whose preview shows the wrap card. */
export function wrapShareUrl(wrap: Wrapped, origin: string): string {
  const text = `${wrap.alias}'s ${wrapLabel(wrap.period)} on Tokentracky: ${formatCompact(wrap.tokens)} tokens${wrap.rank > 0 ? `, #${formatExact(wrap.rank)} of ${formatExact(wrap.builders)} builders` : ''}.`;
  return `https://x.com/intent/post?${new URLSearchParams({ text, url: `${origin}/wrapped/${wrap.alias}/${wrap.period}?ref=share` }).toString()}`;
}

/** The wrap's change on the period before, once the period is over: "+62%". Null while it is under way or without a period before. */
export function wrapChange(wrap: Wrapped): string | null {
  const whole = wrapRange(wrap.period, '9999-12-31');
  if (!whole || whole.to !== wrap.to || !wrap.previousTokens) return null;
  const change = Math.round(((wrap.tokens - wrap.previousTokens) / wrap.previousTokens) * 100);
  return `${change >= 0 ? '+' : '−'}${formatExact(Math.abs(change))}%`;
}

const plural = (count: number, word: string) => `${formatExact(count)} ${word}${count === 1 ? '' : 's'}`;

/** A shareable `/wrapped/:alias/:period` page: a builder's month or year, its card, and buttons to share it. */
export function WrappedPage({ api, alias, period, origin, onProfile, onPeriod }: { api: ApiClient; alias: string; period: string; origin: string; onProfile: () => void; onPeriod: (period: string) => void }) {
  const [wrap, setWrap] = useState<Wrapped | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setWrap(null); setError(null);
    api.wrapped(alias, period).then((value) => { if (live) setWrap(value); }).catch((value: unknown) => { if (live) setError(value); });
    return () => { live = false; };
  }, [api, alias, period]);
  usePublicPageReady(wrap !== null || error !== null);
  if (error instanceof ApiError && error.status === 404) return <div className="page-stack"><Empty title={`${alias} isn’t on the leaderboard`}>They may have deleted their account, or the name is mistyped.</Empty></div>;
  if (error instanceof ApiError && error.status === 400) return <div className="page-stack"><Empty title={`${wrapLabel(period)} hasn’t started yet`} action={<button type="button" className="btn" onClick={onProfile}>See {alias}’s profile</button>} /></div>;
  if (error) return <div className="page-stack"><Notice tone="error">Could not load this wrap: {errorText(error)}</Notice></div>;
  if (!wrap) return <Loading>Loading wrap…</Loading>;
  return <WrappedView wrap={wrap} origin={origin} onProfile={onProfile} onPeriod={onPeriod} />;
}

export function WrappedView({ wrap, origin, onProfile, onPeriod }: { wrap: Wrapped; origin: string; onProfile: () => void; onPeriod: (period: string) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const label = wrapLabel(wrap.period);
  const today = new Date().toISOString().slice(0, 10);
  const later = adjacentWrap(wrap.period, 1);
  const month = wrap.period.length === 7;
  const image = `/og/wrapped/${wrap.alias}/${wrap.period}.png`;
  const link = `${origin}/wrapped/${wrap.alias}/${wrap.period}`;
  const change = wrapChange(wrap);
  const tools = (Object.entries(wrap.toolTokens ?? {}) as Array<[ToolId, number]>).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const copy = async (action: () => Promise<void>, done: string) => {
    try { await action(); setMessage(done); } catch (value) { setMessage(`Copying failed: ${errorText(value)}`); }
  };
  const png = async () => { const response = await fetch(image); if (!response.ok) throw new Error('The image could not be loaded.'); return response.blob(); };
  const save = async () => {
    try {
      const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(await png()); anchor.download = `tokentracky-${wrap.alias}-${wrap.period}.png`; anchor.click(); URL.revokeObjectURL(anchor.href);
    } catch (value) { setMessage(`Saving failed: ${errorText(value)}`); }
  };
  return <div className="page-stack wrapped">
    <section className="panel" aria-labelledby="wrap-title">
      <header className="panel-head">
        <h1 id="wrap-title">{wrap.alias}’s {label}</h1>
        <span className="push actions">
          <button type="button" className="btn sm" onClick={() => onPeriod(adjacentWrap(wrap.period, -1))}>← {wrapLabel(adjacentWrap(wrap.period, -1))}</button>
          {month ? <button type="button" className="btn sm" onClick={() => onPeriod(wrap.period.slice(0, 4))}>All of {wrap.period.slice(0, 4)}</button>
            : <button type="button" className="btn sm" onClick={() => onPeriod(wrap.to.slice(0, 7))}>{wrapLabel(wrap.to.slice(0, 7))}</button>}
          {wrapRange(later, today) && <button type="button" className="btn sm" onClick={() => onPeriod(later)}>{wrapLabel(later)} →</button>}
        </span>
      </header>
      <div className="panel-body form">
        <img className="share-card" src={image} width={1200} height={630} alt={`${wrap.alias}’s ${label}: ${formatExact(wrap.tokens)} tokens`} />
        <div className="actions">
          <button type="button" className="btn sm" onClick={() => void save()}>Save image</button>
          {typeof ClipboardItem !== 'undefined' && <button type="button" className="btn sm" onClick={() => void copy(async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]); }, 'Image copied.')}>Copy image</button>}
          <button type="button" className="btn sm" onClick={() => void copy(() => navigator.clipboard.writeText(`${link}?ref=share`), 'Link copied.')}>Copy link</button>
          <button type="button" className="btn sm" onClick={() => window.open(wrapShareUrl(wrap, origin), '_blank', 'noopener')}>Post on X</button>
          <button type="button" className="btn sm" onClick={onProfile}>{wrap.alias}’s profile</button>
        </div>
        {message && <p className="faint" role="status">{message}</p>}
      </div>
    </section>
    <section className="panel" aria-label="Highlights">
      <dl className="stats">
        <div><dt>Tokens</dt><dd><Tokens value={wrap.tokens} /></dd><small>{wrap.to < (wrapRange(wrap.period, '9999-12-31')?.to ?? wrap.to) ? `to ${shortDay(wrap.to)}` : label}</small></div>
        <div><dt>Rank</dt><dd>{wrap.rank > 0 ? `#${formatExact(wrap.rank)}` : '—'}</dd><small>of {plural(wrap.builders, 'active builder')}</small></div>
        <div><dt>Active days</dt><dd>{formatExact(wrap.activeDays)}</dd><small>longest streak {plural(wrap.longestStreak, 'day')}</small></div>
        <div><dt>Best day</dt><dd>{wrap.bestDay ? formatCompact(wrap.bestDay.tokens) : '—'}</dd><small>{wrap.bestDay ? shortDay(wrap.bestDay.day) : 'No usage yet'}</small></div>
        <div><dt>{wrapLabel(adjacentWrap(wrap.period, -1))}</dt><dd>{formatCompact(wrap.previousTokens)}</dd><small>{change ? `${change} since` : 'tokens'}</small></div>
        {wrap.costMicrousd !== undefined && <div><dt>Est. cost</dt><dd>{wrap.costMicrousd === null ? '—' : formatCost(wrap.costMicrousd)}</dd><small>{wrap.costMicrousd === null ? 'Pricing unknown' : 'API list prices'}</small></div>}
      </dl>
    </section>
    {tools.length > 0 && <section className="panel" aria-labelledby="wrap-tools"><header className="panel-head"><h2 id="wrap-tools">Top tools</h2></header>
      <ol className="panel-body wrap-list">{tools.map(([tool, tokens]) => <li key={tool}><ToolIcon id={tool} />{TOOL_NAMES[tool]}<b>{formatCompact(tokens)}</b></li>)}</ol></section>}
    {wrap.models && wrap.models.length > 0 && <section className="panel" aria-labelledby="wrap-models"><header className="panel-head"><h2 id="wrap-models">Top models</h2></header>
      <ol className="panel-body wrap-list">{wrap.models.map((model) => <li key={model.model}>{model.model}<b>{formatCompact(model.tokens)}</b></li>)}</ol></section>}
  </div>;
}
