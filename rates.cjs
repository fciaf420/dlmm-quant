// rates.cjs — the ONE copy of how pool fee/volume windows become daily rates, and
// the fee-vs-IL constants the edge heuristic is built on. Required by gates.cjs,
// trader_daemon.cjs, screen.cjs, deploy.cjs, launchwatch.cjs and replay.cjs.
// (mirror of meteora-quant-lens v0.7.12 pool-age-aware rates + edge-math fix)
//
// POOL-AGE WINDOWS (caught live 2026-09-27, NEARPAD-SOL, pool 1.68h old): datapi's
// fee_tvl_ratio / volume windows (30m,1h,2h,4h,12h,24h) can only cover the time the
// POOL has existed. NEARPAD returned 2h=4h=12h=24h=6.375 — the same since-creation
// total — and the old code read that "24h" as 6.4%/day when it was 6.4% in 1.7h
// (~91%/day). Consequences: BID ASK fee persistence (24h >= 8%/day) failed on nearly
// every sub-day pool, and deploy.cjs stamped that understated number as the pool's
// NORMAL (entryFeeRate24h), so FEE-DECAY's "below normal" guard needed the live rate
// to fall to ~6%/day before it could ever fire on a young-pool position.
// Every window-based rate is now divided by the hours the window really covered.
// Pool age comes from the POOL's created_at, not Jupiter's token age: these are pool
// windows, and a fresh pool for an old token is exactly the case that broke.

const FEE_BASIS = 'pool-age-v1';      // stamped on rows/baselines computed this way
// stamped on rows whose edge uses the formula below. v1 INCLUDES the one-sided rule
// (ilPerDayForRange): no row was ever written with this tag before that rule existed.
const EDGE_BASIS = 'il4w-net-v1';
// replay/launchlab cache entries simulated under any other basis are misses
const REPLAY_CACHE_VERSION = FEE_BASIS + '|' + EDGE_BASIS;
const MIN_FEE_HISTORY_H = 1;          // under 1h of fees nothing fee-priced may pass (launch hold)
const MIN_COVERED_H = 0.25;           // floor so a minutes-old pool never divides by ~0

// FEES ARE ALREADY NET OF THE PROTOCOL CUT (proven live 2026-09-27 across the top-30
// board): SOL-USDC with a 0.04% base fee shows fees/volume = 0.0382% — below the
// minimum fee a swap can pay, so `fees` cannot be gross. (fees + protocol_fees)/volume
// = 0.0424%, and protocol/(fees+protocol) ~= 10% (standard) / ~19-20% (launch pool),
// matching Meteora's documented protocol shares. fee_tvl_ratio = fees/TVL is therefore
// the LP's share already; the old extra *0.9 haircut deducted the cut a second time.
const LP_FEE_SHARE = 1.0;

// IL/LVR of a uniform (Spot) band of HALF-width W, small-range diffusion limit:
// sigma^2 / (4W) %/day with sigma in %/day and W in % — not sigma^2/(8W).
// Uniform band => position delta falls linearly across 2W, gamma = V/(2W),
// E[IL] = 1/2 * gamma * sigma^2 = V * sigma^2 / (4W). Same answer as the Uniswap-v3
// narrow-range LVR (sigma^2/8 * 2/W). A DLMM bin simulation (uniform L per bin,
// W=20%, 100bps) fit IL = k*ln(p)^2 with k = 1.42 vs 1/(4w) = 1.25 vs the old
// 1/(8w) = 0.625, so sigma^2/(4W) is if anything still slightly generous.
const IL_DENOM = 4;
const EDGE_SAFETY = 1.3;              // unchanged safety margin on the IL term

// old edge = fr*0.9 / (1.3*sigma^2/(8W)); new = fr / (1.3*sigma^2/(4W)).
// new/old = 4 / (0.9*8) = 5/9 on identical inputs (fee basis aside).
const LEGACY_EDGE_TO_V1 = 4 / (0.9 * 8);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function poolAgeHours(createdAt, nowMs = Date.now()) {
  const n = Number(createdAt);
  if (createdAt === null || createdAt === undefined || createdAt === '' || !Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e11 ? n : n * 1000;   // datapi sends ms; accept seconds too
  const h = (Number(nowMs) - ms) / 3600e3;
  return Number.isFinite(h) && h >= 0 ? h : null;
}

function coveredHours(windowH, ageH) {
  return ageH == null || !finite(ageH) ? windowH : Math.min(windowH, Math.max(ageH, MIN_COVERED_H));
}

// a window's value (fee/TVL %, or volume) expressed per day over the time it covered.
// null in -> null out (callers use null for "metric missing").
function windowPerDay(windowValue, windowH, ageH) {
  if (windowValue === null || windowValue === undefined || windowValue === '') return null;
  const v = Number(windowValue);
  if (!Number.isFinite(v)) return null;
  return v * 24 / coveredHours(windowH, ageH);
}

// accel: hourly pace over the last 30m vs hourly pace over the last 4h, each over the
// time it covered. Old form (v30*48)/max(v4*6,1) assumed a full 4h and inflated accel
// ~2.4x on a 1.7h pool, loosening IGNITION's ac >= 1.2 gate on young pools.
function accelFrom(v30m, v4h, ageH) {
  if (v30m === null || v30m === undefined || v4h === null || v4h === undefined) return null;
  const a = Number(v30m), b = Number(v4h);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (a / coveredHours(0.5, ageH)) / Math.max(b / coveredHours(4, ageH), 1 / 24);
}

function poolAgeStage(ageH) {
  if (ageH == null || !finite(ageH)) return 'UNKNOWN';
  if (ageH < MIN_FEE_HISTORY_H) return 'LAUNCH';
  if (ageH < 24) return 'YOUNG';
  return 'MATURE';
}

const launchHeld = (ageH) => finite(ageH) && ageH < MIN_FEE_HISTORY_H;

// Baselines stored before FEE_BASIS were computed as ratio*24/windowH even when the
// pool was younger than the window. Rescale by the pool's age when they were
// recorded so positions already open get a correct "pool normal". Stamped rows and
// unknown pool ages pass through untouched.
function legacyWindowRate(value, windowH, recordedAtMs, poolCreatedAt, basis) {
  const v = Number(value);
  if (!(v > 0)) return null;
  if (basis === FEE_BASIS) return v;
  const at = typeof recordedAtMs === 'string' ? Date.parse(recordedAtMs) : Number(recordedAtMs);
  const ageAt = poolAgeHours(poolCreatedAt, at);
  if (ageAt == null || ageAt >= windowH) return v;
  return v * windowH / coveredHours(windowH, ageAt);
}

// ONE RULE FOR ANY UNIFORM BAND: in-range IL %/day = sigma^2 / (2 * fullWidthPct),
// fullWidthPct = max - min of the band in %. The edge heuristic assumes capital earns
// the pool fee rate while ACTIVE, so IL must be the in-range IL too. A one-sided band
// (0 -> -W, or 0 -> +W) holds the same capital in half the width of a +-W band: twice
// the gamma, twice the IL. Two-sided +-W: full 2W -> sigma^2/(4W) (unchanged).
// One-sided 0 -> -W: full W -> sigma^2/(2W). (mirror of meteora-quant-lens)
const ilPerDayForRange = (sigma, fullWidthPct) => (sigma * sigma) / (2 * fullWidthPct);
// two-sided +-W alias (the historical call shape): = ilPerDayForRange(sigma, 2W)
const ilPerDay = (sigma, halfWidthPct) => ilPerDayForRange(sigma, 2 * halfWidthPct);
// the +-W half-width whose sigma^2/(4W) equals a band's in-range IL: two-sided keeps W,
// a one-sided band of depth D is equivalent to +-(D/2)
const equivalentHalfWidth = (widthPct, mode = 'two') => (mode === 'single' ? widthPct / 2 : widthPct);
const breakevenFeePerDayForRange = (sigma, fullWidthPct) => ilPerDayForRange(sigma, fullWidthPct) / LP_FEE_SHARE;

// PRICE-DRIVEN BRACKET TERMS BY BAND SIDE (mirror of meteora-quant-lens). Verified with a
// SOL-only ladder, equal SOL per log-spaced bin, marked at the band bottom:
//   one-sided 0 -> -W loses 6.13 / 10.37 / 15.89% at W = 12 / 20 / 30  (~0.5W)
//   two-sided +-W     loses 9.06 / 15.19 / 22.94%                       (~0.75W, the
//   source of the existing 0.75W + k SLs)
// and a one-sided SOL band has ZERO price-driven upside: above the band it is 100% SOL,
// unchanged, so the ~W/4 cap term does not exist for it - its TP is fees only.
const priceUpsideCapPct = (W, mode = 'two') => (mode === 'single' ? 0 : W / 4);
const bandBreakLossPct = (W, mode = 'two') => (mode === 'single' ? 0.5 : 0.75) * W;
const breakevenFeePerDay = (sigma, halfWidthPct) => breakevenFeePerDayForRange(sigma, 2 * halfWidthPct);

// ---- legacy shadow-row conversion (ONE copy, shared by replay.cjs + launchlab.cjs) --
// Rows without `eb` were logged with edge = fr*0.9/(1.3*s^2/(8W)), W = the recipe's
// deployed depth for BOTH modes, and fr = ratio1h*24 regardless of pool age.
// Conversion to v1: edge x5/9 always; x0.5 more when the row's edge was a one-sided
// band; fr (and edge) x 1/max(age,0.25h) when the pool was under 1h old at the row.

// Pool age at the row's own timestamp: logged poolAgeH (daemon/launchwatch), pAgeH
// (Quant Lens exports), else a backfilled pool created_at (pool_created.cjs).
function rowPoolAgeH(row, createdAt) {
  if (finite(row && row.poolAgeH)) return row.poolAgeH;
  if (finite(row && row.pAgeH)) return row.pAgeH;
  if (createdAt != null && finite(row && row.t)) return poolAgeHours(createdAt, row.t);
  return null;
}

// true / false / null (cannot tell). Daemon rows (they carry recipeEdges/edgeModel) log
// the trade's edge when one fired (BASING/CARRY: two-sided) and otherwise the IGNITION
// recipe edge, whose band was one-sided exactly when ofi > 2 (gates.cjs). Quant Lens
// rows' legacy edge was always a two-sided +-W computation.
function legacyEdgeOneSided(row) {
  if (!row) return null;
  if (row.mode === 'single') return true;
  if (row.mode === 'two') return false;
  const daemonRow = row.recipeEdges != null || row.edgeModel != null;
  if (!daemonRow) return false;
  if (row.sig && row.sig !== 'IGNITION') return false;
  if (!finite(row.ofi)) return null;
  return row.ofi > 2;   // NB: logged ofi is rounded to 2dp; 2.001-2.004 reads as 2.00
}

function legacyRowToV1(row, createdAt) {
  const ageH = rowPoolAgeH(row, createdAt);
  const legacyFee = row.fb !== FEE_BASIS;
  const feeFix = (legacyFee && ageH != null && ageH < 1) ? 1 / Math.max(ageH, MIN_COVERED_H) : 1;
  const fr = finite(row.fr) ? row.fr * feeFix : row.fr;
  const feeAgeKnown = !legacyFee || ageH != null;
  if (row.eb === EDGE_BASIS) return { edge: row.edge, fr, native: true, oneSided: null, feeAgeKnown, ageH };
  const oneSided = legacyEdgeOneSided(row);
  const edge = finite(row.edge)
    ? row.edge * LEGACY_EDGE_TO_V1 * feeFix * (oneSided === true ? 0.5 : 1) : row.edge;
  return { edge, fr, native: false, oneSided, feeAgeKnown, ageH };
}

const replayCacheHit = (entry) => !!entry && entry.v === REPLAY_CACHE_VERSION;

// basis bookkeeping for the replay/launchlab summary line (one copy: no drift)
function legacyBasisSummary(convs) {
  const out = { native: 0, legacy: 0, oneSided: 0, sideUnknown: 0, ageUnknown: 0 };
  for (const c of convs) {
    if (c.native) { out.native++; continue; }
    out.legacy++;
    if (c.oneSided === true) out.oneSided++;
    if (c.oneSided === null) out.sideUnknown++;
    if (!c.feeAgeKnown) out.ageUnknown++;
  }
  return out;
}
function legacyBasisLine(b) {
  return `edge basis: ${EDGE_BASIS} (fr/(1.3*s^2/2F), F = full band width) | ${b.native} native, ${b.legacy} legacy rows x${LEGACY_EDGE_TO_V1.toFixed(4)}`
    + (b.oneSided ? ` (${b.oneSided} one-sided: extra x0.5)` : '')
    + (b.sideUnknown ? ` | ${b.sideUnknown} legacy rows: band side unidentifiable (no ofi) -> left at x5/9, one-sided ones still overstated 2x` : '')
    + (b.ageUnknown ? ` | ${b.ageUnknown} legacy rows: pool age unknown -> if <1h old, fr/edge stay understated` : '');
}

module.exports = {
  FEE_BASIS, EDGE_BASIS, MIN_FEE_HISTORY_H, MIN_COVERED_H, LP_FEE_SHARE, IL_DENOM,
  EDGE_SAFETY, LEGACY_EDGE_TO_V1, REPLAY_CACHE_VERSION,
  poolAgeHours, coveredHours, windowPerDay, accelFrom, poolAgeStage, launchHeld,
  legacyWindowRate, ilPerDay, ilPerDayForRange, equivalentHalfWidth,
  breakevenFeePerDay, breakevenFeePerDayForRange, priceUpsideCapPct, bandBreakLossPct,
  rowPoolAgeH, legacyEdgeOneSided, legacyRowToV1, replayCacheHit, legacyBasisSummary, legacyBasisLine,
};
