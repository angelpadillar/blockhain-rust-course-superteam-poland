"""Run on VPS: isolated, network-disabled browser proofs using the deployed image."""
import json, subprocess, time, pathlib, os, statistics
root = pathlib.Path('/data/captions-editor-bench/20260919-baseline')
root.mkdir(parents=True, exist_ok=True)
image = subprocess.check_output(['docker','inspect','captions-editor-camoufox-onboarding-1','--format','{{.Image}}'],text=True).strip()
rows=[]
for i in range(3):
    work=root/f'run-{i+1}'
    work.mkdir(exist_ok=True)
    os.chown(work,1001,1001)
    start=time.monotonic()
    cmd=['docker','run','--rm','--network','none','--user','1001:1001','--cpus','2','--memory','4g','--pids-limit','512','--shm-size','1g','--security-opt','no-new-privileges:true','--security-opt','seccomp=/opt/captions-editor-camoufox/config/browser-seccomp.json','--mount',f'type=bind,src={work},dst=/app/state',image,'scripts/selftest.mjs']
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=120)
    (root/f'run-{i+1}.stdout').write_text(result.stdout)
    (root/f'run-{i+1}.stderr').write_text(result.stderr)
    try: report=json.loads(result.stdout)
    except ValueError: report={'status':'failed','blocker':'No structured report'}
    row={'run':i+1,'exitCode':result.returncode,'containerWallSeconds':time.monotonic()-start,'report':report}
    rows.append(row)
    (root/'results.json').write_text(json.dumps({'image':image,'runs':rows},indent=2)+'\n')
    print(json.dumps({'run':i+1,'status':report.get('status'),'checks':len(report.get('checks',{})),'wallSeconds':report.get('wallTimeSeconds'),'blocker':report.get('blocker')}),flush=True)
print(json.dumps({'completed':len(rows),'passed':sum(r['report'].get('status')=='passed' for r in rows),'medianContainerWallSeconds':statistics.median(r['containerWallSeconds'] for r in rows),'results':str(root/'results.json')}))
