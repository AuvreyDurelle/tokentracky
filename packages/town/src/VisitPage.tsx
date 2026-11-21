import { useEffect, useMemo, useState } from 'react';
import type { TownMapResponse, TownPublic } from '@tokentracky/core';
import type { TownApi } from './api.ts';
import { Crest, StreakClock, useNow, useToast } from './Hud.tsx';
import { HeartIcon, HomeIcon, MapIcon } from './icons.tsx';
import { count } from './format.ts';
import { sceneLayout } from './layout.ts';
import { Sky, TownScene, preloadWorld } from './Scene.tsx';

/** Someone else's town, to look at and like. */
export function VisitPage({api, alias, signedIn, me, onMap, onHome}: {api: TownApi; alias: string; signedIn: boolean; me: string | null; onMap: () => void; onHome?: () => void}) {
  const [town, setTown] = useState<TownPublic | null>(null);
  const [map, setMap] = useState<TownMapResponse | null>(null);
  const [liked, setLiked] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, say] = useToast();
  const now = useNow();
  // The 3D town's code loads alongside the town's data.
  useEffect(() => { void preloadWorld().catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setTown(null); setError(null);
    api.town(alias).then(next => {
      if (!live) return;
      setTown(next);
      const area = sceneLayout(next.plots);
      api.map({x0: area.x0, y0: area.y0, x1: area.x0 + area.cols - 1, y1: area.y0 + area.rows - 1}).then(m => { if (live) setMap(m); }).catch(() => {});
    }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); });
    if (api.liked && signedIn && alias !== me) api.liked(alias).then(value => { if (live) setLiked(value); }).catch(() => {});
    return () => { live = false; };
  }, [api, alias, signedIn, me]);
  const layout = useMemo(() => town ? sceneLayout(town.plots) : null, [town]);

  if (error) return <div className="tt tt-stage tt-center"><Sky /><div className="tt-glass tt-card"><b>{error}</b><button type="button" className="tt-btn" onClick={onMap}>Back to the map</button></div></div>;
  if (!town || !layout) return <div className="tt tt-stage tt-center" aria-busy="true"><Sky /><div className="tt-glass tt-card">Walking over…</div></div>;
  const canLike = !!api.like && signedIn && alias !== me && liked !== null;
  const toggle = async () => {
    if (!api.like || liked === null) return;
    try { await api.like(alias, !liked); setTown({...town, likes: town.likes + (liked ? -1 : 1)}); setLiked(!liked); }
    catch (failure) { say(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <div className="tt tt-stage">
    <Sky />
    <TownScene layout={layout} plots={town.plots} buildings={town.buildings} map={map} selected={null} label={`${town.alias}'s town`} visiting spins />
    <div className="tt-top">
      <Crest alias={town.alias} level={town.level} plots={town.plots.length} />
      <StreakClock streak={town.streak} now={now} />
    </div>
    <div className="tt-glass tt-dock">
      <button type="button" className="tt-db" onClick={onMap}><MapIcon />Map</button>
      <button type="button" className={`tt-cta tt-like${liked ? ' on' : ''}`} disabled={!canLike} onClick={() => void toggle()} aria-pressed={liked ?? false}>
        <span className="tt-ci"><HeartIcon filled={!!liked} size={22} /></span>
        <span><b>{count(town.likes)} {town.likes === 1 ? 'like' : 'likes'}</b><small>{alias === me ? 'This is your town' : canLike ? (liked ? 'You like this town' : 'Like this town') : signedIn ? '' : 'Sign in to like towns'}</small></span>
      </button>
      {onHome && <button type="button" className="tt-db" onClick={onHome}><HomeIcon />Your town</button>}
    </div>
    {toast}
  </div>;
}
