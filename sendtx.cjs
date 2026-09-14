// Send + confirm over HTTP only.
//
// sendAndConfirmTransaction awaits confirmation via a websocket signature subscription.
// Some RPCs (FluxRPC among them) return that notification with the field named `error`
// rather than `err`, which fails web3.js's superstruct schema. The throw happens inside
// an event-emitter callback, so it is an uncaught exception that kills the process — and
// it fires on `{error: null}`, i.e. while reporting success. It's a race against HTTP
// confirmation, so it only bites sometimes.
//
// Polling getSignatureStatuses avoids the subscription entirely.
const CONFIRM_TIMEOUT_MS = 90e3, POLL_MS = 1500;
const bs58Import = require('bs58');
const bs58 = bs58Import.default ?? bs58Import;

// Poll an already-submitted signature to confirmation. lastValidBlockHeight is optional;
// without it we simply wait out the timeout rather than detecting expiry early.
async function confirmSig(conn, sig, label, lastValidBlockHeight) {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label||'tx'} failed on-chain: ${JSON.stringify(st.err)} (${sig})`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    if (!st && lastValidBlockHeight != null) {
      // Not landed yet — give up once the blockhash can no longer be accepted.
      const h = await conn.getBlockHeight('confirmed');
      if (h > lastValidBlockHeight) throw new Error(`${label||'tx'} blockhash expired before landing (${sig})`);
    }
  }
  throw new Error(`${label||'tx'} not confirmed within ${CONFIRM_TIMEOUT_MS/1000}s (${sig})`);
}

// Blockhash-expiry retry (caught live: a 139-bin extended position-open took >60s
// to land and expired). Expiry means the tx never executed, so re-signing the SAME
// transaction with a FRESH blockhash is safe - not a double-spend. Legacy
// web3.js Transactions allow mutating recentBlockhash and re-signing in place.
async function sendConfirm(conn, tx, signers, label, hooks = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.signatures = [];          // clear prior attempt's signatures before re-signing
    tx.sign(...signers);
    const raw = tx.serialize();
    if (!tx.signature) throw new Error(`${label || 'tx'} has no deterministic signature after signing`);
    const expectedSig = bs58.encode(tx.signature);
    // Durable intent goes to disk before broadcast. If the process dies after the
    // RPC accepts the bytes, a resume can reconcile this exact signature rather
    // than building a second add-liquidity transaction.
    if (hooks.beforeSend) await hooks.beforeSend({ signature: expectedSig, lastValidBlockHeight, attempt });
    const sig = await conn.sendRawTransaction(raw, { maxRetries: 3 });
    if (sig !== expectedSig) throw new Error(`${label || 'tx'} RPC returned an unexpected signature`);
    try {
      return await confirmSig(conn, sig, label, lastValidBlockHeight);
    } catch (e) {
      lastErr = e;
      if (!/blockhash expired/.test(String(e.message))) throw e;   // real failures propagate
      if (hooks.retryExpired === false) throw e; // durable caller reconciles this exact signature first
      console.error(`${label || 'tx'} attempt ${attempt}/3 expired - retrying with fresh blockhash`);
    }
  }
  throw lastErr;
}

module.exports = { sendConfirm, confirmSig };
