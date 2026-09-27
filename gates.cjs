// gates.cjs — the ONE copy of the entry-signal logic: path classification, the
// edge formula, the three trade-class gates, and the independent BID ASK gate.
// Required by trader_daemon.cjs (live deploys) and screen.cjs (preview board).
// Extracted from the daemon so the read-only board cannot drift from execution.
// Numbers here are the daemon's real thresholds — editing them changes LIVE deploys.

const { qualifyBidAskCandle } = require('./candle_analysis.cjs');
const RATES = require('./rates.cjs');

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP from price action + day structure
function classifyPath({ pc5, pc1, dd, pos }) {
  if (pc1<=-25 || (pc5<=-8 && pc1<0)) return "FREEFALL";
  if ((dd??0)>=40 && Math.abs(pc5)<5 && pc1>-15) return "BASING";
  if ((pos??0)>0.85 && pc1>40) return "BLOWOFF";
  if (pc1>0) return "GRIND-UP";
  return "CHOP";
}

// Pool-level fee-yield vs realized-vol heuristic (fr = daily fee %, sigma =
// daily vol %, widthPct = the HALF-width the recipe can actually deploy). This is
// not a position simulator: shape, directional inventory, costs and fill path
// are deliberately outside this proxy.
// EDGE MATH FIX 2026-09-27 (mirror of meteora-quant-lens): fr is already LP-net
// (no *0.9) and a uniform +-W band's IL is sigma^2/(4W), not sigma^2/(8W) - see
// rates.cjs for the live proof and the bin simulation. edge = fr / (1.3 * IL).
// Thresholds below are deliberately UNCHANGED: on identical inputs every edge is
// now 5/9 of the old number, i.e. entries need ~1.8x the fees they used to.
// widthPct here is the +-W HALF-width of a two-sided band. For a one-sided band pass
// RATES.equivalentHalfWidth(depth, 'single') = depth/2 (same capital in half the width:
// in-range IL sigma^2/(2*depth), see rates.cjs ilPerDayForRange) - or use edgeForRange.
const edgeFrom = (fr, sigma, widthPct = 20) => {
  if (![fr, sigma, widthPct].every(Number.isFinite) || sigma <= 0 || widthPct <= 0) return 0;
  return ((fr * RATES.LP_FEE_SHARE) / Math.max(sigma, .001))
    / Math.max(RATES.EDGE_SAFETY * sigma / (RATES.IL_DENOM * widthPct), .001);
};
// the same heuristic for a band given by its FULL width (max - min, %)
const edgeForRange = (fr, sigma, fullWidthPct) => edgeFrom(fr, sigma, fullWidthPct / 2);
// edge for a tradeRange() result deployed in `mode`: effectiveWidthPct is the down
// depth, which is the half-width of a two-sided band but the FULL width of a single one
const edgeForTradeRange = (fr, sigma, range, mode) => (range
  ? edgeFrom(fr, sigma, RATES.equivalentHalfWidth(range.effectiveWidthPct, mode)) : 0);

const ignition = ({ edge, sg, ac, org, path, ageH, ofi }) =>
  [edge, sg, ac, org, ageH, ofi].every(finite)
  && edge>=1.0 && sg>=1.25 && ac>=1.2 && org>=40 && path!=="FREEFALL" && (ageH>=6 || (org>=60 && ofi<2));

// edge floor raised 0.5 -> 0.8 (2026-08-08). The 0.5 discount assumed the post-crash
// lookback inflates sigma and understates edge; live it admitted serial floor-breakers
// (BUTTHOLE: -8.9/-8.6 on BASING entries in three days - a landing in a stair-step
// decline has great fees right up until the floor gives). Replay splits the old
// 0.5-1 bucket cleanly at 0.8: 0.5-0.8 = -6.1% (n=27), 0.8-1.0 = +1.9% (5/7 wins).
const basing = ({ path, ofi, org, fr, edge }) =>
  [ofi, org, fr, edge].every(finite)
  && path==="BASING" && ofi<=1.0 && org>=60 && fr>=15 && edge>=0.8;

// BASE-ANCHORED floor: nearest consolidation low below price (6h preferred, then
// 24h, then a synthetic -15%). rawW = how far below price that floor sits, in %.
// The TIGHT-BASE gate itself (rawW <= CFG.BASING_MAX_FLOOR) stays with the caller
// so the config dependency doesn't leak in here.
function basingFloor({ px, low, low6h }) {
  const floor = (low6h > 0 && low6h < px) ? low6h : ((low > 0 && low < px) ? low : px * 0.85);
  const rawW = px > 0 ? ((px - floor) / px) * 100 : 18;
  return { floor, rawW };
}

const carry = ({ edge, ofi6, org, tvl, fr, sigma, ageH, audit, path }) =>
  [edge, ofi6, org, tvl, fr, sigma, ageH].every(finite)
  && edge>=1.3 && ofi6<1.0 && org>=60 && tvl>=100000 && (fr>=2 || (fr>=1.2 && edge>=2) || (fr>=0.6 && edge>=3 && sigma<10)) && ageH>=72 && audit.mintAuthorityDisabled===true && audit.freezeAuthorityDisabled===true && ["CHOP","BASING","GRIND-UP"].includes(path);

const BID_ASK_FRESH_MS = 2 * 60e3;

// A DLMM bin is geometric: adjacent prices differ by (1 + binStep/10_000).
// Return the number of downward steps needed to reach the requested drawdown.
// Deep accumulation plans are all-or-nothing because silently shortening a
// 64% band to fit memory changes the economic position the signal requested.
function downsideRange({ depthPct, binStepBps, maxBins }) {
  if (!finite(depthPct) || depthPct <= 0 || depthPct >= 100
      || !finite(binStepBps) || binStepBps <= 0
      || !Number.isInteger(maxBins) || maxBins < 2) {
    return { requiredBins: null, totalBins: null, executable: false, effectiveDepthPct: null };
  }
  const base = 1 + binStepBps / 10_000;
  const requiredBins = Math.ceil(-Math.log(1 - depthPct / 100) / Math.log(base));
  const totalBins = requiredBins + 1;
  return {
    requiredBins,
    totalBins,
    executable: totalBins <= maxBins,
    effectiveDepthPct: 100 * (1 - Math.pow(base, -requiredBins)),
  };
}

// Preserve the existing trade recipe's bin selection, but expose the geometric
// percentage that those bins really cover so EDGE/brackets use shipped width.
function tradeRange({ widthPct, binStepBps, maxBins, mode = 'two' }) {
  if (!finite(widthPct) || widthPct <= 0 || !finite(binStepBps) || binStepBps <= 0
      || !Number.isInteger(maxBins) || maxBins < 2) return null;
  const stepPct = binStepBps / 100;
  const requestedBins = Math.max(3, Math.round(widthPct / stepPct));
  const maxWidthBins = mode === 'single' ? maxBins - 1 : Math.floor((maxBins - 1) / 2);
  const widthBins = Math.min(requestedBins, maxWidthBins);
  const base = 1 + binStepBps / 10_000;
  const effectiveDownPct = 100 * (1 - Math.pow(base, -widthBins));
  const effectiveUpPct = mode === 'single' ? 0 : 100 * (Math.pow(base, widthBins) - 1);
  return {
    requestedBins,
    widthBins,
    totalBins: mode === 'single' ? widthBins + 1 : widthBins * 2 + 1,
    clamped: widthBins < requestedBins,
    effectiveDownPct,
    effectiveUpPct,
    effectiveWidthPct: effectiveDownPct,
  };
}

function bidAskSignal(d, now = Date.now()) {
  d = d || {};
  const paths = ['FREEFALL', 'BASING', 'BLOWOFF', 'GRIND-UP', 'CHOP'];
  const knownPath = paths.includes(d.path);
  const pairOK = d.supportedSolPair === true;
  const complete = d.ok === true && finite(d.ts)
    && finite(d.topHoldersPct) && d.topHoldersPct >= 0
    && finite(d.orgBuy1h) && d.orgBuy1h >= 0
    && finite(d.feeRate1h) && d.feeRate1h >= 0
    && finite(d.feeRate24h) && d.feeRate24h >= 0
    && finite(d.ofi1h) && d.ofi1h >= 0
    && finite(d.sigma) && d.sigma > 0 && knownPath
    && typeof d.mintAuthorityDisabled === 'boolean'
    && typeof d.freezeAuthorityDisabled === 'boolean';
  const gates = {
    fresh: finite(d.ts) && now >= d.ts && now - d.ts <= BID_ASK_FRESH_MS,
    data: complete,
    pair: pairOK,
    auth: d.mintAuthorityDisabled === true && d.freezeAuthorityDisabled === true,
    top10: finite(d.topHoldersPct) && d.topHoldersPct <= 35,
    flow: finite(d.orgBuy1h) && d.orgBuy1h > 0,
    // feeRate24h is pool-age-aware (since-launch %/day on a sub-day pool). Under an
    // hour of fees there is no history to measure persistence against: hold.
    fees: !RATES.launchHeld(d.poolAgeH) && finite(d.feeRate1h) && finite(d.feeRate24h)
      && d.feeRate24h >= 8 && d.feeRate1h >= 0.5 * d.feeRate24h,
    path: knownPath && finite(d.ofi1h) && !(d.path === 'FREEFALL' && d.ofi1h >= 1.43),
  };
  const baseReady = Object.values(gates).every(Boolean);
  const candleQualification = qualifyBidAskCandle(d.candleAnalysis, { nowMs: now });
  const ready = baseReady && candleQualification.ready;
  let depthPct = null;
  let bidAskPct = null;
  if (finite(d.sigma) && d.sigma > 0) {
    let depth = d.sigma >= 150 ? 75 : (d.sigma <= 80 ? 60 : 60 + ((d.sigma - 80) / 70) * 15);
    if (finite(d.ddHigh) && d.ddHigh < 20) depth = Math.min(75, depth + 5);
    if (finite(d.ddHigh) && d.ddHigh > 50) depth = Math.max(60, depth - 5);
    depthPct = Math.round(depth);
    let share = 0.55 + (d.sigma - 100) / 1000 + (d.ofi1h > 1 ? 0.05 : 0)
      + (d.path === 'FREEFALL' ? 0.05 : 0);
    share = Math.min(0.80, Math.max(0.60, share));
    bidAskPct = Math.round((Math.round(share * 20) / 20) * 100);
  }
  return {
    label: 'BID_ASK',
    profile: 'ACCUM',
    strategy: 'Bid-Ask + Spot',
    state: ready ? 'READY' : (baseReady ? 'WATCH' : 'WAIT'),
    ready,
    baseReady,
    heuristic: true,
    depthPct,
    allocation: bidAskPct == null ? null : { bidAskPct, spotPct: 100 - bidAskPct },
    gates,
    candleQualification,
    candleAnalysis: d.candleAnalysis || null,
    reasons: [
      ...Object.entries(gates).filter(([, pass]) => !pass).map(([key]) => key),
      ...candleQualification.reasons,
    ],
  };
}

function resolvePositionProfile(row, previousProfile) {
  row = row || {};
  const explicit = String(row.profile || '').toUpperCase();
  if (explicit === 'ACCUM' || row.accum === true || ['BID_ASK', 'BID ASK'].includes(row.label)) return 'ACCUM';
  if (explicit === 'TRADE') return 'TRADE';
  if (['IGNITION', 'BASING', 'CARRY', 'SQUEEZE', 'IGNITION_OVERRIDE', 'CARRY_OVERRIDE'].includes(row.label)) return 'TRADE';
  if (['ACCUM', 'TRADE', 'ACCUM_INFERRED', 'TRADE_INFERRED'].includes(previousProfile)) return previousProfile;
  return 'TRADE_INFERRED';
}

function needsDeploymentResume(row) {
  return !!(row && resolvePositionProfile(row) === 'ACCUM'
    && row.label === 'BID_ASK' && row.funded !== true && row.deploymentState !== 'COMPLETE');
}

function evaluateAccumLifecycle({ dataReady = true, decay = false, flow = false } = {}) {
  if (!dataReady) return 'WAIT';
  if (decay && flow) return 'EXIT';
  if (decay || flow) return 'WAIT';
  return 'ACCUMULATING';
}

function signalsReady(s) {
  return !!(s && s.ok === true && finite(s.ts) && finite(s.feeRate)
    && finite(s.ofi) && finite(s.pc1));
}

function updateFeeDecay(previous, row, snapshot) {
  const prior = previous && previous.position === row.position ? previous : null;
  let belowCount = prior ? prior.belowCount || 0 : 0;
  if (!signalsReady(snapshot)) return { ...(prior || {}), position: row.position, belowCount };
  if (!prior || prior.dataTs !== snapshot.ts) {
    const normal = row.entryFeeRate24h > 0 ? row.entryFeeRate24h : Infinity;
    const below = row.entryFeeRate > 2
      && snapshot.feeRate < 0.5 * row.entryFeeRate && snapshot.feeRate < normal;
    belowCount = below ? belowCount + 1 : 0;
  }
  return { position: row.position, belowCount, dataTs: snapshot.ts };
}

// RECIPE GEOMETRY - the ONE copy of which band each TRADE class would ship (width,
// side, bins) and its edge on that band. Used by collectSignals (live deploys) and by
// launchwatch.cjs's observational "would fire" (caught 2026-09-27: launchwatch priced
// every class at a default +-20 band, so its WOULD column disagreed with the daemon).
// Ranges/edges come back null/0 when the bin geometry is unknown.
function recipePlan(d, c) {
  d = d || {}; c = c || {};
  const rawW = basingFloor({ px: d.px, low: d.low, low6h: d.low6h }).rawW;
  const makeRange = (wanted, mode) => tradeRange({ widthPct: wanted, binStepBps: d.binStepBps, maxBins: c.maxBins, mode });
  const ignitionWanted = Math.min(30, Math.max(12, Math.round(d.sigma / 4)));
  // ONE-SIDED IL (2026-09-27, mirror of meteora-quant-lens): when ofi > 2 IGNITION ships a
  // quote-only 0 -> -W band - same capital in half the width of +-W, 2x in-range IL.
  const ignitionMode = d.ofi > 2 ? 'single' : 'two';
  const ignitionRange = makeRange(ignitionWanted, ignitionMode);
  const basingWanted = Math.min(30, Math.max(8, Math.round(rawW)));
  const basingRange = makeRange(basingWanted, 'two');
  const carryRange = makeRange(35, 'two');
  const edge = (range, mode) => edgeForTradeRange(d.feeRate1h, d.sigma, range, mode);
  return {
    rawW,
    IGNITION: { wanted: ignitionWanted, mode: ignitionMode, range: ignitionRange, edge: edge(ignitionRange, ignitionMode) },
    BASING: { wanted: basingWanted, mode: 'two', range: basingRange, edge: edge(basingRange, 'two') },
    CARRY: { wanted: 35, mode: 'two', range: carryRange, edge: edge(carryRange, 'two') },
  };
}

// SIDE-AWARE EXIT BRACKETS (mirror of meteora-quant-lens). The CLI's own clamps and fee
// multipliers are unchanged; only the price-driven terms depend on the band side
// (rates.cjs): TP's ~W/4 upside cap is 0 for a one-sided SOL band (100% SOL above it,
// fees are the only upside), and the SL's band-break term is ~0.5W instead of ~0.75W.
// Two-sided brackets are numerically identical to before.
function tradeBrackets(label, W, fr, mode = 'two') {
  const up = RATES.priceUpsideCapPct(W, mode), loss = RATES.bandBreakLossPct(W, mode);
  if (label === 'IGNITION') return { tp: Math.min(25, Math.max(4, Math.round(up + fr * 0.5))), sl: -Math.min(20, Math.max(8, Math.round(loss + 2))) };
  if (label === 'BASING') return { tp: Math.min(20, Math.max(6, Math.round(up + fr))), sl: -Math.min(25, Math.max(10, Math.round(loss + 5))) };
  if (label === 'CARRY') return { tp: Math.min(15, Math.max(6, Math.round(up + fr * 2))), sl: -Math.min(12, Math.max(8, Math.round(loss + 2))) };
  return null;
}

// Observational only (launchwatch.cjs): which class WOULD the live gates fire on, priced
// at the width and side the daemon would actually deploy. Deliberately ignores the
// launch hold and data freshness - launchwatch exists to watch that regime.
function wouldFire(d, c) {
  d = d || {}; c = c || {};
  const plan = recipePlan(d, c);
  const edges = { IGNITION: plan.IGNITION.edge, BASING: plan.BASING.edge, CARRY: plan.CARRY.edge };
  const would = plan.IGNITION.range && ignition({ edge: edges.IGNITION, sg: d.surge, ac: d.accel, org: d.org, path: d.path, ageH: d.ageH, ofi: d.ofi }) ? 'IGNITION'
    : plan.BASING.range && finite(c.basingMaxFloor) && plan.rawW <= c.basingMaxFloor
      && basing({ path: d.path, ofi: d.ofi, org: d.org, fr: d.feeRate1h, edge: edges.BASING }) ? 'BASING'
      : plan.CARRY.range && carry({ edge: edges.CARRY, ofi6: d.ofi6, org: d.org, tvl: d.tvl, fr: d.feeRate1h, sigma: d.sigma, ageH: d.ageH, audit: d.audit || {}, path: d.path }) ? 'CARRY'
        : null;
  return { would, edges, ignitionMode: plan.IGNITION.mode, plan };
}

function collectSignals({ data: d, config: c, now = Date.now() }) {
  d = d || {}; c = c || {};
  const out = { trade: null, bidAsk: null, bidAskStatus: null, recipeEdges: {},
    poolAgeH: finite(d.poolAgeH) ? d.poolAgeH : null, launchHold: RATES.launchHeld(d.poolAgeH) };
  // LAUNCH HOLD (mirror of meteora-quant-lens v0.7.12): every class is priced off the
  // pool fee rate, and under 1h that rate is minutes of launch trading scaled to a day
  // (now correctly scaled, i.e. LARGER than the old understated read). No class may
  // deploy on it; edges are still computed so logs/shadow show what it would have been.
  const dataFresh = d.ok === true && finite(d.ts) && now >= d.ts && now - d.ts <= BID_ASK_FRESH_MS
    && !out.launchHold;
  if (d.supportedSolPair !== true || !finite(d.binStepBps) || d.binStepBps <= 0
      || !finite(d.sigma) || d.sigma <= 0 || !finite(d.feeRate1h)) return out;
  const plan = recipePlan(d, c);
  const rawW = plan.rawW;
  const { wanted: ignitionWanted, mode: ignitionMode, range: ignitionRange, edge: ignitionEdge } = plan.IGNITION;
  const { range: basingRange, edge: basingEdge } = plan.BASING;
  const { range: carryRange, edge: carryEdge } = plan.CARRY;
  out.recipeEdges.IGNITION = ignitionEdge;
  out.recipeEdges.BASING = basingEdge;
  out.recipeEdges.CARRY = carryEdge;

  const common = (label, mode, range, size, tp, sl, stop, wantedPct) => ({
    label, profile: 'TRADE', mode, shape: 'spot', range, widthBins: range.widthBins,
    widthPct: range.effectiveWidthPct, wantedPct, size, tp, sl, stop,
    edge: out.recipeEdges[label], edgeModel: 'pool-width heuristic; shape and execution costs unmodeled',
    edgeBasis: RATES.EDGE_BASIS,
  });
  if (dataFresh && ignitionRange && ignition({ edge: ignitionEdge, sg: d.surge, ac: d.accel, org: d.org, path: d.path, ageH: d.ageH, ofi: d.ofi })) {
    // W = the band's depth; for a one-sided (ofi > 2) band that is its full width
    const W = ignitionRange.effectiveWidthPct;
    const br = tradeBrackets('IGNITION', W, d.feeRate1h, ignitionMode);
    out.trade = common('IGNITION', ignitionMode, ignitionRange,
      ignitionEdge >= 2 ? c.sizeIgnitionHi : c.sizeIgnition, br.tp, br.sl, 0, ignitionWanted);
  } else if (dataFresh && basingRange && rawW <= c.basingMaxFloor
      && basing({ path: d.path, ofi: d.ofi, org: d.org, fr: d.feeRate1h, edge: basingEdge })) {
    const W = basingRange.effectiveWidthPct;
    const stop = d.px > 0 ? d.px * (1 - W / 100) * 0.98 : 0;
    const br = tradeBrackets('BASING', W, d.feeRate1h, 'two');
    out.trade = common('BASING', 'two', basingRange, c.sizeBasing, br.tp, br.sl, stop, Math.round(rawW));
  } else if (dataFresh && carryRange && carry({ edge: carryEdge, ofi6: d.ofi6, org: d.org, tvl: d.tvl,
    fr: d.feeRate1h, sigma: d.sigma, ageH: d.ageH, audit: d.audit || {}, path: d.path })) {
    const W = carryRange.effectiveWidthPct;
    const br = tradeBrackets('CARRY', W, d.feeRate1h, 'two');
    out.trade = common('CARRY', 'two', carryRange, c.sizeCarry, br.tp, br.sl, 0, 35);
  }

  const audit = d.audit || {};
  const mintAuthorityDisabled = typeof audit.mintAuthorityDisabled === 'boolean'
    ? audit.mintAuthorityDisabled : audit.mint_authority_disabled;
  const freezeAuthorityDisabled = typeof audit.freezeAuthorityDisabled === 'boolean'
    ? audit.freezeAuthorityDisabled : audit.freeze_authority_disabled;
  const topHoldersPct = finite(audit.topHoldersPercentage) ? audit.topHoldersPercentage
    : (finite(audit.top_holders_percentage) ? audit.top_holders_percentage : audit.topHoldersPct);
  const ba = bidAskSignal({
    ok: d.ok, ts: d.ts, supportedSolPair: d.supportedSolPair,
    mintAuthorityDisabled, freezeAuthorityDisabled, topHoldersPct,
    orgBuy1h: d.orgBuy1h, feeRate1h: d.feeRate1h, feeRate24h: d.feeRate24h, poolAgeH: d.poolAgeH,
    path: d.path, ofi1h: d.ofi, sigma: d.sigma, ddHigh: d.dd,
    candleAnalysis: d.candleAnalysis,
  }, now);
  const baRange = ba.depthPct == null ? null
    : downsideRange({ depthPct: ba.depthPct, binStepBps: d.binStepBps, maxBins: c.maxBins });
  out.bidAskStatus = { ...ba, range: baRange,
    executable: !!(ba.ready && baRange && baRange.executable && finite(c.sizeBidAsk) && c.sizeBidAsk > 0) };
  if (out.bidAskStatus.executable) {
    out.bidAsk = {
      label: 'BID_ASK', profile: 'ACCUM', mode: 'single', shape: 'hybrid', strategy: 'Bid-Ask + Spot',
      depthPct: ba.depthPct, widthPct: baRange.effectiveDepthPct, widthBins: baRange.requiredBins,
      wantedPct: ba.depthPct, size: c.sizeBidAsk,
      bidAskPct: ba.allocation.bidAskPct, spotPct: ba.allocation.spotPct,
      range: baRange, tp: 0, sl: 0, stop: 0,
      ready: true, baseReady: ba.baseReady,
      candleQualification: ba.candleQualification,
      candleAnalysis: ba.candleAnalysis,
      edge: null, edgeModel: 'unvalidated accumulation heuristic; no position-specific profitability model',
    };
  }
  return out;
}

function selectBidAskCandidates(entries, options = {}) {
  const now = finite(options.nowMs) ? options.nowMs : Date.now();
  const candleReadyAtNow = (entry, signal, status) => {
    const analysis = signal.candleAnalysis || entry.candleAnalysis || status.candleAnalysis;
    return !!analysis && qualifyBidAskCandle(analysis, { nowMs: now }).ready;
  };
  const selected = [];
  const seenMints = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const signal = entry && entry.sig;
    if (!signal || signal.label !== 'BID_ASK') continue;
    const dataTs = entry.dataTs;
    if (!finite(dataTs) || now < dataTs || now - dataTs > BID_ASK_FRESH_MS) continue;
    const status = entry.bidAskStatus || {};
    if (signal.ready !== true || !candleReadyAtNow(entry, signal, status)) continue;
    const capacityFit = signal.executable !== false
      && status.executable !== false
      && (!signal.range || signal.range.executable !== false)
      && (!status.range || status.range.executable !== false);
    if (!capacityFit) continue;
    const rawMint = entry.mint ?? entry.p?.token_x?.address ?? entry.p?.mint ?? entry.p?.address;
    const mint = String(rawMint || '');
    if (seenMints.has(mint)) continue;
    seenMints.add(mint);
    selected.push(entry);
  }
  return selected;
}

function selectBidAskHistoryCandidates(entries, options = {}) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 2;
  const now = finite(options.nowMs) ? options.nowMs : Date.now();
  const candleReadyAtNow = (entry) => {
    const signal = entry?.sig || entry?.evaluated?.bidAsk;
    const analysis = signal?.candleAnalysis || entry?.candleAnalysis
      || entry?.bidAskStatus?.candleAnalysis;
    return !!analysis && qualifyBidAskCandle(analysis, { nowMs: now }).ready;
  };
  const groups = new Map();
  let groupIndex = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const status = entry && entry.bidAskStatus;
    if (!status || status.baseReady !== true) continue;
    const rawMint = entry.mint ?? entry.p?.token_x?.address ?? entry.p?.mint ?? entry.p?.address;
    const mint = String(rawMint || '');
    if (!groups.has(mint)) groups.set(mint, { entries: [], index: groupIndex++ });
    groups.get(mint).entries.push(entry);
  }
  const selected = [];
  const orderedGroups = [...groups.values()].map((group) => {
    const qualified = group.entries.find((entry) => entry.bidAskStatus?.ready === true
      && entry.bidAskStatus?.executable === true
      && entry.bidAskStatus?.range?.executable === true
      && candleReadyAtNow(entry));
    const fit = qualified || group.entries.find((entry) => entry.bidAskStatus?.range?.executable === true);
    return {
      fit,
      qualified: !!qualified,
      collectedAt: fit ? Number(fit.candleCollectedAt || 0) : 0,
      index: group.index,
    };
  }).filter((group) => group.fit);
  orderedGroups.sort((a, b) => Number(b.qualified) - Number(a.qualified)
    || a.collectedAt - b.collectedAt || a.index - b.index);
  for (const group of orderedGroups) {
    const fit = group.fit;
    if (fit) selected.push(fit);
    if (selected.length >= max) break;
  }
  return selected;
}

function selectExecutionSignal(entries) {
  const all = Array.isArray(entries) ? entries : [];
  const trades = all.filter(x => x && x.sig && x.sig.label !== 'BID_ASK');
  if (!trades.length) return selectBidAskCandidates(all)[0] || null;
  const ratio = (x) => x.sig.widthPct / (x.sig.wantedPct || x.sig.widthPct || 1);
  return trades.slice().sort((a, b) => ratio(b) - ratio(a))[0] || null;
}

module.exports = {
  classifyPath, edgeFrom, edgeForRange, edgeForTradeRange, ignition, basing, basingFloor, carry,
  recipePlan, tradeBrackets, wouldFire,
  downsideRange, tradeRange, bidAskSignal, resolvePositionProfile,
  needsDeploymentResume, evaluateAccumLifecycle, signalsReady, updateFeeDecay, collectSignals,
  selectBidAskCandidates, selectBidAskHistoryCandidates, selectExecutionSignal,
  BID_ASK_FRESH_MS,
};
