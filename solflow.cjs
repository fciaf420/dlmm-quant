// solflow.cjs — "Meteora says my closed positions made SOL, but my wallet says otherwise.
// Where is it going?" Itemizes EVERY lamport in/out of the wallet over a window and
// categorises it, so the categories must sum to the real balance change.
//
//   node solflow.cjs <WALLET> [--hours 24]
//
// No price estimation anywhere: this is pure on-chain accounting. The only inferred
// quantity is the token-inventory change (tokens bought but not yet sold), which is
// reported separately and priced at CURRENT value with that stated clearly.
const { RPC_URL, JUP_KEY: JK } = require('./config.cjs');
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (k,d) => { const i = process.argv.indexOf('--'+k); return i>0 ? process.argv[i+1] : d; };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function jf(u,o){ for(let a=1;a<=10;a++){ try{ const r=await fetch(u,o); if(r.status===429||r.status>=500){await sleep(a*1000);continue;} return await r.json(); }catch(e){ if(a===10)throw e; await sleep(a*1000);} } }
const rpc=(m,p)=>jf(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
const parse=v=>typeof v==='string'?JSON.parse(v):(v||{});
const S=n=>(n>=0?'+':'')+n.toFixed(4);

(async () => {
  const W = process.argv[2];
  if (!W || W.startsWith('--')) { console.error('usage: node solflow.cjs <WALLET> [--hours 24]'); process.exit(1); }
  const HOURS = +arg('hours',24);
  const since = Math.floor(Date.now()/1000) - HOURS*3600;

  const cat = {};                       // category -> net SOL
  const add=(k,v)=>{ cat[k]=(cat[k]||0)+v; };
  let fees=0, txs=0, pools=new Set(), tokenDelta={};
  let token=null, calls=0, oldest=null;
  for(;;){
    const cfg={transactionDetails:'full',limit:1000,sortOrder:'desc',encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed',filters:{blockTime:{gte:since},status:'succeeded'}};
    if(token) cfg.paginationToken=token;
    const r=await rpc('getTransactionsForAddress',[W,cfg]);
    const d=r.result?.data||[]; if(!d.length) break; calls++;
    for(const tx of d){
      const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
      const i=keys.indexOf(W); if(i<0) continue;
      const pre=tx.meta?.preBalances||[], post=tx.meta?.postBalances||[]; if(!pre.length) continue;
      txs++; oldest=tx.blockTime;
      const delta=((post[i]||0)-(pre[i]||0))/1e9;
      const f=(tx.meta?.fee||0)/1e9; fees+=f;
      const logs=tx.meta?.logMessages||[];
      const has=re=>logs.some(l=>re.test(l));
      // token inventory change for this wallet
      const bm={};
      for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)-(+b.uiTokenAmount.uiAmount||0);
      for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)+(+b.uiTokenAmount.uiAmount||0);
      for(const [m,v] of Object.entries(bm)) if(m!==WSOL && Math.abs(v)>1e-9) tokenDelta[m]=(tokenDelta[m]||0)+v;
      // categorise (a tx can do several things; attribute the whole SOL delta to the
      // dominant DLMM/swap action, which is how the wallet actually experiences it)
      let k;
      if (has(/Instruction: (AddLiquidity|InitializePosition)/)) k='LP deposits (SOL into positions)';
      else if (has(/Instruction: (RemoveLiquidity|ClosePosition|ClaimFee)/)) k='LP withdrawals + claimed fees';
      else if (has(/Instruction: (Swap|Route|Sell|Buy)/)) k = delta>0 ? 'swaps: token -> SOL' : 'swaps: SOL -> token';
      else if (has(/Instruction: (Transfer|TransferChecked)/) && Math.abs(delta)>0.001) k='transfers in/out';
      else k='other (fees, ATA rent, misc)';
      add(k, delta);
      if (has(/Instruction: (AddLiquidity|RemoveLiquidity|ClosePosition|InitializePosition)/)) {
        const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]))];
        for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue; for(const a of (ix.accounts||[])) pools.add(a); }
      }
    }
    token=r.result?.paginationToken;
    process.stdout.write(`\r  scanning ${txs} txs…`);
    if(!token||d[d.length-1].blockTime<=since) break;
  }
  const bal=await rpc('getBalance',[W]);
  const now=bal.result.value/1e9;
  const net=Object.values(cat).reduce((a,b)=>a+b,0);
  console.log(`\n\n=== SOL FLOW, last ${HOURS}h (${txs} txs) ===`);
  console.log(`window start: ${new Date(oldest*1000).toISOString().slice(0,16)}\n`);
  for(const [k,v] of Object.entries(cat).sort((a,b)=>a[1]-b[1])) console.log(`  ${S(v).padStart(10)} SOL   ${k}`);
  console.log(`  ${'-'.repeat(10)}`);
  console.log(`  ${S(net).padStart(10)} SOL   NET CHANGE (current balance ${now.toFixed(4)})`);
  console.log(`\n  of which network fees: -${fees.toFixed(4)} SOL over ${txs} txs`);

  // Meteora's claim for the same window
  console.log(`\n  checking Meteora's reported PnL across ${pools.size} touched accounts…`);
  let claimed=0, n=0;
  const cand=[...pools];
  for(let i=0;i<cand.length;i+=6){
    await Promise.all(cand.slice(i,i+6).map(async p=>{
      try{ let page=1; for(;;){
        const r=await jf(`https://dlmm.datapi.meteora.ag/positions/${p}/pnl?user=${W}&status=closed&page=${page}`);
        const rows=r.positions||[]; if(!rows.length) break;
        for(const x of rows) if(x.closedAt&&x.closedAt>=since){ claimed+=+x.pnlSol||0; n++; }
        if(rows.length>=(r.totalCount||0)||page>15) break; page++; }
      }catch(e){}
    }));
  }
  console.log(`\n  METEORA says: ${S(claimed)} SOL across ${n} positions closed in this window`);
  console.log(`  WALLET says:  ${S(net)} SOL actual change`);
  console.log(`  GAP:          ${S(net-claimed)} SOL\n`);
  // where an unexplained gap usually hides
  const tokLeft=Object.entries(tokenDelta).filter(([,v])=>v>1e-9);
  console.log(`  tokens acquired but NOT sold this window: ${tokLeft.length} mints`);
  if (tokLeft.length) {
    const ids=tokLeft.slice(0,40).map(([m])=>m).join(',');
    try{ const pr=await jf('https://api.jup.ag/price/v3?ids='+ids,{headers:{'x-api-key':JK}});
      const solp=(await jf('https://api.jup.ag/price/v3?ids='+WSOL,{headers:{'x-api-key':JK}}))[WSOL]?.usdPrice||0;
      let v=0; for(const [m,a] of tokLeft) v += a*((pr[m]?.usdPrice)||0);
      console.log(`  their value at CURRENT prices: $${v.toFixed(2)} = ${(v/solp).toFixed(3)} SOL  (unrealised - this is the usual gap)`);
    }catch(e){}
  }
})().catch(e=>{ console.error('ERR',e.message); process.exit(1); });
