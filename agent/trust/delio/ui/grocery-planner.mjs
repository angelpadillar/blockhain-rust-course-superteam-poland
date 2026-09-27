// Pure basket planning: no merchant mutation, coupon redemption or authorization.
export function planBasket({items,lines,regionId,indexRegionId='krakow'}={}) {
 const fail=()=>{throw new Error('invalid_grocery_plan');};
 if(!Array.isArray(items)||!Array.isArray(lines)||lines.length>50||!['krakow','warsaw'].includes(regionId))fail();
 const products=new Map(items.map(p=>[p.productId,p])),seen=new Set();let subtotal=0,priceMissing=false;
 const planned=lines.map(line=>{
  if(!line||Object.keys(line).some(k=>!['productId','quantity'].includes(k))||!products.has(line.productId)||seen.has(line.productId)||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>99)fail();
  seen.add(line.productId);const p=products.get(line.productId);
  const known=regionId===indexRegionId&&Number.isSafeInteger(p.unitPriceMinor)&&p.unitPriceMinor>=0&&p.currency==='PLN';
  if(!known)priceMissing=true;else subtotal+=p.unitPriceMinor*line.quantity;
  return {productId:p.productId,title:p.title,quantity:line.quantity,estimatedLineMinor:known?p.unitPriceMinor*line.quantity:null};
 });
 return {regionId,lines:planned,currency:'PLN',estimatedSubtotalMinor:priceMissing?null:subtotal,reportedMinimumMinor:15000,remainingToReportedMinimumMinor:priceMissing?null:Math.max(0,15000-subtotal),thresholdReached:!priceMissing&&subtotal>=15000,qualifyingSubtotalMinor:null,appliedDiscountMinor:0,checkoutTotalMinor:null,stockVerified:false,status:'draft_only',merchantActionsDispatched:0};
}
