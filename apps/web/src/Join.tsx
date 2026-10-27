import { TOOLS, toolLabel } from './format';
import { INSTALL_COMMAND, MAC_DOWNLOAD } from './download-config';
import { CONNECT_NOTICE } from './publication';
import { AppleIcon, Avatar, CopyCommand, ToolIcon } from './ui';

const PUBLIC = ['Daily token totals', 'Tool breakdown', 'Model mix', 'Estimated cost'];
const PRIVATE = ['Prompts and responses', 'Code', 'File paths and project names', 'Session ids'];
const FAQ = [
  { q: 'Does it read my prompts or code?', a: 'It scans the logs your tools keep for usage numbers only. Prompts, responses and code are never kept or uploaded.' },
  { q: 'Does it slow my tools down?', a: 'No. It reads records your tools already write, in the background, and never installs hooks or changes a tool’s settings.' },
  { q: 'Why is cost estimated?', a: 'Tokens are priced at public API rates. It isn’t a bill and may differ from what you pay on a subscription. Models without a known price show cost as unknown.' },
  { q: 'Does it work on Windows or Linux?', a: 'Not yet. The app and the terminal install both need an Apple Silicon Mac on macOS 13 or later.' },
  { q: 'Can I leave?', a: 'Yes. Delete your account on the Account page: your profile and public totals are removed. The history on your computer stays.' },
];
/** Tools shown before "more"; the rest fold away. */
const FIRST_TOOLS = 8;
/** Made-up numbers for the demo; never real data. */
const SAMPLE_HOURS = [18, 10, 6, 4, 8, 26, 48, 62, 40, 71, 88, 54, 36, 66, 92, 100];
const SAMPLE_TOOLS = [{ id: 'claude', tokens: '880K', share: 62 }, { id: 'codex', tokens: '384K', share: 27 }, { id: 'gemini', tokens: '156K', share: 11 }] as const;
const SAMPLE_BOARD = [{ rank: 40, alias: 'nightowl', tokens: '1.61M' }, { rank: 41, alias: 'kai-builds', tokens: '1.55M' }, { rank: 42, alias: 'you', tokens: '1.42M' }, { rank: 43, alias: 'deploy-dan', tokens: '1.38M' }, { rank: 44, alias: 'quill', tokens: '1.21M' }];

/** How it works: install, a demo of the app with sample numbers, what is shared, which tools, and questions. */
export function Join({ onLeaderboard }: { onLeaderboard: () => void }) {
  const more = TOOLS.length - FIRST_TOOLS;
  return <div className="page-stack join">
    <section className="join-hero">
      <p className="join-pill">{`Works with ${TOOLS.length} AI coding tools`}</p>
      <h1>Track every token.<br /><span>Get on the board in a minute.</span></h1>
      <p className="join-lede">Tokentracky reads the usage logs your AI coding tools already keep, then ranks you on the leaderboard. <strong>Token counts only, never prompts or code.</strong></p>
      <div className="panel join-install">
        {MAC_DOWNLOAD && <>
          <div className="join-install-row">
            <a className="btn primary xl" href={MAC_DOWNLOAD} aria-label="Download Tokentracky for Apple Silicon"><AppleIcon />Download for Mac</a>
            <small><strong>Menu bar app</strong> Apple Silicon · macOS 13+</small>
          </div>
          {INSTALL_COMMAND && <p className="join-or">or install in one command</p>}
        </>}
        {INSTALL_COMMAND && <>
          <CopyCommand text={INSTALL_COMMAND} />
          <p className="join-install-foot"><span>Installs the CLI and opens your browser to approve.</span><span>Node 18+</span></p>
        </>}
        {MAC_DOWNLOAD
          ? <small className="first-launch"><span><strong>First open on a Mac:</strong> macOS can’t check the app yet. Allow it once:</span><span className="join-path"><b>System Settings</b> → <b>Privacy &amp; Security</b> → <b>Open Anyway</b></span></small>
          : <span className="soon"><AppleIcon />Mac app coming soon</span>}
      </div>
      <ul className="join-trust"><li>No API keys</li><li>Never changes your tools’ settings</li><li>Your past usage counts</li></ul>
    </section>

    <Demo />

    <section aria-labelledby="join-shared">
      <header className="join-sec"><h2 id="join-shared">What leaves your computer</h2><small>Daily totals only, nothing per prompt</small></header>
      <div className="panel join-privacy">
        <div><h3>Public once you connect</h3><ul>{PUBLIC.map((item) => <li key={item}>{item}</li>)}</ul></div>
        <div className="never"><h3>Never leaves your computer</h3><ul>{PRIVATE.map((item) => <li key={item}>{item}</li>)}</ul></div>
      </div>
      <p className="join-notice">{CONNECT_NOTICE}</p>
    </section>

    <section aria-labelledby="join-tools">
      <header className="join-sec"><h2 id="join-tools">Supported tools</h2><small>Found on their own, no setup per tool</small></header>
      <ul className="chips works-with">{TOOLS.slice(0, FIRST_TOOLS).map((tool) => <li key={tool.id} className="chip"><ToolIcon id={tool.id} />{tool.label}</li>)}</ul>
      <details className="works-more">
        <summary className="chip">{`+${more} more`}</summary>
        <ul className="chips works-with">
          {TOOLS.slice(FIRST_TOOLS).map((tool) => <li key={tool.id} className="chip"><ToolIcon id={tool.id} />{tool.label}</li>)}
          <li className="chip off"><ToolIcon id="cursor" />Cursor <span className="badge plain">Not yet</span></li>
        </ul>
      </details>
    </section>

    <section className="join-faq" aria-labelledby="join-faq">
      <header className="join-sec"><h2 id="join-faq">Questions</h2><button type="button" className="link-quiet" onClick={onLeaderboard}>See the leaderboard →</button></header>
      <div>{FAQ.map((item, index) => <details key={item.q} open={index === 0}><summary>{item.q}</summary><p>{item.a}</p></details>)}</div>
    </section>
  </div>;
}

/**
 * The app at work on a Mac, with sample numbers: a coding tool in a terminal, Tokentracky's menu bar popover, and the leaderboard.
 * The menu bar and the desk share columns, so the menu bar item sits above its popover. Decorative; the steps carry the meaning.
 */
function Demo() {
  return <section className="demo" aria-labelledby="join-how">
    <header className="join-sec"><h2 id="join-how">How it works</h2><small>Example with made-up numbers</small></header>
    <div className="demo-screen" aria-hidden="true">
      <div className="demo-menubar">
        <span className="demo-apps"><b>Terminal</b><span>Shell</span><span>Edit</span><span>View</span></span>
        <span className="join-menubar-item"><span className="brand-mark" />1.42M</span>
        <span className="demo-status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h.01" /></svg>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="17" height="10" rx="2.5" /><path d="M22 11v2" /><path d="M5 10v4h9v-4z" fill="currentColor" /></svg>
          <span>Mon 14:32</span>
        </span>
      </div>
      <div className="demo-desk">
        <div className="demo-win demo-term">
          <span className="demo-mark">1</span>
          <div className="demo-bar"><i /><i /><i /><span><ToolIcon id="claude" />claude — ~/code/shop</span></div>
          <div className="demo-term-body">
            <p className="demo-prompt">› add rate limiting to the checkout API</p>
            <p><span className="demo-dot" />Read <b>src/api/checkout.ts</b></p>
            <p><span className="demo-dot" />Update <b>src/api/checkout.ts</b> <span className="up">+42</span> <span className="down">−6</span></p>
            <p><span className="demo-dot" />Run <b>npm test</b> <span className="up">✓ 31 passed</span></p>
            <p className="demo-usage">48.2K tokens this session · written to the tool’s own log</p>
          </div>
        </div>
        <div className="join-pop demo-pop">
          <span className="demo-mark">2</span>
          <div className="join-pop-head"><b>Today</b><span><i className="dot" />Synced 2m ago</span></div>
          <div className="join-pop-total">1.42M<small>tokens</small></div>
          <div className="join-pop-sub">≈ $3.18 estimated · <span className="up">↑ 18%</span> vs yesterday</div>
          <div className="join-pop-spark">{SAMPLE_HOURS.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
          <div className="join-pop-split">{SAMPLE_TOOLS.map((tool) => <i key={tool.id} style={{ flex: tool.share, background: `var(--tool-${tool.id})` }} />)}</div>
          <ul className="join-pop-tools">{SAMPLE_TOOLS.map((tool) => <li key={tool.id}><ToolIcon id={tool.id} />{toolLabel(tool.id)}<span>{tool.tokens}</span></li>)}</ul>
          <div className="join-pop-rank">This week<strong>#42</strong><span className="up">↑ 3 places</span></div>
        </div>
        <div className="demo-win demo-board">
          <span className="demo-mark">3</span>
          <div className="demo-bar"><i /><i /><i /><span><span className="brand-mark" />Leaderboard · This week</span></div>
          <ol>{SAMPLE_BOARD.map((row) => <li key={row.rank} className={row.alias === 'you' ? 'mine' : undefined}>
            <span className="num">{row.rank}</span><Avatar alias={row.alias} /><b>{row.alias === 'you' ? 'You' : row.alias}</b>
            {row.alias === 'you' && <span className="up">↑3</span>}<span className="num">{row.tokens}</span></li>)}</ol>
        </div>
      </div>
    </div>
    <ol className="demo-steps">
      <li><span className="step-num">1</span><div><strong>Code as usual</strong><p>Claude Code, Codex and {TOOLS.length - 2} more tools already log their token usage on your Mac. Nothing to set up per tool.</p></div></li>
      <li><span className="step-num">2</span><div><strong>It counts in your menu bar</strong><p>Tokentracky reads those logs in the background and shows today’s total. Token counts only, never prompts or code.</p></div></li>
      <li><span className="step-num">3</span><div><strong>You climb the board</strong><p>Sign in with GitHub once and pick a name. Your past usage counts, and totals upload every 5 minutes.</p></div></li>
    </ol>
  </section>;
}
