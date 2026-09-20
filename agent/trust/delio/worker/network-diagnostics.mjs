/** Only aggregate public host/method/status categories. Never export request data. */
export function networkHostSummary(payload) {
  const rows=new Map();
  for(const event of Array.isArray(payload?.requests)?payload.requests:[]){
    let url;try{url=new URL(event.url);}catch{continue;}
    if(!['http:','https:'].includes(url.protocol)||!/^[a-z0-9.-]{1,253}$/i.test(url.hostname))continue;
    const kind=['request','response','request_failed'].includes(event.event)?event.event:'unknown';
    const method=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(event.method)?event.method:'unknown';
    const status=Number.isInteger(event.status)&&event.status>=100&&event.status<=599?event.status:null;
    const policyBlocked=event.reason==='network_policy'||event.error==='network_policy';
    const key=JSON.stringify([url.hostname,kind,method,status,policyBlocked]);
    const row=rows.get(key)||{hostname:url.hostname,event:kind,method,status,policyBlocked,count:0};row.count++;rows.set(key,row);
  }
  return {available:true,hosts:[...rows.values()].slice(0,200),scope:'Hostname aggregates only; a failed request alone does not establish a policy block.'};
}
