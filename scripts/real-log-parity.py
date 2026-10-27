#!/usr/bin/env python3
"""Counts Claude Code and Codex usage straight from their logs, without the app's readers, and compares it with the
app's store by tool, model and UTC day.

Local only. It reads usage numbers, ids, models and times, never message text, and prints totals to the terminal;
keep its output out of the repository.

    python3 -I scripts/real-log-parity.py [--db ~/.tokentracky/usage.sqlite] [--days 15]

Claude Code: each assistant message counted once by message id and request id, at its largest output (streamed
lines repeat it). Codex: each token_count counted once by its running total and last request together, which a fork's
copied history repeats; it is dated at the earliest time it was seen, so a copy does not move it to the fork's day.
Totals are input + output + cache read + cache write, as the app counts them.

Codex usage that raises a running total without a token count of its own (one rollout on 15 July 2026: 6.2M) is in
the app's count, which takes differences of totals, and not in this one, which adds each request's last usage.
"""
import argparse
import collections
import json
import os
import sqlite3
import subprocess
import sys
from multiprocessing import Pool

HOME = os.path.expanduser('~')
T3 = os.path.join(HOME, 't3-routing', '.runtime', 'profiles')
ROOTS = {
    'claude': [os.path.join(HOME, '.claude', 'projects'), os.path.join(HOME, '.config', 'claude', 'projects'),
               os.path.join(T3, 'claude', 'projects')],
    'codex': [os.path.join(HOME, '.codex', 'sessions'), os.path.join(HOME, '.codex', 'archived_sessions'),
              os.path.join(T3, 'codex', 'sessions'), os.path.join(T3, 'codex', 'archived_sessions')],
}


COUNTERS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'cache_creation_input_tokens',
            'output_tokens', 'reasoning_output_tokens')


def lines(path):
    if path.endswith('.zst'):
        process = subprocess.Popen(['zstd', '-dcq', path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        yield from process.stdout
        process.wait()
    else:
        with open(path, 'rb') as file:
            yield from file


def files(tool):
    for root in ROOTS[tool]:
        for folder, _, names in os.walk(root):
            for name in names:
                if (tool == 'claude' and name.endswith('.jsonl')) or (tool == 'codex' and name.startswith('rollout-')):
                    yield root, os.path.join(folder, name)


def claude_file(path):
    """(message id, request id) -> (output, model, time, tokens) of each assistant message in one log."""
    found = {}
    for raw in lines(path):
        if b'"usage"' not in raw or b'"assistant"' not in raw:
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        message = record.get('message') or {}
        usage = message.get('usage')
        if record.get('type') != 'assistant' or not usage or not message.get('id'):
            continue
        tokens = sum(usage.get(kind) or 0 for kind in
                     ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
        key = (message['id'], record.get('requestId'))
        output = usage.get('output_tokens') or 0
        if key not in found or output >= found[key][0]:
            found[key] = (output, message.get('model') or 'unknown', record.get('timestamp') or '', tokens)
    return found


def codex_file(path):
    """(running total, last request) -> (model, time, tokens) of each token_count in one rollout."""
    found, model = {}, 'unknown'
    for raw in lines(path):
        if b'"turn_context"' in raw:
            try:
                model = json.loads(raw)['payload'].get('model') or model
            except (ValueError, KeyError, AttributeError):
                pass
        elif b'"token_count"' in raw:
            try:
                record = json.loads(raw)
                info = record['payload'].get('info')
            except (ValueError, KeyError, AttributeError):
                continue
            if not info or not info.get('last_token_usage'):
                continue
            total, last = info.get('total_token_usage') or {}, info['last_token_usage']
            # The counters alone: a parent writes `cache_write_input_tokens: 0` where its copies leave it out.
            key = tuple(usage.get(kind) or 0 for usage in (total, last) for kind in COUNTERS)
            tokens = (last.get('input_tokens') or 0) + (last.get('output_tokens') or 0)
            at = record.get('timestamp') or ''
            if key not in found or at < found[key][1]:
                found[key] = (model, at, tokens)
    return found


def raw_counts(tool):
    """{(model, day): [requests, tokens]} and {root: tokens}."""
    paths = list(files(tool))
    root_of = dict((path, root) for root, path in paths)
    scan = claude_file if tool == 'claude' else codex_file
    best = {}
    with Pool(8) as pool:
        for path, found in zip([p for _, p in paths], pool.imap(scan, [p for _, p in paths], chunksize=8)):
            for key, value in found.items():
                old = best.get(key)
                if tool == 'claude':
                    if old is None or value[0] >= old[0][0]:
                        best[key] = (value, root_of[path])
                elif old is None or value[1] < old[0][1]:
                    best[key] = (value, root_of[path])
    counts, roots = collections.defaultdict(lambda: [0, 0]), collections.Counter()
    for value, root in best.values():
        model, at, tokens = (value[1], value[2], value[3]) if tool == 'claude' else value
        row = counts[(model, at[:10] or 'undated')]
        row[0] += 1
        row[1] += tokens
        roots[root] += tokens
    return counts, roots, len(paths)


def app_counts(db, tool):
    """{(model, day): [events, tokens]} from the app's store, and the folders it reads."""
    store = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
    paths = json.loads(store.execute('SELECT paths FROM sources WHERE tool=?', (tool,)).fetchone()[0])
    counts = collections.defaultdict(lambda: [0, 0])
    saved = store.execute("SELECT 1 FROM sqlite_master WHERE name='usage_slots'").fetchone()
    if saved:
        rows = store.execute('SELECT model, day, SUM(events), SUM(input+output+cache_read+cache_write) FROM usage_slots '
                             'WHERE tool=? GROUP BY model, day', (tool,))
        for model, day, events, tokens in rows:
            counts[(model, day or 'undated')] = [events, tokens]
    else:
        for (event,) in store.execute("SELECT event_json FROM current_events WHERE json_extract(event_json,'$.tool')=?",
                                      (tool,)):
            event = json.loads(event)
            tokens = sum(event['tokens'][kind] for kind in ('input', 'output', 'cacheRead', 'cacheWrite'))
            if tokens:
                row = counts[(event['model'], (event.get('occurredAt') or '')[:10] or 'undated')]
                row[0] += 1
                row[1] += tokens
    return counts, paths


def tokens_by(counts, part):
    """Tokens by model (`part` 0) or day (1)."""
    totals = collections.Counter()
    for key, row in counts.items():
        totals[key[part]] += row[1]
    return totals


def millions(tokens):
    return f'{tokens / 1e6:,.1f}M'


def report(tool, db, days):
    raw, roots, read = raw_counts(tool)
    app, paths = app_counts(db, tool)
    total = lambda counts, at: sum(row[at] for row in counts.values())
    print(f'\n== {tool}: {read} log files')
    print(f'   logs {millions(total(raw, 1))} in {total(raw, 0):,} requests;'
          f' app {millions(total(app, 1))} in {total(app, 0):,} events;'
          f' app - logs {millions(total(app, 1) - total(raw, 1))}')
    for root in ROOTS[tool]:
        if os.path.isdir(root):
            reads = any(os.path.realpath(path) == os.path.realpath(root) for path in paths)
            print(f'   {root}: {millions(roots[root])}{"" if reads else "  (the app does not read this folder)"}')
    raw_models, app_models = tokens_by(raw, 0), tokens_by(app, 0)
    models = sorted(set(raw_models) | set(app_models), key=lambda model: -max(raw_models[model], app_models[model]))
    print('   by model (logs, app, app - logs):')
    for model in models[:15]:
        print(f'     {model:28} {millions(raw_models[model]):>12} {millions(app_models[model]):>12}'
              f' {millions(app_models[model] - raw_models[model]):>10}')
    raw_days, app_days = tokens_by(raw, 1), tokens_by(app, 1)
    every = set(raw_days) | set(app_days)
    differ = sorted((d for d in every if raw_days[d] != app_days[d]), key=lambda d: -abs(app_days[d] - raw_days[d]))
    print(f'   days: {len(every)}, matching exactly {len(every) - len(differ)}; largest differences (logs, app):')
    for day in differ[:days]:
        print(f'     {day}  {millions(raw_days[day]):>10} {millions(app_days[day]):>10}'
              f'  {millions(app_days[day] - raw_days[day]):>10}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--db', default=os.path.join(HOME, '.tokentracky', 'usage.sqlite'))
    parser.add_argument('--days', type=int, default=15, help='how many differing days to list')
    parser.add_argument('--tool', choices=sorted(ROOTS), action='append', help='one tool (default: all)')
    options = parser.parse_args()
    for tool in options.tool or sorted(ROOTS):
        report(tool, options.db, options.days)


if __name__ == '__main__':
    sys.exit(main())
