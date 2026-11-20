import React from 'react';
import { guide } from '../src/footer-guides';

const pricing = 'https://platform.claude.com/docs/en/about-claude/pricing';
const reports = 'https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api';

export const budgetSpendGuides = [
  {
    ...guide('monthly-ai-token-budget'),
    description: 'Turn a $100 monthly AI coding budget into a weekly token allowance. Keep $20 in reserve and recalculate your pace after a week that runs over.',
    body: <>
      <h2>Set aside a reserve before dividing the budget</h2>
      <p>Start with the dollars you can spend on metered coding usage, subtract a reserve, and divide the rest by your planned coding days. For a $100 budget with $20 held back and 20 coding days, that leaves $4 a day, or $20 for each five-day week. In a week with three planned coding days, the same pace allows $12.</p>
      <p>Translate the allowance into a token envelope using a measured workload mix. Suppose every one million uncached input tokens comes with 250,000 output tokens. At illustrative rates of $2 per million input and $8 per million output, that bundle costs $2 + $2 = $4. The five-day allowance buys five million input and 1.25 million output tokens at that mix. If output per million input doubles, each bundle costs $6, and the same $20 buys only about 3.33 million input tokens and 1.67 million output tokens. Price cache reads and writes separately where applicable.</p>
      <h2>Reset your weekly allowance with the days you have left</h2>
      <p>Say the first five days cost $27. You’ve used 33.75% of the $80 operating budget in 25% of the planned days. With 15 days left, you can spend $53 ÷ 15, or about $3.53 per day, without touching the reserve. Use the unrounded figure for your spreadsheet. If you kept spending $27 each week, the month would reach $108.</p>
      <p>At your weekly check, add the cost of work already done and subtract it from the operating budget. Compare the resulting allowance with the work still on the calendar. If the next task would take you over, defer it, time-box the agent, or try a cheaper model on a small piece with the same acceptance test. Release the reserve for a specific task with an expected cost. At the $100 ceiling, stop discretionary metered runs until the next month or until you explicitly raise the budget.</p>
      <p>Use the provider’s cost report for the budgeted account or workspace. Before releasing the reserve, check how far the report has caught up. Anthropic’s <code>data_refreshed_at</code> marks the point after which charges may still be missing or partial. To see whether changes in Claude Code explain the result, <a href="/join">set up Tokentracky’s private dashboard</a> and export your Claude Code records from <strong>Tokens</strong>. Review input, output and cache counts over the same dates. The dashboard’s dollar figures are estimates, and your weekly spending rule is manual.</p>
    </>,
    sources: [
      { label: 'Anthropic’s API pricing by token category', url: pricing },
      { label: 'Anthropic’s usage and cost reporting', url: reports },
    ],
  },
  {
    ...guide('forecast-ai-token-spend'),
    description: 'Forecast next month’s AI coding spend from ordinary days and heavy runs. Use your working calendar to turn a recent average into a low, base and high case.',
    body: <>
      <h2>Forecast the days you expect to work</h2>
      <p>Use recent daily costs for the same workload and billing scope, then count the working days on next month’s calendar. Suppose the last 20 working days included 16 routine days costing $48 in total and four migration days costing $32. That gives you $3 per routine day and $8 per heavy day. Keep any planned workdays with zero usage in the sample. A gap where you lack records needs checking before you treat it as zero.</p>
      <p>Next month has 21 working days after holidays. All 21 at the routine rate would cost $63. Each day you swap for migration work adds $5. With three days set aside for the migration, the base forecast is $78.</p>
      <table><caption>Illustrative scenarios for a 21-day month</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Heavy days</th><th scope="col">Forecast</th></tr></thead><tbody>
        <tr><th scope="row">Migration goes quickly</th><td>1</td><td>$68</td></tr>
        <tr><th scope="row">Current schedule</th><td>3</td><td>$78</td></tr>
        <tr><th scope="row">Migration needs another pass</th><td>6</td><td>$93</td></tr>
      </tbody></table>
      <p>The $68–$93 range depends on the schedule and holds the models, rates and cache mix steady. Repricing last month’s tokens at another model’s rates isolates the effect of price alone. To forecast a model switch, run one representative routine task and one heavy task on the target model. Use their observed input, output, cache usage and retries to update the daily figures. Keep any recurring fee on its own line.</p>
      <h2>Check the forecast after the first heavy run</h2>
      <p>After five days, suppose four routine days and one heavy run cost $23 altogether. You have 16 days left, of which two are heavy. Replace the first five forecast days with actuals. The updated estimate is $23 + 14 × $3 + 2 × $8 = $81. If it exceeds the amount available, reschedule some of the remaining heavy work or price a smaller batch before running it.</p>
      <p>For supported local usage, <a href="/join">install Tokentracky and open the private Tokens view</a>. Choose a UTC date preset wide enough to include both boundaries of your planning period. Convert exported timestamps to your planning time zone, filter to the dates you need, then group into days and compare with the work calendar. Treat a blank cost cell as unknown. For a forecast of an entire API account, get the daily amounts from the provider’s cost report. Check that its refresh timestamp covers the last day before treating the period as complete. Use the local coding-tool records to explain your share.</p>
    </>,
    sources: [
      { label: 'Anthropic’s daily cost report and filters', url: reports },
      { label: 'Anthropic’s API rates and pricing tiers', url: pricing },
    ],
  },
  {
    ...guide('api-cost-per-completed-task'),
    description: 'Add up retries and abandoned attempts, then divide by coding changes you actually accept. See how the cheaper first attempt can cost more per completion.',
    body: <>
      <h2>Define an accepted change before starting the trial</h2>
      <p>Divide the spend on all attempts by the number of accepted changes. For a trial on small bug fixes, define completion as a reviewed patch that passes the same required checks for both workflows. Assign comparable tickets to each workflow before starting. Record a ticket ID, all associated runs, and whether the change met your acceptance rule by a fixed cutoff. If you’re testing cost for comparable work, keep repo setup, task size and review expectations as similar as possible.</p>
      <h2>Divide the full cohort cost by the number accepted</h2>
      <table><caption>Illustrative trial with ten tickets assigned to each workflow</caption><thead><tr><th scope="col">Workflow</th><th scope="col">All attempt costs</th><th scope="col">Accepted changes</th></tr></thead><tbody>
        <tr><th scope="row">Cheaper model first</th><td>$5 first passes + $7 retries = $12</td><td>6</td></tr>
        <tr><th scope="row">Stronger model first</th><td>$9 first passes + $3 retries = $12</td><td>8</td></tr>
      </tbody></table>
      <p>The first workflow costs $12 ÷ 6 = <strong>$2 per accepted change</strong>. The second costs $12 ÷ 8 = <strong>$1.50 per accepted change</strong>. Both numerators include spend on abandoned tickets and any handoffs between models. If no tickets are accepted, report the spend and zero completions without a per-completion figure. Show the acceptance rate alongside the cost so readers can see the difference between 6 of 10 and 8 of 10.</p>
      <h2>Give each attempt a place in your ledger</h2>
      <p>Run each ticket in its own coding session where possible, and record its session ID next to the ticket. <a href="/join">Set up local usage collection</a> for your coding tool. In a Claude Code trial, export the relevant rows from <strong>Tokens</strong>, group them by <code>session</code>, and join them to the ticket ledger you maintain. Include follow-up sessions for the same ticket and check that no session appears on two tickets. Divide <code>cost_microusd</code> by one million for estimated dollars. Resolve unassigned or unpriced rows before comparing cohorts.</p>
      <p>For actual metered spend, isolate the trial in billing workspaces where feasible and check the sum against the provider’s cost report. Decide when to stop upfront. For example, after two retries or $2 in metered usage on a ticket, pause and record its status before deciding whether to finish it manually. Keep review time in a separate column if developer time could change the decision.</p>
    </>,
    sources: [
      { label: 'Anthropic’s API cost reporting by workspace', url: reports },
    ],
  },
  {
    ...guide('investigate-ai-spend-spike'),
    description: 'Explain an AI token spend spike by pricing yesterday’s volume, today’s mix and any rate change in sequence. Then trace the largest part to a tool or session.',
    body: <>
      <h2>Verify the spike on two complete days</h2>
      <p>If spend is still rising, pause the suspected metered run first. Then compare two complete days with the same billing scope, time zone and data freshness. Identify whether the number rose in a provider’s cost report or only in a local estimate. In Claude Console, narrow the cost report by workspace and, where available, API key. Group by model and <code>cost_type</code> to separate token spend from charges such as web search. Then split token usage into fresh input, cached input and output. Look for a shift toward costlier categories even if total tokens barely moved.</p>
      <h2>Change one assumption at a time</h2>
      <p>In this illustrative example, yesterday had four million fresh input tokens and one million output tokens. At $2 and $8 per million respectively, the total was $16. Today had five million fresh input and 2.5 million output, and the applicable output rate rose to $10 per million. The new total is $35.</p>
      <table><caption>Attributing the $19 increase</caption><thead><tr><th scope="col">Step</th><th scope="col">Result</th><th scope="col">Change</th></tr></thead><tbody>
        <tr><th scope="row">Volume only: multiply yesterday’s $16 by 7.5M ÷ 5M</th><td>$24</td><td>+$8</td></tr>
        <tr><th scope="row">Today’s mix, yesterday’s rates: 5 × $2 + 2.5 × $8</th><td>$30</td><td>+$6</td></tr>
        <tr><th scope="row">Today’s usage and rates: 5 × $2 + 2.5 × $10</th><td>$35</td><td>+$5</td></tr>
      </tbody></table>
      <p>Volume, mix and rates explain $8 + $6 + $5 = $19 in that order. Interactions are assigned to the later step, so keep the order fixed when repeating this method. With several models or cache tiers, price each model and category separately. If today introduced a model with no comparable old rate, identify that line separately before attributing the rest.</p>
      <h2>Find the run you can verify</h2>
      <p>To investigate supported local coding activity, <a href="/join">open Tokentracky’s private dashboard after setup</a>, export a <strong>Tokens</strong> range covering both dates, and group the CSV by day, tool and model. Filter the biggest change down to its sessions. If one session drove the extra output, use the tool’s own history to check what it was doing, then see whether a comparable smaller run stays within your expected range.</p>
      <p>Check that the cost report’s refresh timestamp covers both days and your follow-up interval before restarting a paused run. Close the investigation when the quantified causes account for the increase within a stated tolerance, such as $1 on this example, and the follow-up interval returns to the expected range. Keep any remaining difference open for billing follow-up.</p>
    </>,
    sources: [
      { label: 'Anthropic’s usage categories, cost buckets and reporting filters', url: reports },
      { label: 'Anthropic’s model and token-category pricing', url: pricing },
    ],
  },
  {
    ...guide('reconcile-ai-usage-with-invoice'),
    description: 'Bridge a local token-cost estimate to an API invoice line by line. Match the billing period and scope, apply credits and tax, and quantify what remains unexplained.',
    body: <>
      <h2>Start with the invoice’s metered usage line</h2>
      <p>Write down the invoice’s organization, currency and usage period, including the billing time zone. For an October UTC period, filter records from October 1 at 00:00 up to, but excluding, November 1 at 00:00. Fetch the provider usage and cost reports for that scope. Compare metered usage first, then use the invoice’s separate lines to work through taxes, credits and fees.</p>
      <h2>Build the bridge from local estimate to invoice</h2>
      <p>Suppose a Claude Console customer’s USD invoice shows $132 in metered usage. You have $96 in local estimates for Claude Code runs identified in your own records as belonging to the billed workspace. A cost report confirms $28 from a separate automation workspace, and matching the coding records to the applicable rates raises their confirmed cost from $96 to $102. In Anthropic’s Analytics cost report, <code>list_amount</code> gives the list-price comparator and <code>amount</code> includes discounts before credits. Both are in cents: divide by 100 before entering dollars. Use the dimensions available to your account; a Claude Enterprise report can lack the workspace and key identifiers in this example.</p>
      <table><caption>Illustrative reconciliation in USD</caption><thead><tr><th scope="col">Line</th><th scope="col">Amount</th></tr></thead><tbody>
        <tr><th scope="row">Local coding estimate</th><td>$96</td></tr>
        <tr><th scope="row">Confirmed automation workspace</th><td>+$28</td></tr>
        <tr><th scope="row">Confirmed rate adjustment</th><td>+$6</td></tr>
        <tr><th scope="row">Unexplained portion of metered usage</th><td>+$2</td></tr>
        <tr><th scope="row">Invoiced metered usage</th><td>$132</td></tr>
        <tr><th scope="row">Invoice credit, fee and tax</th><td>−$19 + $3 + $12</td></tr>
        <tr><th scope="row">Invoice amount due</th><td>$128</td></tr>
      </tbody></table>
      <p>The amount due is $4 below the metered line after the credit, fee and tax. Confirmed usage adds up to $130, leaving $2 unexplained against the $132 metered line. Check day-boundary records, other API keys or workspaces, cache categories and pricing tiers before assigning the $2 to any cause.</p>
      <p>If you <a href="/join">have Tokentracky collecting local Claude Code usage</a>, export a <strong>Tokens</strong> range covering the full billing period and filter its timestamps to the invoice dates. Use project or session details where available to match runs to your own billing notes. Keep unknown prices and records with uncertain billing ownership out of the confirmed column. Verify costs with the provider’s reports and retain the invoice and report filters alongside the worksheet. For a final Anthropic monthly reconciliation, run the report again at least seven days after month-end to allow for late events. If the residual stays above your documented tolerance, send billing support the affected dates, workspace and line amounts.</p>
    </>,
    sources: [
      { label: 'Anthropic’s organization usage and cost reports', url: reports },
      { label: 'Anthropic’s API pricing by model, tier and cache category', url: pricing },
    ],
  },
  {
    ...guide('subscription-versus-api-cost'),
    description: 'Find the break-even point for a coding subscription, then see how much paid overflow you can afford before pay-as-you-go becomes cheaper.',
    body: <>
      <h2>Price a month of work the subscription could cover</h2>
      <p>Take a completed month and price the work at the relevant API model’s input, output and cache rates. Compare the result with the subscription fee plus any paid overflow. Check model access, eligible clients and reset windows on the current plan before assuming it covers the same work. Keep scripts or other usage outside the plan on a separate billing line.</p>
      <p>Suppose a hypothetical plan costs $24 a month. Your repeated task bundle uses 500,000 fresh input tokens, two million cache reads and 200,000 output tokens. At illustrative rates of $2, $0.50 and $10 per million respectively, that’s $1 + $1 + $2 = $4 per bundle on the API. This example assumes no cache-write charges for the measured bundles. At six bundles, API spend equals the plan fee. At eight bundles, API spend is $32. That gives the plan $8 of room for paid overflow before the costs tie.</p>
      <h2>Test the busiest window before choosing</h2>
      <p>Suppose five of the eight bundles fit into the plan when you need them, and you run the remaining three through the API. Your hybrid cost is $24 + 3 × $4 = $36, so pay-as-you-go saves $4. With exactly two overflow bundles the cost ties at $32. If the work can wait until the allowance resets, try moving one run and check whether the delay is acceptable. A token-based break-even calculation alone can’t tell you whether the plan has enough capacity on release day.</p>
      <p>For a Claude Code comparison, <a href="/join">install Tokentracky to inspect your local usage</a> and export a <strong>Tokens</strong> range covering a completed month. Filter to its dates and sum the known <code>cost_microusd</code> values. Divide by 1,000,000 to get the same-model list-price estimate in dollars. Flag unpriced events separately. To apply custom rates to mixed five-minute and one-hour cache writes, get each lifetime’s count from the original usage records; the CSV combines them in <code>cache_write</code>. Use timestamps to identify the busiest stretch. If you can try the subscription, record limits hit and work deferred during a representative busy window using the plan’s own usage indicators. Treat local dollar estimates as a way to price equivalent usage. Check your actual charges, available models and plan allowance with the provider before deciding.</p>
    </>,
    sources: [
      { label: 'Claude subscription plans and coding allowances', url: 'https://claude.com/pricing' },
      { label: 'Anthropic’s metered API pricing', url: pricing },
    ],
  },
];
