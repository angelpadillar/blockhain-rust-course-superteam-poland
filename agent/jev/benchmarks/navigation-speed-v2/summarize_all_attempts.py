#!/usr/bin/env python3
"""Combine every retained public cohort from this candidate experiment."""
import json
from pathlib import Path
from analyze_comparison import summarize_arm

base = Path(__file__).resolve().parent
cohorts = [('v1', '../navigation-speed-v1/results/comparison.json'),
           ('v2_outage', 'results/availability-stopped-batch.json'),
           ('v2_retry', 'results/comparison.json')]
rows = []
groups = {'baseline': [], 'candidate_v1': [], 'candidate_v2': []}
for name, file in cohorts:
    attempts = json.loads((base / file).read_text())['attempts']
    rows.extend(attempts)
    for row in attempts:
        group = 'baseline' if row['arm'] == 'baseline' else 'candidate_v1' if name == 'v1' else 'candidate_v2'
        groups[group].append(row)
report = {
    'scope': 'All eight benchmark attempts from the v1 cohort, the first v2 availability stop and the v2 retry; independent read-only diagnostic excluded from task attempts and made no model calls.',
    'groups': {name: summarize_arm(attempts) for name, attempts in groups.items()},
    'allAttempts': summarize_arm(rows),
}
(base / 'results/all-attempts.json').write_text(json.dumps(report, indent=2) + '\n')
print('Combined retained public cohorts; no private data or live calls.')
