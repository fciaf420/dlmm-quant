# dlmm-quant

A quant LP system for [Meteora DLMM](https://meteora.ag) on Solana. Treats an LP position as a payoff shape and a market-making book, not a "set a range and pray" deposit.

## The four strategies

1. **Bin-crowding arbitrage (queue positioning)** — fee share in a bin = your liquidity ÷ bin total. `binscore.cjs` maps every LP's liquidity bin-by-bin on-chain, scores bins by traversal-probability ÷ crowding, and deploys into the thin high-traffic bins other LPs leave empty (retail all cluster in the default centered spread).
2. **Volatility-accumulator surge timing** — DLMM's dynamic fee is a readable state variable. Only deploy when the vol accumulator is surged (`dynamic_fee / base_fee ≥ 1.25`) and volume is accelerating; exit when it decays. Sell insurance only when the premium is elevated.
3. **Fee term-structure roll-down** — pool fee run-rates decay ~exponentially after ignition. The scanner fits per-pool half-lives from its own scan history; positions exit at a fixed fraction of decay (fee rate < 25% of entry), not at a price target.
4. **Inventory-aware skew (Avellaneda-Stoikov on bins)** — re-centers are never blind-symmetric: range = `[-W×(1-inv), +W×inv]` where `inv` = fraction of position value in the base token, and width `W = clamp(realizedVol/4, 12%, 30%)`.

## Entry bar: IL-breakeven, not vibes

For a Spot range of half-width `W`, expected IL/day ≈ `σ²/8W`. A pool is only enterable when

```
edge = LP_Sharpe / (1.3 × σ/(8W)) ≥ 1.0     where LP_Sharpe = netFeeRate / σ
```

i.e. fees must clear expected IL with a 30% margin. The bar breathes with each pool's volatility — a 200%/day memecoin needs ~3x the fee yield a 60%/day pool does.

## Signals (all from public APIs)

- **Meteora Data API** (`dlmm.datapi.meteora.ag`): fee/TVL by window, dynamic fee (surge), volume acceleration
- **Jupiter Tokens API**: Organic Score (wash-trade filter), organic buy/sell flow imbalance (OFI), multi-window realized vol, mint/freeze authority audit
- **On-chain via `@meteora-ag/dlmm`**: bin-level liquidity distribution, exact-bin position placement

## Files

- `binscore.cjs` — bin-gap scorer: `node binscore.cjs <pool> <realizedVolPctPerDay>`
- `bins.cjs` — raw bin-distribution reader
- `PLAYBOOK.md` — the full operating spec: scan → deploy → manage → learn, dynamic TP/SL bracket math, carry vs scalp sleeves, capital allocation

## Dynamic brackets (no flat ±20%)

```
TP = clamp( max(0.6 × netFeeRate × t½/ln2, 1.2 × σ × √hold), 10, 40 )
SL = -clamp( σ × √hold, 10, 25 )
```

## Setup

```bash
npm install
# keypair JSON (Uint8Array bytes) + RPC URL supplied via your own config — never commit them
node binscore.cjs <POOL_ADDRESS> <VOL_PCT_PER_DAY>
```

## Disclaimer

Real-money experimental software. Memecoin LPing can lose everything. Nothing here is financial advice.
