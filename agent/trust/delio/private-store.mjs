import {mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
const fail=code=>{throw new Error(code);};
export function readPrivateJson(file,fallback){try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;fail('private_store_invalid');}}
export function writePrivateJson(file,value){
  writeFileSync(file+'.next',JSON.stringify(value),{mode:0o600,flush:true});
  renameSync(file+'.next',file);
  const fd=openSync(join(file,'..'),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
/** Caller holds a process lock for this directory. No public read method. */
export function createPrivateContactVault({dir,customerId}){
  if(typeof customerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(customerId)||['__proto__','constructor','prototype'].includes(customerId))fail('invalid_vault_owner');
  mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'contacts.json');
  let state=readPrivateJson(file,{customerId,secrets:{}}),poisoned=false;
  if(state.customerId!==customerId||!state.secrets||typeof state.secrets!=='object')fail('vault_owner_mismatch');
  const allowed=new Set(['activationEmail','activationPhone','activationOtp','notificationEmail','notificationPhone']);
  const check=(owner,kind)=>{if(poisoned)fail('private_vault_persistence_failed');if(owner!==customerId||!allowed.has(kind))fail('private_contact_not_owned');};
  return Object.freeze({
    async put(owner,kind,value){check(owner,kind);if(typeof value!=='string'||!value||value.length>254)fail('invalid_private_contact');const next={customerId,secrets:{...state.secrets,[kind]:value}};try{writePrivateJson(file,next);}catch{poisoned=true;fail('private_vault_persistence_failed');}state=next;},
    async withSecret(owner,kind,consumer){check(owner,kind);if(typeof consumer!=='function'||typeof state.secrets[kind]!=='string')fail('private_contact_unavailable');await consumer(state.secrets[kind]);},
  });
}
