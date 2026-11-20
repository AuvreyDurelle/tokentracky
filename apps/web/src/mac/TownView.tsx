import { useMemo } from 'react';
import { MapPage, TownPage, VisitPage, type TownApi } from '@tokentracky/town';
import type { ApiClient } from '../api';
import type { Route } from '../route';

/** The app's Token Town: the local API answers with the hosted town, acting as this computer. */
export function townApi(api: ApiClient): TownApi {
  return {
    me: () => api.townMe(),
    collect: () => api.townAct('collect'),
    claim: (x, y) => api.townAct('plots', { x, y }),
    build: (kind, x, y) => api.townAct('jobs', { action: 'build', kind, x, y }),
    upgrade: (buildingId) => api.townAct('jobs', { action: 'upgrade', buildingId }),
    move: () => api.townAct('move'),
    trade: (bricks) => api.townAct('trade', { bricks }),
    map: (area) => api.townMap(area),
    town: (alias) => api.townOf(alias),
    liked: async (alias) => (await api.likeStatus(alias)).liked,
    like: (alias, liked) => liked ? api.like(alias) : api.unlike(alias),
  };
}

/** Your town, the public map and other towns. Only a computer on the leaderboard has a town; anyone can look at the map. */
export function TownView({ api, route, me, go }: { api: ApiClient; route: Route; me: string | null; go: (route: Route) => void }) {
  const town = useMemo(() => townApi(api), [api]);
  const home = me ? () => go({ page: 'town' }) : undefined;
  return <div className="m-town">
    {route.page === 'town' && (me
      ? <TownPage api={town} onMap={() => go({ page: 'town-map' })} />
      : <div className="m-town-join">
        <strong>Start your town</strong>
        <p>Join the leaderboard to get your first plot of land. Your tokens become Power, Bricks, Water and Crystals to build with.</p>
        <div className="m-town-actions">
          <button type="button" className="btn primary" onClick={() => go({ page: 'settings' })}>Join from Settings</button>
          <button type="button" className="btn ghost" onClick={() => go({ page: 'town-map' })}>See the map</button>
        </div>
      </div>)}
    {route.page === 'town-map' && <MapPage api={town} signedIn={!!me} onHome={home} onVisit={(alias) => go({ page: 'town-visit', alias })} />}
    {route.page === 'town-visit' && <VisitPage key={route.alias} api={town} alias={route.alias} signedIn={!!me} me={me} onMap={() => go({ page: 'town-map' })} onHome={home} />}
  </div>;
}
