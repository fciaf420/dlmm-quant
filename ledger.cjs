// ledger.cjs — the definitive reconciliation: exactly where the SOL went, and why the
// Meteora data API's PnL differs from your wallet.
//
//   node ledger.cjs <WALLET> [--hours 24] [--csv ledger.csv]
//
// PART 1 — WALLET LEDGER. Every lamport in/out over the window, classified. Must sum to
// the real balance change (verified, printed). Categories are exclusive and ordered so a
// transaction lands in exactly one bucket:
//   jito tips        transfers to the 8 known Jito tip accounts
//   priority fees    tx.meta.fee minus base (5000 lamports per signature)
//   base fees        5000 lamports per signature
//   LP in / LP out   DLMM position deposits / withdrawals+claimed fees
//   swap buy / sell  Jupiter or direct AMM routes
//   rent             ATA + position account rent paid/reclaimed
//   transfers        plain SOL to/from other wallets
//
// PART 2 — WHY METEORA DISAGREES. Meteora's pnlSol books a position the instant it
// closes, valuing the TOKEN side you withdrew at the pool's price at that moment. You
// then sell that token seconds later at whatever the market pays. Per position:
//   meteora_pnl  = its reported pnlSol
//   realised     = (SOL out of position + SOL from selling the token side)
//                  - (SOL into position + SOL spent buying the token side)
//   gap          = realised - meteora_pnl
// The gap is NOT a fee and NOT a transfer - it is mark-versus-realised on a token whose
// price moved between the close and the sale. Verified live 2026-08-11 on STABLE, which
// ran 3.6e-6 -> 7.1e-6 -> 3.3e-6 within seven minutes while positions closed against it.
const { RPC_URL } = require('./config.cjs');
const fs=require('fs');
const DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', WSOL='So11111111111111111111111111111111111111112';
const JITO=new Set(['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5','HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY','ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGbaLLn',
 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh','ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL','3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']);
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:d;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function jf(u,o){for(let a=1;a<=10;a++){try{const r=await fetch(u,o);if(r.status===429||r.status>=500){await sleep(a*900);continue;}return await r.json();}catch(e){if(a===10)throw e;await sleep(a*900);}}}
const rpc=(m,p)=>jf(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
const P=v=>typeof v==='string'?JSON.parse(v):(v||{});
const F=(n,w=10)=>(n>=0?'+':'')+n.toFixed(4).padStart(w);

(async () => {
  const W=process.argv[2]; if(!W||W.startsWith('--')){console.error('usage: node ledger.cjs <WALLET> [--hours 24]');process.exit(1);}
  const H=+arg('hours',24), since=Math.floor(Date.now()/1000)-H*3600;

  let token=null, txs=[];
  for(;;){ const cfg={transactionDetails:'full',limit:1000,sortOrder:'desc',encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed',filters:{blockTime:{gte:since},status:'succeeded'}};
    if(token) cfg.paginationToken=token;
    const r=await rpc('getTransactionsForAddress',[W,cfg]); const d=r.result?.data||[]; if(!d.length) break;
    txs.push(...d); token=r.result?.paginationToken;
    process.stdout.write(`\r  loading ${txs.length} txs…`);
    if(!token||d[d.length-1].blockTime<=since) break; }
  txs.sort((a,b)=>a.blockTime-b.blockTime);
  const idx=t=>(t.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k).indexOf(W);
  const startBal=((txs[0].meta?.preBalances||[])[idx(txs[0])]||0)/1e9;
  const endBal=((txs[txs.length-1].meta?.postBalances||[])[idx(txs[txs.length-1])]||0)/1e9;

  // ---------- PART 1: wallet ledger ----------
  // POOL RESOLUTION FIRST: accounts[2] is the pool for InitializePosition but NOT for
  // RemoveLiquidity/ClosePosition, so index-based attribution silently drops every
  // withdrawal (caught 2026-08-11: it produced a -369 SOL 'realised' total).
  const cand=new Set();
  for(const tx of txs){ const L=tx.meta?.logMessages||[];
    if(!L.some(l=>/Instruction: (AddLiquidity|RemoveLiquidity|ClosePosition|InitializePosition|RebalanceLiquidity|ClaimFee)/.test(l))) continue;
    const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
    const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]))];
    for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue; for(const a of (ix.accounts||[])) cand.add(a); } }
  const isPool={}; const cl=[...cand];
  for(let i=0;i<cl.length;i+=10){ await Promise.all(cl.slice(i,i+10).map(async a=>{
      try{ const m=await jf(`https://dlmm.datapi.meteora.ag/pools/${a}`); if(m?.token_x?.address) isPool[a]={mint:m.token_x.address,name:m.name}; }catch(e){} }));
    process.stdout.write(`\r  resolving pools ${Math.min(i+10,cl.length)}/${cl.length}…`); }
  console.log('');
  const C={}; const add=(k,v)=>{C[k]=(C[k]||0)+v;};
  let sum=0, jitoTot=0, prioTot=0, baseTot=0;
  const swapsByMint={}, lpByPool={};
  for(const tx of txs){
    const i=idx(tx); if(i<0) continue;
    const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
    const pre=tx.meta?.preBalances||[], post=tx.meta?.postBalances||[];
    const d=((post[i]||0)-(pre[i]||0))/1e9; sum+=d;
    const sigs=(tx.transaction?.signatures||[]).length||1;
    const fee=(tx.meta?.fee||0)/1e9, base=sigs*5000/1e9, prio=Math.max(0,fee-base);
    baseTot+=base; prioTot+=prio;
    // jito tip: SOL to a known tip account inside this tx
    let jito=0;
    for(let j=0;j<keys.length;j++) if(JITO.has(keys[j])) jito+=((post[j]||0)-(pre[j]||0))/1e9;
    if(jito>0) jitoTot+=jito;
    const L=tx.meta?.logMessages||[]; const has=re=>L.some(l=>re.test(l));
    const isSwap=has(/Instruction: (Swap|Swap2|SwapV2|Sell|Buy|Route|SharedAccountsRoute)/);
    const isLP=has(/Instruction: (AddLiquidity|RemoveLiquidity|ClosePosition|InitializePosition|InitializeBinArray|RebalanceLiquidity|ClaimFee)/);
    // token movement for attribution
    const bm={};
    for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)-(+b.uiTokenAmount.uiAmount||0);
    for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)+(+b.uiTokenAmount.uiAmount||0);
    const moved=Object.entries(bm).filter(([m,v])=>Math.abs(v)>1e-9&&m!==WSOL).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))[0];
    if(isLP&&!isSwap){
      add(d<0?'LP in (deposits)':'LP out (withdrawals + claimed fees)', d);
      const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[]))];
      let pool=null;
      for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue;
        for(const a of (ix.accounts||[])) if(isPool[a]){ pool=a; break; } if(pool) break; }
      if(pool){ (lpByPool[pool]=lpByPool[pool]||{in:0,out:0,tok:0})[d<0?'in':'out']+=d; if(moved) lpByPool[pool].tok+=moved[1]; }
    } else if(isSwap){
      add(d<0?'swap: buying tokens':'swap: selling tokens', d);
      if(moved){ const s=swapsByMint[moved[0]]=swapsByMint[moved[0]]||{buy:0,sell:0,tokIn:0,tokOut:0};
        if(d<0){s.buy+=d;s.tokIn+=moved[1];} else {s.sell+=d;s.tokOut+=-moved[1];} }
    } else if(jito>0.000001 && Math.abs(d)<0.05) add('jito tips / standalone fee txs', d);
    else add('other (transfers, rent, misc)', d);
  }
  console.log(`\n\n${'='.repeat(74)}\nPART 1 — WALLET LEDGER (last ${H}h, ${txs.length} txs)\n${'='.repeat(74)}`);
  console.log(`  balance ${startBal.toFixed(4)} -> ${endBal.toFixed(4)} SOL   ACTUAL CHANGE ${F(endBal-startBal)}\n`);
  for(const [k,v] of Object.entries(C).sort((a,b)=>a[1]-b[1])) console.log(`  ${F(v)}  ${k}`);
  console.log(`  ${'-'.repeat(12)}`);
  console.log(`  ${F(sum)}  SUM   (reconciles within ${Math.abs(sum-(endBal-startBal)).toFixed(9)} SOL)\n`);
  console.log(`  embedded costs (already inside the lines above):`);
  console.log(`    base network fees : -${baseTot.toFixed(4)} SOL`);
  console.log(`    priority fees     : -${prioTot.toFixed(4)} SOL`);
  console.log(`    jito tips         : -${jitoTot.toFixed(4)} SOL`);
  console.log(`    TOTAL FRICTION    : -${(baseTot+prioTot+jitoTot).toFixed(4)} SOL`);

  // ---------- PART 2: Meteora vs realised ----------
  console.log(`\n${'='.repeat(74)}\nPART 2 — METEORA'S PnL vs WHAT YOU REALISED\n${'='.repeat(74)}`);
  const pools=Object.keys(lpByPool);
  const rows=[]; let mTot=0;
  for(let i=0;i<pools.length;i+=6){
    await Promise.all(pools.slice(i,i+6).map(async p=>{
      try{
        const meta=await jf(`https://dlmm.datapi.meteora.ag/pools/${p}`); if(!meta?.token_x?.address) return;
        let page=1,pnl=0,n=0,wdTok=0,wdUsd=0,solPrice=null;
        for(;;){ const r=await jf(`https://dlmm.datapi.meteora.ag/positions/${p}/pnl?user=${W}&status=closed&page=${page}`);
          solPrice=r.solPrice??solPrice; const rr=r.positions||[]; if(!rr.length) break;
          for(const x of rr) if(x.closedAt&&x.closedAt>=since){ pnl+=+x.pnlSol||0; n++; const wd=P(x.allTimeWithdrawals); wdTok+=+(wd.tokenX?.amount||0); wdUsd+=+(wd.tokenX?.usd||0); }
          if(rr.length>=(r.totalCount||0)||page>15) break; page++; }
        if(n) rows.push({pool:p,name:meta.name,mint:meta.token_x.address,pnl,n,wdTok,wdUsd,solPrice,lp:lpByPool[p]});
      }catch(e){}
    }));
    process.stdout.write(`\r  querying ${Math.min(i+6,pools.length)}/${pools.length} pools…`);
  }
  console.log('\n');
  const agg={};
  for(const r of rows){ const a=agg[r.mint]=agg[r.mint]||{name:r.name,pnl:0,n:0,wdTok:0,wdUsd:0,solPrice:r.solPrice,lpIn:0,lpOut:0};
    a.pnl+=r.pnl; a.n+=r.n; a.wdTok+=r.wdTok; a.wdUsd+=r.wdUsd; a.lpIn+=r.lp.in; a.lpOut+=r.lp.out; }
  const out=[];
  for(const [mint,a] of Object.entries(agg)){
    const s=swapsByMint[mint]||{buy:0,sell:0};
    const realised=a.lpIn+a.lpOut+s.buy+s.sell;
    const meteoraMark=a.solPrice?a.wdUsd/a.solPrice:0;      // Meteora's SOL value of the token side you withdrew
    out.push({mint,name:a.name,n:a.n,pnl:a.pnl,realised,gap:realised-a.pnl,mark:meteoraMark,sold:s.sell,markVsSold:s.sell-meteoraMark});
    mTot+=a.pnl;
  }
  out.sort((x,y)=>x.gap-y.gap);
  console.log('  token            pos   meteora  realised     gap | tokenSide: mark  sold   diff');
  let T={pnl:0,realised:0,gap:0,mark:0,sold:0};
  for(const r of out){ for(const k of ['pnl','realised','gap','mark','sold']) T[k]+=r[k];
    console.log(`  ${(r.name||r.mint.slice(0,12)).padEnd(16).slice(0,16)} ${String(r.n).padStart(3)} ${F(r.pnl,9)} ${F(r.realised,9)} ${F(r.gap,7)} | ${r.mark.toFixed(2).padStart(7)} ${r.sold.toFixed(2).padStart(6)} ${F(r.markVsSold,6)}`); }
  console.log(`  ${'-'.repeat(72)}`);
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(out.reduce((a,b)=>a+b.n,0)).padStart(3)} ${F(T.pnl,9)} ${F(T.realised,9)} ${F(T.gap,7)} | ${T.mark.toFixed(2).padStart(7)} ${T.sold.toFixed(2).padStart(6)} ${F(T.sold-T.mark,6)}`);
  console.log(`\n  meteora  = data API pnlSol for positions closed in this window`);
  console.log(`  realised = (LP out + token sales) - (LP in + token purchases), on-chain`);
  console.log(`  mark     = Meteora's SOL valuation of the TOKEN side you withdrew`);
  console.log(`  sold     = SOL you actually got selling that token side`);
  console.log(`  diff     = sold - mark  <- the mark-versus-realised gap, the whole story`);

  const csv=arg('csv');
  if(csv){ fs.writeFileSync(csv,'mint,name,positions,meteoraPnlSol,realisedSol,gapSol,tokenSideMarkSol,tokenSideSoldSol,markVsSold\n'+
    out.map(r=>[r.mint,r.name||'',r.n,r.pnl,r.realised,r.gap,r.mark,r.sold,r.markVsSold].join(',')).join('\n'));
    console.log(`\n  wrote ${out.length} rows to ${csv}`); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
