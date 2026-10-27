#!/usr/bin/env python3
"""Isolated native runtime measurement. No third-party Python packages or real source logs.

Entry points: measure-footprint.sh, soak-native.sh. Raw evidence stays in .runtime;
copy selected redacted evidence into docs before calling a release gate complete.
"""
import argparse
import ctypes
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlsplit, parse_qs
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import sqlite3
import statistics
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
# Approved 24 October 2026; all responsibility-attributed helpers count.
CLOSED_TARGET_MIB = 40


def run(argv, **kwargs):
    return subprocess.run([str(x) for x in argv], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, **kwargs)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def processes(app):
    """All responsibility-attributed processes, irrespective of name or parent PID."""
    responsible = ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
    responsible.argtypes = [ctypes.c_int]
    responsible.restype = ctypes.c_int
    if responsible(app) != app:
        raise RuntimeError('LaunchServices responsibility attribution is unavailable')
    found = []
    for line in run(['ps', '-Ao', 'pid=,comm=']).stdout.splitlines():
        pid, name = line.strip().split(None, 1)
        pid = int(pid)
        if pid == app or responsible(pid) == app:
            found.append({'pid': pid, 'name': name})
    if not any(p['pid'] == app for p in found):
        raise RuntimeError('App exited during process enumeration')
    return found


def cpu_seconds(pids):
    total = 0.0
    for pid in pids:
        text = run(['ps', '-o', 'time=', '-p', pid]).stdout.strip()
        value = 0.0
        for component in text.split(':'):
            value = value * 60 + float(component)
        total += value
    return total


def fixture(source):
    """60 sessions / 600 unique requests over 30 UTC days, from scratch."""
    source.mkdir()
    today = dt.datetime.now(dt.timezone.utc).date()
    total = 0
    for day in range(30):
        for session in range(2):
            ident = f'native-{day}-{session}'
            lines = []
            for request in range(10):
                usage = {'input_tokens': 1000, 'output_tokens': 200,
                         'cache_read_input_tokens': 3000, 'cache_creation_input_tokens': 400}
                total += sum(usage.values())
                lines.append(json.dumps({
                    'type': 'assistant', 'sessionId': ident,
                    'cwd': f'/synthetic/project-{session}',
                    'timestamp': f'{today - dt.timedelta(days=day)}T12:{request:02}:00.000Z',
                    'requestId': f'{ident}-{request}',
                    'message': {'id': f'{ident}-{request}', 'model': 'claude-sonnet-4-6',
                                'usage': usage, 'content': []}}))
            (source / f'{ident}.jsonl').write_text('\n'.join(lines) + '\n')
    return {'requests': 600, 'sessions': 60, 'days': 30, 'tokens': total}


def continuous_seconds():
    """macOS continuous clock includes sleep; wall and awake clocks remain in raw events."""
    class Timebase(ctypes.Structure):
        _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    lib.mach_continuous_time.restype = ctypes.c_uint64
    base = Timebase()
    if lib.mach_timebase_info(ctypes.byref(base)) != 0:
        raise RuntimeError('mach_timebase_info failed')
    return lib.mach_continuous_time() * base.numer / base.denom / 1e9


def bundle_digest(app):
    digest = hashlib.sha256()
    for path in sorted(app.rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(app)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def validate_soak(summary, required, max_gap):
    failures = []
    if summary['elapsed_seconds'] < required:
        failures.append('incomplete elapsed duration')
    if summary.get('max_sample_gap_seconds', 0) > max_gap:
        failures.append('unobserved sampling gap (sleep or harness stall; inspect wake evidence)')
    for case in ('offline-start', 'offline-end', 'short-wake', 'long-wake', 'repeated-wake',
                 'offline-wake', 'wake-during-sync'):
        if case not in summary.get('manual_events', []):
            failures.append(f'missing manual event: {case}')
    for key in ('collection_ok', 'sync_ok', 'closed_budget_ok', 'no_growth', 'graceful_exit'):
        if not summary.get(key):
            failures.append(f'failed/unverified: {key}')
    if summary.get('wake_notifications', 0) < 5:
        failures.append('missing observed workspace wake notifications')
    if not summary.get('artifact_unchanged'):
        failures.append('candidate changed during run')
    if not summary.get('signed_notarized_candidate'):
        failures.append('not a verified signed and stapled candidate')
    return failures


def assess_closed_memory(samples):
    """Count every settled reading, including minute samples between paired page visits."""
    values = [sample['mb'] for sample in samples]
    return {'closed_budget_ok': bool(values) and max(values) <= CLOSED_TARGET_MIB,
            'no_growth': len(values) >= 4 and statistics.median(values[-4:]) <= statistics.median(values[:4]) + 3}


class FixtureCloud:
    """Loopback-only populated public rankings and an idempotent synthetic ingest sink."""
    def __init__(self, raw, namespace):
        self.raw, self.namespace = raw, namespace
        self.offline = False
        self.buckets = {}
        self.uploads = 0
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def answer(self, status, body):
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                path = urlsplit(self.path).path
                owner.requests.append(path)
                if owner.offline or (owner.raw / 'fixture-offline').exists():
                    return self.answer(503, {'error': {'code': 'SYNTHETIC_OFFLINE'}})
                publication = {'alias': 'native-fixture-01', 'historyStart': None, 'shareTools': True,
                               'shareCost': True, 'shareModels': True,
                               'generation': '11111111-2222-3333-4444-555555555555'}
                if path == '/api/device-policy':
                    if self.headers.get('Authorization') not in (f'Bearer synthetic-native-runtime-{owner.namespace}-app', f'Bearer synthetic-native-runtime-{owner.namespace}-cli'):
                        return self.answer(401, {})
                    return self.answer(200, {'publication': publication})
                rows = [{'alias': f'native-fixture-{i:02}', 'rank': i, 'tokens': 3000000-i*10000,
                         'previousRank': i, 'toolTokens': {'claude': 3000000-i*10000},
                         'costMicrousd': 1000000, 'daily': [10000+i*100]*14} for i in range(1, 21)]
                if path == '/api/leaderboard':
                    today = dt.datetime.now(dt.timezone.utc).date()
                    return self.answer(200, {'items': rows, 'total': 20, 'page': 1, 'pageSize': 20,
                        'period': parse_qs(urlsplit(self.path).query).get('period', ['week'])[0],
                        'windowStart': f'{today-dt.timedelta(days=6)}T00:00:00.000Z',
                        'updatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                        'totalTokens': sum(row['tokens'] for row in rows),
                        'toolTotals': {'claude': sum(row['tokens'] for row in rows)},
                        'totalCostMicrousd': 20000000,
                        'trend': [{'day': str(today-dt.timedelta(days=29-i)), 'tokens': 1000000+i*5000} for i in range(30)]})
                if path.startswith('/api/profiles/'):
                    return self.answer(200, rows[0])
                return self.answer(404, {})

            def do_POST(self):
                if self.path != '/api/ingest':
                    return self.answer(404, {})
                if owner.offline or (owner.raw / 'fixture-offline').exists():
                    return self.answer(503, {'error': {'code': 'SYNTHETIC_OFFLINE'}})
                if self.headers.get('Authorization') not in (f'Bearer synthetic-native-runtime-{owner.namespace}-app', f'Bearer synthetic-native-runtime-{owner.namespace}-cli'):
                    return self.answer(401, {})
                size = int(self.headers.get('Content-Length', '0'))
                if size > 1048576:
                    return self.answer(413, {})
                body = json.loads(self.rfile.read(size))
                delay_file = owner.raw / 'fixture-ingest-delay-seconds'
                if delay_file.exists():
                    delay = float(delay_file.read_text().strip())
                    if not 0 <= delay <= 12:
                        return self.answer(400, {'error': {'code': 'INVALID_FIXTURE_DELAY'}})
                    time.sleep(delay)
                for bucket in body['buckets']:
                    key = (bucket.get('day'), bucket['tool'], bucket.get('model'))
                    previous = owner.buckets.get(key)
                    if previous and previous['revision'] == bucket['revision'] and previous != bucket:
                        return self.answer(409, {'error': {'code': 'CONFLICTING_FIXTURE_REVISION'}})
                    if not previous or previous['revision'] <= bucket['revision']:
                        owner.buckets[key] = bucket
                owner.uploads += 1
                with (owner.raw / 'fixture-ingest.jsonl').open('a') as output:
                    # Synthetic public buckets only; never record Authorization or request identifiers.
                    output.write(json.dumps({'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                                             'checkpoint': body['checkpoint'], 'buckets': body['buckets']})+'\n')
                return self.answer(200, {'accepted': len(body['buckets'])})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def summary(self):
        return {'uploads': self.uploads, 'buckets': len(self.buckets),
                'tokens': sum(bucket['tokens'] for bucket in self.buckets.values()),
                'leaderboard_requests': self.requests.count('/api/leaderboard')}

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Runtime:
    def __init__(self, args):
        self.args = args
        self.started_continuous = continuous_seconds()
        self.soak_started_continuous = None
        self.app = args.app.resolve()
        info = plistlib.loads((self.app / 'Contents/Info.plist').read_bytes())
        self.exe = self.app / 'Contents/MacOS' / info['CFBundleExecutable']
        self.cli = args.cli.resolve()
        # Refuse old binaries that ignore isolation and could read a real cloud credential.
        for exe in (self.exe, self.cli):
            if any(marker not in exe.read_bytes() for marker in (b'TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE', b'TOKENTRACKY_TEST_CLOUD_FIXTURE')):
                raise RuntimeError(f'{exe} does not support isolated credential namespaces; rebuild first')
        # The single-instance plugin is per identifier, not per data directory. Never drive another instance.
        existing = subprocess.run(
            ['pgrep', '-x', self.exe.name], capture_output=True, text=True, check=False)
        if existing.returncode == 0:
            raise RuntimeError('A native app is already running; refusing to control or terminate it')
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.raw = ROOT / '.runtime' / args.mode / f'{stamp}-{uuid.uuid4().hex[:8]}'
        self.raw.mkdir(parents=True)
        print(f'Raw evidence: {self.raw}', flush=True)
        self.env = dict(os.environ)
        self.namespace = 'runtime-' + uuid.uuid4().hex
        self.env.update(TOKENTRACKY_HOME=str(self.raw / 'data'),
                        TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE=self.namespace+'-app',
                        TOKENTRACKY_TEST_CLOUD_FIXTURE='1',
                        TOKENTRACKY_PRICING_REFRESH='0',
                        TOKENTRACKY_CLOUD_URL='https://native-runtime.invalid')
        # Drop inherited source-location overrides; only explicitly granted fixture paths are read.
        for key in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'CLINE_DIR',
                    'CLINE_DATA_DIR', 'XDG_DATA_HOME', 'OPENCODE_DB', 'KILO_DB'):
            self.env.pop(key, None)
        self.cloud = FixtureCloud(self.raw, self.namespace)
        self.env['TOKENTRACKY_TEST_CLOUD_URL'] = self.cloud.origin
        self.keychain_seeded = False
        self.pid = None
        self.added_events = 0
        self.log = self.raw / 'app.log'
        (self.raw / 'source.diff').write_text(run(['git', 'diff', 'HEAD'], cwd=ROOT).stdout)
        (self.raw / 'native_runtime.py').write_bytes(Path(__file__).read_bytes())
        self.result = {'status': 'incomplete', 'mode': args.mode, 'app': str(self.app),
                       'bundle_identifier': info['CFBundleIdentifier'], 'keychain_namespace': self.namespace,
                       'source_commit': run(['git', 'rev-parse', 'HEAD'], cwd=ROOT).stdout.strip(),
                       'binary_sha256': hashlib.sha256(self.exe.read_bytes()).hexdigest(),
                       'bundle_sha256': bundle_digest(self.app),
                       'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       'compiler': run(['rustc', '--version']).stdout.strip(),
                       'hardware': run(['sysctl', '-n', 'machdep.cpu.brand_string', 'hw.memsize']).stdout.strip(),
                       'source_diff_sha256': hashlib.sha256(run(['git', 'diff', 'HEAD'], cwd=ROOT).stdout.encode()).hexdigest(),
                       'system': run(['sw_vers']).stdout, 'architecture': run(['uname', '-m']).stdout.strip(),
                       'closed_target_mb': CLOSED_TARGET_MIB, 'closed_deadline_seconds': 10,
                       'open_at_rest_target_mb': 120, 'idle_cpu_target_percent': 0.05}
        write_json(self.raw / 'results.json', self.result)
        self.event('created')

    def event(self, name, **values):
        with (self.raw / 'events.jsonl').open('a') as output:
            output.write(json.dumps({'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                                     'monotonic': time.monotonic(), 'event': name, **values}) + '\n')

    def cli_run(self, command, label, check=True):
        cli_env = dict(self.env, TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE=self.namespace+'-cli')
        completed = subprocess.run([str(self.cli), command, '--json'], env=cli_env,
                                   text=True, capture_output=True, timeout=30, check=False)
        (self.raw / f'{label}.stdout').write_text(completed.stdout)
        (self.raw / f'{label}.stderr').write_text(completed.stderr)
        if check and completed.returncode:
            raise RuntimeError(f'CLI {command} failed ({completed.returncode}); see {label}.stderr')
        return completed

    def prepare(self):
        self.keychain_seeded = True
        (self.raw / 'credential-seed.txt').write_text('Each binary seeds/reads back its own generated synthetic link in its own test file.\n')
        self.cli_run('refresh', 'empty-init')
        expected = fixture(self.raw / 'sources')
        with sqlite3.connect(self.raw / 'data/usage.sqlite') as db:
            db.execute('UPDATE sources SET enabled=0, paths=?', ('[]',))
            db.execute('UPDATE sources SET enabled=1, paths=? WHERE tool=?',
                       (json.dumps([str(self.raw / 'sources')]), 'claude'))
        self.cli_run('refresh', 'populated-init')
        self.verify_fixture()
        self.result['fixture'] = expected
        self.event('fixture-prepared', **expected)

    def append_soak_usage(self):
        """One new synthetic request per later hour exercises checkpoints and bucket revisions."""
        self.added_events += 1
        ident = f'native-soak-{self.added_events}'
        record = {'type': 'assistant', 'sessionId': 'native-soak', 'cwd': '/synthetic/soak-project',
                  'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(), 'requestId': ident,
                  'message': {'id': ident, 'model': 'claude-sonnet-4-6', 'content': [],
                              'usage': {'input_tokens': 1000, 'output_tokens': 200,
                                        'cache_read_input_tokens': 3000, 'cache_creation_input_tokens': 400}}}
        with (self.raw / 'sources/native-soak.jsonl').open('a') as output:
            output.write(json.dumps(record)+'\n')
        self.event('synthetic-usage-appended', request=self.added_events, tokens=4600)

    def expected_totals(self):
        return {'events': 600 + self.added_events, 'tokens': 2760000 + 4600*self.added_events}

    def verify_fixture(self):
        # Read only our own store, after app/CLI released its exclusive writer lock.
        with sqlite3.connect(self.raw / 'data/usage.sqlite') as db:
            events = [json.loads(row[0]) for row in db.execute('SELECT event_json FROM current_events')]
        tokens = sum(sum(e['tokens'][key] for key in ('input', 'output', 'cacheRead', 'cacheWrite')) for e in events)
        expected = self.expected_totals()
        if (len(events), tokens) != (expected['events'], expected['tokens']):
            raise RuntimeError(f'Fixture totals changed or duplicated: {len(events)} events, {tokens} tokens')
        return {'events': len(events), 'tokens': tokens}

    def wait_log(self, pattern, offset=0, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            text = self.log.read_text(errors='replace') if self.log.exists() else ''
            found = re.search(pattern, text[offset:])
            if found:
                return found
            time.sleep(.1)
        raise RuntimeError(f'Timed out waiting for {pattern!r}; see {self.log}')

    def launch(self):
        self.log.touch()
        offset = len(self.log.read_text())
        command = ['open', '-n', '-F', '--stderr', self.log]
        for key in ('TOKENTRACKY_HOME', 'TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE',
                    'TOKENTRACKY_PRICING_REFRESH', 'TOKENTRACKY_CLOUD_URL', 'TOKENTRACKY_TEST_CLOUD_FIXTURE', 'TOKENTRACKY_TEST_CLOUD_URL'):
            command += ['--env', f'{key}={self.env[key]}']
        run(command + [self.app, '--args', '--hidden'], env=self.env)
        deadline = time.monotonic() + 10
        while self.pid is None and time.monotonic() < deadline:
            for line in run(['ps', '-Ao', 'pid=,comm=']).stdout.splitlines():
                number, path = line.strip().split(None, 1)
                if Path(path).resolve() == self.exe.resolve():
                    self.pid = int(number)
                    break
            if self.pid is None:
                time.sleep(.1)
        if self.pid is None:
            raise RuntimeError('LaunchServices did not start the requested executable')
        logged = int(self.wait_log(r'title-set pid=(\d+)', offset).group(1))
        if logged != self.pid:
            raise RuntimeError('Startup log belongs to a different instance')
        actual = run(['ps', '-p', self.pid, '-o', 'comm=']).stdout.strip()
        if Path(actual).resolve() != self.exe.resolve():
            raise RuntimeError('LaunchServices started a different bundle; refusing control')
        self.event('launched', pid=self.pid)
        return float(self.wait_log(r'exec_to_title_ms=([0-9.]+)', offset).group(1))

    def control(self, action, wait=None):
        if self.pid is None:
            raise RuntimeError('No owned app instance')
        # Every command carries the same namespace, even though second-instance exits before opening a store.
        offset = len(self.log.read_text())
        run([self.exe, action], env=self.env)
        self.event('control', action=action)
        if wait:
            self.wait_log(wait, offset)

    def open_popover(self):
        """The menu bar popover a left click opens, under the icon, once its page has loaded and it is shown.
        Already shown, it stays as it is (as --open-dashboard succeeds on an open dashboard); still loading, the app
        logs nothing until it is shown."""
        self.control('--open-popover', 'popover (?:visible|already open)')

    def quit(self):
        self.control('--quit', r'backend shutdown finished ok=true')
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                os.kill(self.pid, 0)
            except ProcessLookupError:
                self.event('graceful-exit', pid=self.pid)
                self.pid = None
                return
            time.sleep(.1)
        raise RuntimeError('Graceful quit did not exit; no forced-termination fallback')

    def memory(self, label):
        started = time.monotonic()
        procs = processes(self.pid)
        write_json(self.raw / f'{label}.procs.json', procs)
        argv = ['footprint', '-j', self.raw / f'{label}.json']
        for proc in procs:
            argv += ['-p', proc['pid']]
        completed = subprocess.run([str(x) for x in argv], capture_output=True, text=True, timeout=45, check=False)
        (self.raw / f'{label}.txt').write_text(completed.stdout + completed.stderr)
        if completed.returncode:
            raise RuntimeError(f'footprint failed; see {label}.txt')
        readings = json.loads((self.raw / f'{label}.json').read_text())['processes']
        if {p['pid'] for p in readings} != {p['pid'] for p in procs}:
            raise RuntimeError(f'Process set changed during footprint {label}; refusing partial total')
        reading = {'mb': sum(p['footprint'] for p in readings) / 1048576,
                   'processes': [{'name': p['name'], 'mb': p['footprint'] / 1048576} for p in readings],
                   'sample_seconds': time.monotonic() - started}
        self.event('memory', label=label, **reading)
        return reading

    def cycle(self, index, page):
        self.control('--open-you' if page == 'you' else '--open-dashboard', 'page-load finished')
        # The fixed native action focuses the window. Enumerate the native accessibility graph BEFORE a
        # Finder reopen: offscreen controls otherwise escape measurement, including the retained theme service.
        loaded = time.monotonic()
        run(['osascript', '-e', f'tell application "System Events" to set frontmost of (first application process whose unix id is {self.pid}) to true'])
        if page == 'you':
            time.sleep(3)
            script = (f'tell application "System Events" to tell (first application process whose unix id is '
                      f'{self.pid}) to get entire contents of window "Tokentracky"')
            deadline = time.monotonic() + 30
            while True:
                completed = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=15, check=False)
                (self.raw / f'{page}-{index}-native-controls.txt').write_text(completed.stdout + completed.stderr)
                if completed.returncode == 0 and 'Daily tokens' in completed.stdout:
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError('Native accessibility graph did not expose the populated Tokens page within 30s')
                time.sleep(.5)
            self.event('native-controls-exercised', page=page, pid=self.pid,
                       readiness_seconds=time.monotonic()-loaded)
            # Keep a full at-rest interval even when accessibility registration follows document load late.
            loaded = time.monotonic()
        samples = []
        while time.monotonic() - loaded < self.args.open_seconds:
            reading = self.memory(f'{page}-{index}-open-{len(samples)}')
            reading['at_seconds'] = time.monotonic() - loaded
            samples.append(reading)
            time.sleep(.5)
        rest = [r['mb'] for r in samples if r['at_seconds'] >= 10]
        if not rest:
            raise RuntimeError('No at-rest samples; open window must be measured beyond 10s')
        closed = time.monotonic()
        self.control('--close-dashboard', 'window destroyed')
        time.sleep(max(0, closed + 10 - time.monotonic()))
        reading = self.memory(f'{page}-{index}-closed-10s')
        result = {'index': index, 'page': page, 'open_peak_mb': max(r['mb'] for r in samples),
                  'open_rest_median_mb': statistics.median(rest), 'closed_10s': reading,
                  'closed_sample_started_seconds': time.monotonic() - closed - reading['sample_seconds']}
        if self.args.closed_followup_seconds:
            time.sleep(max(0, closed + self.args.closed_followup_seconds - time.monotonic()))
            result['closed_followup'] = self.memory(f'{page}-{index}-closed-{self.args.closed_followup_seconds}s')
            result['closed_followup_seconds'] = self.args.closed_followup_seconds
        self.event('cycle-complete', **result)
        return result

    def lifecycle(self):
        locked = self.cli_run('refresh', 'cli-while-app-locked', check=False)
        self.result['cli_app_lock_exit_code'] = locked.returncode
        if locked.returncode == 0 or 'already running with' not in locked.stderr.lower():
            raise RuntimeError('CLI did not reject the app-owned store lock')
        self.cloud.offline = True
        self.event('fixture-offline-start')
        self.control('--refresh', r'manual refresh finished ok=true .*sync_error=Some')
        self.cloud.offline = False
        self.event('fixture-offline-end')
        self.control('--refresh', r'manual refresh finished ok=true .*sync_at=Some.*sync_error=None')
        self.result['isolated_sync_offline_retry'] = 'pass'
        self.control('--pause', 'collection paused=true')
        self.control('--refresh', 'manual refresh finished ok=false')
        self.control('--resume', 'collection paused=false')
        self.quit()
        self.result['graceful_relaunch_totals'] = self.verify_fixture()
        self.cli_run('refresh', 'cli-after-graceful-quit')
        self.launch()
        # Explicit, separate crash recovery. No normal quit path uses a signal.
        self.event('forced-termination-recovery-start', pid=self.pid, signal='SIGKILL')
        os.kill(self.pid, signal.SIGKILL)
        time.sleep(2)
        self.pid = None
        self.cli_run('refresh', 'cli-after-forced-termination')
        self.result['crash_recovery_totals'] = self.verify_fixture()
        self.launch()
        self.control('--refresh', 'manual refresh finished ok=true')
        self.result['cli_app_lock'] = 'pass'
        self.result['graceful_quit_relaunch'] = 'pass'
        self.result['forced_termination_recovery'] = 'pass'

    def idle(self):
        started = time.monotonic()
        procs = processes(self.pid)
        pids = [p['pid'] for p in procs]
        before = cpu_seconds(pids)
        # No polling footprint during CPU window: instrumentation itself wakes the app.
        argv = ['top', '-l', str(self.args.idle_seconds + 1), '-s', '1', '-stats', 'pid,cpu']
        for pid in pids:
            argv += ['-pid', str(pid)]
        self.event('idle-start', pids=pids, seconds=self.args.idle_seconds)
        with (self.raw / 'idle-top.txt').open('w') as output:
            process = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT)
            try:
                while process.poll() is None:
                    time.sleep(.25)
            finally:
                if process.poll() is None:
                    process.terminate()  # Only the instrumentation child, never the app or a helper.
                    process.wait(timeout=5)
            if process.returncode:
                raise RuntimeError('top idle measurement failed')
        elapsed = time.monotonic() - started
        after_procs = processes(self.pid)
        after_pids = [p['pid'] for p in after_procs]
        if set(after_pids) != set(pids):
            raise RuntimeError('Attributed process set changed during idle CPU interval')
        after = cpu_seconds(pids)
        self.result['idle'] = {'elapsed_seconds': elapsed, 'cpu_seconds': after - before,
                               'average_percent': (after - before) / elapsed * 100,
                               'pids': pids, 'complete_10_minutes': elapsed >= 600}
        self.event('idle-end', **self.result['idle'])

    def measure(self):
        self.prepare()
        self.result['dmg_mb'] = self.args.dmg.stat().st_size / 1048576 if self.args.dmg else None
        self.result['dmg_sha256'] = hashlib.sha256(self.args.dmg.read_bytes()).hexdigest() if self.args.dmg else None
        self.result['installed_mb'] = int(run(['du', '-sk', self.app]).stdout.split()[0]) / 1024
        self.result['startup_ms'] = []
        for _ in range(self.args.launches):
            self.result['startup_ms'].append(self.launch())
            self.quit()
        self.launch()
        time.sleep(5)
        self.result['closed_launch'] = self.memory('closed-launch')
        cycles = []
        for index in range(self.args.cycles):
            for page in ('leaderboard', 'you'):
                cycles.append(self.cycle(index, page))
        self.result['cycles'] = cycles
        # Normal lifecycle/idle is measured before the separately labeled forced-termination case.
        self.idle()
        self.result['closed_after_idle'] = self.memory('closed-after-idle')
        self.lifecycle()
        self.result['post_recovery_you'] = self.cycle('recovery', 'you')
        self.quit()
        self.result['final_totals'] = self.verify_fixture()
        self.result['fixture_cloud'] = self.cloud.summary()
        if self.cloud.summary()['tokens'] != 2760000 or self.cloud.summary()['leaderboard_requests'] < self.args.cycles:
            raise RuntimeError('Populated rankings/synthetic sync did not complete')
        self.result['artifact_unchanged'] = bundle_digest(self.app) == self.result['bundle_sha256']
        if not self.result['artifact_unchanged']:
            raise RuntimeError('App bundle changed during measurement')
        self.result['status'] = 'complete'
        self.result['budgets_pass'] = (
            max(r['closed_10s']['mb'] for r in cycles + [self.result['post_recovery_you']]) <= CLOSED_TARGET_MIB
            and self.result['closed_launch']['mb'] <= CLOSED_TARGET_MIB
            and self.result['closed_after_idle']['mb'] <= CLOSED_TARGET_MIB
            and max(r['open_rest_median_mb'] for r in cycles + [self.result['post_recovery_you']]) <= 120
            and self.result['idle']['complete_10_minutes']
            and self.result['idle']['average_percent'] <= .05
            and statistics.median(self.result['startup_ms']) <= 300
            and self.result['installed_mb'] <= 40
            and self.result['dmg_mb'] is not None and self.result['dmg_mb'] <= 15)

    def soak(self):
        self.prepare()
        self.launch()
        # Verification of signing/stapling is mandatory for release acceptance; unsigned diagnostics may run.
        assessments = []
        for argv in (
            ['codesign', '--verify', '--deep', '--strict', str(self.app)],
            ['spctl', '--assess', '--type', 'execute', str(self.app)],
            ['xcrun', 'stapler', 'validate', str(self.app)]):
            completed = subprocess.run(argv, capture_output=True, text=True, timeout=45, check=False)
            assessments.append({'command': argv, 'returncode': completed.returncode,
                                'stdout': completed.stdout, 'stderr': completed.stderr})
        write_json(self.raw / 'candidate-assessments.json', assessments)
        signed = all(check['returncode'] == 0 for check in assessments)
        self.event('candidate-assessment', signed_notarized_candidate=signed)
        started = time.monotonic()
        continuous_start = continuous_seconds()
        self.soak_started_continuous = continuous_start
        wall_start = time.time()
        last_sample = continuous_seconds()
        gaps, closed, refreshes = [], [], 0
        next_visit = continuous_start
        next_refresh = continuous_start
        while continuous_seconds() - continuous_start < self.args.duration_seconds:
            now = time.monotonic()
            current = continuous_seconds()
            gaps.append(current - last_sample)
            last_sample = current
            label = f'soak-{len(gaps)}'
            reading = self.memory(label)
            # Visits always finish with a destroyed window and a 10-second settled reading. The initial
            # launch is hidden, so these regular closed samples must count just like the hourly visits.
            closed.append({'label': label, 'mb': reading['mb']})
            self.event('sample', elapsed_seconds=now-started,
                       wall_elapsed_seconds=time.time()-wall_start,
                       continuous_elapsed_seconds=current-continuous_start,
                       data_bytes=sum(p.stat().st_size for p in (self.raw / 'data').glob('*') if p.is_file()),
                       log_bytes=self.log.stat().st_size, cpu_seconds=cpu_seconds([p['pid'] for p in processes(self.pid)]),
                       **reading)
            if current >= next_refresh:
                if refreshes:
                    self.append_soak_usage()
                if refreshes % 6 == 0:
                    self.cloud.offline = True
                    self.event('fixture-offline-start')
                    self.control('--refresh', r'manual refresh finished ok=true .*sync_error=Some')
                    self.cloud.offline = False
                    self.event('fixture-offline-end')
                self.control('--refresh', r'manual refresh finished ok=true .*sync_at=Some.*sync_error=None')
                refreshes += 1
                next_refresh += 3600
            if current >= next_visit:
                for page in ('you', 'leaderboard'):
                    index = len(closed)
                    cycle = self.cycle(index, page)
                    closed.append({'label': f'{page}-{index}-closed-10s', 'mb': cycle['closed_10s']['mb']})
                    if 'closed_followup' in cycle:
                        closed.append({'label': f'{page}-{index}-closed-{self.args.closed_followup_seconds}s',
                                       'mb': cycle['closed_followup']['mb']})
                next_visit += self.args.visit_seconds
            time.sleep(min(self.args.sample_seconds, max(0, self.args.duration_seconds-(continuous_seconds()-continuous_start))))
        final_sample = continuous_seconds()
        gaps.append(final_sample-last_sample)
        self.quit()
        totals = self.verify_fixture()
        manual = []
        manual_path = self.raw / 'manual-events.jsonl'
        if manual_path.exists():
            for line in manual_path.read_text().splitlines():
                event = json.loads(line)
                if not event.get('utc') or not event.get('evidence'):
                    raise RuntimeError('Manual events require utc, event, and evidence fields')
                when = dt.datetime.fromisoformat(event['utc'].replace('Z', '+00:00'))
                if when.tzinfo is None or not wall_start <= when.timestamp() <= time.time():
                    raise RuntimeError('Manual event timestamp is outside this run')
                manual.append(event['event'])
        # This verifies only the synthetic sink. Real hosted approval and upload review remain parent-owned.
        summary = {'elapsed_seconds': final_sample-continuous_start, 'awake_elapsed_seconds': time.monotonic()-started, 'wall_elapsed_seconds': time.time()-wall_start,
                   'artifact_unchanged': bundle_digest(self.app) == self.result['bundle_sha256'],
                   'wake_notifications': self.log.read_text().count('workspace wake received'), 'max_sample_gap_seconds': max(gaps, default=0),
                   'manual_events': manual, 'collection_ok': refreshes >= self.args.duration_seconds // 3600,
                   'sync_ok': self.cloud.summary()['uploads'] >= refreshes and self.cloud.summary()['tokens'] == self.expected_totals()['tokens'],
                   'fixture_cloud': self.cloud.summary(), 'settled_closed_samples': closed,
                   **assess_closed_memory(closed),
                   'graceful_exit': True, 'signed_notarized_candidate': signed,
                   'fixture_totals': totals, 'refreshes': refreshes}
        summary['failures'] = validate_soak(summary, max(86400, self.args.duration_seconds), self.args.max_gap_seconds)
        self.result['soak'] = summary
        self.result['status'] = 'failed' if summary['failures'] else 'complete'
        self.result['budgets_pass'] = not summary['failures']

    def finish(self):
        self.result['run_elapsed_seconds'] = continuous_seconds() - self.started_continuous
        if self.soak_started_continuous is not None:
            self.result['observed_soak_elapsed_seconds'] = continuous_seconds() - self.soak_started_continuous
        if self.keychain_seeded:
            try:
                for suffix in ('-app', '-cli'):
                    (self.raw / 'data' / f'cloud-link.native-test.{self.namespace}{suffix}.json').unlink(missing_ok=True)
                (self.raw / 'credential-clear.txt').write_text('Synthetic credential files deleted.\n')
                self.result['isolated_credential_roundtrip'] = 'pass'
            except Exception as error:
                self.result['status'] = 'incomplete'
                self.result['credential_cleanup_error'] = str(error)
                self.result['budgets_pass'] = False
            self.keychain_seeded = False
        self.cloud.close()
        write_json(self.raw / 'results.json', self.result)
        print(json.dumps(self.result, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['footprint', 'native-soak'])
    parser.add_argument('--app', type=Path, default=ROOT / 'target/release/bundle/macos/Tokentracky.app')
    parser.add_argument('--dmg', type=Path, help='Exact DMG produced with this bundle; no stale newest-file inference')
    parser.add_argument('--cli', type=Path, default=ROOT / 'target/release/tokentracky')
    parser.add_argument('--idle-seconds', type=int, default=600)
    parser.add_argument('--launches', type=int, default=5)
    parser.add_argument('--cycles', type=int, default=3, help='Each cycle visits BOTH Leaderboard and You')
    parser.add_argument('--open-seconds', type=int, default=30)
    parser.add_argument('--closed-followup-seconds', type=int, default=0,
                        help='Optional additional closed reading (>=10s); never replaces the 10s gate')
    parser.add_argument('--duration-seconds', type=int, default=86400)
    parser.add_argument('--sample-seconds', type=int, default=60)
    parser.add_argument('--visit-seconds', type=int, default=3600)
    parser.add_argument('--max-gap-seconds', type=int, default=900,
                        help='Predeclared longest observed gap, including planned manual sleep')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Requires macOS with footprint, top, LaunchServices and an unsigned/signed .app')
    for name in ('idle_seconds', 'launches', 'cycles', 'duration_seconds', 'sample_seconds', 'visit_seconds', 'max_gap_seconds'):
        if getattr(args, name) < 1:
            parser.error(f'{name} must be positive')
    if args.closed_followup_seconds and args.closed_followup_seconds < 10:
        parser.error('closed-followup-seconds must be 0 or >=10')
    if args.open_seconds < 12:
        parser.error('open-seconds must be >=12 for an at-rest sample after 10s')
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt('Run interrupted; incomplete evidence is retained')
    signal.signal(signal.SIGTERM, interrupted)
    runtime = Runtime(args)
    try:
        if args.mode == 'footprint':
            runtime.measure()
        else:
            runtime.soak()
    except BaseException as error:
        runtime.result['status'] = 'incomplete'
        runtime.result['error'] = str(error)
        # Graceful cleanup only. Never silently convert a failed quit into a crash-recovery result.
        if runtime.pid is not None:
            try:
                runtime.quit()
            except Exception as cleanup:
                runtime.result['cleanup_error'] = str(cleanup)
        runtime.finish()
        raise
    runtime.finish()
    return 0 if runtime.result.get('budgets_pass') else 1


if __name__ == '__main__':
    sys.exit(main())
