// Generic exit: node exit.cjs --pool X   (closes ALL bot positions in pool, sweeps token to SOL, updates registry)
const fs = require('fs');
const DLMMImport = require('@meteora-ag/dlmm');
const DLMM = DLMMImport.default ?? DLMMImport;
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, VersionedTransaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { sendConfirm, confirmSig } = require('./sendtx.cjs');
const { RPC_URL, JUP_KEY: JK, keypair, CFG } = require("./config.cjs");
const SOLM = CFG.QUOTE_MINT;
const arg = (k) => { const i = process.argv.indexOf('--'+k); return i>0 ? process.argv[i+1] : null; };
// Same reasoning as deploy.cjs: never abandon a half-finished withdrawal.
process.on('SIGINT', () => console.error('SIGINT ignored - finishing exit to avoid a half-closed position'));
(async () => {
  const POOL = arg('pool');
  const rpc = RPC_URL;
  const user = keypair();
  const conn = new Connection(rpc, 'confirmed');
  const reg = fs.existsSync(__dirname+'/positions.json') ? JSON.parse(fs.readFileSync(__dirname+'/positions.json','utf8')) : [];
  const entry = reg.find(r=>r.pool===POOL);
  const MINT = entry?.mint || (await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${POOL}`)).json()).token_x.address;
  const dlmm = await DLMM.create(conn, new PublicKey(POOL));
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(user.publicKey);
  for (const pos of userPositions) {
    const ids = pos.positionData.positionBinData.map(b=>b.binId);
    const tx = await dlmm.removeLiquidity({ position: pos.publicKey, user: user.publicKey,
      fromBinId: Math.min(...ids), toBinId: Math.max(...ids), bps: new BN(10000), shouldClaimAndClose: true });
    for (const t of (Array.isArray(tx)?tx:[tx])) {
      const sig = await sendConfirm(conn, t, [user], 'close');
      console.log('close tx:', sig);
    }
  }
  await new Promise(r=>setTimeout(r,2000));
  const accs = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint: new PublicKey(MINT) });
  const raw = accs.value.reduce((s,a)=>s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
  if (raw > 0) {
    // SWEEP MUST NOT KILL THE EXIT (audit 2026-08-08): the position is already closed
    // on-chain by this point. The old code threw on any sweep failure (incl. a bare
    // "Buffer.from received undefined" on a Jupiter 429 - the null-check deploy.cjs
    // got after being caught live never made it here), which aborted BEFORE the
    // registry write; next tick manage() saw totalCount 0, took the EXTERNAL-CLOSE
    // branch, dropped the row with a null journal, and the tokens sat in the wallet
    // silently. Now: retry with backoff, and on final failure WARN + finish the
    // bookkeeping - the daemon surfaces the SWEEP FAILED line, manual recovery is
    // node jupswap.cjs <mint> <SOL> <raw>.
    let ok = false;
    for (let sAttempt = 1; sAttempt <= 3 && !ok; sAttempt++) {
    try {
      const ord = await (await fetch(`https://api.jup.ag/swap/v2/order?inputMint=${MINT}&outputMint=${SOLM}&amount=${raw}&taker=${user.publicKey.toBase58()}`, { headers:{'x-api-key':JK} })).json();
      if (ord.transaction) {
        const tx = VersionedTransaction.deserialize(Buffer.from(ord.transaction,'base64')); tx.sign([user]);
        const ex = await (await fetch('https://api.jup.ag/swap/v2/execute', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
          body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: ord.requestId }) })).json();
        ok = ex.status === 'Success'; console.log('sweep v2:', ex.status);
      }
    } catch(e){ console.log('sweep v2 err:', e.message); }
    if (!ok) {
      try {
        const q = await (await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${MINT}&outputMint=${SOLM}&amount=${raw}&slippageBps=${CFG.SLIPPAGE_BPS}`, { headers:{'x-api-key':JK} })).json();
        const sw = await (await fetch('https://api.jup.ag/swap/v1/swap', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
          body: JSON.stringify({ quoteResponse: q, userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
        if (!sw.swapTransaction) throw new Error(`jupiter v1 sweep returned no transaction: ${JSON.stringify(sw.error||q.error||sw).slice(0,200)}`);
        const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction,'base64')); tx.sign([user]);
        const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries:3 });
        await confirmSig(conn, sig, 'sweep v1'); console.log('sweep v1:', sig); ok = true;
      } catch(e){
        console.log(`sweep v1 err (attempt ${sAttempt}/3): ${e.message}`);
        if (sAttempt < 3) await new Promise(r=>setTimeout(r, sAttempt*4000));
      }
    }
    }
    if (!ok) console.log(`SWEEP FAILED after 3 attempts - ${raw} raw of ${MINT} left in wallet; recover with: node jupswap.cjs ${MINT} ${SOLM} ${raw}`);
  }
  fs.writeFileSync(__dirname+'/positions.json', JSON.stringify(reg.filter(r=>r.pool!==POOL), null, 1));
  const sol = await conn.getBalance(user.publicKey);
  console.log('EXITED pool', POOL, '| FINAL wallet SOL:', sol/1e9);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
