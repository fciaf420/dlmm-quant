const DLMMImport = require('@meteora-ag/dlmm');
const { Connection, PublicKey } = require('@solana/web3.js');
const DLMM = DLMMImport.default ?? DLMMImport;
(async () => {
  const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const pool = new PublicKey('2VHM9pTZEU6pqeZoiNi8ZCeyerqhRYgS5Um7U8AEKrd9');
  const dlmm = await DLMM.create(conn, pool);
  const active = await dlmm.getActiveBin();
  const { bins } = await dlmm.getBinsAroundActiveBin(20, 20);
  console.log('ACTIVE BIN:', active.binId, 'price', Number(active.price).toPrecision(6));
  console.log('binId | price | Jimothy | SOL | totalSOL');
  for (const b of bins) {
    const x = Number(b.xAmount) / 1e6;
    const y = Number(b.yAmount) / 1e9;
    const p = Number(b.price);
    const mark = b.binId === active.binId ? ' <== ACTIVE' : '';
    console.log(`${b.binId} | ${p.toPrecision(4)} | ${x.toFixed(0)} | ${y.toFixed(3)} | ${(x*p + y).toFixed(3)}${mark}`);
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
