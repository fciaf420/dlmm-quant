'use strict';

const fs = require('fs');
const { createCandleHistoryLoader } = require('./candle_analysis.cjs');

function compactCandleEvidence(analysis) {
  if (!analysis) return { state: 'NOT_COLLECTED' };
  if ((analysis.state !== 'READY' && analysis.state !== 'LIMITED') || !analysis.events) {
    return { state: analysis.state || 'WAIT', reason: analysis.reason || 'history-unavailable' };
  }
  return {
    state: analysis.state,
    hours: analysis.historyHours,
    completed: analysis.completedCandles,
    expectedAvailable: analysis.expectedAvailableCandles,
    coveragePct: analysis.coveragePct,
    coverageVerified: analysis.coverageVerified === true,
    historyBasis: analysis.historyBasis,
    total: analysis.events.total,
    matured: analysis.events.matured,
    recovered: analysis.events.recovered,
    timedOut: analysis.events.timedOut,
    pending: analysis.events.pending,
    recoveryRatePct: analysis.events.recoveryRatePct,
    medianDepthPct: analysis.medianDepthPct,
    medianRecoveryMinutes: analysis.medianRecoveryMinutes,
    currentDrawdownPct: analysis.currentDrawdownPct,
    recentVolumeRatio: analysis.recentVolumeRatio,
    recentVolumeRatioRaw: analysis.recentVolumeRatioRaw,
    volumeBaselineHours: analysis.volumeBaselineHours,
    latestCompletedTs: analysis.latestCompletedTs,
    lastRecoveryTs: analysis.lastRecoveryTs,
    lastRecoveryMinutes: analysis.lastRecoveryMinutes,
    support15mReady: analysis.support15m?.ready === true,
    note: analysis.note,
  };
}

function createCandleDiagnostics(options = {}) {
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const maxPools = Number.isInteger(options.maxPools) && options.maxPools > 0 ? options.maxPools : 8;
  const maxPerBatch = Number.isInteger(options.maxPerBatch) && options.maxPerBatch > 0
    ? options.maxPerBatch : 2;
  const cacheFile = options.cacheFile || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const fetchJson = options.fetchJson || (async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response || !response.ok) throw new Error(`candle HTTP ${response ? response.status : '?'}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  });
  const loader = createCandleHistoryLoader({ fetchJson, nowMs, maxPools });
  const records = new Map();
  const primed = new Set();
  let job = null;

  if (cacheFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : [];
      rows.sort((a, b) => Number(a.collectedAt || 0) - Number(b.collectedAt || 0));
      for (const row of rows.slice(-maxPools)) {
        if (row && row.address && Array.isArray(row.candles)
            && (row.analysis?.state === 'READY' || row.analysis?.state === 'LIMITED')) {
          records.set(String(row.address), row);
        }
      }
    } catch (e) {}
  }

  const touch = (address, record) => {
    records.delete(address);
    records.set(address, record);
    while (records.size > maxPools) records.delete(records.keys().next().value);
  };

  const persist = () => {
    if (!cacheFile) return;
    const usable = [...records.values()].filter(row => row
      && (row.analysis?.state === 'READY' || row.analysis?.state === 'LIMITED'));
    const tmp = cacheFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(usable, null, 1));
      fs.renameSync(tmp, cacheFile);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (ignored) {}
    }
  };

  const normalizeCandidates = (candidates) => {
    const seen = new Set();
    return (Array.isArray(candidates) ? candidates : []).filter(candidate => {
      const address = String(candidate?.address || '');
      if (!address || seen.has(address)) return false;
      seen.add(address);
      return true;
    }).map((candidate, index) => ({ candidate, index,
      collectedAt: Number(records.get(String(candidate.address))?.collectedAt || 0) }))
      .sort((a, b) => a.collectedAt - b.collectedAt || a.index - b.index)
      .slice(0, maxPerBatch).map(row => row.candidate);
  };

  async function collect(candidates) {
    const selected = normalizeCandidates(candidates);
    for (const candidate of selected) {
      const address = String(candidate.address);
      const prior = records.get(address);
      if (!primed.has(address)) {
        primed.add(address);
        if (prior && Array.isArray(prior.candles)) {
          loader.seed(address, prior.candles, { poolCreatedAt: candidate.poolCreatedAt ?? prior.poolCreatedAt });
        } else if (Array.isArray(candidate.recentCandles) && candidate.recentCandles.length) {
          loader.seed(address, candidate.recentCandles, { poolCreatedAt: candidate.poolCreatedAt });
        }
      }
      const result = await loader.load(address, { poolCreatedAt: candidate.poolCreatedAt });
      const usable = result.analysis.state === 'READY' || result.analysis.state === 'LIMITED';
      touch(address, {
        address,
        poolCreatedAt: candidate.poolCreatedAt ?? null,
        collectedAt: nowMs(),
        analysis: result.analysis,
        candles: usable ? result.candles : (prior?.candles || []),
      });
    }
    persist();
    return selected.map(candidate => {
      const row = records.get(String(candidate.address));
      const evidence = compactCandleEvidence(row?.analysis);
      if (row) evidence.collectedAt = row.collectedAt;
      return { address: String(candidate.address), name: candidate.name || String(candidate.address), evidence };
    });
  }

  function schedule(candidates) {
    if (job) return job;
    job = new Promise(resolve => {
      setTimeout(resolve, 0);
    }).then(() => collect(candidates)).catch(error => {
      if (typeof options.onError === 'function') options.onError(error);
      return [];
    }).finally(() => { job = null; });
    return job;
  }

  function get(address) {
    const row = records.get(String(address || ''));
    const evidence = compactCandleEvidence(row?.analysis);
    if (row) {
      evidence.collectedAt = row.collectedAt;
      const latestExpected = Math.floor(nowMs() / 1000 / 300) * 300 - 300;
      if ((evidence.state === 'READY' || evidence.state === 'LIMITED')
          && (!Number.isFinite(Number(evidence.latestCompletedTs))
            || Number(evidence.latestCompletedTs) < latestExpected)) {
        return { state: 'STALE', reason: 'stale-history',
          latestCompletedTs: evidence.latestCompletedTs, collectedAt: row.collectedAt };
      }
    }
    return evidence;
  }

  // Full analysis is intentionally separate from get(): the compact payload is
  // safe for logs and the persisted board, while the gate needs the complete
  // causal fields (coverage, active event, support buckets, and raw volume).
  function getAnalysis(address) {
    const row = records.get(String(address || ''));
    return row?.analysis || null;
  }

  return { collect, schedule, get, getAnalysis };
}

module.exports = { compactCandleEvidence, createCandleDiagnostics };
