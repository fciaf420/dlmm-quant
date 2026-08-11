// roundtrip.cjs — true realized PnL per token, in SOL, with zero price estimation.
//   node roundtrip.cjs <WALLET> [--hours 24] [--csv out.csv]
//
// A full DLMM lifecycle is four SOL movements:
//   1. swap  SOL -> token   (to get the base side for a two-sided entry)
//   2. LP in   SOL deposited into the position
//   3. LP out  SOL withdrawn when it closes (+ claimed fees)
//   4. swap  token -> SOL   (selling the base side back)
// net = (3 + 4) - (1 + 2). That is what your wallet actually experienced, and it
// captures BOTH swap legs plus the LP result in one number.
//
// Contrast with Meteora's pnlSol, which values the token side you withdrew at the
// POOL's price and never sees what you realise selling it. The per-token delta between
// the two columns is the cost the reported PnL hides.
//
// Everything here is on-chain balance deltas - no oracle, no historical price feed, no
// current price. The only judgement call is attributing each tx to a mint.
const { RPC_URL } = require('./config.cjs');
const fs=require('fs');
const DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', WSOL='So11111111111111111111111111111111111111112';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:d;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function jf(u,o){for(let a=1;a<=10;a++){try{const r=await fetch(u,o);if(r.status===429||r.status>=500){await sleep(a*1000);continue;}return await r.json();}catch(e){if(a===10)throw e;await sleep(a*1000);}}}
const rpc=(m,p)=>jf(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
const S=n=>(n>=0?'+':'')+n.toFixed(3);

(async () => {
  const W=process.argv[2]; if(!W||W.startsWith('--')){console.error('usage: node roundtrip.cjs <WALLET> [--hours 24]');process.exit(1);}
  const HOURS=+arg('hours',24), since=Math.floor(Date.now()/1000)-HOURS*3600;
  const M={};                                  // mint -> { swapIn, lpIn, lpOut, swapOut, pools:Set, n }
  const get=m=>M[m]||(M[m]={swapIn:0,lpIn:0,lpOut:0,swapOut:0,pools:new Set(),n:0,name:null});
  let token=null, scanned=0, unattributed=0;
  const poolMint={};                           // pool -> token_x mint (resolved lazily)

  // pass 1: collect raw txs so we can resolve pools once, then attribute
  const txs=[];
  for(;;){
    const cfg={transactionDetails:'full',limit:1000,sortOrder:'desc',encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed',filters:{blockTime:{gte:since},status:'succeeded'}};
    if(token) cfg.paginationToken=token;
    const r=await rpc('getTransactionsForAddress',[W,cfg]);
    const d=r.result?.data||[]; if(!d.length) break;
    txs.push(...d); scanned+=d.length;
    token=r.result?.paginationToken;
    process.stdout.write(`\r  scanning ${scanned} txs…`);
    if(!token||d[d.length-1].blockTime<=since) break;
  }
  // resolve every DLMM pool touched -> its token_x
  const poolsSeen=new Set();
  for(const tx of txs){
    const logs=tx.meta?.logMessages||[];
    if(!logs.some(l=>/Instruction: (AddLiquidity|RemoveLiquidity|ClosePosition|InitializePosition|RebalanceLiquidity|ClaimFee)/.test(l))) continue;
    const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
    const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]))];
    for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue;
      const a=ix.accounts||[]; if(a.length>=3) poolsSeen.add(a[2]); if(a.length>=2) poolsSeen.add(a[1]); }
  }
  console.log(`\n  resolving ${poolsSeen.size} candidate pools…`);
  const ps=[...poolsSeen];
  for(let i=0;i<ps.length;i+=8){
    await Promise.all(ps.slice(i,i+8).map(async p=>{
      try{ const m=await jf(`https://dlmm.datapi.meteora.ag/pools/${p}`); if(m?.token_x?.address){ poolMint[p]=m.token_x.address; get(m.token_x.address).name=m.name; } }catch(e){}
    }));
  }

  // pass 2: attribute each tx's SOL delta
  for(const tx of txs){
    const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
    const i=keys.indexOf(W); if(i<0) continue;
    const pre=tx.meta?.preBalances||[],post=tx.meta?.postBalances||[]; if(!pre.length) continue;
    const solD=((post[i]||0)-(pre[i]||0))/1e9;
    if(Math.abs(solD)<1e-6) continue;
    const logs=tx.meta?.logMessages||[];
    const isLP=logs.some(l=>/Instruction: (AddLiquidity|RemoveLiquidity|ClosePosition|InitializePosition|RebalanceLiquidity|ClaimFee)/.test(l));
    const isSwap=logs.some(l=>/Instruction: (Route|SharedAccountsRoute|Swap|Sell|Buy)/.test(l));
    if(isLP){
      const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]))];
      let mint=null;
      for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue;
        for(const a of (ix.accounts||[])) if(poolMint[a]){ mint=poolMint[a]; break; } if(mint) break; }
      if(!mint){ unattributed+=solD; continue; }
      const e=get(mint); e.n++;
      if(solD<0) e.lpIn+=solD; else e.lpOut+=solD;
    } else if(isSwap){
      const bm={};
      for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)-(+b.uiTokenAmount.uiAmount||0);
      for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)+(+b.uiTokenAmount.uiAmount||0);
      const moved=Object.entries(bm).filter(([m,v])=>Math.abs(v)>1e-9&&m!==WSOL).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))[0];
      if(!moved){ unattributed+=solD; continue; }
      const e=get(moved[0]); e.n++;
      if(solD<0) e.swapIn+=solD; else e.swapOut+=solD;
    } else unattributed+=solD;
  }

  // Meteora's reported pnl per pool, for the same window
  console.log(`  fetching Meteora's reported PnL…`);
  const claimed={};
  for(const [p,mint] of Object.entries(poolMint)){
    try{ let page=1; for(;;){
      const r=await jf(`https://dlmm.datapi.meteora.ag/positions/${p}/pnl?user=${W}&status=closed&page=${page}`);
      const rows=r.positions||[]; if(!rows.length) break;
      for(const x of rows) if(x.closedAt&&x.closedAt>=since) claimed[mint]=(claimed[mint]||0)+(+x.pnlSol||0);
      if(rows.length>=(r.totalCount||0)||page>15) break; page++; }
    }catch(e){}
  }

  const out=Object.entries(M).map(([mint,e])=>({mint,name:e.name,...e,
    net:e.lpOut+e.swapOut+e.lpIn+e.swapIn, meteora:claimed[mint]||0}))
    .filter(e=>Math.abs(e.net)>0.005||Math.abs(e.meteora)>0.005);
  out.sort((a,b)=>a.net-b.net);
  console.log(`\n=== ROUND-TRIP PnL BY TOKEN, last ${HOURS}h (SOL, on-chain only) ===`);
  console.log('  token            buy(SOL)   LP in    LP out   sell(SOL)   NET    meteora   gap');
  let T={swapIn:0,lpIn:0,lpOut:0,swapOut:0,net:0,meteora:0};
  for(const e of out){
    for(const k of ['swapIn','lpIn','lpOut','swapOut','net','meteora']) T[k]+=e[k];
    console.log(`  ${(e.name||e.mint.slice(0,12)).padEnd(16).slice(0,16)} ${e.swapIn.toFixed(2).padStart(8)} ${e.lpIn.toFixed(2).padStart(8)} ${e.lpOut.toFixed(2).padStart(8)} ${e.swapOut.toFixed(2).padStart(9)} ${S(e.net).padStart(7)} ${S(e.meteora).padStart(8)} ${S(e.net-e.meteora).padStart(7)}`);
  }
  console.log(`  ${'-'.repeat(78)}`);
  console.log(`  ${'TOTAL'.padEnd(16)} ${T.swapIn.toFixed(2).padStart(8)} ${T.lpIn.toFixed(2).padStart(8)} ${T.lpOut.toFixed(2).padStart(8)} ${T.swapOut.toFixed(2).padStart(9)} ${S(T.net).padStart(7)} ${S(T.meteora).padStart(8)} ${S(T.net-T.meteora).padStart(7)}`);
  console.log(`\n  NET = (LP out + sell) - (buy + LP in)   <- what your wallet actually made`);
  console.log(`  meteora = its reported pnlSol for positions closed in the window`);
  console.log(`  gap     = what the reported number missed (mostly swap execution)`);
  if(Math.abs(unattributed)>0.01) console.log(`\n  unattributed SOL (transfers, rent, fees): ${S(unattributed)}`);
  const csv=arg('csv');
  if(csv){ fs.writeFileSync(csv,'mint,name,buySol,lpIn,lpOut,sellSol,net,meteora,gap\n'+out.map(e=>[e.mint,e.name||'',e.swapIn,e.lpIn,e.lpOut,e.swapOut,e.net,e.meteora,e.net-e.meteora].join(',')).join('\n'));
    console.log(`\n  wrote ${out.length} rows to ${csv}`); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
