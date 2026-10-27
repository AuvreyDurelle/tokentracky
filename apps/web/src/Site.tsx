import type { ApiClient } from './api';
import { LegalLinks } from './Legal';
import { Avatar, JUMP_KEYS, SearchIcon, useRank } from './ui';

type Page = 'leaderboard' | 'join' | 'you' | 'connect' | 'other';

/** Hosted header. Signed out: Sign in and Join. Joined: your name and all-time rank. Signed in without a name: Finish joining. */
export function SiteNav({ api, page, me, signedIn, canJoin, onHome, onLeaderboard, onJoin, onYou, onSignUp, onPalette }: { api: ApiClient; page: Page; me: string | null; signedIn: boolean; canJoin: boolean; onHome: () => void; onLeaderboard: () => void; onJoin: () => void; onYou: () => void; onSignUp: () => void; onPalette: () => void }) {
  const rank = useRank(api, me);
  return <header className="site-nav"><div className="site-nav-inner site-nav-main">
    <Brand onClick={onHome} />
    <nav className="site-links" aria-label="Primary">
      <button type="button" aria-current={page === 'leaderboard' ? 'page' : undefined} onClick={onLeaderboard}>Leaderboard</button>
      <button type="button" aria-current={page === 'join' ? 'page' : undefined} onClick={onJoin}>How it works</button>
    </nav>
    <div className="site-right">
      <button type="button" className="pill jump" aria-label="Jump to a page" aria-keyshortcuts="Meta+K Control+K" onClick={onPalette}><SearchIcon /><kbd>{JUMP_KEYS}</kbd></button>
      {me ? <button type="button" className="me-chip" aria-label={rank ? `${me}, rank ${rank} all time` : me} aria-current={page === 'you' ? 'page' : undefined} onClick={onYou}><Avatar alias={me} /><span>{me}</span>{rank !== null && <strong className="num">#{rank}</strong>}</button>
        : signedIn ? canJoin && <button type="button" className="btn primary sm" onClick={onYou}>Finish joining</button>
        : <><button type="button" className="btn ghost sm" onClick={onYou}>Sign in</button>{canJoin && <button type="button" className="btn primary sm" onClick={onSignUp}>Join the board</button>}</>}
    </div>
  </div></header>;
}

/** The connect flow keeps one way out and nothing else to click. */
export function ConnectNav({ onHome, onBack }: { onHome: () => void; onBack: () => void }) {
  return <header className="site-nav"><div className="site-nav-inner">
    <Brand onClick={onHome} />
    <div className="site-right"><button type="button" className="btn ghost sm" onClick={onBack}>Back to leaderboard</button></div>
  </div></header>;
}

export function SiteFooter({ version, onJoin }: { version: string; onJoin: () => void }) {
  return <footer className="footer"><div className="footer-inner">
    <span className="site-foot-links"><button type="button" className="link-quiet" onClick={onJoin}>Download</button><LegalLinks /></span>
    <span>v{version}</span>
  </div></footer>;
}

function Brand({ onClick }: { onClick: () => void }) {
  return <button type="button" className="brand" onClick={onClick}><span className="brand-mark" aria-hidden="true" /><span>Tokentracky</span></button>;
}
