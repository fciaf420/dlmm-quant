const test = require('node:test');
const assert = require('node:assert/strict');

const { runBidAskPhases, makeBidAskJournal, validateFundingRange, phaseLiquidity, reconcileSubmitted, matchesJournalRow, remainingPrincipalLamports } = require('../bid_ask_exec.cjs');

function plan() {
  return makeBidAskJournal({
    pool: 'POOL', mint: 'TOKEN', owner: 'OWNER', position: 'POSITION', positionSecret: [1, 2, 3],
    sizeLamports: 1_000_000_000, bidAskPct: 60, spotPct: 40,
    anchorBinId: 500, minBinId: 397, maxBinId: 500,
  });
}

test('a crash after broadcast resumes the same signature without rebuilding or duplicating a leg', async () => {
  const journal = plan();
  let builds = 0;
  let saves = 0;
  await assert.rejects(runBidAskPhases(journal, {
    save: async () => { saves++; },
    reconcile: async () => 'planned',
    validate: async () => {},
    build: async () => { builds++; return {}; },
    send: async (_tx, phase, beforeSend) => {
      await beforeSend({ signature: `${phase}-sig`, lastValidBlockHeight: 99 });
      throw new Error('simulated process death after broadcast');
    },
  }), /simulated process death/);
  assert.equal(journal.phases.create.status, 'submitted');
  assert.equal(journal.phases.create.signature, 'create-sig');
  assert.equal(builds, 1);
  assert.ok(saves >= 1);

  const builtOnResume = [];
  await runBidAskPhases(journal, {
    save: async () => {},
    reconcile: async (phase) => phase.signature === 'create-sig' ? 'confirmed' : 'planned',
    validate: async () => {},
    build: async (phase, fixed) => { builtOnResume.push({ phase, min: fixed.minBinId, max: fixed.maxBinId }); return {}; },
    send: async (_tx, phase, beforeSend) => {
      await beforeSend({ signature: `${phase}-sig`, lastValidBlockHeight: 100 });
      return `${phase}-sig`;
    },
  });
  assert.deepEqual(builtOnResume.map((x) => x.phase), ['bidAsk', 'spot']);
  assert.equal(journal.phases.create.status, 'confirmed');
  assert.equal(journal.phases.bidAsk.status, 'confirmed');
  assert.equal(journal.phases.spot.status, 'confirmed');
  assert.equal(journal.status, 'complete');
});

test('both funding legs keep the original bin IDs if active price moves between them', async () => {
  const journal = plan();
  const strategies = [];
  let active = 500;
  await runBidAskPhases(journal, {
    save: async () => {},
    reconcile: async () => 'planned',
    validate: async (phase, fixed) => {
      if (phase === 'spot') active = 510;
      assert.ok(active >= fixed.minBinId);
    },
    build: async (phase, fixed) => {
      if (phase !== 'create') strategies.push({ phase, min: fixed.minBinId, max: fixed.maxBinId, active });
      return {};
    },
    send: async (_tx, phase, beforeSend) => {
      await beforeSend({ signature: `${phase}-sig`, lastValidBlockHeight: 100 });
      return `${phase}-sig`;
    },
  });
  assert.deepEqual(strategies, [
    { phase: 'bidAsk', min: 397, max: 500, active: 500 },
    { phase: 'spot', min: 397, max: 500, active: 510 },
  ]);
  assert.equal(journal.bidAskLamports + journal.spotLamports, 1_000_000_000);
});

test('a moved active bin below the fixed range blocks the remaining SOL-only leg', async () => {
  const journal = plan();
  journal.phases.create.status = 'confirmed';
  journal.phases.bidAsk.status = 'confirmed';
  await assert.rejects(runBidAskPhases(journal, {
    save: async () => {},
    reconcile: async () => 'planned',
    validate: async (phase, fixed) => {
      if (phase === 'spot' && 390 < fixed.minBinId) throw new Error('active bin moved below fixed accumulation range');
    },
    build: async () => { throw new Error('must not build invalid leg'); },
    send: async () => { throw new Error('must not send invalid leg'); },
  }), /below fixed accumulation range/);
});

test('production range helper pauses if any fixed bin moved above active price', () => {
  const journal = plan();
  assert.doesNotThrow(() => validateFundingRange(journal, { lowerBinId: 397, upperBinId: 500 }, 510));
  assert.throws(() => validateFundingRange(journal, { lowerBinId: 397, upperBinId: 500 }, 499), /above the current active bin/);
  assert.throws(() => validateFundingRange(journal, { lowerBinId: 398, upperBinId: 500 }, 510), /on-chain range/);
});

test('production liquidity specs use one fixed position/range and exact total principal', () => {
  const journal = plan();
  const bidAsk = phaseLiquidity(journal, 'bidAsk', { BidAsk: 'BA', Spot: 'SPOT' });
  const spot = phaseLiquidity(journal, 'spot', { BidAsk: 'BA', Spot: 'SPOT' });
  assert.deepEqual(bidAsk, { minBinId: 397, maxBinId: 500, strategyType: 'BA', yLamports: 600_000_000 });
  assert.deepEqual(spot, { minBinId: 397, maxBinId: 500, strategyType: 'SPOT', yLamports: 400_000_000 });
  assert.equal(bidAsk.yLamports + spot.yLamports, journal.sizeLamports);
});

test('confirmed phases are surfaced so the registry can reserve partial positions', async () => {
  const journal = plan();
  const confirmed = [];
  await runBidAskPhases(journal, {
    save: async () => {},
    reconcile: async () => 'planned',
    validate: async () => {},
    build: async () => ({}),
    send: async (_tx, phase, beforeSend) => {
      await beforeSend({ signature: `${phase}-sig`, lastValidBlockHeight: 100 });
      return `${phase}-sig`;
    },
    onConfirmed: async (phase) => { confirmed.push(phase); },
  });
  assert.deepEqual(confirmed, ['create', 'bidAsk', 'spot']);
});

test('reconciliation searches transaction history before declaring a signature expired', async () => {
  const calls = [];
  const conn = {
    getSignatureStatuses: async (_sigs, opts) => {
      calls.push(opts);
      return { value: [{ confirmationStatus: 'finalized', err: null }] };
    },
    getBlockHeight: async () => { throw new Error('must not inspect height after historical confirmation'); },
  };
  const outcome = await reconcileSubmitted(conn, { signature: 'SIG', lastValidBlockHeight: 10 }, async () => {});
  assert.equal(outcome, 'confirmed');
  assert.deepEqual(calls, [{ searchTransactionHistory: true }]);
});

test('reconciliation retries only after a historically absent signature expires', async () => {
  const conn = {
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 11,
  };
  assert.equal(await reconcileSubmitted(conn, { signature: 'SIG', lastValidBlockHeight: 10 }, async () => {}), 'expired');
});

test('submitted funding is reconciled before remaining-principal affordability validation', async () => {
  const journal = plan();
  journal.phases.create.status = 'confirmed';
  journal.phases.bidAsk = { status: 'submitted', signature: 'BA-SIG', lastValidBlockHeight: 10 };
  const validations = [];
  await runBidAskPhases(journal, {
    save: async () => {},
    reconcile: async (phase) => phase.signature === 'BA-SIG' ? 'confirmed' : 'planned',
    validate: async (phase, current) => {
      validations.push({ phase, remaining: remainingPrincipalLamports(current) });
    },
    build: async () => ({}),
    send: async (_tx, phase, beforeSend) => {
      await beforeSend({ signature: `${phase}-sig`, lastValidBlockHeight: 20 });
      return `${phase}-sig`;
    },
  });
  assert.deepEqual(validations, [{ phase: 'spot', remaining: 400_000_000 }]);
});

test('a complete exact registry row may clean up a leftover complete journal without another send', async () => {
  const journal = plan();
  Object.values(journal.phases).forEach((phase) => { phase.status = 'confirmed'; });
  assert.equal(matchesJournalRow({ pool: 'POOL', position: 'POSITION', deploymentState: 'COMPLETE', funded: true }, journal), true);
  let sent = 0;
  await runBidAskPhases(journal, {
    save: async () => {}, reconcile: async () => { throw new Error('no reconcile'); },
    validate: async () => { throw new Error('no validate'); }, build: async () => { throw new Error('no build'); },
    send: async () => { sent++; },
  });
  assert.equal(sent, 0);
  assert.equal(journal.status, 'complete');
});

test('failed on-chain phase is retained and requires an explicit safe retry', async () => {
  const journal = plan();
  journal.phases.create = { status: 'submitted', signature: 'FAILED', lastValidBlockHeight: 10 };
  await assert.rejects(runBidAskPhases(journal, {
    save: async () => {}, reconcile: async () => 'failed', validate: async () => {}, build: async () => ({}), send: async () => '',
  }), /--retry-failed/);
  assert.equal(journal.phases.create.status, 'failed');

  const sent = [];
  await runBidAskPhases(journal, {
    retryFailed: true,
    save: async () => {}, reconcile: async () => 'planned', validate: async () => {}, build: async () => ({}),
    send: async (_tx, phase, beforeSend) => {
      sent.push(phase); await beforeSend({ signature: `${phase}-retry`, lastValidBlockHeight: 20 }); return `${phase}-retry`;
    },
  });
  assert.deepEqual(sent, ['create', 'bidAsk', 'spot']);
  assert.equal(journal.status, 'complete');
});
