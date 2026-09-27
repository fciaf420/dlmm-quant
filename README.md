# dlmm-quant

**An autonomous market-making bot for [Meteora DLMM](https://meteora.ag) on Solana.**
It scans the configured top-volume pool universe, evaluates explicit signal rules, deploys through Meteora, and manages each position by its saved strategy profile. One process, no UI.

```bash
git clone https://github.com/fciaf420/dlmm-quant && cd dlmm-quant
npm install
cp .env.example .env   # add your RPC url, wallet key, and free Jupiter API key
npm run screen         # safe read-only test: scan the board, see every verdict
npm start              # go live
```

> ⚠️ Use a **dedicated wallet with only what you're willing to lose**. Memecoin LPing can go to zero.
> The bot closes *every* position it finds in a pool it exits — on a shared wallet that includes positions you opened by hand.

---

## The core idea (read this even if you skip everything else)

When you LP a DLMM pool, you're not "earning yield" — **you're selling insurance against price movement**. Fees are the premium you collect; impermanent loss is the claim you pay out when price actually moves. Most LPs never check whether the premium covers the claims.

The TRADE profiles use this pool-level screening approximation for a uniform band of half-width `W` (±W%):

```
expected IL/day ≈ σ² / 4W        (σ = realized volatility, %/day; W = half-width, %)
```

This gives the TRADE screener a fee-versus-volatility comparison:

```
edge = (LP fee rate / σ)  ÷  (1.3 × σ / 4W)   =   LP fee rate ÷ (1.3 × expected IL)
```

**Edge math fix (2026-09-27).** The formula used to be `σ²/8W` with an extra `×0.9` protocol haircut. Both were wrong, and together they overstated every edge by 9/5:

- A uniform ±W band's delta falls linearly across 2W, so gamma = V/2W and E[IL] = ½·gamma·σ² = **σ²/4W** (the same answer as Uniswap-v3's narrow-range LVR). A DLMM bin simulation (uniform liquidity per bin, W=20%) fits IL ≈ 1.42·ln(p)² vs 1/(4w)=1.25 vs the old 1/(8w)=0.625, so σ²/4W is, if anything, still slightly generous.
- Meteora's `fee_tvl_ratio` is **already net of the protocol cut**: on SOL-USDC with a 0.04% base fee, `fees/volume` = 0.0382% (below the minimum fee, so it cannot be gross) and `(fees + protocol_fees)/volume` = 0.0424%. Protocol share ≈ 10% standard / ≈20% on launch pools, already taken out.

**One rule for any band:** in-range IL/day = **σ² / (2 × full width)**, full width = max − min in %. Two-sided ±W has full width 2W → σ²/4W (above). A **one-sided** band (0 → −W, e.g. IGNITION when OFI > 2) holds the same capital in half the width, so its in-range IL is σ²/2W: twice the gamma, **half the edge** on the same fees. Edge assumes capital earns the pool fee rate while active, so IL must be the in-range IL too (`rates.cjs` `ilPerDayForRange`; `gates.cjs` `edgeForTradeRange`).

Thresholds were **not** retuned: `edge ≥ 1.0` now honestly means LP fees ≥ 1.3× modeled IL. On identical inputs every two-sided edge is 5/9 of what the pre-fix daemon printed (entries need ~1.8× the fees), and one-sided IGNITION edges are 5/18. Shadow rows carry `eb: 'il4w-net-v1'` (which includes the one-sided rule). `replay.cjs` and `launchlab.cjs` convert older rows through one shared helper (`rates.cjs` `legacyRowToV1`): ×5/9, ×0.5 more when the row's band was identifiably one-sided, and the pool-age fee fix when the pool's age at that row is known (logged, or backfilled once per pool from its immutable `created_at` into `pool-created.json`; `--no-backfill` for offline runs). Rows that can't be identified are counted in the summary line, never silently mixed.

`edge ≥ 1.0` is the configured heuristic threshold. It is not a profit forecast. The model does not include exact bin shape, directional inventory, swap/priority fees, slippage, rewards, or position-specific fill path. BID ASK is an accumulation profile and does not use this symmetric TRADE proxy.

Two properties of edge worth internalizing:

- **It scales linearly with width `W`.** The gate now uses the geometric width represented by the bins the recipe will actually deploy. A requested width that is narrowed by the bin budget no longer receives credit for the wider setting.
- **It scales inversely with σ².** A vol estimate 20% too low inflates edge by ~56%. Which is why σ is measured, not guessed:

## σ — measured, not guessed

Realized volatility comes from actual price candles, in a three-tier quality ladder:

1. **EWMA realized vol** — last ~4h of 5-minute closes, exponentially weighted (λ=0.9, ~33min half-life). The default whenever ≥6 returns exist.
2. **Parkinson** — for pools under ~35 minutes old. Estimates vol from each candle's high-low *range*, which carries ~5x more information per candle, so it works from just 3.
3. **Legacy single-print estimator** — last resort under ~15 minutes. Both noisy *and* biased: it systematically under-reads vol on calm prints, which inflates edge exactly when you least want it.

Readings are tagged by source. Volatility compression remains a same-source diagnostic; it is not an entry signal.

If σ falls back to the legacy estimator on 2+ *mature* tokens in one scan, candle data is broken, every edge that cycle was computed on a bad instrument, and **the bot logs `DEGRADED SIGMA` and refuses to deploy that cycle.** It doesn't trade on data it doesn't trust.

## The signals (what the bot reads every scan)

| Signal | Question it answers | Source |
|---|---|---|
| **feeRate** | What's the pool paying *right now* (last hour annualized), not yesterday? Pool-age-aware: see *Young pools* below | Meteora Data API |
| **σ (sigma)** | How violently does this thing actually move? | OHLCV candles (see above) |
| **edge** | Do fees beat expected IL? | computed |
| **surge** | Is the on-chain dynamic-fee accumulator elevated? DLMM raises fees during volatility — deploy when the premium is surged, not after it decays | Meteora |
| **accel** | Is volume accelerating (30-min pace vs 4-hour pace) or fading? Catalysts, not leftovers | Meteora |
| **OFI** | Are *organic* wallets (Jupiter filters out bots) net buying or net selling? Don't be someone's exit liquidity | Jupiter |
| **path** | Where is price in its recent story? Labels each pool `FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP` | OHLCV |

### Young pools (pool age, not token age)

Meteora's windows (30m, 1h, 2h, 4h, 12h, 24h) can only cover the time the **pool** has existed. On a 1.7h-old pool the 2h/4h/12h/24h numbers are all the same since-creation total. Every window-based rate is divided by the hours it actually covered (`value × 24 ÷ min(window, pool age)`, 15-minute floor), in `rates.cjs`:

| Pool age | Treatment |
|---|---|
| under 1h | **Launch hold**: no class deploys (fee rate is minutes of launch trading), scan gives these pools no slot. `launchwatch.cjs` still observes them and tags `launchHold`. |
| 1h–24h | Real %/day; the "24h" normal (BID ASK fee persistence, FEE-DECAY's below-normal guard) is fees since launch ÷ pool age. |
| 24h+ | Unchanged. |

Caught live on NEARPAD-SOL (2026-09-27): 6.4% of fees in 1.7h was read as 6.4%/day (really ~91%/day). That failed BID ASK fee persistence on nearly every sub-day pool and stamped `entryFeeRate24h` so low that FEE-DECAY could not arm on young-pool positions. Registry rows are now stamped `feeBasis: 'pool-age-v1'`; older rows are rescaled by pool age at `openedAt` when read (never rewritten). Accel had the same bug (fixed 4h divisor, ~2.4× inflated on a 1.7h pool).

### Completed-candle pullback evidence

The public Meteora Data API also supplies a descriptive 5-minute history for BID
ASK candidates. The measured event is explicit: a 5% close-based drawdown and an
80% recovery of the peak-to-trough move within six hours of the trigger. Output
separates recovered, timed-out, and still-observing events and includes median
maximum drop, median recovery time, current completed-close drawdown, and the
last hour's **total pool volume** versus prior complete hours. That volume is not
Jupiter organic flow.

Full 24-hour history is preferred. A known young pool is measured only from its
first full 5-minute bucket and labeled `LIMITED`; a gap after pool creation is
`WAIT`. Pool creation age and token age are kept separate. Unknown creation with
less than a verified full day stays `WATCH`; an unknown-age history can qualify
when the returned coverage is a complete full day. Small-sample counts come
before the descriptive recovery fraction, which is not a win probability.

The candle result is an actionable BID ASK gate. In addition to the base snapshot
checks above, a READY entry needs the latest completed 5-minute bucket, verified
contiguous coverage, at least 0.5x the median of prior complete hourly total
volume (with one baseline hour), two distinct completed 5% dip / 80% recovery
events with one recovery within three hours, and three wall-clock-aligned fully
closed 15-minute buckets. Each support low is the minimum of that bucket's
three completed 5-minute closes; the three support lows must be nondecreasing,
and no failed active cycle may remain. An active
non-timed-out dip may remain eligible only while the latest close is above its
running trough. Missing or stale evidence is `WATCH`/`WAIT` and cannot alert or
deploy. The evidence contains no fee or PnL model. Inspect one pool without
loading config, a wallet, or Jupiter credentials:

```bash
npm run candles -- <POOL_ADDRESS>
npm run candles -- <POOL_ADDRESS> --json
```

`screen.cjs` refreshes at most two current BID ASK candidates for its read-only
preview. When no fresh TRADE is available, the daemon refreshes at most two
deduplicated, capacity-fitting histories before BID ASK selection, oldest or
uncollected first; other base-ready candidates remain `WATCH` and rotate through
the persistent cache on later scans. Completed history is reused and only the
5-minute tail is requested.

## The automated profiles

**🔥 IGNITION** — an event-driven scalp. Fees clear the bar (edge ≥ 1) *and* the fee accumulator is surged *and* volume is accelerating. Never fires into a FREEFALL (huge fees during a crash are bait). Width scales with σ; brackets are computed from the pool's own vol and fee rate.

**🧲 BASING** — the reversion play. Token is down 40%+ from its high, the 5-minute chart has flattened, organic wallets are absorbing, and fees are still rich.

The band's **bottom is placed *on* the consolidation floor** (the recent 5-minute low) rather than at a fixed width — so price leaving the band downward *is* the base breaking, and the structural stop sits just beneath it. The setup requires that floor to be **within 25% of price**: if the nearest floor is a third of the way down, there is no base to straddle and the trade is skipped. The PnL stop is a far backstop rather than the primary rule — a mean-reversion straddle is structurally long the dip, so a tight PnL stop fights its own premise.

**🛡 CARRY** — boring on purpose. Mature token (3+ days), mint & freeze authority burned, big TVL, calm price, organic buyers on the 6-hour window, decent persistent fees. Wide ±35% range, rides for days. The fee floor is tiered: thin yield is only acceptable when risk-adjusted quality is exceptional.

**🪣 BID ASK** — a quote-only accumulation profile. It is surfaced independently, so the same pool may show both a TRADE class and BID ASK. READY requires a fresh, complete snapshot; a non-SOL token X quoted in wrapped SOL token Y; mint and freeze authority disabled; top-holder concentration ≤35%; positive organic buy volume; 24h fee rate ≥8%/day with the 1h rate at least half of that; no unbought FREEFALL (`OFI ≥1.43`); and the completed-candle evidence gate described above. These are uncalibrated strategy priors, not evidence of profitability.

The requested band runs from the active bin down 60–75%, with depth mapped from σ and drawdown. Total principal is split 60–80% **BidAsk** and the remainder **Spot**, both added as SOL/token-Y to the same position and the same fixed bin IDs. `SIZE_BID_ASK=1` is the total across both layers. Deep widths use DLMM's geometric bin spacing; if the full range needs more than `MAX_BINS`, the bot reports `CAPACITY WAIT` and does not substitute a shallower trade.

Execution keeps the existing TRADE family first when both profiles qualify. BID ASK is eligible for deployment when no executable TRADE remains; among BID ASK candidates, exact token mints are deduplicated, capacity-fitting siblings are retained, and fee-rate/input order remains the tiebreak rather than treating geometric bin rounding as a profitability score.

Existing SQUEEZE rows remain TRADE positions and retain their saved exits/time-stop. New volatility-compression observations are diagnostic only: passive Bid-Ask liquidity does not provide a generic long-vol payoff that wins on either breakout direction.

### Cap-aware take-profits

In the replay's simplified uniform two-sided payoff model, price-driven gain approaches a cap of **about W/4** once inventory has converted to SOL (a DLMM bin simulation gives 4.5% vs 5% at W=20% and 7.4% vs 8.75% at W=35%, so it is slightly optimistic for wide bands).

**One-sided bands (IGNITION when OFI > 2) get their own brackets.** A SOL-only 0 → −W band has **zero** price-driven upside (above the band it is 100% SOL, unchanged), so its TP is the fee term alone, and at the band bottom it has lost ~0.5W, not ~0.75W (SOL-only ladder, equal SOL per log-spaced bin: 6.13 / 10.37 / 15.89% at W = 12 / 20 / 30, vs 9.06 / 15.19 / 22.94% two-sided). IGNITION one-sided: TP = clamp(fee×0.5, 4, 25), SL = clamp(0.5W + 2, 8, 20). Two-sided brackets are unchanged (`gates.cjs` `tradeBrackets`). Note that `.env` `TP_IGNITION` / `SL_IGNITION` still override both sides. The TRADE recipes use that approximation to avoid setting brackets far beyond their modeled band payoff. Actual reachability still depends on DLMM bin shape, fill path, fees, slippage, and costs; pump-outs are normally booked by the out-of-range rule.

## The lifecycle

```
every ~14 min  SCAN    top-volume board → filters → shared profile gates
                        (cadence is configurable)
                 │
on signal      DEPLOY  TRADE: Jupiter swap + one Meteora position
                        BID ASK: create one fixed range → confirmed BidAsk layer
                        → confirmed Spot layer; each phase is journaled before send
                 │
every 2 min    MANAGE  each open position against its saved profile:
                        ✓ take-profit           ✓ stop-loss / structural stop
                        ✓ out-of-range          ✓ fee-decay
                        ✓ flow-flip             ✓ legacy squeeze time-stop
                        BID ASK: WAIT on either fee decay or distribution;
                        EXIT only when both are true on current valid data
                 │
on trigger     EXIT    close 100% → sweep every token to SOL → journal the
                        round trip to trades.json
                 │
               repeat  (2h re-entry cooldown per pool)
```

While held, BID ASK deliberately accumulates token inventory and can become fully token-side. Its exit rule is separate from scalp TP/SL; when that rule fires, the existing exit path closes the LP and sweeps token inventory back to SOL.

### The exit rules, in detail

- **Fee-decay** — the 1h rate falls below 50% of your entry rate **and** below the pool's own 24h normal, two ticks running. Both conditions matter: the scanner ranks by fee rate, so entries systematically land on *spikes*, and a spike merely reverting to normal is not the fee engine dying. (Without the second condition, positions were being closed while still paying a healthy 7%/day.)
- **Out-of-range** — no liquidity at the active bin means no fee income. Up books the gain (TP is unreachable from outside the band anyway); down cuts dead exposure. Requires 2 consecutive ticks to filter wicks — **except** when the position is already past 60% of its stop, where waiting is the expensive choice and it exits immediately.
- **Flow-flip** — organic sellers >3:1 while price drops >15%/hour. Real wallets are exiting through your bid.
- **Structural stop** — the price level that invalidates the thesis (for BASING, the base itself).
- **Squeeze time-stop** — a coil that hasn't sprung in 24h isn't going to; stop paying rent.

For `profile: ACCUM`, TP, SL, structural-stop, FREEFALL, and out-of-range exits do not apply. Fee decay must persist for two distinct valid snapshots, and the bot exits only when that decay and hard organic distribution are both present. If fee or organic-flow inputs are missing, management reports `DATA_WAIT` and does not infer zero. A position whose first layer is still deploying is resumed before ordinary management and is never mistaken for an external close during indexer lag.

Out-of-range is computed from **the bot's own recorded bin range**, not the indexer's flag — a position's true range is something it ordered and verified, not something it needs to be told.

## Tuning (`.env`)

Every operational number lives in `.env`; defaults reproduce the behavior above, so an empty file is a no-op.

```bash
# cadence
TICK_MS=120000          # manage every tick (2 min)
SCAN_EVERY=7            # scan every Nth tick (7 × 2min ≈ 14 min)

# universe
MIN_TVL=60000
MIN_VOL_24H=150000
SCAN_TOP_N=8            # candidates examined per scan, ranked by fee rate
COOLDOWN_H=2

# sizing, in SOL
MAX_POSITIONS=2
SIZE_IGNITION=0.3       SIZE_IGNITION_HI=0.4    # HI used when edge ≥ 2
SIZE_BASING=0.3         SIZE_CARRY=0.4          SIZE_BID_ASK=1

# exit rulebook
FEE_DECAY_FRAC=0.5      # exit below this fraction of the entry fee rate…
FEE_DECAY_VS_NORM=1     # …and below the pool's 24h normal (spike-bias guard)
FLOW_OFI=3              FLOW_PC1=-15            # flow-flip thresholds
OOR_TICKS=2             OOR_DEEP_FRAC=0.6       # out-of-range persistence / deep-loss bypass
SQZ_TIMEOUT_H=24
BASING_MAX_FLOOR=25     # BASING needs a floor within this % of price

# per-class bracket overrides (SL positive; 0 = use the class formula)
TP_IGNITION= SL_IGNITION= TP_BASING= SL_BASING= TP_CARRY= SL_CARRY=
```

Bracket overrides apply at **deploy time** and are stamped into the registry, so changes affect new positions only — what you entered on is what you're managed by.

> Values are read at startup: **restart the daemon after editing `.env`.** Inline comments are stripped, but a malformed number logs a warning and falls back to the default rather than failing silently.

## Learning from its own trades

Two analysis tools, both propose-only — neither ever edits config.

### `node calibrate.cjs` — what actually happened

Reads `trades.json` (every closed round trip, with the class, entry fee baseline, brackets, and exit trigger), lazily settles official SOL-denominated PnL from Meteora's closed-position rollup, and prints per-class exit-trigger distributions and PnL percentiles. At **n ≥ 20 per TRADE class** it proposes TP/SL values (p75 of winners, p90 of losses) for you to review and apply via `.env`. ACCUM outcomes remain descriptive because its lifecycle has no TP/SL brackets.

Reading the trigger mix is half the value: `TP` heavy means brackets are working; `FEE-DECAY` dominant means fees are the real exit and TP is set too far; `OOR-UP` heavy means pump-outs are booking the cap.

### `node replay.cjs` — what *would* have happened

The scanner evaluates ~8 pools every scan and, without this, throws every rejection away — which means only ever learning from trades you took. That's survivorship bias in your own data.

Instead, every evaluation (signal *or* rejection) is appended to `shadow.jsonl` with all its inputs, at **zero extra API cost** — it's data already in hand. `replay.cjs` then simulates each observation forward against the pool's **real price path** (30m candles) and **real fee series**, applies the daemon's own exit rules, and caches results permanently.

Output is an edge → outcome calibration curve per TRADE class: bucket, n, win rate, mean PnL, trigger mix — plus a suggested entry gate (the lowest bucket clearing measured friction at n ≥ 10) and a **near-miss audit** comparing setups blocked *only* by surge/accel against full passes. BID ASK rows are explicitly excluded until the replay models its two-shape inventory and conjunctive exit lifecycle.

Hundreds of labeled observations per day, versus a handful of real trades per week. It also ingests `shadow-*.jsonl` exports from the companion [Meteora Quant Lens](https://github.com/fciaf420/meteora-quant-lens) extension, deduped.

## Safety rails

- **Wallet balance is the hard cap** — the bot can't spend what isn't there, and refuses deploys without rent plus a configurable fee buffer
- Max **2 concurrent positions**, **1 per pool**, 2h cooldown after exiting a pool
- **Atomic deploy lock + registry dedup** — even multiple accidental daemon instances can't double-spend
- **Single-instance heartbeat lock** — a second daemon exits itself at startup
- **`touch STOP`** — graceful shutdown within one tick
- **Degraded-data suppression** — a scan cycle whose vol data is untrustworthy deploys nothing
- **Exact swap-delta accounting** — deposits only what *this* deploy's swap bought, never the wallet's total balance of that mint, so pre-existing holdings can't be swept into a bot position
- **Crash-safe swaps** — a swap that succeeds but whose position fails journals its output; the retry reuses those exact tokens instead of buying again
- **Crash-safe BID ASK phases** — the deterministic signature is journaled before each broadcast; restart reconciliation checks transaction history before any retry, and the position/range never regenerates between layers
- **Blockhash-expiry retry** — heavy position-opens get 3 attempts with fresh blockhashes (expiry means nothing executed, so re-signing is safe)
- **Rate-limit retry** — Jupiter 429s back off and retry rather than killing the deploy
- **Range verification** — an extended position whose on-chain bin range doesn't match the order is *never funded*; the unfunded position stays registered so its rent is recoverable
- **External-close detection** — close a position by hand and the daemon notices, journals it, and cleans its registry
- Keys never leave your machine; everything reads from `.env` (gitignored)

If a partial BID ASK deployment must be abandoned, stop the daemon first. Reconcile every submitted signature so none remains ambiguous, close the partial position and confirm that cleanup on-chain, then archive or remove `.pending-bid-ask.json`. Deleting the journal before those steps removes the executor's idempotency record.

## CLI reference

```bash
npm start                                # the daemon
npm run screen                           # one-shot preview of the configured top candidate set
npm test                                 # mock-only strategy/recovery regression tests
node calibrate.cjs                       # per-class results from real trades
node replay.cjs [--max 150] [--no-backfill]  # entry-gate calibration curves from shadow observations
node candle-analysis.cjs <POOL> [--json] # public completed-candle pullback evidence; no wallet/config
node binscore.cjs <POOL> <VOL%/day>      # bin-crowding map — see where other LPs AREN'T
                                         # (fees are paid per-bin pro-rata: a thin bin in the
                                         #  path of price pays you 10-50x a crowded one)
node deploy.cjs --pool <P> --size 0.3 --mode two --widthPct 18 --tp 20 --sl -15 --label MANUAL
node deploy.cjs ... --dry                # plan only, no transactions
node deploy.cjs --resume                 # resume/reconcile an interrupted BID ASK deployment
node deploy.cjs --resume --retry-failed  # explicit retry after a confirmed on-chain failure
node exit.cjs --pool <P>                 # close all positions in pool, sweep to SOL
node jupswap.cjs <inMint> <outMint> <rawAmount>
node pnlhunt.cjs --pair X-SOL --binStep N --baseFee N --duration hh:mm:ss --pnl P  # identify the wallet behind a PnL card
touch STOP                               # stop the daemon gracefully
```

Scan lines, deploys, and exits all print a clickable `meteora.ag/dlmm/<pool>` link — ⌘-click straight to the pool.

## Files it writes

| File | What |
|---|---|
| `positions.json` | open-position registry (restart-proof) |
| `trades.json` | closed round trips: class, entry context, exit trigger, PnL — the calibration dataset |
| `shadow.jsonl` | every candidate evaluation, signal or not — the counterfactual dataset |
| `replay-cache.json` | cached replay outcomes, stamped with the fee/edge basis they were simulated under; entries from an older basis are re-simulated (up to `--max` per run) |
| `pool-created.json` | pool `created_at` backfill cache for legacy shadow rows (immutable, fetched once per pool) |
| `daemon_state.json` | σ/fee history, cooldowns, OOR counters |
| `candle_evidence.json` | bounded public OHLCV cache and latest descriptive BID ASK evidence |
| `events.log` | every deploy/exit/failure, with the actual error text |
| `daemon.log` | heartbeat + every scan verdict with reasons |
| `.pending-swap.json` | crash-recovery ledger for a swap whose position didn't land |
| `.pending-bid-ask.json` | ignored local journal for the fixed position, allocation, and transaction phases of one hybrid deploy |

## Identifying the wallet behind a PnL card (`pnlhunt.cjs`)

Those RocketScan / metlex / LP Army "gud fee tek" cards leak a precise fingerprint: pair, bin step, base fee, hold duration, and a PnL number. `pnlhunt.cjs` turns that back into the on-chain wallet. Read-only — it reuses the Helius RPC in `.env` (429 backoff built in) plus the Meteora datapi, and never touches the trading side.

```bash
node pnlhunt.cjs --pair CHARITY-SOL --binStep 200 --baseFee 2 --duration 7:28 --pnl 17.17
node pnlhunt.cjs --pair STONK-SOL  --binStep 50  --baseFee 0.5 --duration 9:54:46 --pnl 1.38
```

How it works:
1. **Resolves the exact pool** on-chain (`getProgramAccounts` on the DLMM program, filtered by token mint + bin step) — deterministic, instant.
2. **Checks currently-open positions** first (cheap — catches a card shared while the position is still live).
3. **Walks position-open events newest-first**, gets each position's open/close time on-chain → hold duration, keeps the ones within `--tol` seconds of the card, then **confirms the PnL** against the datapi row.

Reading the card → flags:

| Card field | Flag | datapi field |
|---|---|---|
| bottom-bar `PNL +X%` | `--pnl X` | `pnlPctChange` (USD %, the reliable anchor) |
| `PROFIT (USD) $X` | `--pnlUsd X` | `pnlUsd` |
| `PROFIT (SOL) X` | `--profitSol X` | `pnlUsd ÷ SOL price` |
| hold time (always shown) | `--duration hh:mm:ss` | `closedAt − createdAt` |

**Lead with `--duration` + `--pnl`** — hold time to the second plus the PNL% is effectively a unique key. Note the card's "PNL %" is always the *USD* percent even when PROFIT is labeled in SOL.

Notes / limits:
- No timestamp on cards, so it walks newest-first with a `--pages` budget (default 250). A **long hold** must be walked back the full `(time since posted) + (hold duration)` — a 10h hold on a busy pool needs `--pages 600+` and a few minutes; the free Helius plan is the bottleneck.
- Widen `--tol` (duration seconds) if a card's number is rounded oddly, or run on `--duration` alone and eyeball the candidates it prints (each shows owner, position, fees, deposit, entry price).
- If the card was shared while still open, the same command catches it in pass 2 with no walk.

## Run it 24/7

Sleep kills processes. On a Mac either `nohup caffeinate -s &` while on AC power, or install the launchd template for boot persistence:

```bash
# edit the /ABSOLUTE/PATH placeholders first
cp launchd.plist.example ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
```

## Companion project

**[Meteora Quant Lens](https://github.com/fciaf420/meteora-quant-lens)** — a read-only Chrome extension using the same BID ASK eligibility, depth/allocation mapping, σ ladder, and profile lifecycle as an overlay on Meteora's UI. It guides wallet-approved entries; this repository can execute the signal automatically through its configured size and position limits.

## Honest limitations

- The IL formula is a diffusion approximation, not exact bin math (σ²/4W; a bin simulation runs ~10-20% above it)
- EDGE is a pool/width heuristic. It does not model the deployed shape, directional inventory, per-bin competition, rewards, swap/priority fees, slippage, or transaction/rent opportunity cost. BID ASK has no profitability model or validated backtest in this release
- A BID ASK layer validates that every saved bin is at or below the active bin immediately before building, but the SDK transaction permits bounded active-bin movement while it lands. A downward move can pause the next layer; the journal remains for later resume or manual close
- Replay simulation is ranking-grade, not penny-grade: uniform-band payoff approximation, 30-minute exit granularity vs the daemon's 2-minute ticks, no execution costs, and same-pool observations overlap in time so `n` runs optimistic
- Several bracket and gate constants are principled but **not yet backtested** — they're structured priors, and the two analysis tools exist precisely to replace them with evidence from your own trade log
- Class sample sizes accumulate slowly: ~98% of evaluations produce no signal, which is the system working, but it means calibration takes weeks not days
- A silent bot is a working bot: most scans correctly conclude *"nothing pays right now"*

## Disclaimer

Experimental software that trades real money in some of the most volatile markets that exist. You can lose everything. Nothing here is financial advice.
