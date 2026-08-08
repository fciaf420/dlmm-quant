// DLMM Quant Trader Daemon — mechanical loop, runs under launchd, immune to screen lock.
// Manage every TICK_MS; scan+deploy every SCAN_MS. Events -> events.log (+ macOS notification).
const fs = require('fs'); const { execFileSync } = require('child_process');
const DIR = __dirname;
const { RPC_URL, JUP_KEY: JK, keypair, CFG } = require("./config.cjs");
const { fetchVolDay, sigmaFrom } = require("./vol.cjs");
const GATES = require("./gates.cjs");   // shared with screen.cjs — edit gates THERE, not inline
const SOLM = CFG.QUOTE_MINT;
const WALLET = keypair().publicKey.toBase58();
const MET = "https://dlmm.datapi.meteora.ag";
const TICK_MS = CFG.TICK_MS, SCAN_EVERY = CFG.SCAN_EVERY;
const NODE = process.execPath;
const HEARTBEAT = DIR + '/daemon.heartbeat';
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
  const positions = reg(); if(!positions.length) return [];
  const s = st(); const held = [];
  for (const p of positions) {
    try {
      const pnl = await jget(`${MET}/positions/${p.pool}/pnl?user=${WALLET}&status=open`);
      if (!pnl.totalCount) {
        ev(`EXTERNAL CLOSE detected ${p.name} — removing from registry`);
        if (s.oorTicks) delete s.oorTicks[p.pool];
        journalTrade(p, 'EXTERNAL', null, null);
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
      const feeRate = (pool.fee_tvl_ratio?.["1h"]||0)*24;
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.mint}`, true);
      const t = Array.isArray(tk)?tk[0]:null;
      const ofi = t ? (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1) : 0;
      const pc1 = t?.stats1h?.priceChange||0;
      // FEE-DECAY spike-bias guard: the scanner ranks by 1h fee rate, so entries are
      // systematically at fee SPIKES - '50% of entry' reads normal mean-reversion as
      // death (5/5 live exits were FEE-DECAY inside 40min, incl. CATE 'dying' at a
      // healthy 7.3%%/d). Decay now also requires the rate to be below the pool's
      // NORMAL level (24h rate at entry): below-entry AND below-normal = actually dying.
      const normFee = (CFG.FEE_DECAY_VS_NORM && p.entryFeeRate24h > 0) ? p.entryFeeRate24h : 1e9;
      let trigger = null;
      if (pnlPct >= p.tpPct) trigger = `TP (${pnlPct.toFixed(1)}% >= ${p.tpPct})`;
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
      else if (feeRate < CFG.FEE_DECAY_FRAC*p.entryFeeRate && feeRate < normFee
        && (s.lastFeeRates[p.pool]??1e9) < CFG.FEE_DECAY_FRAC*p.entryFeeRate && (s.lastFeeRates[p.pool]??1e9) < normFee)
        trigger = `FEE-DECAY (${feeRate.toFixed(1)} < ${Math.round(CFG.FEE_DECAY_FRAC*100)}% of entry ${p.entryFeeRate.toFixed(1)}${normFee<1e9?` AND < norm ${normFee.toFixed(1)}`:''}, x2)`;
      else if (ofi > CFG.FLOW_OFI && pc1 < CFG.FLOW_PC1) trigger = `FLOW-FLIP (OFI ${ofi.toFixed(1)}, 1h ${pc1.toFixed(1)}%)`;
      else if (p.label === 'SQUEEZE' && p.openedAt && (Date.now() - new Date(p.openedAt).getTime()) > CFG.SQZ_TIMEOUT_H*3600e3 && Math.abs(pnlPct) < 3) trigger = `TIME-STOP (squeeze unresolved ${CFG.SQZ_TIMEOUT_H}h, pnl ${pnlPct.toFixed(1)}%)`;
      s.lastFeeRates[p.pool] = feeRate;
      if (trigger) {
        ev(`EXIT ${p.label} ${p.name}: ${trigger} | pnl ${pnlPct.toFixed(2)}%  https://www.meteora.ag/dlmm/${p.pool}`);
        try {
          const out = execFileSync(NODE, [DIR+'/exit.cjs','--pool',p.pool], { cwd: DIR, timeout: 480e3 }).toString();
          const fin = out.match(/FINAL wallet SOL: ([\d.]+)/)?.[1];
          s.cooldowns[p.pool] = Date.now();
          if (s.oorTicks) delete s.oorTicks[p.pool];
          journalTrade(p, trigger, +pnlPct.toFixed(2), fin ? +fin : null);
          ev(`EXITED ${p.name} | wallet ${fin} SOL`);
        } catch(e){ ev(`EXIT FAILED ${p.name}: ${String((e.stderr||'') + ' | ' + (e.message||'')).replace(/\s+/g,' ').slice(0,300)} — will retry next tick`); }
      } else {
        log(`hold ${p.name} pnl=${pnlPct.toFixed(2)}% fee=${feeRate.toFixed(1)} ofi=${ofi.toFixed(2)}`);
        held.push(`${p.name} ${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%/f${feeRate.toFixed(0)}`);
      }
    } catch(e){ log(`manage err ${p.name}: ${e.message}`); held.push(`${p.name} ERR`); }
  }
  saveSt(s);
  return held;
}

async function scan(){
  const s = st(); const positions = reg(); let seen = 0;
  if (positions.length >= CFG.MAX_POSITIONS) { log(`scan skipped: ${positions.length} positions open`); return `scan skipped (${positions.length} open)`; }
  const bd = await jget(`${MET}/pools?sort_by=volume_24h:desc&page_size=100`);
  // token_y must be SOL: deploy.cjs swaps SOL->token_x and treats the Y side as lamports,
  // so SOL-first pools (SOL-HYPE) and USDC-quoted pools can't be deployed by this path.
  const B = (bd.data||bd).filter(p=>(p.tvl||0)>=CFG.MIN_TVL && (p.volume?.["24h"]||0)>=CFG.MIN_VOL_24H && p.token_y?.address===SOLM);
  B.forEach(p=>{ p._fr=(p.fee_tvl_ratio?.["1h"]||0)*24; p._sg=(p.dynamic_fee_pct||0)/(p.pool_config?.base_fee_pct||1); p._ac=(p.volume?.["30m"]*48)/Math.max(p.volume?.["4h"]*6,1); });
  B.sort((a,b)=>b._fr-a._fr);
  let best = null;
  const sigs = [];        // all qualifying signals this cycle (bin-aware selection below)
  let degradedSigma = 0;  // legacy-sigma fallbacks on mature (>1h) tokens this cycle
  const cands = B.slice(0, CFG.SCAN_TOP_N);
  hb(`scanning: ${(bd.data||bd).length} pools -> ${B.length} pass tvl/vol -> checking top ${cands.length} by fee rate`);
  for (const [i, p] of cands.entries()) {
    const n = `${i+1}/${cands.length} ${(p.name||'?').padEnd(16).slice(0,16)}`;
    if (positions.find(r=>r.pool===p.address)) { sc(`${n} skip: already holding`); continue; }
    if (s.cooldowns[p.address] && Date.now()-s.cooldowns[p.address] < CFG.COOLDOWN_H*3600e3) {
      const mins = Math.round((CFG.COOLDOWN_H*3600e3 - (Date.now()-s.cooldowns[p.address]))/60e3);
      sc(`${n} skip: cooldown ${mins}m left`); continue;
    }
    try {
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.token_x.address}`, true);
      const t = Array.isArray(tk)?tk[0]:null; if(!t) continue;
      seen++;
      const ageH = t.createdAt ? (Date.now()-new Date(t.createdAt).getTime())/3600e3 : 999;
      const pc5=t.stats5m?.priceChange||0, pc1=t.stats1h?.priceChange||0, pc24=t.stats24h?.priceChange||0;
      // RV sigma from 5m OHLCV (one call also yields dd/pos/low below); legacy fallback for thin data
      let dd=null,pos=null,low=null,low6h=null,rv=null;
      try { const vd = await fetchVolDay(p.address, (u)=>jget(u)); rv=vd.rv; dd=vd.dd; pos=vd.pos; low=vd.low; low6h=vd.low6h; } catch(e){}
      const sigma = sigmaFrom(rv, ageH, pc5, pc1, pc24);
      if (rv == null && ageH > 1) degradedSigma++;  // candles should exist for a >1h token
      const edge = GATES.edgeFrom(p._fr, sigma);
      const ofi = (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1);
      const ofi6 = (t.stats6h?.sellOrganicVolume||0)/Math.max(t.stats6h?.buyOrganicVolume||0,1);
      const org = t.organicScore||0;
      // delta history (foundation for squeeze detection)
      if (!s.history) s.history = {};
      { const h = s.history[p.token_x.address] || []; h.push({ ts: Date.now(), feeRate: +p._fr.toFixed(2), sigma: +sigma.toFixed(1), surge: +p._sg.toFixed(2), src: rv != null ? 'rv' : 'lg' }); s.history[p.token_x.address] = h.slice(-40); }
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

      const path = GATES.classifyPath({ pc5, pc1, dd, pos });
      const audit = t.audit||{};
      let sig = null;
      let extraBlock = null;   // class-specific rejection reason for the scan log
      // BIN-BUDGET CAP at signal time: deploy clamps width to the 140-bin budget
      // (fine bin steps need ~5x the bins per %%), but brackets were computed from
      // the REQUESTED width - stamping TP/SL for a band that never deploys. Clamp
      // here so brackets derive from the width that actually ships.
      const binPct = (p.pool_config && p.pool_config.bin_step ? p.pool_config.bin_step : 0) / 100;
      const wCap = binPct > 0 ? Math.floor((CFG.MAX_BINS - 1) / 2) * binPct : 999;
      // floor distance computed for EVERY candidate (not just BASING) so the shadow
      // log can replay tight-base counterfactuals offline; pure function, BASING
      // branch consumes the same values below.
      const px = Number(p.current_price) || 0;
      const { rawW } = GATES.basingFloor({ px, low, low6h });
      if (GATES.ignition({ edge, sg:p._sg, ac:p._ac, org, path, ageH, ofi })) {
        const wantP = Math.min(30,Math.max(12,Math.round(sigma/4)));
        const Wp = Math.min(wCap, wantP);
        // TP = capped appreciation (W/4) + ~half-day fee take; SL = just inside structural band-break (~-0.75W).
        sig = { label:'IGNITION', mode: ofi>2?'single':'two', widthPct: Wp, size: edge>=2?CFG.SIZE_IGNITION_HI:CFG.SIZE_IGNITION,
          // TP is CAP-AWARE: a two-sided band's max price-driven PnL is exactly W/4
          // (above the band you are 100% SOL); everything beyond is fees. Old min
          // clamp of 8 made low-fee TPs fictional — OOR-UP was doing the real booking.
          tp: CFG.TP_IGNITION || Math.min(25,Math.max(4,Math.round(Wp/4 + p._fr*0.5))), sl: CFG.SL_IGNITION ? -CFG.SL_IGNITION : -Math.min(20,Math.max(8,Math.round(0.75*Wp+2))), stop: 0, wantedPct: wantP };
      }
      else if (GATES.basing({ path, ofi, org, fr:p._fr, edge })) {
        // BASE-ANCHORED BAND: the class thesis is "price is chopping on a floor" - so the
        // band's BOTTOM is placed AT that floor (recent consolidation low). Then leaving
        // the band downward IS the base breaking: OOR-DOWN and the structural stop finally
        // mean the same thing instead of contradicting each other.
        //
        // Before: fixed +-18%% band with a stop at the DAY low. On a crash-then-rally chart
        // the day low sat multiples below the base (SISYPUSS: entry 7.26e-6, stop 1.60e-6 =
        // -78%%), so the structural stop could never fire - the PnL SL and OOR-DOWN, ~2
        // points of price apart, did all the work. Three loss rules, two duplicated, one
        // dead, none expressing the actual thesis.
        // px / rawW computed above (hoisted for the shadow log)
        // TIGHT-BASE GATE: a "base" is a level price is chopping ON. If the nearest
        // consolidation floor is a third of the way down, there is no base to straddle -
        // the token simply hasn't found one yet. Those are the setups that produced the
        // -9.95%% and -20.5%% losses (band clamped to its max, structure meaningless).
        if (rawW > CFG.BASING_MAX_FLOOR) {
          extraBlock = `no tight base (floor ${rawW.toFixed(0)}%% away > ${CFG.BASING_MAX_FLOOR}%%)`;
        } else {
        const Wb = Math.min(wCap, Math.min(30, Math.max(8, Math.round(rawW))));
        // stop just under the band bottom = base break confirmed (fast path; OOR-DOWN
        // starts counting the moment price leaves the band)
        const stopPx = px > 0 ? px * (1 - Wb/100) * 0.98 : 0;
        // PnL SL becomes a genuine BACKSTOP below the band-break loss (~0.75W), not the
        // primary risk rule - a mean-reversion straddle is structurally long the dip, so
        // a tight PnL stop fights its own thesis.
        sig = { label:'BASING', mode:'two', widthPct:Wb, size:CFG.SIZE_BASING,
          tp: CFG.TP_BASING || Math.min(20, Math.max(6, Math.round(Wb/4 + p._fr))),
          sl: CFG.SL_BASING ? -CFG.SL_BASING : -Math.min(25, Math.max(10, Math.round(0.75*Wb+5))),
          stop: stopPx, wantedPct: Math.round(rawW) };
        }
      }
      else if (GATES.carry({ edge, ofi6, org, tvl:p.tvl, fr:p._fr, sigma, ageH, audit, path })) {
        // cap-aware: W/4 appreciation cap + ~2 days of fees (carries are multi-day)
        const Wc = Math.min(wCap, 35);
        sig = { label:'CARRY', mode:'two', widthPct:Wc, size:CFG.SIZE_CARRY, tp: CFG.TP_CARRY || Math.min(15, Math.max(6, Math.round(Wc/4 + p._fr*2))), sl: CFG.SL_CARRY ? -CFG.SL_CARRY : -Math.min(12, Math.max(8, Math.round(0.75*Wc+2))), stop:0, wantedPct: 35 };
      }
      else if (GATES.squeeze({ sqzPersist, path, pos, ofi, org, ageH, tvl:p.tvl, fr:p._fr })) {
        // SQUEEZE (long-vol wing): sigma compressed to <=60% of its own trailing median.
        // DATA-GATED: cannot fire without >=6 prior readings spanning >=45min. Width from the TRAILING sigma (what it coils back to).
        const wantQ = Math.min(30, Math.max(15, Math.round((sigmaTrail||60) / 4)));
        const Wq = Math.min(wCap, wantQ);
        sig = { label:'SQUEEZE', mode:'two', shape:'bidask', widthPct: Wq, size: CFG.SIZE_SQUEEZE,
          tp: CFG.TP_SQUEEZE || Math.min(25, Math.max(5, Math.round(Wq/3 + p._fr*0.5))), sl: CFG.SL_SQUEEZE ? -CFG.SL_SQUEEZE : -Math.min(20, Math.max(8, Math.round(0.7*Wq+2))), stop: 0, wantedPct: wantQ };
      }
      sc(`${n}${sigmaRatio!=null?" sqz "+sigmaRatio.toFixed(2):""} edge ${edge.toFixed(2).padStart(5)} surge ${p._sg.toFixed(2)} accel ${p._ac.toFixed(2)} ofi ${ofi.toFixed(2)}/${ofi6.toFixed(2)} org ${String(Math.round(org)).padStart(3)} ${path.padEnd(9)} ${sig ? '=> '+sig.label : '-- '+(extraBlock || blocker(edge,p._sg,p._ac,org,path,ageH,ofi))}  https://www.meteora.ag/dlmm/${p.address}`);
      // SHADOW LOG: persist every evaluation (signal or not) for counterfactual replay.
      // Zero extra API calls - this is data already in hand. Review with: node replay.cjs
      try {
        fs.appendFileSync(DIR + '/shadow.jsonl', JSON.stringify({ t: Date.now(), pool: p.address, name: p.name,
          tvl: Math.round(p.tvl || 0), fr: +p._fr.toFixed(2), sg: +p._sg.toFixed(2), ac: +p._ac.toFixed(2),
          sigma: +sigma.toFixed(1), src: rv != null ? 'rv' : 'lg', edge: +edge.toFixed(3),
          ofi: +ofi.toFixed(2), ofi6: +ofi6.toFixed(2), org: Math.round(org), path, ageH: +ageH.toFixed(1),
          dd: dd != null ? Math.round(dd) : null, sig: sig ? sig.label : null, w: sig ? sig.widthPct : null,
          // widened 2026-08-08: every gate INPUT now persists, so rule variants can be
          // tested offline. Before this, squeeze ratios lived only in daemon_state's
          // rolling 40-entry window — the best-performing class had the least data —
          // and rawW/pos/pc5/pc1 weren't logged at all (tight-base and path boundaries
          // were untestable in replay).
          pc5: +pc5.toFixed(1), pc1: +pc1.toFixed(1), pos: pos != null ? +pos.toFixed(2) : null,
          px, rawW: +rawW.toFixed(1), sqzR: sigmaRatio != null ? +sigmaRatio.toFixed(2) : null,
          sqzP: sqzPersist ? 1 : 0, binStep: p.pool_config?.bin_step ?? null }) + '\n');
      } catch (e) {}
      if (sig) sigs.push({ p, sig });
      await new Promise(r=>setTimeout(r,130));
      } catch(e){ log(`scan err ${p.name}: ${e.message}`); }
  }
  // BIN-AWARE SELECTION: the same token often lists 3 pools (20/25/50/100bps) and
  // the finest bin step usually ranks first by fee rate - but it may not be able to
  // express the width the data asked for (a +-35 CARRY needs 350 bins at 20bps vs 35
  // at 100bps). Prefer the pool that can hold the wanted width; candidates arrive in
  // fee-rate order and Array#sort is stable, so fee rate remains the tiebreak.
  if (sigs.length) {
    const ratio = (x) => x.sig.widthPct / (x.sig.wantedPct || x.sig.widthPct);
    const head = sigs[0];
    sigs.sort((a, b) => ratio(b) - ratio(a));
    best = sigs[0];
    if (best.p.address !== head.p.address) {
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
  if (best) {
    const { p, sig } = best;
    ev(`DEPLOY ${sig.label} ${p.name} size ${sig.size} width ±${sig.widthPct}% tp ${sig.tp} sl ${sig.sl}  https://www.meteora.ag/dlmm/${p.address}`);
    try {
      const out = execFileSync(NODE, [DIR+'/deploy.cjs','--pool',p.address,'--size',String(sig.size),'--mode',sig.mode,
        '--widthPct',String(sig.widthPct),'--tp',String(sig.tp),'--sl',String(sig.sl),'--stopPrice',String(sig.stop),'--label',sig.label,'--shape',(sig.shape||'spot')], { cwd: DIR, timeout: 480e3 }).toString();
      ev(`DEPLOYED ${sig.label} ${p.name}: ${out.match(/DEPLOYED: (\S+)/)?.[1]||'ok'}`);
    } catch(e){ ev(`DEPLOY FAILED ${p.name}: ${String((e.stderr||'') + ' | ' + (e.stdout||'')).replace(/\s+/g,' ').slice(0,300) || String(e.message).slice(0,150)}`); }
  }
  saveSt(s);
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
