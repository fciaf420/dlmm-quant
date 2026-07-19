# dlmm-quant

Autonomous quant LP trading daemon for [Meteora DLMM](https://meteora.ag) on Solana. Scans the pool board, deploys liquidity when the math clears, manages positions against data-driven brackets, exits fully to SOL. No UI, no babysitting — one process.

## Quick start

```bash
git clone https://github.com/fciaf420/dlmm-quant && cd dlmm-quant
npm install
cp .env.example .env     # fill in RPC_URL, KEYPAIR_PATH (or PRIVATE_KEY), JUP_API_KEY
npm start                # runs the daemon: manage every 2 min, scan+deploy every ~14 min
```

Use a **dedicated wallet with capped funds**. The daemon's max exposure = the wallet's balance; it refuses deploys below a 0.12 SOL gas/rent buffer.

## What the daemon does

Every 2 minutes (**manage**): for each open position (tracked in `positions.json`) it checks
TP / price-stop / SL / fee-decay (rate < 50% of entry, 2 reads) / organic flow-flip — any hit closes the position 100% back to SOL via the Meteora SDK + Jupiter Swap v2.

Every ~14 minutes (**scan**): pulls the liquid pool board and computes per pool:

- `feeRate` — live fee/TVL run-rate (%/day)
- `sigma` — age-aware realized vol (5m/1h/24h √t-scaled; since-launch excluded for tokens < 24h)
- `edge` — feeRate·0.9/σ divided by the **IL-breakeven bar** `1.3·σ/(8W)` — entries require fees to clear expected IL with margin
- `surge` — dynamic-fee accumulator vs base (is the vol premium elevated?)
- `accel` — 30m vs 4h volume run-rate (igniting or fading?)
- `OFI` — organic sell/buy imbalance from Jupiter (don't be someone's exit liquidity)
- `path` — FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP from OHLCV

Three entry classes, each with its own brackets:

| Class | Trigger sketch | Shape |
|---|---|---|
| **IGNITION** | edge ≥ 1 + surge ≥ 1.25 + accel ≥ 1.2, never into FREEFALL | vol-scaled width, dynamic TP/SL |
| **BASING** | −40%+ from high, 5m flattened, organic buying, fees ≥ 15%/day | ±18%, stop below base low |
| **CARRY** | edge ≥ 1.3, 6h organic buying, mature token, authorities dead (tiered fee floor: 2 / 1.2 / 0.6 %/day as edge quality rises) | ±35%, ride until fee decay |

Safety rails: atomic deploy lock, one-position-per-pool, max 2 concurrent, 2h re-entry cooldown, single-instance heartbeat lock, `STOP` file for graceful shutdown, idempotent deploys (a timed-out deploy resumes from the swapped tokens on retry).

## CLI tools

```bash
npm run screen                          # one-shot board scan with all signals + verdicts
node binscore.cjs <POOL> <VOL%/day>     # bin-crowding map: where other LPs aren't
node deploy.cjs --pool <P> --size 0.3 --mode two --widthPct 18 --tp 20 --sl -15 --label MANUAL
node exit.cjs --pool <P>                # close everything in pool, sweep to SOL
node jupswap.cjs <inMint> <outMint> <rawAmount>
touch STOP                              # graceful daemon shutdown (removes itself on restart)
```

## Files the daemon writes

- `positions.json` — open-position registry (survives restarts)
- `daemon_state.json` — fee-rate history, cooldowns
- `events.log` — deploys/exits/failures (also macOS notifications)
- `daemon.log` — heartbeat + scan verdicts

## Keeping it alive 24/7

macOS sleep kills any process. Either `caffeinate -s` while on AC, or install the included launchd template:

```bash
# edit paths in launchd.plist.example, then:
cp launchd.plist.example ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dlmm.quant-trader.plist
```

## Disclaimer

Experimental real-money software for volatile memecoin LPing. You can lose everything. Not financial advice.
