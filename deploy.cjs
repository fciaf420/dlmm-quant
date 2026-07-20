// Generic deploy: node deploy.cjs --pool X --size 0.3 --mode two|single --widthPct 18 --tp 20 --sl -15 --stopPrice 0 --label BASING [--dry]
const fs = require('fs');
const DLMMImport = require('@meteora-ag/dlmm');
const DLMM = DLMMImport.default ?? DLMMImport;
const { StrategyType } = DLMMImport;
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, VersionedTransaction } = require('@solana/web3.js');
const BN = require('bn.js');
const { sendConfirm, confirmSig } = require('./sendtx.cjs');
const { RPC_URL, JUP_KEY: JK, keypair } = require("./config.cjs");
const SOLM = "So11111111111111111111111111111111111111112";
const arg = (k, d) => { const i = process.argv.indexOf('--'+k); return i>0 ? process.argv[i+1] : d; };
const DRY = process.argv.includes('--dry');
// Ctrl-C in a terminal hits the whole process group. Killing mid-deploy can leave an
// on-chain position that positions.json never records, so ignore SIGINT and finish.
// The parent's 480s timeout is the real backstop; kill -9 still works.
process.on('SIGINT', () => console.error('SIGINT ignored - finishing deploy to keep the registry consistent'));
(async () => {
  const POOL = arg('pool'), size = +arg('size','0.3'), mode = arg('mode','two'), widthPct = +arg('widthPct','18');
  const tp = +arg('tp','20'), sl = +arg('sl','-15'), stopPrice = +arg('stopPrice','0'), label = arg('label','POS');
  const rpc = RPC_URL;
  const user = keypair();
  const conn = new Connection(rpc, 'confirmed');
  // ---- ZOMBIE-PROOF GUARDS (atomic lock + dedup + cap) ----
  const lockDir = __dirname + '/.deploy.lock';
  try { fs.mkdirSync(lockDir); } catch(e) {
    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (age < 5*60e3) { console.error('LOCKED: another deploy in progress'); process.exit(3); }
    fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir);
  }
  process.on('exit', () => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch(e){} });
  const reg0 = fs.existsSync(__dirname+'/positions.json') ? JSON.parse(fs.readFileSync(__dirname+'/positions.json','utf8')) : [];
  if (reg0.find(r => r.pool === POOL)) { console.error('DUPLICATE: position already exists for this pool'); process.exit(4); }
  if (reg0.length >= 2) { console.error('CAP: 2 positions already open'); process.exit(5); }
  const pool = await (await fetch(`https://dlmm.datapi.meteora.ag/pools/${POOL}`)).json();
  const MINT = pool.token_x.address;
  const binStepPct = pool.pool_config.bin_step / 100;
  // Position sizing. initializePositionAndAddLiquidityByStrategy creates the account via
  // CPI, so it can only cover DEFAULT_BIN_PER_POSITION (70) bins before the account
  // outgrows Solana's 10240-byte inner-instruction realloc cap (InvalidRealloc). Wider
  // ranges use createExtendedEmptyPosition, which grows the account outside that path
  // and supports up to MAX_BINS_PER_POSITION (1400). Two-sided spans 2w+1 bins, single w+1.
  const DEF_BINS = DLMMImport.DEFAULT_BIN_PER_POSITION?.toNumber?.() ?? 70;
  // The account supports MAX_BINS_PER_POSITION (1400), but AddLiquidityByStrategy2 panics
  // with "memory allocation failed, out of memory" well below that: 351 bins OOMs, 145
  // funds fine. The exact ceiling between those is unmeasured, so cap conservatively.
  // Override with --maxBins once a higher value is known to work.
  const MAX_BINS = Math.min(+arg('maxBins', '140'), DLMMImport.MAX_BINS_PER_POSITION?.toNumber?.() ?? 1400);
  const maxHalf = mode === 'single' ? MAX_BINS - 1 : Math.floor((MAX_BINS - 1) / 2);
  const wanted = Math.max(3, Math.round(widthPct / binStepPct));
  const widthBins = Math.min(wanted, maxHalf);
  const effPct = (widthBins * binStepPct).toFixed(1);
  if (widthBins < wanted) console.log(`width clamped: ±${widthPct}% = ${wanted} bins exceeds the ${MAX_BINS}-bin max -> using ${widthBins} bins (±${effPct}%)`);
  const totalBins = mode === 'single' ? widthBins + 1 : 2*widthBins + 1;
  const extended = totalBins > DEF_BINS;
  // Rent scales with width past the default: POSITION_MIN_SIZE + 112B per extra bin.
  // Refunded on close, but it locks capital, so charge it to the affordability check.
  const acctSize = (DLMMImport.POSITION_MIN_SIZE ?? 8112) + Math.max(0, totalBins - DEF_BINS) * (DLMMImport.POSITION_BIN_DATA_SIZE ?? 112);
  const rent = (await conn.getMinimumBalanceForRentExemption(acctSize)) / 1e9;
  const bal = await conn.getBalance(user.publicKey);
  const need = size + rent + 0.08; // + bin array init and gas headroom
  console.log(`plan: ${label} ${mode} ${size} SOL on ${pool.name} width ±${effPct}% (${totalBins} bins${extended?', extended':''}) rent ${rent.toFixed(4)} tp ${tp} sl ${sl} stopPrice ${stopPrice} | wallet ${bal/1e9} SOL`);
  if (bal/1e9 < need) { console.error(`INSUFFICIENT: need ${need.toFixed(4)} SOL (${size} position + ${rent.toFixed(4)} rent + 0.08 fees), have ${(bal/1e9).toFixed(4)}`); process.exit(2); }
  if (DRY) { console.log('DRY RUN OK'); return; }
  let totalX = new BN(0);
  let swapSOL = mode === 'two' ? size/2 : 0;
  // idempotency: if a prior timed-out attempt already swapped, reuse the held tokens
  try {
    const pre = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint: new PublicKey(MINT) });
    const preRaw = pre.value.reduce((s,a)=>s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
    const preUi = pre.value.reduce((s,a)=>s + Number(a.account.data.parsed.info.tokenAmount.uiAmount), 0);
    const preVal = preUi * (pool.current_price||0);
    if (preVal > swapSOL * 0.5) { console.log('reusing held tokens from prior attempt:', preRaw); swapSOL = 0; totalX = new BN(String(preRaw)); }
  } catch(e){}
  if (swapSOL > 0) {
    const amt = Math.floor(swapSOL*1e9);
    let ok = false;
    try {
      const ord = await (await fetch(`https://api.jup.ag/swap/v2/order?inputMint=${SOLM}&outputMint=${MINT}&amount=${amt}&taker=${user.publicKey.toBase58()}`, { headers:{'x-api-key':JK} })).json();
      if (ord.transaction) {
        const tx = VersionedTransaction.deserialize(Buffer.from(ord.transaction,'base64')); tx.sign([user]);
        const ex = await (await fetch('https://api.jup.ag/swap/v2/execute', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
          body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString('base64'), requestId: ord.requestId }) })).json();
        ok = ex.status === 'Success'; console.log('swap v2:', ex.status, ex.signature||'');
      }
    } catch(e){ console.log('v2 err', e.message); }
    if (!ok) {
      const q = await (await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${SOLM}&outputMint=${MINT}&amount=${amt}&slippageBps=300`, { headers:{'x-api-key':JK} })).json();
      const sw = await (await fetch('https://api.jup.ag/swap/v1/swap', { method:'POST', headers:{'x-api-key':JK,'content-type':'application/json'},
        body: JSON.stringify({ quoteResponse: q, userPublicKey: user.publicKey.toBase58(), wrapAndUnwrapSol: true }) })).json();
      const tx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction,'base64')); tx.sign([user]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries:3 });
      await confirmSig(conn, sig, 'swap v1'); console.log('swap v1:', sig);
    }
    await new Promise(r=>setTimeout(r,2000));
    const accs = await conn.getParsedTokenAccountsByOwner(user.publicKey, { mint: new PublicKey(MINT) });
    const raw = accs.value.reduce((s,a)=>s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
    totalX = new BN(String(raw));
    console.log('token acquired (raw):', raw);
  }
  const solSide = mode === 'two' ? size/2 : size;
  const dlmm = await DLMM.create(conn, new PublicKey(POOL));
  const active = await dlmm.getActiveBin();
  const minBinId = mode === 'single' ? active.binId - widthBins : active.binId - widthBins;
  const maxBinId = mode === 'single' ? active.binId : active.binId + widthBins;
  const posKp = Keypair.generate();
  const strategy = { minBinId, maxBinId, strategyType: (arg('shape','spot') === 'bidask' ? StrategyType.BidAsk : StrategyType.Spot) };
  const totalYAmount = new BN(Math.floor(solSide*1e9));
  if (!extended) {
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKp.publicKey, user: user.publicKey,
      totalXAmount: totalX, totalYAmount, strategy,
    });
    for (const t of (Array.isArray(tx)?tx:[tx])) {
      const sig = await sendConfirm(conn, t, [user, posKp], 'position');
      console.log('open tx:', sig);
    }
  } else {
    // Two steps: create the wide account, then fund it. The create leg spends rent, so
    // from the moment it confirms the position must be in the registry — otherwise a
    // failure on the add leg orphans it and nothing will ever reclaim that rent.
    const initTx = await dlmm.createExtendedEmptyPosition(minBinId, maxBinId, posKp.publicKey, user.publicKey);
    for (const t of (Array.isArray(initTx)?initTx:[initTx])) {
      const sig = await sendConfirm(conn, t, [user, posKp], 'position');
      console.log('extended position tx:', sig);
    }
    record({ funded: false });
    console.log('registered unfunded position (rent recoverable if the add leg fails)');
    const addTx = await dlmm.addLiquidityByStrategy({
      positionPubKey: posKp.publicKey, user: user.publicKey,
      totalXAmount: totalX, totalYAmount, strategy, slippage: 3,
    });
    for (const t of (Array.isArray(addTx)?addTx:[addTx])) {
      const sig = await sendConfirm(conn, t, [user], 'liquidity');
      console.log('add liquidity tx:', sig);
    }
  }
  record({ funded: true });
  console.log('DEPLOYED:', posKp.publicKey.toBase58(), `bins ${minBinId}..${maxBinId}`, '| registry updated');

  // Upsert this position into the registry. Called once for the standard path and twice
  // for the extended path (unfunded right after create, then funded after the add leg).
  function record({ funded }) {
    const reg = fs.existsSync(__dirname+'/positions.json') ? JSON.parse(fs.readFileSync(__dirname+'/positions.json','utf8')) : [];
    const row = { pool: POOL, name: pool.name, mint: MINT, position: posKp.publicKey.toBase58(), label, mode,
      sizeSOL: size, entryPrice: pool.current_price, entryFeeRate: (pool.fee_tvl_ratio['1h']||0)*24,
      tpPct: tp, slPct: sl, stopPrice, minBinId, maxBinId, funded, openedAt: new Date().toISOString() , shape: arg('shape','spot') };
    const i = reg.findIndex(r => r.position === row.position);
    if (i >= 0) reg[i] = { ...reg[i], ...row }; else reg.push(row);
    fs.writeFileSync(__dirname+'/positions.json', JSON.stringify(reg, null, 1));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
