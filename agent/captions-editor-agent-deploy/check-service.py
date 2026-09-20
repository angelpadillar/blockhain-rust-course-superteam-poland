import json,urllib.request,urllib.error,time
from pathlib import Path
base='http://100.121.5.10:8792'
token=Path('/data/captions-editor-agent/secrets/service_token').read_text().strip()
body={'assetId':'buena-clean-20s','trimStart':2,'trimEnd':8,'style':'Velocity','expectedCaption':'Buena AI','requireSubtitleTrack':False}
start=time.monotonic()
req=urllib.request.Request(base+'/v1/jobs',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':'buena-captions-velocity-proof-20260918-1'})
try:
 r=urllib.request.urlopen(req);report={'httpStatus':r.status,'result':json.load(r)}
except urllib.error.HTTPError as e:report={'httpStatus':e.code,'result':json.load(e)}
report['wallSeconds']=round(time.monotonic()-start,3)
Path('/data/captions-editor-agent/state/proof-admission.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
