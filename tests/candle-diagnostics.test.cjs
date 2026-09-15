const test = require('node:test');
const assert = require('node:assert/strict');

const { createCandleDiagnostics } = require('../candle_diagnostics.cjs');

const STEP = 300;
const NOW_SEC = 1_800_000_000;

function rows(hours = 6) {
  const result = [];
  for (let ts = NOW_SEC - hours * 3600; ts < NOW_SEC; ts += STEP) {
    result.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  }
  return result;
}

test('candidate diagnostics reuse six-hour candles and cap a batch at two pools', async () => {
  const calls = [];
  const diagnostics = createCandleDiagnostics({
    nowMs: () => NOW_SEC * 1000,
    maxPerBatch: 2,
    fetchJson: async (url) => {
      calls.push(url);
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) {
        data.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
      }
      return { data };
    },
  });
  const candidates = ['A', 'B', 'C'].map(address => ({
    address,
    poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000,
    recentCandles: rows(),
  }));
  await diagnostics.collect(candidates);
  assert.equal(calls.length, 6);
  assert.equal(diagnostics.get('A').state, 'READY');
  assert.equal(diagnostics.get('A').coverageVerified, true);
  assert.equal(diagnostics.get('B').state, 'READY');
  assert.equal(diagnostics.get('C').state, 'NOT_COLLECTED');
  assert.equal(diagnostics.getAnalysis('A').state, 'READY');
  assert.equal(diagnostics.getAnalysis('A').events.total, 0);

  await diagnostics.collect(candidates);
  assert.equal(diagnostics.get('C').state, 'READY');
  assert.equal(calls.length, 9);
});

test('scheduled diagnostics make no request on the caller critical path', async () => {
  let calls = 0;
  const diagnostics = createCandleDiagnostics({
    nowMs: () => NOW_SEC * 1000,
    maxPerBatch: 1,
    fetchJson: async (url) => {
      calls++;
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) {
        data.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
      }
      return { data };
    },
  });
  const pending = diagnostics.schedule([{ address: 'A',
    poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000, recentCandles: rows() }]);
  assert.equal(calls, 0);
  await pending;
  assert.equal(calls, 3);
});

test('cached diagnostics suppress numeric evidence after the next completed bucket is missing', async () => {
  let now = NOW_SEC;
  const diagnostics = createCandleDiagnostics({
    nowMs: () => now * 1000,
    maxPerBatch: 1,
    fetchJson: async (url) => {
      const u = new URL(url);
      const start = Number(u.searchParams.get('start_time'));
      const end = Number(u.searchParams.get('end_time'));
      const data = [];
      for (let ts = start; ts <= end; ts += STEP) {
        data.push({ timestamp: ts, open: 1, high: 1, low: 1, close: 1, volume: 1 });
      }
      return { data };
    },
  });
  await diagnostics.collect([{ address: 'A',
    poolCreatedAt: (NOW_SEC - 48 * 3600) * 1000, recentCandles: rows() }]);
  assert.equal(diagnostics.get('A').state, 'READY');
  now += STEP;
  assert.deepEqual(diagnostics.get('A'), {
    state: 'STALE', reason: 'stale-history', latestCompletedTs: NOW_SEC - STEP,
    collectedAt: NOW_SEC * 1000,
  });
});
