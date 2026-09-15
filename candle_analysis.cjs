(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MQLCandleAnalysis = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_TIMEFRAME_SEC = 300;
  const DEFAULT_EXPECTED_BARS = 288;
  const DEFAULT_WINDOW_SEC = 6 * 3600;
  const NOTE = 'historical candle evidence; recovery statistics are descriptive, not a profit forecast';

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const round = (v, places = 2) => {
    if (!finite(v)) return null;
    const p = 10 ** places;
    return Math.round(v * p) / p;
  };
  const median = (values) => {
    const a = values.filter(finite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const rowsOf = (value) => {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.candles)) return value.candles;
    return [];
  };
  const requiredNumber = (value) => value === null || value === undefined || value === '' ? NaN : Number(value);
  const creationTimeSec = (value) => {
    const n = requiredNumber(value);
    if (!finite(n) || n < 0) return NaN;
    return n > 100_000_000_000 ? n / 1000 : n;
  };
  const sameCandle = (a, b) => ['open', 'high', 'low', 'close', 'volume']
    .every((key) => Number(a[key]) === Number(b[key]));

  function normalizeCompletedCandles(input, options = {}) {
    const timeframeSec = Number(options.timeframeSec) || DEFAULT_TIMEFRAME_SEC;
    const expectedBars = Number(options.expectedBars) || DEFAULT_EXPECTED_BARS;
    const nowMs = finite(options.nowMs) ? options.nowMs : Date.now();
    const currentBucket = Math.floor(nowMs / 1000 / timeframeSec) * timeframeSec;
    const latestExpected = currentBucket - timeframeSec;
    const fullDayEarliest = latestExpected - (expectedBars - 1) * timeframeSec;
    const createdValue = creationTimeSec(options.poolCreatedAt);
    const creationKnown = finite(createdValue) && createdValue >= 0 && createdValue <= currentBucket;
    const firstFullAfterCreation = creationKnown ? Math.ceil(createdValue / timeframeSec) * timeframeSec : null;
    let earliestExpected = creationKnown ? Math.max(fullDayEarliest, firstFullAfterCreation) : fullDayEarliest;
    const byTs = new Map();
    let invalidCount = 0;
    let conflictCount = 0;

    for (const raw of rowsOf(input)) {
      const timestamp = requiredNumber(raw && raw.timestamp);
      if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 100_000_000_000) {
        invalidCount++;
        continue;
      }
      // The API includes the current forming bucket. Ignore it (and later buckets)
      // before validating OHLC fields, because incomplete fields are expected there.
      if (timestamp >= currentBucket || timestamp < fullDayEarliest) continue;
      const open = requiredNumber(raw && raw.open);
      const high = requiredNumber(raw && raw.high);
      const low = requiredNumber(raw && raw.low);
      const close = requiredNumber(raw && raw.close);
      const volume = requiredNumber(raw && raw.volume);
      if (timestamp % timeframeSec !== 0
          || !finite(open) || !finite(high) || !finite(low) || !finite(close) || !finite(volume)
          || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
          || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
        invalidCount++;
        continue;
      }
      const row = { timestamp, open, high, low, close, volume };
      const prior = byTs.get(timestamp);
      if (prior && !sameCandle(prior, row)) conflictCount++;
      else byTs.set(timestamp, row);
    }

    let candles = [...byTs.values()].filter((c) => c.timestamp >= earliestExpected)
      .sort((a, b) => a.timestamp - b.timestamp);
    let historyBasis = creationKnown ? 'known pool age' : '24h target';
    let confidence = creationKnown ? 'limited history' : 'full history';
    let expectedAvailableBars = earliestExpected <= latestExpected
      ? Math.floor((latestExpected - earliestExpected) / timeframeSec) + 1 : 0;
    let coverageVerified = creationKnown;
    if (!creationKnown && candles.length > 0 && candles.length < expectedBars
        && candles[candles.length - 1].timestamp === latestExpected) {
      // Without pool metadata a contiguous short response is useful descriptively,
      // but it cannot prove the API returned everything since pool creation.
      earliestExpected = candles[0].timestamp;
      expectedAvailableBars = Math.floor((latestExpected - earliestExpected) / timeframeSec) + 1;
      historyBasis = 'pool creation unavailable';
      confidence = 'unverified start';
      coverageVerified = false;
    }
    candles = candles.filter((c) => c.timestamp >= earliestExpected);
    const latestCompletedTs = candles.length ? candles[candles.length - 1].timestamp : null;
    const missingBars = Math.max(0, expectedAvailableBars - candles.length);
    let gapCount = 0;
    for (let ts = earliestExpected; ts <= latestExpected; ts += timeframeSec) {
      if (!byTs.has(ts)) gapCount++;
    }
    let coveragePct = coverageVerified && expectedAvailableBars > 0
      ? round(100 * Math.min(candles.length, expectedAvailableBars) / expectedAvailableBars, 1) : null;
    const fullDayCoveragePct = round(100 * Math.min(candles.length, expectedBars) / expectedBars, 1);
    const historyHours = round(candles.length * timeframeSec / 3600, 2);
    let reason = null;
    if (invalidCount || conflictCount) reason = 'invalid-candles';
    else if (latestCompletedTs == null || latestCompletedTs < latestExpected) reason = 'stale-history';
    else if (candles.length < 2) reason = 'insufficient-history';
    else if (candles.length < expectedAvailableBars && candles[0].timestamp > earliestExpected) reason = 'insufficient-history';
    else if (gapCount) reason = 'gapped-history';

    let state = 'READY';
    if (reason) state = 'WAIT';
    else if (candles.length < expectedBars) state = 'LIMITED';
    if (state === 'READY') {
      historyBasis = 'complete trailing 24h';
      confidence = 'full history';
      coverageVerified = true;
      coveragePct = 100;
    }

    return {
      state,
      reason,
      candles,
      timeframeSec,
      expectedBars,
      currentBucket,
      earliestExpected,
      latestExpected,
      latestCompletedTs,
      completedCandles: candles.length,
      expectedAvailableCandles: expectedAvailableBars,
      missingBars,
      gapCount,
      invalidCount,
      conflictCount,
      coveragePct,
      fullDayCoveragePct,
      historyHours,
      historyBasis,
      confidence,
      coverageVerified,
    };
  }

  function emptyAnalysis(prepared, reason) {
    return {
      state: 'WAIT',
      reason: reason || prepared.reason || 'insufficient-history',
      note: NOTE,
      timeframe: prepared.timeframeSec === 300 ? '5m' : prepared.timeframeSec + 's',
      completedCandles: prepared.completedCandles || 0,
      expectedCandles: prepared.expectedBars || DEFAULT_EXPECTED_BARS,
      expectedAvailableCandles: prepared.expectedAvailableCandles || 0,
      coveragePct: prepared.coveragePct == null ? 0 : prepared.coveragePct,
      fullDayCoveragePct: prepared.fullDayCoveragePct == null ? 0 : prepared.fullDayCoveragePct,
      historyHours: prepared.historyHours || 0,
      historyBasis: prepared.historyBasis || 'unavailable',
      confidence: 'unavailable',
      coverageVerified: false,
      gapCount: prepared.gapCount || 0,
      invalidCount: prepared.invalidCount || 0,
      conflictCount: prepared.conflictCount || 0,
      latestCompletedTs: prepared.latestCompletedTs == null ? null : prepared.latestCompletedTs,
      currentDrawdownPct: null,
      recentVolumeRatio: null,
      recentVolumeRatioRaw: null,
      volumeBaselineHours: 0,
      volumeKind: 'total pool volume',
      events: null,
      completedEvents: [],
      activeEvent: null,
      lastRecoveryTs: null,
      lastRecoveryMinutes: null,
      support15m: null,
      medianDepthPct: null,
      medianRecoveryMinutes: null,
      drawdownReference: 'available-history completed-close high',
      depthStatistic: 'median maximum close drawdown within the 6h outcome window',
      eventDefinition: {
        triggerDrawdownPct: 5,
        recoveryPct: 80,
        deadlineMinutes: 360,
        priceField: 'close',
        recoveryOrigin: 'trigger time',
      },
    };
  }

  function analyzeCandleHistory(input, options = {}) {
    const prepared = normalizeCompletedCandles(input, options);
    if (prepared.state === 'WAIT') return emptyAnalysis(prepared);
    const candles = prepared.candles;
    const triggerDrawdownPct = finite(options.triggerDrawdownPct) ? options.triggerDrawdownPct : 5;
    const recoveryFraction = finite(options.recoveryFraction) ? options.recoveryFraction : 0.8;
    const deadlineMinutes = finite(options.deadlineMinutes) ? options.deadlineMinutes : 360;
    const deadlineSec = deadlineMinutes * 60;
    let peak = candles[0].close;
    let active = null;
    const completed = [];
    let pending = null;

    for (const c of candles) {
      const close = c.close;
      if (!active) {
        if (close > peak) peak = close;
        const drawdownPct = 100 * (peak - close) / peak;
        if (drawdownPct >= triggerDrawdownPct) {
          active = {
            peak,
            startTs: c.timestamp,
            trough: close,
            maxDepthPct: drawdownPct,
            timedOut: false,
          };
        }
        continue;
      }

      if (close < active.trough) active.trough = close;
      active.maxDepthPct = Math.max(active.maxDepthPct, 100 * (active.peak - close) / active.peak);
      const elapsedSec = c.timestamp - active.startTs;
      const recoveryTarget = active.trough + recoveryFraction * (active.peak - active.trough);
      if (close >= recoveryTarget) {
        if (!active.timedOut && elapsedSec <= deadlineSec) {
          completed.push({
            status: 'recovered',
            startTs: active.startTs,
            endTs: c.timestamp,
            maxDepthPct: active.maxDepthPct,
            recoveryMinutes: elapsedSec / 60,
          });
        } else if (!active.timedOut) {
          completed.push({
            status: 'timedOut',
            startTs: active.startTs,
            endTs: c.timestamp,
            maxDepthPct: active.maxDepthPct,
            recoveryMinutes: null,
          });
        }
        active = null;
        peak = close;
      } else if (!active.timedOut && elapsedSec >= deadlineSec) {
        active.timedOut = true;
        completed.push({
          status: 'timedOut',
          startTs: active.startTs,
          endTs: c.timestamp,
          maxDepthPct: active.maxDepthPct,
          recoveryMinutes: null,
        });
      }
    }

    if (active && !active.timedOut) {
      pending = {
        status: 'pending',
        maxDepthPct: active.maxDepthPct,
        ageMinutes: (candles[candles.length - 1].timestamp - active.startTs) / 60,
      };
    }

    const recovered = completed.filter((e) => e.status === 'recovered');
    const timedOut = completed.filter((e) => e.status === 'timedOut');
    const matured = recovered.length + timedOut.length;
    const lastClose = candles[candles.length - 1].close;
    const closeHigh = Math.max(...candles.map((c) => c.close));
    const currentDrawdownPct = 100 * Math.max(0, closeHigh - lastClose) / closeHigh;

    const lastHour = candles.slice(-12).reduce((sum, c) => sum + c.volume, 0);
    const prior = candles.slice(0, -12);
    const hourly = [];
    for (let i = 0; i + 12 <= prior.length; i += 12) {
      hourly.push(prior.slice(i, i + 12).reduce((sum, c) => sum + c.volume, 0));
    }
    const typicalHour = median(hourly);
    const recentVolumeRatio = typicalHour != null && typicalHour > 0 ? lastHour / typicalHour : null;

    // Three wall-clock-aligned, fully closed 15m buckets. Support uses the
    // minimum completed 5m CLOSE in each bucket, keeping this causal and
    // consistent with the close-based pullback/recovery event definition.
    const candleByTs = new Map(candles.map((c) => [c.timestamp, c]));
    const lastClosed15Start = Math.floor(prepared.currentBucket / 900) * 900 - 900;
    const supportBuckets = [];
    for (let start = lastClosed15Start - 1800; start <= lastClosed15Start; start += 900) {
      const block = [0, 300, 600].map((offset) => candleByTs.get(start + offset));
      if (block.every(Boolean)) supportBuckets.push({
        startTs: start,
        closeLow: Math.min(...block.map((c) => c.close)),
      });
    }
    const supportComparisons = supportBuckets.length === 3 ? [
      supportBuckets[1].closeLow >= supportBuckets[0].closeLow,
      supportBuckets[2].closeLow >= supportBuckets[1].closeLow,
    ] : [];
    const lastCandle = candles[candles.length - 1];
    const activeEvent = active ? {
      startTs: active.startTs,
      ageMinutes: round((lastCandle.timestamp - active.startTs) / 60),
      depthPct: round(100 * (active.peak - active.trough) / active.peak),
      recoveryProgressPct: round(100 * (lastCandle.close - active.trough)
        / Math.max(active.peak - active.trough, Number.EPSILON)),
      recovering: lastCandle.close > active.trough,
      timedOut: active.timedOut,
    } : null;
    const lastRecoveryTs = recovered.length ? recovered[recovered.length - 1].endTs : null;

    return {
      state: prepared.state,
      reason: null,
      note: NOTE,
      timeframe: prepared.timeframeSec === 300 ? '5m' : prepared.timeframeSec + 's',
      completedCandles: prepared.completedCandles,
      expectedCandles: prepared.expectedBars,
      expectedAvailableCandles: prepared.expectedAvailableCandles,
      coveragePct: prepared.coveragePct,
      fullDayCoveragePct: prepared.fullDayCoveragePct,
      historyHours: prepared.historyHours,
      historyBasis: prepared.historyBasis,
      confidence: prepared.confidence,
      coverageVerified: prepared.coverageVerified,
      gapCount: prepared.gapCount,
      invalidCount: prepared.invalidCount,
      conflictCount: prepared.conflictCount,
      latestCompletedTs: prepared.latestCompletedTs,
      currentDrawdownPct: round(currentDrawdownPct),
      recentVolumeRatio: round(recentVolumeRatio),
      recentVolumeRatioRaw: recentVolumeRatio,
      volumeBaselineHours: hourly.length,
      volumeKind: 'total pool volume',
      events: {
        total: matured + (pending ? 1 : 0),
        matured,
        recovered: recovered.length,
        timedOut: timedOut.length,
        pending: pending ? 1 : 0,
        recoveryRatePct: matured ? round(100 * recovered.length / matured, 1) : null,
      },
      completedEvents: completed.map((event) => ({
        status: event.status,
        startTs: event.startTs,
        endTs: event.endTs,
        maxDepthPct: round(event.maxDepthPct),
        recoveryMinutes: round(event.recoveryMinutes),
      })),
      activeEvent,
      lastRecoveryTs,
      lastRecoveryMinutes: lastRecoveryTs == null ? null
        : round((lastCandle.timestamp - lastRecoveryTs) / 60),
      support15m: {
        bucketSeconds: 900,
        priceField: 'close',
        buckets: supportBuckets,
        comparisons: supportComparisons,
        comparisonsPassed: supportComparisons.filter(Boolean).length,
        ready: supportComparisons.length === 2 && supportComparisons.every(Boolean),
      },
      sampleNote: matured < 3 ? 'small sample; descriptive counts are not a win probability' : 'descriptive historical count, not a win probability',
      medianDepthPct: round(median(completed.map((e) => e.maxDepthPct))),
      medianRecoveryMinutes: round(median(recovered.map((e) => e.recoveryMinutes))),
      drawdownReference: prepared.state === 'READY'
        ? '24h completed-close high' : 'available-history completed-close high',
      depthStatistic: 'median maximum close drawdown within the 6h outcome window',
      eventDefinition: {
        triggerDrawdownPct,
        recoveryPct: round(recoveryFraction * 100),
        deadlineMinutes,
        priceField: 'close',
        recoveryOrigin: 'trigger time',
      },
    };
  }

  function qualifyBidAskCandle(analysis, options = {}) {
    const nowMs = finite(options.nowMs) ? options.nowMs : Date.now();
    const timeframeSec = Number(options.timeframeSec) || DEFAULT_TIMEFRAME_SEC;
    const latestExpected = Math.floor(nowMs / 1000 / timeframeSec) * timeframeSec - timeframeSec;
    const usable = !!analysis && (analysis.state === 'READY'
      || (analysis.state === 'LIMITED' && analysis.coverageVerified === true))
      && !!analysis.events;
    const active = usable ? analysis.activeEvent : null;
    const gates = {
      fresh: usable && analysis.latestCompletedTs === latestExpected,
      history: usable,
      volume: usable && finite(finite(analysis.recentVolumeRatioRaw)
        ? analysis.recentVolumeRatioRaw : analysis.recentVolumeRatio)
        && (finite(analysis.recentVolumeRatioRaw)
          ? analysis.recentVolumeRatioRaw : analysis.recentVolumeRatio) >= 0.5
        && Number(analysis.volumeBaselineHours) >= 1,
      repeatedRecoveries: usable && analysis.events.recovered >= 2,
      recentRecovery: usable && finite(analysis.lastRecoveryMinutes)
        && analysis.lastRecoveryMinutes >= 0 && analysis.lastRecoveryMinutes <= 180,
      support: usable && analysis.support15m?.ready === true,
      cycle: usable && (!active || (active.timedOut === false && active.recovering === true)),
    };
    const ready = Object.values(gates).every(Boolean);
    return {
      state: ready ? 'QUALIFIED' : 'WATCH',
      ready,
      checkedAtMs: nowMs,
      heuristic: true,
      gates,
      reasons: Object.entries(gates).filter(([, pass]) => !pass).map(([key]) => key),
      note: 'candle qualification gates BID ASK entry; recovery statistics remain descriptive, not a profit forecast',
    };
  }

  function createCandleHistoryLoader(options = {}) {
    if (typeof options.fetchJson !== 'function') throw new Error('fetchJson is required');
    const fetchJson = options.fetchJson;
    const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
    const timeframeSec = Number(options.timeframeSec) || DEFAULT_TIMEFRAME_SEC;
    const expectedBars = Number(options.expectedBars) || DEFAULT_EXPECTED_BARS;
    const windowSec = Number(options.windowSec) || DEFAULT_WINDOW_SEC;
    const maxPools = Number.isInteger(options.maxPools) && options.maxPools > 0 ? options.maxPools : 12;
    const baseUrl = String(options.baseUrl || 'https://dlmm.datapi.meteora.ag').replace(/\/$/, '');
    const cache = new Map();
    const inflight = new Map();

    const isContinuous = (candles) => candles.every((c, i) => i === 0
      || c.timestamp - candles[i - 1].timestamp === timeframeSec);

    const touch = (address, entry) => {
      cache.delete(address);
      cache.set(address, entry);
      while (cache.size > maxPools) cache.delete(cache.keys().next().value);
    };
    const waitResult = (reason, entry) => {
      const prepared = entry
        ? normalizeCompletedCandles(entry.candles, { nowMs: nowMs(), timeframeSec, expectedBars })
        : { timeframeSec, expectedBars, completedCandles: 0, coveragePct: 0, gapCount: 0,
          invalidCount: 0, conflictCount: 0, latestCompletedTs: null };
      return { analysis: emptyAnalysis(prepared, reason), candles: entry ? entry.candles.slice() : [] };
    };

    async function loadOnce(address, loadOptions = {}) {
      address = String(address || '');
      if (!address) return waitResult('invalid-pool');
      const now = nowMs();
      const currentBucket = Math.floor(now / 1000 / timeframeSec) * timeframeSec;
      const createdValue = creationTimeSec(loadOptions.poolCreatedAt);
      const creationKnown = finite(createdValue) && createdValue >= 0 && createdValue <= currentBucket;
      const desiredStart = Math.max(currentBucket - expectedBars * timeframeSec,
        creationKnown ? Math.ceil(createdValue / timeframeSec) * timeframeSec : 0);
      let entry = cache.get(address);
      if (entry && entry.bucket === currentBucket && entry.poolCreatedAt === (creationKnown ? createdValue : null)
          && (!entry.seeded || entry.analysis.state !== 'WAIT')) {
        touch(address, entry);
        return { analysis: entry.analysis, candles: entry.candles.slice() };
      }

      const canTail = entry && entry.candles.length && isContinuous(entry.candles)
        && (!entry.analysis || (entry.analysis.invalidCount === 0 && entry.analysis.conflictCount === 0
          && entry.analysis.reason !== 'gapped-history'))
        && entry.candles[0].timestamp <= desiredStart
        && currentBucket - entry.candles[entry.candles.length - 1].timestamp <= windowSec;
      const canPrepend = entry && entry.candles.length && isContinuous(entry.candles)
        && (!entry.analysis || (entry.analysis.invalidCount === 0 && entry.analysis.conflictCount === 0
          && entry.analysis.reason !== 'gapped-history'))
        && entry.poolCreatedAt === (creationKnown ? createdValue : null)
        && entry.candles[0].timestamp > desiredStart
        && entry.candles[entry.candles.length - 1].timestamp === currentBucket - timeframeSec;
      const windows = [];
      if (canTail) {
        windows.push([entry.candles[entry.candles.length - 1].timestamp, currentBucket]);
      } else if (canPrepend) {
        for (let start = desiredStart; start < entry.candles[0].timestamp; start += windowSec) {
          windows.push([start, Math.min(start + windowSec, entry.candles[0].timestamp)]);
        }
      } else {
        for (let start = desiredStart; start < currentBucket; start += windowSec) {
          windows.push([start, Math.min(start + windowSec, currentBucket)]);
        }
      }

      const fetched = [];
      try {
        for (const [start, end] of windows) {
          const url = baseUrl + '/pools/' + encodeURIComponent(address)
            + '/ohlcv?timeframe=5m&start_time=' + start + '&end_time=' + end;
          const response = await fetchJson(url);
          if (response && response.ok === false) throw new Error(response.error || 'fetch failed');
          const value = response && response.ok === true && response.json !== undefined ? response.json : response;
          fetched.push(...rowsOf(value));
        }
      } catch (e) {
        return waitResult('fetch-failed', entry);
      }

      let merged = (entry && (canTail || canPrepend) ? entry.candles : []).concat(fetched);
      const analysisOptions = { nowMs: now, timeframeSec, expectedBars,
        poolCreatedAt: creationKnown ? createdValue : undefined };
      let preparedWithAge = normalizeCompletedCandles(merged, analysisOptions);
      const leadingBoundaryMissing = preparedWithAge.state === 'WAIT'
        && preparedWithAge.reason === 'insufficient-history'
        && preparedWithAge.invalidCount === 0 && preparedWithAge.conflictCount === 0
        && preparedWithAge.gapCount === 1
        && preparedWithAge.completedCandles === preparedWithAge.expectedAvailableCandles - 1
        && preparedWithAge.candles[0]?.timestamp === preparedWithAge.earliestExpected + timeframeSec
        && preparedWithAge.latestCompletedTs === preparedWithAge.latestExpected;
      if (leadingBoundaryMissing) {
        // The API can omit a real zero-volume candle when the requested range
        // starts exactly on that bucket. Ask once more with one candle of prior
        // context; accept only the real returned row through normal validation.
        try {
          const start = preparedWithAge.earliestExpected - timeframeSec;
          const end = preparedWithAge.earliestExpected + timeframeSec;
          const url = baseUrl + '/pools/' + encodeURIComponent(address)
            + '/ohlcv?timeframe=5m&start_time=' + start + '&end_time=' + end;
          const response = await fetchJson(url);
          if (response && response.ok === false) throw new Error(response.error || 'repair fetch failed');
          const value = response && response.ok === true && response.json !== undefined ? response.json : response;
          merged = merged.concat(rowsOf(value));
          preparedWithAge = normalizeCompletedCandles(merged, analysisOptions);
        } catch (e) {}
      }
      const analysis = preparedWithAge.state !== 'WAIT'
        ? analyzeCandleHistory(preparedWithAge.candles, analysisOptions)
        : emptyAnalysis(preparedWithAge);
      entry = { bucket: currentBucket, candles: preparedWithAge.candles, analysis,
        poolCreatedAt: creationKnown ? createdValue : null, seeded: false };
      touch(address, entry);
      return { analysis, candles: preparedWithAge.candles.slice() };
    }

    function load(address, loadOptions = {}) {
      const normalizedAddress = String(address || '');
      const bucket = Math.floor(nowMs() / 1000 / timeframeSec) * timeframeSec;
      const created = creationTimeSec(loadOptions.poolCreatedAt);
      const key = normalizedAddress + ':' + bucket + ':' + (finite(created) ? created : 'unknown');
      if (inflight.has(key)) return inflight.get(key);
      const pending = loadOnce(normalizedAddress, loadOptions).finally(() => inflight.delete(key));
      inflight.set(key, pending);
      return pending;
    }

    function seed(address, candles, loadOptions = {}) {
      address = String(address || '');
      if (!address) return null;
      const now = nowMs();
      const createdValue = creationTimeSec(loadOptions.poolCreatedAt);
      const creationKnown = finite(createdValue) && createdValue >= 0;
      const analysisOptions = { nowMs: now, timeframeSec, expectedBars,
        poolCreatedAt: creationKnown ? createdValue : undefined };
      const prepared = normalizeCompletedCandles(candles, analysisOptions);
      const analysis = prepared.state !== 'WAIT'
        ? analyzeCandleHistory(prepared.candles, analysisOptions)
        : emptyAnalysis(prepared);
      const entry = {
        bucket: prepared.latestCompletedTs == null ? -1 : prepared.latestCompletedTs + timeframeSec,
        candles: prepared.candles,
        analysis,
        poolCreatedAt: creationKnown ? createdValue : null,
        seeded: true,
      };
      touch(address, entry);
      return analysis;
    }

    const snapshot = (address) => {
      const entry = cache.get(String(address || ''));
      return entry ? entry.candles.slice() : [];
    };

    return { load, seed, snapshot, clear: () => cache.clear() };
  }

  return {
    DEFAULT_TIMEFRAME_SEC,
    DEFAULT_EXPECTED_BARS,
    normalizeCompletedCandles,
    analyzeCandleHistory,
    qualifyBidAskCandle,
    createCandleHistoryLoader,
  };
});
