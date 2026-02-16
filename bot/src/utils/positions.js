// bot/src/utils/positions.js - OPTIMIZED WITH PARALLEL PROCESSING
// Includes: API integration, liquidation events, parallel HF checks, zombie filtering

const axios = require("axios");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const PoolArtifact = require("@aave/core-v3/artifacts/contracts/protocol/pool/Pool.sol/Pool.json");

const STATE_PATH = path.resolve(__dirname, "..", "..", ".borrow-scan-state.json");

// ============================================================================
// PERFORMANCE CONFIGURATION
// ============================================================================
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "20", 10); // Process 20 borrowers in parallel
const HF_DELAY_MS = parseInt(process.env.HF_DELAY_MS || "0", 10);
const MIN_PROCESSABLE_HF = ethers.parseUnits("0.01", 18); // Filter out dust/zombie positions
const POSITION_API_TIMEOUT_MS = 15000; // 15 second timeout for position API calls

// Position cache
const positionCache = new Map();
const POSITION_CACHE_TTL_MS = 30000;

function getCachedPosition(user) {
  const cached = positionCache.get(user.toLowerCase());
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > POSITION_CACHE_TTL_MS) {
    positionCache.delete(user.toLowerCase());
    return null;
  }
  
  return cached.positions;
}

function setCachedPosition(user, positions) {
  positionCache.set(user.toLowerCase(), {
    positions,
    timestamp: Date.now()
  });
  
  if (positionCache.size > 1000) {
    const entries = Array.from(positionCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, 100);
    toDelete.forEach(([key]) => positionCache.delete(key));
  }
}

function pairLargestSupplyWithLargestBorrow(supplyBalances, borrowBalances) {
  const sortedSupplies = supplyBalances.filter((e) => e.value > 0).sort((a, b) => b.value - a.value);
  const sortedBorrows = borrowBalances.filter((e) => e.value > 0).sort((a, b) => b.value - a.value);

  const length = Math.min(sortedSupplies.length, sortedBorrows.length);
  const result = [];
  for (let i = 0; i < length; i++) result.push([sortedSupplies[i], sortedBorrows[i]]);
  return result;
}


// Provider setup
const HYPEREVM_NETWORK = new ethers.Network("hyperEvm", 999);

function getRpcList() {
  const fallbacks = String(process.env.RPC_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rpcs = [process.env.SEND_RPC, ...fallbacks].filter(Boolean);
  if (!rpcs.length) throw new Error("No RPC configured");
  return rpcs;
}

let _rpcIdx = 0;
let _provider = null;

function buildProvider(idx) {
  const rpcs = getRpcList();
  return new ethers.JsonRpcProvider(rpcs[idx % rpcs.length], HYPEREVM_NETWORK, {
    staticNetwork: HYPEREVM_NETWORK,
  });
}

function getProvider() {
  if (!_provider) _provider = buildProvider(_rpcIdx);
  return _provider;
}

function rotateProvider() {
  const rpcs = getRpcList();
  _rpcIdx = (_rpcIdx + 1) % rpcs.length;
  _provider = buildProvider(_rpcIdx);
  console.log(`   [RPC] Rotated to RPC index ${_rpcIdx}: ${rpcs[_rpcIdx]}`);
  return _provider;
}

function isRetryableRpcError(e) {
  const msg = String(e?.message || "").toLowerCase();
  const code = e?.code;

  if (msg.includes("timeout")) return true;
  if (msg.includes("rate limited")) return true;
  if (msg.includes("too many requests")) return true;
  if (msg.includes("gateway timeout")) return true;
  if (msg.includes("bad gateway") || msg.includes("502")) return true;
  if (msg.includes("503")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("missing response")) return true;
  if (msg.includes("504")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  if (code === "BAD_DATA" || code === "UNKNOWN_ERROR") return true;

  return false;
}

async function withRpcRetry(fn, tries = 3, label = "RPC") {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(getProvider());
    } catch (e) {
      lastErr = e;
      console.log(`   ⚠️  ${label} attempt ${i + 1}/${tries} failed: ${String(e?.message || "").slice(0, 160)}`);
      if (isRetryableRpcError(e)) rotateProvider();
      const backoff = Math.min(1200 * Math.pow(2, i), 12000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

let _getLogsBusy = false;
async function gatedGetLogs(provider, filter) {
  const delay = Number(process.env.GETLOGS_DELAY_MS || 500);
  const timeoutMs = Number(process.env.GETLOGS_TIMEOUT_MS || 45000);

  while (_getLogsBusy) await new Promise((r) => setTimeout(r, 50));
  _getLogsBusy = true;

  try {
    const res = await Promise.race([
      provider.getLogs(filter),
      new Promise((_, reject) => setTimeout(() => reject(new Error("getLogs timeout")), timeoutMs)),
    ]);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return res;
  } finally {
    _getLogsBusy = false;
  }
}

// Markets cache
let _marketsCache = null;
let _marketsCacheAt = 0;
let _reserveDataCache = null;
let _reserveDataCacheAt = 0;
let _marketByUnderlying = null;

function normalizeBonus(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;

  if (n >= 10000 && n <= 20000) return n;
  if (n > 0 && n < 1000) return 10000 + Math.round(n * 100);
  return null;
}

async function getMarketsCached() {
  const ttlMs = Number(process.env.MARKETS_CACHE_TTL_MS || 1800000); // 30 min default
  const now = Date.now();
  if (_marketsCache && now - _marketsCacheAt < ttlMs) return _marketsCache;

  const base = process.env.HYPERLEND_API_BASE || "https://api.hyperlend.finance";
  const pathp = process.env.MARKETS_API_PATH || "/data/markets";
  const url = `${base}${pathp}`;

  try {
    const res = await axios.get(url, { params: { chain: "hyperEvm" }, timeout: 15000 });
    const reserves = res?.data?.reserves || [];
    if (!Array.isArray(reserves) || !reserves.length) throw new Error("markets API empty");

    _marketsCache = reserves.map((r) => {
      const underlying = String(r.underlyingAsset).toLowerCase();
      const liquidationBonusBps = normalizeBonus(
        r.liquidationBonus ?? r.reserveLiquidationBonus ?? r.liquidationBonusBps ?? r.liquidation_bonus
      );

      return {
        underlying,
        symbol: r.symbol,
        decimals: Number(r.decimals),
        isActive: !!r.isActive,
        isFrozen: !!r.isFrozen,
        borrowingEnabled: !!r.borrowingEnabled,
        usageAsCollateralEnabled: !!r.usageAsCollateralEnabled,
        liquidationBonusBps,
      };
    });

    _marketsCacheAt = now;

    _marketByUnderlying = new Map();
    for (const m of _marketsCache) _marketByUnderlying.set(m.underlying, m);

    console.log(`   ✅ Cached ${_marketsCache.length} markets from HyperLend API`);
    return _marketsCache;
  } catch (e) {
    console.log(`   ⚠️  Failed to fetch markets: ${String(e?.message || "").slice(0, 140)}`);
    if (_marketsCache) return _marketsCache;
    throw e;
  }
}

function getMarketMetaByUnderlying(underlying) {
  if (!_marketByUnderlying) return null;
  return _marketByUnderlying.get(String(underlying || "").toLowerCase()) || null;
}

async function getReserveDataCached(pool) {
  const ttlMs = Number(process.env.RESERVE_DATA_CACHE_TTL_MS || 1800000); // 30 min default
  const now = Date.now();
  if (_reserveDataCache && now - _reserveDataCacheAt < ttlMs) return _reserveDataCache;

  const markets = await getMarketsCached();
  const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
  const list = activeOnly ? markets.filter((m) => m.isActive && !m.isFrozen) : markets;

  const map = new Map();
  let ok = 0;

  for (const m of list) {
    try {
      const rd = await pool.getReserveData(m.underlying);
      map.set(m.underlying, {
        aTokenAddress: rd.aTokenAddress,
        variableDebtTokenAddress: rd.variableDebtTokenAddress,
        stableDebtTokenAddress: rd.stableDebtTokenAddress,
      });
      ok++;
    } catch (e) {
      console.log(`     ⚠️ reserveData failed for ${m.symbol}: ${String(e?.message || "").slice(0, 110)}`);
    }
  }

  _reserveDataCache = map;
  _reserveDataCacheAt = now;
  console.log(`   ✅ Cached ${ok}/${list.length} reserve data entries`);
  return map;
}

// State management
function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.log(`   ⚠️  Could not write state file: ${String(e?.message || "").slice(0, 90)}`);
  }
}

function seedBorrowersFromEnv(state) {
  const seeds = String(process.env.SEED_BORROWERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length === 42 && s.startsWith("0x"));

  if (!seeds.length) return;

  state.knownBorrowers = state.knownBorrowers || [];
  const set = new Set(state.knownBorrowers);
  for (const s of seeds) set.add(s);
  state.knownBorrowers = Array.from(set);
}

function mergeKnownBorrowers(state, borrowers) {
  state.knownBorrowers = state.knownBorrowers || [];
  const set = new Set(state.knownBorrowers);
  for (const b of borrowers) set.add(String(b).toLowerCase());

  const cap = Number(process.env.KNOWN_BORROWERS_CAP || 50000);
  const arr = Array.from(set);
  state.knownBorrowers = arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function extractToFromTransferLog(log) {
  const toTopic = log?.topics?.[2];
  if (!toTopic || toTopic.length !== 66) return null;
  try {
    return ethers.getAddress("0x" + toTopic.slice(26)).toLowerCase();
  } catch {
    return null;
  }
}

// Scan recent liquidation events
async function scanRecentLiquidations() {
  if (String(process.env.ENABLE_LIQUIDATION_SCANNING || "true").toLowerCase() === "false") {
    return [];
  }

  try {
    const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, getProvider());
    
    const LIQUIDATION_TOPIC = ethers.id(
      "LiquidationCall(address,address,address,uint256,uint256,address,bool)"
    );
    
    const latest = await getProvider().getBlockNumber();
    const lookback = Number(process.env.LIQUIDATION_LOOKBACK_BLOCKS || 100000);
    
    const logs = await gatedGetLogs(getProvider(), {
      address: process.env.POOL_ADDRESS,
      fromBlock: Math.max(0, latest - lookback),
      toBlock: latest,
      topics: [LIQUIDATION_TOPIC]
    });
    
    const liquidatedUsers = new Set();
    for (const log of logs) {
      try {
        const decoded = pool.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        
        if (decoded?.args?.user) {
          liquidatedUsers.add(String(decoded.args.user).toLowerCase());
        }
      } catch {}
    }
    
    if (liquidatedUsers.size > 0) {
      console.log(`   📊 Found ${liquidatedUsers.size} recently liquidated users (may borrow again)`);
    }
    
    return Array.from(liquidatedUsers);
  } catch (e) {
    console.log(`   ⚠️  Could not scan liquidation events: ${String(e?.message || "").slice(0, 100)}`);
    return [];
  }
}

// Try HyperLend API for distressed positions
async function getDistressedPositionsFromAPI() {
  if (String(process.env.ENABLE_API_SCANNING || "true").toLowerCase() === "false") {
    return [];
  }

  const apiBase = process.env.HYPERLEND_API_BASE || "https://api.hyperlend.finance";
  const foundUsers = [];
  
  const endpoints = [
    { path: "/data/liquidations", params: { chain: "hyperEvm", limit: 100 } },
    { path: "/api/liquidations", params: { chain: "hyperEvm", limit: 100 } },
    { path: "/data/users", params: { chain: "hyperEvm", healthFactorMax: "1.1", limit: 500 } },
    { path: "/api/users", params: { chain: "hyperEvm", healthFactorMax: "1.1", limit: 500 } },
  ];
  
  for (const endpoint of endpoints) {
    try {
      const url = `${apiBase}${endpoint.path}`;
      const res = await axios.get(url, {
        params: endpoint.params,
        timeout: 10000
      });
      
      const data = res?.data;
      
      if (data?.liquidations && Array.isArray(data.liquidations)) {
        const users = data.liquidations.map(l => l.user?.toLowerCase() || l.address?.toLowerCase()).filter(Boolean);
        if (users.length > 0) {
          console.log(`   ✅ Found ${users.length} liquidations from API ${endpoint.path}`);
          foundUsers.push(...users);
          break;
        }
      }
      
      if (data?.users && Array.isArray(data.users)) {
        const users = data.users.map(u => u.address?.toLowerCase() || u.id?.toLowerCase()).filter(Boolean);
        if (users.length > 0) {
          console.log(`   ✅ Found ${users.length} distressed positions from API ${endpoint.path}`);
          foundUsers.push(...users);
          break;
        }
      }
      
    } catch (e) {
      continue;
    }
  }
  
  if (foundUsers.length === 0) {
    console.log(`   ℹ️  No distressed positions from API (normal in stable markets)`);
  }
  
  return [...new Set(foundUsers)];
}

async function scanDebtMintsAdaptive(debtToken, fromBlock, toBlock) {
  let range = Number(process.env.GETLOGS_START_BLOCK_RANGE || 900);
  const minRange = Number(process.env.GETLOGS_MIN_BLOCK_RANGE || 50);

  const SAME_CHUNK_RETRIES = Number(process.env.GETLOGS_RETRIES_PER_CHUNK || 3);
  const JITTER_MS = Number(process.env.GETLOGS_JITTER_MS || 250);

  let cursor = fromBlock;
  const borrowers = new Set();
  let progressedTo = null;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + range - 1, toBlock);

    let ok = false;
    let lastErr = null;

    for (let attempt = 1; attempt <= SAME_CHUNK_RETRIES; attempt++) {
      try {
        const provider = getProvider();

        const logs = await gatedGetLogs(provider, {
          address: debtToken,
          fromBlock: cursor,
          toBlock: end,
          topics: [TRANSFER_TOPIC, ZERO_TOPIC, null],
        });

        for (const l of logs) {
          const addr = extractToFromTransferLog(l);
          if (addr) borrowers.add(addr);
        }

        progressedTo = end;
        cursor = end + 1;
        ok = true;

        const maxRange = Number(process.env.GETLOGS_START_BLOCK_RANGE || 900);
        if (range < maxRange) range = Math.min(maxRange, Math.floor(range * 1.5));

        break;
      } catch (e) {
        lastErr = e;

        const msg = String(e?.message || "").toLowerCase();
        const maxRangeErr = msg.includes("max block range") || msg.includes("query exceeds max block range");
        const retryable = isRetryableRpcError(e) || maxRangeErr;

        if (!retryable) {
          console.log(`     ⚠️ getLogs non-retryable ${cursor}-${end}: ${String(e?.message || "").slice(0, 160)}`);
          return { borrowers: Array.from(borrowers), progressedTo };
        }

        const backoff = Math.min(800 * Math.pow(2, attempt - 1), 8000);
        const jitter = Math.floor(Math.random() * JITTER_MS);
        await new Promise((r) => setTimeout(r, backoff + jitter));

        rotateProvider();

        if (maxRangeErr) break;
      }
    }

    if (ok) continue;

    range = Math.max(minRange, Math.floor(range / 2));
    console.log(
      `     ⚠️ getLogs chunk failed ${cursor}-${end} (${String(lastErr?.message || "").slice(0, 80)}), shrinking -> ${range}`
    );

    if (range === minRange) {
      console.log(`     ⚠️ at minRange=${minRange} and still failing; aborting this token range this cycle`);
      break;
    }
  }

  return { borrowers: Array.from(borrowers), progressedTo };
}

async function getBorrowerSetFromDebtMints() {
  return withRpcRetry(async (provider) => {
    const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);

    const markets = await getMarketsCached();
    const reserveDataMap = await getReserveDataCached(pool);

    const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
    const reserves = activeOnly
      ? markets.filter((m) => m.isActive && !m.isFrozen && m.borrowingEnabled)
      : markets;

    const latest = await provider.getBlockNumber();

    const LOOKBACK = Number(process.env.SCAN_LOOKBACK_BLOCKS || 500000);
    const MAX_PER_RUN = Number(process.env.BORROW_SCAN_MAX_BLOCKS_PER_RUN || 50000);

    const state = readState();
    state.perDebtToken = state.perDebtToken || {};
    state.cooldowns = state.cooldowns || {};
    const nowMs = Date.now();

    seedBorrowersFromEnv(state);

    const newBorrowers = new Set();
    let queries = 0;
    let skippedByCooldown = 0;

    // Scan liquidation events first
    const recentlyLiquidated = await scanRecentLiquidations();
    if (recentlyLiquidated.length > 0) {
      for (const addr of recentlyLiquidated) {
        newBorrowers.add(addr);
      }
    }

    // Check API for distressed positions
    const apiDistressed = await getDistressedPositionsFromAPI();
    if (apiDistressed.length > 0) {
      for (const addr of apiDistressed) {
        newBorrowers.add(addr);
      }
    }

    // Existing debt mints scanning
    for (const m of reserves) {
      const rd = reserveDataMap.get(m.underlying);
      const debtToken = rd?.variableDebtTokenAddress;
      if (!debtToken) continue;

      const key = debtToken.toLowerCase();

      const cd = state.cooldowns[key];
      if (cd?.untilMs && nowMs < cd.untilMs) {
        skippedByCooldown++;
        continue;
      }

      const lastDone = Number(state.perDebtToken[key]?.lastScannedBlock || 0);

      const start = lastDone > 0 ? lastDone + 1 : Math.max(0, latest - LOOKBACK);
      const end = Math.min(latest, start + MAX_PER_RUN);
      if (start > end) continue;

      const res = await scanDebtMintsAdaptive(debtToken, start, end);
      queries++;

      if (res.progressedTo != null) {
        state.perDebtToken[key] = { lastScannedBlock: res.progressedTo };
        state.cooldowns[key] = { fails: 0, untilMs: 0 };
        console.log(`     ✅ ${m.symbol}: covered blocks ${start}-${res.progressedTo} (${res.borrowers.length} mints)`);
      } else {
        const fails = Number(state.cooldowns[key]?.fails || 0) + 1;
        const waitMs = Math.min(10 * 60 * 1000, fails * 60 * 1000);
        state.cooldowns[key] = { fails, untilMs: Date.now() + waitMs };
        console.log(`     ⚠️  ${m.symbol}: no progress; cooling down ${Math.round(waitMs / 60000)}m`);
        continue;
      }

      for (const b of res.borrowers) newBorrowers.add(b);
    }

    mergeKnownBorrowers(state, Array.from(newBorrowers));
    writeState(state);

    if (skippedByCooldown > 0) {
      console.log(`   ⏭️  Skipped ${skippedByCooldown} token scans due to cooldowns`);
    }

    const knownCount = (state.knownBorrowers || []).length;
    console.log(`   📊 Discovered ${newBorrowers.size} new borrowers from ${queries} token scans + API + events`);
    console.log(`   🧠 Known borrowers persisted: ${knownCount}`);

    return new Set((state.knownBorrowers || []).map((x) => String(x).toLowerCase()));
  }, 3, "getBorrowerSetFromDebtMints");
}

// Timeout wrapper for getDetailedPositionFromAPI
async function getDetailedPositionFromAPIWithTimeout(walletData, timeoutMs = POSITION_API_TIMEOUT_MS) {
  return Promise.race([
    getDetailedPositionFromAPI(walletData),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Position API timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]).catch(err => {
    console.log(`   ⚠️  Failed to fetch position for ${walletData.wallet_address}: ${err.message}`);
    return null;
  });
}

async function getDetailedPositionFromAPI(walletData) {
  const user = String(walletData.wallet_address);
  
  const cached = getCachedPosition(user);
  if (cached) {
    return cached;
  }
  
  return withRpcRetry(async (provider) => {
    const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);
    const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];

    const markets = await getMarketsCached();
    const reserveDataMap = await getReserveDataCached(pool);

    const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
    const reserves = activeOnly ? markets.filter((m) => m.isActive && !m.isFrozen) : markets;

    const supply = [];
    const borrow = [];

    for (const m of reserves) {
      const rd = reserveDataMap.get(m.underlying);
      if (!rd?.aTokenAddress || !rd?.variableDebtTokenAddress) continue;

      try {
        const aToken = new ethers.Contract(rd.aTokenAddress, ERC20_ABI, provider);
        const debtToken = new ethers.Contract(rd.variableDebtTokenAddress, ERC20_ABI, provider);

        const [aBal, dBal] = await Promise.all([aToken.balanceOf(user), debtToken.balanceOf(user)]);

        if (aBal > 0n)
          supply.push({
            underlying: m.underlying,
            symbol: m.symbol,
            amount: aBal.toString(),
            decimals: String(m.decimals),
          });

        if (dBal > 0n)
          borrow.push({
            underlying: m.underlying,
            symbol: m.symbol,
            amount: dBal.toString(),
            decimals: String(m.decimals),
          });
      } catch (e) {
        if (process.env.LOG_POSITION_ERRORS === "true") {
          console.log(`     ⚠️  Failed to fetch ${m.symbol} for ${user.slice(0, 10)}: ${String(e?.message || "").slice(0, 80)}`);
        }
      }
    }

    const result = { supply, borrow };
    setCachedPosition(user, result);
    return result;
  }, 3, "getDetailedPositionFromAPI");
}

// ============================================================================
// PARALLEL HF CHECKING (KEY OPTIMIZATION!)
// ============================================================================

async function checkHealthFactorsParallel(pool, borrowers, constants) {
  const { ONE, WATCH_THRESHOLD, HF_NEAR_LOW, HF_NEAR_HIGH, LOWEST_N } = constants;
  
  let lowest = [];
  let near = [];
  let watchList = [];
  let liquidatable = [];

  console.log(`   🔄 Checking ${borrowers.length} borrowers in parallel (batch size: ${BATCH_SIZE})`);

  // Process in batches for parallel execution
  for (let i = 0; i < borrowers.length; i += BATCH_SIZE) {
    const batch = borrowers.slice(i, Math.min(i + BATCH_SIZE, borrowers.length));
    
    // Execute all HF checks in this batch simultaneously
    const results = await Promise.allSettled(
      batch.map(async (user) => {
        try {
          const data = await pool.getUserAccountData(user);
          const totalDebtBase = data[1];
          const hfBI = data[5];
          
          // Skip if no debt
          if (totalDebtBase === 0n || hfBI === 0n) {
            return null;
          }
          
          return {
            user,
            hfBI,
            hfStr: ethers.formatUnits(hfBI, 18)
          };
        } catch (err) {
          // Silently skip failed checks
          if (process.env.LOG_HF_ERRORS === "true") {
            const msg = String(err?.shortMessage || err?.message || err);
            console.log(`     ⚠️  HF check failed for ${user.slice(0, 10)}...: ${msg.slice(0, 140)}`);
          }
          return null;
        }
      })
    );
    
    // Process results from this batch
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { user, hfBI, hfStr } = result.value;
        
        // Update lowest HF array
        lowest.push({ user, hfBI, hfStr });
        lowest.sort((a, b) => (a.hfBI < b.hfBI ? -1 : a.hfBI > b.hfBI ? 1 : 0));
        if (lowest.length > LOWEST_N) lowest.pop();
        
        // Track near-liquidation positions
        if (hfBI >= HF_NEAR_LOW && hfBI <= HF_NEAR_HIGH) {
          near.push({ user, hfBI, hfStr });
        }
        
        // Track watch list (1.0 < HF < 1.15)
        if (hfBI < WATCH_THRESHOLD && hfBI >= ONE) {
          watchList.push({ user, hfBI, hfStr });
        }
        
        // Track liquidatable positions
        if (hfBI < ONE) {
          liquidatable.push({
            wallet_address: user,
            health_rate: hfStr,
            total_supply: "0",
            total_borrow: "0",
            supplied_assets: [],
            borrowed_assets: [],
          });
        }
      }
    }
    
    // Optional: Small delay between batches to avoid overwhelming RPC
    if (HF_DELAY_MS > 0 && i + BATCH_SIZE < borrowers.length) {
      await new Promise(r => setTimeout(r, HF_DELAY_MS));
    }
  }

  return { lowest, near, watchList, liquidatable };
}

async function getLiquidatableWallets() {
  try {
    console.log("🔍 Scanning for liquidatable borrowers...");
    console.log("   Step 1: Building borrower set...");

    const borrowerSet = await getBorrowerSetFromDebtMints();
    const allBorrowers = Array.from(borrowerSet);

    if (borrowerSet.size === 0) {
      console.log("   ⚠️  No borrowers discovered yet.\n");
      return [];
    }

    console.log(`   Step 2: Checking up to ${Number(process.env.MAX_USERS_TO_CHECK || 500)} borrowers for HF...`);

    const liquidatable = await withRpcRetry(async (provider) => {
      const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);

      const ONE = ethers.parseUnits("1", 18);
      const HF_NEAR_LOW = ethers.parseUnits(String(process.env.HF_NEAR_LOW || "0.90"), 18);
      const HF_NEAR_HIGH = ethers.parseUnits(String(process.env.HF_NEAR_HIGH || "1.30"), 18);
      const WATCH_THRESHOLD = ethers.parseUnits(String(process.env.HF_WATCH_THRESHOLD || "1.15"), 18);
      const LOWEST_N = Number(process.env.LOG_LOWEST_HF || 20);
      const NEAR_N = Number(process.env.LOG_NEAR_HF || 20);
      const MAX_USERS = Number(process.env.MAX_USERS_TO_CHECK || 500);

      const state = readState();
      let checkOffset = Number(state.lastCheckOffset || 0);

      const slice = [];
      for (let i = 0; i < MAX_USERS && i < allBorrowers.length; i++) {
        const idx = (checkOffset + i) % allBorrowers.length;
        slice.push(allBorrowers[idx]);
      }

      const nextOffset = (checkOffset + Math.min(MAX_USERS, allBorrowers.length)) % allBorrowers.length;
      state.lastCheckOffset = nextOffset;
      writeState(state);

      console.log(`   🔄 Checking borrowers ${checkOffset}-${nextOffset} of ${allBorrowers.length}`);

      // Use parallel checking instead of sequential
      const { lowest, near, watchList, liquidatable } = await checkHealthFactorsParallel(
        pool,
        slice,
        { ONE, WATCH_THRESHOLD, HF_NEAR_LOW, HF_NEAR_HIGH, LOWEST_N }
      );

      // Display results
      const showLowest = Number(process.env.LOG_LOWEST_HF || 20);
      if (showLowest > 0 && lowest.length > 0) {
        console.log(`   👀 Lowest HF sample (showing ${Math.min(showLowest, lowest.length)}/${lowest.length}):`);
        lowest.slice(0, showLowest).forEach((x) => console.log(`     - ${x.user} (HF=${x.hfStr})`));
      }

      if (NEAR_N > 0 && near.length > 0) {
        near.sort((a, b) => (a.hfBI < b.hfBI ? -1 : a.hfBI > b.hfBI ? 1 : 0));
        console.log(
          `   👀 Near-HF band ${ethers.formatUnits(HF_NEAR_LOW, 18)}–${ethers.formatUnits(HF_NEAR_HIGH, 18)} ` +
            `(showing ${Math.min(NEAR_N, near.length)}/${near.length}):`
        );
        near.slice(0, NEAR_N).forEach((x) => console.log(`     - ${x.user} (HF=${x.hfStr})`));
      }

      if (watchList.length > 0) {
        watchList.sort((a, b) => (a.hfBI < b.hfBI ? -1 : a.hfBI > b.hfBI ? 1 : 0));
        const showWatch = Math.min(10, watchList.length);
        console.log(`   👁️  Watch list (HF 1.0-${ethers.formatUnits(WATCH_THRESHOLD, 18)}): ${watchList.length} positions (showing ${showWatch}):`);
        watchList.slice(0, showWatch).forEach((x) => console.log(`     - ${x.user} (HF=${x.hfStr})`));
      }

      console.log(`   ✅ HF check complete: ${liquidatable.length} borrowers have 0 < HF < 1`);
      
      // Filter out zombie positions (dust with HF near 0)
      const beforeFilter = liquidatable.length;
      const filtered = liquidatable.filter(entry => {
        const hf = ethers.parseUnits(entry.health_rate || "0", 18);
        
        if (hf < MIN_PROCESSABLE_HF) {
          console.log(`   ⏭️  Skipping zombie/dust position ${entry.wallet_address} (HF=${entry.health_rate}, likely already liquidated)`);
          return false;
        }
        
        return true;
      });
      
      if (beforeFilter > filtered.length) {
        console.log(`   🗑️  Filtered out ${beforeFilter - filtered.length} zombie/dust position(s)`);
      }
      
      return filtered;
    }, 3, "HF check");

    liquidatable.sort((a, b) => parseFloat(a.health_rate) - parseFloat(b.health_rate));
    return liquidatable;
  } catch (e) {
    console.error("❌ Failed to fetch borrowers / check HF:", String(e?.message || e));
    return [];
  }
}

module.exports = {
  pairLargestSupplyWithLargestBorrow,
  getDetailedPositionFromAPI,
  getDetailedPositionFromAPIWithTimeout,
  getLiquidatableWallets,
  getMarketsCached,
  getMarketMetaByUnderlying,
};