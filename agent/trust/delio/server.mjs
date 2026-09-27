import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPilot } from './core.mjs';
import { createDelioAdapter } from './adapter.mjs';
import { createLocalAuthorizer } from './authorization.mjs';
import { suggest } from './suggest.mjs';
import { createPayService } from './pay.mjs';
import { costReport } from './costs.mjs';
import { bindReceiptPromotion, evaluatePromotion } from './promotion.mjs';
import { CATALOGUE_IMAGE_ORIGINS } from './catalogue.mjs';

const here=dirname(fileURLToPath(import.meta.url)), digest=text=>createHash('sha256').update(text).digest();
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))fail('invalid_request_fields');};
const safeCode=code=>typeof code==='string'&&/^[a-zA-Z_]{1,80}$/.test(code)?code:'request_failed';
async function body(req) {
  if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('json_required');
  let bytes=0,parts=[];
  for await(const part of req){bytes+=part.length;if(bytes>8192)fail('request_too_large');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts));}catch{fail('invalid_json');}
}
export function createDelioServer({pilot,adapter,accounts,authorizer,clock=Date.now,readCosts=()=>costReport(),sessionTtlMs=30*60*1000,readGroceries=()=>null,pay=null}={}) {
  const sessions=new Map(),failures=new Map();
  const allowed=new Map(accounts.map(account=>[digest(account.accessCode).toString('hex'),{customerId:account.customerId,merchantAccountId:account.merchantAccountId}]));
  const server=createServer(async(req,res)=>{
    const reply=(code,value)=>{if(res.headersSent){if(!res.writableEnded)res.end();return;}const body=JSON.stringify(value);res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(body);};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    // Wallet-connect CSP: Privy iframe + APIs, WalletConnect relays, devnet RPC.
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://auth.privy.io https://explorer-api.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org ${CATALOGUE_IMAGE_ORIGINS.join(' ')}; font-src 'self'; connect-src 'self' https://auth.privy.io https://api.devnet.solana.com wss://api.devnet.solana.com https://relay.walletconnect.com https://relay.walletconnect.org wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://pulse.walletconnect.org; child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    let actor;
    const statePayload=async()=>{
      const state=actor?pilot.getState(actor):{};
      const account=actor&&accounts.find(a=>a.customerId===actor.customerId&&a.merchantAccountId===actor.merchantAccountId);
      const promotion=account?.couponCode==='z5913'?evaluatePromotion({promotion:bindReceiptPromotion({...actor,code:account.couponCode}),actor,customerFacts:account.customerFacts||{},cart:{version:state.version,lines:state.cart.lines,...(state.quote?{itemSubtotalMinor:state.quote.amounts.itemSubtotalMinor}:{})},quote:state.quote,now:clock()}):null;
      return {authenticated:Boolean(actor),catalog:await pilot.catalog(),access:actor?adapter.getAccess():{status:'authentication_required',blockers:[]},
        pricing:{currency:'PLN',buenaFeeMinor:0,accepted:false},promotion,costs:actor?readCosts(actor):{},state,
        payment:actor&&pay?pay.currentFor(actor,state):null};
    };
    try {
      const port=server.address()?.port,host=req.headers.host;
      if(!['127.0.0.1:'+port,'localhost:'+port].includes(host))return reply(403,{ok:false,code:'host_not_allowed'});
      const url=new URL(req.url,'http://'+host);
      if(url.search)fail('query_parameters_not_allowed');
      const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('delio_session='))?.slice(14);
      const session=token&&sessions.get(digest(token).toString('hex'));
      if(session?.expiresAt>clock())actor=session.actor;
      if(req.method==='GET'&&url.pathname==='/api/state')return reply(200,await statePayload());
      if(req.method==='GET'&&url.pathname==='/api/groceries'){
        if(!actor)fail('authentication_required');
        const groceries=readGroceries(actor);
        if(!groceries||groceries.regionId!=='krakow'||!Array.isArray(groceries.items))fail('grocery_index_unavailable');
        return reply(200,groceries);
      }
      if(req.method==='GET'&&url.pathname==='/api/evidence'){
        if(!actor)fail('authentication_required');return reply(200,{...await statePayload(),scope:'Local authorization only; no merchant order or payment.'});
      }
      if(req.method==='GET'&&url.pathname==='/api/pay/config'){
        if(!actor)fail('authentication_required');if(!pay)fail('payments_not_configured');return reply(200,{ok:true,...pay.config()});
      }
      if(req.method==='GET'&&['/','/groceries','/groceries.js','/groceries.css','/grocery-planner.mjs','/pay.js','/app.js','/catalogue-view.mjs','/style.css'].includes(url.pathname)){
        const file=url.pathname==='/'?'index.html':url.pathname==='/groceries'?'groceries.html':url.pathname.slice(1),type=/\.(m?js)$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(join(here,'ui',file)));
      }
      if(!['POST','DELETE'].includes(req.method))return reply(404,{ok:false,code:'not_found'});
      if(req.headers.origin!=='http://'+host)fail('origin_not_allowed');
      if(url.pathname==='/api/session'&&req.method==='POST'){
        const address=req.socket.remoteAddress,entry=failures.get(address)||{count:0,until:0};
        if(entry.count>=10&&entry.until>clock())fail('admission_rate_limited');
        const data=await body(req);exact(data,['accessCode']);
        if(typeof data.accessCode!=='string'||data.accessCode.length>256)fail('invalid_access_code');
        const codeHash=digest(data.accessCode);let admitted;
        for(const [key,value] of allowed)if(timingSafeEqual(Buffer.from(key,'hex'),codeHash))admitted=value;
        if(!admitted){failures.set(address,{count:entry.until>clock()?entry.count+1:1,until:clock()+60000});fail('invalid_access_code');}
        failures.delete(address);
        for(const [key,value] of sessions)if(value.expiresAt<=clock())sessions.delete(key);
        if(sessions.size>=32)fail('session_limit_reached');
        const value=randomBytes(32).toString('base64url');sessions.set(digest(value).toString('hex'),{actor:admitted,expiresAt:clock()+sessionTtlMs});
        res.setHeader('Set-Cookie',`delio_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs/1000)}`);
        return reply(200,{ok:true});
      }
      if(!actor)fail('authentication_required');
      if(url.pathname==='/api/session'&&req.method==='DELETE'){
        sessions.delete(digest(token).toString('hex'));res.setHeader('Set-Cookie','delio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return reply(200,{ok:true});
      }
      if(req.method!=='POST')return reply(404,{ok:false,code:'not_found'});
      const data=await body(req);
      if(url.pathname==='/api/suggest'){
        const groceries=readGroceries(actor);
        if(!groceries||!Array.isArray(groceries.items))fail('grocery_index_unavailable');
        return reply(200,{ok:true,...(await suggest({items:groceries.items,body:data}))});
      }
      if(url.pathname==='/api/cart')await pilot.updateCart(actor,data);
      else if(url.pathname==='/api/apply-coupon')await pilot.applyCartCoupon(actor,data);
      else if(url.pathname==='/api/quote')await pilot.refreshQuote(actor,data);
      else if(['/api/reconcile','/api/check-access'].includes(url.pathname)){exact(data,[]);await pilot.reconcile(actor);}
      else if(url.pathname==='/api/authorize')await pilot.authorizeQuote(actor,data,authorizer);
      else if(url.pathname==='/api/pay/intent'){
        if(!pay)fail('payments_not_configured');exact(data,['quoteId','version','asset']);
        return reply(200,{ok:true,payment:pay.createIntent(actor,pilot.getState(actor),data)});
      }
      else if(['/api/pay/submit','/api/pay/status'].includes(url.pathname)){
        if(!pay)fail('payments_not_configured');exact(data,url.pathname==='/api/pay/submit'?['paymentId','signature']:['paymentId']);
        return reply(200,{ok:true,payment:await pay.check(actor,pilot.getState(actor),data)});
      }
      else return reply(404,{ok:false,code:'not_found'});
      return reply(200,{ok:true,...await statePayload()});
    } catch(error) {
      const code=safeCode(error.code),status=code==='authentication_required'?401:code==='origin_not_allowed'?403:code==='admission_rate_limited'?429:409;
      if(!error.code)console.error('delio_request_error',req.method,req.url,error?.message||error);
      let payload={};try{payload=await statePayload();}catch{console.error('delio_state_unavailable');}
      return reply(status,{ok:false,code,...(error.blocked?{blocked:error.blocked}:{}),...(error.blockers?{blockers:error.blockers}:{}),...(error.missing?{missing:error.missing}:{}),...(error.usage?{usage:error.usage}:{}),...payload});
    }
  });
  return server;
}

export async function startPilot({port=Number(process.env.DELIO_PORT||4319),privateDir=process.env.DELIO_PRIVATE_DIR||join(here,'private')}={}) {
  process.umask(0o077);mkdirSync(privateDir,{recursive:true,mode:0o700});
  // A second HTTP process must not bypass the in-process account/global locks.
  const lock=join(privateDir,'owner.lock');let fd;
  try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));}catch{throw new Error('pilot_already_owned_review_lock_before_restart');}
  const configFile=join(privateDir,'operator.json');
  if(!existsSync(configFile))writeFileSync(configFile,JSON.stringify({customerId:'pilot-owner',merchantAccountId:'delio-pilot-owner',accessCode:randomBytes(24).toString('base64url'),deliveryCommitment:randomBytes(32).toString('hex'),allowance:{liveQuotes:5,cartUpdates:12,modelCalls:0,runtimeMs:300000}},null,2),{mode:0o600,flag:'wx'});
  // Live execution always requires fresh stock proof. A missing configured
  // region cannot silently opt out; it remains unverified until setup is done.
  const savedAccount=JSON.parse(readFileSync(configFile,'utf8'));
  const account={...savedAccount,requireStockProof:true,regionId:savedAccount.regionId||'unconfigured'};
  const adapter=createDelioAdapter({storeDir:privateDir,accountId:account.merchantAccountId});
  const pilot=createPilot({adapter,storeDir:privateDir,accounts:[account],limits:{maxConcurrent:1,liveQuotes:60,cartUpdates:300,modelCalls:4000,runtimeMs:7200000,operationRuntimeMs:300000,modelCallsPerOperation:{mutateCart:15,quote:2,observeCart:0,authorize:0,applyCoupon:6}}});
  const authorizer=createLocalAuthorizer({storeDir:join(privateDir,'authorizations'),evidenceDir:join(privateDir,'evidence')});
  const readCosts=actor=>{let attempts=[];try{attempts=readFileSync(join(privateDir,'attempts.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
    const ownedAttempts=new Set(attempts.filter(a=>a.customerId===actor.customerId&&a.merchantAccountId===actor.merchantAccountId).map(a=>a.attemptId).filter(Boolean));
    attempts=attempts.filter(a=>(a.customerId===actor.customerId&&a.merchantAccountId===actor.merchantAccountId)||ownedAttempts.has(a.attemptId));
    return costReport({attempts,verifiedQuotes:attempts.filter(a=>a.type==='quote_verified').length});};
  const readGroceries=actor=>{if(actor.customerId!==account.customerId||actor.merchantAccountId!==account.merchantAccountId)fail('account_not_owned');return JSON.parse(readFileSync(join(here,'catalogue/krakow.json')));};
  const pay=createPayService({storeDir:join(privateDir,'payments'),
    privyAppId:process.env.PRIVY_APP_ID||savedAccount.privyAppId||'',
    rpcUrl:process.env.DELIO_SOLANA_RPC||undefined,
    solPlnRate:Number(process.env.DELIO_SOL_PLN_RATE)||800,
    usdPlnRate:Number(process.env.DELIO_USD_PLN_RATE)||4.0,
    settlementUsdcDestination:process.env.DELIO_SETTLEMENT_USDC_DEST||savedAccount.settlementUsdcDestination||''});
  const server=createDelioServer({pilot,adapter,accounts:[account],authorizer,readCosts,readGroceries,pay});
  const release=()=>{try{closeSync(fd);unlinkSync(lock);}catch{}};server.on('close',release);
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(e){release();throw e;}
  const stop=()=>{if(pilot.getState(account).workerActive)pilot.stop('operator_shutdown');server.close();};
  // SIGUSR2 is the bounded operator stop switch; pending workers are aborted.
  process.once('SIGUSR2',()=>pilot.stop('operator_stop'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log(`Delio workspace: http://127.0.0.1:${server.address().port}\nPrivate operator configuration: ${configFile}\nDevnet payments: ${pay.config().enabled ? 'enabled (Privy app ' + pay.config().appId + ')' : 'no PRIVY_APP_ID — pay UI disabled'}\nNo merchant order or paid SMS operation is enabled by this server.`);
  return {server,pilot,adapter};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await startPilot();
