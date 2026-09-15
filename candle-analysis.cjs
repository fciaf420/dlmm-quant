#!/usr/bin/env node
'use strict';

// Public, read-only candle diagnostic. It deliberately imports neither config.cjs
// nor wallet code, so running it cannot load a key or submit a transaction.
const { createCandleHistoryLoader } = require('./candle_analysis.cjs');

const DATAPI = 'https://dlmm.datapi.meteora.ag';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

async function main(deps = {}) {
  const argv = deps.argv || process.argv.slice(2);
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  const fetchImpl = deps.fetchImpl || fetch;
  const nowMs = deps.nowMs || (() => Date.now());
  const pool = argv.find((arg) => !String(arg).startsWith('--'));
  if (!pool || argv.includes('--help')) {
    out('usage: node candle-analysis.cjs <pool-address> [--json]');
    return pool ? 0 : 2;
  }

  const fetchJson = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : '?'} from Meteora data API`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const meta = await fetchJson(`${DATAPI}/pools/${encodeURIComponent(pool)}`);
    const tokenX = meta && meta.token_x;
    const tokenY = meta && meta.token_y;
    if (!tokenX || !tokenY || tokenX.address === WRAPPED_SOL || tokenY.address !== WRAPPED_SOL) {
      err('unsupported orientation: candle analysis requires a non-SOL token X and wrapped SOL token Y');
      return 2;
    }
    const loader = createCandleHistoryLoader({ fetchJson, nowMs, maxPools: 1 });
    const history = await loader.load(pool, { poolCreatedAt: meta.created_at });
    const analysis = history.analysis;
    const payload = {
      pool,
      name: meta.name || pool,
      pair: `${tokenX.symbol || tokenX.address}/${tokenY.symbol || 'SOL'}`,
      createdAt: meta.created_at == null ? null : meta.created_at,
      analysis,
    };
    if (argv.includes('--json')) {
      out(JSON.stringify(payload, null, 2));
      return 0;
    }

    out(`${payload.name} (${payload.pair})`);
    out(`CANDLE EVIDENCE ${analysis.state}: ${analysis.historyHours}h, ${analysis.completedCandles}/${analysis.expectedAvailableCandles || analysis.expectedCandles} completed 5m candles`);
    if (analysis.state === 'WAIT') {
      out(`data unavailable: ${analysis.reason}; event statistics suppressed`);
      out(analysis.note);
      return 0;
    }
    const e = analysis.events;
    out(`pullbacks: ${e.total} total | ${e.recovered} recovered within 6h | ${e.timedOut} timed out | ${e.pending} pending`);
    out(e.matured === 0 ? 'matured recovery fraction: n/a (no completed outcomes)'
      : `matured recovery fraction: ${e.recovered}/${e.matured} (${e.recoveryRatePct}%) — descriptive, not a win probability`);
    out(`median max close drop within outcome window: ${analysis.medianDepthPct == null ? 'n/a' : analysis.medianDepthPct + '%'}`);
    out(`median recovery from trigger: ${analysis.medianRecoveryMinutes == null ? 'n/a' : analysis.medianRecoveryMinutes + ' min'}`);
    out(`current drawdown from ${analysis.drawdownReference}: ${analysis.currentDrawdownPct}%`);
    out(`last-hour total pool volume / prior hourly median: ${analysis.recentVolumeRatio == null ? 'n/a' : analysis.recentVolumeRatio + 'x'} (${analysis.volumeBaselineHours} baseline hours)`);
    out(`${analysis.note}; default event = 5% close drawdown, 80% recovery, 6h deadline.`);
    return 0;
  } catch (e) {
    err(`candle analysis failed: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };
