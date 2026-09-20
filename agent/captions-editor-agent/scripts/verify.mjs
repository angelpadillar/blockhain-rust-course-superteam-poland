import { verifyExport } from '../src/verify.mjs';
const [source,output,expectedCaption,rangeStart='0',rangeEnd='4',directory='/tmp/captions-verification']=process.argv.slice(2);
if(!source||!output||!expectedCaption)throw new Error('usage: verify SOURCE OUTPUT EXPECTED_CAPTION [START END DIRECTORY]');
const result=await verifyExport({source,output,task:{trimStart:Number(rangeStart),trimEnd:Number(rangeEnd),expectedCaption,requireSubtitleTrack:false},directory});
console.log(JSON.stringify(result,null,2));process.exit(result.passed?0:1);
