// Read-only preview of the same trade and BID ASK engine the daemon executes.
const { JUP_KEY: JK, CFG } = require('./config.cjs');
const { fetchVolDay, sigmaFrom } = require('./vol.cjs');
const GATES = require('./gates.cjs');
const { createCandleDiagnostics } = require('./candle_diagnostics.cjs');
const { refreshBidAskCandidates } = require('./bidask_runtime.cjs');
const fs = require('fs');

const metric = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;
const show = (v, digits = 2) => v == null ? '?' : Number(v).toFixed(digits);

(async () => {
  const boardResponse = await fetch('https://dlmm.datapi.meteora.ag/pools?sort_by=volume_24h:desc&page_size=100');
  if (!boardResponse.ok) throw new Error(`pool board ${boardResponse.status}`);
  const bd = await boardResponse.json();
  const boardTs = Date.now();
  const B = (bd.data || bd).filter(p => Number(p.tvl) >= CFG.MIN_TVL
    && Number(p.volume?.['24h']) >= CFG.MIN_VOL_24H
    && p.token_x?.address && p.token_x.address !== CFG.QUOTE_MINT
    && p.token_y?.address === CFG.QUOTE_MINT);
  B.forEach(p => {
    const f1 = metric(p.fee_tvl_ratio?.['1h']);
    const base = metric(p.pool_config?.base_fee_pct);
    const v30 = metric(p.volume?.['30m']), v4 = metric(p.volume?.['4h']);
    p._fr = f1 == null ? null : f1 * 24;
    p._fr24 = metric(p.fee_tvl_ratio?.['24h']);
    p._sg = metric(p.dynamic_fee_pct) == null || base == null || base <= 0 ? null : metric(p.dynamic_fee_pct) / base;
    p._ac = v30 == null || v4 == null ? null : (v30 * 48) / Math.max(v4 * 6, 1);
  });
  B.sort((a, b) => (b._fr ?? -Infinity) - (a._fr ?? -Infinity));

  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(__dirname + '/daemon_state.json', 'utf8')).history || {}; } catch (e) {}
  const tokenCache = new Map();
  const tokenFor = async (mint) => {
    if (!tokenCache.has(mint)) tokenCache.set(mint,
      fetch(`https://api.jup.ag/tokens/v2/search?query=${mint}`, { headers: { 'x-api-key': JK } })
        .then(async response => ({ response: response.ok ? await response.json() : null, ts: Date.now() })));
    const hit = await tokenCache.get(mint);
    const token = Array.isArray(hit.response)
      ? hit.response.find(x => (x.id || x.address || x.mint) === mint) || null : null;
    return { token, ts: hit.ts };
  };

  const candleDiagnostics = createCandleDiagnostics({ maxPerBatch: 2, maxPools: 2 });
  const R = [];
  for (const p of B.slice(0, CFG.SCAN_TOP_N)) {
    try {
      const tokenHit = await tokenFor(p.token_x.address);
      const t = tokenHit.token; if (!t) continue;
      const ageH = t.createdAt ? (Date.now() - new Date(t.createdAt).getTime()) / 3600e3 : 999;
      const pc5 = metric(t.stats5m?.priceChange), pc1 = metric(t.stats1h?.priceChange), pc24 = metric(t.stats24h?.priceChange);
      const buy1 = metric(t.stats1h?.buyOrganicVolume), sell1 = metric(t.stats1h?.sellOrganicVolume);
      const buy6 = metric(t.stats6h?.buyOrganicVolume), sell6 = metric(t.stats6h?.sellOrganicVolume);
      const ofi = buy1 == null || sell1 == null ? null : sell1 / Math.max(buy1, 1);
      const ofi6 = buy6 == null || sell6 == null ? null : sell6 / Math.max(buy6, 1);
      let dd = null, pos = null, low = null, low6h = null, rv = null, recentCandles = [];
      try { const vd = await fetchVolDay(p.address); ({ rv, dd, pos, low, low6h, recentCandles = [] } = vd); } catch (e) {}
      const legacyReady = pc5 != null && pc1 != null && (ageH < 24 || pc24 != null);
      const sigma = rv != null ? sigmaFrom(rv, ageH, pc5 || 0, pc1 || 0, pc24 || 0)
        : legacyReady ? sigmaFrom(null, ageH, pc5, pc1, pc24 || 0) : null;
      if (sigma == null || sigma < CFG.MIN_SIGMA) continue;
      const path = pc5 == null || pc1 == null ? 'UNKNOWN' : GATES.classifyPath({ pc5, pc1, dd, pos });
      const px = Number(p.current_price) || 0;
      const audit = t.audit || {};
      const dataTs = Math.min(boardTs, tokenHit.ts);
      const scanData = {
        address: p.address, ok: true, ts: dataTs, supportedSolPair: true,
        feeRate1h: p._fr, feeRate24h: p._fr24, sigma,
        surge: p._sg, accel: p._ac, org: metric(t.organicScore), orgBuy1h: buy1,
        path, ageH, ofi, ofi6, tvl: Number(p.tvl), audit, px, low, low6h, dd,
        binStepBps: Number(p.pool_config?.bin_step),
      };
      const signalConfig = {
        maxBins: CFG.MAX_BINS, basingMaxFloor: CFG.BASING_MAX_FLOOR,
        sizeIgnition: CFG.SIZE_IGNITION, sizeIgnitionHi: CFG.SIZE_IGNITION_HI,
        sizeBasing: CFG.SIZE_BASING, sizeCarry: CFG.SIZE_CARRY, sizeBidAsk: CFG.SIZE_BID_ASK,
      };
      const evaluated = GATES.collectSignals({ now: Date.now(), data: scanData, config: signalConfig });
      const hs = (hist[p.token_x.address] || []).filter(x => x.src === (rv != null ? 'rv' : 'lg'));
      const r2 = hs.slice(-2).map(x => x.ratio);
      const compression = r2.length === 2 && r2.every(x => x != null && x <= 0.6);
      R.push({
        addr: p.address, name: p.name, tvl: Number(p.tvl), fr: p._fr,
        edge: evaluated.trade ? evaluated.trade.edge : (evaluated.recipeEdges.IGNITION || 0), surge: p._sg, accel: p._ac,
        ofi, ofi6, org: metric(t.organicScore), dd, pos, pc5, pc1, path, ageH, sigma,
        evaluated, compression, poolCreatedAt: p.created_at, recentCandles,
        data: scanData, config: signalConfig, dataTs, mint: p.token_x.address, pool: p,
      });
      await new Promise(r => setTimeout(r, 140));
    } catch (e) {}
  }

  // Match the daemon's execution order: TRADE gets first refusal. If no trade
  // is available, refresh at most two deduplicated BID ASK histories before
  // rendering this read-only preview; the rest remain WATCH/deferred for the
  // daemon's persistent rotation.
  const bidAskCandidates = R.filter(r => r.evaluated.bidAskStatus?.baseReady).map(r => ({
    address: r.addr, mint: r.mint, p: r.pool, name: r.name,
    poolCreatedAt: r.poolCreatedAt, recentCandles: r.recentCandles,
    data: r.data, config: r.config, dataTs: r.dataTs,
    bidAskStatus: r.evaluated.bidAskStatus,
  }));
  const nowBeforeBidAsk = Date.now();
  const hasFreshTrade = R.some(r => r.evaluated.trade && Number.isFinite(r.dataTs)
    && nowBeforeBidAsk >= r.dataTs && nowBeforeBidAsk - r.dataTs <= GATES.BID_ASK_FRESH_MS);
  if (!hasFreshTrade && bidAskCandidates.length) {
    const refreshed = await refreshBidAskCandidates(bidAskCandidates, {
      diagnostics: candleDiagnostics, collectSignals: GATES.collectSignals, max: 2,
      nowMs: () => Date.now(),
    });
    for (const candidate of refreshed.refreshed) {
      const row = R.find(r => r.addr === candidate.address);
      if (!row) continue;
      row.evaluated = candidate.evaluated || row.evaluated;
      row.candle = candleDiagnostics.get(row.addr);
    }
  }
  for (const r of R) if (!r.candle) r.candle = candleDiagnostics.get(r.addr);

  R.sort((a, b) => b.edge - a.edge);
  console.log('run:', new Date().toISOString());
  console.log('pool | TVL$k | fee%/d | EDGE@recipe | surge | accel | OFI | org | dd% | rngPos | 5m% | 1h% | PATH');
  for (const r of R) console.log(`${r.name} | ${Math.round(r.tvl / 1000)} | ${show(r.fr, 1)} | ${show(r.edge)} | ${show(r.surge)} | ${show(r.accel)} | ${show(r.ofi)} | ${r.org == null ? '?' : Math.round(r.org)} | ${r.dd != null ? Math.round(r.dd) : '?'} | ${show(r.pos)} | ${show(r.pc5, 1)} | ${show(r.pc1, 1)} | ${r.path} | https://www.meteora.ag/dlmm/${r.addr}`);
  const trades = R.filter(r => r.evaluated.trade);
  for (const label of ['IGNITION', 'BASING', 'CARRY']) {
    const rows = trades.filter(r => r.evaluated.trade.label === label);
    console.log(`${label}:`, rows.length ? JSON.stringify(rows.map(r => r.name)) : 'none');
  }
  const bidAskEntries = R.map(r => ({
    p: r.pool, mint: r.mint, dataTs: r.dataTs,
    sig: r.evaluated.bidAsk,
    bidAskStatus: r.evaluated.bidAskStatus,
    candleAnalysis: r.evaluated.bidAsk?.candleAnalysis || r.evaluated.bidAskStatus?.candleAnalysis,
  }));
  const bidAsk = GATES.selectBidAskCandidates(bidAskEntries, { nowMs: Date.now() });
  const capacity = R.filter(r => r.evaluated.bidAskStatus?.baseReady
    && r.evaluated.bidAskStatus.range?.executable === false);
  console.log('BID ASK READY:', bidAsk.length ? JSON.stringify(bidAsk.map(r => `${r.p.name} ${r.sig.bidAskPct}/${r.sig.spotPct} 0..-${r.sig.depthPct}%`)) : 'none');
  if (capacity.length) console.log('BID ASK CAPACITY WAIT:', JSON.stringify(capacity.map(r => `${r.name} needs ${r.evaluated.bidAskStatus.range?.totalBins || '?'} bins > ${CFG.MAX_BINS}`)));
  const candleRows = R.filter(r => r.evaluated.bidAskStatus?.baseReady);
  console.log('CANDLE EVIDENCE (bounded preview: two BID ASK histories refreshed before selection; remaining candidates WATCH/deferred):');
  for (const r of candleRows) {
    const c = r.candle;
    if (!c || !['READY', 'LIMITED'].includes(c.state)) {
      console.log(`  ${r.name}: ${c?.state || 'NOT_COLLECTED'}${c?.reason ? ` (${c.reason})` : ''}`);
    } else {
      const matured = c.matured ? `${c.recovered}/${c.matured} recovered` : 'no matured outcomes';
      console.log(`  ${r.name}: ${c.state} ${c.hours}h | dips ${c.total}: ${matured}, ${c.timedOut} timed out, ${c.pending} pending | median depth ${c.medianDepthPct ?? 'n/a'}% | median recovery ${c.medianRecoveryMinutes ?? 'n/a'}m | drawdown ${c.currentDrawdownPct}% | total-volume ratio ${c.recentVolumeRatio ?? 'n/a'}x`);
    }
  }
  const compression = R.filter(r => r.compression);
  console.log('COMPRESSION (diagnostic only; no SQUEEZE entry):', compression.length ? JSON.stringify(compression.map(r => r.name)) : 'none');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
