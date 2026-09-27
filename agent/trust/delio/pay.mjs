import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Devnet payment rail for a verified PLN quote. A user pays native SOL or
// devnet USDC to the local treasury address; each intent carries a unique
// reference account (the Solana Pay convention) so the transfer can be found
// and bound to exactly one intent. Confirmation is read directly from the
// devnet RPC — the on-chain transfer itself is the payment proof, no webhook
// or Privy credential is trusted server-side. After `paid`, a funded order
// record is written and a pluggable executor command may be invoked; with no
// executor configured the order stays honestly EXECUTION_PENDING.
export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const ASSETS = ['SOL', 'USDC'];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const clone = value => structuredClone(value);

export function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) { carry += digits[index] << 8; digits[index] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  if (zeros === bytes.length) return '1'.repeat(zeros);
  return '1'.repeat(zeros) + digits.reverse().map(digit => B58[digit]).join('');
}

function base58Decode(text) {
  let num = 0n;
  for (const char of text) {
    const index = B58.indexOf(char);
    if (index < 0) fail('invalid_base58');
    num = num * 58n + BigInt(index);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num % 256n)); num /= 256n; }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

// --- Minimal Solana transaction building (server stays zero-dependency) ---
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const FIELD_P = 2n ** 255n - 19n;
const modPow = (base, exp, mod) => { let r = 1n, b = base % mod; while (exp > 0n) { if (exp & 1n) r = r * b % mod; b = b * b % mod; exp >>= 1n; } return r; };
const modInv = (a, m) => modPow(((a % m) + m) % m, m - 2n, m);
const ED25519_D = ((-121665n * modInv(121666n, FIELD_P)) % FIELD_P + FIELD_P) % FIELD_P;
const leInt = bytes => { let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); return v; };
// A PDA must be off the ed25519 curve: reject y values where x² = (y²-1)/(d·y²+1)
// has no square root mod p (Euler criterion).
function isOnCurve(bytes) {
  const copy = Uint8Array.from(bytes); copy[31] &= 0x7f;
  const y = leInt(copy);
  if (y >= FIELD_P) return false;
  const y2 = y * y % FIELD_P;
  const x2 = (y2 - 1n + FIELD_P) % FIELD_P * modInv((ED25519_D * y2 + 1n) % FIELD_P, FIELD_P) % FIELD_P;
  return x2 === 0n || modPow(x2, (FIELD_P - 1n) / 2n, FIELD_P) === 1n;
}
function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump > 0; bump--) {
    const hash = createHash('sha256').update(Buffer.concat([...seeds, Uint8Array.from([bump]), programId, Buffer.from('ProgramDerivedAddress')])).digest();
    if (!isOnCurve(hash)) return Uint8Array.from(hash);
  }
  fail('pda_not_found');
}
const shortvec = n => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Uint8Array.from(out); };
// Legacy message: 1 signer (the treasury/fee payer), fixed account layout below.
function compileSettlementTx({ treasury, treasuryAta, destAta, destOwner, mint, reference, needAtaCreate, blockhash, usdcMinor }) {
  const tokenProg = base58Decode(TOKEN_PROGRAM), ataProg = base58Decode(ATA_PROGRAM), systemProg = base58Decode(SYSTEM_PROGRAM);
  const keys = [base58Decode(treasury.publicKey), treasuryAta, destAta, destOwner, mint, base58Decode(reference), ataProg, tokenProg, systemProg];
  const header = Uint8Array.from([1, 0, 6]);
  const ix = (programIdIndex, accounts, data) => Buffer.concat([Uint8Array.from([programIdIndex]), shortvec(accounts.length), Uint8Array.from(accounts), shortvec(data.length), Uint8Array.from(data)]);
  const instructions = [];
  if (needAtaCreate) instructions.push(ix(6, [0, 2, 3, 4, 8, 7], [1])); // createAssociatedTokenAccountIdempotent
  const amount = new Uint8Array(9); amount[0] = 12; // transferChecked
  new DataView(amount.buffer).setBigUint64(1, BigInt(usdcMinor), true);
  instructions.push(ix(7, [1, 4, 2, 0], [...amount, 6])); // decimals = 6
  const message = Buffer.concat([header, shortvec(keys.length), ...keys, base58Decode(blockhash), shortvec(instructions.length), ...instructions]);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Uint8Array.from(treasury.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  const signature = cryptoSign(null, message, key);
  return Buffer.concat([shortvec(1), signature, message]);
}

function loadOrCreateTreasury(storeDir) {
  const path = join(storeDir, 'treasury.json');
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof saved.publicKey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved.publicKey)) fail('treasury_config_invalid');
    return saved;
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const record = { publicKey: base58Encode(publicBytes), secretKey: Array.from(Buffer.concat([seed, publicBytes])) };
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return record;
}

function treasuryDelta(tx, recipient, usdcMint) {
  const meta = tx?.meta, message = tx?.transaction?.message;
  if (!meta || meta.err !== null || !message) return null;
  const keys = (message.accountKeys || []).map(key => typeof key === 'string' ? key : key?.pubkey);
  const pre = meta.preBalances || [], post = meta.postBalances || [];
  let sol = 0n;
  for (let index = 0; index < keys.length; index++)
    if (keys[index] === recipient) sol += BigInt(post[index] ?? 0) - BigInt(pre[index] ?? 0);
  const preToken = new Map((meta.preTokenBalances || []).map(balance => [balance.accountIndex, BigInt(balance.uiTokenAmount?.amount ?? 0)]));
  let usdc = 0n;
  for (const balance of meta.postTokenBalances || [])
    if (balance.owner === recipient && balance.mint === usdcMint)
      usdc += BigInt(balance.uiTokenAmount?.amount ?? 0) - (preToken.get(balance.accountIndex) ?? 0n);
  const signer = (message.accountKeys || []).find(key => typeof key === 'object' && key?.signer === true);
  return { sol, usdc, payer: typeof signer === 'object' ? signer.pubkey : keys[0] ?? null };
}

export function createPayService({ storeDir, clock = Date.now, rpcUrl = DEVNET_RPC, usdcMint = DEVNET_USDC_MINT,
  solPlnRate = 800, usdPlnRate = 4.0, intentTtlMs = 15 * 60 * 1000, privyAppId = '',
  executorCommand = process.env.DELIO_PAY_EXECUTOR || '',
  settlementUsdcDestination = process.env.DELIO_SETTLEMENT_USDC_DEST || '',
  fetchImpl = fetch, invoke = spawn } = {}) {
  if (!storeDir || !(solPlnRate > 0) || !(usdPlnRate > 0) || !integer(intentTtlMs)) fail('invalid_pay_config');
  if (settlementUsdcDestination && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(settlementUsdcDestination)) fail('invalid_pay_config');
  mkdirSync(join(storeDir, 'intents'), { recursive: true, mode: 0o700 });
  mkdirSync(join(storeDir, 'orders'), { recursive: true, mode: 0o700 });
  const treasury = loadOrCreateTreasury(storeDir);
  // Rates are kept as milli-PLN per unit so BigInt conversion stays exact:
  // lamports = totalMinor(grosze) * 1e9 / (solPlnRate * 100) = totalMinor * 1e10 / solRateMilli
  // usdcMinor = totalMinor(grosze) * 1e6 / (usdPlnRate * 100) = totalMinor * 1e7 / usdRateMilli
  const solRateMilli = BigInt(Math.round(solPlnRate * 1000));
  const usdRateMilli = BigInt(Math.round(usdPlnRate * 1000));
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const lamportsFor = totalMinor => Number(ceilDiv(BigInt(totalMinor) * 10_000_000_000n, solRateMilli));
  const usdcMinorFor = totalMinor => Number(ceilDiv(BigInt(totalMinor) * 10_000_000n, usdRateMilli));
  // Settlement is always denominated in USDC minor for the executor: a SOL
  // payment settles at its USD value under the configured rates (the rail owns
  // the conversion), a USDC payment settles 1:1. There is no swap venue on
  // devnet, so this is verified accounting — not an on-chain exchange.
  const usdcMinorSettled = found => found.asset === 'SOL'
    ? Number(ceilDiv(BigInt(found.lamports) * solRateMilli * 1_000_000n, 1_000_000_000n * usdRateMilli))
    : found.usdcMinor;
  const paths = {
    intents: join(storeDir, 'intents'), orders: join(storeDir, 'orders'), events: join(storeDir, 'events.jsonl'),
  };
  function journal(record) {
    appendFileSync(paths.events, JSON.stringify({ at: clock(), ...record }) + '\n', { mode: 0o600, flush: true });
  }
  function persist(intent) {
    const path = join(paths.intents, intent.paymentId + '.json');
    writeFileSync(path + '.tmp', JSON.stringify(intent), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  }
  function persistOrder(order) {
    const path = join(paths.orders, order.order_id + '.json');
    writeFileSync(path + '.tmp', JSON.stringify(order), { mode: 0o600, flush: true });
    renameSync(path + '.tmp', path);
  }
  function loadIntent(paymentId) {
    if (!identifier(paymentId)) fail('payment_not_found');
    const path = join(paths.intents, paymentId + '.json');
    if (!existsSync(path)) fail('payment_not_found');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  function intentForQuote(quoteId) {
    if (!existsSync(paths.intents)) return null;
    for (const name of readdirSync(paths.intents)) {
      if (!name.endsWith('.json')) continue;
      try {
        const intent = JSON.parse(readFileSync(join(paths.intents, name), 'utf8'));
        if (intent.quoteId === quoteId) return intent;
      } catch { fail('payment_store_invalid'); }
    }
    return null;
  }
  async function rpc(method, params) {
    let response;
    try {
      response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'buena', method, params }), signal: AbortSignal.timeout(12_000) });
    } catch (error) { throw Object.assign(new Error('rpc_unavailable'), { code: 'rpc_unavailable', cause: error }); }
    if (!response.ok) fail('rpc_unavailable');
    const data = await response.json().catch(() => fail('rpc_invalid_response'));
    if (data.error) throw Object.assign(new Error('rpc_error'), { code: 'rpc_error', rpcError: data.error });
    return data.result;
  }
  async function checkTransaction(signature, intent) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx) return null;
    // The intent's unique reference must be an account in this transaction —
    // otherwise a signature funding a different intent could be replayed here.
    const keys = (tx.transaction.message.accountKeys || []).map(key => typeof key === 'string' ? key : key?.pubkey);
    if (!keys.includes(intent.reference)) return null;
    const delta = treasuryDelta(tx, intent.recipient, usdcMint);
    if (!delta) return null;
    const expected = intent.asset === 'SOL' ? delta.sol >= BigInt(intent.expectedLamports) : delta.usdc >= BigInt(intent.expectedUsdcMinor);
    if (!expected) {
      journal({ type: 'payment_underpaid_candidate', paymentId: intent.paymentId, signature, solDelta: delta.sol.toString(), usdcDelta: delta.usdc.toString() });
      return null;
    }
    return { signature, payer: delta.payer, asset: intent.asset,
      lamports: intent.asset === 'SOL' ? Number(delta.sol) : null,
      usdcMinor: intent.asset === 'USDC' ? Number(delta.usdc) : null,
      blockTime: tx.blockTime ?? null, slot: tx.slot ?? null };
  }
  async function findPayment(intent, submittedSignature = null) {
    const candidates = [];
    if (submittedSignature) candidates.push(submittedSignature);
    const signatures = await rpc('getSignaturesForAddress', [intent.reference, { limit: 8, commitment: 'confirmed' }]);
    for (const entry of signatures || []) if (entry?.signature && !candidates.includes(entry.signature)) candidates.push(entry.signature);
    for (const signature of candidates.slice(0, 9)) {
      const found = await checkTransaction(signature, intent);
      if (found) return found;
    }
    return null;
  }
  // Settlement delivery: when a USDC destination is configured (e.g. an
  // Altitude deposit address), the treasury sends the settled amount as a real
  // on-chain USDC transfer — the conversion is custodial, funded by the
  // treasury's USDC float. Without a destination, settlement remains
  // accounting-only ('accounted').
  const treasuryPublic = () => base58Decode(treasury.publicKey);
  async function settleUsdc(order, intent) {
    const s = order.settlement;
    const tokenProg = base58Decode(TOKEN_PROGRAM), ataProg = base58Decode(ATA_PROGRAM), mintBytes = base58Decode(usdcMint);
    const treasuryAta = findProgramAddress([treasuryPublic(), tokenProg, mintBytes], ataProg);
    const destOwner = base58Decode(settlementUsdcDestination);
    const destAta = findProgramAddress([destOwner, tokenProg, mintBytes], ataProg);
    // Float check: the treasury must hold enough USDC to cover the settlement.
    let float = 0n;
    try {
      const balance = await rpc('getTokenAccountBalance', [base58Encode(treasuryAta)]);
      float = BigInt(balance?.value?.amount ?? 0);
    } catch { float = 0n; }
    if (float < BigInt(s.usdcMinor)) {
      s.status = 'insufficient_float'; s.detail = `Treasury USDC float ${float} < settlement ${s.usdcMinor}; top up the treasury USDC account ${base58Encode(treasuryAta)}.`; s.at = clock();
      journal({ type: 'settlement_insufficient_float', paymentId: intent.paymentId, usdcMinor: s.usdcMinor, float: float.toString() });
      return s;
    }
    // If a previous attempt left a signature, confirm it before resending.
    if (s.signature) {
      const status = await rpc('getSignatureStatuses', [[s.signature], { searchTransactionHistory: true }]).catch(() => null);
      const value = status?.value?.[0];
      if (value && value.err === null && ['confirmed', 'finalized'].includes(value.confirmationStatus)) { s.status = 'settled'; s.at = clock(); return s; }
    }
    const needAtaCreate = !(await rpc('getAccountInfo', [base58Encode(destAta), { encoding: 'base64' }]).then(r => r?.value).catch(() => null));
    const { blockhash } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(r => r.value ?? r);
    const wire = compileSettlementTx({ treasury, treasuryAta, destAta, destOwner, mint: mintBytes, reference: intent.reference, needAtaCreate, blockhash, usdcMinor: s.usdcMinor });
    s.destinationAta = base58Encode(destAta); s.treasuryAta = base58Encode(treasuryAta);
    s.signature = await rpc('sendTransaction', [wire.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 }]);
    s.status = 'submitted'; s.at = clock();
    journal({ type: 'settlement_submitted', paymentId: intent.paymentId, signature: s.signature, usdcMinor: s.usdcMinor, destination: settlementUsdcDestination });
    // Confirm briefly; if it doesn't land in time, stay 'submitted' — a later
    // check() picks it up via the signature rather than resending blindly.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      const status = await rpc('getSignatureStatuses', [[s.signature], { searchTransactionHistory: true }]).catch(() => null);
      const value = status?.value?.[0];
      if (value?.err) { s.status = 'failed'; s.detail = 'Settlement transaction failed on-chain.'; s.at = clock(); return s; }
      if (value && ['confirmed', 'finalized'].includes(value.confirmationStatus)) {
        s.status = 'settled'; s.detail = null; s.at = clock();
        journal({ type: 'settlement_confirmed', paymentId: intent.paymentId, signature: s.signature });
        return s;
      }
    }
    return s;
  }
  // Returns true when the order's settlement is in a state the executor may
  // rely on: either on-chain delivery is confirmed, or no destination is
  // configured so accounting is the contract.
  const settlementReady = order => ['accounted', 'settled'].includes(order.settlement?.status);
  async function dispatchExecution(intent) {
    const orderPath = join(paths.orders, intent.paymentId + '.json');
    const order = JSON.parse(readFileSync(orderPath, 'utf8'));
    if (order.execution.status !== 'pending_dispatch') return order;
    if (!executorCommand) {
      order.execution = { status: 'execution_pending', detail: 'Payment received. No executor command is configured; the card-order step is pending.', at: clock() };
      persistOrder(order); journal({ type: 'order_execution_pending', orderId: order.order_id });
      return order;
    }
    order.execution = { status: 'dispatching', at: clock() };
    persistOrder(order);
    const outcome = await new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      try {
        const child = invoke(executorCommand, [orderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { child.kill('SIGTERM'); done({ code: 'executor_timeout' }); }, 120_000);
        let output = '';
        child.stdout?.on('data', bytes => { if (output.length < 4096) output += bytes.toString().slice(0, 4096 - output.length); });
        child.stderr?.resume();
        child.on('error', () => { clearTimeout(timer); done({ code: 'executor_unavailable' }); });
        child.on('exit', code => { clearTimeout(timer); done(code === 0 ? { exitCode: 0 } : { exitCode: code ?? 'unknown', code: 'executor_failed' }); });
      } catch { done({ code: 'executor_unavailable' }); }
    });
    order.execution = outcome.exitCode === 0
      ? { status: 'executed', command: 'configured', at: clock(), detail: 'Executor command completed.' }
      : { status: 'execution_failed', at: clock(), detail: `Executor command failed: ${outcome.code ?? 'exit ' + outcome.exitCode}` };
    persistOrder(order);
    journal({ type: 'order_execution_' + (outcome.exitCode === 0 ? 'dispatched' : 'failed'), orderId: order.order_id });
    return order;
  }
  async function markPaid(intent, found) {
    intent.status = 'paid';
    intent.payment = { ...found, receivedAt: clock() };
    persist(intent);
    // Any sibling intent left over for the same quote can no longer be paid
    // into a second order — the quote is funded once.
    for (const name of readdirSync(paths.intents)) {
      if (!name.endsWith('.json')) continue;
      try {
        const sibling = JSON.parse(readFileSync(join(paths.intents, name), 'utf8'));
        if (sibling.quoteId === intent.quoteId && sibling.paymentId !== intent.paymentId && sibling.status === 'pending') {
          sibling.status = 'superseded'; persist(sibling);
        }
      } catch { fail('payment_store_invalid'); }
    }
    journal({ type: 'payment_received', paymentId: intent.paymentId, signature: found.signature, payer: found.payer, asset: found.asset, lamports: found.lamports, usdcMinor: found.usdcMinor });
    const settlementUsdcMinor = usdcMinorSettled(found);
    journal({ type: 'payment_settled', paymentId: intent.paymentId, settlementUsdcMinor });
    const order = { order_id: intent.paymentId, merchant: 'delio', quoteId: intent.quoteId,
      customerId: intent.customerId, merchantAccountId: intent.merchantAccountId,
      quoted_amount_minor: intent.totalMinor, currency: 'PLN', asset: intent.asset,
      funding: { signature: found.signature, payer: found.payer, amount: found.lamports ?? found.usdcMinor, asset: intent.asset, received_at: new Date(intent.payment.receivedAt).toISOString() },
      // The executor reads settlement.usdcMinor — always USDC-denominated,
      // regardless of which asset the customer paid.
      settlement: { asset: 'USDC', usdcMinor: settlementUsdcMinor, sourceAsset: found.asset,
        sourceLamports: found.lamports, sourceUsdcMinor: found.usdcMinor,
        destination: settlementUsdcDestination || null,
        status: settlementUsdcDestination ? 'pending' : 'accounted',
        signature: null, detail: null,
        basis: { solPlnRate, usdPlnRate, quoteTotalMinor: intent.totalMinor }, at: clock() },
      status: 'FUNDED', execution: { status: 'pending_dispatch' }, created_at: new Date().toISOString() };
    if (settlementUsdcDestination) {
      try { await settleUsdc(order, intent); }
      catch (error) { order.settlement.status = 'failed'; order.settlement.detail = `Settlement send failed: ${error.code || error.message}`; }
    }
    persistOrder(order);
    if (!settlementReady(order)) {
      order.execution = { status: 'execution_pending', at: clock(), detail: `Awaiting USDC settlement (${order.settlement.status}) before dispatch.` };
      persistOrder(order);
      return order;
    }
    return dispatchExecution(intent);
  }
  // A paid intent whose on-chain settlement never completed retries it on the
  // next status check — topping up the treasury float is enough to unblock it.
  async function resumeSettlement(intent) {
    const path = join(paths.orders, intent.paymentId + '.json');
    if (!existsSync(path)) return null;
    const order = JSON.parse(readFileSync(path, 'utf8'));
    if (!settlementUsdcDestination || settlementReady(order)) return order;
    try { await settleUsdc(order, intent); } catch { order.settlement.status = 'failed'; }
    persistOrder(order);
    if (settlementReady(order) && order.execution.status === 'execution_pending') {
      order.execution = { status: 'pending_dispatch' }; persistOrder(order);
      return dispatchExecution(intent);
    }
    return order;
  }
  function visibleQuote(state) {
    return state?.quote && state.quote.status === 'verified' ? state.quote : null;
  }
  function publicIntent(intent, order) {
    return clone({ paymentId: intent.paymentId, quoteId: intent.quoteId, version: intent.version, asset: intent.asset,
      status: intent.status, recipient: intent.recipient, reference: intent.reference,
      expectedLamports: intent.expectedLamports ?? null, expectedUsdcMinor: intent.expectedUsdcMinor ?? null,
      usdcMint: intent.asset === 'USDC' ? usdcMint : null, totalMinor: intent.totalMinor, currency: 'PLN',
      createdAt: intent.createdAt, expiresAt: intent.expiresAt, payment: intent.payment ?? null,
      order: order ?? (existsSync(join(paths.orders, intent.paymentId + '.json')) ? JSON.parse(readFileSync(join(paths.orders, intent.paymentId + '.json'), 'utf8')) : null) });
  }
  function owned(intent, actor) {
    if (intent.customerId !== actor.customerId || intent.merchantAccountId !== actor.merchantAccountId) fail('payment_not_found');
  }
  const service = {
    config() {
      return { appId: privyAppId || null, enabled: Boolean(privyAppId), cluster: 'devnet', rpcHttpUrl: rpcUrl,
        recipient: treasury.publicKey, usdcMint, assets: ASSETS, solPlnRate, usdPlnRate,
        settlementDestination: settlementUsdcDestination || null,
        scope: 'Devnet only. Paying here funds a merchant order; it is not an escrow and no on-chain program holds it.' };
    },
    currentFor(actor, state) {
      const quote = visibleQuote(state);
      if (!quote) return null;
      const intent = intentForQuote(quote.quoteId);
      if (!intent || intent.customerId !== actor.customerId || intent.merchantAccountId !== actor.merchantAccountId) return null;
      return publicIntent(intent);
    },
    createIntent(actor, state, request) {
      if (!request || typeof request !== 'object') fail('invalid_request_fields');
      const { quoteId, version, asset } = request;
      if (!ASSETS.includes(asset)) fail('invalid_payment_asset');
      const quote = visibleQuote(state);
      if (!quote || quote.quoteId !== quoteId || quote.version !== version) fail('quote_not_current');
      if (!integer(quote.amounts?.totalMinor) || quote.amounts.totalMinor <= 0) fail('invalid_authorization_total');
      if (clock() >= quote.expiresAt) fail('quote_expired');
      // One live intent per quote: a pending or paid intent is returned as-is
      // even for a different asset, so a quote can never carry two payable
      // references. An expired or superseded intent frees the quote again.
      const existing = intentForQuote(quote.quoteId);
      if (existing && ['pending', 'paid'].includes(existing.status)) { owned(existing, actor); return publicIntent(existing); }
      const totalMinor = quote.amounts.totalMinor;
      const intent = { paymentId: randomUUID(), quoteId: quote.quoteId, version: state.version,
        customerId: actor.customerId, merchantAccountId: actor.merchantAccountId, asset,
        status: 'pending', recipient: treasury.publicKey, reference: base58Encode(randomBytes(32)),
        expectedLamports: asset === 'SOL' ? lamportsFor(totalMinor) : null,
        expectedUsdcMinor: asset === 'USDC' ? usdcMinorFor(totalMinor) : null,
        totalMinor, createdAt: clock(), expiresAt: Math.min(quote.expiresAt, clock() + intentTtlMs) };
      persist(intent);
      journal({ type: 'payment_intent_created', paymentId: intent.paymentId, quoteId: intent.quoteId, asset, totalMinor, reference: intent.reference });
      return publicIntent(intent);
    },
    async check(actor, state, request) {
      if (!request || typeof request !== 'object') fail('invalid_request_fields');
      const { paymentId, signature } = request;
      if (signature !== undefined && (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature))) fail('invalid_signature');
      const intent = loadIntent(paymentId);
      owned(intent, actor);
      if (intent.status === 'paid') {
        const order = await resumeSettlement(intent);
        return publicIntent(intent, order ?? undefined);
      }
      const quote = state?.quote;
      if (intent.status === 'pending' && (!quote || quote.quoteId !== intent.quoteId || quote.version !== intent.version)) {
        intent.status = 'superseded'; persist(intent); journal({ type: 'payment_superseded', paymentId: intent.paymentId });
        return publicIntent(intent);
      }
      if (intent.status === 'pending' && clock() >= intent.expiresAt) {
        intent.status = 'expired'; persist(intent); journal({ type: 'payment_expired', paymentId: intent.paymentId });
        return publicIntent(intent);
      }
      if (intent.status === 'pending') {
        let found;
        try { found = await findPayment(intent, signature ?? null); }
        catch (error) { journal({ type: 'payment_check_error', paymentId: intent.paymentId, code: error.code || 'rpc_unavailable' }); throw error; }
        if (found) {
          const order = await markPaid(intent, found);
          return publicIntent(intent, order);
        }
      }
      return publicIntent(intent);
    },
  };
  return service;
}
