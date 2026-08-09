// wallettrace.cjs — "I have this wallet. Where did the money come from, and where did it go?"
// On-demand, read-only, no monitoring. Uses the Helius RPC in .env + Meteora datapi.
//
//   node wallettrace.cjs <WALLET> [--min 0.3] [--hops 1] [--limit 1000]
//
//   --min    minimum SOL moved to be worth reporting (default 0.3)
//   --hops   follow destinations N levels deep (default 1; 2 gets slow but works)
//   --limit  transactions to pull per wallet (default 1000 = usually the whole history)
//
// Why this is cheap where the pool hunts were not: a POOL can run 200 tx/sec (~20GB of
// history), but an LP wallet typically has hundreds of transactions total. One
// getTransactionsForAddress call usually covers a wallet's entire life.
//
// SOL flow is derived from pre/postBalances rather than parsed transfer instructions, so
// it catches every movement shape (system transfer, CPI, program-initiated) without
// needing getTransfersByAddress (which is Developer+ tier and unavailable on the free plan).
const { RPC_URL } = require('./config.cjs');
const DLMM_PROG = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise(r=>setTimeout(r, ms));
async function jfetch(url, opts) {
  for (let a = 1; a <= 8; a++) {
    try { const r = await fetch(url, opts); if (r.status === 429 || r.status >= 500) { await sleep(a*1200); continue; } return await r.json(); }
    catch(e) { if (a === 8) throw e; await sleep(a*1200); }
  }
  throw new Error('rate-limited');
}
const rpc = (m, p) => jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:m, params:p }) });
const SOL = (lamports) => (lamports/1e9);
const when = (t) => new Date(t*1000).toISOString().replace('T',' ').slice(0,16);

// Every SOL move in/out of `wallet`, with the counterparty that gained/lost the most.
async function flows(wallet, limit) {
  const r = await rpc('getTransactionsForAddress', [wallet, { transactionDetails:'full', limit:+limit,
    sortOrder:'desc', encoding:'jsonParsed', maxSupportedTransactionVersion:0, commitment:'confirmed', filters:{ status:'succeeded' } }]);
  const txs = r.result?.data || [];
  const out = [], inn = [];
  let touchedDLMM = 0;
  for (const tx of txs) {
    const keys = (tx.transaction?.message?.accountKeys||[]).map(k=>k.pubkey||k);
    const i = keys.indexOf(wallet); if (i < 0) continue;
    const pre = tx.meta?.preBalances||[], post = tx.meta?.postBalances||[];
    if (!pre.length) continue;
    if ((tx.meta?.logMessages||[]).some(l=>l.includes(DLMM_PROG))) touchedDLMM++;
    const d = (post[i]||0) - (pre[i]||0);
    if (Math.abs(d) < 1e6) continue;                    // ignore sub-0.001 SOL noise (fees)
    // counterparty = the OTHER account whose balance moved the opposite way the most
    let best = null, bestD = 0;
    for (let j = 0; j < keys.length; j++) {
      if (j === i) continue;
      const dj = (post[j]||0) - (pre[j]||0);
      if (Math.sign(dj) === Math.sign(d) || dj === 0) continue;
      if (Math.abs(dj) > Math.abs(bestD)) { bestD = dj; best = keys[j]; }
    }
    (d < 0 ? out : inn).push({ t: tx.blockTime, sol: Math.abs(SOL(d)), other: best, sig: tx.transaction?.signatures?.[0] });
  }
  return { out, inn, n: txs.length, touchedDLMM };
}

// does this address look like an LP? (open DLMM positions on-chain right now)
async function isLP(addr) {
  const r = await rpc('getProgramAccounts', [DLMM_PROG, { encoding:'base64', dataSlice:{offset:0,length:0},
    filters:[{ dataSize:8120 }, { memcmp:{ offset:40, bytes:addr } }] }]);
  return (r.result||[]).length;
}

// CRITICAL for answering "where did the money go": most large counterparties are POOLS
// and PDAs (an LP deposit looks exactly like a big SOL outflow), not other wallets. A
// real wallet is owned by the System Program; everything else is a program account.
const SYSTEM = '11111111111111111111111111111111';
async function classify(addrs) {
  const kind = {};
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i+100);
    const r = await rpc('getMultipleAccounts', [chunk, { encoding:'base64', dataSlice:{offset:0,length:0} }]);
    (r.result?.value||[]).forEach((v, j) => { kind[chunk[j]] = !v ? 'wallet(empty)' : (v.owner === SYSTEM ? 'wallet' : 'program/pool'); });
  }
  return kind;
}

function summarize(list, minSol) {
  const by = {};
  for (const f of list) { if (f.sol < minSol || !f.other) continue;
    const b = by[f.other] || (by[f.other] = { sol:0, n:0, first:f.t, last:f.t });
    b.sol += f.sol; b.n++; b.first = Math.min(b.first, f.t); b.last = Math.max(b.last, f.t); }
  return Object.entries(by).sort((a,b)=>b[1].sol-a[1].sol);
}

(async () => {
  const wallet = process.argv[2];
  if (!wallet || wallet.startsWith('--')) { console.error('usage: node wallettrace.cjs <WALLET> [--min 0.3] [--hops 1]'); process.exit(1); }
  const minSol = +arg('min', 0.3), hops = +arg('hops', 1), limit = arg('limit', 1000);

  const bal = await rpc('getBalance', [wallet]);
  console.log(`\n=== ${wallet} ===`);
  console.log(`current balance: ${SOL(bal.result?.value||0).toFixed(4)} SOL`);
  const f = await flows(wallet, limit);
  console.log(`history: ${f.n} txs pulled | ${f.touchedDLMM} touched the DLMM program`);
  const open = await isLP(wallet);
  console.log(`open DLMM positions right now: ${open}`);

  const ins = summarize(f.inn, minSol), outs = summarize(f.out, minSol);
  const kind = await classify([...new Set([...ins, ...outs].map(([a])=>a))]);
  const wOut = outs.filter(([a])=>kind[a]?.startsWith('wallet')), wIn = ins.filter(([a])=>kind[a]?.startsWith('wallet'));
  const pOut = outs.filter(([a])=>kind[a]==='program/pool');

  if (wIn.length) {
    const [funder, d] = wIn[wIn.length-1];   // earliest significant inbound WALLET = likely funder
    console.log(`\nFUNDED BY (earliest significant inbound wallet): ${funder}\n  ${d.sol.toFixed(3)} SOL @ ${when(d.first)}   https://solscan.io/account/${funder}`);
  }
  console.log(`\n>>> WALLET → WALLET MOVES (≥${minSol} SOL) — where the money actually went:`);
  if (!wOut.length) console.log('  (none — funds stayed in this wallet or only moved to pools/programs)');
  for (const [a,d] of wOut.slice(0,12)) {
    const lp = await isLP(a);
    console.log(`  ${a}  ${d.sol.toFixed(3)} SOL over ${d.n} tx  ${when(d.first)} → ${when(d.last)}${lp?`  <<< LP WALLET (${lp} open positions)`:''}`);
  }
  console.log(`\nwallet → wallet INBOUND (≥${minSol} SOL):`);
  for (const [a,d] of wIn.slice(0,8)) console.log(`  ${a}  ${d.sol.toFixed(3)} SOL over ${d.n} tx  ${when(d.first)}`);
  // LP activity is the noisy majority — summarize, don't list every pool
  const lpSol = pOut.reduce((s,[,d])=>s+d.sol,0);
  console.log(`\n(LP/program activity, not money movement: ${pOut.length} pools/PDAs, ${lpSol.toFixed(0)} SOL deposited — excluded above)`);

  if (hops > 1) {
    console.log(`\n--- following top destinations (hop 2) ---`);
    for (const [a] of outs.slice(0, 3)) {
      const b = await rpc('getBalance', [a]);
      const f2 = await flows(a, 1000);
      const o2 = summarize(f2.out, minSol);
      const lp = await isLP(a);
      console.log(`\n  ${a}  bal ${SOL(b.result?.value||0).toFixed(3)} SOL | ${f2.touchedDLMM} DLMM txs | ${lp} open positions`);
      for (const [c,d] of o2.slice(0,5)) console.log(`     → ${c}  ${d.sol.toFixed(3)} SOL  ${when(d.last)}`);
    }
  }
  console.log('');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
