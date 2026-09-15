const test = require('node:test');
const assert = require('node:assert/strict');

const { refreshBidAskCandidates } = require('../bidask_runtime.cjs');

test('synchronous BID ASK refresh caps histories and re-evaluates selected siblings with full analysis', async () => {
  const calls = [];
  const analyses = new Map([
    ['FIT', { state: 'READY', latestCompletedTs: 100 }],
    ['SECOND', { state: 'WATCH', latestCompletedTs: 100 }],
  ]);
  const diagnostics = {
    async collect(candidates) { calls.push(candidates.map((c) => c.address)); },
    getAnalysis(address) { return analyses.get(address) || null; },
  };
  const evaluated = [];
  const collectSignals = ({ data, config, now }) => {
    evaluated.push({ address: data.address, analysis: data.candleAnalysis, config, now });
    return { bidAsk: data.candleAnalysis?.state === 'READY' ? { label: 'BID_ASK' } : null,
      bidAskStatus: { ready: data.candleAnalysis?.state === 'READY' } };
  };
  const candidates = [
    { address: 'FINE', mint: 'MintA', bidAskStatus: { baseReady: true, range: { executable: false } }, data: { address: 'FINE' } },
    { address: 'FIT', mint: 'MintA', bidAskStatus: { baseReady: true, range: { executable: true } }, data: { address: 'FIT' } },
    { address: 'SECOND', mint: 'MintB', bidAskStatus: { baseReady: true, range: { executable: true } }, data: { address: 'SECOND' } },
    { address: 'THIRD', mint: 'MintC', bidAskStatus: { baseReady: true, range: { executable: true } }, data: { address: 'THIRD' } },
  ];
  const out = await refreshBidAskCandidates(candidates, {
    diagnostics, collectSignals, config: { marker: true }, nowMs: () => 123,
  });
  assert.deepEqual(calls, [['FIT', 'SECOND']]);
  assert.deepEqual(out.selected.map((c) => c.address), ['FIT', 'SECOND']);
  assert.deepEqual(out.refreshed.map((c) => c.address), ['FIT', 'SECOND']);
  assert.equal(evaluated.length, 2);
  assert.equal(evaluated[0].analysis.state, 'READY');
  assert.deepEqual(evaluated[0].config, { marker: true });
});

test('BID ASK history refresh rotates a three mint board across scans', async () => {
  const calls = [];
  const diagnostics = {
    async collect(rows) { calls.push(rows.map(row => row.address)); },
    getAnalysis(address) { return { state: 'READY', latestCompletedTs: 100, address }; },
  };
  const collectSignals = ({ data }) => ({
    bidAsk: { label: 'BID_ASK', ready: true, executable: true, candleAnalysis: data.candleAnalysis },
    bidAskStatus: { baseReady: true, ready: true, executable: true, range: { executable: true } },
  });
  const candidates = ['FIRST', 'SECOND', 'THIRD'].map((address, index) => ({
    address, mint: `Mint${index + 1}`, data: { address },
    bidAskStatus: { baseReady: true, range: { executable: true } }, candleCollectedAt: 0,
  }));

  const first = await refreshBidAskCandidates(candidates, {
    diagnostics, collectSignals, max: 2, nowMs: () => 123,
  });
  assert.deepEqual(first.selected.map(candidate => candidate.address), ['FIRST', 'SECOND']);
  assert.deepEqual(first.refreshed.map(candidate => candidate.address), ['FIRST', 'SECOND']);

  // The first batch has now been attempted. The next scan must give the
  // untouched third mint a history slot instead of replaying the prefix.
  for (const candidate of first.selected) candidate.candleCollectedAt = 1;
  const second = await refreshBidAskCandidates(candidates, {
    diagnostics, collectSignals, max: 2, nowMs: () => 123,
  });
  assert.deepEqual(second.selected.map(candidate => candidate.address), ['THIRD', 'FIRST']);
  assert.deepEqual(second.refreshed.map(candidate => candidate.address), ['THIRD', 'FIRST']);
  assert.deepEqual(calls, [['FIRST', 'SECOND'], ['THIRD', 'FIRST']]);
  assert.equal(second.refreshed[0].evaluated.bidAsk.label, 'BID_ASK');
});
