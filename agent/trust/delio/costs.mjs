// USD is the reporting denomination. Unknown inputs stay unknown; no FX rate is invented.
export function costReport({attempts=[],smsSpentUsd=0,verifiedQuotes=0,completedOrders=0,
  revenueUsd=0,infrastructureUsd=null,manualSupportUsd=null,paymentAndFxUsd=null}={}) {
  const valid=value=>Number.isFinite(value)&&value>=0;
  for(const value of [smsSpentUsd,revenueUsd]) if(!valid(value)) throw new Error('invalid_cost');
  for(const value of [verifiedQuotes,completedOrders]) if(!Number.isSafeInteger(value)||value<0) throw new Error('invalid_count');
  const ends=new Map(),legacy=[];
  for(const attempt of attempts.filter(a=>a.type==='worker_end')) {
    if(attempt.attemptId)ends.set(attempt.attemptId,attempt);else legacy.push(attempt);
  }
  const starts=new Map(attempts.filter(a=>a.type==='worker_start'&&a.attemptId).map(a=>[a.attemptId,a]));
  const unresolved=[...starts.values()].filter(a=>!ends.has(a.attemptId));
  const costs=[...ends.values(),...legacy,...unresolved.map(a=>({...a,cost:{status:'unknown',amountUsd:null},runtimeMs:null}))];
  const known=costs.filter(a=>a.cost?.status==='known');
  const estimated=costs.filter(a=>a.cost?.status==='estimated');
  const unknownAttempts=costs.length-known.length-estimated.length;
  const knownModelCostUsd=known.reduce((sum,a)=>sum+a.cost.amountUsd,0);
  const estimatedModelCostUsd=estimated.reduce((sum,a)=>sum+a.cost.amountUsd,0);
  const missing=[];
  if(unknownAttempts) missing.push('some model usage');
  if(unresolved.length)missing.push('interrupted attempt runtime/outcome');
  for(const [name,value] of [['infrastructure',infrastructureUsd],['manual support',manualSupportUsd],['payment and FX',paymentAndFxUsd]]) {
    if(value===null) missing.push(name); else if(!valid(value)) throw new Error('invalid_cost');
  }
  const knownSubtotalUsd=knownModelCostUsd+smsSpentUsd+[infrastructureUsd,manualSupportUsd,paymentAndFxUsd].filter(valid).reduce((a,b)=>a+b,0);
  const totalVariableCostUsd=missing.length?null:knownSubtotalUsd+estimatedModelCostUsd;
  return {currency:'USD',attempts:costs.length,verifiedQuotes,completedOrders,knownModelCostUsd,estimatedModelCostUsd,unknownAttempts,
    browserRuntimeMs:unresolved.length?null:costs.reduce((sum,a)=>sum+(a.runtimeMs || 0),0),
    knownBrowserRuntimeMs:costs.reduce((sum,a)=>sum+(a.runtimeMs || 0),0),unresolvedAttempts:unresolved.length,
    sms:{authorizedTotalUsd:0.20,spentUsd:smsSpentUsd,maxPurchases:1},
    infrastructureUsd,manualSupportUsd,paymentAndFxUsd,knownSubtotalUsd,totalVariableCostUsd,
    costPerVerifiedQuoteUsd:verifiedQuotes&&totalVariableCostUsd!==null?totalVariableCostUsd/verifiedQuotes:null,
    allocatedCostPerCompletedOrderUsd:completedOrders&&totalVariableCostUsd!==null?totalVariableCostUsd/completedOrders:null,
    revenueUsd,contributionMarginUsd:totalVariableCostUsd===null?null:revenueUsd-totalVariableCostUsd,
    missing,allocation:'All recorded attempts, including failures and abandoned quotes, count toward total cost. Coupons are customer savings, never Buena revenue.',
    feeRecommendation:'Pilot fee: PLN 0, no charge. A sustainable paid fee cannot be established before measured successful quotes, conversions, payment/FX and support costs.'};
}
