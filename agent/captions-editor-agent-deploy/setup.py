from pathlib import Path
import os,json,secrets,shutil,hashlib,subprocess
root=Path('/data/captions-editor-agent')
for name in ['state','assets','config','secrets']:
 p=root/name;p.mkdir(parents=True,exist_ok=True);os.chown(p,1000,1000);os.chmod(p,0o700)
config=root/'config/editor.json'
if not config.exists():
 d=json.loads(Path('/opt/captions-editor-agent/config/editor.example.json').read_text())
 src=Path('/data/hypit/workspace/creator/exports/28916d6f-cc75-4be7-8f1b-c7934a723143/clean.mp4')
 if not src.exists():
  src=Path('/data/hypit/workspace/creator/projects/28916d6f-cc75-4be7-8f1b-c7934a723143/clean.mp4')
 if src.exists():
  dst=root/'assets/buena-clean-4s.mp4';shutil.copyfile(src,dst);os.chown(dst,1000,1000)
  d['assets']['buena-clean-4s']={'file':dst.name,'sha256':hashlib.sha256(dst.read_bytes()).hexdigest()}
 config.write_text(json.dumps(d,indent=2)+'\n');os.chown(config,1000,1000);os.chmod(config,0o600)
for name,length in [('service_token',48),('desktop-login.txt',8)]:
 p=root/'secrets'/name
 if not p.exists():
  p.write_text(''.join(secrets.choice('abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(length))+'\n');os.chown(p,1000,1000);os.chmod(p,0o600)
if not (root/'secrets/vnc_password').exists():
 password=(root/'secrets/desktop-login.txt').read_text().strip()
 subprocess.run(['docker','run','--rm','--network','none','--user','1000:1000','--mount','type=bind,src='+str(root/'secrets')+',dst=/secrets','buena-captions-editor-agent:20260918-1','x11vnc','-storepasswd',password,'/secrets/vnc_password'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('Isolated directories, authorized source manifest and private credentials ready.')
