// DLMM Quant Trader Daemon — mechanical loop, runs under launchd, immune to screen lock.
// Manage every TICK_MS; scan+deploy every SCAN_MS. Events -> events.log (+ macOS notification).
const fs = require('fs'); const { execFileSync } = require('child_process');
const DIR = __dirname;
const { RPC_URL, JUP_KEY: JK, keypair, CFG } = require("./config.cjs");
const { fetchVolDay, sigmaFrom } = require("./vol.cjs");
const GATES = require("./gates.cjs");   // shared with screen.cjs — edit gates THERE, not inline
const { createCandleDiagnostics } = require('./candle_diagnostics.cjs');
const { refreshBidAskCandidates } = require('./bidask_runtime.cjs');
const SOLM = CFG.QUOTE_MINT;
const WALLET = keypair().publicKey.toBase58();
const MET = "https://dlmm.datapi.meteora.ag";
const TICK_MS = CFG.TICK_MS, SCAN_EVERY = CFG.SCAN_EVERY;
const NODE = process.execPath;
const HEARTBEAT = DIR + '/daemon.heartbeat';
const BID_ASK_PENDING = DIR + '/.pending-bid-ask.json';
let tick = 0;
// --- graceful shutdown ---
// Ctrl-C sets a flag rather than killing outright. Deploy/exit children run under
// execFileSync, which blocks the event loop, so the handler can only fire between
// steps — an in-flight transaction always finishes first. Second Ctrl-C forces out.
let stopping = false, wake = null;
const sleep = (ms) => new Promise(r => { wake = r; setTimeout(r, ms); });
function shutdown(sig){
  if (stopping) { console.log(`\n${sig} again - forcing exit`); process.exit(1); }
  stopping = true;
  console.log(`\n${sig} - finishing current step, then exiting (Ctrl-C again to force)`);
  if (wake) wake();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Clear the heartbeat so the next start isn't blocked by the 3-minute liveness guard.
process.on('exit', () => { try { fs.rmSync(HEARTBEAT, { force: true }); } catch(e){} });
const st = () => fs.existsSync(DIR+'/daemon_state.json') ? JSON.parse(fs.readFileSync(DIR+'/daemon_state.json','utf8')) : { lastFeeRates:{}, cooldowns:{}, alerted:{} };
const saveSt = (s) => fs.writeFileSync(DIR+'/daemon_state.json', JSON.stringify(s,null,1));
const reg = () => fs.existsSync(DIR+'/positions.json') ? JSON.parse(fs.readFileSync(DIR+'/positions.json','utf8')) : [];
function ev(msg){
  const line = `${new Date().toISOString()} | ${msg}`;
  fs.appendFileSync(DIR+'/events.log', line+'\n');
  try { execFileSync('/usr/bin/osascript',['-e',`display notification ${JSON.stringify(msg.slice(0,180))} with title "DLMM Trader"`]); } catch(e){}
  console.log(line);
}
const log = (m) => { fs.appendFileSync(DIR+'/daemon.log', `${new Date().toISOString()} | ${m}\n`); };
// One compact stdout line per tick. Detail stays in daemon.log.
const hb = (m) => { console.log(`${new Date().toTimeString().slice(0,8)} ${m}`); };
// Scan progress: indented, goes to both stdout and daemon.log so the terminal
// shows what's being evaluated instead of sitting silent for ~15s.
const sc = (m) => { console.log(`         ${m}`); log(m); };
// BID ASK history is refreshed synchronously for at most two deduplicated,
// capacity-fitting candidates when no TRADE will deploy. Remaining base-ready
// candidates stay WATCH and rotate through the deferred descriptive collector.
const candleDiagnostics = createCandleDiagnostics({
  cacheFile: DIR + '/candle_evidence.json',
  maxPools: 8,
  maxPerBatch: 2,
  onError: error => { try { log(`candle diagnostic err: ${error?.message || error}`); } catch (e) {} },
});
// First gate a candidate fails, so a rejection is legible at a glance.
// (log text only — thresholds mirror gates.cjs ignition(); keep in sync when tuning)
function blocker(edge, sg, ac, org, path, ageH, ofi){
  if (path === 'FREEFALL') return 'FREEFALL';
  if (edge < 1.0)  return `edge ${edge.toFixed(2)}<1.0`;
  if (sg   < 1.25) return `surge ${sg.toFixed(2)}<1.25`;
  if (ac   < 1.2)  return `accel ${ac.toFixed(2)}<1.2`;
  if (org  < 40)   return `org ${org.toFixed(0)}<40`;
  if (!(ageH >= 6 || (org >= 60 && ofi < 2))) return `age ${ageH.toFixed(1)}h<6`;
  return 'no fit';
}
async function jget(u, jup){ const r = await fetch(u, jup?{headers:{'x-api-key':JK}}:undefined); if(!r.ok) throw new Error(`${r.status} ${u.slice(0,60)}`); return r.json(); }

// ---- TRADE JOURNAL: the registry row is deleted on exit, so persist it (plus the
// exit context) to trades.json — the origin-pure calibration dataset calibrate.cjs
// reads. Every CLI trade is signal-driven by construction, so per-class bracket
// tuning from this file satisfies the calibration-contamination rule by design.
function journalTrade(p, exitTrigger, pnlPctAtExit, walletSolAfter) {
  try {
    const f = DIR + '/trades.json';
    const tj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
    tj.push({ ...p, exitTrigger, pnlPctAtExit, walletSolAfter, closedAt: new Date().toISOString() });
    fs.writeFileSync(f, JSON.stringify(tj.slice(-500), null, 1));
  } catch (e) { log('journal err: ' + e.message); }
}

async function manage(){
  const s = st(); const held = [];
  let pendingPool = null;
  // Resume a durable hybrid deployment before querying positions. A confirmed
  // CREATE may not be visible in the indexer yet, and treating that lag as an
  // external close would sweep/drop a position between its two funding legs.
  if (fs.existsSync(BID_ASK_PENDING)) {
    try { pendingPool = JSON.parse(fs.readFileSync(BID_ASK_PENDING, 'utf8')).pool || null; } catch(e){}
    try {
      const out = execFileSync(NODE, [DIR+'/deploy.cjs', '--resume'], { cwd: DIR, timeout: 480e3 }).toString();
      ev(`BID ASK deployment resumed: ${out.match(/DEPLOYED: (\S+)/)?.[1] || 'complete'}`);
      held.push('BID ASK resumed');
    } catch(e) {
      const msg = String((e.stderr||'') + ' | ' + (e.stdout||'') + ' | ' + (e.message||'')).replace(/\s+/g,' ').slice(0,300);
      const last = s.alerted?.bidAskResume || 0;
      if (Date.now() - last > 30*60e3) {
        ev(`BID ASK RESUME BLOCKED: ${msg} — journal retained; fix the stated condition and it will retry`);
        s.alerted = s.alerted || {}; s.alerted.bidAskResume = Date.now(); saveSt(s);
      } else log(`BID ASK resume still blocked: ${msg}`);
      held.push('BID ASK PENDING');
    }
  }
  const positions = reg(); if(!positions.length) return held;
  let boundProfiles = false;
  for (const p of positions) {
    const resolved = GATES.resolvePositionProfile(p, p.profile);
    if (p.profile !== resolved) { p.profile = resolved; boundProfiles = true; }
  }
  if (boundProfiles) fs.writeFileSync(DIR+'/positions.json', JSON.stringify(positions, null, 1));
  for (const p of positions) {
    try {
      if (pendingPool && p.pool === pendingPool) {
        held.push(`${p.name} DEPLOYING`);
        continue;
      }
      if (GATES.needsDeploymentResume(p)) {
        const key = `orphan:${p.position}`;
        const last = s.alerted?.[key] || 0;
        if (Date.now() - last > 30*60e3) {
          ev(`BID ASK RECOVERY REQUIRED ${p.name}: partial registry row ${p.position} has no .pending-bid-ask.json journal; leaving it untouched`);
          s.alerted = s.alerted || {}; s.alerted[key] = Date.now();
        }
        held.push(`${p.name} PARTIAL`);
        continue;
      }
      const pnl = await jget(`${MET}/positions/${p.pool}/pnl?user=${WALLET}&status=open`);
      if (!pnl.totalCount) {
        // CLEANUP SWEEP (audit 2026-08-08): reaching here with a registry row means a
        // manual UI close OR an exit that crashed after the on-chain close but before
        // its sweep. The old code dropped the row with a null journal and left any
        // unswept tokens sitting in the wallet silently. exit.cjs is idempotent - its
        // close loop no-ops on an already-closed position, its sweep clears residue -
        // so run it before dropping the row, and journal the real wallet balance.
        let fin = null;
        try {
          const out = execFileSync(NODE, [DIR+'/exit.cjs','--pool',p.pool], { cwd: DIR, timeout: 480e3 }).toString();
          fin = out.match(/FINAL wallet SOL: ([\d.]+)/)?.[1];
          if (/SWEEP FAILED/.test(out)) ev(`SWEEP FAILED in external-close cleanup ${p.name} — recover manually (see daemon.log)`);
        } catch(e){ log(`external-close cleanup err ${p.name}: ${String(e.message).slice(0,150)}`); }
        ev(`EXTERNAL CLOSE detected ${p.name} — swept residue, removing from registry${fin?` | wallet ${fin} SOL`:''}`);
        if (s.oorTicks) delete s.oorTicks[p.pool];
        if (s.lastFeeRates) delete s.lastFeeRates[p.pool];   // fresh persistence per position (see exit path)
        if (s.positionSignals) delete s.positionSignals[p.position || p.pool];
        journalTrade(p, 'EXTERNAL', null, fin ? +fin : null);
        fs.writeFileSync(DIR+'/positions.json', JSON.stringify(reg().filter(r=>r.pool!==p.pool),null,1));
        continue;
      }
      const pos = pnl.positions[0];
      const pnlPct = +pos.pnlSolPctChange, price = +pos.poolActivePrice;
      // OOR tracking: out of range = zero fee income = the vol-selling thesis is dead.
      // 2 consecutive manage ticks (~4 min) filters single-wick noise (same persistence
      // pattern as FEE-DECAY and the squeeze anti-flap).
      // OOR from OUR OWN registry bin range, not the indexer's flag.
      // Proven live (CATE, position DXFXNbWC): the create tx ran InitializePosition
      // (base 70 bins) + IncreasePositionLength(69, Upper) - both succeeded, so the
      // on-chain band was the full 139 bins - but the datapi rollup reports only the
      // BASE width (-679..-610), so price sitting in the healthy UPPER HALF of the
      // real band was flagged isOutOfRange and the daemon exited a fine position.
      // poolActiveBinId is pool state (reliable); minBinId/maxBinId are what we
      // actually ordered and verified. Fall back to the flag for pre-fix rows.
      const activeBin = Number(pos.poolActiveBinId);
      const haveBins = Number.isFinite(activeBin) && Number.isFinite(p.minBinId) && Number.isFinite(p.maxBinId);
      const oor = haveBins ? (activeBin < p.minBinId || activeBin > p.maxBinId) : pos.isOutOfRange === true;
      const oorDir = !oor ? null
        : haveBins ? (activeBin > p.maxBinId ? 'UP' : 'DOWN')
        : (price > +pos.maxPrice ? 'UP' : 'DOWN');
      s.oorTicks = s.oorTicks || {};
      s.oorTicks[p.pool] = oor ? (s.oorTicks[p.pool] || 0) + 1 : 0;
      const pool = await jget(`${MET}/pools/${p.pool}`);
      const numberOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
      const feeRatio1h = numberOrNull(pool.fee_tvl_ratio?.["1h"]);
      const feeRate = feeRatio1h == null ? null : feeRatio1h * 24;
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.mint}`, true);
      const t = Array.isArray(tk) ? tk.find(x => (x.id || x.address || x.mint) === p.mint) : null;
      const buy1 = numberOrNull(t?.stats1h?.buyOrganicVolume);
      const sell1 = numberOrNull(t?.stats1h?.sellOrganicVolume);
      const ofi = buy1 == null || sell1 == null ? null : sell1 / Math.max(buy1, 1);
      const pc1 = numberOrNull(t?.stats1h?.priceChange);
      const signalTs = Date.now();
      const signalSnapshot = { ok: feeRate != null && ofi != null && pc1 != null, ts: signalTs, feeRate, ofi, pc1 };
      const signalsReady = GATES.signalsReady(signalSnapshot);
      // FEE-DECAY spike-bias guard: the scanner ranks by 1h fee rate, so entries are
      // systematically at fee SPIKES - '50% of entry' reads normal mean-reversion as
      // death (5/5 live exits were FEE-DECAY inside 40min, incl. CATE 'dying' at a
      // healthy 7.3%%/d). Decay now also requires the rate to be below the pool's
      // NORMAL level (24h rate at entry): below-entry AND below-normal = actually dying.
      const normFee = (CFG.FEE_DECAY_VS_NORM && p.entryFeeRate24h > 0) ? p.entryFeeRate24h : 1e9;
      let trigger = null;
      const accum = p.profile === 'ACCUM' || p.profile === 'ACCUM_INFERRED';
      s.positionSignals = s.positionSignals || {};
      const posSignalKey = p.position || p.pool;
      if (accum) {
        const feeState = GATES.updateFeeDecay(s.positionSignals[posSignalKey], p, signalSnapshot);
        s.positionSignals[posSignalKey] = feeState;
        const decay = feeState.belowCount >= 2;
        const flow = signalsReady && ofi > CFG.FLOW_OFI && pc1 < CFG.FLOW_PC1;
        const accumState = GATES.evaluateAccumLifecycle({ dataReady: signalsReady, decay, flow });
        if (accumState === 'EXIT') {
          trigger = `BID ASK EXIT (fee decay x${feeState.belowCount} AND distribution OFI ${ofi.toFixed(1)}, 1h ${pc1.toFixed(1)}%)`;
        } else {
          const detail = !signalsReady ? 'DATA_WAIT (current fee/organic-flow data unavailable)'
            : accumState === 'WAIT' ? `WAIT (${decay ? 'fee decay' : 'distribution'}; exit needs both)`
              : 'ACCUMULATING';
          log(`hold ${p.name} BID_ASK=${detail} pnl=${pnlPct.toFixed(2)}% fee=${feeRate == null ? '?' : feeRate.toFixed(1)} ofi=${ofi == null ? '?' : ofi.toFixed(2)}`);
          held.push(`${p.name} ${detail}`);
          continue;
        }
      } else if (pnlPct >= p.tpPct) trigger = `TP (${pnlPct.toFixed(1)}% >= ${p.tpPct})`;
      else if (p.stopPrice > 0 && price < p.stopPrice) trigger = `STOP-PRICE (${price.toExponential(2)} < ${p.stopPrice.toExponential(2)})`;
      else if (pnlPct <= p.slPct) trigger = `SL (${pnlPct.toFixed(1)}% <= ${p.slPct})`;
      // DEEP-LOSS BYPASS: the x2 persistence exists to filter transient wicks, but it
      // RESETS on any single in-range tick - so price oscillating at the band edge kept
      // it at zero while the position bled (caught live: SISYPUSS sat out-of-range at
      // -14.7%% for ~45 min, never got 2 consecutive OOR ticks, and finally exited at
      // -20.5%% on SL instead of ~-15%% on OOR). A position already deep in loss AND
      // earning nothing outside its range is not a wick. Fires on DOWN in practice:
      // OOR-UP means price pumped through the band, which books a gain.
      else if (oor && ((s.oorTicks[p.pool] || 0) >= CFG.OOR_TICKS
        || (CFG.OOR_DEEP_FRAC > 0 && p.slPct < 0 && pnlPct <= CFG.OOR_DEEP_FRAC * p.slPct)))
        trigger = `OOR-${oorDir} ${((s.oorTicks[p.pool]||0) >= CFG.OOR_TICKS)
          ? `x${s.oorTicks[p.pool]} ticks`
          : `DEEP ${pnlPct.toFixed(1)}% past ${Math.round(CFG.OOR_DEEP_FRAC*100)}% of SL ${p.slPct}% — persistence bypassed`} (no fee income OOR — ${oorDir === 'UP' ? 'booking gain, TP unreachable from outside range' : 'cutting dead exposure before it grinds to SL'})`;
      else if (signalsReady && feeRate < CFG.FEE_DECAY_FRAC*p.entryFeeRate && feeRate < normFee
        && (s.lastFeeRates[p.pool]??1e9) < CFG.FEE_DECAY_FRAC*p.entryFeeRate && (s.lastFeeRates[p.pool]??1e9) < normFee)
        trigger = `FEE-DECAY (${feeRate.toFixed(1)} < ${Math.round(CFG.FEE_DECAY_FRAC*100)}% of entry ${p.entryFeeRate.toFixed(1)}${normFee<1e9?` AND < norm ${normFee.toFixed(1)}`:''}, x2)`;
      else if (signalsReady && ofi > CFG.FLOW_OFI && pc1 < CFG.FLOW_PC1) trigger = `FLOW-FLIP (OFI ${ofi.toFixed(1)}, 1h ${pc1.toFixed(1)}%)`;
      else if (p.label === 'SQUEEZE' && p.openedAt && (Date.now() - new Date(p.openedAt).getTime()) > CFG.SQZ_TIMEOUT_H*3600e3 && Math.abs(pnlPct) < 3) trigger = `TIME-STOP (squeeze unresolved ${CFG.SQZ_TIMEOUT_H}h, pnl ${pnlPct.toFixed(1)}%)`;
      if (signalsReady) s.lastFeeRates[p.pool] = feeRate;
      if (trigger) {
        ev(`EXIT ${p.label} ${p.name}: ${trigger} | pnl ${pnlPct.toFixed(2)}%  https://www.meteora.ag/dlmm/${p.pool}`);
        try {
          const out = execFileSync(NODE, [DIR+'/exit.cjs','--pool',p.pool], { cwd: DIR, timeout: 480e3 }).toString();
          const fin = out.match(/FINAL wallet SOL: ([\d.]+)/)?.[1];
          if (/SWEEP FAILED/.test(out)) ev(`SWEEP FAILED on ${p.name} exit — tokens left in wallet, recover manually (see daemon.log)`);
          s.cooldowns[p.pool] = Date.now();
          if (p.mint) s.cooldowns[p.mint] = Date.now();   // mint-keyed too: blocks sibling-pool re-entry
          if (s.oorTicks) delete s.oorTicks[p.pool];
          // CLEAR THE FEE HISTORY TOO (caught live 2026-08-09, BUTTHOLE 48Bdejg): lastFeeRates
          // is pool-keyed and survived the position, so a re-entry's FIRST manage tick found a
          // stale reading from the PREVIOUS position sitting in the "previous tick" slot - both
          // halves of the x2 persistence satisfied at once. Deployed 17:28:39, exited 17:31:16
          // logging "x2" after exactly ONE observation. Persistence must start fresh per position.
           if (s.lastFeeRates) delete s.lastFeeRates[p.pool];
           if (s.positionSignals) delete s.positionSignals[posSignalKey];
          journalTrade(p, trigger, +pnlPct.toFixed(2), fin ? +fin : null);
          ev(`EXITED ${p.name} | wallet ${fin} SOL`);
        } catch(e){ ev(`EXIT FAILED ${p.name}: ${String((e.stderr||'') + ' | ' + (e.message||'')).replace(/\s+/g,' ').slice(0,300)} — will retry next tick`); }
      } else {
        log(`hold ${p.name} pnl=${pnlPct.toFixed(2)}% fee=${feeRate == null ? '?' : feeRate.toFixed(1)} ofi=${ofi == null ? '?' : ofi.toFixed(2)}`);
        held.push(`${p.name} ${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%/f${feeRate == null ? '?' : feeRate.toFixed(0)}`);
      }
    } catch(e){ log(`manage err ${p.name}: ${e.message}`); held.push(`${p.name} ERR`); }
  }
  saveSt(s);
  return held;
}

async function scan(){
  const s = st(); const positions = reg(); let seen = 0;
  if (fs.existsSync(BID_ASK_PENDING)) { log('scan skipped: BID ASK deployment journal pending resume'); return 'scan skipped (BID ASK pending)'; }
  if (positions.length >= CFG.MAX_POSITIONS) { log(`scan skipped: ${positions.length} positions open`); return `scan skipped (${positions.length} open)`; }
  const bd = await jget(`${MET}/pools?sort_by=volume_24h:desc&page_size=100`);
  const boardTs = Date.now();
  // token_y must be SOL: deploy.cjs swaps SOL->token_x and treats the Y side as lamports,
  // so SOL-first pools (SOL-HYPE) and USDC-quoted pools can't be deployed by this path.
  const B = (bd.data||bd).filter(p=>Number(p.tvl)>=CFG.MIN_TVL && Number(p.volume?.["24h"])>=CFG.MIN_VOL_24H
    && p.token_x?.address && p.token_x.address!==SOLM && p.token_y?.address===SOLM);
  const metric = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
  B.forEach(p=>{
    const f1=metric(p.fee_tvl_ratio?.["1h"]), base=metric(p.pool_config?.base_fee_pct);
    const v30=metric(p.volume?.["30m"]), v4=metric(p.volume?.["4h"]);
    p._fr=f1==null?null:f1*24;
    p._fr24=metric(p.fee_tvl_ratio?.["24h"]);
    p._sg=metric(p.dynamic_fee_pct)==null||base==null||base<=0?null:metric(p.dynamic_fee_pct)/base;
    p._ac=v30==null||v4==null?null:(v30*48)/Math.max(v4*6,1);
  });
  B.sort((a,b)=>(b._fr??-Infinity)-(a._fr??-Infinity));
  let best = null;
  const sigs = [];        // all qualifying signals this cycle (bin-aware selection below)
  const bidAskCandidates = []; // base-ready candidates awaiting candle qualification
  let degradedSigma = 0;  // legacy-sigma fallbacks on mature (>1h) tokens this cycle
  const cands = B.slice(0, CFG.SCAN_TOP_N);
  // Sibling pools share token metadata. Coalesce one Jupiter lookup per mint for
  // this scan; OHLCV remains pool-specific.
  const jupByMint = new Map();
  const tokenFor = async (mint) => {
    if (!jupByMint.has(mint)) jupByMint.set(mint, jget(`https://api.jup.ag/tokens/v2/search?query=${mint}`, true)
      .then(response => ({ response, ts: Date.now() })));
    const hit = await jupByMint.get(mint);
    const token = Array.isArray(hit.response) ? hit.response.find(x => (x.id || x.address || x.mint) === mint) || null : null;
    return { token, ts: hit.ts };
  };
  hb(`scanning: ${(bd.data||bd).length} pools -> ${B.length} pass tvl/vol -> checking top ${cands.length} by fee rate`);
  for (const [i, p] of cands.entries()) {
    const n = `${i+1}/${cands.length} ${(p.name||'?').padEnd(16).slice(0,16)}`;
    // MINT DEDUP (caught live 2026-08-08: two BASING positions on Jimothy via different
    // pools - same token risk doubled inside the 2-slot cap). Skip by pool OR token.
    if (positions.find(r=>r.pool===p.address || r.mint===p.token_x.address)) { sc(`${n} skip: already holding (pool or token)`); continue; }
    // cooldown is keyed by pool AND mint - exiting a token blocks re-entry via ANY of
    // its sibling pools, not just the one just exited (same incident as the dedup).
    { const cdTs = Math.max(s.cooldowns[p.address]||0, s.cooldowns[p.token_x.address]||0);
      if (cdTs && Date.now()-cdTs < CFG.COOLDOWN_H*3600e3) {
        const mins = Math.round((CFG.COOLDOWN_H*3600e3 - (Date.now()-cdTs))/60e3);
        sc(`${n} skip: cooldown ${mins}m left`); continue;
      } }
    try {
      const tokenHit = await tokenFor(p.token_x.address); const t = tokenHit.token;
      if(!t) { sc(`${n} skip: exact token metadata unavailable`); continue; }
      seen++;
      const ageH = t.createdAt ? (Date.now()-new Date(t.createdAt).getTime())/3600e3 : 999;
      const pc5=metric(t.stats5m?.priceChange), pc1=metric(t.stats1h?.priceChange), pc24=metric(t.stats24h?.priceChange);
      const buy1=metric(t.stats1h?.buyOrganicVolume), sell1=metric(t.stats1h?.sellOrganicVolume);
      const buy6=metric(t.stats6h?.buyOrganicVolume), sell6=metric(t.stats6h?.sellOrganicVolume);
      // RV sigma from 5m OHLCV (one call also yields dd/pos/low below); legacy fallback for thin data
      let dd=null,pos=null,low=null,low6h=null,rv=null,recentCandles=[];
      try { const vd = await fetchVolDay(p.address, (u)=>jget(u)); rv=vd.rv; dd=vd.dd; pos=vd.pos; low=vd.low; low6h=vd.low6h; recentCandles=vd.recentCandles||[]; } catch(e){}
      const legacyReady = pc5 != null && pc1 != null && (ageH < 24 || pc24 != null);
      const sigma = rv != null ? sigmaFrom(rv, ageH, pc5 || 0, pc1 || 0, pc24 || 0)
        : legacyReady ? sigmaFrom(null, ageH, pc5, pc1, pc24 || 0) : null;
      if (rv == null && ageH > 1) degradedSigma++;  // candles should exist for a >1h token
      // MIN_SIGMA universe gate (audit 2026-08-08): edge = fr/sigma^2, so an LST/stable-
      // grade asset prints fictional thousand-edges on pools that yield nothing (INF-SOL
      // was in the live top-100). Also: flat candles return rv=0, which BYPASSES the
      // degraded-sigma watchdog above (it checks null, not 0) - this gate closes that too.
      if (sigma == null) { sc(`${n} skip: volatility inputs incomplete`); continue; }
      if (sigma < CFG.MIN_SIGMA) { sc(`${n} skip: sigma ${sigma.toFixed(1)}<${CFG.MIN_SIGMA} - vol too low, edge unreliable`); continue; }
      const ofi = buy1 == null || sell1 == null ? null : sell1/Math.max(buy1,1);
      const ofi6 = buy6 == null || sell6 == null ? null : sell6/Math.max(buy6,1);
      const org = metric(t.organicScore);
      // delta history (foundation for squeeze detection)
      if (!s.history) s.history = {};
      { const h = s.history[p.token_x.address] || []; h.push({ ts: Date.now(), feeRate: p._fr == null ? null : +p._fr.toFixed(2), sigma: +sigma.toFixed(1), surge: p._sg == null ? null : +p._sg.toFixed(2), src: rv != null ? 'rv' : 'lg' }); s.history[p.token_x.address] = h.slice(-40); }
      let sigmaTrail = null, sigmaRatio = null, sqzPersist = false;
      // CONTAMINATION GUARD (mirror of extension fix): squeeze ratios only within
      // same-sigma-source entries. A model change (legacy -> rv) shifts the sigma
      // LEVEL and would read as a false board-wide "compression" otherwise.
      { const h = s.history[p.token_x.address] || []; const curSrc = rv != null ? 'rv' : 'lg';
        const hs = h.filter(x => x.src === curSrc);
        const prior = hs.slice(0, -1).map(x => x.sigma).filter(x => x > 0);
        const spanMin = hs.length >= 2 ? (hs[hs.length-1].ts - hs[0].ts) / 60e3 : 0;
        if (prior.length >= 6 && spanMin >= 45) {
          const srt=[...prior].sort((a,b)=>a-b); sigmaTrail = srt[Math.floor(srt.length/2)];
          const recent = hs.slice(-3).map(x=>x.sigma).sort((a,b)=>a-b);
          const sigmaNow = recent[Math.floor(recent.length/2)];   // smoothed: median of last 3
          sigmaRatio = sigmaNow / Math.max(sigmaTrail, 0.001);
          hs[hs.length-1].ratio = Math.round(sigmaRatio*100)/100;
          const prevRatio = hs.length >= 2 ? hs[hs.length-2].ratio : null;
          sqzPersist = (sigmaRatio <= 0.6 && prevRatio != null && prevRatio <= 0.6);  // 2 consecutive scans
        } }

      const path = pc5 == null || pc1 == null ? 'UNKNOWN' : GATES.classifyPath({ pc5, pc1, dd, pos });
      const audit = t.audit||{};
      const px = Number(p.current_price) || 0;
      const { rawW } = GATES.basingFloor({ px, low, low6h });
      const dataTs = Math.min(boardTs, tokenHit.ts);
      const scanData = {
        address: p.address, ok: true, ts: dataTs, supportedSolPair: true,
        feeRate1h: p._fr, feeRate24h: p._fr24, sigma, surge: p._sg, accel: p._ac,
        org, orgBuy1h: buy1, path, ageH, ofi, ofi6, tvl: Number(p.tvl), audit,
        px, low, low6h, dd, binStepBps: Number(p.pool_config?.bin_step),
      };
      const signalConfig = {
        maxBins: CFG.MAX_BINS, basingMaxFloor: CFG.BASING_MAX_FLOOR,
        sizeIgnition: CFG.SIZE_IGNITION, sizeIgnitionHi: CFG.SIZE_IGNITION_HI,
        sizeBasing: CFG.SIZE_BASING, sizeCarry: CFG.SIZE_CARRY, sizeBidAsk: CFG.SIZE_BID_ASK,
      };
      const evaluated = GATES.collectSignals({ now: Date.now(), data: scanData, config: signalConfig });
      if (evaluated.trade?.label === 'IGNITION') {
        if (CFG.TP_IGNITION) evaluated.trade.tp = CFG.TP_IGNITION;
        if (CFG.SL_IGNITION) evaluated.trade.sl = -CFG.SL_IGNITION;
      } else if (evaluated.trade?.label === 'BASING') {
        if (CFG.TP_BASING) evaluated.trade.tp = CFG.TP_BASING;
        if (CFG.SL_BASING) evaluated.trade.sl = -CFG.SL_BASING;
      } else if (evaluated.trade?.label === 'CARRY') {
        if (CFG.TP_CARRY) evaluated.trade.tp = CFG.TP_CARRY;
        if (CFG.SL_CARRY) evaluated.trade.sl = -CFG.SL_CARRY;
      }
      const poolSignals = [evaluated.trade].filter(Boolean);
      if (evaluated.bidAskStatus?.baseReady) bidAskCandidates.push({
        address: p.address, mint: p.token_x.address, p, name: p.name,
        poolCreatedAt: p.created_at, recentCandles, data: scanData,
        config: signalConfig, dataTs,
        bidAskStatus: evaluated.bidAskStatus, evaluated,
      });
      const edge = evaluated.recipeEdges.IGNITION || 0;
      const compressed = sqzPersist ? ` compression ${sigmaRatio.toFixed(2)} diagnostic-only` : '';
      const baBlocked = evaluated.bidAskStatus?.baseReady
        && evaluated.bidAskStatus.range?.executable === false
        ? `; BID ASK capacity wait ${evaluated.bidAskStatus.range?.totalBins || '?'}>${CFG.MAX_BINS} bins` : '';
      const show = (v, digits=2) => v == null ? '?' : v.toFixed(digits);
      const tradeBlock = [p._sg,p._ac,org,ofi].some(v=>v==null) || path === 'UNKNOWN'
        ? 'trade inputs incomplete' : blocker(edge,p._sg,p._ac,org,path,ageH,ofi);
      const bidAskLabel = evaluated.bidAskStatus?.baseReady ? ' +BID_WATCH' : '';
      sc(`${n}${compressed} edge@recipe ${edge.toFixed(2).padStart(5)} surge ${show(p._sg)} accel ${show(p._ac)} ofi ${show(ofi)}/${show(ofi6)} org ${org == null ? '?' : String(Math.round(org)).padStart(3)} ${path.padEnd(9)} ${poolSignals.length ? '=> '+poolSignals.map(x=>x.label).join('+') : '-- '+tradeBlock}${bidAskLabel}${baBlocked}  https://www.meteora.ag/dlmm/${p.address}`);
      // SHADOW LOG: persist every evaluation (signal or not) for counterfactual replay.
      // Zero extra API calls - this is data already in hand. Review with: node replay.cjs
      try {
        fs.appendFileSync(DIR + '/shadow.jsonl', JSON.stringify({ t: Date.now(), pool: p.address, name: p.name,
          tvl: Math.round(p.tvl || 0), fr: p._fr == null ? null : +p._fr.toFixed(2), sg: p._sg == null ? null : +p._sg.toFixed(2), ac: p._ac == null ? null : +p._ac.toFixed(2),
          sigma: +sigma.toFixed(1), src: rv != null ? 'rv' : 'lg',
          edge: +(evaluated.trade ? evaluated.trade.edge : edge).toFixed(3),
          edgeModel: 'pool-width heuristic', recipeEdges: evaluated.recipeEdges,
          ofi: ofi == null ? null : +ofi.toFixed(2), ofi6: ofi6 == null ? null : +ofi6.toFixed(2), org: org == null ? null : Math.round(org), path, ageH: +ageH.toFixed(1),
          dd: dd != null ? Math.round(dd) : null, sig: evaluated.trade ? evaluated.trade.label : null, w: evaluated.trade ? evaluated.trade.widthPct : null,
          bidAsk: evaluated.bidAskStatus?.baseReady
            ? (evaluated.bidAskStatus.ready
              ? (evaluated.bidAsk ? 'READY' : 'CAPACITY_WAIT')
              : 'WATCH')
            : null,
          bidAskDepth: evaluated.bidAskStatus?.depthPct ?? null, profile: evaluated.trade ? 'TRADE' : null,
          candle: candleDiagnostics.get(p.address),
          // widened 2026-08-08: every gate INPUT now persists, so rule variants can be
          // tested offline. Before this, squeeze ratios lived only in daemon_state's
          // rolling 40-entry window — the best-performing class had the least data —
          // and rawW/pos/pc5/pc1 weren't logged at all (tight-base and path boundaries
          // were untestable in replay).
          pc5: pc5 == null ? null : +pc5.toFixed(1), pc1: pc1 == null ? null : +pc1.toFixed(1), pos: pos != null ? +pos.toFixed(2) : null,
          px, rawW: +rawW.toFixed(1), sqzR: sigmaRatio != null ? +sigmaRatio.toFixed(2) : null,
          sqzP: sqzPersist ? 1 : 0, binStep: p.pool_config?.bin_step ?? null }) + '\n');
      } catch (e) {}
      for (const found of poolSignals) sigs.push({ p, sig: found, dataTs });
      await new Promise(r=>setTimeout(r,130));
      } catch(e){ log(`scan err ${p.name}: ${e.message}`); }
  }
  // Re-evaluate every cached full analysis first. A deferred refresh from the
  // prior scan can already be current for this completed 5m bucket; using it
  // prevents the fee-ordered prefix from monopolising the two synchronous
  // history slots. The qualifier is recomputed at this scan's wall clock.
  const cachedQualifiedMints = new Set();
  for (const candidate of bidAskCandidates) {
    const compact = candleDiagnostics.get(candidate.address);
    candidate.candleCollectedAt = Number(compact?.collectedAt || 0);
    const cachedAnalysis = candleDiagnostics.getAnalysis(candidate.address);
    if (!cachedAnalysis) continue;
    candidate.candleAnalysis = cachedAnalysis;
    const cachedEvaluated = GATES.collectSignals({ now: Date.now(),
      data: { ...candidate.data, candleAnalysis: cachedAnalysis }, config: candidate.config });
    candidate.evaluated = cachedEvaluated;
    candidate.bidAskStatus = cachedEvaluated.bidAskStatus;
    if (cachedEvaluated.bidAsk) {
      cachedQualifiedMints.add(candidate.mint);
      sigs.push({ p: candidate.p, mint: candidate.mint, sig: cachedEvaluated.bidAsk,
        bidAskStatus: cachedEvaluated.bidAskStatus, candleAnalysis: cachedAnalysis,
        dataTs: candidate.dataTs });
    }
  }
  // TRADE gets first refusal. Only when no fresh trade is available do we spend
  // the caller's latency budget on at most two full BID ASK history refreshes.
  const nowBeforeBidAsk = Date.now();
  const freshTradeEntries = sigs.filter((entry) => entry.sig && entry.sig.label !== 'BID_ASK'
    && Number.isFinite(entry.dataTs) && nowBeforeBidAsk >= entry.dataTs
    && nowBeforeBidAsk - entry.dataTs <= GATES.BID_ASK_FRESH_MS);
  if (!GATES.selectExecutionSignal(freshTradeEntries) && bidAskCandidates.length) {
    const historyCandidates = bidAskCandidates.filter((candidate) => !cachedQualifiedMints.has(candidate.mint));
    const refreshed = await refreshBidAskCandidates(historyCandidates, {
      diagnostics: candleDiagnostics,
      collectSignals: GATES.collectSignals,
      max: 2,
      nowMs: () => Date.now(),
    });
    for (const candidate of refreshed.refreshed) {
      const evaluated = candidate.evaluated;
      if (!evaluated || !evaluated.bidAsk) continue;
      sigs.push({ p: candidate.p, mint: candidate.mint, sig: evaluated.bidAsk,
        bidAskStatus: evaluated.bidAskStatus, candleAnalysis: candidate.candleAnalysis,
        dataTs: candidate.dataTs });
    }
    for (const candidate of refreshed.deferred) {
      sc(`BID ASK WATCH ${candidate.name || candidate.p?.name || candidate.address}: candle refresh deferred`);
    }
  }
  // BIN-AWARE SELECTION: the same token often lists 3 pools (20/25/50/100bps) and
  // the finest bin step usually ranks first by fee rate - but it may not be able to
  // express the width the data asked for (a +-35 CARRY needs 350 bins at 20bps vs 35
  // at 100bps). Prefer the pool that can hold the wanted width; candidates arrive in
  // fee-rate order and Array#sort is stable, so fee rate remains the tiebreak.
  for (let i = sigs.length - 1; i >= 0; i--) {
    if (Date.now() - sigs[i].dataTs > GATES.BID_ASK_FRESH_MS) {
      sc(`stale signal skipped before execution: ${sigs[i].sig.label} ${sigs[i].p.name}`);
      sigs.splice(i, 1);
    }
  }
  // Surface every actionable BID ASK independently even when an existing trade
  // class wins the one-deploy-per-scan selector.
  s.alerted = s.alerted || {};
  // Re-run the complete gate at alert time. A cached READY analysis can cross
  // the five-minute bucket boundary while the board/Jupiter fetches are in
  // flight, and a status flag from the earlier scan must never keep it
  // actionable. The helper also applies exact-mint deduplication and capacity
  // checks for sibling pools.
  const actionableBidAsks = GATES.selectBidAskCandidates(sigs, { nowMs: Date.now() });
  for (const x of actionableBidAsks) {
    const alertMint = x.mint ?? x.p?.token_x?.address ?? x.p?.mint ?? x.p?.address;
    const key = `BID_ASK:${String(alertMint)}`;
    if (Date.now() - (s.alerted[key] || 0) >= 2*3600e3) {
      ev(`BID ASK READY ${x.p.name}: ${x.sig.size} SOL total, ${x.sig.bidAskPct}/${x.sig.spotPct} Bid-Ask+Spot, 0%..-${x.sig.depthPct}% (${x.sig.range.totalBins} bins)  https://www.meteora.ag/dlmm/${x.p.address}`);
      s.alerted[key] = Date.now();
    }
  }
  if (sigs.length) {
    const head = sigs.find(x => x.sig.label !== 'BID_ASK') || sigs[0];
    best = GATES.selectExecutionSignal(sigs);
    if (best && best.p.address !== head.p.address) {
      sc(`bin-aware: preferring ${best.p.name} ${best.p.pool_config?.bin_step}bps (holds ±${best.sig.widthPct}% of ±${best.sig.wantedPct}% wanted) over ${head.p.name} ${head.p.pool_config?.bin_step}bps (only ±${head.sig.widthPct}%)`);
    }
  }

  // DATA-HEALTH GUARD (mirror of quant-lens v0.6.0 watchdog): if sigma fell back
  // to the legacy estimator on 2+ mature tokens this cycle, candle data is broken
  // and every edge/gate above was computed on a bad instrument. Warn AND refuse
  // to deploy this cycle - do not trade on silently-degraded vol data.
  if (degradedSigma >= 2) {
    ev(`DEGRADED SIGMA: legacy fallback on ${degradedSigma} mature tokens this cycle (OHLCV data missing) - deploy suppressed`);
    best = null;
  }
  // A BID ASK signal can become stale during the final scan work. Revalidate
  // the full candle qualification immediately before invoking deploy.cjs.
  if (best?.sig?.label === 'BID_ASK') {
    const freshBidAsk = GATES.selectBidAskCandidates([best], { nowMs: Date.now() });
    if (!freshBidAsk.length) {
      sc(`BID ASK skipped before deploy: candle evidence or market snapshot is stale for ${best.p.name}`);
      best = null;
    } else {
      best = freshBidAsk[0];
    }
  }
  if (best) {
    const { p, sig } = best;
    const rangeText = sig.label === 'BID_ASK' ? `0%..-${sig.depthPct}% ${sig.bidAskPct}/${sig.spotPct} Bid-Ask+Spot` : `width ${sig.widthPct.toFixed(1)}% downside tp ${sig.tp} sl ${sig.sl}`;
    ev(`DEPLOY ${sig.label} ${p.name} size ${sig.size} ${rangeText}  https://www.meteora.ag/dlmm/${p.address}`);
    try {
      const args = sig.label === 'BID_ASK'
        ? [DIR+'/deploy.cjs','--pool',p.address,'--size',String(sig.size),'--mode','single',
          '--depthPct',String(sig.depthPct),'--bidAskPct',String(sig.bidAskPct),'--label','BID_ASK','--profile','ACCUM','--shape','hybrid']
        : [DIR+'/deploy.cjs','--pool',p.address,'--size',String(sig.size),'--mode',sig.mode,
          '--widthPct',String(sig.widthPct),'--widthBins',String(sig.widthBins),'--tp',String(sig.tp),'--sl',String(sig.sl),
          '--stopPrice',String(sig.stop),'--label',sig.label,'--profile','TRADE','--shape',(sig.shape||'spot')];
      const out = execFileSync(NODE, args, { cwd: DIR, timeout: 480e3 }).toString();
      ev(`DEPLOYED ${sig.label} ${p.name}: ${out.match(/DEPLOYED: (\S+)/)?.[1]||'ok'}`);
    } catch(e){ ev(`DEPLOY FAILED ${p.name}: ${String((e.stderr||'') + ' | ' + (e.stdout||'')).replace(/\s+/g,' ').slice(0,300) || String(e.message).slice(0,150)}`); }
  }
  saveSt(s);
  // Remaining candidates are deliberately deferred: entry/exit timing stays
  // independent of public OHLCV backfill, and collectedAt rotates the two-pool
  // batch so a high-fee sibling cannot starve the rest of the board.
  const deferredCandleCandidates = bidAskCandidates.map((candidate) => ({
    address: candidate.address, name: candidate.name,
    poolCreatedAt: candidate.poolCreatedAt, recentCandles: candidate.recentCandles,
  }));
  void candleDiagnostics.schedule(deferredCandleCandidates).then(rows => {
    for (const row of rows) {
      const c = row.evidence;
      if (c.state !== 'READY' && c.state !== 'LIMITED') {
        log(`candle evidence ${row.name}: ${c.state} (${c.reason || 'history unavailable'})`);
        continue;
      }
      const outcomes = c.matured ? `${c.recovered}/${c.matured} recovered` : 'no matured outcomes';
      log(`candle evidence ${row.name}: ${c.state} ${c.hours}h | dips ${c.total}, ${outcomes}, ${c.timedOut} timed out, ${c.pending} pending | median depth ${c.medianDepthPct ?? 'n/a'}% recovery ${c.medianRecoveryMinutes ?? 'n/a'}m | drawdown ${c.currentDrawdownPct}% total-volume ${c.recentVolumeRatio ?? 'n/a'}x | completed through ${c.latestCompletedTs}`);
    }
  }).catch(error => { try { log(`candle diagnostic log err: ${error?.message || error}`); } catch (e) {} });
  return best ? `scanned ${seen} -> ${best.sig.label} ${best.p.name}` : `scanned ${seen}, no signal`;
}

(function cleanStaleLock(){
  const L = DIR + '/.deploy.lock';
  try { if (fs.existsSync(L) && Date.now()-fs.statSync(L).mtimeMs > 10*60e3) fs.rmSync(L,{recursive:true,force:true}); } catch(e){}
})();
(async function guard(){
  if (fs.existsSync(DIR+'/STOP')) { console.log('STOP file present - rm STOP to start again'); process.exit(0); }
  if (fs.existsSync(HEARTBEAT) && Date.now() - fs.statSync(HEARTBEAT).mtimeMs < 3*60e3) { console.log('another live daemon holds heartbeat - exiting'); process.exit(0); }
  const hbTimer = setInterval(() => { try { fs.writeFileSync(HEARTBEAT, String(process.pid)); } catch(e){} }, 60e3);
  hbTimer.unref();
  try { fs.writeFileSync(HEARTBEAT, String(process.pid)); } catch(e){}
})();

(async function loop(){
  log('daemon started pid '+process.pid);
  ev('Trader daemon ONLINE (launchd, lock-immune)');
  while (true) {
    if (fs.existsSync(DIR+'/STOP')) { ev('STOP file - daemon shutting down'); process.exit(0); }
    if (stopping) break;
    let held = [], scanned = null;
    try { held = await manage(); } catch(e){ log('manage fatal '+e.message); held = ['manage ERR']; }
    if (stopping) break;
    if (tick % SCAN_EVERY === 0) { try { scanned = await scan(); } catch(e){ log('scan fatal '+e.message); scanned = 'scan ERR'; } }
    hb([`t${tick}`, held.length ? held.join(' | ') : 'no positions', scanned].filter(Boolean).join(' | '));
    tick++;
    if (stopping) break;
    await sleep(TICK_MS);
  }
  const open = reg();
  ev(`daemon STOPPED cleanly${open.length ? ` — ${open.length} position(s) still open and now UNMANAGED: ${open.map(p=>p.name).join(', ')}` : ''}`);
  process.exit(0);
})();
