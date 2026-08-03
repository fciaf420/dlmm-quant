// replay.cjs — counterfactual review of the shadow log (shadow.jsonl).
// Usage: node replay.cjs [--max 150] [--friction 0.4]
//
// For every logged scan evaluation old enough to have a full forward window, this
// simulates the class recipe (or the IGNITION recipe for non-signals) against the
// pool's REAL price path (30m candles) and REAL fee series (volume/history fees),
// applying the daemon's exit rules. Results cache into replay-cache.json so each
// observation is only ever fetched once (a past outcome never changes).
//
// Output: per-class calibration curves — edge bucket -> n, win rate, mean PnL,
// exit-trigger mix — plus a near-miss audit (edge>=1 rows blocked only by
// surge/accel vs full passes). Gate recommendation = lowest edge bucket whose
// mean PnL clears --friction (%, default 0.4: measured round-trip cost).
//
// APPROXIMATIONS (ranking-grade, not penny-grade): uniform two-sided payoff with
// upside capped at W/4 and downside ~0.75x to band-break then 1:1 below; fees =
// pool fees x (your notional / TVL) while in range; OOR granularity is 2x30m
// candles vs the daemon's 2x2min ticks. Observations of the same pool overlap
// in time, so treat n as optimistic.
const fs = require('fs');
const DIR = __dirname;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? +process.argv[i + 1] : d; };
const MAX = arg('max', 150), FRICTION = arg('friction', 0.4);
const HORIZON_H = { IGNITION: 6, BASING: 24, CARRY: 48, SQUEEZE: 24 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pnlPrice(r, W) {  // W as fraction (0.15 = ±15%)
  const d = r - 1;
  if (d >= 0) return Math.min(d / 2, W / 4);                       // token half converts out; cap W/4
  if (d >= -W) return 0.75 * d;                                    // both halves hurt on the way down
  return -0.75 * W + (d + W);                                      // fully converted: 1:1 below the band
}

async function simulate(row) {
  const cls = row.sig || 'IGNITION';
  const W = (row.w || Math.min(30, Math.max(12, Math.round(row.sigma / 4)))) / 100;
  const tp = row.sig ? null : Math.min(25, Math.max(4, Math.round(W * 100 / 4 + row.fr * 0.5)));  // cap-aware
  const tpPct = tp != null ? tp : Math.min(25, Math.max(4, Math.round(W * 100 / 4 + row.fr * 0.5)));
  const slPct = Math.min(20, Math.max(8, Math.round(0.75 * W * 100 + 2)));
  const t0 = Math.floor(row.t / 1000);
  const t1 = t0 + (HORIZON_H[cls] || 6) * 3600;
  const [oh, vh] = await Promise.all([
    fetch(`https://dlmm.datapi.meteora.ag/pools/${row.pool}/ohlcv?timeframe=30m&start_time=${t0}&end_time=${t1}`).then((r) => r.json()).catch(() => null),
    fetch(`https://dlmm.datapi.meteora.ag/pools/${row.pool}/volume/history?timeframe=30m&start_time=${t0}&end_time=${t1}`).then((r) => r.json()).catch(() => null)
  ]);
  const candles = (oh && oh.data) || [];
  if (candles.length < 3) return { skip: 'no-candles' };
  const feeByTs = {};
  for (const v of ((vh && vh.data) || [])) feeByTs[v.timestamp] = Number(v.fees || 0);
  const p0 = Number(candles[0].open) || Number(candles[0].close);
  if (!(p0 > 0) || !(row.tvl > 0)) return { skip: 'bad-entry' };
  let pnl = 0, feePnl = 0, oorRun = 0, decayRun = 0, trigger = 'HORIZON';
  const entryFr = row.fr;
  for (const c of candles) {
    const r = Number(c.close) / p0;
    const inRange = Math.abs(r - 1) <= W;
    if (inRange) {
      // fee share: pool fees this bucket x (notional/TVL); percentage points of position
      feePnl += (feeByTs[c.timestamp] || 0) / row.tvl * 100;
    }
    pnl = pnlPrice(r, W) * 100 + feePnl;
    const bucketFr = (feeByTs[c.timestamp] || 0) / row.tvl * 48 * 100;  // annualized-to-daily %/day
    decayRun = (entryFr > 2 && bucketFr < 0.5 * entryFr) ? decayRun + 1 : 0;
    oorRun = !inRange ? oorRun + 1 : 0;
    if (pnl >= tpPct) { trigger = 'TP'; break; }
    if (pnl <= -slPct) { trigger = 'SL'; break; }
    if (oorRun >= 2) { trigger = r > 1 ? 'OOR-UP' : 'OOR-DOWN'; break; }
    if (decayRun >= 2) { trigger = 'FEE-DECAY'; break; }
  }
  return { cls, pnl: +pnl.toFixed(2), trigger, edge: row.edge, gates: { sg: row.sg, ac: row.ac, org: row.org, path: row.path } };
}

(async () => {
  if (!fs.existsSync(DIR + '/shadow.jsonl')) { console.log('shadow.jsonl not found — it accrues while the daemon runs.'); return; }
  const rows = fs.readFileSync(DIR + '/shadow.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const cache = fs.existsSync(DIR + '/replay-cache.json') ? JSON.parse(fs.readFileSync(DIR + '/replay-cache.json', 'utf8')) : {};
  let fetched = 0;
  for (const row of rows) {
    const key = row.t + ':' + row.pool;
    const horizon = (HORIZON_H[row.sig || 'IGNITION'] || 6) * 3600e3;
    if (cache[key] || Date.now() - row.t < horizon + 1800e3) continue;
    if (fetched >= MAX) break;
    cache[key] = await simulate(row);
    fetched++;
    await sleep(150);
  }
  fs.writeFileSync(DIR + '/replay-cache.json', JSON.stringify(cache));
  const done = rows.map((r) => ({ row: r, res: cache[r.t + ':' + r.pool] })).filter((x) => x.res && !x.res.skip);
  console.log(`shadow log: ${rows.length} observations | replayed: ${Object.keys(cache).length} (${fetched} new this run) | usable: ${done.length}\n`);
  if (!done.length) return;

  const BUCKETS = [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 3], [3, 99]];
  for (const cls of [...new Set(done.map((x) => x.res.cls))]) {
    const D = done.filter((x) => x.res.cls === cls);
    console.log(`=== ${cls} — ${D.length} replayed observations ===`);
    console.log('  edge      n    win%   meanPnL   triggers');
    let gate = null;
    for (const [lo, hi] of BUCKETS) {
      const B = D.filter((x) => x.row.edge >= lo && x.row.edge < hi);
      if (!B.length) continue;
      const pnls = B.map((x) => x.res.pnl);
      const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      const win = pnls.filter((x) => x > 0).length / pnls.length * 100;
      const trig = {};
      for (const x of B) trig[x.res.trigger] = (trig[x.res.trigger] || 0) + 1;
      console.log(`  ${(lo + '-' + (hi === 99 ? '+' : hi)).padEnd(8)} ${String(B.length).padStart(4)}   ${win.toFixed(0).padStart(3)}%   ${(mean >= 0 ? '+' : '') + mean.toFixed(2).padStart(6)}%   ${Object.entries(trig).map(([k, v]) => k + '×' + v).join(' ')}`);
      if (gate == null && mean > FRICTION && B.length >= 10) gate = lo;
    }
    console.log(gate != null
      ? `  → suggested entry gate for ${cls}: edge ≥ ${gate} (lowest bucket with n≥10 clearing ${FRICTION}% friction)`
      : `  → no bucket clears ${FRICTION}% friction with n≥10 yet — keep collecting`);
    console.log('');
  }
  // near-miss audit: would-have-been IGNITIONs blocked ONLY by surge or accel
  const nm = done.filter((x) => !x.row.sig && x.row.edge >= 1 && x.row.org >= 40 && x.row.path !== 'FREEFALL' && (x.row.sg < 1.25 || x.row.ac < 1.2));
  const fp = done.filter((x) => x.row.sig === 'IGNITION');
  if (nm.length >= 5) {
    const m = (a) => a.reduce((s, x) => s + x.res.pnl, 0) / a.length;
    console.log(`NEAR-MISS AUDIT: ${nm.length} edge≥1 rows blocked only by surge/accel → mean ${m(nm).toFixed(2)}%` +
      (fp.length ? ` | ${fp.length} full IGNITION passes → mean ${m(fp).toFixed(2)}%` : ''));
    console.log('  (if near-misses ≈ passes, surge/accel gates are deleting opportunity; if far worse, they are saving you)');
  }
})();
