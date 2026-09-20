import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyExport } from '../src/verify.mjs';
const exec=promisify(execFile);
async function bitmap(path) {
  const glyphs={B:['11110','10001','10001','11110','10001','10001','11110'],U:['10001','10001','10001','10001','10001','10001','01110'],E:['11111','10000','10000','11110','10000','10000','11111'],N:['10001','11001','11001','10101','10011','10011','10001'],A:['01110','10001','10001','11111','10001','10001','10001'],F:['11111','10000','10000','11110','10000','10000','10000'],I:['11111','00100','00100','00100','00100','00100','11111'],D:['11110','10001','10001','10001','10001','10001','11110'],S:['01111','10000','10000','01110','00001','00001','11110'],L:['10000','10000','10000','10000','10000','10000','11111']};
  const pixels=Buffer.alloc(720*1280*3);let x=65;
  for(const c of 'BUENA LEADS'){if(c!==' ')for(let r=0;r<7;r++)for(let col=0;col<5;col++)if(glyphs[c][r][col]==='1')for(let dy=0;dy<6;dy++)for(let dx=0;dx<6;dx++){const off=((620+r*6+dy)*720+x+col*6+dx)*3;pixels.fill(255,off,off+3);}x+=36;}
  await writeFile(path,Buffer.concat([Buffer.from('P6\n720 1280\n255\n'),pixels]));
}
test('actual ffmpeg decode and sampled OCR distinguish a fixture caption from clean footage',async(t)=>{
  try{await exec('ffmpeg',['-version']);await exec('tesseract',['--version']);}catch{return t.skip('ffmpeg and Tesseract are required for integration verification');}
  const dir=await mkdtemp(join(tmpdir(),'caption-verifier-'));
  try{
    const source=join(dir,'source.mp4'),output=join(dir,'output.mp4');
    await exec('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=black:s=720x1280:d=1:r=30','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
    await bitmap(join(dir,'caption.ppm'));
    await exec('ffmpeg',['-nostdin','-v','error','-loop','1','-i',join(dir,'caption.ppm'),'-i',source,'-t','0.8','-map','0:v','-map','1:a','-r','30','-pix_fmt','yuv420p','-c:v','libx264','-preset','ultrafast','-c:a','aac',output]);
    const result=await verifyExport({source,output,task:{trimStart:0.1,trimEnd:0.9,expectedCaption:'Buena leads',requireSubtitleTrack:false},directory:join(dir,'evidence')});
    assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.fullDecodePassed,true);assert.equal(result.frameRateAcceptable,true);assert.equal(result.sampledCaptionWordsPresent,true);assert.equal(result.captionTranscriptVerified,false);assert.equal(result.captionTrackPresent,false);assert.match(result.sha256,/^[a-f0-9]{64}$/);
    // Replacing a real editor export with a bare, silent image or unchanged source must not pass metadata/OCR proof.
    assert.equal(result.audioPresent,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
