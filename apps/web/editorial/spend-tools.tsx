import React from 'react';
import { guide } from '../src/footer-guides';

export const toolsSpendGuides = [
  {
    ...guide('limit-agent-tool-output'),
    description: 'Return a page of matching files with a total and a continuation offset, then open only the excerpts needed to answer the coding question.',
    body: <>
      <h2>Cap the search response and show what remains</h2>
      <p>To reduce AI agent tool output tokens, return a short list of matching paths first. Give the agent the total and the next offset so it can tell whether it has finished. A bare <code>head</code> caps the response but leaves the agent guessing whether the rest of the repository was searched.</p>
      <p>Suppose you want to find the editorial modules that use the shared guide helper in the Tokentracky repository. Run this from the repository root with Python 3 and ripgrep installed. It searches locally and sends at most five paths per invocation. The search uses ripgrep’s normal ignore rules.</p>
      <pre><code>{`python3 - 0 <<'PY'
import subprocess
import sys

start = int(sys.argv[1])
if start < 0:
    raise SystemExit("Offset must be nonnegative")
result = subprocess.run(
    ["rg", "--files-with-matches", "--sort", "path", "--null",
     "--glob", "*.tsx", "--fixed-strings", "...guide(", "apps/web/editorial"],
    stdout=subprocess.PIPE,
)
if result.returncode not in (0, 1):
    raise SystemExit(result.returncode)
paths = result.stdout.split(b"\\0")[:-1]
end = min(start + 5, len(paths))
for index, path in enumerate(paths[start:end], start + 1):
    print(index, repr(path.decode("utf-8", errors="backslashreplace")))
print(f"total_files={len(paths)}")
print(f"next_offset={end}" if end < len(paths) else "next_offset=none")
PY`}</code></pre>
      <p>Replace <code>0</code> on the first line with the printed offset to get the next page. With 12 matches, the offsets are 0, 5 and 10 and the last page contains two paths. The command reruns the search for each page, so keep the working tree fixed during enumeration or restart from offset 0 after edits. A search error exits without a continuation marker.</p>
      <h2>Stop when you have enough evidence for the question</h2>
      <p>If you only need one working example, take one path from the first page and inspect a bounded line range, for example <code>sed -n '40,80p' apps/web/editorial/spend-budget.tsx</code>. Line and path limits can still return oversized lines. For a hard response ceiling, cap bytes or use the target tokenizer, mark truncated output, and provide a continuation position. If you need a complete inventory, follow every offset to <code>none</code> and check that your collected file count equals <code>total_files</code>. This counts matching files. To audit every matching line, page through the matching lines within each file too.</p>
      <p>Try the same lookup in two fresh Claude Code sessions with the same model, one asking for the full search output and one using pages. Check that both answers meet the same completeness requirement. Compare cached plus uncached input in the private Tokens dashboard after setting up <a href="/join">Tokentracky for Claude Code</a>. The totals cover the coding sessions, so compare the same task and record the extra search turns the paginated version needed.</p>
    </>,
    sources: [
      { label: 'ripgrep guide to file filtering and ignore rules', url: 'https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md' },
    ],
  },
  {
    ...guide('reduce-tool-schema-overhead'),
    description: 'Send only the tools a task is likely to need, then count the discovery and fallback calls to see whether the smaller schema actually saves input.',
    body: <>
      <h2>Compare the schemas on the request you actually send</h2>
      <p>LLM tool schema token cost comes from the definitions the model receives, including names, descriptions and argument schemas. For a client that assembles its own requests, select the likely tools before sending the request. Keep the descriptions that distinguish similar tools and the argument constraints that prevent bad calls.</p>
      <p>Imagine an agent answering CI questions. The full registry includes tools for issue triage and releases as well as build inspection. Start with the two tools needed to look up a build and read a test result. Include a narrow discovery option or route on the client when the question needs a tool outside that set. For Claude client tools, count two requests with identical model, system prompt and messages: one with the full tool array and one with the focused array. Subtract their input counts. To measure the overhead of each array individually, also count the request with no tools as a common baseline. Check actual generation usage afterward. For OpenAI, function calling documentation distinguishes sending a smaller array from using <code>allowed_tools</code> to restrict which tools the model can call while keeping the full list in the request.</p>
      <h2>Charge the fallback to the smaller configuration</h2>
      <p>Suppose your paired counts put the first request’s tool overhead at 3,000 input tokens for the full set and 300 for the focused set, including discovery. Across ten tasks that is 30,000 versus 3,000. If two focused tasks need an extra request that costs 1,200 input tokens each, including replayed context and newly loaded definitions, the comparison becomes <strong>30,000 versus 5,400</strong> for these costs. These are illustrative counts. Ordinary requests common to both versions are excluded.</p>
      <p>Replay a small labeled set with routine and unusual questions. For an unavailable tool, allow one scoped lookup and retry with the discovered definition. If discovery gives no valid tool or a schema error repeats, return the missing capability or validation error. Count any extra model requests and generated tool calls. Compare task success, latency and cache usage before rolling out. A stable full array can make repeated input cheaper when it is cached, even when its raw count is higher.</p>
      <p>Keep API measurements in your own request logs. If you are testing the practical effect of disabling unused integrations in a local Codex workflow, <a href="/join">set up Tokentracky</a> and compare whole-task usage in its private dashboard. Use the API comparison above when you need to isolate schema overhead.</p>
    </>,
    sources: [
      { label: 'Claude token counting for structured requests', url: 'https://platform.claude.com/docs/en/build-with-claude/token-counting' },
      { label: 'OpenAI function calling and allowed tool selection', url: 'https://developers.openai.com/api/docs/guides/function-calling' },
    ],
  },
  {
    ...guide('budget-agent-retries'),
    description: 'Use one token and attempt budget for retries and corrective turns. Reserve for each send and keep timed-out requests on the ledger until their outcome is known.',
    body: <>
      <h2>Budget a new request before sending it</h2>
      <p>An AI agent retry token budget should cover both the input sent again and the output the model could generate. Set a request-attempt cap and deadline alongside it. Treat a transport retry and a completed response that fails a test as different decisions.</p>
      <table><caption>When a second attempt can help</caption><thead><tr><th scope="col">What happened</th><th scope="col">What to do</th></tr></thead><tbody>
        <tr><th scope="row">Transient rejection before a usable result</th><td>Retry only within the attempt and time limits. Honor a valid Retry-After header or use exponential backoff with jitter. Disable automatic SDK retries. Let the runner check the token reservation, attempt limit and deadline before every actual send.</td></tr>
        <tr><th scope="row">Timeout with uncertain outcome</th><td>Reserve for possible usage and check whether the operation already completed. Confirm state before repeating any side effect.</td></tr>
        <tr><th scope="row">Response completed but failed a check</th><td>Record its returned usage. Retry only after adding new evidence or changing the approach, such as supplying the specific failing assertion.</td></tr>
        <tr><th scope="row">Invalid credentials or request</th><td>Correct the cause before sending again.</td></tr>
      </tbody></table>
      <p>OpenAI documents that unsuccessful requests can count toward per-minute limits. That is a throttling rule. Use returned usage and provider records to reconcile what was processed and billed.</p>
      <h2>Work through a failed patch</h2>
      <p>Set a 16,000-token task ceiling, at most three model request attempts including transport retries, and a two-minute deadline. The first reply used 5,000 input and 1,000 output tokens, but its patch failed a regression test. Adding the failing assertion brings the second request to an estimated 7,000 input. With a maximum of 2,000 output tokens, reserve 9,000. The 6,000 already used plus 9,000 reserved fits the budget.</p>
      <p>If the second request completes with 7,000 input and 1,500 output, recorded use reaches 14,500 and only 1,500 remains. If the test still fails, stop because even replaying the second request’s input would exceed what remains. The attempt cap alone would allow one more request. If the second request times out and you cannot resolve its usage, keep the 9,000 reserved. Only 1,000 tokens remain unreserved; refuse a resend that needs another 9,000. Record the failing check and next hypothesis for the developer. Treat estimated input as a forecast and leave headroom for counting error.</p>
      <p>Test the policy with a transient failure, a timed-out request and a patch that keeps failing. Verify the actual number of sends and the ledger after each. If you retry work manually in Claude Code, use the private dashboard from <a href="/join">Tokentracky’s setup page</a> to review recorded coding usage afterwards. Keep the attempt counter and stopping decision in the runner or your own notes.</p>
    </>,
    sources: [
      { label: 'OpenAI rate limits and retry backoff', url: 'https://developers.openai.com/api/docs/guides/rate-limits' },
    ],
  },
  {
    ...guide('budget-parallel-ai-agents'),
    description: 'Price the repeated brief, each worker’s evidence, and the coordinating answer before deciding whether a faster parallel review is worth the extra tokens.',
    body: <>
      <h2>Count the workers and the coordinator</h2>
      <p>Parallel AI agent token cost includes a copy of the necessary brief for each worker, every worker’s local context, and the parent’s requests to delegate and combine results. Fan out only when the tasks can proceed independently and the time saved is worth the overhead. Claude Code’s subagent documentation describes separate context windows and separate requests that count toward the same usage limits.</p>
      <p>Consider three read-only checks before a CLI release. One checks the option parser, one checks shell completions, and one checks the help examples. Each worker gets the same acceptance criteria and just its assigned files. Ask each to return a path, the finding and the verification command, so the coordinator can check disagreements without replaying all three transcripts.</p>
      <table><caption>Illustrative token totals for the same review</caption><thead><tr><th scope="col">Work</th><th scope="col">Input</th><th scope="col">Output</th></tr></thead><tbody>
        <tr><th scope="row">Serial review, including final answer</th><td>9,000</td><td>1,200</td></tr>
        <tr><th scope="row">Three workers, each with 1,500 of shared brief and 2,000 of evidence</th><td>10,500</td><td>1,500</td></tr>
        <tr><th scope="row">Coordinator across delegation and synthesis, including workers’ replies as input</th><td>4,000</td><td>800</td></tr>
        <tr><th scope="row">Parallel total</th><td>14,500</td><td>2,300</td></tr>
      </tbody></table>
      <p>At illustrative rates of $2 per million input and $8 per million output, serial costs $0.0276 and parallel costs $0.0474. If you can spend at most two extra cents, the $0.0198 difference fits by only $0.0002, before any follow-up. To enforce the ceiling in a runner, start with $0.0476 total. Reserve $0.0144 for the coordinator (4,000 input and 800 output), then reserve $0.011 per worker (3,500 input and at most 500 output). Have the coordinator’s delegation and synthesis calls draw on the same $0.0144 allocation. Before each send, subtract settled spend and all outstanding reservations from the run ceiling. Count the new payload, enforce its output cap, and admit it only if the reservation fits both the caller’s remaining allocation and that run-wide balance. On completion, replace its reservation with actual spend. Keep unresolved calls reserved. If the input is estimated, allow for error before dispatch; $0.0002 spare may be too little. With a single extra verification turn likely, plan for serial or split off just the longest independent check. Actual multi-turn counts can include replayed context and may price cache hits differently.</p>
      <h2>Decide what speedup earns that premium</h2>
      <p>Set an elapsed-time target and require all three checks to cite evidence against the same acceptance criteria. If serial takes 100 seconds and parallel takes 65 end to end, the parallel run clears a 30-second savings target. Count from dispatch through verified synthesis, including queue time. If one worker depends on another’s result, sequence those checks. Once the coordinator has verified coverage, stop spawning workers. If there is a discrepancy, verify the specific file before commissioning a second pass.</p>
      <p>For a local Claude Code comparison, use <a href="/join">Tokentracky’s private usage setup</a> to look at recorded usage during isolated serial and parallel runs. Include all recorded worker rows for the isolated run, even if they have different session IDs from the parent. Keep a roster of those IDs, timings and assignments. If some workers are missing, mark the local comparison incomplete. For a per-worker estimate, use runner or provider telemetry where it exposes that breakdown.</p>
    </>,
    sources: [
      { label: 'Claude Code subagent context and usage', url: 'https://code.claude.com/docs/en/sub-agents' },
    ],
  },
  {
    ...guide('reduce-retrieval-token-spend'),
    description: 'Keep retrieval broad enough to find the exception, then merge overlapping passages and send only the evidence the answer needs.',
    body: <>
      <h2>Separate how many chunks you retrieve from how many you send</h2>
      <p>A RAG retrieval token budget limits the source text placed in the model request. Pull enough candidates to find the main rule and its exceptions, then remove repeated spans and pack whole pieces of evidence up to that budget. Top k controls the number of candidates returned. Chunk overlap affects both what can be found and how much text those candidates repeat.</p>
      <p>Suppose a help desk asks whether a cancelled annual plan receives a refund within 14 days. The three highest-ranked chunks are 300 tokens each. The first gives the general rule. The second overlaps the first by 100 tokens and adds filing instructions. The third gives the annual-plan exception and shares no text with the other two. Treat these counts as illustrative and use the same document version throughout.</p>
      <table><caption>Evidence included for the refund question</caption><thead><tr><th scope="col">Selection</th><th scope="col">Passage tokens</th><th scope="col">Annual exception</th></tr></thead><tbody>
        <tr><th scope="row">All three as returned</th><td>900</td><td>Present</td></tr>
        <tr><th scope="row">Cut to the top two</th><td>600</td><td>Missing</td></tr>
        <tr><th scope="row">Keep all three, merge the shared span once</th><td>800</td><td>Present</td></tr>
      </tbody></table>
      <p>Deduplicate by document ID, version and source offsets when your index provides them. Preserve citations to the merged span and to the exception. With a 650-token passage budget, reserve room for the highest-ranked passage matching the annual-plan condition, then add the general rule. Those two chunks total 600 tokens. If required evidence still cannot fit, retrieve narrower spans, increase the allowance within the request limit, or flag that the evidence is incomplete. If the user also asks how to file, you need the supporting instructions too. Count separators, citation labels and any other prompt text in the final request. OpenAI’s Retrieval guide documents separate controls for returned result count and indexing overlap.</p>
      <h2>Check retrieval coverage before judging answers</h2>
      <ol>
        <li>Label a small held-out set with the required source passages and expected answer facts. Include exceptions and questions whose answers cross a chunk boundary.</li>
        <li>At the same retrieval depth, compare the original and packed prompts. For each question, record whether every required passage survived packing. Then score whether the answer includes every required fact and cites the right source.</li>
        <li>Lower top k only after packing passes. If even one critical exception disappears from the candidates, restore the previous depth or improve ranking. Test changes to indexing overlap separately, since a new chunk boundary can change what gets retrieved.</li>
      </ol>
      <p>Measure the RAG requests with your application’s provider usage records. If you prototype and review the packing code in Codex, <a href="/join">install Tokentracky</a> to review that local coding work’s token usage separately from the evaluation requests.</p>
    </>,
    sources: [
      { label: 'OpenAI retrieval result counts and overlap controls', url: 'https://developers.openai.com/api/docs/guides/retrieval' },
    ],
  },
  {
    ...guide('image-input-token-cost'),
    description: 'Crop to the evidence that decides the question, then choose the lowest vision detail that preserves it. A worked GPT-4.1 example shows what each choice costs.',
    body: <>
      <h2>Send the screenshot when layout is part of the evidence</h2>
      <p>If you only need help interpreting an error string, paste the exact text. If you need to show that a toolbar covers the Save button at a narrow viewport, an image can show the relationship the text leaves out. Give the viewport width in text and crop around the toolbar, the button, and enough surrounding layout to show the overlap. Keep the labels readable at the size you send.</p>
      <h2>Calculate a full image and a crop at the same detail</h2>
      <p>For OpenAI API <code>gpt-4.1</code>, checked November 20, 2026, low detail uses 85 image input tokens. For high detail, fit the image inside 2,048 × 2,048 without enlarging it. If the shorter side still exceeds 768 pixels, scale it down to 768 pixels and round the other dimension down. Cover the result with 512-pixel tiles, then add 170 tokens per tile to the 85-token base.</p>
      <table><caption>One screenshot in three forms on GPT-4.1</caption><thead><tr><th scope="col">Image and detail</th><th scope="col">Image input tokens</th></tr></thead><tbody>
        <tr><th scope="row">1,600 × 1,000 full screenshot, high</th><td>1,228 × 768 after scaling, 3 × 2 tiles. 85 + 6 × 170 = 1,105.</td></tr>
        <tr><th scope="row">640 × 480 crop, high</th><td>2 × 1 tiles. 85 + 2 × 170 = 425.</td></tr>
        <tr><th scope="row">Same crop, low</th><td>85.</td></tr>
      </tbody></table>
      <p>Use the high-detail crop if the small button label matters. It saves 680 image tokens over the high-detail full screenshot in this example. To convert the 680 saved tokens into a dollar estimate, multiply 680 by the model’s applicable input price per million and divide by one million. Try low detail for a coarse alignment check. If low detail misses the label and you resend at high detail, the two image inputs alone add up to 510 tokens, plus the rest of both requests.</p>
      <h2>Verify that the cheaper view answers the question</h2>
      <p>Keep the same model and prompt. Ask which element covers the Save button and at what viewport width, then check the answer against the screenshot. If the answer gets both right, stop. If it cannot read the label at low detail, change to high. Widen the crop only when the missing edge or neighboring element matters. Check the provider’s image input calculator for other dimensions and use API response usage for the complete request, including text.</p>
      <p>When comparing screenshot-heavy and text-only workflows in local Codex sessions, <a href="/join">set up Tokentracky</a> to compare total recorded coding usage for equivalent tasks. Use the provider’s measurements to isolate the cost of API images.</p>
    </>,
    sources: [
      { label: 'OpenAI vision detail and image token accounting', url: 'https://developers.openai.com/api/docs/guides/images-vision' },
      { label: 'OpenAI image input calculator', url: 'https://developers.openai.com/api/docs/guides/image-cost-calculator' },
    ],
  },
];
