const { RPC_URL, JUP_KEY: JK, keypair } = require('./config.cjs');
// Bin-gap scorer: score = P(traversal) / crowding
// usage: node binscore.cjs <poolAddress> <dailyVolPct> [side: both|up|down]
const DLMMImport = require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = DLMMImport.default ?? DLMMImport;
(async () => {
  const [pool, dailyVolPctArg] = process.argv.slice(2);
  const dailyVolPct = Number(dailyVolPctArg || 50);       // realized vol %/day from Jupiter stats
  const conn = new Connection(RPC_URL, 'confirmed');
  const dlmm = await DLMM.create(conn, new PublicKey(pool));
  const binStepPct = dlmm.lbPair.binStep / 100;           // % per bin
  const active = await dlmm.getActiveBin();
  const { bins } = await dlmm.getBinsAroundActiveBin(35, 35);
  const decX = dlmm.tokenX.mint.decimals ?? dlmm.tokenX.decimal;
  const decY = dlmm.tokenY.mint.decimals ?? dlmm.tokenY.decimal;
  // sigma in bins over ~4h horizon: dailyVol/sqrt(6) then / binStep
  const sigmaBins = Math.max((dailyVolPct / Math.sqrt(6)) / binStepPct, 1);
  const rows = bins.map(b => {
    const d = Math.abs(b.binId - active.binId);
    const x = Number(b.xAmount) / 10**decX;
    const y = Number(b.yAmount) / 10**decY;
    const p = Number(b.price) * 10**(decX - decY);        // price of X in Y (real units)
    const liqY = x * p + y;                                // bin liquidity in token-Y units
    const pTrav = Math.exp(-d / sigmaBins);                // traversal likelihood proxy
    const score = pTrav / (liqY + 0.1);
    return { bin: b.binId, distBins: b.binId - active.binId, priceY: p, liqY, pTrav, score };
  }).filter(r => r.distBins !== 0);
  rows.sort((a,b)=>b.score-a.score);
  console.log(`pool ${pool}  binStep ${binStepPct}%  sigmaBins(4h) ${sigmaBins.toFixed(1)}  activeBin ${active.binId}`);
  console.log('TOP GAP BINS (high traversal / low crowding):');
  console.log('bin | dist | price | binLiq(Y units) | P(trav) | score');
  for (const r of rows.slice(0, 12))
    console.log(`${r.bin} | ${r.distBins>0?'+':''}${r.distBins} | ${r.priceY.toExponential(3)} | ${r.liqY.toFixed(2)} | ${(r.pTrav*100).toFixed(0)}% | ${r.score.toFixed(4)}`);
  const crowded = [...rows].sort((a,b)=>b.liqY-a.liqY).slice(0,5);
  console.log('\nMOST CROWDED (avoid):');
  for (const r of crowded) console.log(`${r.bin} | ${r.distBins>0?'+':''}${r.distBins} | liq ${r.liqY.toFixed(2)}`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
