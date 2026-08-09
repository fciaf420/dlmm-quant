// launchlab.cjs — does ANY LP configuration have positive expectancy on launch-phase
// tokens? Offline, read-only, propose-only. Never trades, never edits config.
//
//   node launchlab.cjs [--maxAge 8] [--max 120] [--horizon 3]
//
// The question this settles: the daemon DOES see launches (14 of 39 tokens first seen
// within 8h) and rejects ~96%% of them on edge, because edge = fr/sigma^2 and launch
// sigma is 235 median vs fees of 152%%/day. That is not a threshold being slightly
// wrong - it is two orders of magnitude. So: is the EDGE GATE mis-calibrated for this
// regime, or is the LP PAYOFF genuinely bad when sigma >> band width? Only a payoff
// model against real forward price paths can tell them apart.
//
// Uses 5m candles (not replay.cjs's 30m): launch trades resolve in minutes, and 30m
// granularity smooths away exactly the moves being tested. Same fee model as replay:
// pool fees x (notional/TVL) while in range. Approximations are ranking-grade - trust
// the ORDERING of variants far more than the absolute numbers, and note there is no
// slippage or swap cost here, which flatters every variant equally.
const fs = require('fs');
const DIR = __dirname;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const MAX_AGE = arg('maxAge', 8), MAX_NEW = arg('max', 120), HORIZON_H = arg('horizon', 3);
const CACHE = DIR + '/launchlab-cache.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- payoff models -------------------------------------------------------
// TWO-SIDED, uniform: upside caps at W/4 (token half converts out as price climbs),
// downside ~0.75x to band break then 1:1 below. Verbatim from replay.cjs.
function pnlTwoSided(r, W) {
  const d = r - 1;
  if (d >= 0) return Math.min(d / 2, W / 4);
  if (d >= -W) return 0.75 * d;
  return -0.75 * W + (d + W);
}
// ONE-SIDED BID (SOL only, band [1-W, 1] BELOW entry): starts 100%% SOL and fills only
// if price retraces into the band. Simulated by bin crossing - SOL converts to token on
// the way down, back to SOL on the way up - so a V-shaped round trip returns to ~flat
// on price and keeps the fees, while a straight-down move leaves you holding the bag.
// A launch that only goes UP never fills: zero PnL, zero fees. That asymmetry is the
// whole point of testing it.
function makeBidLadder(W, nBins = 50) {
  const bins = [];
  for (let i = 0; i < nBins; i++) bins.push({ px: 1 - W * (i + 0.5) / nBins, sol: 1 / nBins, tok: 0 });
  return bins;
}
function stepBidLadder(bins, r) {
  for (const b of bins) {
    if (r <= b.px && b.sol > 0) { b.tok += b.sol / b.px; b.sol = 0; }        // price fell through: buy
    else if (r > b.px && b.tok > 0) { b.sol += b.tok * b.px; b.tok = 0; }    // price rose back: sell
  }
}
const bidValue = (bins, r) => bins.reduce((s, b) => s + b.sol + b.tok * r, 0);

// ---- variants ------------------------------------------------------------
// widthPct: null = the live recipe's sigma-derived width. stopMin: minute time-stop.
const VARIANTS = [
  { key: 'live-recipe',      side: 'two', width: null, stopMin: null, note: 'what the bot would do today' },
  { key: 'two ±30 / 20m',    side: 'two', width: 30,   stopMin: 20 },
  { key: 'two ±12 / 20m',    side: 'two', width: 12,   stopMin: 20,  note: 'narrow: more fees per min in range' },
  { key: 'two ±12 / 60m',    side: 'two', width: 12,   stopMin: 60 },
  { key: 'two ±8  / 20m',    side: 'two', width: 8,    stopMin: 20 },
  { key: 'bid  ±20 / 60m',   side: 'bid', width: 20,   stopMin: 60,  note: 'one-sided SOL, fills only on retrace' },
  { key: 'bid  ±12 / 60m',   side: 'bid', width: 12,   stopMin: 60 },
];

async function fetchPath(row) {
  const t0 = Math.floor(row.t / 1000), t1 = t0 + HORIZON_H * 3600;
  const [oh, vh] = await Promise.all([
    fetch(`https://dlmm.datapi.meteora.ag/pools/${row.pool}/ohlcv?timeframe=5m&start_time=${t0}&end_time=${t1}`).then(r => r.json()).catch(() => null),
    fetch(`https://dlmm.datapi.meteora.ag/pools/${row.pool}/volume/history?timeframe=5m&start_time=${t0}&end_time=${t1}`).then(r => r.json()).catch(() => null),
  ]);
  const candles = (oh && oh.data) || [];
  if (candles.length < 3) return null;
  const fees = {}; for (const v of ((vh && vh.data) || [])) fees[v.timestamp] = Number(v.fees || 0);
  return { candles, fees };
}

function runVariant(row, path, V) {
  const { candles, fees } = path;
  const p0 = Number(candles[0].open) || Number(candles[0].close);
  if (!(p0 > 0) || !(row.tvl > 0)) return null;
  const W = (V.width != null ? V.width : Math.min(30, Math.max(12, Math.round(row.sigma / 4)))) / 100;
  const tpPct = Math.min(25, Math.max(4, Math.round(W * 100 / 4 + row.fr * 0.5)));
  const slPct = Math.min(20, Math.max(8, Math.round(0.75 * W * 100 + 2)));
  const bins = V.side === 'bid' ? makeBidLadder(W) : null;
  let feePnl = 0, oorRun = 0, decayRun = 0, trigger = 'HORIZON', pnl = 0, filled = false;
  const t0 = candles[0].timestamp;
  for (const c of candles) {
    const r = Number(c.close) / p0;
    const mins = (c.timestamp - t0) / 60;
    const inRange = V.side === 'bid' ? (r <= 1 && r >= 1 - W) : Math.abs(r - 1) <= W;
    if (inRange) feePnl += (fees[c.timestamp] || 0) / row.tvl * 100;
    if (V.side === 'bid') { stepBidLadder(bins, r); if (r <= 1) filled = true; pnl = (bidValue(bins, r) - 1) * 100 + feePnl; }
    else pnl = pnlTwoSided(r, W) * 100 + feePnl;
    const bucketFr = (fees[c.timestamp] || 0) / row.tvl * 288 * 100;   // 5m -> %/day
    decayRun = (row.fr > 2 && bucketFr < 0.5 * row.fr) ? decayRun + 1 : 0;
    oorRun = !inRange ? oorRun + 1 : 0;
    if (V.stopMin != null && mins >= V.stopMin) { trigger = 'TIME'; break; }
    if (pnl >= tpPct) { trigger = 'TP'; break; }
    if (pnl <= -slPct) { trigger = 'SL'; break; }
    if (V.side === 'two' && oorRun >= 2) { trigger = r > 1 ? 'OOR-UP' : 'OOR-DOWN'; break; }
    if (V.stopMin == null && decayRun >= 2) { trigger = 'FEE-DECAY'; break; }
  }
  return { pnl: +pnl.toFixed(2), trigger, fees: +feePnl.toFixed(2), filled };
}

(async () => {
  const rows = fs.readFileSync(DIR + '/shadow.jsonl', 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter(r => r.ageH != null && r.ageH < MAX_AGE && r.tvl > 0);
  // one observation per pool per 15 min: adjacent scans of the same pool are near-duplicates
  const seen = new Set(), obs = [];
  for (const r of rows) { const k = r.pool + ':' + Math.floor(r.t / 900e3); if (!seen.has(k)) { seen.add(k); obs.push(r); } }
  const ripe = obs.filter(r => Date.now() - r.t > (HORIZON_H * 3600 + 900) * 1000);
  console.log(`launch-phase rows (age<${MAX_AGE}h): ${rows.length} -> ${obs.length} deduped -> ${ripe.length} with a full ${HORIZON_H}h forward window\n`);

  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  let fetched = 0;
  for (const row of ripe) {
    const key = row.t + ':' + row.pool;
    if (cache[key] || fetched >= MAX_NEW) continue;
    const path = await fetchPath(row);
    fetched++;
    if (!path) { cache[key] = { skip: 'no-candles' }; continue; }
    const res = { edge: row.edge, sigma: row.sigma, fr: row.fr, ageH: row.ageH, name: row.name, v: {} };
    for (const V of VARIANTS) { const out = runVariant(row, path, V); if (out) res.v[V.key] = out; }
    cache[key] = res;
    await sleep(150);
    if (fetched % 20 === 0) process.stdout.write(`\r  fetched ${fetched} paths…`);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  const done = ripe.map(r => cache[r.t + ':' + r.pool]).filter(x => x && !x.skip && x.v);
  console.log(`\nsimulated: ${Object.keys(cache).length} (${fetched} new this run) | usable: ${done.length}\n`);
  if (!done.length) { console.log('no usable observations yet — rerun later as the forward windows mature'); return; }

  console.log(`=== LAUNCH-PHASE VARIANTS (n=${done.length}, tokens <${MAX_AGE}h old) ===`);
  console.log('variant              n    win%   meanPnL   medPnL   meanFees   triggers');
  for (const V of VARIANTS) {
    const R = done.map(d => d.v[V.key]).filter(Boolean);
    if (!R.length) continue;
    const pn = R.map(x => x.pnl).sort((a, b) => a - b);
    const mean = pn.reduce((a, b) => a + b, 0) / pn.length;
    const med = pn[Math.floor(pn.length / 2)];
    const win = R.filter(x => x.pnl > 0).length / R.length * 100;
    const mf = R.reduce((s, x) => s + x.fees, 0) / R.length;
    const trig = {}; for (const x of R) trig[x.trigger] = (trig[x.trigger] || 0) + 1;
    console.log(`${V.key.padEnd(20)} ${String(R.length).padStart(3)}   ${win.toFixed(0).padStart(3)}%   ${(mean>=0?'+':'')+mean.toFixed(2).padStart(6)}%  ${(med>=0?'+':'')+med.toFixed(2).padStart(6)}%    ${mf.toFixed(2).padStart(5)}%   ${Object.entries(trig).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>k+'×'+v).join(' ')}`);
  }
  const fillRate = done.map(d => d.v['bid  ±20 / 60m']).filter(Boolean).filter(x => x.filled).length;
  console.log(`\none-sided bid fill rate: ${fillRate}/${done.length} (unfilled = launch never retraced into the band = 0 PnL, 0 fees)`);
  console.log('friction: a real round trip costs ~0.4%% (measured). Nothing below that is tradeable.');
  console.log('NOTE: no slippage/swap cost modeled — every variant is flattered equally, so compare RANKS not levels.');
})();
