const { RPC_URL, JUP_KEY: JK, keypair } = require("./config.cjs");
(async () => {
  const bd = await (await fetch("https://dlmm.datapi.meteora.ag/pools?sort_by=volume_24h:desc&page_size=100")).json();
  const B = (bd.data||bd).filter(p=>(p.tvl||0)>=60000 && (p.volume?.["24h"]||0)>=150000);
  B.forEach(p=>{ p._fr=(p.fee_tvl_ratio?.["1h"]||0)*24; p._sg=(p.dynamic_fee_pct||0)/(p.pool_config?.base_fee_pct||1); p._ac=(p.volume?.["30m"]*48)/Math.max(p.volume?.["4h"]*6,1); });
  B.sort((a,b)=>b._fr-a._fr);
  const R = [];
  for (const p of B.slice(0,8)) {
    try {
      const tk = await (await fetch(`https://api.jup.ag/tokens/v2/search?query=${p.token_x.address}`, { headers:{'x-api-key':JK} })).json();
      const t = Array.isArray(tk)?tk[0]:null; if(!t) continue;
      const ageH = t.createdAt ? (Date.now()-new Date(t.createdAt).getTime())/3600000 : 999;
      const pc5=t.stats5m?.priceChange||0, pc1=t.stats1h?.priceChange||0, pc24=t.stats24h?.priceChange||0;
      const sigma = ageH>=24 ? Math.max(Math.abs(pc5)*17, Math.abs(pc1)*4.9, Math.abs(pc24)) : Math.max(Math.abs(pc5)*17, Math.abs(pc1)*4.9, 60);
      const edge = ((p._fr*0.9)/Math.max(sigma,0.001)) / Math.max(1.3*sigma/160, 0.001);
      const ofi = (t.stats1h?.sellOrganicVolume||0)/Math.max(t.stats1h?.buyOrganicVolume||0,1);
      let dd=null, pos=null, path="?";
      try {
        const oh = await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${p.address}/ohlcv`)).json();
        const cs = oh.data||oh; const c = Array.isArray(cs)&&cs.length ? cs[cs.length-1] : null;
        if(c){ dd=(c.high-c.close)/c.high*100; pos=(c.close-c.low)/Math.max(c.high-c.low,1e-18); }
      } catch(e){}
      if (pc1<=-25 || (pc5<=-8 && pc1<0)) path="FREEFALL";
      else if ((dd??0)>=40 && Math.abs(pc5)<5 && pc1>-15) path="BASING";
      else if ((pos??0)>0.85 && pc1>40) path="BLOWOFF";
      else if (pc1>0) path="GRIND-UP";
      else path="CHOP";
      R.push({ name:p.name, tvl:Math.round(p.tvl/1000), fr:+p._fr.toFixed(1), edge:+edge.toFixed(2),
        surge:+p._sg.toFixed(2), accel:+p._ac.toFixed(2), ofi:+ofi.toFixed(2), org:Math.round(t.organicScore||0),
        dd:dd!=null?Math.round(dd):null, pos:pos!=null?+pos.toFixed(2):null, pc5:+pc5.toFixed(1), pc1:+pc1.toFixed(1), path, ageH:+ageH.toFixed(1) });
      await new Promise(r=>setTimeout(r,140));
    } catch(e){}
  }
  R.sort((a,b)=>b.edge-a.edge);
  console.log("run:", new Date().toISOString());
  console.log("pool | TVL$k | fee%/d | EDGE | surge | accel | OFI | org | dd% | rngPos | 5m% | 1h% | PATH");
  for(const r of R) console.log(`${r.name} | ${r.tvl} | ${r.fr} | ${r.edge} | ${r.surge} | ${r.accel} | ${r.ofi} | ${r.org} | ${r.dd} | ${r.pos} | ${r.pc5} | ${r.pc1} | ${r.path}`);
  const ign = R.filter(r=>r.edge>=1 && r.surge>=1.25 && r.accel>=1.2 && r.org>=40 && r.path!=="FREEFALL" && (r.ageH>=6 || (r.org>=60 && r.ofi<2)));
  const bas = R.filter(r=>r.path==="BASING" && r.ofi<=1.0 && r.org>=60 && r.fr>=15 && r.edge>=0.5);
  console.log("\nIGNITION:", ign.length?JSON.stringify(ign.map(r=>r.name)):"none");
  console.log("BASING SETUP:", bas.length?JSON.stringify(bas.map(r=>r.name)):"none");
})();
