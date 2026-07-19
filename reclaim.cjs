// Close empty on-chain positions that are not in positions.json and reclaim their rent.
//
// A deploy that creates an extended position and then fails on the add-liquidity leg
// leaves an empty position the registry never learned about, so nothing will ever close
// it. This finds those and closes them.
//
// usage: node reclaim.cjs [--live]     (default is a dry run)
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
const DI = require('@meteora-ag/dlmm'); const DLMM = DI.default ?? DI;
const { RPC_URL, keypair } = require('./config.cjs');
const { sendConfirm } = require('./sendtx.cjs');
const LIVE = process.argv.includes('--live');

(async () => {
  const conn = new Connection(RPC_URL, 'confirmed');
  const user = keypair();
  const reg = fs.existsSync(__dirname+'/positions.json') ? JSON.parse(fs.readFileSync(__dirname+'/positions.json','utf8')) : [];
  const tracked = new Set(reg.map(r => r.position));
  const before = await conn.getBalance(user.publicKey);
  const all = await DLMM.getAllLbPairPositionsByUser(conn, user.publicKey);
  const entries = all instanceof Map ? [...all.entries()] : Object.entries(all);
  let closed = 0;
  for (const [pair, info] of entries) {
    for (const p of info.lbPairPositionsData) {
      const d = p.positionData;
      const empty = String(d.totalXAmount) === '0' && String(d.totalYAmount) === '0';
      const key = p.publicKey.toBase58();
      if (tracked.has(key)) { console.log(`skip ${key.slice(0,12)} — tracked in positions.json`); continue; }
      if (!empty) { console.log(`skip ${key.slice(0,12)} — HAS LIQUIDITY (X ${d.totalXAmount}, Y ${(+d.totalYAmount/1e9).toFixed(4)} SOL), close it with exit.cjs`); continue; }
      console.log(`orphan ${key.slice(0,12)} in ${pair.slice(0,12)} — ${d.positionBinData.length} bins, empty`);
      if (!LIVE) continue;
      const dlmm = await DLMM.create(conn, new PublicKey(pair));
      const tx = await dlmm.closePosition({ owner: user.publicKey, position: p });
      for (const t of (Array.isArray(tx) ? tx : [tx])) {
        const sig = await sendConfirm(conn, t, [user], 'close');
        console.log('  closed:', sig);
      }
      closed++;
    }
  }
  if (!LIVE) { console.log('\nDRY RUN — pass --live to close'); return; }
  const after = await conn.getBalance(user.publicKey);
  console.log(`\nclosed ${closed} | SOL ${(before/1e9).toFixed(4)} -> ${(after/1e9).toFixed(4)} (+${((after-before)/1e9).toFixed(4)})`);
})();
