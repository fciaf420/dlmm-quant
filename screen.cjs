// screen.cjs — read-only preview board. Universe filters and gate verdicts come
// from config.cjs + gates.cjs — the SAME code the daemon deploys by — so the
// board can no longer drift from the live rules. (Before 2026-08-07 it carried
// hand-retyped copies: hardcoded 60k/150k/top-8, no SOL-quote filter, no
// tight-base gate, and no CARRY/SQUEEZE classes at all — it could show setups
// the daemon would refuse and hide ones it trades.)
// SQUEEZE persistence is read from daemon_state.json (the daemon's own stored
// trailing-sigma ratios, same-source entries only); with no daemon state on
// disk it simply reports none.
const { JUP_KEY: JK, CFG } = require("./config.cjs");
const { fetchVolDay, sigmaFrom } = require("./vol.cjs");
const GATES = require("./gates.cjs");
const fs = require("fs");
(async () => {
  const bd = await (await fetch("https://dlmm.datapi.meteora.ag/pools?sort_by=volume_24h:desc&page_size=100")).json();
  // same universe as the daemon: TVL/vol floors + quote-mint filter (deploy can't ship anything else)
  const B = (bd.data||bd).filter(p=>(p.tvl||0)>=CFG.MIN_TVL && (p.volume?.["24h"]||0)>=CFG.MIN_VOL_24H && p.token_y?.address===CFG.QUOTE_MINT);
  B.forEach(p=>{ p._fr=(p.fee_tvl_ratio?.["1h"]||0)*24; p._sg=(p.dynamic_fee_pct||0)/(p.pool_config?.base_fee_pct||1); p._ac=(p.volume?.["30m"]*48)/Math.max(p.volume?.["4h"]*6,1); });
  B.sort((a,b)=>b._fr-a._fr);
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(__dirname+'/daemon_state.json','utf8')).history || {}; } catch(e){}
  const R = [];
  for (const p of B.slice(0, CFG.SCAN_TOP_N)) {
    try {
      const tk = await (await fetch(`https://api.jup.ag/tokens/v2/search?query=${p.token_x.address}`, { headers:{'x-api-key':JK} })).json();
      const t = Array.isArray(tk)?tk[0]:null; if(!t) continue;
      const ageH = t.createdAt ? (Date.now()-new Date(t.createdAt).getTime())/3600000 : 999;
      const pc5=t.stats5m?.priceChange||0, pc1=t.stats1h?.priceChange||0, pc24=t.stats24h?.priceChange||0;
      const ofi = (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1);
      const ofi6 = (t.stats6h?.sellOrganicVolume||0)/Math.max(t.stats6h?.buyOrganicVolume||0,1);
      let dd=null, pos=null, low=null, low6h=null, rv=null;
      try { const vd = await fetchVolDay(p.address); rv=vd.rv; dd=vd.dd; pos=vd.pos; low=vd.low; low6h=vd.low6h; } catch(e){}
      const sigma = sigmaFrom(rv, ageH, pc5, pc1, pc24);   // RV primary, legacy fallback
      const edge = GATES.edgeFrom(p._fr, sigma);
      const path = GATES.classifyPath({ pc5, pc1, dd, pos });
      // squeeze persistence: last two same-source ratios the daemon recorded, both <= 0.6
      const hs = (hist[p.token_x.address]||[]).filter(x=>x.src===(rv!=null?'rv':'lg'));
      const r2 = hs.slice(-2).map(x=>x.ratio);
      const sqzPersist = r2.length===2 && r2.every(x=>x!=null && x<=0.6);
      const px = Number(p.current_price) || 0;
      const { rawW } = GATES.basingFloor({ px, low, low6h });
      R.push({ addr:p.address, name:p.name, tvl:p.tvl, fr:p._fr, edge, surge:p._sg, accel:p._ac, ofi, ofi6,
        org:t.organicScore||0, dd, pos, pc5, pc1, path, ageH, sigma, audit:t.audit||{}, rawW, sqzPersist });
      await new Promise(r=>setTimeout(r,140));
    } catch(e){}
  }
  R.sort((a,b)=>b.edge-a.edge);
  console.log("run:", new Date().toISOString());
  console.log("pool | TVL$k | fee%/d | EDGE | surge | accel | OFI | org | dd% | rngPos | 5m% | 1h% | PATH");
  for(const r of R) console.log(`${r.name} | ${Math.round(r.tvl/1000)} | ${r.fr.toFixed(1)} | ${r.edge.toFixed(2)} | ${r.surge.toFixed(2)} | ${r.accel.toFixed(2)} | ${r.ofi.toFixed(2)} | ${Math.round(r.org)} | ${r.dd!=null?Math.round(r.dd):null} | ${r.pos!=null?r.pos.toFixed(2):null} | ${r.pc5.toFixed(1)} | ${r.pc1.toFixed(1)} | ${r.path} | https://www.meteora.ag/dlmm/${r.addr}`);
  const ign = R.filter(r=>GATES.ignition({ edge:r.edge, sg:r.surge, ac:r.accel, org:r.org, path:r.path, ageH:r.ageH, ofi:r.ofi }));
  const basAll = R.filter(r=>GATES.basing({ path:r.path, ofi:r.ofi, org:r.org, fr:r.fr, edge:r.edge }));
  const bas = basAll.filter(r=>r.rawW <= CFG.BASING_MAX_FLOOR);
  const basBlocked = basAll.filter(r=>r.rawW > CFG.BASING_MAX_FLOOR);
  const car = R.filter(r=>GATES.carry({ edge:r.edge, ofi6:r.ofi6, org:r.org, tvl:r.tvl, fr:r.fr, sigma:r.sigma, ageH:r.ageH, audit:r.audit, path:r.path }));
  const sqz = R.filter(r=>GATES.squeeze({ sqzPersist:r.sqzPersist, path:r.path, pos:r.pos, ofi:r.ofi, org:r.org, ageH:r.ageH, tvl:r.tvl, fr:r.fr }));
  console.log("\nIGNITION:", ign.length?JSON.stringify(ign.map(r=>r.name)):"none");
  console.log("BASING SETUP:", bas.length?JSON.stringify(bas.map(r=>r.name)):"none");
  if (basBlocked.length) console.log("  basing blocked by tight-base gate:", JSON.stringify(basBlocked.map(r=>`${r.name} floor ${r.rawW.toFixed(0)}% > ${CFG.BASING_MAX_FLOOR}%`)));
  console.log("CARRY:", car.length?JSON.stringify(car.map(r=>r.name)):"none");
  console.log("SQUEEZE:", sqz.length?JSON.stringify(sqz.map(r=>r.name)):"none");
})();
