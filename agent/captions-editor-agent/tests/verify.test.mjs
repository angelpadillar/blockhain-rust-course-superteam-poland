import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMetadata, captionEvidence } from '../src/verify.mjs';
const media=(duration=4,width=1080,height=1920)=>({streams:[{codec_type:'video',width,height,codec_name:'h264',avg_frame_rate:'30/1'},{codec_type:'audio'}],format:{duration:String(duration)}});
test('metadata detects duration, aspect and loss of original resolution',()=>{
  const task={trimStart:2,trimEnd:6};assert.equal(checkMetadata(media(8),media(),task).durationMatches,true);
  assert.equal(checkMetadata(media(8),media(4.5),task).durationMatches,false);
  assert.equal(checkMetadata(media(8),media(4,720,1280),task).preservesDimensions,false);
  assert.equal(checkMetadata(media(8),media(4,1920,1080),task).portrait916,false);
});
test('burned captions do not fabricate a subtitle stream',()=>assert.equal(checkMetadata(media(),media(),{trimStart:0,trimEnd:4}).captionTrackPresent,false));
test('5 fps export cannot hide a 333 ms truncation inside a two-frame tolerance',()=>{
  const output=media(14);output.streams[0].avg_frame_rate='5/1';
  const result=checkMetadata(media(14.333),output,{trimStart:0,trimEnd:14.333});
  assert.equal(result.tolerance,0.1);assert.equal(result.durationMatches,false);
  assert.equal(result.frameRate,5);assert.equal(result.frameRateAcceptable,false);
});
test('matching duration does not make low, missing or invalid frame rates acceptable',()=>{
  for(const rate of ['5/1','0/0','24/0','not-a-rate',undefined]){
    const output=media();output.streams[0].avg_frame_rate=rate;
    const result=checkMetadata(media(),output,{trimStart:0,trimEnd:4});
    assert.equal(result.durationMatches,true);assert.equal(result.frameRateAcceptable,false,String(rate));
    assert.ok(result.tolerance<=0.1);
  }
});
test('standard 23.976, 24 and 30 fps exports preserve the proof frame-rate requirement',()=>{
  for(const rate of ['24000/1001','24/1','30/1']){
    const output=media();output.streams[0].avg_frame_rate=rate;
    assert.equal(checkMetadata(media(),output,{trimStart:0,trimEnd:4}).frameRateAcceptable,true,rate);
  }
});
test('caption check requires newly visible expected words, not pre-existing scene text',()=>{
  const text='Claude finds leads with Buena';assert.equal(captionEvidence(text,text,'').passed,true);
  assert.equal(captionEvidence(text,text,text).passed,false);
  assert.equal(captionEvidence(text,'random lettering','').passed,false);
});
test('missing negation cannot pass expected caption presence',()=>assert.equal(captionEvidence('Claude should not send outreach emails','Claude should send outreach emails','').passed,false));
