// launchwatch.cjs — OBSERVER ONLY. Records the launch-phase universe the daemon
// structurally cannot see, so a first-wave thesis can be tested on real data later
// instead of invented thresholds.
//
//   node launchwatch.cjs          # run in its own terminal, Ctrl-C to stop
//
// WHY THIS EXISTS: scan() discovers pools via sort_by=volume_24h:desc, which ranks by
// YESTERDAY's activity — a 20-minute-old pool has no 24h volume and never appears
// (measured 2026-08-09: the top 5 by volume_24h were 20703h/733h/21715h/25h/23h old,
// while the top 5 by fee_tvl_ratio_1h were 0.2h/0.8h/0.4h/1.2h/16.5h). So shadow.jsonl
// contains only pools that SURVIVED into the top-100 — survivors, never the first wave.
// This process logs the missing half.
//
// IT CANNOT TRADE. No keypair() call, no deploy/exit shell-out, no signing path — the
// private key is never loaded into this process. It writes only its own two files and
// never touches positions.json / daemon_state.json / shadow.jsonl / trades.json.
// Safe to start, kill, or delete with zero effect on the daemon.
const fs = require('fs');
const DIR = __dirname;
const { JUP_KEY: JK, CFG } = require("./config.cjs");
const { fetchVolDay, sigmaFrom } = require("./vol.cjs");
const GATES = require("./gates.cjs");           // same detectors the daemon deploys by
const MET = "https://dlmm.datapi.meteora.ag";
const SOLM = CFG.QUOTE_MINT;

const num = (k, d) => { const v = process.env[k]; const n = v === undefined || v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
const LW = {
  TICK_MS:   num('LW_TICK_MS', 180e3),   // launches move fast; 3 min vs the daemon's 10
  MAX_AGE_H: num('LW_MAX_AGE_H', 8),     // "launch phase" cutoff
  MIN_TVL:   num('LW_MIN_TVL', 15000),   // far below the daemon's floor - new pools start small
  TOP_N:     num('LW_TOP_N', 10),        // candidates evaluated per tick
  THROTTLE:  num('LW_THROTTLE', 400),    // ms between Jupiter calls (shared key with the daemon)
};
// NOT named shadow-*.jsonl on purpose: replay.cjs ingests every file matching that
// pattern, so launch-phase rows (measured at ~-4%% mean, see launchlab.cjs) would
// silently contaminate the live class curves. Caught 2026-08-09 when a 4-row smoke
// test showed up in replay's source list.
const LOG = DIR + '/launch.log', SHADOW = DIR + '/launchwatch.jsonl';
const log = (m) => { const l = `${new Date().toISOString()} | ${m}`; console.log(l); try { fs.appendFileSync(LOG, l+'\n'); } catch(e){} };
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
let stopping = false;
process.on('SIGINT', () => { console.log('\nstopping after this tick…'); stopping = true; });

async function jget(u, jup){ const r = await fetch(u, jup?{headers:{'x-api-key':JK}}:undefined); if(!r.ok) throw new Error(`${r.status}`); return r.json(); }

// per-token sigma history, so SQUEEZE-style compression is measurable on launches too
const hist = {};

async function tick() {
  // DISCOVERY: fee-to-TVL ranking surfaces pools minutes old; volume_24h cannot.
  const bd = await jget(`${MET}/pools?sort_by=fee_tvl_ratio_1h:desc&page_size=100`);
  const now = Date.now();
  const B = (bd.data||bd).filter(p => {
    const ageH = p.created_at ? (now - p.created_at)/3600e3 : 999;
    return p.token_y?.address === SOLM && ageH <= LW.MAX_AGE_H && (p.tvl||0) >= LW.MIN_TVL;
  });
  B.forEach(p=>{ p._fr=(p.fee_tvl_ratio?.["1h"]||0)*24; p._sg=(p.dynamic_fee_pct||0)/(p.pool_config?.base_fee_pct||1); p._ac=(p.volume?.["30m"]*48)/Math.max(p.volume?.["4h"]*6,1); });
  B.sort((a,b)=>b._fr-a._fr);
  const cands = B.slice(0, LW.TOP_N);
  log(`tick: ${(bd.data||bd).length} pools -> ${B.length} launch-phase (<${LW.MAX_AGE_H}h, SOL-quoted) -> evaluating top ${cands.length}`);

  for (const p of cands) {
    try {
      const tk = await jget(`https://api.jup.ag/tokens/v2/search?query=${p.token_x.address}`, true);
      const t = Array.isArray(tk)?tk[0]:null; if(!t) continue;
      const ageH = t.createdAt ? (now-new Date(t.createdAt).getTime())/3600e3 : 999;
      const pc5=t.stats5m?.priceChange||0, pc1=t.stats1h?.priceChange||0, pc24=t.stats24h?.priceChange||0;
      let dd=null,pos=null,low=null,low6h=null,rv=null;
      try { const vd = await fetchVolDay(p.address, (u)=>jget(u)); rv=vd.rv; dd=vd.dd; pos=vd.pos; low=vd.low; low6h=vd.low6h; } catch(e){}
      const sigma = sigmaFrom(rv, ageH, pc5, pc1, pc24);
      const edge = GATES.edgeFrom(p._fr, sigma);
      const ofi = (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1);
      const ofi6 = (t.stats6h?.sellOrganicVolume||0)/Math.max(t.stats6h?.buyOrganicVolume||0,1);
      const org = t.organicScore||0;
      const path = GATES.classifyPath({ pc5, pc1, dd, pos });
      const px = Number(p.current_price)||0;
      const { rawW } = GATES.basingFloor({ px, low, low6h });
      // sigma trail (same contamination guard as the daemon: same-source entries only)
      const h = hist[p.token_x.address] || []; const src = rv!=null?'rv':'lg';
      h.push({ ts: now, sigma:+sigma.toFixed(1), src }); hist[p.token_x.address] = h.slice(-40);
      const hs = h.filter(x=>x.src===src).map(x=>x.sigma);
      let sqzR = null;
      if (hs.length >= 4) { const prior=hs.slice(0,-1).sort((a,b)=>a-b); const med=prior[Math.floor(prior.length/2)]; sqzR = +(sigma/Math.max(med,.001)).toFixed(2); }
      // WOULD the live gates fire? (recorded, never acted on)
      const would = GATES.ignition({edge,sg:p._sg,ac:p._ac,org,path,ageH,ofi}) ? 'IGNITION'
                  : GATES.basing({path,ofi,org,fr:p._fr,edge}) ? 'BASING'
                  : GATES.carry({edge,ofi6,org,tvl:p.tvl,fr:p._fr,sigma,ageH,audit:t.audit||{},path}) ? 'CARRY' : null;
      fs.appendFileSync(SHADOW, JSON.stringify({ t: now, pool: p.address, name: p.name, poolAgeH:+((now-(p.created_at||now))/3600e3).toFixed(2),
        tvl: Math.round(p.tvl||0), vol30m: Math.round(p.volume?.["30m"]||0), fr:+p._fr.toFixed(2), sg:+p._sg.toFixed(2), ac:+p._ac.toFixed(2),
        sigma:+sigma.toFixed(1), src, edge:+edge.toFixed(3), ofi:+ofi.toFixed(2), ofi6:+ofi6.toFixed(2), org:Math.round(org),
        path, ageH:+ageH.toFixed(2), dd: dd!=null?Math.round(dd):null, pos: pos!=null?+pos.toFixed(2):null,
        pc5:+pc5.toFixed(1), pc1:+pc1.toFixed(1), px, rawW:+rawW.toFixed(1), sqzR, binStep:p.pool_config?.bin_step??null,
        mint: p.token_x.address, would }) + '\n');
      log(`  ${(p.name||'?').padEnd(16).slice(0,16)} pool ${((now-(p.created_at||now))/60e3).toFixed(0).padStart(3)}m fr ${p._fr.toFixed(0).padStart(4)} sigma ${sigma.toFixed(0).padStart(4)} edge ${edge.toFixed(2).padStart(5)} surge ${p._sg.toFixed(2)} org ${String(Math.round(org)).padStart(3)} ${path.padEnd(9)} ${would?'=> WOULD '+would:''}`);
      await sleep(LW.THROTTLE);
    } catch(e) { log(`  err ${p.name}: ${e.message}`); }
  }
}

(async function loop(){
  log(`launchwatch ONLINE (observer only — cannot trade) | tick ${LW.TICK_MS/1000}s, age<${LW.MAX_AGE_H}h, minTVL ${LW.MIN_TVL}, top ${LW.TOP_N}`);
  log(`writing ${SHADOW}`);
  while (!stopping) {
    try { await tick(); } catch(e){ log('tick err '+e.message); }
    if (stopping) break;
    await sleep(LW.TICK_MS);
  }
  log('launchwatch stopped');
  process.exit(0);
})();
