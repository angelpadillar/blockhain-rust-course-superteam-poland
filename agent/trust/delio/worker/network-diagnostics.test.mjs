import test from 'node:test';
import assert from 'node:assert/strict';
import {networkHostSummary} from './network-diagnostics.mjs';
test('network diagnostics export only host and closed categories, never request data',()=>{
  const request={url:'https://api.example.test/private-phone-path?otp=SECRET_CODE',event:'request_failed',method:'POST',reason:'network_policy',headers:{authorization:'SECRET_TOKEN'},body:'SECRET_PHONE'};
  const result=networkHostSummary({requests:[request,request,{url:'https://api.example.test/path',event:'response',method:'GET',status:200},{url:'file:///private/SECRET_FILE',event:'request'},{url:'not-url',event:'request'}]});
  assert.equal(result.hosts.length,2);assert.deepEqual(result.hosts[0],{hostname:'api.example.test',event:'request_failed',method:'POST',status:null,policyBlocked:true,count:2});
  assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(JSON.stringify(result).includes('/path'),false);
});
test('unclassified failure is not asserted to be an allowlist denial',()=>{
  const result=networkHostSummary({requests:[{url:'https://delio.com.pl/',event:'request_failed',method:'UNKNOWN_PRIVATE',reason:'private error',status:999}]});
  assert.equal(result.hosts[0].policyBlocked,false);assert.equal(result.hosts[0].method,'unknown');assert.equal(result.hosts[0].status,null);
});
