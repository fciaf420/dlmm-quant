const test = require('node:test');
const assert = require('node:assert/strict');

const GATES = require('../gates.cjs');

function qualifiedCandleAnalysis(now = 2_000_000) {
  return {
    state: 'READY', coverageVerified: true,
    latestCompletedTs: Math.floor(now / 1000 / 300) * 300 - 300,
    recentVolumeRatio: 0.5, recentVolumeRatioRaw: 0.5, volumeBaselineHours: 1,
    events: { recovered: 2 }, lastRecoveryMinutes: 120,
    support15m: { ready: true }, activeEvent: null,
  };
}

test('EDGE uses the width that the recipe actually deploys', () => {
  const settingsEdge = GATES.edgeFrom(5.2, 30, 35);
  const recipeEdge = GATES.edgeFrom(5.2, 30, 12);
  assert.ok(settingsEdge > 1);
  assert.ok(recipeEdge < 1);
  assert.equal(GATES.ignition({ edge: recipeEdge, sg: 1.3, ac: 1.3, org: 80, path: 'CHOP', ageH: 100, ofi: 1 }), false);
});

test('deep accumulation depth uses geometric DLMM bins and never silently clamps', () => {
  const fine = GATES.downsideRange({ depthPct: 64, binStepBps: 25, maxBins: 140 });
  assert.deepEqual(
    { requiredBins: fine.requiredBins, totalBins: fine.totalBins, executable: fine.executable },
    { requiredBins: 410, totalBins: 411, executable: false }
  );

  const coarse = GATES.downsideRange({ depthPct: 64, binStepBps: 100, maxBins: 140 });
  assert.equal(coarse.requiredBins, 103);
  assert.equal(coarse.totalBins, 104);
  assert.equal(coarse.executable, true);
  assert.ok(Math.abs(coarse.effectiveDepthPct - 64.116) < 0.001);

  const coarser = GATES.downsideRange({ depthPct: 64, binStepBps: 200, maxBins: 140 });
  assert.equal(coarser.requiredBins, 52);
  assert.equal(coarser.totalBins, 53);
  assert.ok(Math.abs(coarser.effectiveDepthPct - 64.290) < 0.001);
});

test('BID ASK readiness requires fresh complete data and maps depth/allocation exactly', () => {
  const now = 2_000_000;
  const base = {
    ok: true,
    ts: now - 30_000,
    supportedSolPair: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPct: 20,
    orgBuy1h: 100,
    feeRate1h: 10,
    feeRate24h: 12,
    path: 'CHOP',
    ofi1h: 1.2,
    sigma: 100,
    ddHigh: 30,
    candleAnalysis: qualifiedCandleAnalysis(now),
  };
  const signal = GATES.bidAskSignal(base, now);
  assert.deepEqual(
    { state: signal.state, depthPct: signal.depthPct, allocation: signal.allocation },
    { state: 'READY', depthPct: 64, allocation: { bidAskPct: 60, spotPct: 40 } }
  );
  assert.equal(GATES.bidAskSignal({ ...base, ts: now - 120_001 }, now).state, 'WAIT');
  assert.equal(GATES.bidAskSignal({ ...base, ofi1h: null }, now).state, 'WAIT');
  assert.equal(GATES.bidAskSignal({ ...base, sigma: 0 }, now).state, 'WAIT');
  assert.equal(GATES.bidAskSignal({ ...base, supportedSolPair: false }, now).state, 'WAIT');
});

test('BID ASK remains WATCH when candle history is missing, unverified, or in a failed active cycle', () => {
  const now = 2_000_000;
  const base = {
    ok: true, ts: now - 30_000, supportedSolPair: true,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
    topHoldersPct: 20, orgBuy1h: 100, feeRate1h: 10, feeRate24h: 12,
    path: 'CHOP', ofi1h: 1.2, sigma: 100, ddHigh: 30,
  };
  assert.equal(GATES.bidAskSignal(base, now).state, 'WATCH');
  assert.equal(GATES.bidAskSignal({ ...base,
    candleAnalysis: { ...qualifiedCandleAnalysis(now), state: 'LIMITED', coverageVerified: false },
  }, now).state, 'WATCH');
  const failed = { ...qualifiedCandleAnalysis(now), activeEvent: { timedOut: true, recovering: false } };
  assert.equal(GATES.bidAskSignal({ ...base, candleAnalysis: failed }, now).state, 'WATCH');
  assert.equal(GATES.bidAskSignal({ ...base, candleAnalysis: qualifiedCandleAnalysis(now) }, now).state, 'READY');
});

test('known legacy trade labels stay TRADE and explicit BID_ASK stays ACCUM', () => {
  assert.equal(GATES.resolvePositionProfile({ label: 'IGNITION', mode: 'single', shape: 'spot' }), 'TRADE');
  assert.equal(GATES.resolvePositionProfile({ label: 'SQUEEZE', shape: 'bidask' }), 'TRADE');
  assert.equal(GATES.resolvePositionProfile({ label: 'BID_ASK', profile: 'ACCUM' }), 'ACCUM');
  assert.equal(GATES.resolvePositionProfile({ label: 'BID ASK' }), 'ACCUM');
  assert.equal(GATES.resolvePositionProfile({ label: 'MANUAL' }), 'TRADE_INFERRED');
});

test('accumulation exits only after persistent fee decay and hard distribution', () => {
  assert.equal(GATES.evaluateAccumLifecycle({ dataReady: false }), 'WAIT');
  assert.equal(GATES.evaluateAccumLifecycle({ dataReady: true, decay: false, flow: false }), 'ACCUMULATING');
  assert.equal(GATES.evaluateAccumLifecycle({ dataReady: true, decay: true, flow: false }), 'WAIT');
  assert.equal(GATES.evaluateAccumLifecycle({ dataReady: true, decay: false, flow: true }), 'WAIT');
  assert.equal(GATES.evaluateAccumLifecycle({ dataReady: true, decay: true, flow: true }), 'EXIT');
});

test('fee decay counts distinct valid snapshots and ignores missing metrics', () => {
  const row = { position: 'P', entryFeeRate: 10, entryFeeRate24h: 8 };
  let state = GATES.updateFeeDecay(null, row, { ok: true, ts: 1, feeRate: 4, ofi: 1, pc1: 0 });
  assert.equal(state.belowCount, 1);
  state = GATES.updateFeeDecay(state, row, { ok: true, ts: 1, feeRate: 4, ofi: 1, pc1: 0 });
  assert.equal(state.belowCount, 1);
  state = GATES.updateFeeDecay(state, row, { ok: true, ts: 2, feeRate: 4, ofi: 1, pc1: 0 });
  assert.equal(state.belowCount, 2);
  state = GATES.updateFeeDecay(state, row, { ok: true, ts: 3, feeRate: 4, ofi: null, pc1: -20 });
  assert.equal(state.belowCount, 2);
});

test('one pool can surface a trade and BID ASK signal independently', () => {
  const signals = GATES.collectSignals({
    now: 2_000_000,
    data: {
      ok: true, ts: 1_990_000, supportedSolPair: true,
      feeRate1h: 20, feeRate24h: 12, sigma: 30,
      surge: 1.4, accel: 1.3, org: 80, orgBuy1h: 100,
      path: 'CHOP', ageH: 100, ofi: 1, ofi6: 0.8,
      tvl: 200_000, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
      px: 100, low: 80, low6h: 90, dd: 30, binStepBps: 100,
      candleAnalysis: qualifiedCandleAnalysis(2_000_000),
    },
    config: {
      maxBins: 140, basingMaxFloor: 25,
      sizeIgnition: 0.3, sizeIgnitionHi: 0.4, sizeBasing: 0.3, sizeCarry: 0.4, sizeBidAsk: 1,
    },
  });
  assert.equal(signals.trade.label, 'IGNITION');
  assert.equal(signals.trade.profile, 'TRADE');
  assert.equal(signals.bidAsk.label, 'BID_ASK');
  assert.equal(signals.bidAsk.profile, 'ACCUM');
  assert.equal(signals.bidAsk.size, 1);
  assert.equal(signals.bidAsk.bidAskPct + signals.bidAsk.spotPct, 100);
});

test('an incomplete BID ASK registry row resumes before normal management', () => {
  assert.equal(GATES.needsDeploymentResume({ label: 'BID_ASK', profile: 'ACCUM', deploymentState: 'BIDASK_CONFIRMED', funded: false }), true);
  assert.equal(GATES.needsDeploymentResume({ label: 'BID_ASK', profile: 'ACCUM', deploymentState: 'COMPLETE', funded: true }), false);
  assert.equal(GATES.needsDeploymentResume({ label: 'IGNITION', profile: 'TRADE', funded: true }), false);
});

test('stale shared market inputs cannot create either automated signal profile', () => {
  const result = GATES.collectSignals({
    now: 500_000,
    data: {
      ok: true, ts: 300_000, supportedSolPair: true,
      feeRate1h: 100, feeRate24h: 12, sigma: 30, surge: 2, accel: 2,
      org: 90, orgBuy1h: 100, path: 'CHOP', ageH: 100, ofi: 1, ofi6: 0.5,
      tvl: 200_000, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 10 },
      px: 100, low: 80, low6h: 90, dd: 30, binStepBps: 100,
      candleAnalysis: qualifiedCandleAnalysis(2_000_000),
    },
    config: { maxBins: 140, basingMaxFloor: 25, sizeIgnition: .3, sizeIgnitionHi: .4, sizeBasing: .3, sizeCarry: .4, sizeBidAsk: 1 },
  });
  assert.equal(result.trade, null);
  assert.equal(result.bidAsk, null);
  assert.equal(result.bidAskStatus.state, 'WAIT');
});

test('execution precedence preserves existing trade signals over unlike BID ASK geometry', () => {
  const dataTs = Date.now();
  const bidAsk = { p: { address: 'BA' }, dataTs, sig: { label: 'BID_ASK', ready: true,
    candleQualification: { ready: true, checkedAtMs: dataTs }, candleAnalysis: qualifiedCandleAnalysis(dataTs), executable: true, range: { executable: true }, widthPct: 64.1, wantedPct: 64 } };
  const bidAskOvershoot = { p: { address: 'BA2' }, dataTs, sig: { label: 'BID_ASK', ready: true,
    candleQualification: { ready: true, checkedAtMs: dataTs }, candleAnalysis: qualifiedCandleAnalysis(dataTs), executable: true, range: { executable: true }, widthPct: 65, wantedPct: 64 } };
  const tradeA = { p: { address: 'A' }, sig: { label: 'IGNITION', widthPct: 10, wantedPct: 12 } };
  const tradeB = { p: { address: 'B' }, sig: { label: 'CARRY', widthPct: 30, wantedPct: 35 } };
  assert.equal(GATES.selectExecutionSignal([bidAsk, tradeA, tradeB]).p.address, 'B');
  assert.equal(GATES.selectExecutionSignal([bidAsk, bidAskOvershoot]).p.address, 'BA');
});

test('automated BID ASK selection deduplicates exact mints and keeps a capacity-fitting sibling', () => {
  assert.equal(typeof GATES.selectBidAskCandidates, 'function');
  const dataTs = Date.now();
  const trade = { p: { address: 'TRADE' }, sig: { label: 'IGNITION' } };
  const fine = { p: { address: 'FINE', token_x: { address: 'MintCase' } }, mint: 'MintCase',
    sig: { label: 'BID_ASK', ready: true, candleQualification: { ready: true, checkedAtMs: dataTs }, candleAnalysis: qualifiedCandleAnalysis(dataTs), executable: false, range: { executable: false } },
    bidAskStatus: { baseReady: true, ready: true, executable: false }, dataTs };
  const fit = { p: { address: 'FIT', token_x: { address: 'MintCase' } }, mint: 'MintCase',
    sig: { label: 'BID_ASK', ready: true, candleQualification: { ready: true, checkedAtMs: dataTs }, candleAnalysis: qualifiedCandleAnalysis(dataTs), executable: true, range: { executable: true } },
    bidAskStatus: { baseReady: true, ready: true, executable: true }, dataTs };
  const differentCase = { p: { address: 'CASE' }, mint: 'mintcase',
    sig: { label: 'BID_ASK', ready: true, candleQualification: { ready: true, checkedAtMs: dataTs }, candleAnalysis: qualifiedCandleAnalysis(dataTs), executable: true, range: { executable: true } },
    bidAskStatus: { baseReady: true, ready: true, executable: true }, dataTs };
  const selected = GATES.selectBidAskCandidates([trade, fine, fit, differentCase]);
  assert.deepEqual(selected.map((x) => x.p.address), ['FIT', 'CASE']);
  assert.equal(GATES.selectExecutionSignal([trade, fine, fit, differentCase]).p.address, 'TRADE');
  assert.equal(GATES.selectExecutionSignal([fine, fit, differentCase]).p.address, 'FIT');
});

test('final BID ASK selection revalidates the completed candle bucket at the decision clock', () => {
  const checkedAt = 2_000_000;
  const dataTs = 2_299_000;
  const candidate = {
    p: { address: 'BOUNDARY' }, mint: 'MintBoundary', dataTs,
    sig: { label: 'BID_ASK', ready: true, executable: true,
      candleAnalysis: qualifiedCandleAnalysis(checkedAt), range: { executable: true } },
    bidAskStatus: { baseReady: true, ready: true, executable: true, range: { executable: true } },
  };
  assert.deepEqual(GATES.selectBidAskCandidates([candidate], { nowMs: dataTs }), []);
  assert.deepEqual(GATES.selectBidAskCandidates([candidate], { nowMs: checkedAt }), []);
  const current = { ...candidate, dataTs: checkedAt };
  assert.deepEqual(GATES.selectBidAskCandidates([current], { nowMs: checkedAt }).map(x => x.p.address), ['BOUNDARY']);
});

test('BID ASK history refresh planning caps work and picks capacity-fit siblings by fee order', () => {
  assert.equal(typeof GATES.selectBidAskHistoryCandidates, 'function');
  const common = { baseReady: true, range: { executable: false } };
  const fine = { p: { address: 'FINE', token_x: { address: 'MintA' } }, mint: 'MintA',
    bidAskStatus: common, feeRate1h: 30 };
  const fit = { p: { address: 'FIT', token_x: { address: 'MintA' } }, mint: 'MintA',
    bidAskStatus: { baseReady: true, range: { executable: true } }, feeRate1h: 20 };
  const second = { p: { address: 'SECOND', token_x: { address: 'MintB' } }, mint: 'MintB',
    bidAskStatus: { baseReady: true, range: { executable: true } }, feeRate1h: 10 };
  const third = { p: { address: 'THIRD', token_x: { address: 'MintC' } }, mint: 'MintC',
    bidAskStatus: { baseReady: true, range: { executable: true } }, feeRate1h: 5 };
  assert.deepEqual(GATES.selectBidAskHistoryCandidates([fine, fit, second, third], { max: 2 })
    .map((x) => x.p.address), ['FIT', 'SECOND']);
});

test('BID ASK history planning prefers a fresh qualified capacity-fit sibling', () => {
  const now = Date.now();
  const first = { p: { address: 'FIRST' }, mint: 'MintZ', feeRate1h: 40,
    bidAskStatus: { baseReady: true, range: { executable: true } } };
  const qualified = { p: { address: 'QUALIFIED' }, mint: 'MintZ', feeRate1h: 10,
    bidAskStatus: { baseReady: true, ready: true, executable: true,
      range: { executable: true }, candleQualification: { ready: true, checkedAtMs: now },
      candleAnalysis: qualifiedCandleAnalysis(now) } };
  assert.deepEqual(GATES.selectBidAskHistoryCandidates([first, qualified], { max: 1, nowMs: now })
    .map((x) => x.p.address), ['QUALIFIED']);
});

test('BID ASK history planning rotates older or never-collected mints ahead of a recently collected prefix', () => {
  const now = Date.now();
  const recent = { p: { address: 'RECENT' }, mint: 'MintRecent', candleCollectedAt: now,
    bidAskStatus: { baseReady: true, range: { executable: true } } };
  const untouched = { p: { address: 'UNTOUCHED' }, mint: 'MintUntouched', candleCollectedAt: 0,
    bidAskStatus: { baseReady: true, range: { executable: true } } };
  assert.deepEqual(GATES.selectBidAskHistoryCandidates([recent, untouched], { max: 1, nowMs: now })
    .map((x) => x.p.address), ['UNTOUCHED']);
});

test('missing trade-only metrics never pass through JavaScript null coercion', () => {
  assert.equal(GATES.ignition({ edge: 2, sg: 2, ac: 2, org: 80, path: 'CHOP', ageH: 2, ofi: null }), false);
  assert.equal(GATES.basing({ path: 'BASING', ofi: null, org: 80, fr: 20, edge: 1 }), false);
  assert.equal(GATES.carry({ edge: 2, ofi6: null, org: 80, tvl: 200000, fr: 3, sigma: 20, ageH: 100,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, path: 'CHOP' }), false);
});

test('BID ASK accepts normalized authoritative audit fields', () => {
  const result = GATES.collectSignals({
    now: 2_000_000,
    data: {
      ok: true, ts: 1_990_000, supportedSolPair: true,
      feeRate1h: 10, feeRate24h: 12, sigma: 100,
      surge: null, accel: null, org: null, orgBuy1h: 100,
      path: 'CHOP', ageH: 100, ofi: 1.2, ofi6: null,
      tvl: 200_000,
      audit: { mint_authority_disabled: true, freeze_authority_disabled: true, top_holders_percentage: 20 },
      px: 100, low: 80, low6h: 90, dd: 30, binStepBps: 100,
      candleAnalysis: qualifiedCandleAnalysis(2_000_000),
    },
    config: { maxBins: 140, basingMaxFloor: 25, sizeIgnition: .3, sizeIgnitionHi: .4, sizeBasing: .3, sizeCarry: .4, sizeBidAsk: 1 },
  });
  assert.equal(result.trade, null);
  assert.equal(result.bidAsk?.label, 'BID_ASK');
});
