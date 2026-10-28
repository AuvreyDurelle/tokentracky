#!/usr/bin/env python3
"""External-tool doubles for the CLI release orchestration test, never used by a release."""
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['STUB_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'target_dir': os.getenv('CARGO_TARGET_DIR')}) + '\n')

if name == 'npm':
    assert args == ['run', 'build', '--workspace=@tokentracky/web']
elif name == 'cargo':
    if args[0] == 'build':
        target = args[args.index('--target') + 1]
        assert args == ['build', '--locked', '--release', '-p', 'tokentracky-cli', '--features', 'embed-web',
                        '--target', target]
        release = Path(os.environ['CARGO_TARGET_DIR']) / target / 'release'
        release.mkdir(parents=True)
        binary = release / ('tokentracky.exe' if 'windows' in target else 'tokentracky')
        version = '0.0.9' if os.getenv('STUB_FAIL') == 'version' else '0.1.0'
        # What crates/cli prints for --version, and the import a dynamically linked Windows C runtime adds.
        runtime = '# VCRUNTIME140.dll\n' if os.getenv('STUB_FAIL') == 'dynamic-crt' else ''
        binary.write_text(f'#!/bin/sh\necho "{version}"\n{runtime}')
        binary.chmod(0o755)
    elif args[0] == 'metadata':
        print('{}')
    else:
        raise RuntimeError(args)
elif name == 'file':
    linked = 'dynamically linked' if os.getenv('STUB_FAIL') == 'dynamic' else 'static-pie linked'
    print(f'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), {linked}, stripped')
elif name == 'rustc':
    print('rustc 1.99.0 (stub)')
else:
    raise RuntimeError(name)
