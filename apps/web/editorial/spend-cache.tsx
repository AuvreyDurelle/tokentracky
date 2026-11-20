import React from 'react';
import { guide } from '../src/footer-guides';

const claudeCache = 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const openAICache = 'https://developers.openai.com/api/docs/guides/prompt-caching';

export const cacheSpendGuides = [
  {
    ...guide('prompt-caching-break-even'),
    description: 'A prompt cache pays off when discounted reads earn back the write premium. Calculate how many reuses you need when some requests miss or reuse only part of the prefix.',
    body: <>
      <h2>Compare the write premium with the next read</h2>
      <p>Price the same input twice: once at ordinary input rates and once using the actual read, write and ordinary-input counts. Hold output and the changing suffix fixed. For this example, use illustrative rates of $4 per million ordinary input tokens, $5 per million written, and $0.40 per million read. A 10,000-token prefix costs $0.040 without caching. Writing it costs $0.050, so you start $0.010 behind. Each full hit costs $0.004 and saves $0.036 against sending that input uncached.</p>
      <p>With one write and only full hits afterward, divide the extra write cost by the savings per hit. Here, $0.010 ÷ $0.036 is about 0.278. The number of reads must exceed that threshold for positive savings, so one full read is enough. The two requests cost $0.054 instead of $0.080.</p>
      <h2>Count tokens when some requests only partly match</h2>
      <p>Suppose a 2,500-token preamble still matches, but a revised reference section means the remaining 7,500 tokens are written at a cache breakpoint. That request costs $0.001 + $0.0375 = $0.0385, saving just $0.0015. Seven requests recover the initial $0.010 premium if each reads those same 2,500 tokens and writes a newly changed 7,500-token section. Check that both marked prefixes meet the chosen model’s cache requirements. If the whole section stays unchanged, a later request can become a full hit. A full miss that rewrites all 10,000 tokens adds another $0.010 to recover.</p>
      <p>For a mixed run of one initial write, two partial hits like these, a full rewrite and one full read, add the five charges: $0.050 + $0.077 + $0.050 + $0.004 = <strong>$0.181</strong>. Ordinary input would cost $0.200. Stop a trial if the savings from actual reads fail to cover the write premiums over a representative cycle. A miss charged as ordinary input contributes zero savings and zero write premium.</p>
      <p>For your own API, check the model’s rates and confirm the token categories in its response. If the repeated workload is in Claude Code, <a href="/join">set up the local Tokentracky dashboard</a> and export the Claude Code period from <strong>Tokens</strong>. If you have confirmed one model and one write lifetime, sum <code>cache_read</code> and <code>cache_write</code> and apply those rates. The CSV combines write lifetimes. For mixed lifetimes, use the original Claude usage record’s <code>cache_creation.ephemeral_5m_input_tokens</code> and <code>cache_creation.ephemeral_1h_input_tokens</code> to price the two write premiums separately.</p>
    </>,
    sources: [{ label: 'Claude API cache pricing and token accounting', url: claudeCache }],
  },
  {
    ...guide('stable-prompt-prefix'),
    description: 'Put fixed instructions and reference material ahead of changing dates and IDs. See exactly where to put a Claude API cache breakpoint and how to verify the next request reuses it.',
    body: <>
      <h2>Put the cache breakpoint before the first changing block</h2>
      <p>On the Claude Messages API, an explicit breakpoint covers the prefix through the block it marks. Anthropic requires an exact match through that block, in the order <code>tools</code>, <code>system</code>, then <code>messages</code>. For Claude Sonnet 4.6, the minimum cacheable prefix is 1,024 tokens as checked on November 20, 2026.</p>
      <p>Imagine a support classifier with a 1,600-token policy and two tickets about incidents on different dates. This layout includes the ticket date and ID in the marked system block. Changing them breaks the match before the policy text even begins.</p>
      <pre><code>{String.raw`{
  system: [{
    type: "text",
    text: "Date: 2026-11-20, ticket: TK-318\n" + policyText,
    cache_control: { type: "ephemeral" }
  }],
  messages: [{ role: "user", content: "The export has no header." }]
}`}</code></pre>
      <p>Keep the same policy text in the system block and put the ticket fields in the user message. These JavaScript objects show the changing fields of the request body. Keep the model, output limit and any tool definitions fixed during the test.</p>
      <pre><code>{String.raw`{
  system: [{
    type: "text",
    text: policyText,
    cache_control: { type: "ephemeral" }
  }],
  messages: [{
    role: "user",
    content: "Date: 2026-11-20, ticket: TK-318\nThe export has no header."
  }]
}`}</code></pre>
      <h2>Change the ticket twice and check the usage</h2>
      <p>Send the revised layout twice within the default five-minute lifetime. In the second request, change the ticket to TK-319, the incident date to 2026-11-19, and the ticket text. Start with a cold policy prefix and send the second request after the first response begins and within five minutes of the first request’s start. Look for positive <code>usage.cache_creation_input_tokens</code> on the first request and positive <code>usage.cache_read_input_tokens</code> on the second. The second ticket text still incurs ordinary input charges. If the reads stay at zero, count the tokens through the marked block, then compare the exact serialized blocks before it, including tools. Stop when the second request reads the policy and both tickets still receive the expected classification. Keep any instructions that define the classifier’s behavior in the system message.</p>
      <p>For a separate test in Claude Code, <a href="/join">install Tokentracky</a> and filter the local <strong>Tokens</strong> view to Claude Code. Compare the recorded cache reads across controlled coding runs. Inspect the API’s own usage objects for the Messages requests above.</p>
    </>,
    sources: [{ label: 'Claude Messages API prefix ordering, breakpoints and minimum lengths', url: claudeCache }],
  },
  {
    ...guide('measure-prompt-cache-hits'),
    description: 'Divide cached input tokens by all input tokens to see how much work the cache reuses. A mixed-length example shows how 90% of requests can hit while only 18% of input tokens are cached.',
    body: <>
      <h2>Report two rates with their denominators</h2>
      <p>Request hit rate is the number of responses with any cache read divided by responses with usable token counts. Cached input share is the sum of cached tokens divided by the sum of input tokens for that same set. The first tells you how often the cache engages. The second tells you how much of the input it serves.</p>
      <table><caption>Illustrative usage for ten requests to the same model</caption><thead><tr><th scope="col">Requests</th><th scope="col">Input per request</th><th scope="col">Cached per request</th></tr></thead><tbody>
        <tr><th scope="row">9 short checks</th><td>2,000</td><td>1,280</td></tr>
        <tr><th scope="row">1 long analysis</th><td>46,000</td><td>0</td></tr>
      </tbody></table>
      <p>Nine of ten requests hit, or <strong>90%</strong>. Cached input is 9 × 1,280 = 11,520 tokens out of 9 × 2,000 + 46,000 = 64,000, or <strong>18%</strong>. Averaging each request’s individual cached share would give 57.6%, giving the 46,000-token miss the same weight as a short check. Investigate whether the long analyses actually share a reusable prefix before trying to lift their cache rate.</p>
      <h2>Check what the input field already includes</h2>
      <p>In OpenAI’s Responses API, sum <code>usage.input_tokens_details.cached_tokens</code> for the numerator and <code>usage.input_tokens</code> for the denominator. Cached tokens already sit inside the input count. Track missing usage separately and compare the same model and task mix across periods. On models that report <code>cache_write_tokens</code>, subtract both cached tokens and written tokens from total input to find ordinary input. Price each category separately, splitting writes by lifetime when their rates differ.</p>
      <p>To run the token-share calculation for local Claude Code usage, <a href="/join">open Tokentracky after setup</a>, choose Claude Code and a period in <strong>Tokens</strong>, and export CSV. Its <code>input</code> column is separate from <code>cache_read</code> and <code>cache_write</code>. Sum all three for the denominator and use <code>cache_read</code> alone in the numerator. Leave output out of the calculation, and use API response records for any request hit rate.</p>
    </>,
    sources: [{ label: 'OpenAI Responses API cache metrics and aggregation', url: openAICache }],
  },
  {
    ...guide('choose-prompt-cache-ttl'),
    description: 'Choose a Claude cache lifetime by replaying the gaps between repeated requests. An eight-request timeline shows when the one-hour cache earns back its higher write cost.',
    body: <>
      <h2>Measure the gap since the last use</h2>
      <p>Claude’s Messages API offers a five-minute cache by default and a one-hour cache with <code>ttl: "1h"</code> on the <code>cache_control</code> object with <code>type: "ephemeral"</code>. As checked November 20, 2026, writes cost 1.25× and 2× ordinary input respectively. A read refreshes the entry’s existing lifetime without a new write charge. For the example use a 0.1× read rate, as listed for Claude Sonnet 4.6. Check the rate for your model.</p>
      <p>Say a release tool sends the same eligible checklist prefix at the following request-start times in minutes. Assume each write becomes available before any follow-up and that the prefix and model stay fixed. Replay each TTL on its own cold entry.</p>
      <table><caption>Write and read events for one repeated prefix</caption><thead><tr><th scope="col">Minute</th><th scope="col">5-minute TTL</th><th scope="col">1-hour TTL</th></tr></thead><tbody>
        <tr><th scope="row">0</th><td>Write</td><td>Write</td></tr>
        <tr><th scope="row">4, 8</th><td>Read, read</td><td>Read, read</td></tr>
        <tr><th scope="row">16, 20</th><td>Write, read</td><td>Read, read</td></tr>
        <tr><th scope="row">29</th><td>Write</td><td>Read</td></tr>
        <tr><th scope="row">94, 98</th><td>Write, read</td><td>Write, read</td></tr>
      </tbody></table>
      <p>Minute 8 is a short-cache hit because minute 4 refreshed the entry. Minute 94 follows a 65-minute gap, so both policies write. In units of the ordinary input price for one prefix, the five-minute policy costs 4 × 1.25 + 4 × 0.1 = 5.4. One hour costs 2 × 2 + 6 × 0.1 = <strong>4.6</strong>. If work always ended at minute 8, five minutes would win at 1.45 versus 2.2.</p>
      <h2>Replay a representative run before changing the TTL</h2>
      <p>Group API request-start times by stable prefix and model, replay the gaps, then compare predicted reads and writes with the API’s usage fields. Use separate cold entries to test the two lifetimes. An existing five-minute hit keeps refreshing for five minutes even if you now ask for one hour. Keep the shorter policy if the longer one fails to lower prefix cost and you have no measured latency benefit worth paying for.</p>
      <p>If your candidate workflow is an interactive Claude Code session, choose Claude Code and <strong>Export CSV</strong> in the local dashboard after <a href="/join">installing Tokentracky</a>. Look for gaps between recorded events in the same session and see where cache writes cluster. The export has a logged event time and no prefix ID. Use it to select a test window, then use your API request log to replay the exact gaps. Set and verify TTL on requests you control through the API.</p>
    </>,
    sources: [{ label: 'Claude cache lifetimes, refresh behavior and rates', url: claudeCache }],
  },
  {
    ...guide('batch-api-cost'),
    description: 'Use a batch API for work that can wait through the queue and still leave time for retries. Price an overnight job using completed, expired and retried requests.',
    body: <>
      <h2>Start with the deadline and the fallback</h2>
      <p>Batch 1,000 support-ticket tags due in 30 hours. Keep interactive ticket replies synchronous. As checked November 20, 2026, OpenAI Batch charges 50% less than the synchronous API for supported requests and uses a 24-hour completion window. A batch can expire with unfinished requests. Before submitting, verify that polling and ingestion plus a synchronous fallback can fit in the six hours left after that window. A Batch input file targets one model and can contain up to 50,000 requests and 200 MB. Check the model’s available queued input-token capacity too. At 2,000 input tokens per ticket, the run needs room for roughly two million queued tokens.</p>
      <h2>Reconcile results by ticket ID</h2>
      <p>Give each JSONL line a unique <code>custom_id</code> that maps back to its ticket and tagging version. Output can arrive out of order. When the batch reaches a terminal state, join both output and error records to the input list by ID. Persist each validated result once, even if you ingest the files twice. Retry only the IDs that still need a result after reconciling them.</p>
      <p>Use illustrative synchronous rates of $2 per million input tokens and $10 per million output tokens. At 2,000 input and 200 output tokens per completed attempt, the cost is $0.006 synchronously or $0.003 in batch. Suppose 960 results pass validation, 10 billed results fail your label checks, and 30 requests expire unfinished. The batch costs 970 × $0.003 = $2.91. After fixing the cause of the invalid labels, one successful synchronous pass on the 40 unresolved tickets costs 40 × $0.006 = $0.24. Total cost is <strong>$3.15</strong> against $6.00 for 1,000 synchronous successes under the same token assumptions. That’s 47.5% lower in this scenario.</p>
      <p>If all 1,000 tickets must fall back, six hours means at least 2.78 requests and about 5,556 input tokens per minute on average. Allow extra time for polling, output-token reservations, and ingestion. Check both synchronous rate limits before promising the deadline. In the fallback window, stop automatic attempts after one retry per unresolved ticket and surface anything still missing. Use the provider’s batch usage and your result ledger to check cost per accepted ticket.</p>
      <p>Track development separately. If you build and debug the tagger in Codex, filter Tokentracky’s private <strong>Tokens</strong> view to Codex for the development period. The <a href="/blog/how-tokentracky-counts-tokens">Codex counting example</a> shows how inherited session history is handled if you fork a debugging session. Use the batch output and provider usage for the production job.</p>
    </>,
    sources: [{ label: 'OpenAI Batch API pricing, queue limits, result IDs and expiration', url: 'https://developers.openai.com/api/docs/guides/batch' }],
  },
  {
    ...guide('reuse-completed-ai-answers'),
    description: 'Return a stored answer before making a model call when the inputs, versions and access scope still match. Build a cache key that handles policy edits and revoked access.',
    body: <>
      <h2>Cache an answer you can safely return again</h2>
      <p>A response cache stores a completed result. On a hit, your application can return it without sending any new input or generating new output. Prompt caching reuses the provider’s work on the input prefix and still generates a fresh answer. Use exact-result caching for a task where reuse is acceptable, such as summarizing an immutable revision of an internal runbook in a fixed output format.</p>
      <h2>Make changes to the task change the key</h2>
      <p>Authorize the caller against the runbook on every request, including cache hits. For this example, the summary may be reused by the same authorized user only. Hash a consistently serialized tuple such as the one below. Here <code>policy-17</code> is the current access-policy revision, <code>rev-8</code> identifies immutable text, and <code>model-release-42</code> stands for the pinned model deployment in this application.</p>
      <pre><code>{`[
  "runbook-summary:v3", "org-14", "user-52", "policy-17",
  "runbook-7", "rev-8", "en", "model-release-42",
  "prompt-v5", "schema-v2", "generation-settings-v1"
]`}</code></pre>
      <p>Store only a validated, complete response. Include any additional input that can change the answer, such as a user-supplied focus. A request for the latest runbook first resolves its current revision. When the runbook moves to <code>rev-9</code>, it gets a new summary even within the cache’s retention window. A user who loses access fails the permission check before lookup. Treat expired entries as misses and delete stored results on a retention schedule that suits the sensitivity of the text. Propagate any required source deletion to cached summaries.</p>
      <h2>Test a hit, a stale result and a permission change</h2>
      <p>Repeat the same authorized request and verify the model call counter stays flat. Change the runbook revision and verify it rises once. Keeping that revision fixed, change only the prompt or schema version and confirm the old answer is skipped. Revoke access and verify the caller receives no summary. If any test fails, bypass the cache until the behavior is fixed. For 500 requests with 180 validated cache hits and an illustrative $0.006 per model request, you avoid 180 calls and save <strong>$1.08</strong> before storage and lookup costs, assuming no other discounts. Measure calls with the application’s own counters.</p>
      <p>If you implement the cache with Claude Code, you can check the coding session’s token usage privately without publishing it. See <a href="/blog/what-joining-the-leaderboard-shares">what device approval shares</a> if you’re deciding whether to connect that computer.</p>
    </>,
    sources: [
      { label: 'OpenRouter’s documented exact-response matching and TTL behavior', url: 'https://openrouter.ai/docs/guides/features/response-caching' },
      { label: 'OpenAI’s explanation of provider-side prompt prefix reuse', url: openAICache },
    ],
  },
];
