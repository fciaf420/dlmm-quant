// DLMM Quant Trader Daemon — mechanical loop, runs under launchd, immune to screen lock.
// Manage every TICK_MS; scan+deploy every SCAN_MS. Events -> events.log (+ macOS notification).
const fs = require('fs'); const { execFileSync } = require('child_process');
const DIR = __dirname;
const { RPC_URL, JUP_KEY: JK, keypair } = require("./config.cjs");
const WALLET = keypair().publicKey.toBase58();
const MET = "https://dlmm.datapi.meteora.ag";
const TICK_MS = 120e3, SCAN_EVERY = 7; // scan every 7th tick (~14 min)
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

async function manage(){
  const positions = reg(); if(!positions.length) return [];
  const s = st(); const held = [];
  for (const p of positions) {
    try {
      const pnl = await jget(`${MET}/positions/${p.pool}/pnl?user=${WALLET}&status=open`);
      if (!pnl.totalCount) {
        ev(`EXTERNAL CLOSE detected ${p.name} — removing from registry`);
        fs.writeFileSync(DIR+'/positions.json', JSON.stringify(reg().filter(r=>r.pool!==p.pool),null,1));
        continue;
      }
      const pos = pnl.positions[0];
      const pnlPct = +pos.pnlSolPctChange, price = +pos.poolActivePrice;
      const pool = await jget(`${MET}/pools/${p.pool}`);
      const feeRate = (pool.fee_tvl_ratio?.["1h"]||0)*24;
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.mint}`, true);
      const t = Array.isArray(tk)?tk[0]:null;
      const ofi = t ? (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1) : 0;
      const pc1 = t?.stats1h?.priceChange||0;
      let trigger = null;
      if (pnlPct >= p.tpPct) trigger = `TP (${pnlPct.toFixed(1)}% >= ${p.tpPct})`;
      else if (p.stopPrice > 0 && price < p.stopPrice) trigger = `STOP-PRICE (${price.toExponential(2)} < ${p.stopPrice.toExponential(2)})`;
      else if (pnlPct <= p.slPct) trigger = `SL (${pnlPct.toFixed(1)}% <= ${p.slPct})`;
      else if (feeRate < 0.5*p.entryFeeRate && (s.lastFeeRates[p.pool]??99) < 0.5*p.entryFeeRate) trigger = `FEE-DECAY (${feeRate.toFixed(1)} < half of ${p.entryFeeRate.toFixed(1)}, x2)`;
      else if (ofi > 3 && pc1 < -15) trigger = `FLOW-FLIP (OFI ${ofi.toFixed(1)}, 1h ${pc1.toFixed(1)}%)`;
      s.lastFeeRates[p.pool] = feeRate;
      if (trigger) {
        ev(`EXIT ${p.label} ${p.name}: ${trigger} | pnl ${pnlPct.toFixed(2)}%`);
        try {
          const out = execFileSync(NODE, [DIR+'/exit.cjs','--pool',p.pool], { cwd: DIR, timeout: 480e3 }).toString();
          const fin = out.match(/FINAL wallet SOL: ([\d.]+)/)?.[1];
          s.cooldowns[p.pool] = Date.now();
          ev(`EXITED ${p.name} | wallet ${fin} SOL`);
        } catch(e){ ev(`EXIT FAILED ${p.name}: ${String(e.message).slice(0,120)} — will retry next tick`); }
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
  if (positions.length >= 2) { log('scan skipped: 2 positions open'); return 'scan skipped (2 open)'; }
  const bd = await jget(`${MET}/pools?sort_by=volume_24h:desc&page_size=100`);
  const B = (bd.data||bd).filter(p=>(p.tvl||0)>=60000 && (p.volume?.["24h"]||0)>=150000);
  B.forEach(p=>{ p._fr=(p.fee_tvl_ratio?.["1h"]||0)*24; p._sg=(p.dynamic_fee_pct||0)/(p.pool_config?.base_fee_pct||1); p._ac=(p.volume?.["30m"]*48)/Math.max(p.volume?.["4h"]*6,1); });
  B.sort((a,b)=>b._fr-a._fr);
  let best = null;
  const cands = B.slice(0,8);
  hb(`scanning: ${(bd.data||bd).length} pools -> ${B.length} pass tvl/vol -> checking top ${cands.length} by fee rate`);
  for (const [i, p] of cands.entries()) {
    const n = `${i+1}/${cands.length} ${(p.name||'?').padEnd(16).slice(0,16)}`;
    if (positions.find(r=>r.pool===p.address)) { sc(`${n} skip: already holding`); continue; }
    if (s.cooldowns[p.address] && Date.now()-s.cooldowns[p.address] < 2*3600e3) {
      const mins = Math.round((2*3600e3 - (Date.now()-s.cooldowns[p.address]))/60e3);
      sc(`${n} skip: cooldown ${mins}m left`); continue;
    }
    try {
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.token_x.address}`, true);
      const t = Array.isArray(tk)?tk[0]:null; if(!t) continue;
      seen++;
      const ageH = t.createdAt ? (Date.now()-new Date(t.createdAt).getTime())/3600e3 : 999;
      const pc5=t.stats5m?.priceChange||0, pc1=t.stats1h?.priceChange||0, pc24=t.stats24h?.priceChange||0;
      const sigma = ageH>=24 ? Math.max(Math.abs(pc5)*17, Math.abs(pc1)*4.9, Math.abs(pc24)) : Math.max(Math.abs(pc5)*17, Math.abs(pc1)*4.9, 60);
      const edge = ((p._fr*0.9)/Math.max(sigma,.001)) / Math.max(1.3*sigma/160,.001);
      const ofi = (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1);
      const ofi6 = (t.stats6h?.sellOrganicVolume||0)/Math.max(t.stats6h?.buyOrganicVolume||0,1);
      const org = t.organicScore||0;
      let dd=null,pos=null,low=null;
      try { const oh = await jget(`${MET}/pools/${p.address}/ohlcv`); const c=(oh.data||oh).slice(-1)[0];
        if(c){ dd=(c.high-c.close)/c.high*100; pos=(c.close-c.low)/Math.max(c.high-c.low,1e-18); low=c.low; } } catch(e){}
      let path="CHOP";
      if (pc1<=-25 || (pc5<=-8 && pc1<0)) path="FREEFALL";
      else if ((dd??0)>=40 && Math.abs(pc5)<5 && pc1>-15) path="BASING";
      else if ((pos??0)>0.85 && pc1>40) path="BLOWOFF";
      else if (pc1>0) path="GRIND-UP";
      const audit = t.audit||{};
      let sig = null;
      if (edge>=1.0 && p._sg>=1.25 && p._ac>=1.2 && org>=40 && path!=="FREEFALL" && (ageH>=6 || (org>=60 && ofi<2)))
        sig = { label:'IGNITION', mode: ofi>2?'single':'two', widthPct: Math.min(30,Math.max(12,Math.round(sigma/4))), size: edge>=2?0.4:0.3,
          tp: Math.min(40,Math.max(10,Math.round(Math.max(0.3*p._fr, 0.84*sigma)))), sl: -Math.min(25,Math.max(10,Math.round(sigma*0.7))), stop: 0 };
      else if (path==="BASING" && ofi<=1.0 && org>=60 && p._fr>=15 && edge>=0.5)
        sig = { label:'BASING', mode:'two', widthPct:18, size:0.3, tp:20, sl:-15, stop: low?low*0.98:0 };
      else if (edge>=1.3 && ofi6<1.0 && org>=60 && (p.tvl||0)>=100000 && (p._fr>=2 || (p._fr>=1.2 && edge>=2) || (p._fr>=0.6 && edge>=3 && sigma<10)) && ageH>=72 && audit.mintAuthorityDisabled===true && audit.freezeAuthorityDisabled===true && ["CHOP","BASING","GRIND-UP"].includes(path))
        sig = { label:'CARRY', mode:'two', widthPct:35, size:0.4, tp:15, sl:-12, stop:0 };
      sc(`${n} edge ${edge.toFixed(2).padStart(5)} surge ${p._sg.toFixed(2)} accel ${p._ac.toFixed(2)} ofi ${ofi.toFixed(2)}/${ofi6.toFixed(2)} org ${String(Math.round(org)).padStart(3)} ${path.padEnd(9)} ${sig ? '=> '+sig.label : '-- '+blocker(edge,p._sg,p._ac,org,path,ageH,ofi)}`);
      if (sig && !best) best = { p, sig };
      await new Promise(r=>setTimeout(r,130));
    } catch(e){ log(`scan err ${p.name}: ${e.message}`); }
  }
  if (best) {
    const { p, sig } = best;
    ev(`DEPLOY ${sig.label} ${p.name} size ${sig.size} width ±${sig.widthPct}% tp ${sig.tp} sl ${sig.sl}`);
    try {
      const out = execFileSync(NODE, [DIR+'/deploy.cjs','--pool',p.address,'--size',String(sig.size),'--mode',sig.mode,
        '--widthPct',String(sig.widthPct),'--tp',String(sig.tp),'--sl',String(sig.sl),'--stopPrice',String(sig.stop),'--label',sig.label], { cwd: DIR, timeout: 480e3 }).toString();
      ev(`DEPLOYED ${sig.label} ${p.name}: ${out.match(/DEPLOYED: (\S+)/)?.[1]||'ok'}`);
    } catch(e){ ev(`DEPLOY FAILED ${p.name}: ${String(e.message).slice(0,150)}`); }
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
