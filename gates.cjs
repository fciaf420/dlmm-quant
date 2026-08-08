// gates.cjs — the ONE copy of the entry-signal logic: path classification, the
// edge formula, and the four class gates. Required by trader_daemon.cjs (live
// deploys) and screen.cjs (preview board). Extracted verbatim from the daemon
// 2026-08-07: screen.cjs carried a hand-retyped copy that had already drifted —
// it lacked the BASING tight-base gate and the CARRY/SQUEEZE classes entirely,
// so the board could show setups the daemon would refuse (and hide ones it trades).
// Numbers here are the daemon's real thresholds — editing them changes LIVE deploys.

// FREEFALL / BASING / BLOWOFF / GRIND-UP / CHOP from price action + day structure
function classifyPath({ pc5, pc1, dd, pos }) {
  if (pc1<=-25 || (pc5<=-8 && pc1<0)) return "FREEFALL";
  if ((dd??0)>=40 && Math.abs(pc5)<5 && pc1>-15) return "BASING";
  if ((pos??0)>0.85 && pc1>40) return "BLOWOFF";
  if (pc1>0) return "GRIND-UP";
  return "CHOP";
}

// fee-yield vs realized-vol edge (fr = daily fee %, sigma = daily vol %)
const edgeFrom = (fr, sigma) => ((fr*0.9)/Math.max(sigma,.001)) / Math.max(1.3*sigma/160,.001);

const ignition = ({ edge, sg, ac, org, path, ageH, ofi }) =>
  edge>=1.0 && sg>=1.25 && ac>=1.2 && org>=40 && path!=="FREEFALL" && (ageH>=6 || (org>=60 && ofi<2));

// edge floor raised 0.5 -> 0.8 (2026-08-08). The 0.5 discount assumed the post-crash
// lookback inflates sigma and understates edge; live it admitted serial floor-breakers
// (BUTTHOLE: -8.9/-8.6 on BASING entries in three days - a landing in a stair-step
// decline has great fees right up until the floor gives). Replay splits the old
// 0.5-1 bucket cleanly at 0.8: 0.5-0.8 = -6.1% (n=27), 0.8-1.0 = +1.9% (5/7 wins).
const basing = ({ path, ofi, org, fr, edge }) =>
  path==="BASING" && ofi<=1.0 && org>=60 && fr>=15 && edge>=0.8;

// BASE-ANCHORED floor: nearest consolidation low below price (6h preferred, then
// 24h, then a synthetic -15%). rawW = how far below price that floor sits, in %.
// The TIGHT-BASE gate itself (rawW <= CFG.BASING_MAX_FLOOR) stays with the caller
// so the config dependency doesn't leak in here.
function basingFloor({ px, low, low6h }) {
  const floor = (low6h > 0 && low6h < px) ? low6h : ((low > 0 && low < px) ? low : px * 0.85);
  const rawW = px > 0 ? ((px - floor) / px) * 100 : 18;
  return { floor, rawW };
}

const carry = ({ edge, ofi6, org, tvl, fr, sigma, ageH, audit, path }) =>
  edge>=1.3 && ofi6<1.0 && org>=60 && (tvl||0)>=100000 && (fr>=2 || (fr>=1.2 && edge>=2) || (fr>=0.6 && edge>=3 && sigma<10)) && ageH>=72 && audit.mintAuthorityDisabled===true && audit.freezeAuthorityDisabled===true && ["CHOP","BASING","GRIND-UP"].includes(path);

const squeeze = ({ sqzPersist, path, pos, ofi, org, ageH, tvl, fr }) =>
  sqzPersist && path === "CHOP" && (pos == null || (pos >= 0.35 && pos <= 0.65)) && ofi >= 0.5 && ofi <= 2 && org >= 60 && ageH >= 24 && (tvl||0) >= 80000 && fr >= 1;

module.exports = { classifyPath, edgeFrom, ignition, basing, basingFloor, carry, squeeze };
