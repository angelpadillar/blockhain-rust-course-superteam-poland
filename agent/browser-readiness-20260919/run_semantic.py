"""Repeat the existing adapter selection fixtures with the configured Jev key."""
import os, sys, subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'tools/typesafe-computer-use'))
from typesafe_computer_use.config import load_dotenv
load_dotenv(root / 'tools/typesafe-computer-use/.env')
env = dict(os.environ)
env.pop('TYPESAFE_KEY_FILE', None)
raise SystemExit(subprocess.call([
    '/Users/buena/.nvm/versions/node/v24.14.0/bin/node',
    str(root / 'captions-editor-eval/src/run.mjs'),
    '--live', '--repeats', '3', '--max-requests', '45'
], env=env))
