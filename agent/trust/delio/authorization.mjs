import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalChain } from '../integrated/chain-client.mjs';
import { canonicalTermsBytes, canonicalTermsHash, hashCommitment } from '../integrated/encoding.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const assert=(condition,code)=>{if(!condition) throw Object.assign(new Error(code),{code});};
export const quoteObservation = quote => ({currency:quote.currency,lines:quote.lines,
  amounts:Object.fromEntries(Object.entries(quote.amounts).filter(([key])=>!['buenaFeeMinor','totalMinor'].includes(key))),
  deliveryCommitment:quote.deliveryCommitment,couponStatus:quote.couponStatus,couponResults:quote.couponResults,
  ...(quote.stockProof?{stockProof:quote.stockProof,regionId:quote.regionId,fulfillmentAreaId:quote.fulfillmentAreaId}:{})});

// Evidence files are private server artifacts, never paths supplied by clients.
export function verifyQuoteEvidence(directory,quote,actor) {
  assert(quote.evidenceRefs?.length,'quote_evidence_required');
  return quote.evidenceRefs.map(ref=>{
    assert(/^[a-zA-Z0-9_-]{1,100}$/.test(ref.id),'invalid_evidence_id');
    let record,image,observation;
    try {
      record=JSON.parse(readFileSync(join(directory,ref.id+'.json'),'utf8'));
      image=readFileSync(join(directory,ref.id+'.png'));
      observation=readFileSync(join(directory,ref.id+'.observation.json'));
    } catch { throw Object.assign(new Error('live_quote_evidence_not_available'),{code:'live_quote_evidence_not_available'}); }
    assert(record.observedAt===ref.observedAt&&record.customerId===actor.customerId&&record.merchantAccountId===actor.merchantAccountId,'evidence_owner_mismatch');
    assert(image.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&sha(image)===record.imageSha256&&sha(observation)===record.observationSha256,'evidence_hash_mismatch');
    assert(hashCommitment({kind:'quote',observation:JSON.parse(observation)})===hashCommitment({kind:'quote',observation:quoteObservation(quote)}),'evidence_quote_mismatch');
    return {id:ref.id,observedAt:record.observedAt,imageSha256:record.imageSha256,observationSha256:record.observationSha256};
  });
}

export function createLocalAuthorizer({storeDir,evidenceDir,verifyEvidence=verifyQuoteEvidence,createChain=()=>new LocalChain(),clock=Date.now}={}) {
  return async (quote,context) => {
    let authorizationSent=false;
    try {
    const {signal,customerId,merchantAccountId}=context;
    assert(quote.status==='verified'&&quote.currency==='PLN'&&quote.expiresAt>clock(),'verified_current_quote_required');
    assert(quote.customerId===customerId&&quote.merchantAccountId===merchantAccountId,'quote_owner_mismatch');
    assert(/^[a-f0-9]{64}$/.test(quote.deliveryCommitment),'delivery_commitment_required');
    assert(Number.isSafeInteger(quote.amounts.totalMinor)&&quote.amounts.totalMinor>0,'invalid_authorization_total');
    const evidence=verifyEvidence(evidenceDir,quote,{customerId,merchantAccountId});
    const commitments={merchantHash:hashCommitment({kind:'merchant',origin:'https://delio.com.pl',merchantAccountId}),
      specHash:hashCommitment({kind:'item',lines:quote.lines}),
      recipientHash:hashCommitment({kind:'recipient',customerId,deliveryCommitment:quote.deliveryCommitment}),
      quoteHash:hashCommitment({kind:'quote',quote,evidence})};
    signal?.throwIfAborted();
    const chain=createChain(), close=()=>chain.close();
    signal?.addEventListener('abort',close,{once:true});
    try {
      const prepared=await chain.request({op:'prepare',quote:{...commitments,currency:'PLN',currencyExponent:2,
        totalMinor:quote.amounts.totalMinor,expiresAt:Math.floor(quote.expiresAt/1000)}});
      assert(prepared.accepted===true,'local_chain_prepare_failed');
      const canonical=prepared.canonical, inputs=canonical?.inputs;
      assert(canonicalTermsHash(inputs)===canonical.termsHash&&canonicalTermsBytes(inputs).toString('hex')===canonical.bytesHex,'local_chain_terms_mismatch');
      for(const key of ['merchantHash','specHash','quoteHash']) assert(inputs.campaign[key]===commitments[key],'local_chain_commitment_mismatch');
      assert(inputs.mandate.recipientHash===commitments.recipientHash&&inputs.mandate.maxChargeAmountMinor===String(quote.amounts.totalMinor)
        &&inputs.campaign.quotedChargeAmountMinor===String(quote.amounts.totalMinor),'local_chain_amount_mismatch');
      assert(BigInt(prepared.state.balances.vaultDemoTokenUnits)>=BigInt(inputs.campaign.settlementAmount),'local_demo_escrow_unfunded');
      signal?.throwIfAborted(); assert(quote.expiresAt>clock(),'quote_expired');
      authorizationSent=true;
      const approved=await chain.request({op:'authorize',termsHash:canonical.termsHash});
      assert(approved.accepted===true&&approved.state.campaign.status==='Approved'&&approved.state.mandate.status==='Active','local_chain_authorization_failed');
      const proof={backend:'LiteSVM local Solana',quoteId:quote.quoteId,version:quote.version,
        observedMerchant:'Delio',quoteSource:'checkout_verified',termsHash:canonical.termsHash,commitments,evidence,
        canonical,transactions:[...prepared.transactions,...approved.transactions],state:approved.state,
        publicKeys:approved.publicKeys,binarySha256:approved.binarySha256,
        funding:{status:'verified_local_demo_tokens',vaultDemoTokenUnits:prepared.state.balances.vaultDemoTokenUnits,realFunds:false},
        merchantExecution:'not_requested',merchantOrder:null,paymentSettlement:'not_performed',delivery:'not_performed',
        limitations:['Ephemeral local signers and chain, closed after evidence capture; no public deployment or wallet connection.',
          'The existing bridge uses one aggregate amount in its item subtotal field. Full merchant line items, fees, discount and Buena fee are bound in quoteHash.',
          'No live merchant execution endpoint exists. The preserved gifting workflow separately demonstrates simulated execution.']};
      if(storeDir) {mkdirSync(storeDir,{recursive:true,mode:0o700});writeFileSync(join(storeDir,quote.quoteId+'.json'),JSON.stringify(proof,null,2),{mode:0o600,flag:'wx'});}
      return {accepted:true,proof,usage:{modelCalls:0,modelCostUsd:0}};
    } finally {signal?.removeEventListener('abort',close);close();}
    } catch(error) {if(!authorizationSent)error.dispatched=false;throw error;}
  };
}
