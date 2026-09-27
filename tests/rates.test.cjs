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
