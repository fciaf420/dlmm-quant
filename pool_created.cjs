// pool_created.cjs — backfill a pool's created_at for legacy shadow rows that were
// logged without poolAgeH/pAgeH, so replay.cjs and launchlab.cjs can apply the
// pool-age fee correction (rates.cjs legacyRowToV1) to them too.
//
// created_at is immutable, so each pool is fetched from the public datapi at most
// once ever and cached in pool-created.json (gitignored). Read-only, wallet-free,
// no config.cjs. Network failures leave that pool unresolved (its rows stay
// uncorrected and are COUNTED by the caller) - never a crash. `enabled: false`
// (replay/launchlab --no-backfill) resolves from the cache file only.
const fs = require('fs');

const DATAPI = 'https://dlmm.datapi.meteora.ag';

function createPoolCreatedResolver(options = {}) {
  const cacheFile = options.cacheFile || null;
  const enabled = options.enabled !== false;
  const throttleMs = Number.isFinite(options.throttleMs) ? options.throttleMs : 80;
  const baseUrl = String(options.baseUrl || DATAPI).replace(/\/$/, '');
  const fetchJson = options.fetchJson || (async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let cache = {};
  if (cacheFile) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch (e) { cache = {}; }
  }
  const stats = { cached: 0, fetched: 0, failed: 0, skipped: 0 };

  async function resolve(addresses) {
    const unique = [...new Set((addresses || []).filter(Boolean).map(String))];
    let dirty = false;
    for (const address of unique) {
      if (cache[address] != null) { stats.cached++; continue; }
      if (!enabled) { stats.skipped++; continue; }
      try {
        const json = await fetchJson(`${baseUrl}/pools/${encodeURIComponent(address)}`);
        const created = Number(json && (json.created_at ?? json.createdAt));
        if (Number.isFinite(created) && created > 0) { cache[address] = created; stats.fetched++; dirty = true; }
        else stats.failed++;
      } catch (e) { stats.failed++; }
      if (throttleMs > 0) await sleep(throttleMs);
    }
    if (dirty && cacheFile) {
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) {}
    }
    return stats;
  }

  const createdAt = (address) => (cache[String(address)] ?? null);
  return { resolve, createdAt, stats };
}

// rows that still need a backfilled age: legacy fee basis and no logged pool age
const needsPoolAge = (row, feeBasis) => !!row && row.fb !== feeBasis
  && !Number.isFinite(row.poolAgeH) && !Number.isFinite(row.pAgeH) && !!row.pool;

module.exports = { createPoolCreatedResolver, needsPoolAge };
