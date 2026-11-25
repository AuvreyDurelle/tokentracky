#!/usr/bin/env python3
"""External-tool doubles for the Windows and Linux app release orchestration test, never used by a release."""
import base64
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
fail = os.getenv('STUB_FAIL')
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'cwd': os.getcwd(), 'target_dir': os.getenv('CARGO_TARGET_DIR'),
                          'updater': os.getenv('TOKENTRACKY_RELEASE_UPDATER')}) + '\n')

if name == 'npm':
    assert args == ['run', 'build', '--workspace=@tokentracky/web']
elif name == 'cargo':
    if args[:2] == ['tauri', 'build']:
        assert Path.cwd().name == 'mac' and os.getenv('TOKENTRACKY_RELEASE_UPDATER') == '1'
        target = args[args.index('--target') + 1]
        assert args[-2:] == ['--', '--locked']
        config = json.loads(Path(args[args.index('--config') + 1]).read_text())
        assert config['bundle']['createUpdaterArtifacts'] is True
        assert config['plugins']['updater']['pubkey'] == os.environ['TOKENTRACKY_UPDATER_PUBLIC_KEY']
        bundle = Path(os.environ['CARGO_TARGET_DIR']) / target / 'release/bundle'
        # The names Tauri gives each bundle: {productName}_{version}_{arch}.
        if 'windows' in target:
            files = ['nsis/Tokentracky_0.1.0_x64-setup.exe']
        else:
            files = ['appimage/Tokentracky_0.1.0_amd64.AppImage', 'deb/Tokentracky_0.1.0_amd64.deb']
        if fail == 'missing-bundle':
            files = files[1:]
        for file in files:
            (bundle / file).parent.mkdir(parents=True, exist_ok=True)
            (bundle / file).write_text(f'{file} built with the updater')
        if fail == 'key-mismatch':
            print('private key does not match the public key')
    elif args[:3] == ['tauri', 'signer', 'sign']:
        assert args[3:5] == ['--app-version', '0.1.0']
        assert Path(args[-1]).is_file()
        Path(args[-1] + '.sig').write_text(base64.b64encode(b'untrusted comment: synthetic signature\n').decode())
    elif args == ['tauri', '--version']:
        print('tauri-cli 2.11.4' if fail == 'tauri-version' else 'tauri-cli 2.11.5')
    else:
        raise RuntimeError(args)
elif name == 'minisign':
    if fail == 'signature':
        print('Signature verification failed', file=sys.stderr)
        sys.exit(1)
    assert Path(args[args.index('-Vm') + 1]).is_file()
    assert Path(args[args.index('-p') + 1]).read_bytes().startswith(b'untrusted comment: minisign public key')
    version = '0.0.9' if fail == 'signed-version' else '0.1.0'
    print(f'Signature and comment signature verified\nTrusted comment: timestamp:0\tfile:{Path(args[1]).name}\tversion:{version}')
elif name == 'rustc':
    print('rustc 1.99.0 (stub)')
else:
    raise RuntimeError(name)
