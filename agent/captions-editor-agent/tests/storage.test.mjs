import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProfileLock, loadJobs, transition } from '../src/storage.mjs';
test('manual onboarding and worker cannot concurrently own the same persistent profile',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'caption-lock-'));try{
    const owner=await acquireProfileLock(dir,'onboarding');await assert.rejects(acquireProfileLock(dir,'worker'),{code:'profile_in_use_or_stale_lock'});
    await owner.release();const next=await acquireProfileLock(dir,'worker');assert.notEqual(next.version,owner.version);await next.release();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('restart checkpoints jobs for attention rather than replaying uncertain UI effects',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'caption-job-'));try{
    const {save}=await loadJobs(dir),id=randomUUID();await save({id,status:'running',stage:'export',request:{assetId:'approved'}});
    const {jobs}=await loadJobs(dir);assert.equal(jobs.get(id).status,'needs_attention');assert.equal(jobs.get(id).reason,'server_restarted_no_replay');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('terminal jobs cannot be restarted or relabelled complete',()=>{
  for(const state of ['complete','cancelled','needs_attention'])for(const next of ['running','complete'])assert.throws(()=>transition({status:state},next),{code:'invalid_job_transition'});
});
