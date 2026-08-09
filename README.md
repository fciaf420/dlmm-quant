# dlmm-quant

**An autonomous market-making bot for [Meteora DLMM](https://meteora.ag) on Solana.**
It scans every liquid pool, does the math a market maker would do, enters only when the fees genuinely overpay for the risk, manages the position against hard rules, and always exits back to SOL. One process, no UI, no babysitting.

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

This bot only enters when it does. For a position of width `W`, the expected daily IL from price wobble is roughly:

```
expected IL/day ≈ σ² / 8W        (σ = realized volatility, %/day)
```

So there's a hard breakeven: **fees/day must beat σ²/8W**. The bot expresses every pool as a single number:

```
edge = (net fee rate / σ)  ÷  (1.3 × σ / 8W)
```

`edge ≥ 1.0` means the fees clear expected IL with a 30% margin. Below 1, you're a charity for traders. A pool paying 40%/day in fees *sounds* incredible — but if the token swings 200%/day, edge is ~0.1 and the bot won't touch it. That single filter kills most "hot pool" traps.

Two properties of edge worth internalizing:

- **It scales linearly with width `W`.** The same pool quotes differently at ±20% than at ±35%, so a width the bot can't actually deploy produces a meaningless number. Widths are capped by the pool's bin budget *before* brackets are derived.
- **It scales inversely with σ².** A vol estimate 20% too low inflates edge by ~56%. Which is why σ is measured, not guessed:

## σ — measured, not guessed

Realized volatility comes from actual price candles, in a three-tier quality ladder:

1. **EWMA realized vol** — last ~4h of 5-minute closes, exponentially weighted (λ=0.9, ~33min half-life). The default whenever ≥6 returns exist.
2. **Parkinson** — for pools under ~35 minutes old. Estimates vol from each candle's high-low *range*, which carries ~5x more information per candle, so it works from just 3.
3. **Legacy single-print estimator** — last resort under ~15 minutes. Both noisy *and* biased: it systematically under-reads vol on calm prints, which inflates edge exactly when you least want it.

Readings are tagged by source, and the SQUEEZE detector only ever compares same-source readings — a change of measuring stick must never look like a change in the market.

If σ falls back to the legacy estimator on 2+ *mature* tokens in one scan, candle data is broken, every edge that cycle was computed on a bad instrument, and **the bot logs `DEGRADED SIGMA` and refuses to deploy that cycle.** It doesn't trade on data it doesn't trust.

## The signals (what the bot reads every scan)

| Signal | Question it answers | Source |
|---|---|---|
| **feeRate** | What's the pool paying *right now* (last hour annualized), not yesterday? | Meteora Data API |
| **σ (sigma)** | How violently does this thing actually move? | OHLCV candles (see above) |
| **edge** | Do fees beat expected IL? | computed |
| **surge** | Is the on-chain dynamic-fee accumulator elevated? DLMM raises fees during volatility — deploy when the premium is surged, not after it decays | Meteora |
| **accel** | Is volume accelerating (30-min pace vs 4-hour pace) or fading? Catalysts, not leftovers | Meteora |
| **OFI** | Are *organic* wallets (Jupiter filters out bots) net buying or net selling? Don't be someone's exit liquidity | Jupiter |
| **path** | Where is price in its recent story? Labels each pool `FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP` | OHLCV |

## The four plays

**🔥 IGNITION** — an event-driven scalp. Fees clear the bar (edge ≥ 1) *and* the fee accumulator is surged *and* volume is accelerating. Never fires into a FREEFALL (huge fees during a crash are bait). Width scales with σ; brackets are computed from the pool's own vol and fee rate.

**🧲 BASING** — the reversion play. Token is down 40%+ from its high, the 5-minute chart has flattened, organic wallets are absorbing, and fees are still rich.

The band's **bottom is placed *on* the consolidation floor** (the recent 5-minute low) rather than at a fixed width — so price leaving the band downward *is* the base breaking, and the structural stop sits just beneath it. The setup requires that floor to be **within 25% of price**: if the nearest floor is a third of the way down, there is no base to straddle and the trade is skipped. The PnL stop is a far backstop rather than the primary rule — a mean-reversion straddle is structurally long the dip, so a tight PnL stop fights its own premise.

**🛡 CARRY** — boring on purpose. Mature token (3+ days), mint & freeze authority burned, big TVL, calm price, organic buyers on the 6-hour window, decent persistent fees. Wide ±35% range, rides for days. The fee floor is tiered: thin yield is only acceptable when risk-adjusted quality is exceptional.

**🌀 SQUEEZE** — the long-vol wing. σ has compressed to ≤60% of its own trailing median for two consecutive scans (data-gated: needs ≥6 readings spanning ≥45min). Deploys **Bid-Ask** shape — liquidity loaded at the band edges — with width derived from the *trailing* σ, i.e. the vol it coils back to, not the compressed reading. **This is the one play with no edge gate**, because edge measures fee-vs-IL at *current* vol and low current vol is the entire thesis. A 24h time-stop closes coils that never spring.

### Cap-aware take-profits

A two-sided band's maximum price-driven gain is exactly **W/4** — above the band you're 100% SOL and done. Everything beyond that must come from accumulated fees. TPs are computed against that cap rather than set optimistically, so a TP the bot shows is a number the position can actually reach. Pump-outs get booked by the out-of-range rule, not by TP.

## The lifecycle

```
every ~14 min  SCAN    100 pools → filters → signals → 4 gates
                        (cadence is configurable)
                 │
on signal      DEPLOY  Jupiter swap for the token side (exact delta accounting)
                        → open position via Meteora SDK → verify the on-chain
                        bin range matches the order → record entry, brackets,
                        and fee baselines in positions.json
                 │
every 2 min    MANAGE  each open position against its own brackets:
                        ✓ take-profit           ✓ stop-loss / structural stop
                        ✓ out-of-range          ✓ fee-decay
                        ✓ flow-flip             ✓ squeeze time-stop
                 │
on trigger     EXIT    close 100% → sweep every token to SOL → journal the
                        round trip to trades.json
                 │
               repeat  (2h re-entry cooldown per pool)
```

**Everything always ends in SOL.** No bags.

### The exit rules, in detail

- **Fee-decay** — the 1h rate falls below 50% of your entry rate **and** below the pool's own 24h normal, two ticks running. Both conditions matter: the scanner ranks by fee rate, so entries systematically land on *spikes*, and a spike merely reverting to normal is not the fee engine dying. (Without the second condition, positions were being closed while still paying a healthy 7%/day.)
- **Out-of-range** — no liquidity at the active bin means no fee income. Up books the gain (TP is unreachable from outside the band anyway); down cuts dead exposure. Requires 2 consecutive ticks to filter wicks — **except** when the position is already past 60% of its stop, where waiting is the expensive choice and it exits immediately.
- **Flow-flip** — organic sellers >3:1 while price drops >15%/hour. Real wallets are exiting through your bid.
- **Structural stop** — the price level that invalidates the thesis (for BASING, the base itself).
- **Squeeze time-stop** — a coil that hasn't sprung in 24h isn't going to; stop paying rent.

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
SIZE_BASING=0.3         SIZE_CARRY=0.4          SIZE_SQUEEZE=0.3

# exit rulebook
FEE_DECAY_FRAC=0.5      # exit below this fraction of the entry fee rate…
FEE_DECAY_VS_NORM=1     # …and below the pool's 24h normal (spike-bias guard)
FLOW_OFI=3              FLOW_PC1=-15            # flow-flip thresholds
OOR_TICKS=2             OOR_DEEP_FRAC=0.6       # out-of-range persistence / deep-loss bypass
SQZ_TIMEOUT_H=24
BASING_MAX_FLOOR=25     # BASING needs a floor within this % of price

# per-class bracket overrides (SL positive; 0 = use the class formula)
TP_IGNITION= SL_IGNITION= TP_BASING= SL_BASING= TP_CARRY= SL_CARRY= TP_SQUEEZE= SL_SQUEEZE=
```

Bracket overrides apply at **deploy time** and are stamped into the registry, so changes affect new positions only — what you entered on is what you're managed by.

> Values are read at startup: **restart the daemon after editing `.env`.** Inline comments are stripped, but a malformed number logs a warning and falls back to the default rather than failing silently.

## Learning from its own trades

Two analysis tools, both propose-only — neither ever edits config.

### `node calibrate.cjs` — what actually happened

Reads `trades.json` (every closed round trip, with the class, entry fee baseline, brackets, and exit trigger), lazily settles official SOL-denominated PnL from Meteora's closed-position rollup, and prints per-class exit-trigger distributions and PnL percentiles. At **n ≥ 20 per class** it proposes TP/SL values (p75 of winners, p90 of losses) for you to review and apply via `.env`.

Reading the trigger mix is half the value: `TP` heavy means brackets are working; `FEE-DECAY` dominant means fees are the real exit and TP is set too far; `OOR-UP` heavy means pump-outs are booking the cap.

### `node replay.cjs` — what *would* have happened

The scanner evaluates ~8 pools every scan and, without this, throws every rejection away — which means only ever learning from trades you took. That's survivorship bias in your own data.

Instead, every evaluation (signal *or* rejection) is appended to `shadow.jsonl` with all its inputs, at **zero extra API cost** — it's data already in hand. `replay.cjs` then simulates each observation forward against the pool's **real price path** (30m candles) and **real fee series**, applies the daemon's own exit rules, and caches results permanently.

Output is an edge → outcome calibration curve per class: bucket, n, win rate, mean PnL, trigger mix — plus a suggested entry gate (the lowest bucket clearing measured friction at n ≥ 10) and a **near-miss audit** comparing setups blocked *only* by surge/accel against full passes. That last one answers a question nothing else can: are those gates saving you money or deleting opportunity?

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
- **Blockhash-expiry retry** — heavy position-opens get 3 attempts with fresh blockhashes (expiry means nothing executed, so re-signing is safe)
- **Rate-limit retry** — Jupiter 429s back off and retry rather than killing the deploy
- **Range verification** — an extended position whose on-chain bin range doesn't match the order is *never funded*; the unfunded position stays registered so its rent is recoverable
- **External-close detection** — close a position by hand and the daemon notices, journals it, and cleans its registry
- Keys never leave your machine; everything reads from `.env` (gitignored)

## CLI reference

```bash
npm start                                # the daemon
npm run screen                           # one-shot scan: every pool, every signal, every verdict
node calibrate.cjs                       # per-class results from real trades
node replay.cjs [--max 150]              # entry-gate calibration curves from shadow observations
node binscore.cjs <POOL> <VOL%/day>      # bin-crowding map — see where other LPs AREN'T
                                         # (fees are paid per-bin pro-rata: a thin bin in the
                                         #  path of price pays you 10-50x a crowded one)
node deploy.cjs --pool <P> --size 0.3 --mode two --widthPct 18 --tp 20 --sl -15 --label MANUAL
node deploy.cjs ... --dry                # plan only, no transactions
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
| `replay-cache.json` | cached replay outcomes (a past outcome never changes) |
| `daemon_state.json` | σ/fee history, cooldowns, OOR counters |
| `events.log` | every deploy/exit/failure, with the actual error text |
| `daemon.log` | heartbeat + every scan verdict with reasons |
| `.pending-swap.json` | crash-recovery ledger for a swap whose position didn't land |

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

**[Meteora Quant Lens](https://github.com/fciaf420/meteora-quant-lens)** — a read-only Chrome extension running the *same* signal engine (identical σ ladder, edge math, class gates, and exit rules) as an overlay on Meteora's own UI. It alerts and journals instead of executing. Useful for watching the board without running a daemon, for manual entries that still get rule-based exit alerts, and its shadow-log export feeds this repo's `replay.cjs`.

## Honest limitations

- The IL formula is a diffusion approximation, not exact bin math
- Replay simulation is ranking-grade, not penny-grade: uniform-band payoff approximation, 30-minute exit granularity vs the daemon's 2-minute ticks, no execution costs, and same-pool observations overlap in time so `n` runs optimistic
- Several bracket and gate constants are principled but **not yet backtested** — they're structured priors, and the two analysis tools exist precisely to replace them with evidence from your own trade log
- Class sample sizes accumulate slowly: ~98% of evaluations produce no signal, which is the system working, but it means calibration takes weeks not days
- A silent bot is a working bot: most scans correctly conclude *"nothing pays right now"*

## Disclaimer

Experimental software that trades real money in some of the most volatile markets that exist. You can lose everything. Nothing here is financial advice.
