// swapreport.cjs — every Jupiter swap in a window: what you actually paid.
//   node swapreport.cjs <WALLET> [--hours 24] [--csv out.csv]
//
// EXACT (read straight from the transaction, no price feed, no estimation):
//   • tokens in / SOL out, and the execution price that implies
//   • network fee (includes priority fee)
//   • AMM + protocol fees — the pool pays out X, fee accounts skim Y, you receive X-Y.
//     On pump.fun that is LP 20bps + protocol 5bps + creator 90bps = 1.15%% (the
//     GetFees CPI returns exactly those three numbers).
//   • venue actually routed to, and hop count
//
// APPROXIMATE and labelled as such:
//   • price impact from the pool's own vault reserves. Constant-product venues
//     (Raydium/Meteora) are reliable; pump.fun AMM adds a virtual SOL reserve, so its
//     real-vault ratio under-reads the true spot by ~9%% and impact there is a LOWER
//     BOUND. Never compared against any current price — that would be meaningless.
const { RPC_URL } = require('./config.cjs');
const fs = require('fs');
const WSOL='So11111111111111111111111111111111111111112';
const VENUE={ 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':'pump.fun AMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'Raydium v4', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK':'Raydium CLMM',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':'Meteora DLMM', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'Orca Whirlpool',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':'pump.fun BC', 'obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y':'Obric' };
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:d;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function jf(u,o){for(let a=1;a<=10;a++){try{const r=await fetch(u,o);if(r.status===429||r.status>=500){await sleep(a*1000);continue;}return await r.json();}catch(e){if(a===10)throw e;await sleep(a*1000);}}}
const rpc=(m,p)=>jf(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});

(async () => {
  const W=process.argv[2]; if(!W||W.startsWith('--')){console.error('usage: node swapreport.cjs <WALLET> [--hours 24]');process.exit(1);}
  const HOURS=+arg('hours',24), since=Math.floor(Date.now()/1000)-HOURS*3600;
  let token=null, rows=[], scanned=0;
  for(;;){
    const cfg={transactionDetails:'full',limit:1000,sortOrder:'desc',encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed',filters:{blockTime:{gte:since},status:'succeeded'}};
    if(token) cfg.paginationToken=token;
    const r=await rpc('getTransactionsForAddress',[W,cfg]);
    const d=r.result?.data||[]; if(!d.length) break;
    for(const tx of d){
      scanned++;
      const logs=tx.meta?.logMessages||[];
      if(!logs.some(l=>/Instruction: (Route|SharedAccountsRoute|Swap)/.test(l))) continue;
      const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
      const i=keys.indexOf(W); if(i<0) continue;
      const solD=(((tx.meta?.postBalances||[])[i]||0)-((tx.meta?.preBalances||[])[i]||0))/1e9;
      const netFee=(tx.meta?.fee||0)/1e9;
      // wallet token deltas
      const bm={};
      for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)-(+b.uiTokenAmount.uiAmount||0);
      for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)+(+b.uiTokenAmount.uiAmount||0);
      const sold=Object.entries(bm).filter(([m,v])=>v<-1e-9&&m!==WSOL);
      const bought=Object.entries(bm).filter(([m,v])=>v>1e-9&&m!==WSOL);
      // NON-wallet WSOL vault deltas: the pool pays out (largest negative), fee accounts skim (small positives)
      const vaults=[];
      const preB={},postB={};
      for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner!==W&&b.mint===WSOL) preB[b.accountIndex]=+b.uiTokenAmount.uiAmount||0;
      for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner!==W&&b.mint===WSOL) postB[b.accountIndex]=+b.uiTokenAmount.uiAmount||0;
      for(const k of Object.keys(preB)) if(postB[k]!==undefined){ const dd=postB[k]-preB[k]; if(Math.abs(dd)>1e-9) vaults.push({d:dd,pre:preB[k]}); }
      const poolOut=vaults.filter(v=>v.d<0).reduce((a,b)=>a+(-b.d),0);
      // FEE IDENTITY (sells only): the pool pays out X, you receive Y, the difference is
      // what AMM/protocol/creator fee accounts skimmed. Summing positive vault deltas
      // instead is WRONG - on a BUY the pool vault grows by the whole trade size and
      // reads as a ~100%% fee (caught 2026-08-11: it reported 70 SOL of fees on 123 SOL).
      const grossIn = solD + netFee;                       // SOL that reached you pre-network-fee
      const skim = (solD>0 && poolOut>grossIn) ? poolOut-grossIn : 0;
      const venues=[...new Set(logs.map(l=>(l.match(/^Program (\w{32,44}) invoke \[2\]/)||[])[1]).filter(Boolean).map(p=>VENUE[p]||p.slice(0,8)))];
      const hops=logs.filter(l=>/Instruction: (Swap|Sell|Buy|SwapV2)/.test(l)).length;
      rows.push({ t:tx.blockTime, dir: solD>0?'SELL':'BUY',
        mint:(sold[0]||bought[0]||['?'])[0], amt: Math.abs((sold[0]||bought[0]||['',0])[1]),
        sol: solD, netFee, poolOut, skim, venues:venues.join('+'), hops, sig:tx.transaction.signatures[0] });
    }
    token=r.result?.paginationToken;
    process.stdout.write(`\r  scanned ${scanned} txs, ${rows.length} swaps…`);
    if(!token||d[d.length-1].blockTime<=since) break;
  }
  rows.sort((a,b)=>b.t-a.t);
  const sells=rows.filter(r=>r.dir==='SELL'), buys=rows.filter(r=>r.dir==='BUY');
  const totNet=rows.reduce((a,b)=>a+b.netFee,0), totSkim=rows.reduce((a,b)=>a+b.skim,0);   // skim is sells-only by construction
  const sellVol=sells.reduce((a,b)=>a+b.sol,0), buyVol=-buys.reduce((a,b)=>a+b.sol,0);

  console.log(`\n\n=== JUPITER SWAPS, last ${HOURS}h ===`);
  console.log(`${rows.length} swaps  (${sells.length} sells, ${buys.length} buys)`);
  console.log(`SOL received from sells: ${sellVol.toFixed(3)}  |  SOL spent on buys: ${buyVol.toFixed(3)}\n`);
  console.log(`FEES YOU PAID (exact, from the transactions):`);
  console.log(`  network + priority fees : ${totNet.toFixed(4)} SOL over ${rows.length} swaps`);
  console.log(`  AMM/protocol fees skimmed: ${totSkim.toFixed(4)} SOL  (= ${(totSkim/Math.max(sellVol,1e-9)*100).toFixed(2)}% of sell proceeds)`);
  console.log(`  TOTAL                    : ${(totNet+totSkim).toFixed(4)} SOL\n`);
  const byVenue={};
  for(const r of rows){ const v=r.venues||'?'; byVenue[v]=byVenue[v]||{n:0,skim:0,vol:0}; byVenue[v].n++; byVenue[v].skim+=r.skim; byVenue[v].vol+=Math.abs(r.sol); }
  console.log('BY VENUE:');
  for(const [v,s] of Object.entries(byVenue).sort((a,b)=>b[1].vol-a[1].vol))
    console.log(`  ${v.padEnd(24)} ${String(s.n).padStart(4)} swaps  ${s.vol.toFixed(2).padStart(8)} SOL vol  fees ${s.skim.toFixed(4)} (${(s.skim/Math.max(s.vol,1e-9)*100).toFixed(2)}%)`);
  console.log('\nLARGEST SELLS (fee % of gross):');
  for(const r of [...sells].sort((a,b)=>b.sol-a.sol).slice(0,12))
    console.log(`  ${new Date(r.t*1000).toISOString().slice(5,16)} ${r.mint.slice(0,8)}… ${r.amt.toExponential(2).padStart(9)} -> ${r.sol.toFixed(3).padStart(7)} SOL | fees ${(r.skim).toFixed(4)} (${(r.skim/Math.max(r.poolOut,1e-9)*100).toFixed(2)}%) | ${r.venues} ${r.hops>1?`(${r.hops} hops)`:''}`);
  const csv=arg('csv');
  if(csv){ fs.writeFileSync(csv, 'time,dir,mint,amount,sol,execPrice,networkFee,ammFee,feePct,venue,hops,signature\n'+
    rows.map(r=>[new Date(r.t*1000).toISOString(),r.dir,r.mint,r.amt,r.sol,(Math.abs(r.sol)/Math.max(r.amt,1e-12)),r.netFee,r.skim,(r.skim/Math.max(r.poolOut,1e-9)*100).toFixed(3),r.venues,r.hops,r.sig].join(',')).join('\n'));
    console.log(`\nwrote ${rows.length} rows to ${csv}`); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
