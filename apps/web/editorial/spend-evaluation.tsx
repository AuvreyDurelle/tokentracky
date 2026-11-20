import React from 'react';
import { guide } from '../src/footer-guides';

export const evaluationSpendGuides = [
  {
    ...guide('benchmark-token-savings'),
    description: 'Run both prompts on the same tasks, report what a typical task saves alongside the total, and reject savings that break a required case.',
    body: <>
      <h2>Pair every run with the same task</h2>
      <p>To benchmark prompt token savings, send each task to both the current prompt and the proposed replacement. Pin the model version, tool definitions, task inputs, output limit and other generation settings. Start fresh conversations and alternate which variant goes first. Capture the provider’s usage and grade the answers without showing the grader which prompt produced them.</p>
      <p>Pick the cache conditions before running. For a cold comparison, confirm from usage that neither arm received a cache hit and record any writes and their charges separately. If you cannot isolate cold runs, run both variants with comparable warm-up and log reads and writes separately. Compare total input volume across token categories, then apply each category’s rate when estimating cost. Repeat pairs when output or grades vary, and include failed attempts in workflow costs.</p>
      <h2>Read the median and the pooled result together</h2>
      <p>Suppose your triage prompt appends whole playbooks based on ticket tags. The candidate appends short playbook excerpts instead. Both variants receive the same ticket text. Each answer must return a queue and a one-line reason. This smoke test uses illustrative input counts, including the request’s instructions and ticket context.</p>
      <table><caption>Four paired runs</caption><thead><tr><th scope="col">Ticket</th><th scope="col">Old to new input tokens</th><th scope="col">New answer</th></tr></thead><tbody>
        <tr><th scope="row">Address correction</th><td>500 to 400</td><td>Pass</td></tr>
        <tr><th scope="row">Duplicate shipment</th><td>1,000 to 700</td><td>Pass</td></tr>
        <tr><th scope="row">Refund status</th><td>1,500 to 1,200</td><td>Pass</td></tr>
        <tr><th scope="row">Chargeback buried in a long thread</th><td>7,000 to 2,800</td><td>Wrong queue</td></tr>
      </tbody></table>
      <p>The median of the four paired reductions (20%, 30%, 20% and 60%) is <strong>25%</strong>. Pooled input drops from 10,000 to 5,100 tokens, or <strong>49%</strong>. The long ticket contributes 4,200 of the 4,900 tokens saved. Write down both statistics and compare output tokens separately. If production traffic has fewer long tickets, estimate savings by weighting each category by its actual frequency.</p>
      <h2>Make a failure worth finding</h2>
      <p>Set the release gate before the trial. For example, require every chargeback ticket to reach the disputes queue and demand at least 15% pooled input savings on a held-out set. The old prompt routed the long ticket correctly. The candidate dropped the escalation rule and sent it to refunds, so stop the rollout. Restore that rule, add other chargeback cases and rerun both variants on unseen tickets before making a decision.</p>
      <p>If the experiment changes your instructions for local Claude Code, <a href="/join">set up Tokentracky’s private dashboard</a> and export the trial period from <strong>Tokens</strong>. Keep a separate roster of session IDs and variants. Match the export rows by session and sum <code>input</code>, <code>cache_read</code> and <code>cache_write</code> for input volume. Score the answers against your rubric separately.</p>
    </>,
    sources: [
      { label: 'Design task-specific evaluations and test edge cases', url: 'https://developers.openai.com/api/docs/guides/evaluation-best-practices' },
    ],
  },
  {
    ...guide('token-cost-of-few-shot-examples'),
    description: 'Keep the examples that prevent expensive mistakes. Compare smaller prompt variants by cost per usable answer, with a separate gate for hard cases.',
    body: <>
      <h2>Remove examples one at a time on the same test set</h2>
      <p>Start with the instructions and a few labeled demonstrations, then remove each example in turn. Use a fixed model, rubric and screening set for the repeated removals. Keep an untouched confirmation set with its own hard negatives. Leave the surviving examples in their original order, and measure the whole request with the actual message structure. An example adds its labels and formatting as well as its text.</p>
      <p>Suppose a classifier flags support messages that explicitly ask to cancel. Your four demonstrations are a direct cancellation, a second direct cancellation phrased similarly, a question about cancellation fees, and a quoted cancellation request the sender says to ignore. In the screening set, “What would I pay if I canceled?” and “Ignore the cancellation request forwarded below” are negative cases. Include distinct positive paraphrases too, such as “Please end my plan at renewal.”</p>
      <h2>Price the usable answers</h2>
      <p>In an illustrative uncached run of 1,000 messages per variant, generation consumes 50,000 output tokens per variant, including malformed answers. At illustrative rates of $2 per million input and $8 per million output tokens, divide the whole run’s cost by the number that match the expected label and format. The two-example variant below keeps the direct cancellation and the quoted-request negative.</p>
      <table><caption>Three variants after screening individual removals</caption><thead><tr><th scope="col">Examples</th><th scope="col">Input and usable answers</th><th scope="col">Cost per 1,000 usable answers</th></tr></thead><tbody>
        <tr><th scope="row">Four</th><td>800,000 tokens, 980 usable</td><td>$2.04</td></tr>
        <tr><th scope="row">Three, drop the duplicate</th><td>700,000 tokens, 975 usable</td><td>$1.85</td></tr>
        <tr><th scope="row">Two, also drop the fees example</th><td>600,000 tokens, 940 usable</td><td>$1.70</td></tr>
      </tbody></table>
      <p>Three examples cost $1.40 in input and $0.40 in output. The $1.80 run cost divided by 975, then multiplied by 1,000, gives $1.85. If your production flow retries, count all attempts in the numerator and each finally accepted task once in the denominator. Track manual repair separately if it materially affects the choice.</p>
      <p>Say your gate is at least 970 usable answers and zero false positives on 40 hard negatives. Four and three pass. Two mislabels seven fee questions and fails both gates despite its lower unit cost. Keep three for a fresh confirmation run. If another removal passes both gates, measure the smaller combination itself before adopting it. Two individually harmless removals can interact.</p>
      <p>For demonstrations in local Codex instructions, <a href="/join">install Tokentracky to compare local Codex sessions</a>. Run matched tasks in separate fresh sessions, label the session IDs in your score sheet and export the Codex usage from <strong>Tokens</strong>. Include repair turns in the variant’s totals.</p>
    </>,
    sources: [
      { label: 'Choose diverse examples that cover edge cases', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#use-examples-effectively' },
    ],
  },
  {
    ...guide('preflight-token-count'),
    description: 'Count the structured Claude request before generation, leave room for the answer, and reconcile the estimate with the usage returned afterward.',
    body: <>
      <h2>Send the structured payload to the counting endpoint</h2>
      <p>For Claude’s Messages API, post the model, system prompt and message blocks to <code>/v1/messages/count_tokens</code>. Include the client tool definitions you will send. The advisor tool can be counted for the executor’s first sampling call only. Other server tools and the MCP connector are unsupported by this endpoint. For images and PDFs, use base64 content; URL and file references are rejected. If the production request includes unsupported features, use the generation response’s usage to measure that request. Counting the document text alone misses those fields and message overhead. The endpoint returns an <code>input_tokens</code> estimate without creating a model response. Anthropic’s counting endpoint is free and has a separate requests-per-minute limit.</p>
      <p>This Bash example uses <code>curl</code>, <code>jq</code>, a local <code>chapter.txt</code> and an existing <code>ANTHROPIC_API_KEY</code> environment variable. The model and API version shown follow the documentation checked November 20, 2026. Use the model you will actually call.</p>
      <pre><code>{`set -e -o pipefail

jq -n --rawfile chapter chapter.txt '
  {model: "claude-sonnet-5-5",
   system: "Summarize the chapter using only details in the text.",
   messages: [{role: "user", content: [{type: "text", text: $chapter}]}]}
' > count-request.json

curl -fsS https://api.anthropic.com/v1/messages/count_tokens \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -H "anthropic-version: 2026-10-21" \\
  -H "content-type: application/json" \\
  --data-binary @count-request.json | jq -e '.input_tokens'`}</code></pre>
      <h2>Decide whether to send, shorten or split</h2>
      <p>Say your application caps a single job at 32,000 tokens including the response. An illustrative preflight count of 29,800 plus a 3,000-token output allowance gives 32,800 before any margin. If you set aside another 200 for estimate drift, your input target is 28,800. Remove at least 1,000 estimated tokens, split at a section boundary if necessary, and recount the exact revised payload. Check the model’s own context and output limits too. For generation, post the same content to <code>/v1/messages</code> and add <code>max_tokens: 3000</code> as a JSON field.</p>
      <h2>Compare preflight with the first actual response</h2>
      <p>For example, an estimate of 28,700 and actual counts of 8,650 ordinary input tokens plus 20,000 cache-read tokens give a 50-token gap. For the initial Messages response, add <code>usage.input_tokens</code>, <code>usage.cache_creation_input_tokens</code> and <code>usage.cache_read_input_tokens</code>, treating absent cache fields as zero. Compare that sum with the estimate. Record <code>usage.output_tokens</code> separately and check <code>stop_reason</code> for truncation. Anthropic says the estimate can differ slightly and can include automatically added system tokens that it does not bill. Counting does not exercise prompt caching. Investigate a large gap by comparing the exact model, message blocks, tools and attachments in both payloads before changing your margin. Budget any later tool results as part of their own requests.</p>
      <p>For large excerpts you instead paste into local Claude Code, <a href="/join">open Tokentracky’s local dashboard after setup</a> and check the Claude Code session’s recorded token use after a pilot. Start the dashboard with <code>tokentracky serve</code> if it is not already running.</p>
    </>,
    sources: [
      { label: 'Check the Claude counting endpoint’s schema and response', url: 'https://platform.claude.com/docs/en/api/messages/count_tokens' },
      { label: 'Read the counting guide’s estimation and caching rules', url: 'https://platform.claude.com/docs/en/build-with-claude/token-counting' },
      { label: 'Verify how Claude reports input tokens across cache categories', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance' },
    ],
  },
  {
    ...guide('reduce-translation-token-cost'),
    description: 'Translate changed passages and reuse approved text for the rest. Include glossary and context changes in the decision so fewer calls still produce a coherent document.',
    body: <>
      <h2>Reuse approved translations by section and locale</h2>
      <p>To reduce translation API token costs on a document you update every week, keep a translation memory with the source text and the approved target text for each stable section ID and locale. Store a source hash, the relevant glossary terms or revision, and a context key such as the screen or feature name. Reuse only when those fields still match. A section can move without needing retranslation if its meaning and context stay the same.</p>
      <p>For an English-to-French help center, “draft” in a page about editing means <em>brouillon</em>. The same word in an invoicing UI might need <em>facture provisoire</em>. Select glossary entries by feature. For ambiguous sections, send the nearby heading or sentence and include that context in the reuse key so a changed heading triggers review. If a product term changes, invalidate matching sections in the affected locales even when the English source hash is unchanged. Keep placeholders and code spans intact.</p>
      <h2>Measure the request you avoid</h2>
      <p>Suppose a locale has 100 approved sections. This week, eight source sections change and a glossary update affects four additional IDs. Take the union per locale before submitting work. For example, a row for section 17 in French with both a source edit and a glossary change still triggers only one translation. At illustrative averages of 250 input tokens per submitted section (including glossary and context) and 180 output tokens per section, translating everything would use 25,000 input and 18,000 output tokens. The 12 affected sections use 3,000 input and 2,160 output, an <strong>88% reduction</strong> on each side at those averages. The other 88 sections still appear in the assembled document from memory. Track actual provider usage because long sections, retries and shared request overhead can change the ratio.</p>
      <h2>Check the assembled document before shipping</h2>
      <ol>
        <li>Verify every source section ID has one target section and that Markdown links, placeholders and code spans survive. Compare placeholder names and counts, even if their order changes.</li>
        <li>Check updated glossary terms in affected sections, then read ambiguous passages with their neighbors. Keep new translations out of memory until they pass review.</li>
        <li>If a section fails a deterministic check, retry once with the exact mismatch and the missing context. Route persistent failures to a bilingual reviewer and leave the current approved version in place until the replacement passes.</li>
      </ol>
      <p>If you use local Claude Code to inspect Markdown changes or fix failed locale checks, <a href="/join">set up Tokentracky to measure that editing session</a>. Keep the translation API’s token counts in the job’s own usage log so you can compare the avoided requests week to week.</p>
    </>,
    sources: [
      { label: 'See how Cloud Translation glossaries handle domain terms and product names', url: 'https://docs.cloud.google.com/translate/docs/advanced/glossary' },
    ],
  },
  {
    ...guide('token-efficient-code-review'),
    description: 'Review the full change once, then send the next push’s diff plus the contracts it touches. Rebuild the baseline when the earlier review no longer applies.',
    body: <>
      <h2>Save the exact head your first review covered</h2>
      <p>Start the AI pull request review with the diff from the PR’s merge base to its current head. Include the contracts and tests needed to judge the change. Save the target branch tip, merge base, reviewed head and open findings. Record what the reviewer checked so the next pass can carry forward unresolved issues and distinguish changes from earlier findings.</p>
      <p>For example, push A adds a reporting option that renders weights in pounds. The PR changes the converter, the export header and snapshot tests. The full review uses an illustrative 18,000 input tokens. It confirms the unit label for the CSV and leaves a finding open about rounding at display boundaries.</p>
      <h2>Review push B with the surrounding contracts</h2>
      <p>Push B changes the rounding helper and a snapshot. Verify both commit IDs and the merge base first. Use the current target tip and head, the reviewed head, and the one merge-base SHA saved in <code>saved_base</code>. The incremental diff runs only if the current merge base is unique, matches that saved SHA, and the head descends from the reviewed head. Multiple candidate bases require re-establishing the PR baseline.</p>
      <pre><code>{`if bases=$(git merge-base --all "$target_tip" "$current_head") &&
   [ "$bases" = "$saved_base" ] &&
   git merge-base --is-ancestor "$reviewed_head" "$current_head"; then
  git diff "$reviewed_head" "$current_head" --
else
  echo "Establish the current PR baseline and review the full change." >&2
fi`}</code></pre>
      <p>Include the units contract, the open rounding finding and the untouched caller that shares the helper. A changed-lines-only review would miss that the shared caller expects rounding after conversion. If the new diff and necessary context use 5,000 input tokens and a full review of push B would use 20,000, the second pass saves 15,000. Across both pushes that’s <strong>23,000 versus 38,000</strong> input tokens, about 39% fewer. Compare output separately and count any follow-up calls.</p>
      <h2>Know when to refresh the full review</h2>
      <p>Rebuild the baseline after a force-push that breaks ancestry or a change to the merge base. Also widen the review when a changed dependency, schema or shared contract invalidates earlier conclusions. If you cannot trace callers reliably, read the full current diff and the affected dependency context. Run the targeted rounding and export tests against push B, verify any retained finding against the current code, and keep the review marked incomplete until those checks pass.</p>
      <p>For reviews run in local Codex, <a href="/join">set up Tokentracky to compare the two review sessions</a>. Start a fresh session for each push, note its ID alongside the commit, then export the Codex period from <strong>Tokens</strong>. Sum the rows for each session, including the turns spent pulling in callers and rerunning checks.</p>
    </>,
    sources: [
      { label: 'Check Git’s two-commit and merge-base diff semantics', url: 'https://git-scm.com/docs/git-diff' },
      { label: 'Check the Git ancestry test and exit status', url: 'https://git-scm.com/docs/git-merge-base' },
    ],
  },
  {
    ...guide('handle-token-rate-limits'),
    description: 'Pace requests against both token and request limits, honor the provider’s retry delay, and use actual response usage to account for spend.',
    body: <>
      <h2>Reserve both tokens and a request slot before sending</h2>
      <p>A token-per-minute (TPM) limit controls token throughput. A requests-per-minute (RPM) limit controls the number of calls. Keep both budgets in one queue for workers that share a limit. Size each request using your provider’s admission rules. For example, OpenAI’s rate-limit guide describes a calculation using the larger of the configured output allowance and an input estimate based on request characters. Check your model and endpoint before implementing that estimate.</p>
      <p>Suppose your queue plans against illustrative ceilings of 8,000 TPM and four RPM, with jobs already estimated at the reservation sizes below. Keep a rolling log of sends and pace them so they don’t bunch up. This example starts with an empty queue history.</p>
      <table><caption>Five queued calls under the example limits</caption><thead><tr><th scope="col">Send at</th><th scope="col">New reservation</th><th scope="col">Sends and tokens in prior 60s including this send</th></tr></thead><tbody>
        <tr><th scope="row">00s</th><td>3,000</td><td>1 request, 3,000 tokens</td></tr>
        <tr><th scope="row">16s</th><td>2,000</td><td>2 requests, 5,000 tokens</td></tr>
        <tr><th scope="row">32s</th><td>2,000</td><td>3 requests, 7,000 tokens</td></tr>
        <tr><th scope="row">48s</th><td>1,000</td><td>4 requests, 8,000 tokens</td></tr>
        <tr><th scope="row">64s</th><td>3,000</td><td>4 requests, 8,000 tokens</td></tr>
      </tbody></table>
      <p>At 64 seconds the first request has aged out. If the last job needs 3,500 tokens, it must wait until the 16-second reservation ages out too. If the 48-second job reserves only 500 tokens, the queue has room for another 100 tokens at 50 seconds but sending a fifth request would exceed RPM. Treat the table as your own pacing rule. Providers can enforce shorter intervals or apply shared limits across models or projects.</p>
      <h2>Check response headers before the next attempt</h2>
      <p>For OpenAI, as documented November 20, 2026, log <code>x-ratelimit-remaining-requests</code> and <code>x-ratelimit-remaining-tokens</code> along with their respective <code>x-ratelimit-reset-requests</code> and <code>x-ratelimit-reset-tokens</code> headers. Check project-token headers when present. Pace against the tighter constraint. On a temporary 429, honor a valid <code>Retry-After</code> as a minimum and add a little jitter. When it’s missing, use exponential backoff with jitter and return each retry through the admission queue. Repeated unsuccessful attempts can consume rate-limit capacity.</p>
      <p>Cap attempts and time together. For example, allow three actual sends within 90 seconds. Disable automatic SDK retries when this queue owns admission. Each resend must wait for the provider delay and pass the same request-slot, token and deadline checks. If a single job exceeds the entire TPM allowance, split it when the task permits or return it for replanning; waiting another minute cannot make it fit. If a valid server delay falls beyond the deadline, defer the work. Stop immediately for quota or billing errors that need action. A 3,000-token reservation could produce a response with 1,800 input and 240 output tokens. Keep the reservation in the pacing calculation and use response usage categories and the provider’s rates to price completed calls.</p>
      <p>If a local Claude Code session also takes a few tries to finish a task, <a href="/join">inspect the session’s recorded usage in Tokentracky</a> to compare its token total with a clean run. Diagnose the API queue from your own timestamps, headers, errors and response usage.</p>
    </>,
    sources: [
      { label: 'Verify OpenAI’s limit headers, admission calculation and retry guidance', url: 'https://developers.openai.com/api/docs/guides/rate-limits' },
    ],
  },
];
