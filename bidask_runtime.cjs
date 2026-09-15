'use strict';

const GATES = require('./gates.cjs');

function addressOf(candidate) {
  return String(candidate?.address || candidate?.p?.address || '');
}

async function refreshBidAskCandidates(candidates, options = {}) {
  const diagnostics = options.diagnostics;
  if (!diagnostics || typeof diagnostics.collect !== 'function'
      || typeof diagnostics.getAnalysis !== 'function') {
    throw new Error('diagnostics with collect/getAnalysis is required');
  }
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const collectSignals = options.collectSignals || GATES.collectSignals;
  const config = options.config || {};
  const all = Array.isArray(candidates) ? candidates : [];
  const selected = GATES.selectBidAskHistoryCandidates(all, {
    max: Number.isInteger(options.max) && options.max > 0 ? options.max : 2,
    nowMs: nowMs(),
  });

  await diagnostics.collect(selected.map((candidate) => ({
    address: addressOf(candidate),
    name: candidate.name || candidate.p?.name || addressOf(candidate),
    poolCreatedAt: candidate.poolCreatedAt,
    recentCandles: candidate.recentCandles,
  })));

  const refreshed = [];
  for (const candidate of selected) {
    const address = addressOf(candidate);
    const analysis = diagnostics.getAnalysis(address);
    const data = { ...(candidate.data || {}), candleAnalysis: analysis || null };
    let evaluated = null;
    let error = null;
    try {
      evaluated = collectSignals({
        now: nowMs(),
        data,
        config: candidate.config || config,
      });
    } catch (caught) {
      error = caught;
    }
    refreshed.push({ ...candidate, data, candleAnalysis: analysis || null, evaluated, error });
  }

  const selectedSet = new Set(selected);
  return {
    selected,
    refreshed,
    deferred: all.filter((candidate) => !selectedSet.has(candidate)),
  };
}

module.exports = { addressOf, refreshBidAskCandidates };
