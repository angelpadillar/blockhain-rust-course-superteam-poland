// The generated client must produce the bytes the program parses and read the
// accounts it writes. The vectors come from the Rust tests
// (programs/will_escrow/tests/vectors.rs), which build them from the same
// structs the program uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AccountRole, address, createNoopSigner, getAddressDecoder } from '@solana/kit';
import * as client from '../dist/index.js';

const program = new URL('../../../programs/will_escrow/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, program), 'utf8'));
const idl = read('idl/will_escrow.json').program;
const instructionVectors = read('tests/vectors/instructions.json');
const accountVectors = read('tests/vectors/accounts.json');
const pdas = read('tests/vectors/pdas.json');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const definedTypes = Object.fromEntries(idl.definedTypes.map((t) => [t.name, t.type]));
const pascal = (name) => name[0].toUpperCase() + name.slice(1);
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

/** Converts a vector's JSON value to the client's type, guided by the IDL. */
function value(type, json) {
  switch (type.kind) {
    case 'numberTypeNode':
      return ['u64', 'i64'].includes(type.format) ? BigInt(json) : json;
    case 'publicKeyTypeNode':
      return address(json);
    case 'fixedSizeTypeNode':
      return type.type.kind === 'stringTypeNode' ? json : fromHex(json);
    case 'arrayTypeNode':
      return json.map((item) => value(type.item, item));
    case 'definedTypeLinkNode':
      return value(definedTypes[type.name], json);
    case 'structTypeNode':
      return Object.fromEntries(type.fields.map((f) => [f.name, value(f.type, json[f.name])]));
    default:
      throw new Error(`no conversion for ${type.kind}`);
  }
}

function args(name, json) {
  const node = idl.instructions.find((instruction) => instruction.name === name);
  const inputs = node.arguments.filter((argument) => argument.name !== 'discriminator');
  assert.deepEqual(Object.keys(json).sort(), inputs.map((a) => a.name).sort(), name);
  return Object.fromEntries(inputs.map((a) => [a.name, value(a.type, json[a.name])]));
}

test('every instruction has a vector', () => {
  assert.deepEqual(
    instructionVectors.map((v) => v.name).sort(),
    idl.instructions.map((i) => i.name).sort(),
  );
});

for (const vector of instructionVectors) {
  test(`${vector.name} data matches the program`, () => {
    const encoder = client[`get${pascal(vector.name)}InstructionDataEncoder`]();
    const decoder = client[`get${pascal(vector.name)}InstructionDataDecoder`]();
    const input = args(vector.name, vector.args);
    assert.equal(toHex(encoder.encode(input)), vector.data);
    const { discriminator, ...decoded } = decoder.decode(fromHex(vector.data));
    assert.equal(discriminator, fromHex(vector.data)[0]);
    assert.deepEqual(decoded, input);
  });
}

for (const [name, size] of [['config', 275], ['job', 334]]) {
  test(`decodes and encodes a ${name} account`, () => {
    const { data, fields } = accountVectors[name];
    const node = idl.accounts.find((account) => account.name === name);
    const expected = value(node.data, fields);
    const bytes = fromHex(data);
    assert.deepEqual(client[`get${pascal(name)}Decoder`]().decode(bytes), expected);
    assert.equal(toHex(client[`get${pascal(name)}Encoder`]().encode(expected)), data);
    assert.equal(client[`get${pascal(name)}Size`](), size);
    assert.equal(client.identifyWillEscrowAccount(bytes), client.WillEscrowAccount[pascal(name)]);
  });
}

test('accounts are identified by tag and size, like the program loads them', () => {
  const job = fromHex(accountVectors.job.data);
  job[0] = 3;
  assert.throws(() => client.identifyWillEscrowAccount(job), 'unknown tag');
  job[0] = 1;
  assert.throws(() => client.identifyWillEscrowAccount(job), 'config tag at job size');
  const truncated = fromHex(accountVectors.job.data).slice(0, 275);
  assert.throws(() => client.identifyWillEscrowAccount(truncated), 'job tag at config size');
});

test('program and PDA helpers match the program', async () => {
  assert.equal(client.WILL_ESCROW_PROGRAM_ADDRESS, pdas.programId);
  assert.deepEqual(await client.findConfigPda(), [pdas.config.address, pdas.config.bump]);
  const job = await client.findJobPda({
    customer: address(pdas.job.customer),
    jobId: BigInt(pdas.job.jobId),
  });
  assert.deepEqual(job, [pdas.job.address, pdas.job.bump]);
  const vault = await client.findVaultPda({ job: address(pdas.vault.job) });
  assert.deepEqual(vault, [pdas.vault.address, pdas.vault.bump]);
});

/** The vectors' `[byte; 32]` addresses. */
const key = (byte) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));

test('createJob resolves config, job, vault and program accounts', async () => {
  const customer = createNoopSigner(address(pdas.job.customer));
  const rentPayer = createNoopSigner(key(0x22));
  const input = args('createJob', instructionVectors.find((v) => v.name === 'createJob').args);
  const instruction = await client.getCreateJobInstructionAsync({
    ...input,
    customer,
    customerToken: key(0x33),
    rentPayer,
    mint: key(0x44),
  });
  assert.equal(input.jobId, BigInt(pdas.job.jobId));
  assert.deepEqual(
    instruction.accounts.map((account) => account.address),
    [
      pdas.config.address,
      pdas.job.address,
      pdas.vault.address,
      customer.address,
      key(0x33),
      rentPayer.address,
      key(0x44),
      TOKEN_PROGRAM,
      SYSTEM_PROGRAM,
    ],
  );
});

test('initializeConfig defaults ProgramData and appends funding accounts', async () => {
  const input = args('initializeConfig', instructionVectors.find((v) => v.name === 'initializeConfig').args);
  const instruction = await client.getInitializeConfigInstructionAsync({
    ...input,
    upgradeAuthority: createNoopSigner(key(0x22)),
    mint: key(0x44),
    funding: [key(0x55), key(0x33)],
  });
  assert.deepEqual(
    instruction.accounts.map((account) => account.address),
    [pdas.config.address, key(0x22), pdas.programData, key(0x44), SYSTEM_PROGRAM, key(0x55), key(0x33)],
  );
});

test('cancel appends the optional return source', async () => {
  const base = {
    job: address(pdas.vault.job),
    customerToken: key(0x33),
    rentPayer: key(0x22),
    signer: createNoopSigner(key(0x44)),
  };
  const without = await client.getCancelInstructionAsync({ ...base, returned: 0n, returnSource: [] });
  assert.equal(without.accounts.length, 7);
  assert.equal(without.accounts[2].address, pdas.vault.address);
  const withSource = await client.getCancelInstructionAsync({ ...base, returned: 5n, returnSource: [key(0x55)] });
  assert.equal(withSource.accounts.length, 8);
  assert.equal(withSource.accounts[7].address, key(0x55));
  assert.equal(withSource.accounts[7].role, AccountRole.WRITABLE, 'the program debits the return source');
});
