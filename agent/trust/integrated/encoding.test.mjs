import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalTermsBytes, canonicalTermsHash, hashCommitment,
  PROGRAM_ID_HEX, CANONICAL_TERMS_BYTE_LENGTH } from './encoding.mjs';

const repeatByte = value => value.toString(16).padStart(2, '0').repeat(32);

// Published independently encoded Rust/Python vector in
// project/programs/gift_campaign/tests/cases/mandate.rs. Its deliberately
// different campaign identities test encoding, not mandate authorization.
function publishedInputs() {
  return {
    programId: 'd02cbed1e1f3f815ef8d3e51cd70bbf114f8af99534b4031044a66a147b83640',
    campaignKey: repeatByte(1), mandateKey: repeatByte(2),
    config: { allowedMint: repeatByte(3), feeBps: 500 },
    mandate: {
      campaign: repeatByte(4), sender: repeatByte(5), executor: repeatByte(6),
      merchantHash: repeatByte(7), specHash: repeatByte(8), recipientHash: repeatByte(9),
      chargeCurrency: 'EUR', chargeCurrencyExponent: 2,
      maxChargeAmountMinor: '10000', maxEscrowDebit: '20000', expiresAt: '4000',
    },
    campaign: {
      quoteVersion: 12, jobKind: 1, adapter: 2,
      specHash: repeatByte(8), quoteHash: repeatByte(10), merchantHash: repeatByte(7),
      currency: 'PLN', currencyExponent: 2, chargeCurrency: 'EUR', chargeCurrencyExponent: 2,
      itemSubtotalMinor: '101', smallOrderFeeMinor: '102', serviceFeeMinor: '103',
      deliveryFeeMinor: '104', tipMinor: '105', otherFeesMinor: '106', landedTotalMinor: '107',
      maxTotalMinor: '108', settlementAmount: '109', quotedChargeAmountMinor: '110',
      settlementUnitsPerChargeUnitMicros: '111', quoteCapturedAt: '2000',
      quoteExpiresAt: '3000', expiresAt: '5000',
    },
  };
}

test('matches the published 602-byte Rust/Python commitment vector', () => {
  const inputs = publishedInputs();
  const bytes = canonicalTermsBytes(inputs);
  assert.equal(PROGRAM_ID_HEX, inputs.programId);
  assert.equal(bytes.length, 602);
  assert.equal(CANONICAL_TERMS_BYTE_LENGTH, 602);
  assert.equal(canonicalTermsHash(inputs), 'e6367d2fc9f36ad885022a42e1456af7d67e705e435b9e0fa4ada4c8b1395f89');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), canonicalTermsHash(inputs));
  // Independent fixed offsets expose field order, raw bytes and little-endian widths.
  assert.equal(bytes.subarray(0, 30).toString('ascii'), 'gift-campaign:mandate-quote:v1');
  assert.equal(bytes.subarray(30, 62).toString('hex'), inputs.programId);
  assert.equal(bytes.subarray(254, 256).toString('hex'), 'f401'); // u16 fee
  assert.equal(bytes.subarray(320, 352).toString('hex'), repeatByte(9)); // recipient
  assert.equal(bytes.subarray(352, 356).toString('hex'), '45555202'); // EUR, exponent
  assert.equal(bytes.subarray(356, 364).toString('hex'), '1027000000000000'); // u64 10000
  assert.equal(bytes.subarray(380, 386).toString('hex'), '0c0000000102'); // version, kind, adapter
  assert.equal(bytes.subarray(490, 498).toString('hex'), '6500000000000000'); // subtotal 101
  assert.equal(bytes.subarray(594, 602).toString('hex'), '8813000000000000'); // i64 5000
});

test('uses exact 64-bit values and two-complement little-endian signed timestamps', () => {
  const inputs = publishedInputs();
  inputs.config.feeBps = 65535;
  inputs.campaign.quoteVersion = 4294967295;
  inputs.campaign.adapter = 255;
  inputs.mandate.maxChargeAmountMinor = '18446744073709551615';
  inputs.mandate.maxEscrowDebit = '9007199254740993';
  inputs.mandate.expiresAt = '-9223372036854775808';
  inputs.campaign.quoteCapturedAt = '-1';
  inputs.campaign.quoteExpiresAt = '9223372036854775807';
  const bytes = canonicalTermsBytes(inputs);
  assert.equal(bytes.subarray(254, 256).toString('hex'), 'ffff');
  assert.equal(bytes.subarray(356, 364).toString('hex'), 'ffffffffffffffff');
  assert.equal(bytes.subarray(364, 372).toString('hex'), '0100000000002000');
  assert.equal(bytes.subarray(372, 380).toString('hex'), '0000000000000080');
  assert.equal(bytes.subarray(380, 384).toString('hex'), 'ffffffff');
  assert.equal(bytes[385], 255);
  assert.equal(bytes.subarray(578, 586).toString('hex'), 'ffffffffffffffff');
  assert.equal(bytes.subarray(586, 594).toString('hex'), 'ffffffffffffff7f');
});

test('price, merchant, recipient, expiry and currency mutations invalidate the hash', () => {
  const original = publishedInputs();
  const expected = canonicalTermsHash(original);
  for (const [group, field, changed] of [
    ['campaign', 'quotedChargeAmountMinor', '111'],
    ['campaign', 'merchantHash', repeatByte(11)],
    ['mandate', 'recipientHash', repeatByte(12)],
    ['mandate', 'expiresAt', '4001'],
    ['campaign', 'chargeCurrency', 'USD'],
  ]) {
    const inputs = structuredClone(original);
    inputs[group][field] = changed;
    assert.notEqual(canonicalTermsHash(inputs), expected, `${group}.${field}`);
  }
});

test('every exposed canonical field is bound and object insertion order is irrelevant', () => {
  const original = publishedInputs();
  const expected = canonicalTermsHash(original);
  for (const [group, record] of Object.entries(original)) {
    const entries = typeof record === 'object' ? Object.entries(record) : [[null, record]];
    for (const [key, value] of entries) {
      if (group === 'programId') continue; // This program identifier is fixed, not selectable.
      let replacement;
      if (typeof value === 'number') replacement = value + 1;
      else if (/^[0-9a-f]{64}$/.test(value)) replacement = `${value[0] === 'f' ? 'e' : 'f'}${value.slice(1)}`;
      else if (/^[A-Z]{3}$/.test(value)) replacement = 'USD';
      else replacement = (BigInt(value) + 1n).toString();
      const inputs = structuredClone(original);
      if (key === null) inputs[group] = replacement;
      else inputs[group][key] = replacement;
      assert.notEqual(canonicalTermsHash(inputs), expected, `${group}.${key ?? ''}`);
    }
  }
  const reverse = object => Object.fromEntries(Object.entries(object).reverse().map(([key, value]) =>
    [key, value && typeof value === 'object' ? reverse(value) : value]));
  assert.equal(canonicalTermsHash(reverse(original)), expected);
  const bytes = canonicalTermsBytes(original);
  bytes.fill(0);
  assert.equal(canonicalTermsHash(original), expected, 'caller buffer mutation must not affect future hashes');
});

test('rejects truncated hex, ambiguous numbers, overflow and ignored fields', () => {
  for (const [group, field, value] of [
    ['mandate', 'maxChargeAmountMinor', 9007199254740992],
    ['mandate', 'maxChargeAmountMinor', 10000],
    ['mandate', 'maxChargeAmountMinor', '010000'],
    ['mandate', 'maxChargeAmountMinor', '+10000'],
    ['mandate', 'maxChargeAmountMinor', '1e4'],
    ['mandate', 'maxChargeAmountMinor', '10000.0'],
    ['mandate', 'maxChargeAmountMinor', ' 10000'],
    ['mandate', 'maxChargeAmountMinor', '-1'],
    ['mandate', 'maxChargeAmountMinor', '18446744073709551616'],
    ['mandate', 'expiresAt', '-0'],
    ['mandate', 'expiresAt', '-9223372036854775809'],
    ['mandate', 'expiresAt', '9223372036854775808'],
    ['mandate', 'merchantHash', 'aa'],
    ['mandate', 'merchantHash', 'GG'.repeat(32)],
    ['mandate', 'merchantHash', 'AA'.repeat(32)],
    ['mandate', 'chargeCurrency', 'eur'],
    ['mandate', 'chargeCurrency', '€UR'],
    ['mandate', 'chargeCurrencyExponent', 256],
    ['campaign', 'quoteVersion', 4294967296],
    ['campaign', 'adapter', -1],
    ['campaign', 'adapter', -0],
    ['campaign', 'jobKind', 0.5],
    ['config', 'feeBps', '500'],
  ]) {
    const inputs = publishedInputs();
    inputs[group][field] = value;
    assert.throws(() => canonicalTermsBytes(inputs), undefined, `${group}.${field}`);
  }
  const wrongProgram = publishedInputs();
  wrongProgram.programId = repeatByte(99);
  assert.throws(() => canonicalTermsHash(wrongProgram), /programId/);
  const missing = publishedInputs();
  delete missing.campaign.deliveryFeeMinor;
  assert.throws(() => canonicalTermsHash(missing), /canonical fields/);
  const extra = publishedInputs();
  extra.campaign.recipientHash = repeatByte(9);
  assert.throws(() => canonicalTermsHash(extra), /canonical fields/);
});

test('fixture commitments use explicit domain separation and deterministic JSON', () => {
  const item = { kind: 'item', merchant: 'Paper Studio', product: 'Notebook', quantity: 2, variant: 'A5 / blue' };
  const canonical = '{"kind":"item","merchant":"Paper Studio","product":"Notebook","quantity":2,"variant":"A5 / blue"}';
  const expected = createHash('sha256').update('gift-campaign:fixture-commitment:v1\0').update(canonical).digest('hex');
  // Independently computed with Python hashlib, using the literal canonical text above.
  assert.equal(expected, 'ff4e8b5c76cb1c7dabceadf0010fae136885ae4e4409020b91a49b3c962b326e');
  assert.equal(hashCommitment(item), expected);
  assert.notEqual(expected, createHash('sha256').update(canonical).digest('hex'));
  assert.equal(hashCommitment({ variant: 'A5 / blue', quantity: 2, product: 'Notebook', merchant: 'Paper Studio', kind: 'item' }), expected);
  for (const change of [{ quantity: 3 }, { variant: 'A5 / red' }, { merchant: 'Another shop' }, { kind: 'merchant' }]) {
    assert.notEqual(hashCommitment({ ...item, ...change }), expected);
  }
  assert.notEqual(hashCommitment({ kind: 'recipient', reference: 'recipient-a' }),
    hashCommitment({ kind: 'recipient', reference: 'recipient-b' }));
  assert.notEqual(hashCommitment({ kind: 'quote', totalMinor: 2 }), hashCommitment({ kind: 'quote', totalMinor: '2' }));
  assert.notEqual(hashCommitment({ kind: 'item', variants: ['blue', 'red'] }),
    hashCommitment({ kind: 'item', variants: ['red', 'blue'] }));
  assert.equal(hashCommitment({ kind: 'quote', data: { z: true, a: null } }),
    hashCommitment({ data: { a: null, z: true }, kind: 'quote' }));
});

test('fixture commitment serialization fails closed on lossy or non-JSON values', () => {
  for (const value of [undefined, NaN, Infinity, -0, 0.5, 9007199254740992, 1n,
    new Date(0), Buffer.from('secret'), () => 1, [undefined], Array(1)]) {
    assert.throws(() => hashCommitment({ kind: 'item', value }));
  }
  assert.throws(() => hashCommitment({ value: 'missing kind' }), /kind/);
  const cycle = { kind: 'item' };
  cycle.self = cycle;
  assert.throws(() => hashCommitment(cycle), /cycles/);
  const getter = { kind: 'item', get value() { throw new Error('must never execute'); } };
  assert.throws(() => hashCommitment(getter), /data fields/);
  assert.throws(() => hashCommitment({ kind: 'item', [Symbol('ignored')]: 'hidden' }), /data fields/);
  const array = ['value'];
  array.hidden = 'not JSON';
  assert.throws(() => hashCommitment({ kind: 'item', value: array }), /dense/);
});
