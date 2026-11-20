import type { ApiClient } from './api';
import { footerTitles } from './footer-guides';
import { LegalLinks } from './Legal';
import { Avatar, JUMP_KEYS, SearchIcon, useRank } from './ui';

type Page = 'leaderboard' | 'join' | 'you' | 'connect' | 'other';

const REPO_URL = 'https://github.com/AuvreyDurelle/tokentracky';

/** Hosted header. Signed out: Sign in and Join. Joined: your name and all-time rank. Signed in without a name: Finish joining. */
export function SiteNav({ api, page, me, signedIn, canJoin, onPalette }: { api: ApiClient; page: Page; me: string | null; signedIn: boolean; canJoin: boolean; onPalette: () => void }) {
  const rank = useRank(api, me);
  return <header className="site-nav"><div className="site-nav-inner site-nav-main">
    <div className="site-left">
      <a className="brand" href="/"><span className="brand-mark" aria-hidden="true" />Tokentracky</a>
      <a className="pill github" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Star Tokentracky on GitHub"><GitHubIcon /><span>Star</span></a>
    </div>
    <PublicNavigation page={page} />
    <div className="site-right">
      <button type="button" className="pill jump" aria-label="Jump to a page" aria-keyshortcuts="Meta+K Control+K" onClick={onPalette}><SearchIcon /><kbd>{JUMP_KEYS}</kbd></button>
      {me ? <a href="/you" className="me-chip" aria-label={rank ? `${me}, rank ${rank} all time` : me} aria-current={page === 'you' ? 'page' : undefined}><Avatar alias={me} /><span>{me}</span>{rank !== null && <strong className="num">#{rank}</strong>}</a>
        : signedIn ? canJoin && <a className="btn primary sm" href="/you">Finish joining</a>
        : <><a className="btn ghost sm" href="/you">Sign in</a>{canJoin && <a className="btn primary sm" href="/you?signup=1">Join the board</a>}</>}
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

export function PublicNavigation({ page }: { page: Page | 'blog' }) {
  return <nav className="site-links" aria-label="Primary">
    <a href="/" aria-current={page === 'leaderboard' ? 'page' : undefined}>Leaderboard</a>
    <a href="/join" aria-current={page === 'join' ? 'page' : undefined}>How it works</a>
    <a href="/blog" aria-current={page === 'blog' ? 'page' : undefined}>Blog</a>
  </nav>;
}

export function SiteFooter({ version }: { version?: string }) {
  return <footer className="footer"><div className="footer-inner">
    <span className="footer-note">Rankings reflect client-reported AI coding token usage.</span>
    <div className="site-foot-links"><a href="/join">Download</a><a href="/blog">Blog</a><LegalLinks /></div>
    {version && <span>v{version}</span>}
    <details className="footer-guides"><summary>Tokentracky guides</summary>
      <nav aria-label="Tokentracky guides">{Object.entries(footerTitles).map(([slug, title]) =>
        <a key={slug} href={`/blog/${slug}`}>{title}</a>)}</nav>
    </details>
  </div></footer>;
}

function Brand({ onClick }: { onClick: () => void }) {
  return <button type="button" className="brand" onClick={onClick}><span className="brand-mark" aria-hidden="true" /><span>Tokentracky</span></button>;
}

function GitHubIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" /></svg>;
}
