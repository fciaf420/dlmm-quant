// pnlhunt.cjs — identify the wallet behind a Meteora DLMM PnL card (RocketScan/metlex/LP Army style).
// Read-only. Uses the Helius RPC in .env (RPC_URL) + Meteora datapi. No writes, no keys printed.
//
// usage:
//   node pnlhunt.cjs --pair CHARITY-SOL --binStep 200 --baseFee 2 --duration 7:28 --pnl 17.17 [--pages 250] [--tol 4]
//   node pnlhunt.cjs --pool <ADDR> --duration 7:28 --pnl 17.17
//
// A card leaks: pair name, bin step, base fee, hold duration (hh:mm:ss), and PnL% (USD).
// Duration + PnL-to-2dp is effectively a unique fingerprint. Pipeline:
//   1. resolve the pool  (on-chain getProgramAccounts by token mint + bin step; deterministic)
//   2. cheap pass: check CURRENTLY-OPEN positions (card shared while still open)
//   3. walk INITIALIZE_POSITION events newest-first; per position, on-chain sigs give
//      open/close time -> duration; keep those within --tol seconds of the target
//   4. confirm each candidate's owner via datapi closed-PnL (pnlPctChange, USD) ~= target
const { RPC_URL, JUP_KEY: JK } = require('./config.cjs');
const bs58 = require('bs58').default ?? require('bs58');
const DLMM_PROG = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const DATAPI = 'https://dlmm.datapi.meteora.ag';
const KEY = new URL(RPC_URL).searchParams.get('api-key');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const durToSec = (s) => { const p = String(s).split(':').map(Number); return p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p.length === 2 ? p[0]*60+p[1] : p[0]; };
const secToDur = (s) => [Math.floor(s/3600), Math.floor(s%3600/60), s%60].map(x=>String(x).padStart(2,'0')).join(':');
const sleep = (ms) => new Promise(r=>setTimeout(r, ms));
// resilient JSON fetch with 429/5xx backoff (free Helius plan rate-limits hard)
async function jfetch(url, opts) {
  for (let a = 1; a <= 6; a++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) { await sleep(a*1500); continue; }
      return await res.json();
    } catch(e) { if (a === 6) throw e; await sleep(a*1500); }
  }
  throw new Error('rate-limited after 6 tries');
}
const rpc = (m, p) => jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:m, params:p }) });
const jget = (u) => jfetch(u);

async function resolvePool() {
  const explicit = arg('pool'); if (explicit) return explicit;
  const pair = arg('pair'), binStep = +arg('binStep', 0), baseFee = arg('baseFee');
  const base = pair.split('-')[0];
  const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${base}`, { headers:{'x-api-key':JK} });
  // token candidates, most liquid first; find one whose DLMM pools include the bin step
  for (const t of (tk||[]).slice(0, 6)) {
    const r = await rpc('getProgramAccounts', [DLMM_PROG, { encoding:'base64', dataSlice:{offset:0,length:0}, filters:[{dataSize:904},{memcmp:{offset:88,bytes:t.id}}] }]);
    for (const a of (r.result||[])) {
      const meta = await jget(`${DATAPI}/pools/${a.pubkey}`);
      if ((!binStep || meta.pool_config?.bin_step === binStep) && (!baseFee || String(meta.pool_config?.base_fee_pct) === String(baseFee))) {
        console.log(`pool: ${a.pubkey}  (${meta.name}, binStep ${meta.pool_config?.bin_step}, baseFee ${meta.pool_config?.base_fee_pct}%)`);
        return a.pubkey;
      }
    }
  }
  throw new Error('no pool matched pair/binStep/baseFee');
}

async function ownerClosedPnl(pool, owner) {
  const r = await jget(`${DATAPI}/positions/${pool}/pnl?user=${owner}&status=closed`);
  return (r.positions||[]).map(p => ({ pct:+p.pnlPctChange, dur:(p.closedAt&&p.createdAt)?p.closedAt-p.createdAt:null, closedAt:p.closedAt }));
}

(async () => {
  const pool = await resolvePool();
  const targetSec = durToSec(arg('duration', '0'));
  const targetPnl = arg('pnl') != null ? +arg('pnl') : null;
  const tol = +arg('tol', 4);           // seconds of duration slop
  const maxPages = +arg('pages', 250);
  console.log(`target: duration ${secToDur(targetSec)} (±${tol}s), pnl ${targetPnl!=null?'+'+targetPnl+'%':'(any)'}\n`);

  // --- pass 1: currently-open positions (cheap) ---
  const open = await rpc('getProgramAccounts', [DLMM_PROG, { encoding:'base64', dataSlice:{offset:40,length:32}, filters:[{dataSize:8120},{memcmp:{offset:8,bytes:pool}}] }]);
  const openOwners = [...new Set((open.result||[]).map(a=>bs58.encode(Buffer.from(a.account.data[0],'base64'))))];
  for (const o of openOwners) {
    const r = await jget(`${DATAPI}/positions/${pool}/pnl?user=${o}&status=open`);
    for (const p of (r.positions||[])) {
      const age = p.createdAt ? Math.round(Date.now()/1000 - p.createdAt) : null;
      if (age!=null && Math.abs(age-targetSec)<=tol && (targetPnl==null || Math.abs(+p.pnlPctChange-targetPnl)<0.3))
        console.log(`*** MATCH (OPEN) *** owner ${o}  age ${secToDur(age)}  pnl ${(+p.pnlPctChange).toFixed(2)}% USD`);
    }
  }

  // --- pass 2: walk INITIALIZE_POSITION events newest-first; per-position on-chain timing ---
  let before = '', page = 0, checked = 0, hits = 0;
  const seen = new Set();
  while (page++ < maxPages) {
    const txs = await jget(`https://api.helius.xyz/v0/addresses/${pool}/transactions?api-key=${KEY}&limit=100${before?`&before=${before}`:''}`);
    await sleep(250);   // throttle the shared free-plan key
    if (!Array.isArray(txs) || !txs.length) break;
    before = txs[txs.length-1].signature;
    for (const t of txs) {
      if (t.type !== 'INITIALIZE_POSITION') continue;
      const di = (t.instructions||[]).find(i => i.programId===DLMM_PROG && i.accounts?.length>=3 && i.accounts[2]===pool);
      if (!di) continue;
      const position = di.accounts[1], owner = di.accounts[0];
      if (seen.has(position)) continue; seen.add(position);
      // on-chain sigs for this position: first = init, last = close (or still open)
      const sg = await rpc('getSignaturesForAddress', [position, { limit:1000 }]);
      const rows = sg.result||[]; if (rows.length < 2) continue;
      const openT = rows[rows.length-1].blockTime, closeT = rows[0].blockTime;
      const stillOpen = (await rpc('getAccountInfo', [position, {encoding:'base64',dataSlice:{offset:0,length:0}}])).result?.value != null;
      if (stillOpen) continue;
      const dur = closeT - openT; checked++;
      if (Math.abs(dur - targetSec) > tol) continue;
      // duration matches — confirm PnL via datapi (owner's closed positions)
      const cp = await ownerClosedPnl(pool, owner);
      const m = cp.find(x => x.dur!=null && Math.abs(x.dur-targetSec)<=tol && (targetPnl==null || Math.abs(x.pct-targetPnl)<0.3));
      if (m) { console.log(`\n*** MATCH (CLOSED) ***\n  owner    ${owner}\n  position ${position}\n  duration ${secToDur(m.dur)}  pnl ${m.pct.toFixed(2)}% USD\n  https://solscan.io/account/${owner}`); hits++; }
      else console.log(`  dur-match ${secToDur(dur)} owner ${owner.slice(0,6)}… but pnl not confirmed (${cp.map(x=>x.pct.toFixed(1)).join(',')||'no closed rows'})`);
    }
    if (hits) break;
    if (page % 20 === 0) console.log(`  …walked ${page} pages, ${checked} closed positions with ~target duration checked`);
  }
  if (!hits) console.log(`\nno closed match in ${page} pages (${checked} duration-candidates checked). Try --pages higher or --tol wider.`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
