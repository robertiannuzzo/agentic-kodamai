#!/usr/bin/env python3
"""Small dependency-free source hygiene and trust-boundary checks."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parent.parent
problems = []
paths = [*root.glob('src/**/*.idr'), *root.glob('tests/**/*.idr'),
         *root.glob('scripts/*.py'), *root.glob('docs/**/*.md'), root / 'README.md']
for path in paths:
    if not path.exists():
        continue
    text = path.read_text()
    for n, line in enumerate(text.splitlines(), 1):
        if line.rstrip() != line or '\t' in line:
            problems.append(f'{path.relative_to(root)}:{n}: trailing whitespace or tab')
    if not text.endswith('\n'):
        problems.append(f'{path}: missing final newline')
    if path.suffix == '.idr':
        if re.search(r'\b(believe_me|assert_total|assert_smaller|idris_crash)\b|\?[A-Za-z]', text):
            problems.append(f'{path}: unsafe escape or hole')
        if path.is_relative_to(root / 'src/Recruitment') and '%default total' not in text:
            problems.append(f'{path}: missing totality default')
        if path.is_relative_to(root / 'src/Recruitment/Core') or path == root / 'src/Recruitment/Container.idr':
            for module in re.findall(r'^import (?:public )?(\S+)', text, re.M):
                if not module.startswith(('Recruitment.Core.', 'Data.')):
                    problems.append(f'{path}: forbidden core dependency {module}')
            if re.search(r'\bIO\b|%foreign|%unsafe', text):
                problems.append(f'{path}: effect or unsafe directive in core')
for problem in problems:
    print(problem, file=sys.stderr)
if problems:
    sys.exit(1)
print('PASS source hygiene and pure-core dependency checks')
