import { useEffect, type ReactNode } from 'react';
import './legal.css';

export type LegalPageId = 'privacy' | 'terms' | 'support';

const UPDATED = '26 October 2026';
const CONTACT = 'contact@tokentracky.com';
const OPERATOR = 'XPO8 Limited';
const ADDRESS = '1603, L. Plaza, 367–375 Queen’s Road Central, Sheung Wan, Hong Kong';

const PAGES: Record<LegalPageId, { path: string; label: string }> = {
  privacy: { path: '/privacy', label: 'Privacy' },
  terms: { path: '/terms', label: 'Terms' },
  support: { path: '/support', label: 'Support' },
};
const IDS = Object.keys(PAGES) as LegalPageId[];

/** The server serves these exact paths with the app shell, so the page is chosen from the address. */
export function legalPageAt(pathname: string): LegalPageId | null {
  const page = pathname.slice(1);
  return IDS.find((id) => id === page) ?? null;
}

const Mail = ({ subject }: { subject?: string }) => <a href={`mailto:${CONTACT}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`}>{CONTACT}</a>;
const Page = ({ id, children }: { id: LegalPageId; children: ReactNode }) => <a href={PAGES[id].path}>{children}</a>;

interface Section { id: string; title: string; body: ReactNode }
interface Doc { title: string; heading: string; lede: string; sections: Section[] }

const privacy: Doc = {
  title: 'Privacy policy',
  heading: 'Privacy policy.',
  lede: 'What Tokentracky reads on your computer, what reaches us only when you join the leaderboard, and what anyone can see.',
  sections: [
    { id: 'who-we-are', title: 'Who we are and what this covers', body: <>
      <p>Tokentracky is operated by {OPERATOR}, {ADDRESS}. This policy covers the Tokentracky website and public leaderboard, the Tokentracky desktop app and command-line tool, and Tokentracky accounts.</p>
      <p>{OPERATOR} is the controller, or data user under Hong Kong law, for the personal information described here. Email <Mail /> about anything in this policy.</p>
    </> },
    { id: 'summary', title: 'The short version', body: <ul>
      <li>Tracking happens on your computer. As soon as it opens, the app reads usage records from the AI coding tools it finds in their usual folders (and from any other folders you choose) and keeps token counts and related details. It never keeps or sends your prompts, responses or code.</li>
      <li>Nothing leaves your computer unless you join the leaderboard.</li>
      <li>The leaderboard shows the name you choose and your daily token totals split by type (input, output, cache read, cache write and reasoning), tool split, model mix and estimated cost.</li>
      <li>There is no advertising, no analytics tracking and no selling of data.</li>
    </ul> },
    { id: 'on-your-computer', title: 'What stays on your computer', body: <>
      <p>As soon as it opens, the app reads the usage logs that supported tools write in their usual folders, and in any other folders you choose. Today these tools are Claude Code, Codex, Gemini CLI, Cline, Roo Code, Kilo Code, OpenCode, Every Code, Mimo Code, DuMate, pi, oh-my-pi, OmO, Prime Agent, MiniMax Code, CodeBuddy, Kimi Code, Command Code, DeepSeek Harness, LM Studio, GitHub Copilot, Unsloth Studio, ZCode, Zed Agent, OpenClaw, Hermes Agent, Goose and Grok Build. A tool you turn off is not read again until you turn it back on. From each usage record it keeps the date and time, the tool and model, token counts by type (input, output, cache and reasoning), an estimated cost, the project folder name and the session identifier.</p>
      <p>While Claude Code is turned on, the app also reads Claude Code’s own record of your latest usage limits in its settings file, <code>~/.claude.json</code>. It keeps only the limit figures: how much of each limit is used, when it resets and when Claude Code checked. It keeps them only when they belong to the account signed in to Claude Code, and keeps nothing else from that file. For Codex, it keeps the latest usage-limit figures from the logs it already reads.</p>
      <p>These details are stored in a database in the app’s data folder on your computer. Logs can contain conversation text; the app reads it only to find usage figures and does not store it. Conversations on the Claude.ai or ChatGPT websites are not read. Nothing in this section is sent to us. The split of cache writes into one-hour and five-minute writes, and the service tier of each request, stay on your computer.</p>
    </> },
    { id: 'when-you-join', title: 'What we receive when you join', body: <>
      <p>If you create an account and join the leaderboard, we hold:</p>
      <ul>
        <li><strong>Account details:</strong> your email address and sign-in records, handled by our authentication provider. If you sign in with GitHub or Google, we also receive the basic profile that service shares, such as your username and email address.</li>
        <li><strong>Leaderboard profile:</strong> the name you choose and when you last saved it.</li>
        <li><strong>Likes:</strong> the profiles you like, so that you can undo a like.</li>
        <li><strong>Usage totals:</strong> for each day (in UTC), your total tokens split by type (input, output, cache read, cache write and reasoning, which is part of output), tokens per tool, tokens per model and estimated cost. For the leaderboard’s 24-hour figure, it also includes your tokens per tool for each hour (in UTC) of the last day. Each upload also carries technical fields that keep totals accurate: a revision number, a random installation identifier and sync receipts. None of these contain project names, folder paths, session identifiers or conversation content.</li>
        <li><strong>Connected computers:</strong> each computer’s name (taken from its system name and shown only in your account), when it last synced, and a scrambled (hashed) copy of its access credential. On a Mac, a salted hash of the hardware identifier lets a reinstall replace the same computer’s connection; the hardware identifier itself stays on the Mac. Up to 10 active computers contribute to one account. Browser approval codes expire after ten minutes and are also stored hashed.</li>
        <li><strong>Link visits:</strong> when someone opens a profile from a shared link or a README badge, we add one to a count for that day and kind of link. No IP address, cookie, account or profile is stored with it.</li>
      </ul>
    </> },
    { id: 'public', title: 'What is public', body: <>
      <p>For every published profile, anyone can see your leaderboard name, your rank, your token totals for the last 24 hours, the week, month and all time, and your daily activity for the last 12 months with your active days and streaks. Your profile page, README badge and share card show the same details. Your all-time tokens by type, tokens per tool, tokens per model (including your most-used model) and estimated cost are shown too. Your totals also count towards the community totals on the home page.</p>
      <p>Your profile also shows the day you joined, how many likes it has received, and achievements we work out from your published totals, such as your active days, streaks and best rank. If you signed in with GitHub, it shows your GitHub username, taken from GitHub’s sign-in record. Your projects, prompts and code never leave your computer, so none of this is based on them.</p>
      <p>Nothing is public until you join the leaderboard. Creating an account alone publishes nothing. Others may copy public information while it is visible, and we cannot recall copies they have made.</p>
    </> },
    { id: 'technical', title: 'Technical information', body: <>
      <p><strong>Requests:</strong> our hosting providers process your IP address, request times and browser or device details to deliver and protect the service, including limiting how many requests one address can make. Tokentracky does not record request contents, sign-in tokens or search terms in its own logs. Providers may keep short-lived technical logs of their own.</p>
      <p><strong>Desktop app:</strong> the app checks for updates and downloads a public table of model prices, used for cost estimates, from GitHub. These requests contain no usage data; GitHub sees your IP address.</p>
      <p><strong>Email:</strong> when you write to us, we receive your address, your message and anything you attach.</p>
    </> },
    { id: 'cookies', title: 'Cookies and local storage', body: <>
      <p>We use no advertising or analytics cookies and no tracking pixels.</p>
      <p>On the website, the sign-in library keeps your session in your browser’s local storage so that you stay signed in, and the site briefly remembers a connection code while you approve a computer. In the desktop app, a session cookie that works only on your own computer protects your private dashboard. These are needed for the service to work, so there is nothing to opt out of.</p>
    </> },
    { id: 'purposes', title: 'How we use information', body: <>
      <p>We use information to run your account and leaderboard profile, publish your leaderboard profile and totals, keep the service secure, prevent abuse and cheating, answer messages and meet legal obligations.</p>
      <p>Where the GDPR, UK GDPR or a similar law applies, our legal grounds are performing our agreement with you (publishing your leaderboard profile and totals is part of the service you sign up for when you join the leaderboard), our legitimate interests in running a secure and fair leaderboard and answering enquiries, and legal obligations. Hong Kong’s Personal Data (Privacy) Ordinance also applies.</p>
      <p>We check published totals automatically for unusual patterns, such as a day far above every other member’s that day. A profile that trips these checks may be hidden from public pages until a person reviews it, and your profile page tells you which days are under review. Your local data is never affected. Only a person can ban an account.</p>
      <p>We do not sell personal information, show advertising, build marketing profiles or use your data to train AI models. Rankings are simple arithmetic on reported totals; no automated decision about you has legal or similarly significant effects.</p>
    </> },
    { id: 'providers', title: 'Service providers and disclosures', body: <>
      <p>We use these providers to run Tokentracky. Each receives only what it needs:</p>
      <ul>
        <li><strong>Supabase:</strong> sign-in, sign-in emails and the account database, hosted in London, United Kingdom.</li>
        <li><strong>Google Cloud:</strong> runs our API, in London, United Kingdom.</li>
        <li><strong>Vercel:</strong> serves the website through its global network.</li>
        <li><strong>GitHub:</strong> app updates and the model price table, and sign-in if you choose GitHub.</li>
        <li><strong>Google:</strong> sign-in if you choose Google.</li>
      </ul>
      <p>Hosting providers act on our instructions under data processing terms. If you sign in with GitHub or Google, their own privacy policies also apply. We may also disclose information when the law requires it, to protect people’s rights and safety, or as part of a business transfer, with any notice the law requires.</p>
    </> },
    { id: 'transfers', title: 'International transfers', body: <p>{OPERATOR} is based in Hong Kong, our database is in the United Kingdom, and some providers process information in other countries, including the United States. Where the law restricts a transfer, we rely on an appropriate safeguard such as an adequacy decision or standard contractual clauses. Ask us for details of the safeguard that applies to your information.</p> },
    { id: 'retention', title: 'Retention and deletion', body: <ul>
      <li><strong>On your computer:</strong> kept until you delete it. <Page id="support">Support</Page> explains how.</li>
      <li><strong>Hourly totals:</strong> kept only for the last day; older hours are deleted. Only their sum for the last 24 hours is shown.</li>
      <li><strong>Published totals:</strong> kept while your account exists. Disconnecting a computer stops its uploads but keeps what it already published; deleting your account data removes your public profile and totals.</li>
      <li><strong>Account data:</strong> kept until you choose <em>Delete Tokentracky data</em>, which removes your profile, totals and connected computers. Your sign-in identity with our authentication provider is separate; email us to delete it as well.</li>
      <li><strong>Bans:</strong> if we ban an account for cheating, we keep a one-way identifier of its sign-in and the reason, even after its account data is deleted, so the same sign-in cannot rejoin the leaderboard.</li>
      <li><strong>Messages:</strong> kept for as long as we need to deal with them.</li>
      <li><strong>Backups:</strong> kept for a limited period and then overwritten. If we ever restore one, we re-apply deletions before anything is published.</li>
    </ul> },
    { id: 'security', title: 'Security', body: <>
      <p>The desktop app stores its credential with your operating system’s encryption. Our servers store only hashed device credentials, keep account data in an isolated database with row-level access controls, and serve everything over HTTPS. The private dashboard is reachable only from your own computer. No system is perfectly secure.</p>
      <p>Report a security concern to <Mail subject="Security" /> with “Security” in the subject. Never include passwords, sign-in links or device credentials.</p>
    </> },
    { id: 'rights', title: 'Your rights and choices', body: <>
      <p>In the product you can disconnect a computer and delete your account data whenever you like.</p>
      <p>Under Hong Kong law you can ask to see and correct your personal data. Depending on where you live, you may also be able to ask us to delete, restrict or transfer it, object to how we use it, or withdraw consent. Withdrawing consent does not affect processing that was lawful before.</p>
      <p>Email <Mail subject="Privacy request" /> from the address on your account. We may ask a proportionate question to confirm the account is yours, and we will reply within the time the law requires.</p>
    </> },
    { id: 'children', title: 'Children', body: <p>Tokentracky is not directed at children, and you must be 16 or older to create an account. If you believe a child has created an account, email <Mail /> and we will delete it.</p> },
    { id: 'communications', title: 'Emails we send', body: <p>We send only service emails, such as sign-in links, security notices and important changes to these terms. We do not send marketing email without your consent.</p> },
    { id: 'complaints', title: 'Complaints', body: <p>Please contact <Mail /> first so that we can try to put things right. You can also complain to Hong Kong’s Privacy Commissioner for Personal Data, the UK Information Commissioner’s Office, a data protection authority in the EU, or the authority where you live.</p> },
    { id: 'changes', title: 'Changes to this policy', body: <p>The date at the top shows when this policy last changed. We will tell you about material changes in the app or by email before they take effect, and we will not use information for a new, incompatible purpose without the notice or consent the law requires.</p> },
  ],
};

const terms: Doc = {
  title: 'Terms of service',
  heading: 'Terms of service.',
  lede: 'The agreement between you and us for using the Tokentracky website, leaderboard, desktop app and command-line tool.',
  sections: [
    { id: 'about', title: 'About these terms', body: <>
      <p>These terms are an agreement between you and {OPERATOR}, {ADDRESS} (“we”), for the Tokentracky website, public leaderboard, desktop app, command-line tool and accounts (together, “Tokentracky”). Our <Page id="privacy">privacy policy</Page> explains how we handle personal information.</p>
      <p>By using Tokentracky you agree to these terms. If you do not agree, do not use it. Rights that the law gives you and that cannot be excluded are not affected.</p>
    </> },
    { id: 'eligibility', title: 'Who can use Tokentracky', body: <>
      <p>You must be 16 or older to create an account. If you use Tokentracky for an organisation, you must be authorised to do so.</p>
      <p>The app reads usage logs on your computer. Check your employer’s rules before tracking tools you use for work. You are responsible for having permission to read the folders the app tracks; you can turn any tool off.</p>
    </> },
    { id: 'account', title: 'Your account', body: <p>Give a real email address, keep your sign-in secure and keep to one account per person. You are responsible for activity on your account. Tell us at <Mail /> straight away if you think someone else has used it.</p> },
    { id: 'app', title: 'The app on your computer', body: <>
      <p>The Tokentracky software is provided under the MIT licence, which permits use, copying, modification and redistribution subject to its notice requirements. These service terms do not restrict rights granted by that licence.</p>
      <p>The app reads only the usual folders of the tools it finds and the folders you choose, and does not change your tools’ settings. It may update itself. Third-party components are covered by their own licences; see the <a href="/assets/third-party-notices.txt">software licences and notices</a>.</p>
    </> },
    { id: 'leaderboard', title: 'The leaderboard', body: <>
      <p>Rankings are based on totals reported by each member’s app. They are not verified spending or productivity figures and are not an endorsement of anyone. Days are counted in UTC. The leaderboard has no prizes or rewards unless we announce them separately with their own rules.</p>
      <p>Joining the leaderboard publishes your leaderboard name, rank and daily token totals, with your tool split, model mix and estimated cost, as our <Page id="privacy">privacy policy</Page> describes. Publishing them is part of the service you sign up for, so none of them can be hidden; deleting your account data removes them.</p>
      <p>We may correct, hide, re-rank or remove entries that we reasonably believe are inaccurate, manipulated or in breach of these terms.</p>
    </> },
    { id: 'fair-play', title: 'Names and fair play', body: <>
      <p>Your leaderboard name must not impersonate anyone, mislead people, offend, infringe someone else’s rights or reveal personal information about another person. We may change or remove a name that breaks these rules.</p>
      <p>Do not fabricate or inflate usage, manipulate uploads to misrepresent usage, run several accounts to move the rankings, or use AI tools in a way that breaks their providers’ terms to climb the leaderboard. Cheating means publishing usage that the app did not read from your real use of your tools, including by editing or inventing the logs they write.</p>
      <p>We check totals automatically and may hide a profile while a person reviews it. If we find cheating, we may ban the account: it can no longer publish, and the same sign-in cannot rejoin.</p>
    </> },
    { id: 'acceptable-use', title: 'Acceptable use', body: <p>Use Tokentracky lawfully. Do not interfere with the service, bypass its security or rate limits, probe other people’s accounts or data, copy the leaderboard in bulk by automated means, or upload malicious code. These hosted-service rules do not limit your rights to inspect, modify or redistribute the software under its open-source licence.</p> },
    { id: 'estimates', title: 'Estimated costs', body: <p>Costs are estimated from public price tables. They may differ from what you are actually billed, and they do not reflect subscriptions, discounts or plan limits. Where we do not know a model’s price we show no estimate. Estimates are for information only and are not financial advice.</p> },
    { id: 'third-parties', title: 'Other companies’ tools and services', body: <p>Tokentracky is not affiliated with or endorsed by Anthropic, OpenAI or the makers of any other tool it supports. Product names belong to their owners. Your use of those tools, and of GitHub or Google sign-in, is governed by their own terms.</p> },
    { id: 'price', title: 'Price', body: <p>Tokentracky is currently free. If we introduce paid features, we will show the price and terms first, and nothing will be charged without your agreement.</p> },
    { id: 'your-content', title: 'Your content', body: <p>You keep your rights in your leaderboard name and data. You give us a worldwide, non-exclusive, royalty-free licence to host and display your leaderboard name and published totals, only to run Tokentracky and only until you delete your account data. Copies already made by other people are outside our control.</p> },
    { id: 'our-rights', title: 'Our intellectual property', body: <p>The Tokentracky name and logo identify the service and belong to {OPERATOR} or its licensors. The software and third-party components remain subject to their respective open-source licences. Those licences do not grant trademark rights or permission to imply endorsement.</p> },
    { id: 'availability', title: 'Availability and changes', body: <p>We may change, pause or stop parts of Tokentracky, and we will try to give notice of significant changes. We do not promise uninterrupted service. Your local history stays on your computer, and you can export it from the app as a CSV file.</p> },
    { id: 'ending', title: 'Leaving, suspension and termination', body: <p>You can delete your account data, which removes your profile and totals from the leaderboard, or uninstall the app at any time. We may suspend or close an account that breaches these terms, harms other members or the service, or where the law requires it. Where appropriate, we will tell you why.</p> },
    { id: 'disclaimers', title: 'Disclaimers', body: <p>To the extent the law allows, Tokentracky is provided “as is” and “as available”. Token counts depend on the logs your tools write, which may be incomplete or change format without notice, so we do not guarantee that counts, rankings or estimates are accurate or complete.</p> },
    { id: 'liability', title: 'Liability', body: <>
      <p>To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of profit, business, goodwill or data. Because Tokentracky is free, our total liability to you for all claims is limited to US$100.</p>
      <p>Nothing in these terms excludes or limits liability for fraud, for death or personal injury caused by negligence, or any other liability or consumer right that the law does not allow to be excluded or limited.</p>
    </> },
    { id: 'law', title: 'Governing law and disputes', body: <p>These terms are governed by the laws of the Hong Kong Special Administrative Region, and the courts of Hong Kong have non-exclusive jurisdiction. If you are a consumer, you keep any mandatory protections and any right to use your local courts. Please contact <Mail /> first so that we can try to resolve a concern.</p> },
    { id: 'general', title: 'Changes and general terms', body: <>
      <p>The date at the top shows when these terms last changed. We will give notice of material changes before they take effect; continuing to use Tokentracky afterwards means you accept them.</p>
      <p>These terms and the privacy policy are the whole agreement between us about Tokentracky. If a provision is unenforceable, the rest continues to apply. Not enforcing a right straight away is not a waiver. We may transfer this agreement as part of a business transfer. Send notices to <Mail /> or to our postal address above.</p>
    </> },
  ],
};

const support: Doc = {
  title: 'Support',
  heading: 'Support.',
  lede: 'Help with the app, the leaderboard and your data. A person reads every message.',
  sections: [
    { id: 'contact', title: 'Contact us', body: <>
      <p>Email <Mail subject="Tokentracky support" />. Tell us what you were doing, what you expected and what happened instead, plus your macOS version and the app version shown at the bottom of every page.</p>
      <p>Never send passwords, sign-in links, device credentials or log files. Logs can contain your conversations.</p>
    </> },
    { id: 'getting-started', title: 'Getting started', body: <>
      <p>Install the Mac app and open it. It finds Claude Code, Codex, Gemini CLI, Cline, Roo Code, Kilo Code, OpenCode, Every Code, Mimo Code, DuMate, pi, oh-my-pi, OmO, Prime Agent, MiniMax Code, CodeBuddy, Kimi Code, Command Code, DeepSeek Harness, LM Studio, GitHub Copilot, Unsloth Studio, ZCode, Zed Agent, OpenClaw, Hermes Agent, Goose and Grok Build in their usual folders on your computer and starts reading them; choose <em>Use different folders</em> if yours are elsewhere. Your totals appear after the first scan, and nothing leaves your computer until you join the leaderboard.</p>
      <p>Only usage from these tools on this computer is counted. Conversations on the Claude.ai and ChatGPT websites are not.</p>
    </> },
    { id: 'joining', title: 'Joining the leaderboard', body: <>
      <p>In the app, choose <em>Join the leaderboard</em>. Your browser opens; sign in, pick a leaderboard name, review exactly what will be shown and check that the code matches the one in the app. The app then connects by itself, with nothing to copy or paste.</p>
      <p>You can connect up to 10 computers to one account, and each adds its totals to yours. When two of your computers report exactly the same tokens for the same day, tool and model, for example from copied log folders, that day counts once. Connecting the same Mac again replaces its earlier connection and totals.</p>
    </> },
    { id: 'leaving', title: 'Leaving and deleting your data', body: <ul>
      <li><strong>Disconnect</strong> stops that computer uploading. What it already published stays until you delete your account data.</li>
      <li><strong>Delete Tokentracky data</strong> removes your profile, totals and connected computers, and existing device credentials stop working. To delete your sign-in identity as well, email <Mail subject="Delete my sign-in identity" /> from the address on your account.</li>
      <li><strong>Local history</strong> stays on your computer until you remove it. Quit the app and delete the <code>Tokentracky</code> folder in <code>~/Library/Application Support</code>. If you use the command-line tool, <code>tokentracky uninstall</code> removes its data.</li>
    </ul> },
    { id: 'troubleshooting', title: 'Troubleshooting', body: <dl className="legal-faq">
      <dt>My tokens aren’t showing</dt>
      <dd>Check that tracking is on at the top of the app and that the folders listed under Tracking are where your tools write their logs. New usage appears after the tool has written its log and the app has refreshed.</dd>
      <dt>The leaderboard hasn’t updated</dt>
      <dd>The app uploads after each refresh while it is running and connected. Days are counted in UTC, so daily and weekly totals roll over at midnight UTC. The 24h figure covers the last 24 whole hours, so the hour under way counts once it ends.</dd>
      <dt>Estimated cost shows “—”</dt>
      <dd>We don’t yet have a price for that model, and we never guess.</dd>
      <dt>The connection code expired</dt>
      <dd>Codes last ten minutes. Choose <em>Join the leaderboard</em> in the app again for a fresh one.</dd>
      <dt>I can’t sign in</dt>
      <dd>Check your spam folder for our email. Links in it expire, so request a new one if needed. If it still fails, email us with the time you tried.</dd>
    </dl> },
    { id: 'security', title: 'Reporting a security issue', body: <p>Email <Mail subject="Security" /> with “Security” in the subject and enough detail for us to reproduce the problem. Please don’t access other people’s accounts or data while testing, and give us a reasonable chance to fix the issue before you disclose it. We will acknowledge your report and keep you updated.</p> },
    { id: 'privacy', title: 'Privacy requests', body: <p>The <Page id="privacy">privacy policy</Page> explains what we hold and your rights. For a copy of your data, a correction or a deletion, email <Mail subject="Privacy request" /> from the address on your account.</p> },
  ],
};

const DOCS: Record<LegalPageId, Doc> = { privacy, terms, support };

export function LegalLinks() {
  return <nav className="footer-links" aria-label="Legal and support">{IDS.map((id) => <a key={id} href={PAGES[id].path}>{PAGES[id].label}</a>)}</nav>;
}

export function LegalPage({ page }: { page: LegalPageId }) {
  const doc = DOCS[page];
  useEffect(() => { document.title = `${doc.title} — Tokentracky`; }, [doc]);
  return <div className="app">
    <header className="topbar"><div className="topbar-inner">
      <a className="brand" href="/"><span className="brand-mark" aria-hidden="true" /><span>Tokentracky</span></a>
      <nav className="tabs" aria-label="Documents">
        {IDS.map((id) => <a key={id} href={PAGES[id].path} aria-current={id === page ? 'page' : undefined}>{PAGES[id].label}</a>)}
      </nav>
      <div className="topbar-right"><a className="btn sm" href="/">Back to Tokentracky</a></div>
    </div></header>
    <main className="page legal">
      <header className="legal-head">
        <p className="eyebrow">Tokentracky / {page === 'support' ? 'Help' : 'Legal'}</p>
        <h1>{doc.heading}</h1>
        <p className="legal-lede">{doc.lede}</p>
        <dl className="legal-meta">
          <div><dt>Updated</dt><dd>{UPDATED}</dd></div>
          <div><dt>Contact</dt><dd><Mail /></dd></div>
        </dl>
      </header>
      <div className="legal-layout">
        <nav className="legal-toc" aria-label="On this page">
          <p className="eyebrow">On this page</p>
          <ol>{doc.sections.map((section) => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ol>
        </nav>
        <article className="legal-body">
          {doc.sections.map((section, index) => <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
            <p className="legal-num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</p>
            <h2 id={`${section.id}-title`}>{section.title}</h2>
            {section.body}
          </section>)}
        </article>
      </div>
    </main>
    <footer className="footer"><div className="footer-inner"><span>Tokentracky · Waste tokens, not time.</span><LegalLinks /><span>Operated by {OPERATOR}</span></div></footer>
  </div>;
}
