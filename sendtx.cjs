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

async function sendConfirm(conn, tx, signers, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  return confirmSig(conn, sig, label, lastValidBlockHeight);
}

module.exports = { sendConfirm, confirmSig };
