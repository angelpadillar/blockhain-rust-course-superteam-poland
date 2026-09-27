import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin } from '@privy-io/react-auth';
import { toSolanaWalletConnectors, useWallets, useSignTransaction, useSignAndSendTransaction } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';

// Devnet pay island for a verified Delio quote. Privy supplies the wallet UI —
// external Solana wallets or an embedded wallet behind email login. The island
// builds the transfer transaction client-side with the intent's unique
// reference account, the wallet signs and broadcasts it, and the server
// confirms the transfer on devnet. Nothing here trusts a client claim: the
// server reads the chain itself.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = bytes => {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  if (zeros === bytes.length) return '1'.repeat(zeros);
  return '1'.repeat(zeros) + digits.reverse().map(d => B58[d]).join('');
};
const pln = minor => new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(minor / 100);
const sol = lamports => `${(lamports / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
const usdc = minor => `${(minor / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
const short = value => value && value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
const assetAmount = payment => payment?.asset === 'USDC' ? usdc(payment.expectedUsdcMinor) : sol(payment?.expectedLamports ?? 0);
const settlementText = s => {
  const amount = `${usdc(s.usdcMinor)} settled`;
  if (s.status === 'settled') return `${amount} as USDC delivered to your account on-chain`;
  if (s.status === 'accounted') return `${amount} as USDC for fulfillment`;
  if (s.status === 'insufficient_float') return `USDC settlement pending treasury funds — it retries automatically`;
  if (s.status === 'failed') return `USDC settlement hit an error — it retries automatically`;
  return `delivering ${usdc(s.usdcMinor)} USDC on-chain…`;
};

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* fallthrough */ }
  return { ok: response.ok && payload?.ok !== false, status: response.status, ...(payload || {}) };
}

const walletName = wallet => wallet?.standardWallet?.name || (wallet?.type === 'embedded' ? 'Privy wallet' : 'Wallet');
const friendly = error => {
  const text = String(error?.message || error || 'request_failed');
  if (/rejected|declined|denied|cancel/i.test(text)) return 'The wallet declined the transaction. Nothing was sent.';
  if (/insufficient|balance/i.test(text)) return 'The wallet reports insufficient devnet funds. Airdrop devnet SOL or USDC and retry.';
  return text.slice(0, 300);
};

function PayPanel({ context, config }) {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const [payment, setPayment] = useState(context.payment?.status ? context.payment : null);
  const [walletIndex, setWalletIndex] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const wallet = wallets[walletIndex] || wallets[0];

  const createIntent = useCallback(async (asset) => {
    setBusy('Creating a payment request'); setError('');
    const result = await api('/api/pay/intent', { quoteId: context.quoteId, version: context.version, asset });
    setBusy('');
    if (!result.ok || !result.payment) { setError(result.code ? `Could not create the payment request: ${result.code.replace(/_/g, ' ')}.` : 'Could not create the payment request.'); return null; }
    setPayment(result.payment);
    return result.payment;
  }, [context.quoteId, context.version]);

  useEffect(() => {
    if (!payment || payment.status !== 'pending') return undefined;
    pollRef.current = setInterval(async () => {
      const result = await api('/api/pay/status', { paymentId: payment.paymentId });
      if (result.ok && result.payment) setPayment(result.payment);
    }, 3000);
    return () => clearInterval(pollRef.current);
  }, [payment?.paymentId, payment?.status]);

  const buildTransaction = useCallback(async () => {
    const connection = new Connection(config.rpcHttpUrl, 'confirmed');
    const payer = new PublicKey(wallet.address);
    const recipient = new PublicKey(payment.recipient);
    const reference = new PublicKey(payment.reference);
    const transaction = new Transaction();
    if (payment.asset === 'USDC') {
      const mint = new PublicKey(config.usdcMint);
      const source = await getAssociatedTokenAddress(mint, payer);
      const destination = await getAssociatedTokenAddress(mint, recipient);
      // The sender funds the treasury's devnet USDC token account when needed —
      // idempotent, so it is a no-op once the account exists.
      transaction.add(createAssociatedTokenAccountIdempotentInstruction(payer, destination, recipient, mint));
      const instruction = createTransferCheckedInstruction(source, mint, destination, payer, BigInt(payment.expectedUsdcMinor), 6);
      instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
      transaction.add(instruction);
    } else {
      const instruction = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: payment.expectedLamports });
      instruction.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
      transaction.add(instruction);
    }
    transaction.feePayer = payer;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    return transaction;
  }, [config.rpcHttpUrl, config.usdcMint, payment, wallet]);

  const pay = useCallback(async () => {
    setError('');
    try {
      setBusy('Waiting for your wallet to sign');
      const transaction = await buildTransaction();
      const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      let encoded;
      try {
        // Preferred: the wallet signs and broadcasts itself (worked for Nightly).
        const result = await signAndSendTransaction({ transaction: serialized, wallet, chain: 'solana:devnet' });
        const signature = result?.signature;
        encoded = typeof signature === 'string' ? signature : base58(signature instanceof Uint8Array ? signature : Uint8Array.from(signature));
      } catch (firstError) {
        // Fallback: some wallets only support signTransaction — we broadcast.
        try {
          const { signedTransaction } = await signTransaction({ transaction: serialized, wallet, chain: 'solana:devnet' });
          setBusy('Broadcasting to devnet');
          const connection = new Connection(config.rpcHttpUrl, 'confirmed');
          encoded = await connection.sendRawTransaction(signedTransaction, { skipPreflight: false });
        } catch (secondError) {
          throw secondError?.message ? secondError : firstError;
        }
      }
      setBusy('Payment broadcast — confirming on devnet');
      const result = await api('/api/pay/submit', { paymentId: payment.paymentId, signature: encoded });
      if (result.ok && result.payment) setPayment(result.payment);
      setBusy('');
    } catch (caught) {
      setBusy('');
      setError(friendly(caught));
    }
  }, [buildTransaction, signAndSendTransaction, signTransaction, wallet, payment, config.rpcHttpUrl]);

  if (!ready) return <p className="pay-note">Starting wallet services…</p>;
  const expired = payment?.status === 'expired' || payment?.status === 'superseded';
  const paid = payment?.status === 'paid';

  return <div className="pay-panel">
    {!authenticated ? (
      <div className="pay-login">
        <button className="primary" onClick={login}>Connect wallet · devnet</button>
        <p className="fine">Privy connects your existing Solana wallet or creates one behind an email. Devnet only — no real funds.</p>
      </div>
    ) : (
      <>
        <div className="pay-wallet-row">
          <span className="pay-wallet-label">Paying from</span>
          {wallets.length > 1 ? (
            <select value={walletIndex} onChange={event => setWalletIndex(Number(event.target.value))}>
              {wallets.map((entry, index) => <option key={entry.address} value={index}>{walletName(entry)} · {short(entry.address)}</option>)}
            </select>
          ) : (
            <span className="pay-wallet">{walletsReady && wallet ? `${walletName(wallet)} · ${short(wallet.address)}` : 'Preparing wallet…'}</span>
          )}
          <button className="text-button" onClick={logout}>Disconnect</button>
        </div>
        {!payment ? (
          <div className="pay-assets">
            <p>Choose how to fund this order on devnet:</p>
            <div className="pay-asset-row">
              <button className="primary" disabled={Boolean(busy)} onClick={() => createIntent('SOL')}>Pay with devnet SOL</button>
              <button className="secondary" disabled={Boolean(busy)} onClick={() => createIntent('USDC')}>Pay with devnet USDC</button>
            </div>
          </div>
        ) : paid ? (
          <div className="pay-paid">
            <strong>Payment confirmed on devnet.</strong>
            <p>{assetAmount(payment)} received{payment.payment?.payer ? ` from ${short(payment.payment.payer)}` : ''}{payment.order?.settlement ? ` — ${settlementText(payment.order.settlement)}` : ''}.</p>
            <p className="fine">Signature <code>{short(payment.payment?.signature)}</code></p>
            <p className="fine">Order execution: {payment.order?.execution?.status === 'executed' ? 'dispatched to the fulfillment worker' : payment.order?.execution?.status === 'execution_failed' ? 'the executor reported a failure — see the operator log' : 'received and pending — the card-order step runs next'}.</p>
          </div>
        ) : expired ? (
          <div className="pay-expired">
            <strong>This payment request has expired.</strong>
            <p>Prepare a fresh quote to create a new one. Nothing was charged.</p>
          </div>
        ) : (
          <div className="pay-request">
            <div className="pay-amount"><span>{pln(payment.totalMinor)} as</span><strong>{assetAmount(payment)}</strong></div>
            <p className="fine">To the Buena treasury on devnet · verified on-chain against this quote only · not an escrow.</p>
            <button className="primary" disabled={Boolean(busy) || !walletsReady || !wallet} onClick={pay}>{busy || `Send ${assetAmount(payment)}`}</button>
            <p className="fine">Your wallet shows the exact transaction before signing. The order is only executed after the transfer confirms on devnet.</p>
          </div>
        )}
        {error ? <p className="pay-error" role="alert">{error}</p> : null}
      </>
    )}
    {busy && !error ? <p className="pay-note">{busy}…</p> : null}
  </div>;
}

function IslandRoot({ context }) {
  const [config, setConfig] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api('/api/pay/config').then(result => {
      if (!alive) return;
      if (result.ok === false || result.enabled === false || !result.appId) setFailed(true);
      else setConfig(result);
    }).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);
  if (failed) return <p className="pay-note">Devnet wallet payment is not configured on this server.</p>;
  if (!config) return <p className="pay-note">Loading wallet payment…</p>;
  const wsUrl = config.rpcHttpUrl.replace(/^https:/, 'wss:');
  return <PrivyProvider
    appId={config.appId}
    config={{
      appearance: { walletChainType: 'solana-only', showWalletLoginFirst: true },
      loginMethods: ['wallet', 'email'],
      externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
      solana: { rpcs: { 'solana:devnet': { rpc: createSolanaRpc(config.rpcHttpUrl), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl) } } },
    }}>
    <PayPanel context={context} config={config} />
  </PrivyProvider>;
}

const roots = new Map();
window.buenaPay = {
  show(context) {
    const container = context?.container instanceof HTMLElement ? context.container : document.getElementById('pay-root');
    if (!container) return;
    let root = roots.get(container);
    if (!root) { root = createRoot(container); roots.set(container, root); }
    root.render(<IslandRoot context={context} />);
  },
};
