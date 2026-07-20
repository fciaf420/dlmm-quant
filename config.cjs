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
};

module.exports = { RPC_URL, JUP_KEY, keypair, CFG };
