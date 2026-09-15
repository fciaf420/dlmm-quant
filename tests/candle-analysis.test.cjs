const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeCandleHistory,
  createCandleHistoryLoader,
  qualifyBidAskCandle,
} = require('../candle_analysis.cjs');
const { main: candleCliMain } = require('../candle-analysis.cjs');

const STEP = 300;
const NOW_SEC = 1_800_000_000;
const LAST_CLOSED = NOW_SEC - STEP;

function candle(timestamp, close = 100, volume = 10) {
  return { timestamp, open: close, high: close, low: close, close, volume };
}

function fullDay(mutator) {
  const first = LAST_CLOSED - 287 * STEP;
  const rows = Array.from({ length: 288 }, (_, i) => candle(first + i * STEP));
  if (mutator) mutator(rows);
  return rows;
}

test('uses only complete, continuous 5m candles and deduplicates inclusive boundaries', () => {
  const rows = fullDay();
  rows.push({ ...rows[72] });
  rows.push(candle(NOW_SEC, 150, 999)); // current forming bucket
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'READY');
  assert.equal(out.completedCandles, 288);
  assert.equal(out.coveragePct, 100);
  assert.equal(out.gapCount, 0);
  assert.equal(out.latestCompletedTs, LAST_CLOSED);
  assert.equal(out.currentDrawdownPct, 0);
});

test('ignores malformed forming/future candles but rejects malformed completed candles and millisecond timestamps', () => {
  const rows = fullDay();
  rows.push({ timestamp: NOW_SEC, open: null, high: null, low: null, close: null, volume: null });
  rows.push({ timestamp: NOW_SEC + STEP, open: 0, high: 0, low: 0, close: 0, volume: -1 });
  assert.equal(analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 }).state, 'READY');

  const malformed = fullDay();
  malformed[20] = { ...malformed[20], close: null };
  const bad = analyzeCandleHistory(malformed, { nowMs: NOW_SEC * 1000 });
  assert.equal(bad.state, 'WAIT');
  assert.equal(bad.reason, 'invalid-candles');

  const millis = fullDay();
  millis[20] = { ...millis[20], timestamp: millis[20].timestamp * 1000 };
  assert.equal(analyzeCandleHistory(millis, { nowMs: NOW_SEC * 1000 }).reason, 'invalid-candles');
});

test('rejects conflicting duplicate completed candles', () => {
  const rows = fullDay();
  rows.push({ ...rows[50], close: 99, low: 99 });
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'WAIT');
  assert.equal(out.reason, 'invalid-candles');
  assert.equal(out.conflictCount, 1);
});

test('returns WAIT and suppresses event metrics when completed history has a gap', () => {
  const rows = fullDay();
  rows.splice(100, 1);
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'WAIT');
  assert.equal(out.reason, 'gapped-history');
  assert.equal(out.gapCount, 1);
  assert.equal(out.events, null);
  assert.equal(out.medianDepthPct, null);
  assert.equal(out.recentVolumeRatio, null);
});

test('accepts all available candles for a known two-hour-old pool as limited evidence', () => {
  const createdAt = NOW_SEC - 2 * 3600;
  const rows = Array.from({ length: 24 }, (_, i) => candle(createdAt + i * STEP));
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000, poolCreatedAt: createdAt * 1000 });
  assert.equal(out.state, 'LIMITED');
  assert.equal(out.historyBasis, 'known pool age');
  assert.equal(out.historyHours, 2);
  assert.equal(out.coveragePct, 100);
  assert.equal(out.fullDayCoveragePct, 8.3);
  assert.equal(out.confidence, 'limited history');
  assert.equal(out.volumeBaselineHours, 1);
  assert.equal(out.drawdownReference, 'available-history completed-close high');
});

test('keeps a young unresolved pullback pending until six real hours have elapsed', () => {
  const createdAt = NOW_SEC - 6 * 3600;
  const rows = Array.from({ length: 72 }, (_, i) => candle(createdAt + i * STEP));
  rows[1] = candle(rows[1].timestamp, 90);
  for (let i = 2; i < rows.length; i++) rows[i] = candle(rows[i].timestamp, 90);
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000, poolCreatedAt: createdAt });
  assert.equal(out.state, 'LIMITED');
  assert.equal(out.events.pending, 1);
  assert.equal(out.events.timedOut, 0);
  assert.equal(out.events.matured, 0);
  assert.equal(out.events.recoveryRatePct, null);
});

test('rejects a two-hour response for a mature pool as truncated history', () => {
  const first = LAST_CLOSED - 23 * STEP;
  const rows = Array.from({ length: 24 }, (_, i) => candle(first + i * STEP));
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000, poolCreatedAt: NOW_SEC - 48 * 3600 });
  assert.equal(out.state, 'WAIT');
  assert.equal(out.reason, 'insufficient-history');
  assert.equal(out.events, null);
});

test('labels contiguous short history as unverified when pool creation is unavailable', () => {
  const first = LAST_CLOSED - 23 * STEP;
  const rows = Array.from({ length: 24 }, (_, i) => candle(first + i * STEP));
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'LIMITED');
  assert.equal(out.confidence, 'unverified start');
  assert.equal(out.coveragePct, null);
  assert.equal(out.historyHours, 2);
  assert.equal(out.coverageVerified, false);
  assert.equal(qualifyBidAskCandle(out, { nowMs: NOW_SEC * 1000 }).gates.history, false);
});

test('counts distinct recovered, timed-out, and right-censored pullbacks without lookahead', () => {
  const rows = fullDay((r) => {
    // Event 1: trigger at -6%, trough -10%, recover 80% of the peak-to-trough in 25m.
    r[20] = candle(r[20].timestamp, 94);
    r[21] = candle(r[21].timestamp, 90);
    r[22] = candle(r[22].timestamp, 95);
    r[23] = candle(r[23].timestamp, 95);
    r[24] = candle(r[24].timestamp, 95);
    r[25] = candle(r[25].timestamp, 98);
    // Event 2: prolonged crash. It times out after 6h but does not re-arm until a late recovery.
    for (let i = 100; i < 180; i++) r[i] = candle(r[i].timestamp, i === 101 ? 80 : 90);
    r[180] = candle(r[180].timestamp, 96);
    // Event 3: too recent to judge at the right edge of the sample.
    for (let i = 280; i < 288; i++) r[i] = candle(r[i].timestamp, 94);
  });
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.state, 'READY');
  assert.deepEqual(out.events, {
    total: 3,
    matured: 2,
    recovered: 1,
    timedOut: 1,
    pending: 1,
    recoveryRatePct: 50,
  });
  assert.equal(out.medianDepthPct, 15);
  assert.equal(out.medianRecoveryMinutes, 25);
});

test('does not count one prolonged crash as repeated pullbacks after timeout', () => {
  const rows = fullDay((r) => {
    for (let i = 20; i < r.length; i++) r[i] = candle(r[i].timestamp, 90);
  });
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.deepEqual(out.events, {
    total: 1,
    matured: 1,
    recovered: 0,
    timedOut: 1,
    pending: 0,
    recoveryRatePct: 0,
  });
});

test('classifies an unresolved event at the exact six-hour boundary as timed out', () => {
  const rows = fullDay((r) => {
    for (let i = 215; i < r.length; i++) r[i] = candle(r[i].timestamp, 90);
  });
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.events.timedOut, 1);
  assert.equal(out.events.pending, 0);
});

test('reports a unitless recent total-volume ratio without calling it organic flow', () => {
  const rows = fullDay((r) => {
    for (let i = 276; i < 288; i++) r[i] = candle(r[i].timestamp, 100, 20);
  });
  const out = analyzeCandleHistory(rows, { nowMs: NOW_SEC * 1000 });
  assert.equal(out.recentVolumeRatio, 2);
  assert.equal(out.volumeKind, 'total pool volume');
});

function qualifyingHistory({ active = true, support = true, recentVolume = 10 } = {}) {
  return fullDay((r) => {
    r[200] = candle(r[200].timestamp, 94);
    r[201] = candle(r[201].timestamp, 90);
    r[202] = candle(r[202].timestamp, 98);
    r[270] = candle(r[270].timestamp, 94);
    r[271] = candle(r[271].timestamp, 90);
    r[272] = candle(r[272].timestamp, 98);
    if (active) {
      r[279] = candle(r[279].timestamp, 100);
      r[280] = candle(r[280].timestamp, 94);
      r[281] = candle(r[281].timestamp, 90);
      r[282] = candle(r[282].timestamp, support ? 91 : 89);
      r[283] = candle(r[283].timestamp, 92);
      r[284] = candle(r[284].timestamp, 92);
      r[285] = candle(r[285].timestamp, support ? 92 : 89);
      r[286] = candle(r[286].timestamp, 93);
      r[287] = candle(r[287].timestamp, 94);
    }
    for (let i = 276; i < 288; i++) r[i].volume = recentVolume;
  });
}

test('qualifies repeated recent recoveries with sustained volume and two closed 15m support comparisons', () => {
  const analysis = analyzeCandleHistory(qualifyingHistory(), { nowMs: NOW_SEC * 1000 });
  assert.equal(analysis.events.recovered, 2);
  assert.equal(analysis.lastRecoveryMinutes, 75);
  assert.equal(analysis.activeEvent.timedOut, false);
  assert.equal(analysis.activeEvent.recovering, true);
  assert.equal(analysis.support15m.comparisonsPassed, 2);
  const qualified = qualifyBidAskCandle(analysis, { nowMs: NOW_SEC * 1000 });
  assert.equal(qualified.ready, true);
  assert.equal(qualified.checkedAtMs, NOW_SEC * 1000);
  assert.deepEqual(qualified.gates, {
    fresh: true, history: true, volume: true, repeatedRecoveries: true,
    recentRecovery: true, support: true, cycle: true,
  });
});

test('keeps one support comparison, collapsed volume, stale evidence, and failed active cycles in WATCH', () => {
  const weakSupport = analyzeCandleHistory(qualifyingHistory({ support: false }), { nowMs: NOW_SEC * 1000 });
  assert.equal(weakSupport.support15m.comparisonsPassed, 1);
  assert.equal(qualifyBidAskCandle(weakSupport, { nowMs: NOW_SEC * 1000 }).gates.support, false);

  const lowVolume = analyzeCandleHistory(qualifyingHistory({ recentVolume: 4 }), { nowMs: NOW_SEC * 1000 });
  assert.equal(lowVolume.recentVolumeRatio, 0.4);
  assert.equal(qualifyBidAskCandle(lowVolume, { nowMs: NOW_SEC * 1000 }).gates.volume, false);

  const stale = qualifyBidAskCandle(weakSupport, { nowMs: (NOW_SEC + STEP) * 1000 });
  assert.equal(stale.gates.fresh, false);

  const failedRows = qualifyingHistory();
  for (let i = 200; i < 288; i++) failedRows[i] = candle(failedRows[i].timestamp, i === 200 ? 94 : 90);
  const failed = analyzeCandleHistory(failedRows, { nowMs: NOW_SEC * 1000 });
  assert.equal(failed.activeEvent.timedOut, true);
  assert.equal(qualifyBidAskCandle(failed, { nowMs: NOW_SEC * 1000 }).gates.cycle, false);
});

test('a recently completed recovery can qualify while waiting for the next dip', () => {
  const analysis = analyzeCandleHistory(qualifyingHistory({ active: false }), { nowMs: NOW_SEC * 1000 });
  assert.equal(analysis.activeEvent, null);
  assert.equal(qualifyBidAskCandle(analysis, { nowMs: NOW_SEC * 1000 }).ready, true);
});

test('volume gate uses the unrounded ratio at the exact 0.5 boundary', () => {
  const base = analyzeCandleHistory(qualifyingHistory(), { nowMs: NOW_SEC * 1000 });
  assert.equal(qualifyBidAskCandle({ ...base, recentVolumeRatio: 0.5,
    recentVolumeRatioRaw: 0.4999 }, { nowMs: NOW_SEC * 1000 }).gates.volume, false);
  assert.equal(qualifyBidAskCandle({ ...base, recentVolumeRatio: 0.5,
    recentVolumeRatioRaw: 0.5 }, { nowMs: NOW_SEC * 1000 }).gates.volume, true);
});

test('history loader backfills four bounded windows, caches a bucket, then fetches only the tail', async () => {
  let now = NOW_SEC;
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const start = Number(u.searchParams.get('start_time'));
    const end = Number(u.searchParams.get('end_time'));
    const data = [];
    for (let ts = start; ts <= end; ts += STEP) data.push(candle(ts));
    return { data };
  };
  const loader = createCandleHistoryLoader({ fetchJson, nowMs: () => now * 1000, maxPools: 2 });
  const first = await loader.load('POOL');
  assert.equal(first.analysis.state, 'READY');
  assert.equal(calls.length, 4);
  await loader.load('POOL');
  assert.equal(calls.length, 4);
  now += STEP;
  const next = await loader.load('POOL');
  assert.equal(next.analysis.state, 'READY');
  assert.equal(calls.length, 5);
  assert.equal(next.analysis.latestCompletedTs, now - STEP);
});

test('history loader turns a failed backfill into WAIT instead of reusing numeric evidence', async () => {
  let calls = 0;
  const loader = createCandleHistoryLoader({
    nowMs: () => NOW_SEC * 1000,
    fetchJson: async () => {
      calls++;
      if (calls === 3) throw new Error('upstream');
      return { data: [] };
    },
  });
  const out = await loader.load('POOL');
  assert.equal(out.analysis.state, 'WAIT');
  assert.equal(out.analysis.reason, 'fetch-failed');
  assert.equal(out.analysis.events, null);
});

test('history loader can seed a prior worker snapshot and fetch one incremental tail window', async () => {
  let now = NOW_SEC;
  const prior = fullDay();
  now += STEP;
  const calls = [];
  const loader = createCandleHistoryLoader({
    nowMs: () => now * 1000,
    fetchJson: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) data.push(candle(ts));
      return { data };
    },
  });
  loader.seed('POOL', prior);
  const out = await loader.load('POOL');
  assert.equal(out.analysis.state, 'READY');
  assert.equal(calls.length, 1);
  assert.equal(out.analysis.latestCompletedTs, now - STEP);
});

test('history loader prepends only the three missing windows when seeded with the current six hours', async () => {
  const sixHourStart = NOW_SEC - 6 * 3600;
  const recent = [];
  for (let ts = sixHourStart; ts < NOW_SEC; ts += STEP) recent.push(candle(ts));
  const calls = [];
  const loader = createCandleHistoryLoader({
    nowMs: () => NOW_SEC * 1000,
    fetchJson: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) data.push(candle(ts));
      return { data };
    },
  });
  loader.seed('POOL', recent, { poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000 });
  const out = await loader.load('POOL', { poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000 });
  assert.equal(out.analysis.state, 'READY');
  assert.equal(calls.length, 3);
});

test('history loader repairs an omitted leading zero-volume candle using real API context', async () => {
  const first = LAST_CLOSED - 287 * STEP;
  const calls = [];
  const loader = createCandleHistoryLoader({
    nowMs: () => NOW_SEC * 1000,
    fetchJson: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) {
        if (ts === first && start === first) continue;
        data.push(candle(ts, 100, ts === first ? 0 : 10));
      }
      return { data };
    },
  });
  const out = await loader.load('POOL', { poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000 });
  assert.equal(calls.length, 5);
  assert.equal(out.analysis.state, 'READY');
  assert.equal(out.candles.length, 288);
  assert.equal(out.candles[0].timestamp, first);
  assert.equal(out.candles[0].volume, 0);
});

test('history loader never fabricates a missing leading candle when the context query omits it', async () => {
  const first = LAST_CLOSED - 287 * STEP;
  let calls = 0;
  const loader = createCandleHistoryLoader({
    nowMs: () => NOW_SEC * 1000,
    fetchJson: async (url) => {
      calls++;
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) {
        if (ts !== first) data.push(candle(ts));
      }
      return { data };
    },
  });
  const out = await loader.load('POOL', { poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000 });
  assert.equal(calls, 5);
  assert.equal(out.analysis.state, 'WAIT');
  assert.equal(out.analysis.reason, 'insufficient-history');
  assert.equal(out.candles.some((row) => row.timestamp === first), false);
});

test('history loader coalesces concurrent requests for the same pool and candle bucket', async () => {
  let calls = 0;
  const loader = createCandleHistoryLoader({
    nowMs: () => NOW_SEC * 1000,
    fetchJson: async (url) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) data.push(candle(ts));
      return { data };
    },
  });
  const [a, b] = await Promise.all([loader.load('POOL'), loader.load('POOL')]);
  assert.equal(a.analysis.state, 'READY');
  assert.equal(b.analysis.state, 'READY');
  assert.equal(calls, 4);
});

test('standalone CLI uses only public pool metadata and OHLCV endpoints', async () => {
  const calls = [];
  const output = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (!u.pathname.endsWith('/ohlcv')) {
      return { ok: true, json: async () => ({
        address: 'POOL', name: 'TOKEN-SOL', created_at: (NOW_SEC - 48 * 3600) * 1000,
        token_x: { address: 'TOKEN', symbol: 'TOKEN' },
        token_y: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      }) };
    }
    const start = Number(u.searchParams.get('start_time'));
    const end = Number(u.searchParams.get('end_time'));
    const data = [];
    for (let ts = start; ts <= end; ts += STEP) data.push(candle(ts));
    return { ok: true, json: async () => ({ data }) };
  };
  const code = await candleCliMain({ argv: ['POOL', '--json'], fetchImpl,
    nowMs: () => NOW_SEC * 1000, out: (line) => output.push(line), err: () => {} });
  assert.equal(code, 0);
  assert.equal(calls.length, 5);
  assert.equal(calls.some((url) => url.includes('jup.ag')), false);
  const result = JSON.parse(output.join('\n'));
  assert.equal(result.analysis.state, 'READY');
  assert.equal(result.pair, 'TOKEN/SOL');
});

test('standalone CLI rejects a pool that is not token-X and wrapped-SOL-Y before candle fetches', async () => {
  const calls = [];
  const errors = [];
  const code = await candleCliMain({ argv: ['POOL'], nowMs: () => NOW_SEC * 1000,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ address: 'POOL', name: 'TOKEN-USDC',
        token_x: { address: 'TOKEN', symbol: 'TOKEN' }, token_y: { address: 'USDC', symbol: 'USDC' } }) };
    }, out: () => {}, err: (line) => errors.push(line) });
  assert.equal(code, 2);
  assert.equal(calls.length, 1);
  assert.match(errors.join('\n'), /token X.*wrapped SOL token Y/i);
});
