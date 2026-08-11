// exitaudit.cjs — "did I lose SOL on the Jupiter exit swaps?"
// Read-only. For every position closed in the window, compares what METEORA says you
// withdrew (allTimeWithdrawals, with its own USD valuation and solPrice) against the SOL
// you ACTUALLY received when you sold that token side on Jupiter.
//
//   node exitaudit.cjs [WALLET] [--hours 24]
//
// Why this reference and not a market price: a single token can have 15 DLMM pools from
// $0 to $556k TVL, and Jupiter routes through whatever venue is deepest — often not a
// DLMM pool at all. Picking a pool to quote "market price" produced garbage (a $67-TVL
// pool with no candles implied a -64%% slip that was pure measurement error). Meteora's
// own USD number is the valuation your PnL is based on, so the gap against realized SOL
// is exactly the cost your reported PnL never shows.
const { RPC_URL } = require('./config.cjs');
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const WSOL = 'So11111111111111111111111111111111111111112';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i+1] : d; };
const WALLET = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : null;
const HOURS = +arg('hours', 24);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jf(url, opts){ for(let a=1;a<=10;a++){ try{ const r=await fetch(url,opts); if(r.status===429||r.status>=500){await sleep(a*1000);continue;} return await r.json(); }catch(e){ if(a===10)throw e; await sleep(a*1000);} } }
const rpc=(m,p)=>jf(RPC_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
const parse = v => typeof v==='string' ? JSON.parse(v) : (v||{});
async function allPages(pool,user,status){ let out=[],page=1,sol=null;
  for(;;){ const r=await jf(`https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${user}&status=${status}&page=${page}`);
    sol = r.solPrice ?? sol; const p=r.positions||[]; out=out.concat(p);
    if(out.length>=(r.totalCount||0)||!p.length||page>15) break; page++; }
  return { rows: out, solPrice: sol }; }

(async () => {
  const W = WALLET || require('./config.cjs').keypair().publicKey.toBase58();
  const since = Math.floor(Date.now()/1000) - HOURS*3600;
  console.log(`\nexit audit — ${W}\nwindow: last ${HOURS}h\n`);

  // 1. walk the wallet's history: collect pools it closed positions in, and every token->SOL swap
  let token=null, calls=0; const pools=new Set(), swaps=[];
  for(;;){
    const cfg={transactionDetails:'full',limit:1000,sortOrder:'desc',encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed',filters:{blockTime:{gte:since},status:'succeeded'}};
    if(token) cfg.paginationToken=token;
    const r=await rpc('getTransactionsForAddress',[W,cfg]);
    const d=r.result?.data||[]; if(!d.length) break; calls++;
    for(const tx of d){
      const logs=tx.meta?.logMessages||[];
      const keys=(tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
      if(logs.some(l=>/Instruction: (ClosePosition|RemoveLiquidity)/.test(l))){
        const ixs=[...(tx.transaction?.message?.instructions||[]),...((tx.meta?.innerInstructions||[]).flatMap(i=>i.instructions||[]))];
        for(const ix of ixs){ if((ix.programId||keys[ix.programIdIndex])!==DLMM) continue; for(const a of (ix.accounts||[])) pools.add(a); }
      }
      if(logs.some(l=>/Instruction: (Swap|SharedAccountsRoute|Route)/.test(l))){
        const bm={};
        for(const b of (tx.meta?.preTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)-(+b.uiTokenAmount.uiAmount||0);
        for(const b of (tx.meta?.postTokenBalances||[])) if(b.owner===W) bm[b.mint]=(bm[b.mint]||0)+(+b.uiTokenAmount.uiAmount||0);
        const i=keys.indexOf(W);
        const solD=(((tx.meta?.postBalances||[])[i]||0)-((tx.meta?.preBalances||[])[i]||0))/1e9;
        const sold=Object.entries(bm).filter(([m,v])=>v<-1e-9&&m!==WSOL);
        if(sold.length===1&&solD>0) swaps.push({t:tx.blockTime,mint:sold[0][0],amt:-sold[0][1],sol:solD,sig:tx.transaction.signatures[0]});
      }
    }
    token=r.result?.paginationToken;
    process.stdout.write(`\r  scanning history: ${calls} pages, ${pools.size} accounts touched, ${swaps.length} exit swaps`);
    if(!token||d[d.length-1].blockTime<=since) break;
  }
  console.log('');

  // 2. which of those accounts are actually pools this wallet has positions in?
  const results=[]; let checked=0;
  const cand=[...pools];
  for(let i=0;i<cand.length;i+=6){
    await Promise.all(cand.slice(i,i+6).map(async p=>{
      try{
        const { rows, solPrice } = await allPages(p,W,'closed');
        for(const x of rows){
          if(!x.closedAt||x.closedAt<since) continue;
          const wd=parse(x.allTimeWithdrawals);
          const tokAmt=+(wd.tokenX?.amount||0), tokUsd=+(wd.tokenX?.usd||0), solAmt=+(wd.tokenY?.amount||0);
          if(tokAmt<=0||!solPrice) continue;
          results.push({pool:p,closedAt:x.closedAt,tokAmt,tokUsd,solAmt,solPrice,pos:x.positionAddress});
        }
      }catch(e){}
    }));
    checked+=Math.min(6,cand.length-i);
    process.stdout.write(`\r  checking ${checked}/${cand.length} accounts for your closed positions (${results.length} found)`);
  }
  console.log('\n');

  // 3. pair each close with the swap that sold its token side (same mint, within 30 min after)
  let totExpected=0, totRealized=0; const rowsOut=[];
  for(const r of results){
    const m = swaps.filter(s=>Math.abs(s.amt-r.tokAmt)/Math.max(r.tokAmt,1e-9)<0.02 && s.t>=r.closedAt-60 && s.t<=r.closedAt+1800)
                   .sort((a,b)=>Math.abs(a.t-r.closedAt)-Math.abs(b.t-r.closedAt))[0];
    if(!m) continue;
    const expected = r.tokUsd / r.solPrice;      // what Meteora valued the token side at, in SOL
    const gap = m.sol - expected;
    totExpected += expected; totRealized += m.sol;
    rowsOut.push({...r, got:m.sol, expected, gap, pct: gap/expected*100, sig:m.sig});
  }
  rowsOut.sort((a,b)=>a.gap-b.gap);
  console.log(`paired ${rowsOut.length} position exits with their Jupiter swap\n`);
  console.log('WORST (Meteora valuation vs SOL actually received):');
  for(const r of rowsOut.slice(0,12))
    console.log(`  ${new Date(r.closedAt*1000).toISOString().slice(5,16)} | meteora valued ${r.expected.toFixed(3)} SOL | you got ${r.got.toFixed(3)} | gap ${r.gap>=0?'+':''}${r.gap.toFixed(3)} SOL (${r.pct.toFixed(1)}%)`);
  const tot = totRealized-totExpected;
  console.log(`\nTOTAL over ${rowsOut.length} exits: meteora ${totExpected.toFixed(2)} SOL vs realized ${totRealized.toFixed(2)} SOL`);
  console.log(`=> ${tot>=0?'GAIN':'LOSS'} of ${Math.abs(tot).toFixed(3)} SOL (${(tot/totExpected*100).toFixed(2)}% of token-side value)`);
  console.log(`\nunpaired: ${results.length-rowsOut.length} closes had no matching swap (token kept, or sold in a batch)`);
})().catch(e=>{ console.error('ERR',e.message); process.exit(1); });
