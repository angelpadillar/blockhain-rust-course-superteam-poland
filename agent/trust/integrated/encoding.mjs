import { createHash } from 'node:crypto';

export const PROGRAM_ID_HEX = 'd02cbed1e1f3f815ef8d3e51cd70bbf114f8af99534b4031044a66a147b83640';
export const CANONICAL_TERMS_BYTE_LENGTH = 602;
const TERMS_DOMAIN = 'gift-campaign:mandate-quote:v1';
const COMMITMENT_DOMAIN = 'gift-campaign:fixture-commitment:v1\0';
const COMMITMENT_KINDS = new Set(['merchant', 'item', 'recipient', 'quote']);
const ROOT_FIELDS = ['programId', 'campaignKey', 'mandateKey', 'config', 'mandate', 'campaign'];
const CONFIG_FIELDS = ['allowedMint', 'feeBps'];
const MANDATE_FIELDS = ['campaign', 'sender', 'executor', 'merchantHash', 'specHash', 'recipientHash',
  'chargeCurrency', 'chargeCurrencyExponent', 'maxChargeAmountMinor', 'maxEscrowDebit', 'expiresAt'];
const CAMPAIGN_AMOUNTS = ['itemSubtotalMinor', 'smallOrderFeeMinor', 'serviceFeeMinor',
  'deliveryFeeMinor', 'tipMinor', 'otherFeesMinor', 'landedTotalMinor', 'maxTotalMinor',
  'settlementAmount', 'quotedChargeAmountMinor', 'settlementUnitsPerChargeUnitMicros'];
const CAMPAIGN_FIELDS = ['quoteVersion', 'jobKind', 'adapter', 'specHash', 'quoteHash', 'merchantHash',
  'currency', 'currencyExponent', 'chargeCurrency', 'chargeCurrencyExponent', ...CAMPAIGN_AMOUNTS,
  'quoteCapturedAt', 'quoteExpiresAt', 'expiresAt'];

function plainRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${path} must contain only enumerable string-keyed data fields`);
    }
  }
  return value;
}

function exactRecord(value, keys, path) {
  plainRecord(value, path);
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${path} must contain exactly the canonical fields`);
  }
  return value;
}

function fixedHex(value, path) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${path} must be exactly 32 bytes of lowercase hexadecimal`);
  }
  return Buffer.from(value, 'hex');
}

function smallInteger(value, bytes, path) {
  if (typeof value !== 'number' || !Number.isInteger(value) || Object.is(value, -0)
      || value < 0 || value > 2 ** (bytes * 8) - 1) {
    throw new TypeError(`${path} must be an unsigned ${bytes * 8}-bit integer number`);
  }
  const output = Buffer.alloc(bytes);
  output.writeUIntLE(value, 0, bytes);
  return output;
}

function integer64(value, signed, path) {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${path} must be a canonical decimal integer string`);
  }
  const integer = BigInt(value);
  const min = signed ? -(1n << 63n) : 0n;
  const max = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (integer < min || integer > max) throw new RangeError(`${path} is outside its 64-bit range`);
  const output = Buffer.alloc(8);
  if (signed) output.writeBigInt64LE(integer);
  else output.writeBigUInt64LE(integer);
  return output;
}

function currency(value, path) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError(`${path} must be three uppercase ASCII currency bytes`);
  }
  return Buffer.from(value, 'ascii');
}

/**
 * Byte-for-byte Rust mandate::quote_terms_hash v1 encoding (602 bytes).
 * Input uses camelCase field names; pubkeys/hashes are 64 lowercase hex chars;
 * u64/i64 values are decimal strings; u8/u16/u32 values are integer numbers.
 * Fixed fields are raw bytes; integers are little-endian, signed i64 uses two's
 * complement. There are no length prefixes or separators in this fixed layout.
 * Program ID is fixed to the staged Rust program. Extra/missing fields fail.
 *
 * This encodes commitments, not authorization: the on-chain program checks
 * actor, bindings, caps and expiry. In particular, it makes no FX conversion
 * guarantee and does not establish that a real website matches an opaque hash.
 */
export function canonicalTermsBytes(inputs) {
  exactRecord(inputs, ROOT_FIELDS, 'inputs');
  const config = exactRecord(inputs.config, CONFIG_FIELDS, 'config');
  const mandate = exactRecord(inputs.mandate, MANDATE_FIELDS, 'mandate');
  const campaign = exactRecord(inputs.campaign, CAMPAIGN_FIELDS, 'campaign');
  if (inputs.programId !== PROGRAM_ID_HEX) throw new TypeError('programId does not match the staged program');
  const parts = [Buffer.from(TERMS_DOMAIN, 'ascii')];
  for (const [path, value] of [
    ['programId', inputs.programId], ['campaignKey', inputs.campaignKey], ['mandateKey', inputs.mandateKey],
    ['config.allowedMint', config.allowedMint], ['mandate.campaign', mandate.campaign],
    ['mandate.sender', mandate.sender], ['mandate.executor', mandate.executor],
  ]) parts.push(fixedHex(value, path));
  parts.push(smallInteger(config.feeBps, 2, 'config.feeBps'));
  for (const key of ['merchantHash', 'specHash', 'recipientHash']) parts.push(fixedHex(mandate[key], `mandate.${key}`));
  parts.push(currency(mandate.chargeCurrency, 'mandate.chargeCurrency'));
  parts.push(smallInteger(mandate.chargeCurrencyExponent, 1, 'mandate.chargeCurrencyExponent'));
  for (const key of ['maxChargeAmountMinor', 'maxEscrowDebit']) parts.push(integer64(mandate[key], false, `mandate.${key}`));
  parts.push(integer64(mandate.expiresAt, true, 'mandate.expiresAt'));
  parts.push(smallInteger(campaign.quoteVersion, 4, 'campaign.quoteVersion'));
  for (const key of ['jobKind', 'adapter']) parts.push(smallInteger(campaign[key], 1, `campaign.${key}`));
  for (const key of ['specHash', 'quoteHash', 'merchantHash']) parts.push(fixedHex(campaign[key], `campaign.${key}`));
  parts.push(currency(campaign.currency, 'campaign.currency'));
  parts.push(smallInteger(campaign.currencyExponent, 1, 'campaign.currencyExponent'));
  parts.push(currency(campaign.chargeCurrency, 'campaign.chargeCurrency'));
  parts.push(smallInteger(campaign.chargeCurrencyExponent, 1, 'campaign.chargeCurrencyExponent'));
  for (const key of CAMPAIGN_AMOUNTS) parts.push(integer64(campaign[key], false, `campaign.${key}`));
  for (const key of ['quoteCapturedAt', 'quoteExpiresAt', 'expiresAt']) parts.push(integer64(campaign[key], true, `campaign.${key}`));
  return Buffer.concat(parts);
}

export function canonicalTermsHash(inputs) {
  return createHash('sha256').update(canonicalTermsBytes(inputs)).digest('hex');
}

/**
 * Local fixture commitment protocol, separate from the fixed Rust terms layout.
 * SHA256(UTF8("gift-campaign:fixture-commitment:v1\0") || canonicalJSON).
 * The root must be a plain object with kind merchant/item/recipient/quote.
 * Recursively sort object keys by UTF-16 code units, preserve array order, use
 * JSON string escapes without Unicode normalization, and allow only null,
 * strings, booleans and safe integer numbers (no -0). 64-bit fixture amounts
 * should be decimal strings. Reject undefined, holes, cycles and class objects.
 *
 * The caller must include the complete intended identity. An item object should
 * include merchant identity, product, variant and quantity; recipient objects
 * should use a commitment-safe identifier, not public personal address data.
 * Rust treats these 32-byte hashes as opaque and cannot validate their contents.
 */
export function hashCommitment(object) {
  plainRecord(object, 'commitment');
  if (!Object.hasOwn(object, 'kind') || !COMMITMENT_KINDS.has(object.kind)) {
    throw new TypeError('commitment.kind must be merchant, item, recipient or quote');
  }
  const ancestors = new Set();
  function encode(value, depth) {
    if (depth > 32) throw new TypeError('commitment nesting exceeds 32 levels');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('commitment numbers must be safe integers');
      return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new TypeError('commitment must contain only JSON data');
    if (ancestors.has(value)) throw new TypeError('commitment must not contain cycles');
    ancestors.add(value);
    let encoded;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1
          || Array.from({ length: value.length }, (_, index) => index).some(index =>
            !Object.hasOwn(value, index) || !('value' in Object.getOwnPropertyDescriptor(value, String(index))))) {
        throw new TypeError('commitment arrays must be dense data arrays without extra fields');
      }
      encoded = `[${value.map(item => encode(item, depth + 1)).join(',')}]`;
    } else {
      plainRecord(value, 'commitment object');
      encoded = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${encode(value[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(value);
    return encoded;
  }
  return createHash('sha256').update(COMMITMENT_DOMAIN, 'utf8').update(encode(object, 0), 'utf8').digest('hex');
}
