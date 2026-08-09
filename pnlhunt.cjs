// pnlhunt.cjs — identify the wallet behind a Meteora DLMM PnL card (RocketScan/metlex/LP Army style).
// Read-only. Uses the Helius RPC in .env (RPC_URL) + Meteora datapi. No writes, no keys printed.
//
// usage (give whichever PnL flavor the card shows — cards toggle $/% and USD/SOL):
//   node pnlhunt.cjs --pair CHARITY-SOL --binStep 200 --baseFee 2 --duration 7:28 --pnl 17.17
//   node pnlhunt.cjs --pair STONK-SOL  --binStep 50  --baseFee 0.5 --duration 9:54:46 --pnl 1.38
//   flags: --pnl (the card's "PNL %")  --pnlUsd ($)  --profitSol (card "PROFIT (SOL)")  --pnlSolPct (rare)  [--pages 250] [--tol 6]
//
// FIELD MAP (learned from real cards — metlex/RocketScan use a USD basis):
//   card "PNL  +X%"        -> datapi pnlPctChange   (ALWAYS USD %, even when PROFIT is labeled SOL)  -> --pnl
//   card "PROFIT (USD) $X" -> datapi pnlUsd                                                          -> --pnlUsd
//   card "PROFIT (SOL) X"  -> pnlUsd / SOL_price  (USD pnl expressed in SOL)                         -> --profitSol
// The bottom-bar "PNL %" is the most reliable single anchor. Pair it with --duration.
// Duration + the PNL% to ~2dp is effectively a unique fingerprint. Pipeline:
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

// PnL targets from whatever flags the card showed. Absolute amounts ($/SOL) match on
// relative tolerance (card rounding); percentages match on absolute tolerance.
function pnlTargets() {
  const T = [];
  if (arg('pnl')       != null) T.push({ field:'pnlPctChange',    v:+arg('pnl'),       abs:0.3,  label:'PNL%' });  // card "PNL %" (USD basis)
  if (arg('pnlUsd')    != null) T.push({ field:'pnlUsd',          v:+arg('pnlUsd'),    rel:0.03, label:'$'    });  // card "PROFIT (USD)"
  if (arg('pnlSolPct') != null) T.push({ field:'pnlSolPctChange', v:+arg('pnlSolPct'), abs:0.3,  label:'SOL%' });  // rare
  if (arg('pnlSol')    != null) T.push({ field:'pnlSol',          v:+arg('pnlSol'),    rel:0.03, label:'SOLnet' });
  // card "PROFIT (SOL)" = pnlUsd / SOL_price. We don't have SOL_price offline, so match
  // pnlUsd within a wide band consistent with SOL ~$60-260 (profitSol * price).
  if (arg('profitSol') != null) T.push({ field:'pnlUsd', v:+arg('profitSol'), lo:+arg('profitSol')*60, hi:+arg('profitSol')*260, label:'profitSOL' });
  return T;
}
const pnlMatch = (row, T) => T.every(t => t.lo != null ? (+row[t.field] >= t.lo && +row[t.field] <= t.hi)
                                        : t.abs != null ? Math.abs(+row[t.field]-t.v) <= t.abs
                                                        : Math.abs(+row[t.field]-t.v) <= Math.max(t.rel*Math.abs(t.v), 0.01));
const pnlShow = (row, T) => (T.length?T:[{field:'pnlPctChange',label:'USD%'}]).map(t=>`${t.label} ${(+row[t.field]).toFixed(2)}`).join(' / ');

(async () => {
  const pool = await resolvePool();
  const targetSec = durToSec(arg('duration', '0'));
  const T = pnlTargets();
  const tol = +arg('tol', 4);           // seconds of duration slop
  const maxPages = +arg('pages', 250);
  console.log(`target: duration ${secToDur(targetSec)} (±${tol}s), pnl ${T.length?T.map(t=>t.label+' '+t.v).join(' & '):'(any)'}\n`);

  // --- pass 1: currently-open positions (cheap) ---
  const open = await rpc('getProgramAccounts', [DLMM_PROG, { encoding:'base64', dataSlice:{offset:40,length:32}, filters:[{dataSize:8120},{memcmp:{offset:8,bytes:pool}}] }]);
  const openOwners = [...new Set((open.result||[]).map(a=>bs58.encode(Buffer.from(a.account.data[0],'base64'))))];
  for (const o of openOwners) {
    const r = await jget(`${DATAPI}/positions/${pool}/pnl?user=${o}&status=open`);
    for (const p of (r.positions||[])) {
      const age = p.createdAt ? Math.round(Date.now()/1000 - p.createdAt) : null;
      if (age!=null && Math.abs(age-targetSec)<=tol && (!T.length || pnlMatch(p, T)))
        console.log(`*** MATCH (OPEN) *** owner ${o}  age ${secToDur(age)}  pnl ${pnlShow(p, T)}`);
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
      // duration matches — pull the owner's closed rows and find THIS position's row
      const cr = await jget(`${DATAPI}/positions/${pool}/pnl?user=${owner}&status=closed`);
      const crows = (cr.positions||[]).map(p => ({ ...p, dur:(p.closedAt&&p.createdAt)?p.closedAt-p.createdAt:null }));
      const row = crows.find(x => x.positionAddress===position) || crows.find(x => x.dur!=null && Math.abs(x.dur-targetSec)<=tol);
      const feeSol = (() => { try { return +JSON.parse(row.allTimeFees||'{}').tokenY?.amount || (row.allTimeFees?.tokenY?.amount); } catch { return row?.allTimeFees?.tokenY?.amount; } })();
      const depSol = (() => { try { const d=typeof row.allTimeDeposits==='string'?JSON.parse(row.allTimeDeposits):row.allTimeDeposits; return d?.tokenY?.amount; } catch { return null; } })();
      const info = row ? `dur ${secToDur(row.dur)} | pnlSol ${(+row.pnlSol).toFixed(3)} (${(+row.pnlSolPctChange).toFixed(2)}%) | feesSOL ${feeSol!=null?(+feeSol).toFixed(2):'?'} | depositSOL ${depSol!=null?(+depSol).toFixed(1):'?'} | entryPx ${row.minPrice||row.entryPrice||'?'}` : 'no row';
      const pnlOk = row && (!T.length || pnlMatch(row, T));
      if (pnlOk) { console.log(`\n*** MATCH (CLOSED) ***\n  owner    ${owner}\n  position ${position}\n  ${info}\n  https://solscan.io/account/${owner}`); hits++; }
      else console.log(`  DUR-MATCH ${secToDur(dur)} owner ${owner} position ${position} | ${info}`);
    }
    if (hits) break;
    if (page % 20 === 0) console.log(`  …walked ${page} pages, ${checked} closed positions with ~target duration checked`);
  }
  if (!hits) console.log(`\nno closed match in ${page} pages (${checked} duration-candidates checked). Try --pages higher or --tol wider.`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
