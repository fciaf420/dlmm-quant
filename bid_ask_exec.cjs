// Crash-resumable BID ASK phase runner. It has no RPC or filesystem side
// effects of its own so the transaction boundary can be tested with mocks.
const PHASES = ['create', 'bidAsk', 'spot'];

function makeBidAskJournal(input) {
  const total = Number(input.sizeLamports);
  const bidAskLamports = Math.floor(total * Number(input.bidAskPct) / 100);
  const spotLamports = total - bidAskLamports;
  if (!Number.isSafeInteger(total) || total <= 0 || bidAskLamports <= 0 || spotLamports <= 0) {
    throw new Error('invalid BID ASK principal/allocation');
  }
  return {
    version: 1,
    kind: 'BID_ASK',
    status: 'pending',
    createdAt: Date.now(),
    ...input,
    sizeLamports: total,
    bidAskLamports,
    spotLamports,
    phases: {
      create: { status: 'planned' },
      bidAsk: { status: 'planned' },
      spot: { status: 'planned' },
    },
  };
}

function validateFundingRange(journal, positionRange, activeBinId) {
  if (!positionRange || Number(positionRange.lowerBinId) !== Number(journal.minBinId)
      || Number(positionRange.upperBinId) !== Number(journal.maxBinId)) {
    throw new Error(`on-chain range does not match BID ASK journal ${journal.minBinId}..${journal.maxBinId}`);
  }
  if (!Number.isInteger(activeBinId)) throw new Error('current active bin unavailable');
  // Both layers are SOL/token-Y only. If active falls inside the saved range,
  // bins above it require token X and the requested hybrid can no longer be
  // laid down. Keep the range fixed and pause rather than recenter or misfund.
  if (activeBinId < journal.maxBinId) {
    throw new Error(`fixed BID ASK range has bins above the current active bin (${activeBinId} < ${journal.maxBinId}); resume after price recovers or close the partial position`);
  }
  return true;
}

function phaseLiquidity(journal, phase, strategyTypes) {
  if (phase !== 'bidAsk' && phase !== 'spot') throw new Error(`no liquidity spec for ${phase}`);
  return {
    minBinId: journal.minBinId,
    maxBinId: journal.maxBinId,
    strategyType: phase === 'bidAsk' ? strategyTypes.BidAsk : strategyTypes.Spot,
    yLamports: phase === 'bidAsk' ? journal.bidAskLamports : journal.spotLamports,
  };
}

function matchesJournalRow(row, journal) {
  return !!(row && journal && row.pool === journal.pool && row.position === journal.position);
}

function remainingPrincipalLamports(journal) {
  if (!journal || !journal.phases) return 0;
  return (journal.phases.bidAsk.status === 'confirmed' ? 0 : journal.bidAskLamports)
    + (journal.phases.spot.status === 'confirmed' ? 0 : journal.spotLamports);
}

async function reconcileSubmitted(conn, phase, confirm) {
  if (!phase || !phase.signature) return 'failed';
  const response = await conn.getSignatureStatuses([phase.signature], { searchTransactionHistory: true });
  const status = response && response.value && response.value[0];
  if (status && status.err) return 'failed';
  if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return 'confirmed';
  if (status) {
    try {
      await confirm(conn, phase.signature, 'BID ASK resume', phase.lastValidBlockHeight);
      return 'confirmed';
    } catch (e) {
      if (/failed on-chain/.test(String(e.message))) return 'failed';
      return 'pending';
    }
  }
  if (Number.isInteger(phase.lastValidBlockHeight)) {
    const height = await conn.getBlockHeight('confirmed');
    if (height > phase.lastValidBlockHeight) return 'expired';
  }
  return 'pending';
}

async function runBidAskPhases(journal, deps) {
  if (!journal || journal.kind !== 'BID_ASK' || !journal.phases) throw new Error('invalid BID ASK journal');
  for (const name of PHASES) {
    const phase = journal.phases[name];
    if (!phase) throw new Error(`BID ASK journal missing ${name} phase`);
    if (phase.status === 'confirmed') continue;
    if (phase.status === 'failed') {
      if (!deps.retryFailed) throw new Error(`${name} transaction failed on-chain; inspect the retained journal, then run deploy.cjs --resume --retry-failed to rebuild only this unexecuted phase`);
      phase.status = 'planned';
      delete phase.signature;
      delete phase.lastValidBlockHeight;
      await deps.save(journal);
    }
    if (phase.status === 'submitted') {
      const result = await deps.reconcile(phase, name, journal);
      if (result === 'confirmed') {
        phase.status = 'confirmed';
        phase.confirmedAt = Date.now();
        if (name === 'create') delete journal.positionSecret;
        await deps.save(journal);
        if (deps.onConfirmed) await deps.onConfirmed(name, journal);
        continue;
      }
      if (result === 'pending') throw new Error(`${name} transaction confirmation is still pending (${phase.signature})`);
      if (result !== 'expired') {
        phase.status = 'failed';
        phase.failedAt = Date.now();
        await deps.save(journal);
        throw new Error(`${name} transaction failed on-chain; inspect the retained journal, then run deploy.cjs --resume --retry-failed to rebuild only this unexecuted phase`);
      }
      phase.status = 'planned';
      delete phase.signature;
      delete phase.lastValidBlockHeight;
      await deps.save(journal);
    }
    await deps.validate(name, journal);
    const tx = await deps.build(name, journal);
    const signature = await deps.send(tx, name, async (meta) => {
      phase.status = 'submitted';
      phase.signature = meta.signature;
      phase.lastValidBlockHeight = meta.lastValidBlockHeight;
      phase.submittedAt = Date.now();
      await deps.save(journal);
    });
    phase.status = 'confirmed';
    phase.signature = signature || phase.signature;
    phase.confirmedAt = Date.now();
    if (name === 'create') delete journal.positionSecret;
    await deps.save(journal);
    if (deps.onConfirmed) await deps.onConfirmed(name, journal);
  }
  journal.status = 'complete';
  journal.completedAt = Date.now();
  await deps.save(journal);
  return journal;
}

module.exports = {
  PHASES, makeBidAskJournal, runBidAskPhases,
  validateFundingRange, phaseLiquidity, reconcileSubmitted,
  matchesJournalRow, remainingPrincipalLamports,
};
