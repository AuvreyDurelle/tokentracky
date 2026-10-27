#!/usr/bin/env python3
"""External-tool doubles for the release orchestration test, never used by a release."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'cwd': os.getcwd(), 'updater': os.getenv('TOKENTRACKY_RELEASE_UPDATER'),
                          'apple': sorted(key for key in os.environ if key.startswith('APPLE_'))}) + '\n')


def copy(source, destination):
    if Path(source).is_dir():
        shutil.copytree(source, destination, symlinks=True, dirs_exist_ok=True)
    else:
        shutil.copy2(source, destination)


if name == 'uname':
    print('Darwin arm64')
elif name == 'gh':
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    success = {'head_sha': sha, 'event': 'push', 'status': 'completed', 'conclusion': 'success'}
    runs = [success]
    if os.getenv('STUB_FAIL') == 'gate':
        runs = []
    elif os.getenv('STUB_FAIL') == 'gate-pending':
        runs = [{**success, 'status': 'in_progress', 'conclusion': None}, success]
    elif os.getenv('STUB_FAIL') == 'gate-failed':
        runs = [{**success, 'conclusion': 'failure'}, success]
    result = subprocess.run(['jq', '-r', args[args.index('--jq') + 1]], input=json.dumps({'workflow_runs': runs}), text=True, capture_output=True, check=True)
    print(result.stdout.strip())
elif name == 'security':
    if args[0] == 'import':
        assert Path(args[1]).stat().st_mode & 0o077 == 0
        assert Path(args[1]).parent.stat().st_mode & 0o077 == 0
    if os.getenv('STUB_FAIL') == 'restore' and args[:4] == ['list-keychains', '-d', 'user', '-s'] and len(args) == 6:
        sys.exit(1)
    if os.getenv('STUB_FAIL') == 'import' and args[0] == 'import':
        sys.exit(1)
    if args == ['list-keychains', '-d', 'user']:
        print('    "/Users/test/Library/Keychains/login.keychain-db"\n    "/Users/test/custom keychain.keychain-db"')
elif name == 'uuidgen':
    print('test-only-keychain-password')
elif name == 'npm':
    if args[0] == 'ls':
        print('{}')
elif name == 'cargo':
    target = Path(os.environ.get('CARGO_TARGET_DIR', '/unused')) / 'release'
    if args[:2] == ['tauri', 'build']:
        assert Path.cwd().name == 'mac' and os.getenv('TOKENTRACKY_RELEASE_UPDATER') == '1'
        assert '--no-bundle' in args and '--locked' in args
        config = json.loads(Path(args[args.index('--config') + 1]).read_text())
        assert config['plugins']['updater']['pubkey'] == os.environ['TOKENTRACKY_UPDATER_PUBLIC_KEY']
        developer_id = os.environ['TOKENTRACKY_SIGNING'] == 'developer-id'
        assert config['bundle']['macOS'] == {'signingIdentity': os.environ['APPLE_SIGNING_IDENTITY'] if developer_id else '-', 'hardenedRuntime': developer_id}
        target.mkdir(parents=True, exist_ok=True)
        (target / 'tokentracky-mac').write_text('compiled updater-enabled app')
    elif args[:2] == ['tauri', 'bundle']:
        assert Path.cwd().name == 'mac' and (target / 'tokentracky-mac').is_file()
        app = target / 'bundle/macos/Tokentracky.app/Contents/MacOS'
        app.mkdir(parents=True)
        (app / 'tokentracky-mac').write_text('signed app')
        if os.getenv('STUB_FAIL') == 'key-mismatch':
            print('private key does not match the public key')
    elif args[0] == 'build':
        assert args == ['build', '--locked', '--release', '-p', 'tokentracky-cli', '--features', 'embed-web']
        binary = target / 'tokentracky'
        binary.write_text('#!/bin/sh\necho "0.1.0"\n')  # what crates/cli prints for --version
        binary.chmod(0o755)
    elif args[:3] == ['tauri', 'signer', 'sign']:
        assert args[3:5] == ['--app-version', '0.1.0']
        import tarfile
        with tarfile.open(args[-1]) as archive:
            stapled = 'Tokentracky.app/Contents/stapled-ticket' in archive.getnames()
            assert stapled == (os.environ['TOKENTRACKY_SIGNING'] == 'developer-id')
        Path(args[-1] + '.sig').write_text(base64.b64encode(b'untrusted comment: synthetic signature\n').decode())
    elif args[0] == 'metadata':
        print('{}')
    else:
        print('tauri-cli 2.11.5')
elif name == 'codesign':
    if '-dvv' in args:
        print('Authority=' + os.environ['APPLE_SIGNING_IDENTITY'], file=sys.stderr)
    elif '-dv' in args:
        print('Signature=none' if os.getenv('STUB_FAIL') == 'adhoc-signature' else 'Signature=adhoc', file=sys.stderr)
    elif '--sign' in args and not Path(args[-1]).is_dir():
        with open(args[-1], 'a') as signed:
            signed.write('\n# signed\n')
elif name == 'lipo':
    print('arm64')
elif name == 'ditto':
    if args[0] == '-c':
        source, destination = map(Path, args[-2:])
        with zipfile.ZipFile(destination, 'w') as archive:
            if source.is_dir():
                for entry in source.rglob('*'):
                    if entry.is_file():
                        archive.write(entry, str(Path(source.name) / entry.relative_to(source)))
            else:
                archive.write(source, source.name)
    else:
        copy(*args)
elif name == 'xcrun':
    if args[:2] == ['notarytool', 'submit']:
        assert Path(args[2]).is_file()
        print(json.dumps({'id': 'stub-submission-id', 'status': 'Invalid' if os.getenv('STUB_FAIL') == 'notary' else 'Accepted'}))
    elif args[:2] == ['stapler', 'staple']:
        artifact = Path(args[2])
        if artifact.is_dir():
            (artifact / 'Contents/stapled-ticket').write_text('ticket')
    elif args[:2] == ['stapler', 'validate']:
        artifact = Path(args[2])
        assert artifact.is_file() or (artifact / 'Contents/stapled-ticket').is_file()
elif name == 'swift':
    Path(args[-1]).write_bytes(b'PNG synthetic artwork')
elif name == 'hdiutil':
    if args[0] == 'create':
        Path(args[-1]).write_text('writable dmg')
        copy(args[args.index('-srcfolder') + 1], args[-1] + '.contents')
    elif args[0] == 'attach':
        copy(args[-1] + '.contents', args[args.index('-mountpoint') + 1])
    elif args[0] == 'convert':
        Path(args[-1]).write_text('compressed dmg with stapled app')
elif name == 'osascript':
    if os.getenv('STUB_FAIL') == 'finder':
        print('Not authorized to send Apple events to Finder. (-1743)', file=sys.stderr)
        sys.exit(1)
    Path(args[-1], '.DS_Store').write_text('layout')
    print('styled')
elif name == 'minisign':
    if os.getenv('STUB_FAIL') == 'signature':
        sys.exit(1)
    assert Path(args[args.index('-Vm') + 1]).is_file()
elif name in ('spctl', 'xcodebuild', 'rustc'):
    print('stub verification/tool version')
else:
    raise RuntimeError(name)
