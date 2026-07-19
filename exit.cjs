// Generic exit: node exit.cjs --pool X   (closes ALL bot positions in pool, sweeps token to SOL, updates registry)
const fs = require('fs');
const DLMMImport = require('@meteora-ag/dlmm');
const DLMM = DLMMImport.default ?? DLMMImport;
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, VersionedTransaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { RPC_URL, JUP_KEY: JK, keypair } = require("./config.cjs");
const SOLM = "So11111111111111111111111111111111111111112";
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
      const sig = await sendAndConfirmTransaction(conn, t, [user], { commitment:'confirmed' });
      console.log('close tx:', sig);
    }
  }
  await new Promise(r=>setTimeout(r,2000));
  const accs = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint: new PublicKey(MINT) });
  const raw = accs.value.reduce((s,a)=>s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
  if (raw > 0) {
    let ok = false;
    try {
      const ord = await (await fetch(`https://api.jup.ag/swap/v2/order?inputMint=${MINT}&outputMint=${SOLM}&amount=${raw}&taker=${user.publicKey.toBase58()}`, { headers:{'x-api-key':JK} })).json();
      if (ord.transaction) {
        const tx = VersionedTransaction.deserialize(Buffer.from(ord.transaction,'base64')); tx.sign([user]);
        const ex = await (await fetch('https://api.jup.ag/swap/v2/execute', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
          body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: ord.requestId }) })).json();
        ok = ex.status === 'Success'; console.log('sweep v2:', ex.status);
      }
    } catch(e){}
    if (!ok) {
      const q = await (await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${MINT}&outputMint=${SOLM}&amount=${raw}&slippageBps=300`, { headers:{'x-api-key':JK} })).json();
      const sw = await (await fetch('https://api.jup.ag/swap/v1/swap', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
        body: JSON.stringify({ quoteResponse: q, userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
      const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction,'base64')); tx.sign([user]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries:3 });
      await conn.confirmTransaction(sig,'confirmed'); console.log('sweep v1:', sig);
    }
  }
  fs.writeFileSync(__dirname+'/positions.json', JSON.stringify(reg.filter(r=>r.pool!==POOL), null, 1));
  const sol = await conn.getBalance(user.publicKey);
  console.log('EXITED pool', POOL, '| FINAL wallet SOL:', sol/1e9);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
