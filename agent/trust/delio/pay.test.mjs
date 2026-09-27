import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { base58Encode, createPayService, DEVNET_USDC_MINT } from './pay.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'delio-pay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const actor = { customerId: 'customer-1', merchantAccountId: 'delio-acct-1' };
const other = { customerId: 'customer-2', merchantAccountId: 'delio-acct-2' };
const quoteState = (over = {}) => ({
  version: 3,
  quote: { quoteId: 'quote-1', version: 3, status: 'verified', currency: 'PLN',
    observedAt: Date.now() - 1000, expiresAt: Date.now() + 240_000,
    amounts: { merchantTotalMinor: 10000, buenaFeeMinor: 0, totalMinor: 10000 },
    ...over.quote },
});
const service = (dir, over = {}) => createPayService({ storeDir: dir, solPlnRate: 800, usdPlnRate: 4.0, ...over });
const SIG = name => (name + '1'.repeat(87)).slice(0, 87);
const rpcFixture = handlers => async (_url, options) => {
  const { method, params } = JSON.parse(options.body);
  const result = handlers[method] ? await handlers[method](params) : null;
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'buena', result }) };
};
function payTransaction({ recipient, reference, lamports = 0, payer = 'PayerWallet111111111111111111111111111', err = null }) {
  const accountKeys = [{ pubkey: payer, signer: true, writable: true, source: 'transaction' },
    { pubkey: recipient, signer: false, writable: true, source: 'transaction' },
    { pubkey: reference, signer: false, writable: false, source: 'transaction' }];
  return { slot: 100, blockTime: 1700000000,
    transaction: { message: { accountKeys } },
    meta: { err, preBalances: [5_000_000_000, 1_000_000, 0], postBalances: [5_000_000_000 - lamports - 5000, 1_000_000 + lamports, 0],
      preTokenBalances: [], postTokenBalances: [] } };
}
function usdcTransaction({ recipient, reference, usdcMint, amount = 0, payer = 'PayerWallet111111111111111111111111111' }) {
  const accountKeys = [{ pubkey: payer, signer: true, writable: true, source: 'transaction' },
    { pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', signer: false, writable: false, source: 'transaction' },
    { pubkey: reference, signer: false, writable: false, source: 'transaction' }];
  return { slot: 100, blockTime: 1700000000,
    transaction: { message: { accountKeys } },
    meta: { err: null, preBalances: [], postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 3, mint: usdcMint, owner: recipient, uiTokenAmount: { amount: String(amount), decimals: 6 } }] } };
}

test('base58Encode renders the system-program address and round-trips 32 bytes', () => {
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
  const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256);
  const encoded = base58Encode(bytes);
  assert.match(encoded, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.ok(encoded.length >= 32 && encoded.length <= 44);
});

test('treasury keypair is generated once, kept private and reused', async t => {
  const dir = await directory(t);
  const first = service(dir).config().recipient;
  assert.match(first, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(service(dir).config().recipient, first);
  const stored = JSON.parse(await readFile(join(dir, 'treasury.json'), 'utf8'));
  assert.equal(stored.publicKey, first);
  assert.equal(stored.secretKey.length, 64);
  assert.equal((await stat(join(dir, 'treasury.json'))).mode & 0o777, 0o600);
});

test('intent creation requires a current verified quote and prices both assets', async t => {
  const dir = await directory(t), pay = service(dir);
  assert.throws(() => pay.createIntent(actor, quoteState(), { quoteId: 'other', version: 3, asset: 'SOL' }), /quote_not_current/);
  assert.throws(() => pay.createIntent(actor, { version: 3, quote: { ...quoteState().quote, status: 'estimate' } }, { quoteId: 'quote-1', version: 3, asset: 'SOL' }), /quote_not_current/);
  assert.throws(() => pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'BTC' }), /invalid_payment_asset/);
  const sol = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  assert.equal(sol.status, 'pending');
  assert.equal(sol.expectedLamports, 125_000_000); // 100 PLN at 800 PLN/SOL
  assert.equal(sol.expectedUsdcMinor, null);
  assert.match(sol.reference, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const again = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  assert.equal(again.paymentId, sol.paymentId); // idempotent per quote
  const switched = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'USDC' });
  assert.equal(switched.paymentId, sol.paymentId); // one live intent per quote
  assert.equal(switched.asset, 'SOL');
});

test('a USDC intent prices PLN at the configured rate', async t => {
  const dir = await directory(t), pay = service(dir);
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'USDC' });
  assert.equal(intent.expectedUsdcMinor, 25_000_000); // 100 PLN at 4.0 PLN/USD
  assert.equal(intent.usdcMint, DEVNET_USDC_MINT);
  assert.equal(intent.expectedLamports, null);
});

test('an unmatched signature leaves the intent pending; a paying one marks it paid and funds an order', async t => {
  const dir = await directory(t);
  let intentRef;
  const fetchImpl = rpcFixture({
    getSignaturesForAddress: () => [{ signature: SIG('sigForeign') }],
    getTransaction: ([sig]) => sig === SIG('sigForeign')
      ? payTransaction({ recipient: 'SomeoneElse11111111111111111111111111111', reference: 'ForeignRef11111111111111111111111111111', lamports: 5_000_000_000 })
      : payTransaction({ recipient: recipient(), reference: intentRef, lamports: 125_000_000 }),
  });
  const recipient = () => JSON.parse(readFileSync(join(dir, 'treasury.json'), 'utf8')).publicKey;
  const pay = service(dir, { fetchImpl });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  intentRef = intent.reference;
  let view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(view.status, 'pending');
  // A submitted signature that paid the treasury now confirms this intent.
  const fetchWithPayingTx = rpcFixture({
    getSignaturesForAddress: () => [{ signature: SIG('sigPays') }],
    getTransaction: ([sig]) => sig === SIG('sigPays') && payTransaction({ recipient: recipient(), reference: intentRef, lamports: 125_000_000 }),
  });
  const pay2 = service(dir, { fetchImpl: fetchWithPayingTx });
  view = await pay2.check(actor, quoteState(), { paymentId: intent.paymentId, signature: SIG('sigPays') });
  assert.equal(view.status, 'paid');
  assert.equal(view.payment.signature, SIG('sigPays'));
  assert.equal(view.payment.lamports, 125_000_000);
  assert.equal(view.order.status, 'FUNDED');
  assert.equal(view.order.funding.signature, SIG('sigPays'));
  assert.equal(view.order.settlement.asset, 'USDC');
  assert.equal(view.order.settlement.usdcMinor, 25_000_000); // 0.125 SOL settles at its USD value (100 PLN / 4.0)
  assert.equal(view.order.settlement.sourceAsset, 'SOL');
  assert.equal(view.order.settlement.sourceLamports, 125_000_000);
  assert.equal(view.order.execution.status, 'execution_pending'); // no executor configured
  const stored = JSON.parse(readFileSync(join(dir, 'orders', intent.paymentId + '.json'), 'utf8'));
  assert.equal(stored.quoted_amount_minor, 10000);
  assert.equal(stored.settlement.usdcMinor, 25_000_000);
  // A repeat check stays paid without further RPC work.
  assert.equal((await pay2.check(actor, quoteState(), { paymentId: intent.paymentId })).status, 'paid');
});

test('a signature that pays the treasury but lacks this intent reference is rejected', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  const fetchImpl = rpcFixture({
    getSignaturesForAddress: () => [],
    getTransaction: () => payTransaction({ recipient, reference: 'SomeOtherReference111111111111111111111', lamports: 10_000_000_000 }),
  });
  const pay = service(dir, { fetchImpl });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  const view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId, signature: SIG('sigRepay') });
  assert.equal(view.status, 'pending');
});

test('underpayment, failed transactions and foreign owners never mark an intent paid', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  const pay = service(dir, { fetchImpl: rpcFixture({
    getSignaturesForAddress: () => [{ signature: SIG('sigUnder') }],
    getTransaction: () => payTransaction({ recipient, reference: intentRef, lamports: 1 }),
  }) });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  const intentRef = intent.reference;
  assert.equal((await pay.check(actor, quoteState(), { paymentId: intent.paymentId })).status, 'pending');
  await assert.rejects(pay.check(other, quoteState(), { paymentId: intent.paymentId }), /payment_not_found/);
  const failed = service(dir, { fetchImpl: rpcFixture({
    getSignaturesForAddress: () => [{ signature: SIG('sigFailed') }],
    getTransaction: () => payTransaction({ recipient, reference: intentRef, lamports: 125_000_000, err: { InstructionError: [0, 'Custom'] } }),
  }) });
  assert.equal((await failed.check(actor, quoteState(), { paymentId: intent.paymentId })).status, 'pending');
});

test('a USDC intent confirms on a token-balance delta to the treasury owner', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  let intentRef;
  const pay = service(dir, { fetchImpl: rpcFixture({
    getSignaturesForAddress: () => [{ signature: SIG('sigUsdc') }],
    getTransaction: () => usdcTransaction({ recipient, reference: intentRef, usdcMint: DEVNET_USDC_MINT, amount: 25_000_000 }),
  }) });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'USDC' });
  intentRef = intent.reference;
  const view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(view.status, 'paid');
  assert.equal(view.payment.usdcMinor, 25_000_000);
  assert.equal(view.order.funding.asset, 'USDC');
  assert.equal(view.order.settlement.usdcMinor, 25_000_000); // USDC settles 1:1
  assert.equal(view.order.settlement.sourceAsset, 'USDC');
});

const DEST = 'EFfKkSpHwCD5bFQMvTWuMz3A6mU2yVdYGALER1afUE9i';
function settlementRpc({ recipient, ref, floatAmount = '30000000', extra = {} }) {
  const sent = [];
  const handlers = {
    getSignaturesForAddress: () => [{ signature: SIG('sigPays') }],
    getTransaction: () => payTransaction({ recipient, reference: ref(), lamports: 125_000_000 }),
    getTokenAccountBalance: () => ({ value: { amount: floatAmount, decimals: 6 } }),
    getAccountInfo: () => ({ value: null }),
    getLatestBlockhash: () => ({ value: { blockhash: base58Encode(new Uint8Array(32)) } }),
    sendTransaction: params => { sent.push(params[0]); return SIG('sigSettle'); },
    getSignatureStatuses: () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    ...extra,
  };
  return { fetchImpl: rpcFixture(handlers), sent };
}

test('a configured USDC destination receives an on-chain settlement before dispatch', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  let intentRef;
  const { fetchImpl, sent } = settlementRpc({ recipient, ref: () => intentRef });
  const pay = service(dir, { fetchImpl, settlementUsdcDestination: DEST });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  intentRef = intent.reference;
  const view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(view.status, 'paid');
  assert.equal(view.order.settlement.status, 'settled');
  assert.equal(view.order.settlement.signature, SIG('sigSettle'));
  assert.equal(view.order.settlement.destination, DEST);
  assert.equal(view.order.settlement.usdcMinor, 25_000_000);
  // The wire transaction really carries the settled amount to a token account.
  const wire = Buffer.from(sent[0], 'base64');
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(25_000_000n);
  assert.ok(wire.includes(amount), 'settlement amount not found in wire transaction');
  assert.equal(view.order.execution.status, 'execution_pending');
});

test('an insufficient USDC float blocks settlement and dispatch', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  let intentRef;
  const { fetchImpl, sent } = settlementRpc({ recipient, ref: () => intentRef, floatAmount: '100' });
  const pay = service(dir, { fetchImpl, settlementUsdcDestination: DEST });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  intentRef = intent.reference;
  const view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(view.status, 'paid');
  assert.equal(view.order.settlement.status, 'insufficient_float');
  assert.equal(sent.length, 0); // nothing was broadcast
  assert.equal(view.order.execution.status, 'execution_pending');
  // Topping up the float unblocks settlement on the next status check.
  const topped = settlementRpc({ recipient, ref: () => intentRef, floatAmount: '30000000' });
  const pay2 = service(dir, { fetchImpl: topped.fetchImpl, settlementUsdcDestination: DEST });
  const retry = await pay2.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(retry.order.settlement.status, 'settled');
});

test('stale quotes supersede the intent and expiry stops verification', async t => {
  const dir = await directory(t), pay = service(dir, { fetchImpl: rpcFixture({}) });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  const moved = quoteState({ quote: { quoteId: 'quote-2', version: 4, status: 'verified', observedAt: Date.now() - 1000, expiresAt: Date.now() + 240_000, amounts: { totalMinor: 5000 } } });
  assert.equal((await pay.check(actor, { ...moved, version: 4 }, { paymentId: intent.paymentId })).status, 'superseded');
  const second = pay.createIntent(actor, { ...moved, version: 4 }, { quoteId: 'quote-2', version: 4, asset: 'SOL' });
  const fastClock = service(dir, { clock: () => Date.now() + 60 * 60 * 1000, fetchImpl: rpcFixture({}) });
  assert.equal((await fastClock.check(actor, { ...moved, version: 4 }, { paymentId: second.paymentId })).status, 'expired');
});

test('a configured executor command is invoked once with the funded order path', async t => {
  const dir = await directory(t);
  const probe = service(dir); const recipient = probe.config().recipient;
  const calls = [];
  let intentRef;
  const pay = service(dir, {
    fetchImpl: rpcFixture({
      getSignaturesForAddress: () => [{ signature: SIG('sigExec') }],
      getTransaction: () => payTransaction({ recipient, reference: intentRef, lamports: 125_000_000 }),
    }),
    invoke: (cmd, args) => { calls.push([cmd, args]);
      const handlers = {}; let stdoutCb;
      setImmediate(() => handlers.exit?.(0));
      return { stdout: { on: (e, cb) => { stdoutCb = cb; } }, stderr: { resume() {} }, on: (e, cb) => { handlers[e] = cb; }, kill() {} };
    },
    executorCommand: '/usr/bin/true',
  });
  const intent = pay.createIntent(actor, quoteState(), { quoteId: 'quote-1', version: 3, asset: 'SOL' });
  intentRef = intent.reference;
  const view = await pay.check(actor, quoteState(), { paymentId: intent.paymentId });
  assert.equal(view.status, 'paid');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/true');
  assert.ok(calls[0][1][0].endsWith(join('orders', intent.paymentId + '.json')));
  assert.equal(view.order.execution.status, 'executed');
});
