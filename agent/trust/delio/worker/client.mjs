import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validateRequest,blocked,WorkerError} from './policy.mjs';

export async function runClient(input, {readToken=()=>readFile('/run/secrets/delio-service-token','utf8'),fetchImpl=fetch}={}) {
  let startedRequest=false;
  try {
    if(typeof input!=='string'||Buffer.byteLength(input)>16384)throw new WorkerError('invalid_request');
    const request=validateRequest(JSON.parse(input));
    const token=(await readToken()).trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw new WorkerError('worker_unavailable');
    startedRequest=true;
    const result=await fetchImpl('http://127.0.0.1:8794/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(29500)});
    const response=await result.json();
    if(!response||typeof response!=='object'||Array.isArray(response)||typeof response.ok!=='boolean')throw new Error('invalid_worker_response');
    // A valid known blocker is application data, not an SSH/transport failure.
    return {response,exitCode:0};
  }catch(error){
    if(!startedRequest){
      const code=error instanceof SyntaxError||error instanceof WorkerError&&error.code==='invalid_request'?'invalid_request':'worker_unavailable';
      return {response:blocked(code,'The client stopped before sending any worker operation.'),exitCode:1};
    }
    // Once sent, lack of a usable reply cannot establish whether an operation
    // reached the worker. Do not attach a false no-dispatch assertion.
    return {response:{ok:false,code:'worker_transport_uncertain',blockers:[{code:'worker_transport_uncertain',message:'No verified worker reply was received. Operation outcome must be reconciled before retrying.'}]},exitCode:1};
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  let input='';
  for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>16384)break;}
  const {response,exitCode}=await runClient(input);
  process.stdout.write(JSON.stringify(response)+'\n');process.exitCode=exitCode;
}
