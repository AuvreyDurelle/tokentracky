import React from 'react';
import { guide } from '../src/footer-guides';

const reasoning = 'https://developers.openai.com/api/docs/guides/reasoning';

export const outputsSpendGuides = [
  {
    ...guide('cap-output-tokens'),
    description: 'Set the cap from answers that already pass your checks. A 240-token cutoff can cost more than a complete 310-token answer once you pay for a retry.',
    body: <>
      <h2>Measure complete answers before setting the limit</h2>
      <p>Tell the model what counts as complete, then measure actual output with a generous cap. For a CI failure triage request, require exactly three fields: the failing test, the likely cause and the next verification command. A shorter response can still be useful if all three fields are present, the test is in the supplied log, and the command targets that test.</p>
      <p>Suppose ten successful trial responses use 180 to 310 output tokens at a 700-token cap. On a reasoning model, keep effort fixed and use the response’s total <code>usage.output_tokens</code>. Count a trial toward the 310 maximum only if it completed and passed the content check. Try 380 next, leaving 70 above the largest observed result. Include long test names and multi-line error messages in a fresh set of trials. Record actual output, completion status and whether each response passes the content check. The cap limits generation. The cost calculation uses tokens actually consumed at the applicable rate.</p>
      <h2>Price the cutoff and the retry together</h2>
      <table><caption>Illustrative usage for one triage request, with no caching</caption><thead><tr><th scope="col">Outcome</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th></tr></thead><tbody>
        <tr><th scope="row">Complete on the first call</th><td>1,500</td><td>310</td></tr>
        <tr><th scope="row">Cut off before the command</th><td>1,500</td><td>240</td></tr>
        <tr><th scope="row">Fresh retry with the higher cap</th><td>1,500</td><td>310</td></tr>
      </tbody></table>
      <p>At illustrative rates of $2 per million input and $8 per million output, the first-pass answer costs $0.00548. The cutoff plus a complete retry costs $0.01040. A short answer that passes all three checks needs no retry. On a confirmed cutoff, retry once with the tested higher cap or split the task into smaller independent outputs. If that attempt also fails, surface the failure for review.</p>
      <h2>Check what the cap includes</h2>
      <p>In the OpenAI Responses API, checked November 20, 2026, <code>max_output_tokens</code> includes both visible output and reasoning tokens. A response can be <code>incomplete</code> with <code>incomplete_details.reason</code> set to <code>max_output_tokens</code> before any visible text appears. Inspect that metadata and validate the fields before accepting the result. Recalibrate when you change the model or its reasoning effort.</p>
      <p>If you test shorter triage instructions in local Codex sessions, <a href="/join">set up Tokentracky</a> and export the Codex rows from the private <strong>Tokens</strong> view. Compare recorded <code>output</code> across your trial sessions. Keep the status and acceptance results in your trial notes or API logs.</p>
    </>,
    sources: [
      { label: 'OpenAI Responses API output limit and response fields', url: 'https://developers.openai.com/api/reference/resources/responses/methods/create' },
      { label: 'OpenAI guide to reasoning tokens and incomplete responses', url: reasoning },
    ],
  },
  {
    ...guide('ask-for-diffs-to-save-tokens'),
    description: 'Request a unified diff for a small edit, check it against your working tree, and compare the cost of a patch retry with a short full-file replacement.',
    body: <>
      <h2>Ask for enough context to apply the patch</h2>
      <p>A unified diff is a good fit when the change touches a few lines of a file you already have. Give the model the current file path and exact surrounding lines. For a module whose retry limit should change from three to two, paste the current snippet and use a request like this.</p>
      <pre><code>{'In retries.mjs, change the exported retry limit from 3 to 2.\nReturn only a unified diff that git apply can read using a/ and b/ paths.\nKeep unchanged context lines and preserve the other export.\nIf the supplied lines are insufficient, ask for the missing context.'}</code></pre>
      <p>For a <code>retries.mjs</code> containing these two exports on its first two lines, the complete patch looks like this. The hunk’s second line of code has a leading space because it is unchanged.</p>
      <pre><code>{'diff --git a/retries.mjs b/retries.mjs\n--- a/retries.mjs\n+++ b/retries.mjs\n@@ -1,2 +1,2 @@\n-export const maxRetries = 3;\n+export const maxRetries = 2;\n export const backoffMs = 250;\n'}</code></pre>
      <h2>Check the patch against the current file</h2>
      <p>Save the patch text as <code>edit.patch</code> without Markdown fences. Use a clean trial checkout so the final diff isolates this change. Read the patch to confirm the path and edit, then run these commands from the repository root.</p>
      <pre><code>{'git apply --check edit.patch && git apply edit.patch &&\ngit diff --check -- retries.mjs && git diff -- retries.mjs &&\nnode --input-type=module -e "import {maxRetries, backoffMs} from \'./retries.mjs\'; if (maxRetries !== 2 || backoffMs !== 250) process.exit(1)"'}</code></pre>
      <p>Check that the diff changes only <code>maxRetries</code>. If the dry run fails because the file moved or was edited, refresh the context and try once. For a one-line change you can verify directly, make it by hand if the second patch fails.</p>
      <h2>Choose a whole file when the patch overhead wins</h2>
      <p>In this two-line module, replacing the whole file is simpler: the patch contains both versions of the changed line plus headers and context. In a larger file, suppose a full answer would be 1,200 output tokens and a valid patch takes 140. Even one rejected 140-token patch followed by a 140-token correction uses 280 output tokens, 920 fewer than the whole-file answer. Those counts are illustrative. Include the extra input and review time if you retry. A new file or a rewrite touching most lines is a better candidate for full output.</p>
      <p>To compare the two prompts in Claude Code, use fresh sessions from the same starting file. In each, request only the assigned artifact and ask the assistant to leave the file untouched. Apply each answer yourself and run the same behavior check. Record which session used which prompt. After <a href="/join">setting up local collection</a>, export Claude Code usage from <strong>Tokens</strong> and sum <code>output</code> by session, including any correction turns. Use the diff and test result to decide which runs succeeded.</p>
    </>,
    sources: [
      { label: 'Git documentation for checking and applying patches', url: 'https://git-scm.com/docs/git-apply/2.51.0' },
    ],
  },
  {
    ...guide('shorten-structured-ai-output'),
    description: 'Stop repeating field names in large batches of flat JSON. Put them in one header, validate every row, and measure whether the smaller response pays for the decoder.',
    body: <>
      <h2>Keep the fields and write their names once</h2>
      <p>Suppose a model classifies a supplied list of CI jobs. For each job you need its ID, whether it should be retried and the reason. Keep those three facts and switch from an array of objects to a versioned table only if you control the reader. For two jobs, the current response might be:</p>
      <pre><code>{'[{"job_id":"ci-17","retryable":true,"reason":"runner_lost"},\n {"job_id":"ci-18","retryable":false,"reason":"test_failed"}]'}</code></pre>
      <p>This compact JSON is validated by your application. It names the columns once. If you require schema-constrained generation, check whether your provider accepts heterogeneous positional rows in its supported JSON Schema subset. Use compact named objects when it cannot express your row contract. Ask for one row per supplied ID and give the allowed reason codes and their retry rules in the instructions.</p>
      <pre><code>{'{"v":1,"columns":["job_id","retryable","reason"],\n "rows":[["ci-17",true,"runner_lost"],["ci-18",false,"test_failed"]]}'}</code></pre>
      <h2>Decode, validate and compare with the old format</h2>
      <ol>
        <li>Parse the response as JSON. Require version 1 and the exact column list in that order. Require an array of rows, each with exactly three elements.</li>
        <li>Require a known string ID, a JSON boolean and a reason from the allowed set. For this contract, <code>runner_lost</code> pairs with <code>true</code> and <code>test_failed</code> with <code>false</code>. Reject duplicate IDs and compare the set of returned IDs with the requested set.</li>
        <li>Map the positions back to the named fields before handing them to existing code. In fixtures, compare the decoded objects with expected results. Try a missing row, a swapped boolean and reason, and a repeated ID. All three should fail validation.</li>
      </ol>
      <p>Measure both formats on the same list against minified objects carrying the same fields. Suppose a 100-job batch takes 2,500 output tokens as objects and 1,600 as rows, while explaining the compact schema adds 120 input tokens. At illustrative rates of $2 per million input and $8 per million output, the net saving is $0.0072 − $0.00024 = <strong>$0.00696 per batch</strong>, assuming both pass on the first attempt. The header and validation can cost more than they save on short or irregular records. Keep the object format if the compact version breaks a consumer or retry costs erase the saving.</p>
      <p>Use the response usage field for an API comparison. For a local Codex trial that returns these records as its answer, <a href="/join">install Tokentracky</a> and compare recorded output across the trial sessions. Run your decoder against the actual answers to verify that the tokens you saved carried no required fields.</p>
    </>,
    sources: [
      { label: 'Python standard library JSON decoding and type conversion', url: 'https://docs.python.org/3/library/json.html' },
    ],
  },
  {
    ...guide('set-reasoning-effort'),
    description: 'Start with lower effort for bounded edits and compare higher effort on tasks with competing explanations. Keep the setting that passes your tests at an acceptable cost.',
    body: <>
      <h2>Choose effort by the decisions the model must make</h2>
      <p>For a task with a known file, an explicit rule and a direct test, start at a low effort setting the model supports. Changing an error message and updating its assertion fits that pattern. A bug with two plausible causes, contradictory traces or a rule that crosses modules deserves a separate comparison at higher effort. Clarify any missing requirement before increasing effort.</p>
      <h2>Run the same task twice with an acceptance test</h2>
      <p>For example, a date filter must treat both endpoints as inclusive in UTC. Give each attempt the same fixture and starting revision. Require tests for events exactly at the start and end, a timestamp whose offset crosses a UTC date boundary, and events just outside the interval. For a range starting at midnight UTC on November 20, an event at November 19, 19:30 at UTC−05:00 belongs inside: it is November 20, 00:30 UTC. Hold the model, tool permissions and prompt fixed. Change only the effort setting and run the same acceptance tests.</p>
      <table><caption>Illustrative test outcomes and total output counts</caption><thead><tr><th scope="col">Effort</th><th scope="col">Output tokens</th><th scope="col">Acceptance result</th></tr></thead><tbody>
        <tr><th scope="row">Low</th><td>700, including 400 reasoning</td><td>Fails the offset case</td></tr>
        <tr><th scope="row">High</th><td>1,600, including 1,250 reasoning</td><td>Passes all cases</td></tr>
      </tbody></table>
      <p>With 4,000 uncached input tokens per attempt and illustrative rates of $2 per million input and $8 per million output, the low attempt costs $0.01360 and the high attempt $0.02080. Low followed by high costs $0.03440. Starting high would be cheaper for this task if the result repeats. For a straightforward edit that passes at low, paying the difference buys no additional pass in this test. Repeat on a small set of each task type before changing defaults. If both settings fail the same requirement, investigate the fixture or the spec before rerunning.</p>
      <h2>Read the reported reasoning count correctly</h2>
      <p>In the OpenAI Responses API, checked November 20, 2026, eligible models use <code>reasoning.effort</code> and report reasoning tokens under <code>usage.output_tokens_details.reasoning_tokens</code>. Those tokens are already part of <code>usage.output_tokens</code> and are billed as output. Check the chosen model for supported effort values. For a model with both levels, send <code>{'reasoning: { effort: "low" }'}</code> and change only <code>low</code> to <code>high</code> in the second request. Use the same generous cap for both trial runs and check for incomplete responses before interpreting a failure.</p>
      <p>For the equivalent experiment in local Codex sessions, <a href="/join">set up Tokentracky’s private dashboard</a> and export <strong>Tokens</strong> for Codex. Record the setting and test result alongside each session ID. Compare the <code>output</code> and <code>reasoning</code> columns, using reasoning as a subset of output.</p>
    </>,
    sources: [
      { label: 'OpenAI reasoning effort, supported usage details and billing treatment', url: reasoning },
    ],
  },
  {
    ...guide('route-tasks-between-models'),
    description: 'Send bounded edits to a cheaper model when a reliable check can catch failures. Compare the savings after escalations and count rejected changes in both routes.',
    body: <>
      <h2>Route by what you can verify</h2>
      <p>Use a cheaper first attempt for bounded edits with an explicit quality gate. For example, an allowed change to a CSV formatter must stay inside the formatter and its tests, pass the suite and preserve the documented escaping of quotes, commas and embedded newlines. Escalate if the patch fails the gate. Send changes that require interpreting an unclear data contract to the stronger model upfront, with the same tests and a manual review of the contract.</p>
      <h2>Include the failed first attempt in the price</h2>
      <p>Suppose you replay 100 bounded edits. Each cheap attempt costs $0.02 and each stronger attempt costs $0.08, including the input and output for that attempt. These are illustrative costs. The cheap model clears the gate on 75 tasks, so 25 get one stronger attempt. The stronger model completes 23 of those 25. In a separate baseline it completes 98 of all 100.</p>
      <table><caption>Illustrative cost with one allowed escalation</caption><thead><tr><th scope="col">Route</th><th scope="col">Total spend</th><th scope="col">Accepted changes</th></tr></thead><tbody>
        <tr><th scope="row">Cheap first, then escalate</th><td>100 × $0.02 + 25 × $0.08 = $4.00</td><td>98</td></tr>
        <tr><th scope="row">Stronger model upfront</th><td>100 × $0.08 = $8.00</td><td>98</td></tr>
      </tbody></table>
      <p>Cost per accepted change is about $0.041 versus $0.082. Both routes spent money on the two unresolved tasks. At these prices total spend ties at 75 escalations per 100 cheap first attempts, since $2 + 75 × $0.08 = $8. Cost per accepted change also depends on how many changes pass in each route. If an escalation sends the failed patch and test log, use the measured cost of that longer request to recompute the threshold.</p>
      <h2>Set a quality threshold before using the cheaper route</h2>
      <p>For this pilot, require at least the baseline’s 98 accepted changes and no incorrect CSV escaping in an independent review of accepted patches. Use held-out inputs for review so passing the visible fixtures alone cannot carry the pilot. If a variant misses that threshold, revise the gate or send that class directly to the stronger model. After one failed escalation, hand the task to a human with the failing fixture.</p>
      <p>If you try manual routing in a supported local client such as Codex, start a fresh session per attempt and record the task, configured model, session and acceptance result. <a href="/join">Set up local tracking</a>, then group the <strong>Tokens</strong> CSV by <code>model</code> and <code>session</code> to compare recorded usage with that ledger. Resolve unknown or conflicting model labels against the client record before assigning spend. Include the first and escalated attempts in the task total.</p>
    </>,
    sources: [
      { label: 'OpenAI evaluation guidance for defining and testing success criteria', url: 'https://developers.openai.com/api/docs/guides/evaluation-best-practices' },
    ],
  },
  {
    ...guide('compare-model-tokenizers'),
    description: 'The same Thai code comment takes 15 tokens in one OpenAI encoding and four in another. Reproduce the counts and estimate usage from text your models actually see.',
    body: <>
      <h2>Encode the same exact text for each model</h2>
      <p>A tokenizer maps text into units drawn from its vocabulary. A word, part of a word, or a space combined with nearby characters can form a token. Models using different encodings can split the same characters differently. OpenAI’s cookbook maps GPT-4 and GPT-4 Turbo to <code>cl100k_base</code> and GPT-4o and GPT-4o mini to <code>o200k_base</code>. Here are exact raw-text counts checked with <code>tiktoken</code> 0.12.0 on November 20, 2026. The snippets include the displayed spaces and no trailing newline.</p>
      <table><caption>Token counts for identical text across two OpenAI encodings</caption><thead><tr><th scope="col">Snippet</th><th scope="col">cl100k_base</th><th scope="col">o200k_base</th></tr></thead><tbody>
        <tr><th scope="row"><code>return total + tax</code></th><td>4</td><td>4</td></tr>
        <tr><th scope="row"><code>// 合計を返す</code></th><td>8</td><td>6</td></tr>
        <tr><th scope="row"><code>// รวมยอดทั้งหมด</code></th><td>15</td><td>4</td></tr>
      </tbody></table>
      <h2>Reproduce the counts locally</h2>
      <p>In a Python environment where you can install packages, run the following. On first use, <code>tiktoken</code> downloads the encoding files. The script sends no model requests.</p>
      <pre><code>{'python -m pip install tiktoken==0.12.0\npython - <<\'PY\'\nimport tiktoken\n\nencodings = [tiktoken.get_encoding(name)\n             for name in ("cl100k_base", "o200k_base")]\nfor snippet in ("return total + tax", "// 合計を返す", "// รวมยอดทั้งหมด"):\n    print(snippet, [len(encoding.encode(snippet)) for encoding in encodings])\nPY'}</code></pre>
      <h2>Estimate with the scripts and code your workload contains</h2>
      <p>Across 10,000 independent copies of the Thai snippet, raw text contributes 150,000 or 40,000 tokens, a difference of 110,000 before message formatting. At an identical illustrative $2 per million input tokens, that difference would be $0.22. Use each model’s own rate in a real comparison. Count actual snippets from the languages and regions you support, including identifiers, indentation and punctuation. A single comment is too small a sample to infer tokens per word across Japanese or Thai text, and counting concatenated text can change token boundaries.</p>
      <p>Use these counts for the visible strings, then check a representative full request using the provider’s reported input usage. Chat framing and attached tool definitions can add tokens. If you <a href="/join">track local Codex usage in Tokentracky</a>, match the sessions and model in the private <strong>Tokens</strong> export, then sum <code>input + cache_read + cache_write</code> for full-request input on the same multilingual coding fixture. Use the script above to isolate the contribution of the raw text.</p>
    </>,
    sources: [
      { label: 'OpenAI cookbook for model encoding names and message counting', url: 'https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken' },
      { label: 'OpenAI tiktoken installation and encoding API', url: 'https://github.com/openai/tiktoken' },
    ],
  },
];
