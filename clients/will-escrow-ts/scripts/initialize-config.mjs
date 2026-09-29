// Initializes will_escrow's config, signed by the program's upgrade authority.
// Run `npm run build` first.
//
//   WILL_UPGRADE_AUTHORITY_KEYPAIR=path/to/deployer.json node scripts/initialize-config.mjs \
//     --cluster devnet --mint <mint> --admin <pubkey> --operator <pubkey> \
//     --treasury <pubkey> --funding <token account> [--funding ...]
//
// Defaults: 5% fee, 24 h dispute window, 7-day job timeout, 14-day dispute
// timeout. mainnet-beta also needs CONFIRM_MAINNET=will_escrow.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  getU64Encoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { fetchMaybeConfig, findConfigPda, getInitializeConfigInstructionAsync } from '../dist/index.js';

const CLUSTERS = {
  localnet: ['http://127.0.0.1:8899', 'ws://127.0.0.1:8900'],
  devnet: ['https://api.devnet.solana.com', 'wss://api.devnet.solana.com'],
  'mainnet-beta': ['https://api.mainnet-beta.solana.com', 'wss://api.mainnet-beta.solana.com'],
};
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111');

const { values } = parseArgs({
  options: {
    cluster: { type: 'string' },
    mint: { type: 'string' },
    admin: { type: 'string' },
    operator: { type: 'string' },
    treasury: { type: 'string' },
    funding: { type: 'string', multiple: true },
    'fee-bps': { type: 'string', default: '500' },
    'dispute-window': { type: 'string', default: '86400' },
    'job-timeout': { type: 'string', default: '604800' },
    'dispute-timeout': { type: 'string', default: '1209600' },
    'compute-unit-price': { type: 'string', default: '0' },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const endpoints = CLUSTERS[values.cluster] ?? fail(`--cluster must be one of ${Object.keys(CLUSTERS)}`);
if (values.cluster === 'mainnet-beta' && process.env.CONFIRM_MAINNET !== 'will_escrow') {
  fail('refusing mainnet: needs the security review and explicit approval (CONFIRM_MAINNET=will_escrow)');
}
for (const name of ['mint', 'admin', 'operator', 'treasury']) {
  if (!values[name]) fail(`--${name} is required`);
}
if (!values.funding?.length || values.funding.length > 4) fail('pass 1 to 4 --funding token accounts');
const keypairPath = process.env.WILL_UPGRADE_AUTHORITY_KEYPAIR ?? fail('set WILL_UPGRADE_AUTHORITY_KEYPAIR');

const [rpcUrl, wsUrl] = [process.env.RPC_URL ?? endpoints[0], process.env.RPC_WS_URL ?? endpoints[1]];
const rpc = createSolanaRpc(rpcUrl);
const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
const upgradeAuthority = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))),
);
const [configAddress] = await findConfigPda();

const printConfig = (config) =>
  console.log(
    JSON.stringify(config.data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );

const existing = await fetchMaybeConfig(rpc, configAddress);
if (existing.exists) {
  console.log(`config ${configAddress} already initialized`);
  printConfig(existing);
  process.exit(0);
}

const initialize = await getInitializeConfigInstructionAsync({
  upgradeAuthority,
  mint: address(values.mint),
  feeBps: Number(values['fee-bps']),
  disputeWindow: Number(values['dispute-window']),
  jobTimeout: Number(values['job-timeout']),
  disputeTimeout: Number(values['dispute-timeout']),
  admin: address(values.admin),
  operator: address(values.operator),
  treasury: address(values.treasury),
  funding: values.funding.map(address),
});
const price = BigInt(values['compute-unit-price']);
const instructions = price > 0n
  ? [{ programAddress: COMPUTE_BUDGET, data: Uint8Array.of(3, ...getU64Encoder().encode(price)) }, initialize]
  : [initialize];

const { value: blockhash } = await rpc.getLatestBlockhash().send();
const transaction = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(upgradeAuthority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  ),
);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(transaction, { commitment: 'confirmed' });
console.log(`initialized config ${configAddress}: ${getSignatureFromTransaction(transaction)}`);
printConfig(await fetchMaybeConfig(rpc, configAddress));
