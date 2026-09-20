import { saveJson, acquireProfileLock } from '../src/storage.mjs';
import { join } from 'node:path';
const accountLabel=process.argv[2],ownerAuthorized=process.argv.includes('--owner-authorized'),dataDir=process.env.EDITOR_DATA_DIR||'/app/data';
if(!accountLabel||accountLabel.length>100){console.error('Supply the authorized account label after manually verifying login.');process.exit(1);}
const lock=await acquireProfileLock(dataDir,'confirm-test-account');
try{await saveJson(join(dataDir,'test-account.json'),{profileId:'captions-test',testAccountOnly:!ownerAuthorized,...(ownerAuthorized?{accountScope:'owner-authorized'}:{}),accountLabel,confirmedAt:new Date().toISOString(),confirmedBy:'operator'});console.log('Authorized account recorded. This does not assert current login validity; each job observes it again.');}finally{await lock.release();}
