#!/usr/bin/env python3
"""External-tool doubles for the Windows and Linux app release orchestration test, never used by a release."""
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
system = os.environ['STUB_SYSTEM']
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'cwd': os.getcwd(), 'target_dir': os.getenv('CARGO_TARGET_DIR'),
                          'updater': os.getenv('TOKENTRACKY_RELEASE_UPDATER')}) + '\n')

if name == 'uname':
    print({'linux': 'Linux', 'windows': 'MINGW64_NT-10.0-20348'}[system])
elif name == 'cygpath':
    print(args[-1])
elif name == 'npm':
    assert args == ['run', 'build', '--workspace=@tokentracky/web']
elif name == 'rustc':
    print('rustc 1.99.0 (stub)')
elif name == 'cargo':
    bundle = Path(os.environ.get('CARGO_TARGET_DIR', '/unused')) / 'release' / 'bundle'
    if args == ['tauri', '--version']:
        print('tauri-cli 2.11.5')
    elif args[:2] == ['tauri', 'build']:
        assert Path.cwd().name == 'mac' and os.getenv('TOKENTRACKY_RELEASE_UPDATER') == '1'
        assert '--no-bundle' in args and '--locked' in args
        config = json.loads(Path(args[args.index('--config') + 1]).read_text())
        assert config['bundle']['createUpdaterArtifacts'] is True and config['plugins']['updater']['pubkey']
    elif args[:2] == ['tauri', 'bundle']:
        bundles = args[args.index('--bundles') + 1]
        assert os.getenv('TAURI_SIGNING_PRIVATE_KEY')
        if os.getenv('STUB_FAIL') == 'key':
            print('Error: The updater secret key does not match the public key')
        if system == 'windows':
            assert bundles == 'nsis'
            (bundle / 'nsis').mkdir(parents=True)
            (bundle / 'nsis' / 'Tokentracky_0.1.0_x64-setup.exe').write_text('installer')
            (bundle / 'nsis' / 'Tokentracky_0.1.0_x64-setup.exe.sig').write_text('installer-signature\n')
        else:
            assert bundles == 'appimage,deb'
            (bundle / 'appimage').mkdir(parents=True)
            (bundle / 'deb').mkdir(parents=True)
            (bundle / 'appimage' / 'Tokentracky_0.1.0_amd64.AppImage').write_text('appimage')
            (bundle / 'appimage' / 'Tokentracky_0.1.0_amd64.AppImage.sig').write_text('appimage-signature\n')
            (bundle / 'deb' / 'Tokentracky_0.1.0_amd64.deb').write_text('deb')
    else:
        raise RuntimeError(args)
elif name in ('smoke-linux', 'pwsh'):
    sys.exit(1 if os.getenv('STUB_FAIL') == 'smoke' else 0)
else:
    raise RuntimeError(name)
