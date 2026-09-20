"""Promote the verified VPS browser candidate with a stopped-profile backup."""
import json, pathlib, shutil, subprocess, time
deployment=pathlib.Path('/opt/captions-editor-camoufox')
stage=pathlib.Path('/opt/captions-editor-bench/20260919-readiness')
backup=stage/'rollback'; backup.mkdir(mode=0o700,exist_ok=False)
container='captions-editor-camoufox-onboarding-1'
release='buena-captions-editor-camoufox:0.1.29-9'
def run(args, **kw): return subprocess.run(args,check=True,capture_output=True,text=True,**kw)
proof=json.loads(pathlib.Path('/data/captions-editor-bench/20260919-readiness/results.json').read_text())
assert len(proof)==18 and sum(x['ready'] and x['report']['status']=='passed' for x in proof)==9, 'Incomplete candidate proof'
run(['docker','image','inspect',release])
for file in pathlib.Path('/data/captions-editor-camoufox/state/automation').glob('*.json'):
    state=json.loads(file.read_text())
    assert not any(r.get('outcome')=='running' for r in state.get('receipts',{}).values()), 'An action is running'
old_image=run(['docker','inspect',container,'--format','{{.Config.Image}}']).stdout.strip()
compose=deployment/'compose.yml'; old_compose=compose.read_text()
shutil.copy2(compose,backup/'compose.yml')
files=['src/automation.mjs','src/observe-server.mjs','scripts/selftest.mjs']
for file in files:
    dest=backup/file;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(deployment/file,dest)
helper=pathlib.Path('/opt/buena-video-workflow/advance-editor.mjs')
assert helper.is_file() and (stage/'advance-editor.mjs').is_file(), 'Missing workflow helper'
shutil.copy2(helper,backup/'advance-editor.mjs')
base=['docker','compose','-f',str(compose),'--profile','onboarding']
started=time.monotonic(); stopped=False
try:
    run(base+['stop','onboarding'],timeout=60);stopped=True
    shutil.copytree('/data/captions-editor-camoufox/state',backup/'state',symlinks=True)
    for file in files: shutil.copy2(stage/file,deployment/file)
    new_compose=old_compose.replace('buena-captions-editor-camoufox:0.1.29-8',release)
    assert new_compose!=old_compose, 'Unexpected compose image'
    compose.write_text(new_compose)
    run(base+['up','-d','--no-build','--no-deps','onboarding'],timeout=60)
    health=None
    for attempt in range(45):
        try:
            result=run(['docker','exec',container,'node','scripts/observe.mjs','status'],timeout=8)
            health=json.loads(result.stdout)
            if health.get('healthy') and health.get('status')=='ready_for_observation':break
        except Exception:pass
        time.sleep(2)
    assert health and health.get('healthy') and health.get('status')=='ready_for_observation', 'Candidate did not finish browser startup'
    # No action is authorized or dispatched: use an unknown job to prove routing.
    script="""import {readFile} from 'node:fs/promises';
const token=(await readFile('/run/secrets/service_token','utf8')).trim();
const r=await fetch('http://127.0.0.1:8793/select-ready',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jobId:'readiness-route-probe',waitMs:0})});
const d=await r.json();console.log(JSON.stringify({status:r.status,error:d.error}));
if(r.status!==409 || d.error!=='unknown_job') process.exit(1);"""
    route=json.loads(run(['docker','exec','-i',container,'node','--input-type=module'],input=script,timeout=15).stdout)
    shutil.copy2(stage/'advance-editor.mjs',helper)
    report={'status':'deployed','oldImage':old_image,'newImage':release,'health':health,'routeProbe':route,'rollback':str(backup),'seconds':time.monotonic()-started,'workflowHelperUpdated':True}
except Exception as exc:
    if stopped:
        rollback_compose=old_compose.replace('buena-captions-editor-camoufox:0.1.29-8',old_image)
        compose.write_text(rollback_compose)
        for file in files:shutil.copy2(backup/file,deployment/file)
        shutil.copy2(backup/'advance-editor.mjs',helper)
        run(base+['up','-d','--no-build','--no-deps','onboarding'],timeout=60)
    report={'status':'rolled_back','error':type(exc).__name__,'oldImage':old_image,'rollback':str(backup)}
    (stage/'deployment.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report));raise
(stage/'deployment.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
