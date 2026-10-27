// Operator moderation commands, run through scripts/moderation.ts.
// Every moderation write names one member and is confirmed by typing that name again. There are no batch or query options;
// `recompute-badges` only refreshes what is derived from published totals, for every member.
import { compactCount } from './badge.ts';
import { CloudError } from './errors.ts';
import type { ModerationSummary, PostgresCloudRepository, QueueItem } from './repository.ts';

export interface OperatorIo {ask(question: string): Promise<string>; print(line: string): void}

export const USAGE = `Usage: npx tsx scripts/moderation.ts <command>
  queue                                   Open flags, hidden first, with the ratio when flagged and now
  audit                                   Counts only; exits 1 when a hidden flag exceeds the configured review deadline
  counter-audit                           Read-only counts of integrity holds and wide shared aggregate families
  clear <alias> <day> --note "<text>"     Restore a day: the member is public again unless another day is hidden
  hide <alias> <day> --note "<text>"      Hide a flagged day as a person's decision
  ban <alias> --reason "<text>"           Refuse every publishing route, revoke computers, close open flags
  unban <alias | account id>              Allow publishing again; revoked computers stay revoked
  recompute-badges                        Recompute every member's badges (after migration 0009 or a BADGE_TIERS change)`;
const DAY = /^(\d{4}-\d{2}-\d{2}|unknown)$/;

/** Returns the process exit code. */
export async function moderationCommand(repository: PostgresCloudRepository, argv: string[], io: OperatorIo): Promise<number> {
  const [command, ...rest] = argv;
  const positional = rest.filter((value, index) => !value.startsWith('--') && !rest[index - 1]?.startsWith('--'));
  const option = (name: string) => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] ?? '' : ''; };
  const usage = () => { io.print(USAGE); return 2; };
  try {
    switch (command) {
      case 'queue': {
        const items = await repository.moderationQueue();
        if (!items.length) io.print('No open flags.');
        for (const item of items) io.print(queueLine(item));
        return 0;
      }
      case 'audit': {
        const audit = await repository.moderationAudit();
        io.print(`Hidden flags past the review deadline: ${audit.staleHidden}`);
        io.print(`Open review flags: ${audit.openReviews}`);
        io.print(`Bans: ${audit.bans}, of which never flagged (re-review first): ${audit.bansWithoutFlag}`);
        return audit.staleHidden > 0 ? 1 : 0;
      }
      case 'counter-audit': {
        if (rest.length) return usage();
        const audit = await repository.counterAudit();
        io.print(`Account integrity holds: ${audit.invalidAccounts}`);
        io.print(`Shared aggregate families using exact decimal values: ${audit.overflowFamilies}`);
        return audit.invalidAccounts > 0 ? 1 : 0;
      }
      case 'clear':
      case 'hide': {
        const [alias, day] = positional;
        if (!alias || !day || !DAY.test(day) || !option('note')) return usage();
        const summary = await repository.moderationSummary(alias);
        if (!summary.flags.some(flag => flag.day === day)) throw new CloudError(404, 'NOT_FOUND', 'No flag for this member and day');
        if (!await confirm(io, summary, `${command === 'clear' ? 'Clear' : 'Hide'} ${day}`, alias)) return 1;
        await repository.reviewFlag(alias, day, command === 'clear' ? 'cleared' : 'hidden', option('note'));
        io.print(`${command === 'clear' ? 'Cleared' : 'Hidden'} ${day} for ${alias}.`);
        return 0;
      }
      case 'ban': {
        const [alias] = positional;
        if (!alias || !option('reason')) return usage();
        const summary = await repository.moderationSummary(alias);
        if (!await confirm(io, summary, `Ban: refuse every publishing route, revoke ${summary.devices} computer(s), close open flags`, alias)) return 1;
        const result = await repository.ban(alias, option('reason'));
        io.print(`Banned ${alias}; ${result.devicesRevoked} computer(s) revoked.`);
        return 0;
      }
      case 'unban': {
        const [target] = positional;
        if (!target) return usage();
        const summary = await repository.moderationSummary(target);
        if (!summary.banned) throw new CloudError(404, 'NOT_FOUND', 'No ban for this account');
        if (!await confirm(io, summary, 'Unban: the member may publish again and must reconnect their computers', target)) return 1;
        await repository.unban(summary.accountId);
        io.print(`Unbanned ${target}.`);
        return 0;
      }
      case 'recompute-badges': {
        if (positional.length) return usage();
        io.print(`Recomputed badges for ${await repository.recomputeAllBadges()} member(s).`);
        return 0;
      }
      default: return usage();
    }
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    io.print(error.message);
    return 1;
  }
}

const ratio = (tokens: number, rival: number) => rival > 0 ? `${(tokens / rival).toFixed(1)}×` : 'no peers';

function queueLine(item: QueueItem): string {
  const who = item.alias ?? `(no profile) ${item.accountId.slice(0, 12)}`;
  return `${item.status.padEnd(6)} ${who} ${item.day} [${item.reasons.join(', ')}] flagged ${compactCount(item.tokens)} at ${ratio(item.tokens, item.rival)} of ${item.cohort} peers;`
    + ` now ${compactCount(item.tokensNow)} at ${ratio(item.tokensNow, item.rivalNow)} of ${item.cohortNow} visible peers${item.rivalNow > 0 && item.tokensNow <= item.rivalNow ? ' (a visible member out-ran them: likely false positive)' : ''}`;
}

async function confirm(io: OperatorIo, summary: ModerationSummary, change: string, typed: string): Promise<boolean> {
  io.print(`${summary.alias ?? '(no profile)'} · account ${summary.accountId.slice(0, 12)} · ${compactCount(summary.tokens)} tokens over ${summary.days} day(s) · ${summary.devices} computer(s)${summary.banned ? ' · banned' : ''}`);
  for (const flag of summary.flags) io.print(`  ${flag.day} ${flag.status}${flag.reviewed ? ' (reviewed)' : ''} [${flag.reasons.join(', ')}]`);
  io.print(`Change: ${change}.`);
  if ((await io.ask(`Type ${typed} to confirm: `)).trim() === typed) return true;
  io.print('Not confirmed; nothing changed.');
  return false;
}
