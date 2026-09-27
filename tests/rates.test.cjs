const test = require('node:test');
const assert = require('node:assert/strict');

const RATES = require('../rates.cjs');
const GATES = require('../gates.cjs');

// Live NEARPAD-SOL numbers (2026-09-27): pool 1.68h old; fee_tvl_ratio 1h 6.1257 and
// 2h = 4h = 12h = 24h = 6.375 - every window past the pool's age is the same
// since-creation total.
const NEARPAD_AGE_H = 1.68;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('window rates divide by the hours the window actually covered', () => {
  assert.ok(close(RATES.windowPerDay(6.375, 24, NEARPAD_AGE_H), 6.375 * 24 / 1.68));   // ~91.07%/day, not 6.4
  assert.ok(close(RATES.windowPerDay(6.375, 24, NEARPAD_AGE_H), 91.0714285714));
  assert.ok(close(RATES.windowPerDay(6.1257, 1, NEARPAD_AGE_H), 6.1257 * 24));          // full 1h window: unchanged
  // mature pool and unknown age reproduce the pre-fix numbers exactly
  assert.equal(RATES.windowPerDay(6.375, 24, 100), 6.375);
  assert.equal(RATES.windowPerDay(6.375, 24, null), 6.375);
  assert.equal(RATES.windowPerDay(2, 1, null), 48);
  // a 20-minute pool's 1h window holds 20 minutes of fees
  assert.ok(close(RATES.windowPerDay(1, 1, 1 / 3), 72));
  // minutes-old pools floor at 15 minutes of coverage
  assert.equal(RATES.windowPerDay(1, 1, 2 / 60), 96);
  // missing metric stays missing (callers rely on null, not 0)
  assert.equal(RATES.windowPerDay(null, 24, 5), null);
  assert.equal(RATES.windowPerDay(undefined, 1, 5), null);
});

test('pool age reads datapi ms and tolerates seconds; stages and the launch hold', () => {
  const now = 1_790_517_000_000;
  const createdMs = now - 1.68 * 3600e3;
  assert.ok(close(RATES.poolAgeHours(createdMs, now), 1.68));
  assert.ok(close(RATES.poolAgeHours(createdMs / 1000, now), 1.68));
  assert.equal(RATES.poolAgeHours(null, now), null);
  assert.equal(RATES.poolAgeHours(now + 60e3, now), null);     // clock skew: unknown, not negative
  assert.equal(RATES.poolAgeStage(0.5), 'LAUNCH');
  assert.equal(RATES.poolAgeStage(NEARPAD_AGE_H), 'YOUNG');
  assert.equal(RATES.poolAgeStage(30), 'MATURE');
  assert.equal(RATES.poolAgeStage(null), 'UNKNOWN');
  assert.equal(RATES.launchHeld(0.5), true);
  assert.equal(RATES.launchHeld(1), false);
  assert.equal(RATES.launchHeld(null), false);                 // unknown age keeps old behavior
});

test('accel compares hourly paces over the time each window covered', () => {
  const v30 = 100000, v4 = 465000;
  const expected = (100000 / 0.5) / (465000 / 1.68);
  assert.ok(close(RATES.accelFrom(v30, v4, NEARPAD_AGE_H), expected));
  const old = (v30 * 48) / Math.max(v4 * 6, 1);
  assert.ok(old / RATES.accelFrom(v30, v4, NEARPAD_AGE_H) > 2.3, 'fixed 4h divisor inflated accel ~2.4x');
  // mature pool: identical to the old formula
  assert.ok(close(RATES.accelFrom(v30, v4, 100), old));
  assert.equal(RATES.accelFrom(null, v4, 100), null);
});

test('edge uses LP-net fees and IL = s^2/4W: exactly 5/9 of the old edge on identical inputs', () => {
  const oldEdge = (fr, s, W) => ((fr * 0.9) / s) / (1.3 * s / (8 * W));
  for (const [fr, s, W] of [[20, 30, 11.26], [147, 459, 12], [5.2, 30, 35]]) {
    const ratio = GATES.edgeFrom(fr, s, W) / oldEdge(fr, s, W);
    assert.ok(close(ratio, 5 / 9, 1e-9), `ratio ${ratio}`);
  }
  assert.ok(close(RATES.LEGACY_EDGE_TO_V1, 0.5555555556, 1e-9));
  // breakeven: LP fee/day that exactly covers modeled IL of a +-W band
  assert.ok(close(RATES.breakevenFeePerDay(40, 20), 1600 / 80));
  assert.equal(RATES.LP_FEE_SHARE, 1);
});

test('legacy baselines are rescaled by pool age at record time, exactly once', () => {
  const created = 1_790_511_431_000;
  const openedAt = new Date(created + 1.68 * 3600e3).toISOString();
  assert.ok(close(RATES.legacyWindowRate(6.375, 24, openedAt, created, undefined), 91.0714285714));
  assert.ok(close(RATES.legacyWindowRate(6.375, 24, created + 1.68 * 3600e3, created / 1000, undefined), 91.0714285714));
  assert.equal(RATES.legacyWindowRate(91.07, 24, openedAt, created, RATES.FEE_BASIS), 91.07);          // stamped: untouched
  assert.equal(RATES.legacyWindowRate(6.375, 24, created + 30 * 3600e3, created, undefined), 6.375);  // mature at record
  assert.equal(RATES.legacyWindowRate(6.375, 24, openedAt, null, undefined), 6.375);                 // pool age unknown
  assert.equal(RATES.legacyWindowRate(50, 1, created + 0.5 * 3600e3, created, undefined), 100);     // 1h window at 30m old
  assert.equal(RATES.legacyWindowRate(0, 24, openedAt, created, undefined), null);
});

test('a rescaled legacy normal re-arms FEE-DECAY on a young-pool position', () => {
  const created = 1_790_511_431_000;
  const row = { position: 'P', entryFeeRate: 225, entryFeeRate24h: 6.375, openedAt: new Date(created + 1.68 * 3600e3).toISOString() };
  const snap = { ok: true, ts: 1, feeRate: 60, ofi: 1, pc1: -1 };
  // pre-fix: the stored "normal" of 6.4 means 60%/day is never "below normal"
  assert.equal(GATES.updateFeeDecay(null, row, snap).belowCount, 0);
  const pBase = { ...row,
    entryFeeRate24h: RATES.legacyWindowRate(row.entryFeeRate24h, 24, row.openedAt, created, row.feeBasis) };
  assert.ok(close(pBase.entryFeeRate24h, 91.0714285714));
  // 60 < 50% of 225 AND 60 < ~91 normal: counts as a decay read
  assert.equal(GATES.updateFeeDecay(null, pBase, snap).belowCount, 1);
});

const common = {
  ok: true, ts: 1_990_000, supportedSolPair: true,
  sigma: 30, surge: 1.4, accel: 1.3, org: 80, orgBuy1h: 100,
  path: 'CHOP', ageH: 100, ofi: 1, ofi6: 0.8,
  tvl: 200_000, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
  px: 100, low: 80, low6h: 90, dd: 30, binStepBps: 100,
};
const cfg = { maxBins: 140, basingMaxFloor: 25, sizeIgnition: 0.3, sizeIgnitionHi: 0.4, sizeBasing: 0.3, sizeCarry: 0.4, sizeBidAsk: 1 };

test('launch hold: no class deploys on under an hour of pool fee history', () => {
  const data = { ...common, feeRate1h: 36, feeRate24h: 12 };
  const mature = GATES.collectSignals({ now: 2_000_000, data: { ...data, poolAgeH: 5 }, config: cfg });
  assert.equal(mature.trade && mature.trade.label, 'IGNITION');
  assert.equal(mature.trade.edgeBasis, RATES.EDGE_BASIS);
  assert.equal(mature.launchHold, false);
  const unknown = GATES.collectSignals({ now: 2_000_000, data, config: cfg });
  assert.equal(unknown.trade && unknown.trade.label, 'IGNITION');
  const held = GATES.collectSignals({ now: 2_000_000, data: { ...data, poolAgeH: 0.5 }, config: cfg });
  assert.equal(held.trade, null);
  assert.equal(held.launchHold, true);
  assert.ok(held.recipeEdges.IGNITION > 1, 'edges still computed for logs');
  assert.equal(held.bidAskStatus.gates.fees, false);
});

test('BID ASK fee persistence passes a young pool on its real rate', () => {
  const base = {
    ok: true, ts: 1_990_000, supportedSolPair: true,
    mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
    topHoldersPct: 13, orgBuy1h: 100, path: 'GRIND-UP', ofi1h: 0.96, sigma: 459, ddHigh: 15,
    poolAgeH: NEARPAD_AGE_H,
  };
  // pre-fix read: "24h" 6.375 treated as %/day fails the 8%/day floor
  assert.equal(GATES.bidAskSignal({ ...base, feeRate1h: 147, feeRate24h: 6.375 }, 2_000_000).gates.fees, false);
  // pool-age-aware: ~91%/day since launch, and 1h 147 >= half of it
  const fr24 = RATES.windowPerDay(6.375, 24, NEARPAD_AGE_H);
  assert.equal(GATES.bidAskSignal({ ...base, feeRate1h: 147, feeRate24h: fr24 }, 2_000_000).gates.fees, true);
});

// ---- follow-ups: one-sided IL, legacy conversion, replay/launchlab cache, backfill ----

test('one IL rule for any band: two-sided identity, one-sided = 2x IL and 0.5x edge', () => {
  // two-sided +-W: full width 2W -> sigma^2/(4W), identical to the ilPerDay alias
  assert.ok(close(RATES.ilPerDayForRange(40, 2 * 20), 1600 / 80));
  assert.ok(close(RATES.ilPerDay(40, 20), RATES.ilPerDayForRange(40, 40)));
  // one-sided 0 -> -20: full width 20 -> sigma^2/(2*20) = 2x the +-20 band's IL
  assert.ok(close(RATES.ilPerDayForRange(40, 20), 2 * RATES.ilPerDay(40, 20)));
  assert.equal(RATES.equivalentHalfWidth(20, 'single'), 10);
  assert.equal(RATES.equivalentHalfWidth(20, 'two'), 20);
  assert.ok(close(RATES.breakevenFeePerDayForRange(40, 20), 2 * RATES.breakevenFeePerDay(40, 20)));
  // edge: the full-width form equals the half-width form for two-sided, halves for one-sided
  assert.ok(close(GATES.edgeForRange(30, 40, 40), GATES.edgeFrom(30, 40, 20)));
  assert.ok(close(GATES.edgeForTradeRange(30, 40, { effectiveWidthPct: 20 }, 'single'),
    0.5 * GATES.edgeForTradeRange(30, 40, { effectiveWidthPct: 20 }, 'two')));
  assert.equal(GATES.edgeForTradeRange(30, 40, null, 'two'), 0);
});

test('IGNITION with ofi > 2 ships a one-sided band and is priced at half the edge', () => {
  const data = { ...common, feeRate1h: 36, feeRate24h: 12, poolAgeH: 5 };
  const two = GATES.collectSignals({ now: 2_000_000, data: { ...data, ofi: 1 }, config: cfg });
  const one = GATES.collectSignals({ now: 2_000_000, data: { ...data, ofi: 2.5 }, config: cfg });
  assert.equal(two.trade && two.trade.mode, 'two');
  assert.ok(close(one.recipeEdges.IGNITION, 0.5 * two.recipeEdges.IGNITION, 1e-9));
  // same inputs that clear IGNITION two-sided (~1.39) fail it one-sided (~0.69)
  assert.ok(two.recipeEdges.IGNITION >= 1 && one.recipeEdges.IGNITION < 1);
  // IGNITION no longer fires; the pool falls through to the next class that qualifies
  assert.notEqual(one.trade && one.trade.label, 'IGNITION');
  // BASING/CARRY stay two-sided regardless of ofi
  const range = GATES.tradeRange({ widthPct: 35, binStepBps: 100, maxBins: 140, mode: 'two' });
  assert.ok(close(one.recipeEdges.CARRY, GATES.edgeFrom(36, 30, range.effectiveWidthPct), 1e-9));
});

test('legacy rows convert once, through the shared helper replay and launchlab both use', () => {
  const daemon = { t: 1_790_000_000_000, pool: 'P', edge: 1.8, fr: 40, recipeEdges: {}, sig: null };
  // IGNITION recipe with ofi > 2 was a one-sided band priced as two-sided: x5/9 x0.5
  const one = RATES.legacyRowToV1({ ...daemon, ofi: 2.5, poolAgeH: 5 });
  assert.equal(one.oneSided, true);
  assert.ok(close(one.edge, 1.8 * 5 / 9 * 0.5, 1e-9));
  // BASING/CARRY trades and Quant Lens rows were two-sided: x5/9 only
  assert.ok(close(RATES.legacyRowToV1({ ...daemon, sig: 'BASING', ofi: 3, poolAgeH: 5 }).edge, 1.0, 1e-9));
  assert.equal(RATES.legacyRowToV1({ t: 1, pool: 'P', edge: 1.8, fr: 40, ofi: 3, pAgeH: 5 }).oneSided, false);
  // unidentifiable side (no ofi on a daemon IGNITION row): left at 5/9 and flagged
  const unk = RATES.legacyRowToV1({ ...daemon, ofi: null, poolAgeH: 5 });
  assert.equal(unk.oneSided, null);
  assert.ok(close(unk.edge, 1.0, 1e-9));
  // sub-1h pool: fr and edge scale by 1/age (30 min -> x2)
  const young = RATES.legacyRowToV1({ ...daemon, ofi: 1, poolAgeH: 0.5 });
  assert.equal(young.fr, 80);
  assert.ok(close(young.edge, 1.8 * 5 / 9 * 2, 1e-9));
  // age from a backfilled created_at at the row's own timestamp
  const bf = RATES.legacyRowToV1({ ...daemon, ofi: 1 }, daemon.t - 0.5 * 3600e3);
  assert.equal(bf.fr, 80);
  assert.equal(bf.feeAgeKnown, true);
  assert.equal(RATES.legacyRowToV1({ ...daemon, ofi: 1 }).feeAgeKnown, false);
  // native v1 rows are never touched
  const native = RATES.legacyRowToV1({ ...daemon, ofi: 3, eb: RATES.EDGE_BASIS, fb: RATES.FEE_BASIS, poolAgeH: 0.3 });
  assert.equal(native.edge, 1.8);
  assert.equal(native.fr, 40);
  const line = RATES.legacyBasisLine(RATES.legacyBasisSummary([native, one, unk, RATES.legacyRowToV1({ ...daemon, ofi: 1 })]));
  assert.match(line, /1 native, 3 legacy/);
  assert.match(line, /1 one-sided/);
  assert.match(line, /1 legacy rows: band side unidentifiable/);
  assert.match(line, /1 legacy rows: pool age unknown/);
});

test('replay and launchlab caches only reuse entries simulated on the current basis', async () => {
  const REPLAY = require('../replay.cjs');
  const LAB = require('../launchlab.cjs');
  const row = { t: 1_790_000_000_000, pool: 'POOL', sig: null, sigma: 60, fr: 40, tvl: 100_000, ofi: 1, poolAgeH: 5, recipeEdges: {}, edge: 1.2 };
  const key = REPLAY.rowKey(row);
  assert.equal(REPLAY.cachedResult({ [key]: { cls: 'IGNITION', pnl: 1 } }, row), null);               // pre-fix entry: miss
  assert.equal(REPLAY.cachedResult({ [key]: { cls: 'IGNITION', pnl: 1, v: 'pool-age-v0|x' } }, row), null);
  const current = { cls: 'IGNITION', pnl: 1, v: RATES.REPLAY_CACHE_VERSION };
  assert.equal(REPLAY.cachedResult({ [key]: current }, row), current);
  // a fresh simulation is stamped with the current version (skips too)
  const candles = [0, 1, 2, 3].map((i) => ({ timestamp: 1_790_000_000 + i * 1800, open: 1, close: 1 }));
  const fakeFetch = async (url) => ({ json: async () => (url.includes('/ohlcv') ? { data: candles } : { data: [] }) });
  const sim = await REPLAY.simulate(row, RATES.legacyRowToV1(row), fakeFetch);
  assert.equal(sim.v, RATES.REPLAY_CACHE_VERSION);
  assert.ok(close(sim.edge, 1.2 * 5 / 9, 1e-9));
  const skip = await REPLAY.simulate(row, null, async () => ({ json: async () => ({ data: [] }) }));
  assert.equal(skip.skip, 'no-candles');
  assert.equal(RATES.replayCacheHit(skip), true);
  // launchlab keeps its variant map in `v`, so its version lives in `basis`
  assert.equal(LAB.launchCacheHit({ v: {}, edge: 1 }), false);
  assert.equal(LAB.launchCacheHit({ v: {}, basis: RATES.REPLAY_CACHE_VERSION }), true);
});

test('pool-age backfill fetches each pool once, caches to disk, and never throws', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createPoolCreatedResolver, needsPoolAge } = require('../pool_created.cjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dq-')), 'pool-created.json');
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.endsWith('/BROKEN')) throw new Error('network down');
    if (url.endsWith('/EMPTY')) return {};
    return { created_at: 1_790_000_000_000 };
  };
  const r1 = createPoolCreatedResolver({ cacheFile: file, fetchJson, throttleMs: 0 });
  await r1.resolve(['A', 'A', 'B', 'BROKEN', 'EMPTY']);
  assert.equal(calls.length, 4);                          // A deduped
  assert.equal(r1.createdAt('A'), 1_790_000_000_000);
  assert.equal(r1.createdAt('BROKEN'), null);
  assert.deepEqual({ fetched: r1.stats.fetched, failed: r1.stats.failed }, { fetched: 2, failed: 2 });
  // second run: cached pools are not refetched; --no-backfill never touches the network
  const r2 = createPoolCreatedResolver({ cacheFile: file, fetchJson, throttleMs: 0, enabled: false });
  await r2.resolve(['A', 'B', 'C']);
  assert.equal(calls.length, 4);
  assert.equal(r2.createdAt('B'), 1_790_000_000_000);
  assert.equal(r2.stats.skipped, 1);
  // end to end: backfilled age feeds the legacy fr correction
  const row = { t: 1_790_000_000_000 + 0.5 * 3600e3, pool: 'A', fr: 40, edge: 1, recipeEdges: {}, ofi: 1 };
  assert.equal(needsPoolAge(row, RATES.FEE_BASIS), true);
  assert.equal(needsPoolAge({ ...row, poolAgeH: 3 }, RATES.FEE_BASIS), false);
  assert.equal(needsPoolAge({ ...row, fb: RATES.FEE_BASIS }, RATES.FEE_BASIS), false);
  assert.equal(RATES.legacyRowToV1(row, r2.createdAt(row.pool)).fr, 80);
});
