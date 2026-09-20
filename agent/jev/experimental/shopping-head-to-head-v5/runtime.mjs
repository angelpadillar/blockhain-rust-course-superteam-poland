import {actionMenu,createShoppingBrowser} from './browser.mjs';
export async function runShopping({page,task,choose,policyContext,guard,signal,onEvent=async()=>{},maxSteps=16}) {
 const browser=createShoppingBrowser({page,policyContext,guard,signal});
 const history=[],metrics={observations:0,actions:0,observationMs:0,decisionMs:0,executionMs:0};
 let previous='';
 try {
  for(let step=0;step<maxSteps;step++) {
   signal.throwIfAborted();guard?.throwIfStopped();const start=performance.now();const observation=await browser.observe();policyContext.currentUrl=observation.url;metrics.observations++;metrics.observationMs+=performance.now()-start;
   if(/captcha|robot check|validatecaptcha|verify you are human|wpisz znaki widoczne|potwierdź.{0,30}człowiek/i.test(observation.title+' '+observation.text.slice(0,1200)))return{status:'blocked',reason:'human_verification',metrics,history};
   const {actions,totalActions,omittedActions}=actionMenu(observation,task,policyContext);
   await onEvent({type:'observation',step,url:observation.url,title:observation.title,text:observation.text,actions:actions.map(({bbox,options,...a})=>a),totalActions,omittedActions});
   const decisionStart=performance.now();const choice=await choose({task,observation,actions,history,signal});metrics.decisionMs+=performance.now()-decisionStart;
   if(['done','unavailable'].includes(choice)){await onEvent({type:'stop',choice});return{status:choice==='done'?'done':'unavailable',reason:choice,metrics,history};}
   const action=actions.find(a=>a.id===choice);
   if(!action)throw Object.assign(new Error('invalid_action'),{code:'invalid_action'});
   const signature=JSON.stringify([observation.url,observation.text,action.operation,action.label,action.value]);
   if(signature===previous)return{status:'incomplete',reason:'repeated_action',metrics,history};previous=signature;
   await onEvent({type:'action_planned',step,action});
   const actionStart=performance.now();await browser.execute(action);metrics.executionMs+=performance.now()-actionStart;metrics.actions++;
   const entry={operation:action.operation,kind:action.kind,label:action.label,value:action.value,result:'dispatched'};history.push(entry);await onEvent({type:'action_completed',step,...entry});
  }
  return{status:'incomplete',reason:'step_limit',metrics,history};
 } finally {await browser.close();}
}
