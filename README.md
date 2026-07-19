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

## The signals (what the bot reads every scan)

| Signal | Question it answers | Source |
|---|---|---|
| **feeRate** | What's the pool paying *right now* (last hour annualized), not yesterday? | Meteora Data API |
| **σ (sigma)** | How violently does this thing actually move? (5m/1h/24h windows, √t-scaled; for tokens < 24h old the "24h change" is price-since-launch garbage and gets excluded) | Jupiter Tokens API |
| **edge** | Do fees beat expected IL? (see above) | computed |
| **surge** | Is the on-chain dynamic-fee accumulator elevated? DLMM raises fees during volatility — deploy when the premium is surged, not after it decays | Meteora |
| **accel** | Is volume accelerating (30-min pace vs 4-hour pace) or fading? Catalysts, not leftovers | Meteora |
| **OFI** | Are *organic* wallets (Jupiter filters out bots) net buying or net selling? Don't be someone's exit liquidity | Jupiter |
| **path** | Where is price in its recent story? Labels each pool `FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP` from OHLCV | Meteora |

## The three plays

**🔥 IGNITION** — an event-driven scalp. Fees clear the bar (edge ≥ 1) *and* the fee accumulator is surged *and* volume is accelerating. Never fires into a FREEFALL (huge fees during a crash are bait). Width scales with vol; TP/SL brackets are computed from the pool's own σ and fee decay, not fixed numbers.

**🧲 BASING** — the reversion play. Token is down 40%+ from its high, the 5-minute chart has flattened, and organic wallets are absorbing. That's a base, not a knife. Enters two-sided with a stop just below the base low. Requires only half the normal edge, because trailing σ overstates forward vol right after a crash.

**🛡 CARRY** — boring on purpose. Mature token (3+ days), mint & freeze authority burned, big TVL, calm price, organic buyers on the 6-hour window, decent persistent fees. Wide ±35% range, rides for days, exits when the fee engine decays to half its entry rate. The fee floor is tiered: thin yield is only acceptable when risk-adjusted quality is exceptional.

## The lifecycle

```
every ~14 min  SCAN    100 pools → filters → signals → 3 gates
                 │
on signal      DEPLOY  Jupiter v2 swap for the token side → open Spot
                        position via Meteora SDK → record entry + brackets
                        in positions.json
                 │
every 2 min    MANAGE  each open position vs its own brackets:
                        ✓ take-profit          ✓ stop-loss / price stop
                        ✓ fee-decay exit (fee rate < 50% of entry — the
                          fees were the trade; when they die, leave even
                          if price looks fine)
                        ✓ flow-flip exit (organic distribution + dump)
                 │
on trigger     EXIT    close 100% → sweep every token to SOL → log PnL
                 │
               repeat  (2h re-entry cooldown per pool)
```

**Everything always ends in SOL.** No bags.

## Safety rails

- **Wallet balance is the hard cap** — the bot can't spend what isn't there, and refuses deploys below a 0.12 SOL gas/rent buffer
- Max **2 concurrent positions**, **1 per pool**, 2h cooldown after exiting a pool
- **Atomic deploy lock + registry dedup** — even multiple accidental daemon instances can't double-spend
- **Single-instance heartbeat lock** — a second daemon exits itself at startup
- **`touch STOP`** — graceful shutdown within one tick
- **Idempotent deploys** — if a deploy times out after the swap leg, the retry detects the held tokens and resumes instead of double-buying
- Keys never leave your machine; everything reads from `.env` (gitignored)

## CLI reference

```bash
npm start                                # the daemon
npm run screen                           # one-shot scan: every pool, every signal, every verdict
node binscore.cjs <POOL> <VOL%/day>      # bin-crowding map — see where other LPs AREN'T
                                         # (fees are paid per-bin pro-rata: a thin bin in the
                                         #  path of price pays you 10-50x a crowded one)
node deploy.cjs --pool <P> --size 0.3 --mode two --widthPct 18 --tp 20 --sl -15 --label MANUAL
node exit.cjs --pool <P>                 # close all positions in pool, sweep to SOL
node jupswap.cjs <inMint> <outMint> <rawAmount>
touch STOP                               # stop the daemon gracefully
```

## Files it writes

| File | What |
|---|---|
| `positions.json` | open-position registry (restart-proof) |
| `daemon_state.json` | fee-rate history, cooldowns |
| `events.log` | every deploy/exit/failure (+ macOS notifications) |
| `daemon.log` | heartbeat + every scan verdict with reasons |

## Run it 24/7

Sleep kills processes. On a Mac either `nohup caffeinate -s &` while on AC power, or install the launchd template for boot persistence:

```bash
# edit the /ABSOLUTE/PATH placeholders first
cp launchd.plist.example ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
```

## Honest limitations

- The IL formula is a diffusion approximation, not exact bin math
- σ from short windows is noisy; a single 5-min blip can temporarily suppress edge (this only ever makes the bot *more* conservative)
- Bracket constants (margins, clamps, tier thresholds) are principled but not yet backtested — they're meant to be recalibrated from your own trade log
- A silent bot is a working bot: most scans correctly conclude *"nothing pays right now"*

## Disclaimer

Experimental software that trades real money in some of the most volatile markets that exist. You can lose everything. Nothing here is financial advice.
