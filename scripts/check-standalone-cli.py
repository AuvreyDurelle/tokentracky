#!/usr/bin/env python3
"""Exercise the actual distributed executable with its build-checkout web root unavailable.

No personal logs/credentials, browser, Node, or hosted service are used. Launch tokens stay private.
The source web build is restored even on failure; run after packaging has finished reading it.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
from urllib.parse import urlsplit
import uuid

WINDOWS = os.name == 'nt'


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        reference = attrs.get('src' if tag == 'script' else 'href', '')
        if reference.split('?')[0].endswith(('.js', '.css')):
            self.paths.add(reference)


def check(binary, web_dist):
    binary, web_dist = binary.resolve(), web_dist.resolve()
    assert web_dist.is_dir(), 'build dashboard first'
    expected_html = (web_dist / 'index.html').read_bytes()
    assets = {f'/{path.relative_to(web_dist).as_posix()}': hashlib.sha256(path.read_bytes()).digest()
              for path in web_dist.rglob('*') if path.suffix in ('.js', '.css')}
    references = References()
    references.feed(expected_html.decode())
    assert any(path.endswith('.js') for path in references.paths), 'dashboard has no script'
    assert any(path.endswith('.css') for path in references.paths), 'dashboard has no stylesheet'
    assert references.paths <= assets.keys(), 'HTML references missing/nonlocal assets'
    hidden = web_dist.with_name(f'.standalone-web-{uuid.uuid4().hex}')
    process = None
    try:
        web_dist.rename(hidden)
        with tempfile.TemporaryDirectory(prefix='tokentracky-standalone-', dir=tempfile.gettempdir()) as temporary:
            root = Path(temporary)
            # Only a single raw executable is installed, as in npm's cache or Homebrew's bin directory.
            installed = root / ('bin/tokentracky.exe' if WINDOWS else 'bin/tokentracky')
            installed.parent.mkdir()
            shutil.copy2(binary, installed)
            for directory in ('home', 'data', 'tmp'):
                (root / directory).mkdir(mode=0o700)
            home, temporary_files = str(root / 'home'), str(root / 'tmp')
            env = {
                'PATH': os.defpath, 'HOME': home, 'USERPROFILE': home, 'TMPDIR': temporary_files,
                'TMP': temporary_files, 'TEMP': temporary_files,
                'TOKENTRACKY_HOME': str(root / 'data'), 'TOKENTRACKY_PRICING_REFRESH': 'off',
                'TOKENTRACKY_TEST_KEYCHAIN_NAMESPACE': f'standalone-{uuid.uuid4().hex}',
                'TOKENTRACKY_CLOUD_URL': 'http://127.0.0.1:9',
            }
            # Windows starts no networking without it.
            if WINDOWS:
                env['SYSTEMROOT'] = os.environ['SYSTEMROOT']
            # Do not inherit developer overrides, tool folders, fixture credentials or cloud configuration.
            output = root / 'serve.log'
            with output.open('wb') as log:
                # Windows stops a process with Ctrl-Break, which reaches only a group of its own.
                group = subprocess.CREATE_NEW_PROCESS_GROUP if WINDOWS else 0
                process = subprocess.Popen([str(installed), 'serve', '--port', '0'], cwd=root, env=env,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=group)
                deadline = time.monotonic() + 30
                while True:
                    match = re.search(r'http://127\.0\.0\.1:\d+/\?launch=[A-Za-z0-9_-]+', output.read_text())
                    if match:
                        break
                    assert process.poll() is None, 'installed CLI exited before serving'
                    assert time.monotonic() < deadline, 'installed CLI did not print launch link'
                    time.sleep(0.05)
                url = urlsplit(match.group())

                def request(path, cookie=None, origin=None):
                    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
                    headers = {}
                    if cookie:
                        headers['Cookie'] = cookie
                    if origin:
                        headers['Origin'] = origin
                    try:
                        connection.request('GET', path, headers=headers)
                        response = connection.getresponse()
                        return response.status, dict(response.getheaders()), response.read()
                    finally:
                        connection.close()

                assert request('/api/health')[0] == 401, 'API must require private session'
                launch_path = f'{url.path}?{url.query}'
                status, headers, _ = request(launch_path)
                assert status == 200
                session = headers['set-cookie']
                assert 'HttpOnly' in session and 'SameSite=Strict' in session
                cookie = session.split(';')[0]
                assert request(launch_path)[0] == 401, 'launch link must be single-use'
                status, headers, html = request('/', cookie)
                assert status == 200 and headers['content-type'].startswith('text/html')
                assert html == expected_html, 'installed dashboard differs from built dashboard'
                assert headers['x-content-type-options'] == 'nosniff'
                assert headers['cache-control'] == 'no-store'
                assert "frame-ancestors 'none'" in headers['content-security-policy']
                for path, digest in sorted(assets.items()):
                    status, headers, body = request(path, cookie)
                    assert status == 200, f'asset unavailable: {path}'
                    content_type = headers['content-type'].split(';')[0]
                    allowed = ('text/css',) if path.endswith('.css') else ('text/javascript', 'application/javascript')
                    assert content_type in allowed, f'incorrect MIME for {path}: {content_type}'
                    assert hashlib.sha256(body).digest() == digest, f'asset differs: {path}'
                status, headers, body = request('/you', cookie)
                assert status == 200 and headers['content-type'].startswith('text/html') and body == html, \
                    'SPA route must serve dashboard'
                status, _, body = request('/api/health', cookie)
                assert status == 200 and json.loads(body)['mode'] == 'local'
                assert request('/api/health', cookie, 'https://example.invalid')[0] == 403
                for path in ('/assets/%2e%2e/index.html', '/assets/%2e%2e%5cindex.html'):
                    assert request(path, cookie)[0] == 403, 'asset traversal must be rejected'
                process.send_signal(signal.CTRL_BREAK_EVENT if WINDOWS else signal.SIGTERM)
                assert process.wait(timeout=15) == 0, 'CLI must quit gracefully'
                assert not list((root / 'tmp').glob('tokentracky-web-*')), 'extracted dashboard leaked after quit'
                status = subprocess.run([str(installed), 'status', '--json'], cwd=root, env=env,
                                        capture_output=True, timeout=15, check=True)
                assert json.loads(status.stdout)['running'] is False, 'collector lock was not released'
            print(f'Standalone CLI passed: HTML, {len(assets)} JS/CSS assets, SPA, private session/API, traversal, graceful quit.')
    finally:
        try:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            if hidden.exists():
                hidden.rename(web_dist)


if __name__ == '__main__':
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    # Restore the source directory and stop the child on normal CI cancellation too. Windows has no SIGHUP.
    for shutdown_signal in (signal.SIGTERM,) if WINDOWS else (signal.SIGTERM, signal.SIGHUP):
        signal.signal(shutdown_signal, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--web-dist', type=Path, required=True)
    args = parser.parse_args()
    check(args.binary, args.web_dist)
