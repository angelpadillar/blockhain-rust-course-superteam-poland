"""VPS-only comparison; isolated containers, no network or credentials."""
import json, subprocess, time, pathlib, os
root=pathlib.Path('/data/captions-editor-bench/20260919-readiness')
root.mkdir(parents=True,exist_ok=True)
rows=[]
for repeat in range(3):
    for delay in [0,800,1800]:
        for ready in ([False,True] if repeat%2 == 0 else [True,False]):
            label=f'r{repeat+1}-delay{delay}-ready{int(ready)}'
            work=root/label;work.mkdir(exist_ok=True);os.chown(work,1001,1001)
            started=time.monotonic()
            cmd=['docker','run','--rm','--network','none','--user','1001:1001','--cpus','2','--memory','4g','--pids-limit','512','--shm-size','1g','--security-opt','no-new-privileges:true','--security-opt','seccomp=/opt/captions-editor-camoufox/config/browser-seccomp.json','--mount',f'type=bind,src={work},dst=/app/state','-e',f'FIXTURE_CONTROL_DELAY_MS={delay}','-e',f'FIXTURE_READY_SELECTION={int(ready)}','buena-captions-editor-camoufox:readiness-20260919','scripts/selftest.mjs']
            proc=subprocess.run(cmd,capture_output=True,text=True,timeout=120)
            (root/f'{label}.stdout').write_text(proc.stdout);(root/f'{label}.stderr').write_text(proc.stderr)
            try: report=json.loads(proc.stdout)
            except ValueError: report={'status':'failed','blocker':'No structured report'}
            row={'repeat':repeat+1,'delayMs':delay,'ready':ready,'exitCode':proc.returncode,'containerWallSeconds':time.monotonic()-started,'report':report}
            rows.append(row);(root/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
            print(json.dumps({'case':label,'status':report.get('status'),'checks':len(report.get('checks',{})),'seconds':report.get('wallTimeSeconds'),'blocker':report.get('blocker')}),flush=True)
