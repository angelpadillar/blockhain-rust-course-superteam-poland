import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
export async function startDisplay({ desktop = false } = {}) {
  process.env.DISPLAY ||= ':99'; const children=[];
  const start=(binary,args)=>{const p=spawn(binary,args,{stdio:'ignore',env:process.env});children.push(p);return p;};
  start('Xvfb',[process.env.DISPLAY,'-screen','0','1440x1000x24','-nolisten','tcp']);
  for(let i=0;i<30;i++){try{await access(`/tmp/.X11-unix/X${process.env.DISPLAY.slice(1)}`);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  start('fluxbox',[]);
  if(desktop){const password=process.env.VNC_PASSWORD_FILE||'/run/secrets/vnc_password';await access(password);
    start('x11vnc',['-display',process.env.DISPLAY,'-localhost','-forever','-shared','-rfbauth',password,'-rfbport','5900']);
    start('websockify',['--web=/usr/share/novnc','6080','127.0.0.1:5900']);}
  return()=>{for(const p of children.reverse())p.kill('SIGTERM');};
}
