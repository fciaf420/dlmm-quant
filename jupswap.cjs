// Generic Jupiter swap helper (Swap v2 Meta-Aggregator, v1 fallback)
// usage: node jupswap.cjs <inputMint> <outputMint> <rawAmount>
const fs = require('fs');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { RPC_URL, JUP_KEY: JK, keypair } = require("./config.cjs");
(async () => {
  const [inMint, outMint, amount] = process.argv.slice(2);
  const rpc = RPC_URL;
  const user = keypair();
  const conn = new Connection(rpc, 'confirmed');
  let done = false;
  try {
    const ord = await (await fetch(`https://api.jup.ag/swap/v2/order?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&taker=${user.publicKey.toBase58()}`, { headers:{'x-api-key':JK} })).json();
    if (ord.transaction) {
      const tx = VersionedTransaction.deserialize(Buffer.from(ord.transaction,'base64'));
      tx.sign([user]);
      const ex = await (await fetch('https://api.jup.ag/swap/v2/execute', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
        body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: ord.requestId }) })).json();
      console.log('v2:', ex.status || JSON.stringify(ex).slice(0,200), ex.signature||'');
      done = ex.status === 'Success';
    } else console.log('v2 no tx:', JSON.stringify(ord).slice(0,150));
  } catch(e){ console.log('v2 err:', e.message); }
  if (!done) {
    const q = await (await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=300`, { headers:{'x-api-key':JK} })).json();
    const sw = await (await fetch('https://api.jup.ag/swap/v1/swap', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
      body: JSON.stringify({ quoteResponse: q, userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
    const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction,'base64'));
    tx.sign([user]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries:3 });
    await conn.confirmTransaction(sig,'confirmed');
    console.log('v1 fallback:', sig);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
