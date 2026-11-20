import React from 'react';
import { guide } from '../src/footer-guides';

const revision = '96621c89bf8b1d5a666c654fb945ee6ab1e01450';
const file = 'https://github.com/AuvreyDurelle/tokentracky/blob/' + revision + '/';
const fixture = 'https://github.com/AuvreyDurelle/tokentracky/tree/' + revision + '/fixtures/';

export const sessionGuides = [
  {
    ...guide('copilot-chat-token-usage'),
    description: 'Track Copilot Chat tokens from a VS Code file export and Copilot CLI tokens from the session store. Follow two responses that share a trace but count separately.',
    body: <>
      <h2>Where does GitHub Copilot record token usage?</h2>
      <p>For Copilot Chat in VS Code, Tokentracky reads token counts from a local OpenTelemetry file export. For Copilot CLI, it reads the <code>assistant_usage_events</code> table in <code>~/.copilot/session-store.db</code>. If you use both, point the Chat exporter at a folder Tokentracky reads. CLI requests are collected from the database even when the same calls appear as spans in an export. These totals measure tokens in recorded requests. To check billed Copilot credits, use GitHub’s usage report.</p>
      <h2>Set up a local Copilot Chat export in VS Code</h2>
      <ol>
        <li>Create a folder named <code>.copilot-otel</code> under your home directory. Tokentracky also recognizes <code>~/.copilot/otel</code>.</li>
        <li>In VS Code Settings (checked November 20, 2026), enable <code>github.copilot.chat.otel.enabled</code>, choose <code>file</code> for <code>github.copilot.chat.otel.exporterType</code>, and set <code>github.copilot.chat.otel.outfile</code> to an absolute filename directly inside that folder, for example <code>/Users/ada/.copilot-otel/chat.jsonl</code> on a Mac. Substitute your own home directory. Leave <code>github.copilot.chat.otel.captureContent</code> off. Token counts come from usage attributes.</li>
        <li>Run a new Chat request. Look for a Chat log record in the JSONL file. Tokentracky skips records marked <code>type: span</code>. The log record needs a <code>gen_ai.response.id</code>, nonzero token usage, and a <code>gen_ai.operation.name</code> of <code>chat</code>. With the Copilot source enabled in Tokentracky, check the report after the next scan.</li>
      </ol>
      <h2>Count the responses in a single trace</h2>
      <p>In the public test export, two responses share <code>trace-2</code> and <code>span-9</code>. The first uses 2,000 input tokens and 300 output. Of that input, 1,200 tokens are cache reads and 300 are cache writes, leaving 500 ordinary input. The second response uses 800 input and 100 output. Their distinct response IDs give two requests and <strong>3,200 tokens</strong> in all.</p>
      <p>If your sum is larger, check whether you also added a CLI span, a tool span, or a trace-level metric. If it is smaller, check for records missing a response ID. An older CLI that only exported spans has no supported session-store rows for those requests. The <a href="/blog/what-joining-the-leaderboard-shares">leaderboard privacy guide</a> shows which fields from local counts can appear on a public profile.</p>
    </>,
    sources: [
      { label: 'VS Code’s Copilot settings reference', url: 'https://code.visualstudio.com/docs/copilot/reference/copilot-settings' },
      { label: 'Inspect the Copilot Chat export and expected events', url: fixture + 'copilot/otel-exports' },
      { label: 'Check the rules for Chat records and CLI rows', url: file + 'crates/collector/src/readers/copilot.rs' },
    ],
  },
  {
    ...guide('lm-studio-local-token-usage'),
    description: 'Read token usage in LM Studio server logs for Chat Completions and Responses. Reconcile cached input, repeated responses, and the $0 local model estimate.',
    body: <>
      <h2>Find the token count for a local LM Studio prediction</h2>
      <p>Send a request through the LM Studio local server and let the prediction finish. Open the matching <code>.log</code> file under <code>~/.lmstudio/server-logs</code> and find the generated prediction’s response ID and <code>usage</code> object. For Chat Completions, add <code>prompt_tokens</code> and <code>completion_tokens</code>. For the Responses API, add <code>input_tokens</code> and <code>output_tokens</code>. Tokentracky counts the resulting tokens and prices local LM Studio inference at <strong>$0 in API charges</strong>. That figure has no allowance for electricity or hardware.</p>
      <h2>Read the two response formats side by side</h2>
      <table><caption>Two predictions in the October 20 synthetic server log</caption><thead><tr><th scope="col">Response</th><th scope="col">What the usage fields say</th><th scope="col">Tokens</th></tr></thead><tbody>
        <tr><th scope="row">Qwen · Chat Completions</th><td>2,000 prompt, including 1,500 cached. Of the 300 completion tokens, 120 are reasoning.</td><td>2,300</td></tr>
        <tr><th scope="row">Gemma · Responses API</th><td>1,293 input, including 1,276 cached. The model returns 42 output.</td><td>1,335</td></tr>
      </tbody></table>
      <p>The Gemma line leaves just 17 ordinary input tokens. A dashboard breakdown of 17 input, 1,276 cache reads and 42 output accounts for the whole prediction. For Qwen, the 120 reasoning tokens describe part of the completion and have already contributed to its 2,300.</p>
      <h2>Reconcile two days of server logs</h2>
      <p>The October 21 file contains a copy of the Qwen response and one new Llama response with 400 input and 100 output. The response ID reveals the duplicate. Qwen’s own creation time places its 2,300 tokens on October 20, even in the later file. Across both files the three distinct responses account for <strong>4,135 tokens</strong>.</p>
      <p>To investigate a missing prediction, check that the logged JSON is complete, carries a response ID, and has consistent usage counters. One rejected fixture entry claims 99 total tokens for 10 prompt and five completion. A request body alone also supplies no completed response usage. For the meaning of the dollar estimate beside a published total, see <a href="/blog/how-to-read-the-token-leaderboard">how to read the leaderboard</a>.</p>
    </>,
    sources: [
      { label: 'Compare the two server logs and expected totals', url: fixture + 'lmstudio/server-logs-responses' },
      { label: 'Read the LM Studio response parser', url: file + 'crates/collector/src/readers/lmstudio.rs' },
      { label: 'Check how the pricing table handles local models', url: file + 'crates/pricing/src/table.rs' },
    ],
  },
  {
    ...guide('cline-checkpoint-token-usage'),
    description: 'See what a Cline checkpoint restore does to tracked token usage. Follow one classic extension request from its empty placeholder to its deleted-request summary.',
    body: <>
      <h2>Why does token usage survive a Cline checkpoint restore?</h2>
      <p>Restoring task history in classic Cline can remove a request after the model has already processed it. A files-only restore leaves the conversation in place. If Tokentracky observed the completed request, it keeps those tokens. In the synthetic task below, a single request contributes <strong>1,700 tokens</strong> before the restore and the same 1,700 afterwards.</p>
      <h2>Follow one request through four scans</h2>
      <p>The classic extension writes <code>ui_messages.json</code> in the editor’s <code>globalStorage/saoudrizwan.claude-dev/tasks/&lt;task-id&gt;</code> folder. In task <code>t1</code>, the same <code>api_req_started</code> message changes as the response arrives.</p>
      <ol>
        <li><strong>Stream started.</strong> The message exists, but its embedded JSON has no usage counters. The first scan contributes zero.</li>
        <li><strong>Stream finished.</strong> Cline updates that message in place. Its <code>tokensIn</code> is 400, <code>tokensOut</code> is 200, <code>cacheWrites</code> is 100, and <code>cacheReads</code> is 1,000. These are separate counters. Their sum is 1,700.</li>
        <li><strong>Unchanged rescan.</strong> The task ID and request timestamp still identify the same request. The running total stays at 1,700.</li>
        <li><strong>Checkpoint restored.</strong> Cline replaces the original message with a <code>deleted_api_reqs</code> summary carrying the same counters. Tokentracky skips that summary and retains the request it already observed. Adding both would produce 3,400.</li>
      </ol>
      <h2>Check which evidence was available to the collector</h2>
      <p>If you first enabled tracking after the restore, a deleted-request summary alone cannot recreate the original request in Tokentracky. In the example, the completed message identifies <code>claude-sonnet-4-6</code>. The replacement summary has no model field. Whether the collector saw the completed message changes what it can report.</p>
      <p>The completed message also carries <code>cost</code> of 0.0123. Tokentracky estimates Cline costs from the model’s prices when available, so that embedded number is unsuitable for checking the token calculation. For another example of preserving the identity of an earlier request, see <a href="/blog/how-tokentracky-counts-tokens">how Tokentracky counts forked Codex sessions</a>.</p>
    </>,
    sources: [
      { label: 'Choose what to restore at a Cline checkpoint', url: 'https://docs.cline.bot/core-workflows/checkpoints' },
      { label: 'Follow the four Cline scans, including the restored task', url: fixture + 'cline/classic-update-in-place-and-checkpoint-restore/steps' },
      { label: 'Check which classic Cline messages the reader accepts', url: file + 'crates/collector/src/readers/cline.rs' },
    ],
  },
  {
    ...guide('opencode-compaction-token-usage'),
    description: 'Trace OpenCode v2 compaction token usage through the session_message table. See why an unnamed model can add 1,750 tokens and a copied fork row adds zero.',
    body: <>
      <h2>Does OpenCode context compaction count toward token usage?</h2>
      <p>Yes, when OpenCode v2 records token usage for the compaction in <code>session_message</code>. Tokentracky counts that work alongside assistant requests. A compaction can contribute tokens even when the row omits its model. In the public example, one assistant reply and one compaction account for <strong>3,500 tokens</strong> in a single session.</p>
      <h2>Inspect the rows that explain the total</h2>
      <p>From a Tokentracky checkout, load the synthetic SQL into a temporary in-memory database with the SQLite command-line tool. For your own OpenCode v2 data, the command for the default database is <code>sqlite3 -readonly ~/.local/share/opencode/opencode.db</code>. If you set <code>XDG_DATA_HOME</code> or <code>OPENCODE_DB</code>, substitute the path to your configured database.</p>
      <pre><code>sqlite3 -init fixtures/opencode/v2-assistant-and-compaction-rows/root/opencode.db.sql :memory:</code></pre>
      <p>At the SQLite prompt, run the query below, substituting your session ID when using your own database. It selects message IDs, types, models, and counters, so you can inspect the rows without displaying conversation text.</p>
      <pre><code>{`SELECT id, type,
  json_extract(data, '$.model.id') AS model,
  json_extract(data, '$.tokens') AS usage
FROM session_message
WHERE session_id = 'ses_02TEST'
ORDER BY seq;`}</code></pre>
      <p>In the fixture, <code>msg_02TEST</code> has 400 input, 1,000 cache reads, 100 cache writes, 200 output and 50 reasoning tokens. OpenCode records reasoning separately here. Tokentracky folds it into output, so the dashboard shows 250 output and the request totals <strong>1,750</strong>. The <code>msg_COMPACT</code> row has the same counters and no model ID. Find its 1,750 under <code>unknown</code> in the model breakdown.</p>
      <h2>Explain the rows left over</h2>
      <ul>
        <li><code>msg_PENDING</code> is an assistant row with no token counters. A stored message alone gives the collector no usage to count.</li>
        <li><code>msg_USER</code> contains a user message. Its text does not supply another measured input count.</li>
        <li>In the separate fork session, <code>msg_evt_1</code> copies the parent’s assistant request. Counting it as fresh work would inflate the total to 5,250. The assistant reply and the compaction in the parent both count because they are distinct operations, even though their counters happen to match.</li>
      </ul>
      <p>For a second example of how the collector distinguishes copied history from new work, follow the <a href="/blog/how-tokentracky-counts-tokens">open-source walkthrough of a forked session</a>.</p>
    </>,
    sources: [
      { label: 'Inspect the five OpenCode message rows in the synthetic database', url: file + 'fixtures/opencode/v2-assistant-and-compaction-rows/root/opencode.db.sql' },
      { label: 'Check the expected model and session totals', url: file + 'fixtures/opencode/v2-assistant-and-compaction-rows/rust-expected/summary.json' },
      { label: 'Read the OpenCode v2 usage and reasoning rules', url: file + 'crates/collector/src/readers/opencode.rs' },
    ],
  },
];
