// pnlhunt.cjs — identify the wallet behind a Meteora DLMM PnL card (RocketScan/metlex/LP Army style).
// Read-only. Uses the Helius RPC in .env (RPC_URL) + Meteora datapi. No writes, no keys printed.
//
// usage (give whichever PnL flavor the card shows — cards toggle $/% and USD/SOL):
//   node pnlhunt.cjs --pair CHARITY-SOL --binStep 200 --baseFee 2 --duration 7:28 --pnl 17.17
//   node pnlhunt.cjs --pair STONK-SOL  --binStep 50  --baseFee 0.5 --duration 9:54:46 --pnl 1.38
//   flags: --pnl (card "PNL %")  --pnlUsd ($)  --profitSol  --pnlSolPct  [--pages 250] [--tol 6]
// TOTALS CARDS ("MY TOTAL FEES FROM DLMM POOL" - no TIME field) use a different mode:
//   node pnlhunt.cjs --pair MANLET-SOL --binStep 80 --baseFee 1 --feesX 371980 --feesSol 25.26
//
// FIELD MAP (learned from real cards — metlex/RocketScan use a USD basis):
//   card "PNL  +X%"        -> datapi pnlPctChange   (ALWAYS USD %, even when PROFIT is labeled SOL)  -> --pnl
//   card "PROFIT (USD) $X" -> datapi pnlUsd                                                          -> --pnlUsd
//   card "PROFIT (SOL) X"  -> pnlUsd / SOL_price  (USD pnl expressed in SOL)                         -> --profitSol
// The card's "(BASE + QT)" vs "(QTF)" label is REAL but only tells you SIDEDNESS, not
// which side. Verified against allTimeDeposits 2026-08-11 - QTF appears on BOTH:
//   THEO  (QTF): deposited 486,841 tokens + 0.0000 SOL  -> token-only (sell ladder)
//   REMUS (QTF): deposited 0 tokens      + 6.0000 SOL   -> SOL-only  (bid ladder)
//   HORACE (BASE + QT): 816,218 tokens + 14.95 SOL      -> two-sided
// So: BASE + QT = two-sided, QTF = one-sided (side UNKNOWN from the card alone).
// Read the actual side from allTimeDeposits, never from the label.
//
// DURATION IS THE ESSENTIAL KEY - never match on PnL alone. Caught live on the HORACE
// hunt: a wallet with $204.40 sat next to the true $203.006 and would have been a
// confident false positive. Always pass --duration.
//
// STRATEGIES (auto-selected by pool traffic; override with --strategy):
//   holders  - enumerate the TOKEN's holders (DAS getTokenAccounts) and query datapi
//              per wallet. Independent of pool traffic, so it is the ONLY thing that
//              works on hyperactive pools, and it does not touch the trading RPC's
//              rate limit the way a full-history scan does. DEFAULT for busy pools.
//   close    - scan recent pool history for ClosePosition, then read each position's
//              own (tiny) history. Good on moderate pools.
//   init     - walk INITIALIZE_POSITION newest-first. Good on quiet/young pools.
//   open     - currently-open positions only (card shared while still live). Always run first.
//
// WHY holders EXISTS: HORACE-SOL ran ~25 tx/sec => ~850k txs over the pool's 95-min life
// at ~24MB per 1000 txs (~20GB). Both scan strategies stall silently there. Also proven
// dead ends: Helius rejects every server-side program/instruction filter (-32602), and
// Meteora's /positions/{pool}/pnl ALWAYS requires `user` (no pool-wide listing exists).
//
// THE DECISIVE DETAIL for holders: showZeroBalance:true. An LP who exits leaves a
// DRAINED token account behind, so the default holder view hides exactly the wallet you
// are hunting. On HORACE: 2,995 holders without it (no match) vs 7,881 with it - the
// target was only in the extra 4,886.
//
// ...BUT holders is TIME-SENSITIVE and can silently miss. Verified 2026-08-09 on that
// same HORACE wallet ~1h later: it had CLOSED its drained token account to reclaim the
// rent, and a closed ATA does not appear in getTokenAccounts at all (showZeroBalance
// only surfaces accounts that still EXIST with zero balance). The datapi row was still
// perfectly queryable - we simply had no way to enumerate that wallet. So: run holders
// promptly after a card is posted, and treat "no match" as inconclusive on a busy pool,
// never as proof of absence. On hyperactive pools there is currently no cheap COMPLETE
// enumeration of past LPs - scans are ~20GB, datapi needs a `user`, and holder sets decay.
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
  for (let a = 1; a <= 12; a++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(a*1200, 8000)); continue; }
      return await res.json();
    } catch(e) { if (a === 12) throw e; await sleep(Math.min(a*1200, 8000)); }
  }
  throw new Error('rate-limited after 12 tries');
}
const rpc = (m, p) => jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:m, params:p }) });
const jget = (u) => jfetch(u);

// datapi pages positions at 20. Summing page 1 only silently UNDERCOUNTS, and heavy
// LPs - exactly the wallets that post a totals card - are the worst affected (caught
// 2026-08-10: a wallet read 353k fees on page 1 vs 543k across all 28 positions).
async function allPages(pool, user, status) {
  let out = [], page = 1;
  for (;;) {
    const r = await jget(`${DATAPI}/positions/${pool}/pnl?user=${user}&status=${status}&page=${page}`);
    const p = r.positions || []; out = out.concat(p);
    if (out.length >= (r.totalCount||0) || !p.length || page > 15) break;
    page++;
  }
  return out;
}
const feesOf = (p) => { const f = typeof p.allTimeFees==='string' ? JSON.parse(p.allTimeFees) : (p.allTimeFees||{});
  return { x:+(f.tokenX?.amount||0), y:+(f.tokenY?.amount||0), usd:(+(f.tokenX?.usd||0))+(+(f.tokenY?.usd||0)) }; };

// TOTALS-CARD MODE ("MY TOTAL FEES FROM DLMM POOL"): these cards have NO duration -
// the key that makes position cards uniquely identifiable - so match on cumulative fees
// instead, with two synthetic keys that make it defensible:
//   1. fees only ever GROW, so the true wallet must now EXCEED both card totals
//   2. the fee RATIO (tokenX per SOL) is a composition property of how a wallet LPs
// Ratio narrows; only the CURVE RECONSTRUCTION is conclusive - replay each candidate's
// positions in close-time order and require the running totals to pass through BOTH
// card numbers at the SAME moment. Verified on the MANLET card: the ratio leader was
// 20%% off on that test while the true wallet hit 0.0%%/0.7%%.
async function feesHunt(pool, mint, targetX, targetY, conc) {
  const set = new Set(); let cursor = null;
  for (let i = 0; i < 40; i++) {
    const params = { mint, limit:1000, options:{ showZeroBalance:true } };
    if (cursor) params.cursor = cursor;
    const r = await jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenAccounts', params }) });
    const ta = r.result?.token_accounts || [];
    for (const a of ta) if (a.owner) set.add(a.owner);
    cursor = r.result?.cursor; process.stdout.write(`\r  holders ${set.size}`);
    if (!cursor || !ta.length) break;
  }
  const wallets = [...set]; console.log('');
  const ratio = targetX / targetY, scored = [];
  for (let i = 0; i < wallets.length; i += conc) {
    await Promise.all(wallets.slice(i, i+conc).map(async w => {
      let fx=0, fy=0, n=0;
      for (const st of ['open','closed']) { try { for (const p of await allPages(pool,w,st)) { const f=feesOf(p); fx+=f.x; fy+=f.y; n++; } } catch(e){} }
      if (n && fy > 0.5) scored.push({ w, fx, fy, n });
    }));
    if (i % 400 === 0) process.stdout.write(`\r  checked ${Math.min(i+conc,wallets.length)}/${wallets.length} (${scored.length} LPs)`);
  }
  const plaus = scored.filter(s => s.fx >= targetX*0.97 && s.fy >= targetY*0.97);
  plaus.forEach(s => s.rerr = Math.abs((s.fx/s.fy) - ratio) / ratio);
  plaus.sort((a,b) => a.rerr - b.rerr);
  console.log(`\n\n${scored.length} wallets earned fees here | ${plaus.length} exceed both card totals`);
  // conclusive test on the ratio-closest candidates
  for (const s of plaus.slice(0, 6)) {
    const rows = [];
    for (const st of ['closed','open']) for (const p of await allPages(pool,s.w,st)) { const f = feesOf(p); rows.push({ t: p.closedAt || Math.floor(Date.now()/1000), x:f.x, y:f.y }); }
    rows.sort((a,b)=>a.t-b.t);
    let cx=0, cy=0, best=null;
    for (const r of rows) { cx+=r.x; cy+=r.y; const ex=Math.abs(cx-targetX)/targetX, ey=Math.abs(cy-targetY)/targetY;
      if (!best || ex+ey < best.tot) best = { t:r.t, cx, cy, ex, ey, tot:ex+ey }; }
    const hit = best && best.ex < 0.05 && best.ey < 0.05;
    console.log(`  ${s.w} | ${s.n} pos | now ${Math.round(s.fx).toLocaleString()}/${s.fy.toFixed(2)} | curve best ${Math.round(best.cx).toLocaleString()}/${best.cy.toFixed(2)} @ ${new Date(best.t*1000).toISOString().slice(5,16)} (err ${(best.ex*100).toFixed(1)}%/${(best.ey*100).toFixed(1)}%)${hit?'   <<<< MATCH':''}`);
    if (hit) console.log(`\n*** MATCH ***\n  owner ${s.w}\n  https://solscan.io/account/${s.w}`);
  }
}

// Measure pool traffic before committing to a scan. A full-history scan on a 25 tx/sec
// pool is ~20GB and stalls silently - the failure mode that wasted 17 min on HORACE.
async function poolTxRate(pool) {
  const r = await rpc('getSignaturesForAddress', [pool, { limit: 1000 }]);
  const s = r.result || [];
  if (s.length < 100) return 0;
  const span = Math.max(1, s[0].blockTime - s[s.length-1].blockTime);
  return s.length / span;
}

// HOLDERS STRATEGY: candidates from the token's holder set, not from pool history.
// Cost is independent of pool traffic, and datapi (30 req/s) carries the load instead
// of the Helius key the daemon trades on.
async function holdersHunt(pool, mint, targetSec, T, tol, conc) {
  const wallets = new Set();
  let cursor = null, pages = 0;
  for (;;) {
    const params = { mint, limit: 1000, options: { showZeroBalance: true } };   // <-- exited LPs leave drained accounts
    if (cursor) params.cursor = cursor;
    const r = await jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenAccounts', params }) });
    const ta = r.result?.token_accounts || [];
    for (const a of ta) if (a.owner) wallets.add(a.owner);
    cursor = r.result?.cursor; pages++;
    process.stdout.write(`\r  holders: ${wallets.size} wallets (${pages} pages)`);
    if (!cursor || !ta.length || pages > 40) break;
  }
  console.log('');
  const list = [...wallets];
  let checked = 0;
  const hits = [];
  for (let i = 0; i < list.length; i += conc) {
    await Promise.all(list.slice(i, i+conc).map(async (w) => {
      try {
        const r = await jget(`${DATAPI}/positions/${pool}/pnl?user=${w}&status=closed`);
        for (const p of (r.positions||[])) {
          const dur = (p.closedAt||0) - (p.createdAt||0);
          if (Math.abs(dur - targetSec) <= tol && (!T.length || pnlMatch(p, T))) hits.push({ owner:w, row:p, dur });
        }
      } catch(e){}
    }));
    checked += Math.min(conc, list.length - i);
    process.stdout.write(`\r  datapi: ${checked}/${list.length} wallets  (${hits.length} hits)`);
    if (hits.length) break;
    await sleep(60);
  }
  console.log('');
  return hits;
}

let POOL_MINT = null;   // token_x of the resolved pool (the holders strategy needs it)
// Returns ALL pools matching the card, not the first. Caught live 2026-08-09 on the
// BOT-SOL card: TWO pools shared the exact spec (binStep 200, baseFee 2%) on DIFFERENT
// BOT tokens. Committing to the first scanned the wrong pool exhaustively and reported
// "not found" - a confidently wrong answer. Ticker collisions are common on launches.
async function resolvePools() {
  const explicit = arg('pool');
  if (explicit) { const m = await jget(`${DATAPI}/pools/${explicit}`); POOL_MINT = m.token_x?.address; return [{ pool: explicit, mint: POOL_MINT, name: m.name }]; }
  const pair = arg('pair'), binStep = +arg('binStep', 0), baseFee = arg('baseFee');
  const base = pair.split('-')[0];
  const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${base}`, { headers:{'x-api-key':JK} });
  const found = [];
  for (const t of (tk||[]).slice(0, 20)) {
    const r = await rpc('getProgramAccounts', [DLMM_PROG, { encoding:'base64', dataSlice:{offset:0,length:0}, filters:[{dataSize:904},{memcmp:{offset:88,bytes:t.id}}] }]);
    for (const a of (r.result||[])) {
      const meta = await jget(`${DATAPI}/pools/${a.pubkey}`);
      if ((!binStep || meta.pool_config?.bin_step === binStep) && (!baseFee || String(meta.pool_config?.base_fee_pct) === String(baseFee)))
        found.push({ pool: a.pubkey, mint: meta.token_x?.address, name: meta.name, tvl: Math.round(meta.tvl||0), ageH: +((Date.now()-meta.created_at)/3600e3).toFixed(2) });
    }
  }
  if (!found.length) throw new Error('no pool matched pair/binStep/baseFee');
  if (found.length > 1) {
    console.log(`${found.length} pools match this card's spec — will search each in turn (ticker collision):`);
    for (const f of found) console.log(`   ${f.pool}  ${f.name} tvl ${f.tvl} age ${f.ageH}h`);
  } else console.log(`pool: ${found[0].pool}  (${found[0].name})`);
  return found;
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

// CLOSE-ANCHORED SCAN (the efficient shape for busy pools).
// Helius has blockTime/status filters but NO program or instruction filter, so any pool
// scan drags the whole firehose (Bark-SOL runs 125 tx/sec of MEV/JIT spam) and discards
// ~99.9%% client-side. The fix is to stop scanning the hold at all: a POSITION account has
// its own tiny history (a handful of txs), so we only need to spot the CLOSE — which is
// recent for a freshly-posted card — and then read that one position's life in a single
// cheap getSignaturesForAddress call. Scanning 20 min of closes beats scanning 2h of
// everything: the bot noise DURING the hold never gets read.
async function closeScan(pool, minutes, conc, targetSec, tol) {
  const now = Math.floor(Date.now()/1000), since = now - Math.round(minutes*60);
  const nWin = Math.max(1, Math.min(conc, Math.ceil((now-since)/120)));
  const step = Math.ceil((now - since) / nWin);
  const positions = new Set();
  let calls = 0;
  const scanWin = async (lo, hi) => {
    let token = null;
    for (;;) {
      const cfg = { transactionDetails:'full', limit:1000, sortOrder:'desc', encoding:'jsonParsed',
        maxSupportedTransactionVersion:0, commitment:'confirmed',
        filters:{ blockTime:{ gte:lo, lte:hi }, status:'succeeded' } };
      if (token) cfg.paginationToken = token;
      const r = await jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTransactionsForAddress', params:[pool, cfg] }) });
      const d = r.result?.data || []; calls++;
      if (!d.length) return;
      for (const tx of d) {
        const logs = tx.meta?.logMessages || [];
        if (!logs.some(l=>/Instruction: ClosePosition/.test(l))) continue;
        const msg = tx.transaction?.message; const keys = (msg?.accountKeys||[]).map(k=>k.pubkey||k);
        const ixs = [...(msg?.instructions||[]), ...((tx.meta?.innerInstructions||[]).flatMap(i=>i.instructions||[]))];
        for (const ix of ixs) {
          if ((ix.programId || keys[ix.programIdIndex]) !== DLMM_PROG) continue;
          for (const a of (ix.accounts||[])) if (a !== pool) positions.add(a);
        }
      }
      token = r.result?.paginationToken;
      if (!token || d[d.length-1].blockTime <= lo) return;
    }
  };
  const wins = []; for (let hi = now; hi > since; hi -= step) wins.push([Math.max(since, hi-step), hi]);
  console.log(`close-scan: last ${minutes} min in ${wins.length} parallel windows…`);
  await Promise.all(wins.map(([lo,hi]) => scanWin(lo,hi).catch(e=>console.log('  window err', e.message))));
  console.log(`  ${calls} calls | ${positions.size} accounts seen in close txs — reading each position's own history`);
  // each position account has a tiny history: 1 cheap call gives open + close.
  // JSON-RPC BATCHING: 100 getSignaturesForAddress per HTTP request instead of one
  // round trip each (877 accounts -> ~9 requests). Per Helius optimization guidance.
  const cands = [];
  const list = [...positions];
  // a batch of N counts as N requests against the plan's rate limit, so keep batches
  // modest and pace them — 100 at once 429s instantly on the free tier.
  const BATCH = +arg('batch', 20);
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i+BATCH);
    const body = chunk.map((p, j) => ({ jsonrpc:'2.0', id:j, method:'getSignaturesForAddress', params:[p, { limit:1000 }] }));
    let res; try { res = await jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }); }
    catch(e) { console.log(`\n  batch ${i} failed (${e.message}) — continuing`); continue; }
    for (const r of (Array.isArray(res) ? res : [])) {
      const s = r.result||[]; if (s.length < 2) continue;
      const dur = s[0].blockTime - s[s.length-1].blockTime;
      if (Math.abs(dur - targetSec) <= tol) cands.push({ position: chunk[r.id], dur });
    }
    process.stdout.write(`\r  positions read: ${Math.min(i+BATCH, list.length)}/${list.length}  (${cands.length} dur-hits)`);
    await sleep(200);
  }
  console.log('');
  console.log(`  ${cands.length} with duration ≈ ${secToDur(targetSec)}`);
  return cands;
}

async function deepScan(pool, hours, conc) {
  const now = Math.floor(Date.now()/1000), since = now - Math.round(hours*3600);
  const nWin = Math.max(1, Math.min(conc, Math.ceil((now-since)/300)));
  const step = Math.ceil((now - since) / nWin);
  const opens = new Map(), closes = new Map();
  let calls = 0;
  const scanWin = async (lo, hi) => {
    let token = null;
    for (;;) {
      const cfg = { transactionDetails:'full', limit:1000, sortOrder:'desc', encoding:'jsonParsed',
        maxSupportedTransactionVersion:0, commitment:'confirmed',
        filters:{ blockTime:{ gte:lo, lte:hi }, status:'succeeded' } };
      if (token) cfg.paginationToken = token;
      const r = await jfetch(RPC_URL, { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTransactionsForAddress', params:[pool, cfg] }) });
      const d = r.result?.data || []; calls++;
      if (!d.length) return;
      for (const tx of d) {
        const logs = tx.meta?.logMessages || []; if (!logs.length) continue;
        const isInit = logs.some(l=>/Instruction: InitializePosition/.test(l));
        const isClose = logs.some(l=>/Instruction: ClosePosition/.test(l));
        if (!isInit && !isClose) continue;
        const msg = tx.transaction?.message; const keys = (msg?.accountKeys||[]).map(k=>k.pubkey||k);
        const ixs = [...(msg?.instructions||[]), ...((tx.meta?.innerInstructions||[]).flatMap(i=>i.instructions||[]))];
        for (const ix of ixs) {
          if ((ix.programId || keys[ix.programIdIndex]) !== DLMM_PROG) continue;
          const acc = ix.accounts || [];
          if (isInit && acc.length >= 3 && acc[2] === pool && !opens.has(acc[1])) opens.set(acc[1], { owner: acc[0], t: tx.blockTime });
          // close ix layout varies; any DLMM account that already has an open record is the position
          if (isClose) for (const a of acc) if (!closes.has(a)) closes.set(a, tx.blockTime);
        }
      }
      token = r.result?.paginationToken;
      if (!token || d[d.length-1].blockTime <= lo) return;
    }
  };
  const wins = []; for (let hi = now; hi > since; hi -= step) wins.push([Math.max(since, hi-step), hi]);
  console.log(`deep scan: ${hours}h of history in ${wins.length} parallel windows…`);
  await Promise.all(wins.map(([lo,hi]) => scanWin(lo,hi).catch(e=>console.log('  window err', e.message))));
  console.log(`  ${calls} calls | ${opens.size} position opens, ${closes.size} close-candidates`);
  return { opens, closes };
}

async function huntOne(pool) {
  // TOTALS-CARD branch: --feesX / --feesSol instead of --duration / --pnl
  if (arg('feesX') != null && arg('feesSol') != null) {
    if (!POOL_MINT) { console.log('  need the token mint — pass --pool or --pair'); return; }
    console.log(`totals-card mode: ${(+arg('feesX')).toLocaleString()} tokenX + ${arg('feesSol')} SOL (ratio ${Math.round(+arg('feesX')/+arg('feesSol')).toLocaleString()}/SOL)`);
    await feesHunt(pool, POOL_MINT, +arg('feesX'), +arg('feesSol'), +arg('conc', 10));
    return;
  }
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

  // --- pass 1.2: TRAFFIC GUARD + HOLDERS STRATEGY ---
  // A scan's cost scales with pool traffic; the holders route does not. Measure first
  // rather than stalling for 17 minutes on a 20GB scan (the HORACE failure mode).
  const strategy = arg('strategy', 'auto');
  const rate = await poolTxRate(pool);
  // Threshold calibrated from both ends: HORACE ran 200 tx/sec (~20GB, genuinely
  // unscannable) while BOT ran 7.4 tx/sec (~27k txs/hour = ~27 calls, trivially
  // scannable) - the first cutoff of 5 sent BOT down the holders path for nothing.
  // Scanning is EXACT where holders is best-effort (an LP that closed its drained
  // token account is unenumerable), so prefer scanning whenever it is affordable.
  const BUSY = +arg('busyTps', 40);
  console.log(`pool traffic: ${rate.toFixed(1)} tx/sec` + (rate >= BUSY ? `  → too busy to scan; using holders strategy` : ''));
  if (strategy === 'holders' || (strategy === 'auto' && rate >= BUSY)) {
    if (!POOL_MINT) { console.log('  cannot run holders strategy: token mint unresolved'); }
    else {
      console.log(`holders strategy on mint ${POOL_MINT.slice(0,8)}… (showZeroBalance:true — exited LPs leave drained accounts)`);
      const hits = await holdersHunt(pool, POOL_MINT, targetSec, T, tol, +arg('conc', 8));
      for (const h of hits) {
        const dep = typeof h.row.allTimeDeposits==='string' ? JSON.parse(h.row.allTimeDeposits) : h.row.allTimeDeposits;
        const sided = (+dep?.tokenX?.amount > 0 && +dep?.tokenY?.amount > 0) ? 'TWO-SIDED (card: BASE + QT)'
                    : (+dep?.tokenX?.amount > 0 ? 'ONE-SIDED (token only)' : 'ONE-SIDED (SOL only)');
        console.log(`\n*** MATCH (CLOSED) ***\n  owner    ${h.owner}\n  position ${h.row.positionAddress}\n  dur ${secToDur(h.dur)} | PNL% ${(+h.row.pnlPctChange).toFixed(2)} | pnlUsd $${(+h.row.pnlUsd).toFixed(2)} | pnlSol ${(+h.row.pnlSol).toFixed(3)}\n  deposits X ${(+dep?.tokenX?.amount||0).toFixed(2)} / SOL ${(+dep?.tokenY?.amount||0).toFixed(3)} → ${sided}\n  https://solscan.io/account/${h.owner}`);
      }
      if (!hits.length) console.log('\nno match in the holder set — INCONCLUSIVE, not proof of absence: an LP that\n  closed its drained token account (to reclaim rent) is unenumerable this way.\n  Try sooner after the card, widen --tol, or check sibling pools.');
      return;
    }
  }

  // --- pass 1.5: CLOSE-ANCHORED SCAN (default; --mins 0 disables) ---
  const mins = +arg('mins', 30);
  if (mins > 0) {
    const conc = +arg('conc', 12);
    const cands = await closeScan(pool, mins, conc, targetSec, tol);
    for (const c of cands) {
      // owner = fee payer of the position's first tx (the init)
      const sg = await rpc('getSignaturesForAddress', [c.position, { limit:1000 }]);
      const first = (sg.result||[]).slice(-1)[0];
      const tx = await rpc('getTransaction', [first.signature, { encoding:'jsonParsed', maxSupportedTransactionVersion:0 }]);
      const owner = (tx.result?.transaction?.message?.accountKeys||[]).find(k=>k.signer)?.pubkey;
      if (!owner) continue;
      c.owner = owner;
      const cr = await jget(`${DATAPI}/positions/${pool}/pnl?user=${owner}&status=closed`);
      const row = (cr.positions||[]).find(p => p.positionAddress === c.position);
      if (!row) { console.log(`  ${owner.slice(0,6)}… dur ${secToDur(c.dur)} — no datapi row`); continue; }
      const dep = typeof row.allTimeDeposits==='string' ? JSON.parse(row.allTimeDeposits) : row.allTimeDeposits;
      const sided = (+dep?.tokenX?.amount > 0 && +dep?.tokenY?.amount > 0) ? 'TWO-SIDED' : (+dep?.tokenX?.amount > 0 ? 'ONE-SIDED (token only)' : 'ONE-SIDED (SOL only)');
      const line = `dur ${secToDur(c.dur)} | PNL% ${(+row.pnlPctChange).toFixed(2)} | pnlUsd $${(+row.pnlUsd).toFixed(2)} | pnlSol ${(+row.pnlSol).toFixed(3)} | deposits X ${(+dep?.tokenX?.amount||0).toFixed(2)} / SOL ${(+dep?.tokenY?.amount||0).toFixed(3)} → ${sided}`;
      if (!T.length || pnlMatch(row, T)) { console.log(`\n*** MATCH (CLOSED) ***\n  owner    ${c.owner}\n  position ${c.position}\n  ${line}\n  https://solscan.io/account/${c.owner}`); process.exit(0); }
      console.log(`  DUR-MATCH ${c.owner} | ${line}`);
    }
    if (cands.length) console.log('\n(duration candidates above did not confirm on PnL — widen --tol or check the flag mapping)');
    else console.log('  → nothing in this window; the card is likely older — retry with --mins 90');
    return;
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
}

(async () => {
  const pools = await resolvePools();
  for (const [i, p] of pools.entries()) {
    POOL_MINT = p.mint;
    if (pools.length > 1) console.log(`\n───── searching pool ${i+1}/${pools.length}: ${p.pool} (${p.name}) ─────`);
    try { await huntOne(p.pool); } catch(e) { console.log(`  pool errored: ${e.message}`); }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
