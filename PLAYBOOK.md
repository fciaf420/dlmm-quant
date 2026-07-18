# DLMM Quant System — Canonical Playbook

Bot wallet: `<BOT_WALLET_PUBKEY>` (key: `<KEYPAIR_JSON_PATH>`, chmod 600)
RPC: `<RPC_URL_CONFIG>`. Node: `/opt/homebrew/bin/node`. SDK project: session `tmp/dlmm-quant` (reinstall: `npm i @meteora-ag/dlmm @solana/web3.js`).

## Stage 1 — DEPLOY (on scanner IGNITION alert)
1. Re-verify live: pool feeRate (1h×24), surge, OFI, organicScore. Abort if signal died.
2. Run bin-gap scorer: `node binscore.cjs <pool> <realizedVolPctPerDay>`
   → deploy into TOP-SCORE bins; skip/underweight the MOST CROWDED zones.
3. Sizing: base 0.5 SOL; STRONG (sharpe ≥ 1) → up to wallet balance − 0.1 SOL buffer.
   Half-life sizing: expected fees ≈ feeRate × t_half/ln(2) × 0.9. If expected fees < 3% of size, skip.
4. Skew from OFI: OFI < 0.5 (accumulation) → centered two-sided; 0.5–2 → mild downside cushion;
   > 2 (distribution) → single-sided SOL below only, or skip.
5. Execute via SDK (`initializePositionAndAddLiquidityByStrategy`, exact minBinId/maxBinId from binscore).
   Record: position address, entry feeRate, entry price, bins, size → needed by the manager.
6. Create the per-position manager routine (template below), 2-min interval, Sonnet (standard), full-access.

## Stage 1b — CARRY DEPLOY (on scanner CARRY alert)
Profile: calm token, persistent fees, organic accumulation, no catalyst. Different recipe than ignition scalps:
- Verify live: edge ≥ 1.3, OFI < 1, organic ≥ 60, mint+freeze authority disabled, TVL ≥ $100k.
- Run binscore with the (low) sigma — expect gap bins matter MORE here since traversal is slow; overweight thin bins near active.
- Shape: wide two-sided Spot, ±30-40% (durability over density). Size 0.4-0.6 SOL.
- Manager (10-min interval is enough, not 2-min): exits = fee-decay (feeRate < 50% of entry), OFI flip (> 3 sustained), plus DYNAMIC BRACKETS computed as in Stage 2 (carries typically land TP ~12-18%, SL ~-10-15% given low σ). No 15-min re-center — carry positions ride; re-center only if out-of-range > 4h.

## Stage 2 — PER-POSITION MANAGER (routine template)
Data each run: Meteora pnl endpoint (bot wallet), pool endpoint (feeRate, surge), Jupiter tokens search (OFI, realizedVol).
State: entryFeeRate, outOfRangeUpSince, peakPnl.

DYNAMIC BRACKETS (computed at deploy, recomputed on each re-center; replaces flat ±20):
- expectedHoldDays = t_half/ln2 (from scanner's fitted half-life; default 0.5 if unknown)
- TP% = clamp( max( 0.6 × netFeeRate × expectedHoldDays, 1.2 × σ × √expectedHoldDays ), 10, 40 )
- SL% = −clamp( σ × √expectedHoldDays, 10, 25 )
Record TP/SL at deploy in the manager's memory; the manager enforces the recorded values.

TERMINAL EXITS (SDK removeLiquidity 100% + claim-and-close; any non-SOL token swapped to SOL via Jupiter; notify; self-delete routine):
(a) TP: pnlSolPctChange ≥ recorded TP%
(b) SL floor break: poolActivePrice < position minPrice
(c) SL backstop: pnlSolPctChange ≤ recorded SL%
(d) DECAY-FRACTION: feeRate < 0.25 × entryFeeRate AND feeRate < 15 (term-structure exit — leave even if price fine)
(e) SURGE-DEAD + DISTRIBUTION: surge < 1.05 AND OFI(1h) > 2.5 while holding base token
(f) Profit trail: peakPnl ≥ +10 → exit if pnl ≤ peakPnl − 10

A-S RE-CENTER (when price above range ≥ 15 min, or on any rebalance):
- inv = baseTokenValue / totalPositionValue
- Width W%/side = clamp(realizedVol/4, 12, 30)
- inv < 0.15 → single-sided SOL ladder, range [−W, 0]
- inv ≥ 0.15 → ask-weighted: range [−W×(1−inv), +W×inv] two-sided (more room above the more base token held)
- Never blind-symmetric. After re-center: reset entryFeeRate to current, notify.
- HOLD (no exit) while price is in-range and filling — accumulation is intended; only the exits above fire.

## Stage 3 — LEARN
After every closed round trip, log to memory: entry sharpe/surge/OFI/half-life estimate, realized fees, PnL, exit trigger.
Recalibrate thresholds when ≥ 10 round trips accumulated.

## Capital allocation — concurrent sleeves
Bankroll = bot wallet balance. Always reserve 0.1 SOL for gas/rent.
- **CARRY sleeve: up to 50% of bankroll.** Deploys on CARRY alerts, rides long. Max 1 carry position per token; max 2 concurrent carries.
- **SCALP sleeve: the rest, kept LIQUID between ignitions.** Deploys on IGNITION alerts, exits fast, returns to cash. Max 2 concurrent scalps.
- Sleeves never cannibalize: an IGNITION does NOT auto-unwind a carry to free capital. If the scalp sleeve is too thin for a STRONG signal, notify the user (top-up or manual call).
- Both sleeves can run simultaneously — each position gets its own independent manager routine (2-min for scalps, 10-min for carries), each self-deleting on exit.
- Sizing within sleeves: scalps scale to edge (0.3 SOL at edge 1.0 → sleeve max at edge ≥ 2); carries 0.4-0.6 SOL flat.

## Standing rules
- All routines: Sonnet-class (standard), NEVER fast.
- Every exit ends 100% SOL in the bot wallet, zero token dust.
- Capital cap = bot wallet balance. Never touch any other wallet.
- All decisions grounded in live API numbers, never assumptions.
