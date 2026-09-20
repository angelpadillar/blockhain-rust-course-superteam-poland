"""Offline source checks: synthetic pixels and stop states; no desktop/API access."""
import json
import argparse
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=Path, default=root / 'research/typesafe-computer-use')
args = parser.parse_args()
revision = subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', 'HEAD'], text=True).strip()
if revision != 'ccde756a3145cd177e6a7396ddbab48286afaf75':
    raise SystemExit('Use the pinned computer-use revision recorded in REPORT.md.')
sys.path.insert(0, str(args.repo.resolve()))

from PIL import Image

from typesafe_computer_use.config import DEFAULT_DELAY
from typesafe_computer_use.perception import changed_tiles, thumbnail, tiles_in
from typesafe_computer_use.runner import RunState, resolve

before = Image.new('RGB', (256, 256), 'black')
after = before.copy()
after.paste('white', (64, 64, 96, 96))
changes = changed_tiles(thumbnail(after), thumbnail(before), tiles_in((0, 0, 256, 256)))
state = RunState()
lines = []
continues = resolve(None, None, state, None, [],
                   SimpleNamespace(stops=True, kind=SimpleNamespace(choice='none')),
                   {}, lines.append)
result = {
    'sourceCommit': revision,
    'scope': 'Synthetic offline checks. No API requests, screenshots, desktop input or hook installation.',
    'smallScreenChange': {
        'imagePixels': [256, 256], 'changedPatchPixels': [32, 32],
        'blackToWhite': True, 'changedTilesReported': len(changes),
        'interpretation': 'This concrete small change is missed by the tile mean threshold; not an OCR accuracy benchmark.',
    },
    'noneStop': {
        'keepsGoing': continues, 'outcomeLabel': state.outcome,
        'interpretation': 'A none decision leaves the default completed label. Independent verification is required for completion metrics.',
    },
    'configuredInterStepDelaySeconds': DEFAULT_DELAY,
}
out = Path(__file__).parent / 'results'
out.mkdir(exist_ok=True)
(out / 'computer-use-source-checks.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
