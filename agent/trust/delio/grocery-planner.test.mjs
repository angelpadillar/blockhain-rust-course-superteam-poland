import test from 'node:test';import assert from 'node:assert/strict';import {planBasket} from './ui/grocery-planner.mjs';
const items=[{productId:'A0000953',title:'Masło',unitPriceMinor:5000,currency:'PLN'}];
test('150 PLN progress never fabricates eligibility, discount, checkout total or stock',()=>{
 const result=planBasket({items,lines:[{productId:'A0000953',quantity:3}],regionId:'krakow'});
 assert.equal(result.estimatedSubtotalMinor,15000);assert.equal(result.remainingToReportedMinimumMinor,0);assert.equal(result.thresholdReached,true);assert.equal(result.appliedDiscountMinor,0);assert.equal(result.checkoutTotalMinor,null);assert.equal(result.qualifyingSubtotalMinor,null);assert.equal(result.merchantActionsDispatched,0);
});
test('Kraków prices cannot be used for a Warsaw draft and malformed quantities fail closed',()=>{
 assert.equal(planBasket({items,lines:[{productId:'A0000953',quantity:1}],regionId:'warsaw'}).estimatedSubtotalMinor,null);
 for(const quantity of [0,-1,1.5,100,NaN])assert.throws(()=>planBasket({items,lines:[{productId:'A0000953',quantity}],regionId:'krakow'}));
 assert.throws(()=>planBasket({items,lines:[{productId:'missing',quantity:1}],regionId:'krakow'}));
});
