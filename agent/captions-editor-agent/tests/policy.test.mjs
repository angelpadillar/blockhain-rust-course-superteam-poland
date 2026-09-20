import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allowedUrl, permittedControl, validateJob, resolveAsset } from '../src/policy.mjs';
const config={assets:{approved:{file:'clip.mp4'}},styles:['Velocity']};
const task={assetId:'approved',trimStart:0,trimEnd:4,style:'Velocity',expectedCaption:'Find leads with Buena'};
test('URL policy rejects credential smuggling, HTTP, foreign subdomains and payment routes',()=>{
  for(const url of ['http://captions.ai/home','https://captions.ai.evil.org/home','https://captions.ai@evil.org/','https://u:p@captions.ai/home','https://captions.ai/billing','https://captions.ai/%70urchase','file:///tmp/x'])assert.equal(allowedUrl(url,['captions.ai'],{navigation:true}),false,url);
  assert.equal(allowedUrl('https://captions.ai/home',['captions.ai'],{navigation:true}),true);
});
test('permitted labels do not permit payment dialogs or destructive controls',()=>{
  const c={visible:true,disabled:false,label:'Export',context:''};assert.equal(permittedControl(c,'export'),true);
  for(const label of ['Publish','Export and share','Purchase','Upgrade','Delete project'])assert.equal(permittedControl({...c,label},'export'),false);
  assert.equal(permittedControl({...c,context:'Upgrade your subscription to export'},'export'),false);
});
test('task contract denies arbitrary paths, account selection, and unknown commands',()=>{
  assert.deepEqual(validateJob(task,config),{...task,requireSubtitleTrack:false});
  for(const patch of [{assetId:'../../private'},{profileId:'real'},{evaluate:'document.cookie'},{trimStart:-1},{trimEnd:61},{style:'Buy premium'},{requireSubtitleTrack:'yes'}])assert.throws(()=>validateJob({...task,...patch},config));
});
test('source manifest rejects symlink escape and changed file bytes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'caption-policy-'));try{
    const root=join(dir,'assets');await mkdir(root);await writeFile(join(dir,'private.mp4'),'private');await symlink(join(dir,'private.mp4'),join(root,'clip.mp4'));
    const c={...config,assetsRoot:root,assets:{approved:{file:'clip.mp4',sha256:createHash('sha256').update('private').digest('hex')}}};
    await assert.rejects(resolveAsset(c,'approved'),{code:'asset_outside_root'});
    await rm(join(root,'clip.mp4'));await writeFile(join(root,'clip.mp4'),'changed');await assert.rejects(resolveAsset(c,'approved'),{code:'asset_hash_mismatch'});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('zero credits evidence cannot match a ten or hundred credit charge',async()=>{
  const {freeEditEvidence}=await import('../src/policy.mjs');
  for(const text of ['10 credits','100 credits','0.5 credits','1 credit','Export for $2.00']){assert.equal(freeEditEvidence(text).included,false,text);assert.equal(freeEditEvidence(text).nonzero,true,text);}
  assert.equal(freeEditEvidence('0 credits').included,true);assert.equal(freeEditEvidence('no credits required').included,true);
});
test('reviewed-host mutations still deny payment query/body intent and unknown endpoints',async()=>{
  const {allowedMutation}=await import('../src/policy.mjs');
  const url='https://api.mirage.app/v1/action',routes=[{host:'api.mirage.app',path:'/v1/action',methods:['POST'],phase:'captions',contentTypes:['application/json']}];
  assert.equal(allowedUrl(url+'?operation=purchase',['api.mirage.app']),false);
  assert.equal(allowedMutation({url,method:'POST',contentType:'application/json',body:'{"operation":"purchase"}'},routes,'captions'),false);
  assert.equal(allowedMutation({url,method:'POST',contentType:'application/json',body:'{"operation":"render"}'},routes,'captions'),true);
  assert.equal(allowedMutation({url,method:'POST',contentType:'application/json',body:'{"operation":"render"}'},routes,'upload'),false);
  assert.equal(allowedMutation({url,method:'DELETE'},routes,'captions'),false);
  assert.equal(allowedMutation({url:url+'/unknown',method:'POST',contentType:'application/json',body:'{}'},routes,'captions'),false);
});

test('reviewed configuration reads permit feature labels without granting write endpoints',async()=>{
  const {allowedMutation,validateConfig}=await import('../src/policy.mjs');
  const url='https://as.captions.ai/v1/initialize';
  const routes=[{host:'as.captions.ai',path:'/v1/initialize',methods:['POST'],phase:'read',contentTypes:['text/plain']}];
  assert.equal(allowedMutation({url,method:'POST',contentType:'text/plain',body:'subscription feature configuration'},routes,'onboarding'),true);
  assert.equal(allowedMutation({url:url+'/purchase',method:'POST',contentType:'text/plain',body:'subscription feature configuration'},routes,'onboarding'),false);
  const c={profileId:'captions-test',testAccountOnly:false,accountScope:'owner-authorized',editorUrl:'https://captions.ai/home',navigationDomains:['captions.ai'],resourceDomains:[],maxActions:20,maxRunMs:60000,maxModelCalls:4,assets:{},styles:['Velocity']};
  assert.equal(validateConfig(c).accountScope,'owner-authorized');
  assert.throws(()=>validateConfig({...c,accountScope:'any-account'}),{code:'authorized_account_required'});
});

test('interactive login permissions do not extend to the autonomous worker',async()=>{
 const {allowedInteractiveAuth}=await import('../src/policy.mjs');
 const config={interactiveAuthDomains:['auth.mirage.app']};
 const request={url:'https://auth.mirage.app/sign-in',method:'POST'};
 assert.equal(allowedInteractiveAuth(request,config,true),true);
 assert.equal(allowedInteractiveAuth(request,config,false),false);
 assert.equal(allowedInteractiveAuth({...request,url:'https://auth.mirage.app/checkout'},config,true),false);
 assert.equal(allowedInteractiveAuth({...request,method:'DELETE'},config,true),false);
 assert.equal(allowedInteractiveAuth({...request,url:'https://elsewhere.test/sign-in'},config,true),false);
});
