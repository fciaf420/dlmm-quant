// Loads .env (KEY=VALUE lines) from this directory. No external deps.
const fs = require('fs'), path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath,'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
  }
}
const RPC_URL = process.env.RPC_URL;
const JUP_KEY = process.env.JUP_API_KEY || '';
if (!RPC_URL) { console.error('config: RPC_URL missing (set it in .env)'); process.exit(1); }
function keypair() {
  const { Keypair } = require('@solana/web3.js');
  if (process.env.KEYPAIR_PATH) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR_PATH,'utf8'))));
  }
  if (process.env.PRIVATE_KEY) {
    const bs58 = require('bs58').default ?? require('bs58');
    return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY.trim()));
  }
  console.error('config: set KEYPAIR_PATH (JSON byte array) or PRIVATE_KEY (base58) in .env'); process.exit(1);
}
// ---- tunables ----
// Every operational number lives here so it can be set in .env rather than edited in
// code. Defaults reproduce the previous hard-coded behaviour, so an empty .env is a
// no-op. Invalid or missing values fall back to the default rather than NaN.
const num = (k, d) => { const v = process.env[k]; if (v === undefined || v.trim() === '') return d;
  const n = Number(v); if (!Number.isFinite(n)) { console.error(`config: ${k}="${v}" is not a number, using ${d}`); return d; } return n; };

const CFG = {
  // quote token every pool must be paired against. deploy swaps QUOTE->token_x and
  // treats the Y side as this mint's lamports, so pools quoted in anything else
  // (SOL-HYPE, *-USDC) cannot be deployed and are filtered out of the scan.
  QUOTE_MINT:   process.env.QUOTE_MINT || 'So11111111111111111111111111111111111111112',

  // loop timing
  TICK_MS:      num('TICK_MS', 120e3),      // manage every tick
  SCAN_EVERY:   num('SCAN_EVERY', 7),       // scan every Nth tick (7 x 2min = ~14min)

  // candidate universe
  MIN_TVL:      num('MIN_TVL', 60000),
  MIN_VOL_24H:  num('MIN_VOL_24H', 150000),
  SCAN_TOP_N:   num('SCAN_TOP_N', 8),       // candidates examined per scan, by fee rate
  COOLDOWN_H:   num('COOLDOWN_H', 2),       // hours before re-entering a pool after exit

  // position sizing, in SOL
  MAX_POSITIONS:   num('MAX_POSITIONS', 2),
  SIZE_IGNITION:   num('SIZE_IGNITION', 0.3),
  SIZE_IGNITION_HI:num('SIZE_IGNITION_HI', 0.4),  // used when edge >= 2
  SIZE_BASING:     num('SIZE_BASING', 0.3),
  SIZE_CARRY:      num('SIZE_CARRY', 0.4),
  SIZE_SQUEEZE:    num('SIZE_SQUEEZE', 0.3),

  // deploy mechanics
  MAX_BINS:        num('MAX_BINS', 140),     // AddLiquidityByStrategy2 OOMs above ~145
  FEE_BUFFER_SOL:  num('FEE_BUFFER_SOL', 0.08), // headroom over position + rent
  SLIPPAGE_BPS:    num('SLIPPAGE_BPS', 300),

  // exit rulebook (manage loop). Defaults = long-standing hardcoded behavior.
  FEE_DECAY_FRAC:  num('FEE_DECAY_FRAC', 0.5),   // exit when 1h fee rate < this fraction of entry (x2 ticks)
  FEE_DECAY_VS_NORM: num('FEE_DECAY_VS_NORM', 1), // 1 = decay must ALSO be below the pool's 24h rate at entry (spike-bias guard); 0 = entry-relative only
  FLOW_OFI:        num('FLOW_OFI', 3),           // flow-flip: organic sell:buy ratio above this...
  FLOW_PC1:        num('FLOW_PC1', -15),         // ...while 1h price change below this (%)
  OOR_TICKS:       num('OOR_TICKS', 2),          // consecutive out-of-range ticks before exit
  SQZ_TIMEOUT_H:   num('SQZ_TIMEOUT_H', 24),     // squeeze time-stop (hours, |pnl|<3%)

  // TP/SL overrides per class, in % (SL as a POSITIVE number, e.g. 12 means -12%).
  // 0 = keep the class formula/default. Overrides apply at DEPLOY time (stamped
  // into the registry entry), so changing them only affects new positions.
  TP_IGNITION:     num('TP_IGNITION', 0),
  SL_IGNITION:     num('SL_IGNITION', 0),
  TP_BASING:       num('TP_BASING', 0),
  SL_BASING:       num('SL_BASING', 0),
  TP_CARRY:        num('TP_CARRY', 0),
  SL_CARRY:        num('SL_CARRY', 0),
  TP_SQUEEZE:      num('TP_SQUEEZE', 0),
  SL_SQUEEZE:      num('SL_SQUEEZE', 0),
};

module.exports = { RPC_URL, JUP_KEY, keypair, CFG };
