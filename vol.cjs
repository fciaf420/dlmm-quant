// vol.cjs — realized-vol sigma + day structure from one 5m OHLCV call.
// Mirror of the meteora-quant-lens v0.5.0 sigma upgrade: the legacy
// max(|5m|*17, |1h|*4.9, |24h|) estimator both flapped (single-print noise,
// edge ~ 1/sigma^2 so one candle could 9x the edge between scans) AND
// systematically under-read vol on calm prints (a quiet 5m window on a
// genuinely violent token reads as "calm" -> inflated edge -> bad entries).
const MET = "https://dlmm.datapi.meteora.ag";

// EWMA realized vol from 5m closes, annualized to %/day.
function computeRealizedVol(candles) {
  const closes = [];
  for (const c of candles || []) {
    const cl = Number(c.close);
    if (isFinite(cl) && cl > 0) closes.push(cl);
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const recent = rets.slice(-48);          // last ~4h of 5m returns
  if (recent.length >= 6) {
    const lambda = 0.9;                    // newest return ~10% weight, half-life ~33min
    let v = 0, wsum = 0, w = 1;
    for (let i = recent.length - 1; i >= 0; i--) { v += w * recent[i] * recent[i]; wsum += w; w *= lambda; }
    return Math.sqrt(v / Math.max(wsum, 1e-12)) * Math.sqrt(288) * 100;  // per-5m -> %/day
  }
  // Young pool (<~35 min): Parkinson estimator on high-low ranges — ~5x more
  // information per candle than close-to-close, usable from 3 candles (~15 min).
  const hl = [];
  for (const c of candles || []) {
    const h = Number(c.high), l = Number(c.low);
    if (isFinite(h) && isFinite(l) && l > 0 && h >= l) hl.push(Math.log(h / l));
  }
  if (hl.length >= 3) {
    const m = hl.reduce((a, b) => a + b * b, 0) / hl.length;
    return Math.sqrt(m / (4 * Math.LN2)) * Math.sqrt(288) * 100;
  }
  return null;  // <15 min of candles: caller falls back to legacy estimator
}

// Two parallel calls (the datapi caps 5m range at ~8h, so one 24h/5m call 400s):
//   5m over 6h  -> realized vol (needs the last ~48 returns)
//   1h over 24h -> rolling day high/low structure (dd, rangePos, dayLow)
// fetchJson optional (daemon passes its jget for retry/backoff semantics).
async function fetchVolDay(poolAddress, fetchJson) {
  const now = Math.floor(Date.now() / 1000);
  const get = fetchJson || (async (u) => await (await fetch(u)).json());
  const arr = (o) => Array.isArray(o) ? o : ((o && (o.data || o.candles)) || []);
  const [ohRv, ohDay] = await Promise.all([
    get(`${MET}/pools/${poolAddress}/ohlcv?timeframe=5m&start_time=${now - 6 * 3600}&end_time=${now}`).catch(() => null),
    get(`${MET}/pools/${poolAddress}/ohlcv?timeframe=1h&start_time=${now - 86400}&end_time=${now}`).catch(() => null)
  ]);
  const rvC = arr(ohRv), dayC = arr(ohDay);
  let hi = -Infinity, lo = Infinity;
  for (const c of dayC) {
    const h = Number(c.high), l = Number(c.low);
    if (isFinite(h) && h > hi) hi = h;
    if (isFinite(l) && l > 0 && l < lo) lo = l;
  }
  // consolidation floor: lowest low of the recent 5m window (the base being
  // straddled), distinct from the DAY low which on a crash-then-rally chart can
  // sit multiples below the current base and make a structural stop unreachable
  let lo6 = Infinity;
  for (const c of rvC) { const l = Number(c.low); if (isFinite(l) && l > 0 && l < lo6) lo6 = l; }
  const closeSrc = rvC.length ? rvC : dayC;
  const close = closeSrc.length ? Number(closeSrc[closeSrc.length - 1].close) : NaN;
  const dd = (isFinite(hi) && hi > 0 && isFinite(close)) ? (hi - close) / hi * 100 : null;
  const pos = (isFinite(hi) && lo < Infinity && isFinite(close)) ? (close - lo) / Math.max(hi - lo, 1e-18) : null;
  return {
    rv: computeRealizedVol(rvC),
    dd, pos,
    low6h: lo6 < Infinity ? lo6 : null,
    low: lo < Infinity ? lo : null,
    close: isFinite(close) ? close : null
  };
}

// Age-aware sigma: RV primary, legacy single-print estimator as fallback only.
function sigmaFrom(rv, ageH, pc5, pc1, pc24) {
  if (rv != null && isFinite(rv) && rv > 0) return ageH < 24 ? Math.max(rv, 60) : rv;
  return ageH >= 24
    ? Math.max(Math.abs(pc5) * 17, Math.abs(pc1) * 4.9, Math.abs(pc24))
    : Math.max(Math.abs(pc5) * 17, Math.abs(pc1) * 4.9, 60);
}

module.exports = { computeRealizedVol, fetchVolDay, sigmaFrom };
