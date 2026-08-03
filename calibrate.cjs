// calibrate.cjs — per-class bracket calibration report from trades.json.
// Usage: node calibrate.cjs
//
// PROPOSE-ONLY: prints suggested TP/SL per class; never edits config. Apply
// accepted proposals yourself via .env (TP_IGNITION / SL_CARRY / etc.).
//
// Data hygiene: every CLI trade is signal-driven by construction (the daemon
// only deploys on gate-passing signals), so this dataset is origin-pure and
// per-class tuning from it satisfies the calibration-contamination rule.
// Proposals are gated on n >= 20 per class; below that the report is
// descriptive only.
//
// PnL preference: official SOL-denominated PnL from Meteora's closed-position
// rollup (settled lazily here, cached back into trades.json; the bot wallet IS
// the on-chain owner so the rollup query just works) > the daemon's last-tick
// pnlPctAtExit.
const fs = require('fs');
const { keypair } = require('./config.cjs');
const DIR = __dirname;
const WALLET = keypair().publicKey.toBase58();
const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const f2 = (v) => v == null ? '—' : v.toFixed(1);

(async () => {
  const f = DIR + '/trades.json';
  const tj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  if (!tj.length) { console.log('trades.json is empty — it accrues automatically as the daemon exits positions.'); return; }

  // settle official SOL pnl once per row (cached back into the journal)
  let dirty = false;
  for (const t of tj) {
    if (t.officialPnlSolPct != null || !t.position || !t.pool) continue;
    try {
      const r = await (await fetch(`https://dlmm.datapi.meteora.ag/positions/${t.pool}/pnl?user=${WALLET}&status=closed&page_size=50`)).json();
      const hit = (r.positions || []).find((x) => x.positionAddress === t.position);
      if (hit) {
        t.officialPnlSolPct = +(+hit.pnlSolPctChange).toFixed(2);
        t.officialPnlSol = +(+hit.pnlSol).toFixed(6);
        dirty = true;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (dirty) fs.writeFileSync(f, JSON.stringify(tj, null, 1));

  console.log(`trades.json: ${tj.length} closed trades | wallet ${WALLET.slice(0, 6)}…\n`);
  for (const cls of [...new Set(tj.map((t) => t.label))]) {
    const T = tj.filter((t) => t.label === cls);
    const pnls = T.map((t) => t.officialPnlSolPct ?? t.pnlPctAtExit).filter((x) => x != null);
    const trig = {};
    for (const t of T) { const k = String(t.exitTrigger || '?').split(' ')[0]; trig[k] = (trig[k] || 0) + 1; }
    const wins = pnls.filter((x) => x > 0), losses = pnls.filter((x) => x < 0).map(Math.abs);
    console.log(`=== ${cls} — ${T.length} trades ===`);
    console.log('  exit triggers:', Object.entries(trig).map(([k, v]) => `${k}×${v}`).join('  '));
    if (pnls.length) {
      console.log(`  pnl (SOL%%): win ${wins.length}/${pnls.length} | avg ${f2(pnls.reduce((a, b) => a + b, 0) / pnls.length)} | p25 ${f2(pct(pnls, .25))} | med ${f2(pct(pnls, .5))} | p75 ${f2(pct(pnls, .75))} | p90 ${f2(pct(pnls, .9))}`);
      if (T.length >= 20) {
        console.log(`  PROPOSAL: TP ≈ p75 of winners = ${f2(pct(wins, .75))}%% | SL ≈ p90 of losses = ${f2(pct(losses, .9))}%%`);
        console.log(`            review, then apply via .env: TP_${cls}= / SL_${cls}= (SL positive)`);
      } else {
        console.log(`  n=${T.length} < 20 — descriptive only, no proposal yet`);
      }
    }
    console.log('');
  }
  console.log('Reading the trigger mix: TP× high = brackets working; FEE-DECAY× dominant = fees are the');
  console.log('real exit (TP likely too far); SL× high with quick recoveries = stops too tight; OOR-UP×');
  console.log('high = pump-outs booking the cap — nominal TP above W/4+fees is decorative for that class.');
})();
