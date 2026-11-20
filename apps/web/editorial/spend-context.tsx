import React from 'react';
import { guide } from '../src/footer-guides';

export const contextSpendGuides = [
  {
    ...guide('reduce-repeated-chat-history'),
    description: 'A fresh chat can cut repeated input. Price the handoff, cache reads and follow-up turns to see whether restarting also cuts spend.',
    body: <>
      <h2>Reset when you can leave most of the history behind</h2>
      <p>You’ve fixed a flaky checkout test and now need to update its error message. The old thread contains several failed hypotheses and a full test trace. The follow-up needs the new behavior, the changed files and one test command. That makes a fresh thread worth testing: little of the old history is needed to finish. If you’re still comparing two traces that only exist in the chat, collect that evidence first.</p>
      <h2>Compare the next three turns</h2>
      <p>Suppose the next request carries 12,000 tokens of prior history, while a new thread would need a 2,000-token brief. In this illustrative calculation, each path adds 1,000 tokens between requests, the next prompt and fixed instructions are the same on both paths, and the client retains all history. The table counts only the differing or growing conversation context, before cache pricing.</p>
      <table>
        <thead><tr><th scope="col">Upcoming request</th><th scope="col">Keep the thread</th><th scope="col">Start fresh</th></tr></thead>
        <tbody>
          <tr><th scope="row">First</th><td>12,000</td><td>2,000</td></tr>
          <tr><th scope="row">Second</th><td>13,000</td><td>3,000</td></tr>
          <tr><th scope="row">Third</th><td>14,000</td><td>4,000</td></tr>
          <tr><th scope="row">Total</th><td>39,000</td><td>9,000</td></tr>
        </tbody>
      </table>
      <p>The reset avoids 30,000 input tokens under those assumptions. If writing the brief in the old chat would take another request, count that request and its output too. Suppose generating the brief uses 12,000 more input tokens and 2,000 more output. Across the three follow-ups, the net change is 18,000 fewer input tokens and 2,000 extra output. At illustrative uncached prices of $2 per million input and $8 per million output, that saves $0.036 − $0.016 = $0.020. One follow-up alone would lose money at those rates. Cache reads can make the old thread cheaper to reuse, and automatic compaction can reduce how much history actually returns. OpenAI’s Responses API documents that chaining with <code>previous_response_id</code> still bills prior input tokens. Use your client’s actual behavior and applicable rates for the cost decision.</p>
      <h2>Reset at a testable checkpoint</h2>
      <p>Save the working diff and make the brief name the expected behavior and the test that proves it. In Claude Code, <code>/clear</code> starts over, per the documentation checked November 20, 2026. Put the brief in the fresh chat and check that the first proposed change targets the right error path. If the assistant needs one missing detail, give it the exact line or test result. Reopen the original context if the change depends on a chain of findings you can’t reproduce from the brief.</p>
      <p>For a local Claude Code trial, <a href="/join">set up Tokentracky’s private dashboard</a> and export the two test runs from <strong>Tokens</strong>. Compare equivalent completed tasks, including any brief-writing and recovery turns you can identify by session and time. Sum <code>input</code>, <code>cache_read</code> and <code>cache_write</code> for each run’s input volume. For a same-model cost comparison, use the priced <code>cost_microusd</code> rows and flag any blanks. The CSV combines five-minute and one-hour cache writes; use their separate counts from the original usage records if applying custom rates.</p>
    </>,
    sources: [
      { label: 'Check how OpenAI accounts for tokens in chained responses', url: 'https://developers.openai.com/api/docs/guides/conversation-state' },
      { label: 'Read Claude Code’s guidance on clearing context between tasks', url: 'https://code.claude.com/docs/en/best-practices' },
    ],
  },
  {
    ...guide('token-efficient-session-handoff'),
    description: 'Carry a coding task into a fresh session with a short, verifiable handoff. Copy this example for a dirty worktree where CSV escaping passes and a trailing-field test still fails.',
    body: <>
      <h2>Hand over the current state and the next check</h2>
      <p>A good AI coding session handoff tells the next assistant what it can verify in the checkout and which constraint still governs the work. Lead with the behavior that must survive, then give the exact result that remains wrong. Here’s a handoff for an illustrative TypeScript repository using Vitest.</p>
      <pre><code>{String.raw`Goal
Finish the CSV export fix for rows with an empty optional note.

Invariant
Every record must have exactly as many fields as the header.
An empty final field must still have its preceding delimiter.

State
The current worktree has uncommitted changes in src/export/csv.ts
and test/csv.test.ts. Keep both. Start with git status --short
and git diff -- src/export/csv.ts test/csv.test.ts.

Checks already run
npx vitest run test/csv.test.ts
6 passed, 1 failed. Escaping a comma inside a note passed.
The empty-final-field test expected "id,name,note\n7,Ada,\n"
and got "id,name,note\n7,Ada\n" (escaped newlines shown).

Next action
Reproduce the failure. Inspect where the row fields are assembled
before changing the escaping code. Fix that case, rerun the same
test file and check that the comma-escaping test still passes.
Stop and report the observed state if the diff or failure differs.`}</code></pre>
      <p>That brief preserves the trailing comma, the detail an assistant could lose by summarizing the failure as “blank notes break CSV.” On a different checkout, it also gives the recipient an early way to detect that the working changes are missing. If you hand off to someone using a clean checkout, give them an accessible commit or patch in place of the dirty-worktree instructions.</p>
      <h2>Verify the first step before adding more context</h2>
      <p>Ask the new session to report the changed files and the failing assertion before editing. If it reproduces the expected failure, proceed. If it can’t, send the missing patch or current test output. Include a rejected approach only when it explains a live constraint, such as why trimming trailing delimiters would violate the CSV invariant.</p>
      <p>Resume the same unfinished task from matched checkout states. Use the original thread or full transcript in one run and the handoff in the other. Keep the acceptance checks fixed. To measure the two local Codex runs, <a href="/join">enable local Codex collection in Tokentracky</a> and use the <strong>Tokens</strong> CSV to sum <code>total</code> for the follow-up sessions. Record which sessions belong to which task yourself. Include any usage from generating the brief and any turns spent reconstructing missing work. Compare only runs that reached the same test result.</p>
    </>,
    sources: [
      { label: 'Check how Vitest runs a matching test file once', url: 'https://vitest.dev/guide/cli' },
      { label: 'Read Claude Code’s guidance on giving an agent a way to verify its work', url: 'https://code.claude.com/docs/en/best-practices' },
    ],
  },
  {
    ...guide('send-relevant-code-context'),
    description: 'Start with the failing test and the code that owns its behavior. Use one counterexample to decide whether the caller, parser or fixture belongs in the next read.',
    body: <>
      <h2>Start with the test that defines success</h2>
      <p>Suppose <code>GET /orders?limit=0</code> returns 200 when the endpoint contract requires 400. Give the assistant the failing assertion in <code>test/orders.list.test.ts</code> and the query-handling function in <code>src/http/orders.ts</code>. Include the adjacent passing assertions: an omitted limit uses 25, and a limit of 1 works. Those cases distinguish “reject zero” from “reject any falsy or missing value.”</p>
      <p>If you need to find those snippets, search the route and test directly with <code>rg -n 'limit|parsePageSize' src/http/orders.ts test/orders.list.test.ts</code>. Open enough surrounding lines to see setup, validation order and the response status. For this example, the filenames and symbols are illustrative. Substitute the ones from your checkout.</p>
      <h2>Follow the value that changes the diagnosis</h2>
      <p>The route calls <code>parsePageSize(rawLimit) ?? 25</code>. If the parser returns <code>undefined</code> for both zero and absent values, the route loses the distinction at that line. The next useful read is the parser body and its tests. Search for <code>parsePageSize</code> in source and tests to check whether other routes rely on that behavior before proposing a shared change.</p>
      <p>Now consider the failure a test excerpt can hide. If its fixture builds a query object from truthy values, it might drop numeric <code>0</code> before any request reaches the route. In that case, add the fixture’s query builder and test the literal HTTP query string <code>?limit=0</code>. A parser edit could leave the test exercising the omitted-limit path. If the fixture drops zero, fix or bypass it and rerun the literal request first. If the route receives zero and the parser loses it, inspect the parser contract and its other callers.</p>
      <h2>Stop opening files once you can explain the failing path</h2>
      <p>Ask for the value at the request boundary, what the parser returns and why the response status follows. Once you can answer all three, run the zero, omitted and valid cases. Reopen the search if the fix changes a shared parser or those checks expose another caller’s contract. In a read-capable assistant, give it the exact paths and checks so it can fetch the needed source itself.</p>
      <p>To compare this approach with a broad repository read in local Claude Code, <a href="/join">turn on local usage collection</a> and record the session IDs and tests passed. Compare the recorded totals from <strong>Tokens</strong> for successful trials on the same starting checkout. Use the client’s tool history to see which files were read.</p>
    </>,
    sources: [
      { label: 'See how ripgrep searches specific files and reports line numbers', url: 'https://ripgrep.dev/docs/guide/' },
      { label: 'See how file reads add to Claude Code context', url: 'https://code.claude.com/docs/en/context-window' },
    ],
  },
  {
    ...guide('trim-logs-for-ai-debugging'),
    description: 'Keep the earliest cause, a useful stack frame, versions and the failure count. This before-and-after example shows what to cut from a noisy retry log.',
    body: <>
      <h2>Find the cause before you cut the log</h2>
      <p>Copy the first failed attempt and its underlying cause. Keep the command, exit code, runtime versions and one frame in your code. Count repeats separately. In this illustrative run, the last line reports exhausted retries, while the first failure provides the clue to inspect.</p>
      <h3>Raw log from a local import</h3>
      <pre><code>{`$ node dist/import.js --fixture tiny.json
09:00:00 INFO node=v22.14.0 importer=2.4.1
09:00:00 DEBUG loading tiny.json
09:00:01 ERROR attempt=1 ImportError: could not read input
  at importFile (dist/import.js:42:11)
Caused by: ENOENT: no such file or directory, open './fixtures/tiny.json'
  at loadFixture (dist/input.js:18:9)
  at async importFile (dist/import.js:40:3)
09:00:01 DEBUG waiting before retry
09:00:02 ERROR attempt=2 same ENOENT ./fixtures/tiny.json
09:00:04 ERROR attempt=3 same ENOENT ./fixtures/tiny.json
09:00:04 ERROR retry limit exceeded
exit=1`}</code></pre>
      <h3>Excerpt to send with the debugging question</h3>
      <pre><code>{`node dist/import.js --fixture tiny.json | Node v22.14.0 | importer 2.4.1 | exit 1
09:00:01 first cause: ENOENT opening './fixtures/tiny.json'
  at loadFixture (dist/input.js:18:9)
  at async importFile (dist/import.js:40:3)
Same cause on 3 of 3 attempts. Final error: retry limit exceeded.
Check how the fixture path is resolved before changing the retry policy.`}</code></pre>
      <p>The excerpt is six lines instead of thirteen. Line count verifies the edit, while a tokenizer or recorded usage can measure token savings. Node supports chaining the underlying failure with <code>Error.cause</code>. Here the example assumes the logger renders that cause. When a logger only shows a wrapper, inspect the original exception or enable a local diagnostic that prints the cause before shortening the output.</p>
      <h2>Check that the shorter log still supports the next action</h2>
      <p>On the failing checkout, run <code>pwd</code> and <code>ls -l ./fixtures/tiny.json</code> in the same directory where the import ran. That distinguishes a missing path at the current working directory from a claim that the fixture is absent everywhere. Keep the raw log for a second pass. If the retries carry different error codes or paths, keep one example and a count for each. Redact secrets in the text you share and use consistent placeholders for IDs needed to match events.</p>
      <p>If you trial the excerpt and full log in fresh local Codex sessions, <a href="/join">set up Tokentracky for Codex</a> and compare recorded usage through the first correct diagnostic step using the <strong>Tokens</strong> export. Keep the log variants and the assistant’s diagnosis in your own trial notes.</p>
    </>,
    sources: [
      { label: 'Check Node.js error causes and the meaning of ENOENT', url: 'https://nodejs.org/api/errors.html' },
    ],
  },
  {
    ...guide('compact-repository-instructions'),
    description: 'Shorten the instructions loaded for ordinary tasks while keeping mandatory rules explicit. Use a root and database example, then test what the assistant actually follows.',
    body: <>
      <h2>Keep shared rules short and move detail to where it applies</h2>
      <p>Imagine a root <code>AGENTS.md</code> that opens with a sprint checklist, repeats the install steps from the README and includes a database backfill walkthrough. A button-label fix needs the package manager and test command. A migration needs the database constraints and the backfill procedure. Start by moving sprint history to the project’s work tracker and keeping one canonical runbook for the walkthrough.</p>
      <p>Here’s how the remaining guidance might look in a repository that uses Codex and starts database sessions under <code>db/</code>. The commands and paths are illustrative.</p>
      <table>
        <thead><tr><th scope="col">Location</th><th scope="col">Instructions</th></tr></thead>
        <tbody>
          <tr><th scope="row">Root <code>AGENTS.md</code></th><td>Use pnpm. For web changes, run <code>pnpm --filter web test</code>. Keep database migrations forward-only. Read <code>db/AGENTS.md</code> before editing migrations.</td></tr>
          <tr><th scope="row"><code>db/AGENTS.md</code></th><td>Before running a backfill, follow <code>docs/backfills.md</code> for staging validation and batching. Verify the affected row count before and after.</td></tr>
        </tbody>
      </table>
      <p>Keep the forward-only rule at the root because a root-started session may touch a migration later. In Codex, the documented discovery chain goes from the project root to the starting working directory, with one selected instruction file per directory and a combined <code>project_doc_max_bytes</code> limit of 32 KiB by default, checked November 20, 2026. The explicit pointer covers work that crosses into <code>db/</code> from the root. Check your own client’s loading behavior before relying on placement. A byte limit measures file size and gives no exact token count.</p>
      <h2>Test the short instructions on two different tasks</h2>
      <ol>
        <li>Start at the repository root and request a plan for a button-label fix. Check that the assistant names the web test command and has no reason to load the backfill runbook.</li>
        <li>Start a fresh session under <code>db/</code> and request a migration plan with a backfill. Check that the plan preserves the forward-only rule, reads the runbook and names the row-count check. Repeat the migration prompt from the root to exercise the explicit pointer.</li>
        <li>If the assistant misses a mandatory rule, restore it where the relevant sessions load it and repeat the probe before adopting the edit.</li>
      </ol>
      <p>For a usage check in Codex, <a href="/join">enable private local collection</a> and run the same one-response planning prompt before and after the edit in fresh sessions, with no tool calls. Keep the checkout, model and tools fixed apart from the instruction changes. In the <strong>Tokens</strong> export, compare <code>input + cache_read + cache_write</code> for the recorded probe. Repeat if the first event varies. Use the plan checks for compliance. The export has no separate counter for the instruction file.</p>
    </>,
    sources: [
      { label: 'Check Codex instruction discovery, merge order and byte limit', url: 'https://learn.chatgpt.com/docs/agent-configuration/agents-md' },
    ],
  },
  {
    ...guide('context-window-token-budget'),
    description: 'Add instructions, tool messages and output headroom before asking for a patch. A worked 32,000-token fit check shows when to shrink the task or split the work.',
    body: <>
      <h2>Reserve room for the patch and another tool result</h2>
      <p>When estimating a context window token budget, count what the model receives now, leave space for the next tool result and reserve the output you still need. Check the model’s separate maximum output too. Suppose you have a 32,000-token window and need a patch plus test notes. These are illustrative counts for one coding task.</p>
      <table>
        <thead><tr><th scope="col">What needs space</th><th scope="col">Tokens</th></tr></thead>
        <tbody>
          <tr><th scope="row">Instructions, conversation and current request</th><td>8,000</td></tr>
          <tr><th scope="row">Tool definitions and retained calls and results</th><td>13,000</td></tr>
          <tr><th scope="row">Allowance for framing and unseen client instructions</th><td>2,000</td></tr>
          <tr><th scope="row">Next retained tool call, thinking blocks if required, and result</th><td>6,000</td></tr>
          <tr><th scope="row">Output reservation, including reasoning if applicable</th><td>5,000</td></tr>
        </tbody>
      </table>
      <p>The current estimate is 23,000. After reserving 5,000 for output, the whole intervening exchange can use at most 4,000 tokens. Suppose the assistant’s tool call, any retained thinking, and the full test result together use 6,000. That takes the plan to 34,000, exceeding the window by 2,000. Narrow the test output until those same blocks together use 2,000. The revised plan uses 30,000 and leaves 2,000 free. If you measure the full message payload with a provider’s count endpoint, avoid adding framing it already counted. Keep a margin for client context you can’t see.</p>
      <h2>Recheck after the tool call</h2>
      <p>A tool response arrives in a later request along with its call and the retained context. On Claude, count the actual next request with its tool-use and tool-result blocks and any thinking blocks the model requires you to return. Check that input before generating the patch. If you also need a 3,000-token schema dump, it now exceeds the remaining 2,000. Query just the table definition you need. If the full schema and trace are both required, stop and save the verified diagnosis and exact test command. Open a fresh session for the patch and recalculate with those findings in place of the older search history.</p>
      <p>For an API you control, use its input count for the actual request shape, including tool definitions and messages. Anthropic’s token counting endpoint accepts those fields. In a coding client use its context indicator when available. Claude Code’s <code>/context</code> shows the session’s current usage by category, per the documentation checked November 20, 2026.</p>
      <p>The window is capacity for a request and its generation. Usage across a sequence of requests can exceed that capacity because retained material can be processed on multiple turns. To compare the cumulative local Claude Code usage of the split and single-session approaches, <a href="/join">set up Tokentracky’s local dashboard</a> and sum <code>total</code> in the <strong>Tokens</strong> export across the sessions used to finish each task. Use <code>/context</code> for the live fit check and the provider’s rates and usage records for billed cost.</p>
    </>,
    sources: [
      { label: 'Check how Claude counts tool results and generation against the window', url: 'https://platform.claude.com/docs/en/build-with-claude/context-windows' },
      { label: 'Check the Claude API token-count request and its accuracy', url: 'https://platform.claude.com/docs/en/build-with-claude/token-counting' },
      { label: 'Check the live context breakdown in Claude Code', url: 'https://code.claude.com/docs/en/context-window' },
    ],
  },
];
