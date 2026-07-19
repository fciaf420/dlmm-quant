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
module.exports = { RPC_URL, JUP_KEY, keypair };
