"""Isolated Comet/Jev A/B probe. Local fixture actions only; no account changes."""
import json, sys, time, statistics
from pathlib import Path
from dataclasses import replace

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'typesafe-computer-use'))
from typesafe_computer_use import config, macos
from typesafe_computer_use.perception import capture, perceive, ax_nodes, to_ax_items, merge_with_origins
from typesafe_computer_use.decide import decide
from typesafe_computer_use.actions import Context, perform, click_item
from typesafe_sdk import TypeSafeClient

config.load_dotenv(ROOT.parent / 'typesafe-computer-use' / '.env')
GUARDED = '--guarded' in sys.argv
PREFIX = 'guarded' if GUARDED else 'live'
CASES = [
    ('plain', 'Preview clip', ['View transcript', 'Preview clip', 'Choose style'], ''),
    ('reordered', 'Choose style', ['Preview clip', 'View transcript', 'Choose style'], 'display:flex;flex-direction:row-reverse'),
    ('similar', 'Preview edited clip', ['Preview original clip', 'Preview edited clip', 'Preview thumbnail'], ''),
    ('canvas', 'Preview clip', ['View transcript', 'Preview clip', 'Choose style'], ''),
]
rows = []
for name, target, labels, style in CASES:
    controls = ''.join(f'<button onclick="location.hash=\'choice-{i}\'">{label}</button>' for i, label in enumerate(labels))
    if name == 'canvas':
        controls = '<canvas width="900" height="120" id="controls"></canvas>'
    script = '' if name != 'canvas' else '''const canvas=document.getElementById('controls');const ctx=canvas.getContext('2d');
const labels=['View transcript','Preview clip','Choose style'];labels.forEach((s,i)=>{ctx.fillStyle='#285a90';ctx.fillRect(i*300+5,10,280,90);ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText(s,i*300+22,63)});
canvas.onclick=e=>{const r=canvas.getBoundingClientRect();location.hash='choice-'+Math.floor((e.clientX-r.left)*900/r.width/300)};'''
    (ROOT / f'{name}.html').write_text(f'<!doctype html><meta charset="utf-8"><title>Browser readiness fixture</title><style>body{{font:24px sans-serif;margin:60px;background:#eff4f8;color:#102033}}button{{font:24px sans-serif;margin:12px;padding:25px}}canvas{{max-width:100%}}</style><h1>Local editor control test</h1><p>Choose one preview action.</p><div style="{style}">{controls}</div><script>{script}</script>')

with TypeSafeClient() as client:
    for repeat in range(2):
        for name, target, labels, _ in CASES:
            for mode in (['full', 'ax_first'] if repeat == 0 else ['ax_first', 'full']):
                row = dict(case=name, repeat=repeat, mode=mode, passed=False, performedActions=0)
                start = time.monotonic()
                try:
                    assert macos.accessibility_trusted(), 'Accessibility unavailable'
                    url = (ROOT / f'{name}.html').as_uri() + f'?trial={repeat}-{mode}'
                    assert macos.open_url('Comet', url), 'Could not open local fixture'
                    assert macos.activate('Comet'), 'Could not activate Comet'
                    time.sleep(0.4)
                    assert macos.browser_url('Comet') == url, 'Wrong page'
                    timing = {}
                    screen = capture(browser='Comet', timing=timing)
                    goal = f'Click the button labeled {target} on this local editor test page.'
                    pstart = time.monotonic()
                    if mode == 'ax_first':
                        nodes, hidden = ax_nodes(screen, 255)
                        merged = merge_with_origins([], to_ax_items(nodes, screen.scale), 255)
                        screen.ax_refs.update({it.index:nodes[origin].ref for it, origin in merged if origin is not None and nodes[origin].ref})
                        items = [it for it, origin in merged]
                        row['visualFallback'] = not any(it.text.strip() == target for it in items)
                        if row['visualFallback']:
                            items = perceive(screen, 255, goal, timing)
                    else:
                        items = perceive(screen, 255, goal, timing)
                        row['visualFallback'] = True
                    row['reobservations'] = 0
                    if GUARDED:
                        deadline = time.monotonic() + 3
                        while not any(it.text.strip() == target for it in items) and time.monotonic() < deadline:
                            assert macos.frontmost_app() == 'Comet' and macos.browser_url('Comet') == url, 'Context changed during readiness wait'
                            time.sleep(0.15)
                            screen = capture(browser='Comet', timing=timing)
                            items = perceive(screen, 255, goal, timing)
                            row['reobservations'] += 1
                    row['perceptionSeconds'] = time.monotonic() - pstart
                    # Send only fixture controls, never unrelated tabs or account details.
                    items = [it for it in items if it.text.strip() in labels]
                    screen = replace(screen, field=None, offscreen=[])
                    row['candidateCount'] = len(items)
                    assert any(it.text.strip() == target for it in items), 'Target absent from perception'
                    ds = time.monotonic()
                    d = decide(client, goal, screen, items, [], 'Comet', None)
                    row['decisionSeconds'] = time.monotonic() - ds
                    row['confidence'] = d.confidence
                    selected = next((it for it in items if str(it.index) == d.chosen), None)
                    row['selected'] = selected.text if selected else None
                    assert d.clicking and selected and selected.text.strip() in labels, 'Invalid fixture action'
                    assert d.confidence >= 0.6, 'Low confidence; abstained'
                    assert macos.frontmost_app() == 'Comet' and macos.browser_url('Comet') == url, 'Focus or page changed'
                    if GUARDED:
                        # Rebind only a unique, freshly observed control with the selected label.
                        fresh_screen = capture(browser='Comet')
                        fresh_items = perceive(fresh_screen, 255, goal)
                        matches = [it for it in fresh_items if it.text.strip() == selected.text.strip()]
                        assert len(matches) == 1, 'Selected control became missing or ambiguous'
                        assert macos.frontmost_app() == 'Comet' and macos.browser_url('Comet') == url, 'Context changed before click'
                        row['action'] = click_item(matches[0], fresh_screen)
                    else:
                        row['action'] = perform(d, screen, items, Context(goal=goal, browser='Comet', email=None, typesafe=client, writer=None, history=[]))
                    row['performedActions'] = 1
                    time.sleep(0.2)
                    expected_url = url + f'#choice-{labels.index(target)}'
                    actual_url = macos.browser_url('Comet')
                    if GUARDED:
                        deadline = time.monotonic() + 2
                        while actual_url == url and time.monotonic() < deadline:
                            time.sleep(0.1)
                            actual_url = macos.browser_url('Comet')
                    row['observedFragment'] = actual_url.split('#', 1)[1] if actual_url and '#' in actual_url else None
                    row['passed'] = actual_url == expected_url
                except Exception as exc:
                    row['errorType'] = type(exc).__name__
                    row['error'] = str(exc)[:300]
                row['wallSeconds'] = time.monotonic() - start
                rows.append(row)
                (ROOT / f'{PREFIX}-results.json').write_text(json.dumps(rows, indent=2) + '\n')
                print(json.dumps(row), flush=True)
                if row.get('error') == 'Accessibility unavailable':
                    sys.exit(2)

summary = {}
for mode in ['full', 'ax_first']:
    group = [r for r in rows if r['mode'] == mode]
    summary[mode] = dict(passed=sum(r['passed'] for r in group), attempted=len(group),
        medianWallSeconds=statistics.median(r['wallSeconds'] for r in group),
        medianPerceptionSeconds=statistics.median(r.get('perceptionSeconds', 0) for r in group),
        modelCalls=sum('decisionSeconds' in r for r in group),
        visualPasses=sum(r.get('visualFallback', False) for r in group))
(ROOT / f'{PREFIX}-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
