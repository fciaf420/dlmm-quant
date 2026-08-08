# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Autonomous Meteora DLMM trading bot on Solana mainnet, trading real money from a **dedicated bot wallet**. `README.md` is the authoritative doc — it matches the code. **`PLAYBOOK.md` is a superseded design doc** (manager routines, sleeves, re-centering do not exist in the daemon); do not implement from it.

## Live-money safety — read first

- **A daemon is usually running** (`node trader_daemon.cjs`, singleton via `daemon.heartbeat`; launchd agent `com.dlmm.quant-trader` has `KeepAlive true` and restarts it). Check `cat daemon.heartbeat` (PID, touched every 60s) before anything that could collide.
- **There is no paper/shadow trading mode.** `shadow.jsonl` is a log, not a mode. `npm start` trades live immediately.
- Scripts that **sign and broadcast transactions**: `trader_daemon.cjs` (autonomously spawns deploy/exit), `deploy.cjs`, `exit.cjs`, `jupswap.cjs` (no confirmation prompt), `reclaim.cjs --live`.
- Read-only/safe: `screen.cjs`, `binscore.cjs`, `bins.cjs`, `calibrate.cjs`, `replay.cjs`, `vol.cjs`.
- **Opposite dry-run defaults:** `deploy.cjs` is LIVE unless you pass `--dry`; `reclaim.cjs` is DRY unless you pass `--live`.
- **Policy:** run live-transaction commands only after the user approves that workflow in the session; once approved, repeating it is fine without re-asking.
- Kill switch: `touch STOP` in repo root → daemon exits within one tick and refuses to start until `rm STOP`. Stopping the daemon leaves open positions UNMANAGED. Never `kill -9` a running `deploy.cjs` (swap can land with no registry row).
- `exit.cjs --pool X` closes EVERY position the wallet holds in that pool and sweeps the wallet's entire token_x balance to SOL. Fine on this dedicated wallet, but know that's what it does.
- Never read, print, or commit `.env` — it holds the private key. The live `.env` diverges from `.env.example` defaults (e.g. sizes); don't assume defaults are what's running.

## Commands

```
npm start                  # = node trader_daemon.cjs  (LIVE trading loop)
npm run screen             # read-only market scan — safest smoke test
node deploy.cjs --pool <P> --size 0.3 --mode two --widthPct 18 --tp 20 --sl -15 --label X [--dry]
node exit.cjs --pool <P>
node reclaim.cjs [--live]
node jupswap.cjs <inMint> <outMint> <rawAmountBaseUnits>
node binscore.cjs <POOL> <dailyVolPct> [side]
node replay.cjs [--max 150] [--friction 0.4]   # offline replay of shadow.jsonl
node calibrate.cjs         # per-class stats from trades.json; propose-only
```

- `deploy.cjs` args are space-separated only (`--pool X`, not `--pool=X` — the latter silently yields undefined).
- `--sl` on the CLI is NEGATIVE (`--sl -15`) but `.env` overrides (`SL_IGNITION` etc.) are POSITIVE (`12` = −12%). Two sign conventions.
- `bins.cjs` is a hardcoded-pool debug scratchpad; `binscore.cjs` is the real tool.
- Monitoring: `tail -f daemon.log` (scan verdicts), `tail -f events.log` (deploys/exits/failures).

## Verifying changes (no tests or CI exist)

1. `npm run lint` — ESLint, correctness rules only (config in `eslint.config.cjs`; no style rules by design). Errors block, warnings are informational.
2. `node screen.cjs` — smoke test (needs `RPC_URL` + `JUP_API_KEY`, no wallet key).
3. `node deploy.cjs ... --dry` — exercises the deploy path up to (not including) the swap.
4. `node replay.cjs` — validate signal/gate changes against logged observations (cached in `replay-cache.json`).
5. `node calibrate.cjs` — real-trade outcomes per class.

**Known drift:** `screen.cjs` hardcodes its TVL/volume/top-N thresholds and its IGNITION/BASING gate expressions as copies of the daemon's — tuning `.env` gates does NOT affect it, and gate edits must be made in both files or they diverge.

## Config

`config.cjs` is a hand-rolled dotenv (no dependency):
- `.env` keys must be `UPPERCASE_WITH_UNDERSCORES`; lowercase keys are silently ignored.
- Real shell env WINS over `.env` (`TICK_MS=60000 npm start` overrides the file).
- Values are read once at process start — `.env` edits require a daemon restart, and TP/SL are stamped into `positions.json` at deploy time (affect NEW positions only).
- Required: `RPC_URL` (hard exit if missing — even read-only scripts need it), plus `KEYPAIR_PATH` or `PRIVATE_KEY`. `JUP_API_KEY` unset → unauthenticated Jupiter calls → 429s.

## Code style

- CommonJS only (`.cjs`, `require`). No build step, no TypeScript. **Zero new runtime dependencies** — the whole runtime is `@meteora-ag/dlmm`, `@solana/web3.js`, `bs58`, `bn.js`; HTTP is global `fetch`. (ESLint lives in devDependencies only.)
- Executables are a top-level async IIFE ending `.catch(e => { console.error('ERR', e.message); process.exit(1); })`. SDK interop idiom: `const DLMM = DLMMImport.default ?? DLMMImport;`.
- Dense one-liners, terse locals (`p`, `tk`, `sg`), long lines, mixed quotes — match the surrounding line, do not reformat.
- **Comments are incident reports**: non-obvious guards cite the live failure that motivated them ("caught live 2026-08-03, MENSA deploy"). New defensive code should carry the same rationale style.
- Confirm transactions via `sendtx.cjs` (`sendConfirm`/`confirmSig`, HTTP polling) — never web3.js's built-in websocket confirm (some RPCs return `error` instead of `err` and crash the process, even on success). `sendConfirm`'s blockhash retry only works for legacy `Transaction`, not `VersionedTransaction`.
- Commits: lowercase `scope: description` (`deploy: exact swap-delta accounting`), SCREAMING scope for named behaviors (`FALSE OOR fix: ...`), subject states the reason. Direct to `master`. Some changes mirror the companion Chrome extension `fciaf420/meteora-quant-lens` — note `(mirror of ...)` when they do.

## Known limits & API quirks

- `MAX_BINS` above ~145 → on-chain OOM panic in AddLiquidityByStrategy2 (145 works, 351 fails; true ceiling unmeasured). >70 bins requires the two-step extended-position path (already implemented).
- Meteora datapi's `isOutOfRange` is wrong for extended positions — the daemon computes OOR from its own recorded bin range instead; keep it that way.
- Meteora 5m OHLCV range caps at ~8h — hence `vol.cjs`'s two parallel calls.
- Jupiter: Swap v2 first, v1 fallback; 429s are real (key shared with the Chrome extension) — keep the existing backoff and inter-call throttles.
- No log rotation: `daemon.log` and `shadow.jsonl` grow forever; `trades.json` self-caps at 500.
