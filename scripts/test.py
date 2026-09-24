#!/usr/bin/env python3
"""Fail-closed compiler fixtures, runtime tests, and CLI smoke test."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
COMPILER = str(ROOT / 'scripts/idris')
BUILD = ROOT / 'build/verification'
STAGE = BUILD / 'src'
LOGS = BUILD / 'logs'


def run(args, *, expect=0):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, timeout=120)
    if result.returncode != expect:
        print(result.stdout + result.stderr, file=sys.stderr)
        raise RuntimeError(f'Command failed ({result.returncode}): {args}')
    return result.stdout + result.stderr


def compiler_args():
    return [COMPILER, '--no-color', '--total', '-Werror', '--source-dir', STAGE,
            '--build-dir', BUILD / 'compiler', '--output-dir', BUILD / 'bin']


def main():
    version = run([COMPILER, '--version']).strip()
    expected = dict(line.split('=', 1) for line in (ROOT / 'toolchain.env').read_text().splitlines())['IDRIS2_VERSION']
    if version != 'Idris 2, version ' + expected:
        raise RuntimeError(f'Expected Idris {expected}; got {version}. See README toolchain instructions.')
    print(version, flush=True)
    print(run([sys.executable, 'scripts/lint.py']), end='', flush=True)
    for entrypoint in ['scripts/idris', 'scripts/bootstrap-idris']:
        run(['sh', '-n', entrypoint])
    print(run([COMPILER, '--typecheck', 'recruitment.ipkg']), end='', flush=True)
    if BUILD.exists():
        shutil.rmtree(BUILD)
    STAGE.mkdir(parents=True)
    LOGS.mkdir()
    shutil.copytree(ROOT / 'src/Recruitment', STAGE / 'Recruitment')
    manifest = json.loads((ROOT / 'tests/compile-fail/manifest.json').read_text())
    fixtures = {p.name for p in (ROOT / 'tests/compile-fail').glob('*.idr')}
    if fixtures != set(manifest):
        raise RuntimeError('Every negative fixture must have diagnostic expectations')
    for fixture in sorted((ROOT / 'tests/compile-pass').glob('*.idr')):
        dest = STAGE / fixture.name
        shutil.copy2(fixture, dest)
        output = run(compiler_args() + ['--check', dest])
        (LOGS / (fixture.stem + '.log')).write_text(output)
        print(f'PASS compiles: {fixture.name}', flush=True)
    for name, expectations in manifest.items():
        dest = STAGE / name
        shutil.copy2(ROOT / 'tests/compile-fail' / name, dest)
        result = subprocess.run([str(arg) for arg in compiler_args() + ['--check', dest]],
                                capture_output=True, text=True, timeout=60)
        output = result.stdout + result.stderr
        (LOGS / (dest.stem + '.log')).write_text(output)
        if result.returncode != 1 or not all(fragment in output for fragment in expectations):
            raise RuntimeError(f'Wrong diagnostic or unexpected compilation for {name}:\n{output}')
        if 'Error: Module' in output or 'Undefined name' in output or 'Unsolved holes' in output:
            raise RuntimeError(f'Fixture has unrelated errors: {name}\n{output}')
        print(f'PASS expected rejection: {name}', flush=True)
    for source in (ROOT / 'tests').glob('*.idr'):
        shutil.copy2(source, STAGE / source.name)
    print(run(compiler_args() + ['-o', 'recruitment-tests', STAGE / 'Tests.idr']), end='')
    output = run([BUILD / 'bin/recruitment-tests'])
    (LOGS / 'runtime.log').write_text(output)
    print(output.splitlines()[-1], flush=True)
    print(run([COMPILER, '--build', 'demo.ipkg']), end='')
    output = run([ROOT / 'build/exec/recruitment-demo'])
    if ('Total: 46' not in output or 'Audit: advert:1;application:1;policy:recruitment-score-v1' not in output
            or 'Review: application:1;total:46;disposition:shortlist' not in output
            or 'Hired: Ada Candidate from advert 1, application 1' not in output):
        raise RuntimeError(f'Unexpected demo output:\n{output}')
    print('PASS CLI build/start smoke test', flush=True)
    print(f'PASS all checks; logs: {LOGS.relative_to(ROOT)}')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        print(f'FAIL {error}', file=sys.stderr)
        sys.exit(1)
