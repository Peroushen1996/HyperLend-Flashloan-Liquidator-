// bot/src/utils/positions.js
const axios = require("axios");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Import Pool ABI to get user data directly
const PoolArtifact = require("@aave/core-v3/artifacts/contracts/protocol/pool/Pool.sol/Pool.json");

/**
 * Pair largest supply with largest borrow (kept for compatibility)
 */
function pairLargestSupplyWithLargestBorrow(supplyBalances, borrowBalances) {
  const sortedSupplies = supplyBalances
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const sortedBorrows = borrowBalances
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  const length = Math.min(sortedSupplies.length, sortedBorrows.length);
  const result = [];

  for (let i = 0; i < length; i++) {
    result.push([sortedSupplies[i], sortedBorrows[i]]);
  }

  return result;
}

/**
 * ---------------------------
 * ✅ Provider w/ proper staticNetwork (ethers v6)
 * Fixes: staticNetwork.matches is not a function
 * ---------------------------
 */
const HYPEREVM_NETWORK = new ethers.Network("hyperEvm", 999); // chainId 999

function getRpcList() {
  const rpcs = [
    process.env.SEND_RPC,
    "https://rpc.hyperliquid.xyz/evm",
    "https://1rpc.io/hyperliquid",
  ].filter(Boolean);

  return rpcs.length ? rpcs : [process.env.SEND_RPC].filter(Boolean);
}

let _providerWrapper = null;
let _rpcIdx = 0;

function makeProvider() {
  const rpcs = getRpcList();

  const build = (idx) =>
    new ethers.JsonRpcProvider(rpcs[idx % rpcs.length], HYPEREVM_NETWORK, {
      staticNetwork: HYPEREVM_NETWORK,
    });

  let provider = build(_rpcIdx);

  provider._rotateRpc = () => {
    _rpcIdx = (_rpcIdx + 1) % rpcs.length;
    provider = build(_rpcIdx);
    console.log(`   [RPC] Rotated to RPC index ${_rpcIdx}: ${rpcs[_rpcIdx]}`);
    return provider;
  };

  provider._get = () => provider;

  return provider;
}

function getProvider() {
  if (!_providerWrapper) _providerWrapper = makeProvider();
  return _providerWrapper._get();
}

/**
 * Enhanced retry with exponential backoff and better error logging
 */
async function withRpcRetry(fn, tries = 3, label = "RPC call") {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const result = await Promise.race([
        fn(getProvider()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout")), 30000)
        ),
      ]);
      return result;
    } catch (e) {
      lastErr = e;
      const isTimeout = e.message.includes("timeout") || e.code === "ETIMEDOUT";
      const isNetwork = e.code === "ECONNREFUSED" || e.code === "ENOTFOUND";

      console.log(
        `   ⚠️  ${label} attempt ${i + 1}/${tries} failed: ${e.message.slice(0, 80)}`
      );

      if (isTimeout || isNetwork) {
        try {
          if (_providerWrapper && typeof _providerWrapper._rotateRpc === "function") {
            _providerWrapper._rotateRpc();
          }
        } catch (_) {}
      }

      if (i < tries - 1) {
        const backoff = Math.min(1000 * Math.pow(2, i), 10000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

/**
 * ---- Markets + ReserveData caching (avoids refetching every cycle) ----
 */
let _marketsCache = null;
let _marketsCacheAt = 0;

let _reserveDataCache = null; // Map lower(underlying) -> reserveData
let _reserveDataCacheAt = 0;

async function getMarketsCached() {
  const ttlMs = Number(process.env.MARKETS_CACHE_TTL_MS || 5 * 60 * 1000);
  const now = Date.now();

  if (_marketsCache && now - _marketsCacheAt < ttlMs) return _marketsCache;

  try {
    const url = "https://api.hyperlend.finance/data/markets";
    const res = await axios.get(url, {
      params: { chain: "hyperEvm" },
      timeout: 15000,
    });

    const reserves = res?.data?.reserves || [];
    if (!Array.isArray(reserves) || reserves.length === 0) {
      throw new Error("HyperLend markets API returned no reserves");
    }

    _marketsCache = reserves.map((r) => ({
      underlying: String(r.underlyingAsset).toLowerCase(),
      symbol: r.symbol,
      name: r.name,
      decimals: Number(r.decimals),
      isActive: !!r.isActive,
      isFrozen: !!r.isFrozen,
      borrowingEnabled: !!r.borrowingEnabled,
      usageAsCollateralEnabled: !!r.usageAsCollateralEnabled,
    }));
    _marketsCacheAt = now;

    console.log(`   ✅ Cached ${_marketsCache.length} markets from HyperLend API`);
    return _marketsCache;
  } catch (err) {
    console.log(`   ⚠️  Failed to fetch markets: ${err.message}`);
    if (_marketsCache) {
      console.log(`   📦 Using stale markets cache (${_marketsCache.length} reserves)`);
      return _marketsCache;
    }
    throw err;
  }
}

async function getReserveDataCached(pool) {
  const ttlMs = Number(process.env.RESERVE_DATA_CACHE_TTL_MS || 10 * 60 * 1000);
  const now = Date.now();

  if (_reserveDataCache && now - _reserveDataCacheAt < ttlMs) return _reserveDataCache;

  const markets = await getMarketsCached();

  const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
  const reservesToScan = activeOnly
    ? markets.filter((m) => m.isActive && !m.isFrozen)
    : markets;

  const maxScan = Number(process.env.MAX_RESERVES_SCAN || 0);
  const list = maxScan > 0 ? reservesToScan.slice(0, maxScan) : reservesToScan;

  const map = new Map();
  const CONCURRENCY = Number(process.env.RESERVE_SCAN_CONCURRENCY || 5);
  let i = 0;
  let successCount = 0;

  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const u = list[idx].underlying;
      try {
        const rd = await pool.getReserveData(u);
        map.set(u, {
          aTokenAddress: rd.aTokenAddress,
          variableDebtTokenAddress: rd.variableDebtTokenAddress,
          stableDebtTokenAddress: rd.stableDebtTokenAddress,
        });
        successCount++;
      } catch (err) {
        console.log(`     ⚠️  Failed to get reserve data for ${list[idx].symbol}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  _reserveDataCache = map;
  _reserveDataCacheAt = now;
  console.log(`   ✅ Cached ${successCount}/${list.length} reserve data entries`);
  return map;
}

/**
 * ---------------------------
 * On-chain borrower discovery:
 * Scan variableDebtToken Transfer(0x0 -> user) logs (debt mint)
 * IMPROVED:
 * - Expand window incrementally (prevents rescan issues)
 * - Better error handling per block range
 * - Track per-reserve state separately
 * ---------------------------
 */
const STATE_PATH = path.resolve(__dirname, "..", ".borrow-scan-state.json");

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    console.log(`   ⚠️  Could not read state file: ${err.message}`);
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.log(`   ⚠️  Could not write state file: ${err.message}`);
  }
}

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

async function scanDebtMintsForReserve(provider, debtToken, fromBlock, toBlock) {
  try {
    const logs = await provider.getLogs({
      address: debtToken,
      fromBlock,
      toBlock,
      topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, null],
    });

    const borrowers = [];
    for (const log of logs) {
      const toTopic = log.topics[2];
      if (!toTopic || toTopic.length !== 66) continue;
      try {
        const to = ethers.getAddress("0x" + toTopic.slice(26));
        borrowers.push(to.toLowerCase());
      } catch {
        // skip malformed topics
      }
    }
    return borrowers;
  } catch (err) {
    console.log(
      `     ⚠️  Log scan failed for blocks ${fromBlock}-${toBlock}: ${err.message}`
    );
    return [];
  }
}

async function getBorrowerSetOnchain() {
  return withRpcRetry(
    async (provider) => {
      const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);

      const markets = await getMarketsCached();
      const reserveDataMap = await getReserveDataCached(pool);

      const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
      const reserves = activeOnly
        ? markets.filter((m) => m.isActive && !m.isFrozen && m.borrowingEnabled)
        : markets;

      const maxScan = Number(process.env.MAX_RESERVES_SCAN || 0);
      const list = maxScan > 0 ? reserves.slice(0, maxScan) : reserves;

      const state = readState();
      state.perDebtToken = state.perDebtToken || {};

      const latest = await provider.getBlockNumber();

      const LOOKBACK_BLOCKS = Number(process.env.BORROW_SCAN_LOOKBACK_BLOCKS || 500_000);
      const STEP = Number(process.env.BORROW_SCAN_STEP || 5_000);
      const MAX_BLOCKS_PER_RUN = Number(process.env.BORROW_SCAN_MAX_BLOCKS_PER_RUN || 100_000);

      const borrowers = new Set();

      const CONCURRENCY = Number(process.env.BORROW_SCAN_CONCURRENCY || 2);
      let i = 0;
      let logsScanned = 0;

      async function worker() {
        while (i < list.length) {
          const idx = i++;
          const m = list[idx];
          const rd = reserveDataMap.get(m.underlying);
          const debtToken = rd?.variableDebtTokenAddress;
          if (!debtToken) continue;

          const key = debtToken.toLowerCase();
          const lastDone = Number(state.perDebtToken[key]?.lastScannedBlock || 0);

          // Start from last scanned OR expand lookback incrementally
          let start = lastDone > 0 ? lastDone + 1 : Math.max(0, latest - LOOKBACK_BLOCKS);
          if (start > latest) continue;

          const cappedEnd = Math.min(latest, start + MAX_BLOCKS_PER_RUN);

          let from = start;
          let blocksCovered = 0;
          let totalFoundThisReserve = 0;
          while (from <= cappedEnd) {
            const to = Math.min(from + STEP - 1, cappedEnd);
            const foundHere = await scanDebtMintsForReserve(provider, debtToken, from, to);
            for (const b of foundHere) borrowers.add(b);

            totalFoundThisReserve += foundHere.length;
            blocksCovered += to - from + 1;
            logsScanned++;

            state.perDebtToken[key] = { lastScannedBlock: to };
            from = to + 1;
          }

          if (blocksCovered > 0) {
            console.log(
              `     ✅ ${m.symbol}: covered blocks ${start}-${cappedEnd} (${blocksCovered} blocks, ${totalFoundThisReserve} mints)`
            );
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      state.lastGlobalBlock = latest;
      writeState(state);

      console.log(`   📊 Discovered ${borrowers.size} unique borrowers from ${logsScanned} log queries`);
      return borrowers;
    },
    3,
    "getBorrowerSetOnchain"
  );
}

async function filterActiveBorrowers(borrowers) {
  return withRpcRetry(
    async (provider) => {
      const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);

      const markets = await getMarketsCached();
      const reserveDataMap = await getReserveDataCached(pool);

      const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
      const reserves = activeOnly
        ? markets.filter((m) => m.isActive && !m.isFrozen && m.borrowingEnabled)
        : markets;

      const maxScan = Number(process.env.MAX_RESERVES_SCAN || 0);
      const list = maxScan > 0 ? reserves.slice(0, maxScan) : reserves;

      const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];

      const debtTokens = [];
      for (const m of list) {
        const rd = reserveDataMap.get(m.underlying);
        if (!rd?.variableDebtTokenAddress) continue;
        debtTokens.push({
          debtToken: rd.variableDebtTokenAddress,
          symbol: m.symbol,
          contract: new ethers.Contract(rd.variableDebtTokenAddress, ERC20_ABI, provider),
        });
      }

      const users = Array.from(borrowers);
      const MAX_USERS = Number(process.env.MAX_USERS_TO_CHECK || 1000);
      const slice = users.slice(0, MAX_USERS);

      const active = [];
      const CONCURRENCY = Number(process.env.ACTIVE_BORROWER_CONCURRENCY || 5);
      let i = 0;
      let checked = 0;

      async function worker() {
        while (i < slice.length) {
          const idx = i++;
          const user = slice[idx];

          try {
            let hasDebt = false;
            for (const dt of debtTokens) {
              try {
                const bal = await dt.contract.balanceOf(user);
                if (bal > 0n) {
                  hasDebt = true;
                  break;
                }
              } catch {
                // skip token check errors
              }
            }
            if (hasDebt) active.push(user);
            checked++;
          } catch (err) {
            console.log(`     ⚠️  Balance check failed for ${user}: ${err.message}`);
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      console.log(`   ✅ Checked ${checked}/${slice.length} borrowers; ${active.length} have active debt`);
      return active;
    },
    3,
    "filterActiveBorrowers"
  );
}

/**
 * Get detailed position:
 * - markets list (all reserves)
 * - pool.getReserveData (cached)
 * - aToken + variableDebtToken balanceOf for REAL user amounts
 */
async function getDetailedPositionFromAPI(walletData) {
  return withRpcRetry(
    async (provider) => {
      const pool = new ethers.Contract(
        process.env.POOL_ADDRESS,
        PoolArtifact.abi,
        provider
      );
      const ERC20_ABI = ["function balanceOf(address account) external view returns (uint256)"];

      const user = String(walletData.wallet_address);

      const markets = await getMarketsCached();
      const reserveDataMap = await getReserveDataCached(pool);

      const activeOnly = String(process.env.SCAN_ACTIVE_ONLY || "true").toLowerCase() !== "false";
      const reserves = activeOnly ? markets.filter((m) => m.isActive && !m.isFrozen) : markets;

      const maxScan = Number(process.env.MAX_RESERVES_SCAN || 0);
      const list = maxScan > 0 ? reserves.slice(0, maxScan) : reserves;

      const supply = [];
      const borrow = [];

      const CONCURRENCY = Number(process.env.POSITION_SCAN_CONCURRENCY || 8);
      let i = 0;

      async function worker() {
        while (i < list.length) {
          const idx = i++;
          const m = list[idx];

          const rd = reserveDataMap.get(m.underlying);
          if (!rd?.aTokenAddress || !rd?.variableDebtTokenAddress) continue;

          try {
            const aToken = new ethers.Contract(rd.aTokenAddress, ERC20_ABI, provider);
            const debtToken = new ethers.Contract(rd.variableDebtTokenAddress, ERC20_ABI, provider);

            const [aBal, dBal] = await Promise.all([
              aToken.balanceOf(user),
              debtToken.balanceOf(user),
            ]);

            if (aBal > 0n) {
              supply.push({
                underlying: m.underlying,
                symbol: m.symbol,
                amount: aBal.toString(),
                decimals: String(m.decimals),
              });
            }

            if (dBal > 0n) {
              borrow.push({
                underlying: m.underlying,
                symbol: m.symbol,
                amount: dBal.toString(),
                decimals: String(m.decimals),
              });
            }
          } catch (err) {
            console.log(
              `     ⚠️  Balance fetch failed for ${m.symbol}: ${err.message}`
            );
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      return { supply, borrow };
    },
    3,
    "getDetailedPositionFromAPI"
  );
}

/**
 * MAIN: Get ACTIVE borrowers (on-chain debt > 0) then filter 0 < HF < 1
 * IMPROVED:
 * - Better logging of each step
 * - Cache active borrower set for subsequent checks
 * - Always re-check HF (don't trust stale data)
 */
let _activeBorrowerCache = null;
let _activeBorrowerCacheAt = 0;

async function getLiquidatableWallets() {
  try {
    console.log("🔍 Scanning for liquidatable borrowers...");

    // Step 1: Discover borrowers from logs
    console.log("   Step 1: Building borrower set from on-chain debt mints...");
    const borrowerSet = await getBorrowerSetOnchain();

    if (borrowerSet.size === 0) {
      console.log("   ⚠️  No borrowers discovered yet from logs.\n");
      return [];
    }

    // Step 2: Filter to those with active debt
    console.log(
      `   Step 2: Filtering ${borrowerSet.size} borrowers to find those with active debt...`
    );
    const activeBorrowers = await filterActiveBorrowers(borrowerSet);

    if (activeBorrowers.length === 0) {
      console.log("   ⚠️  No borrowers with active debt found.\n");
      return [];
    }

    _activeBorrowerCache = activeBorrowers;
    _activeBorrowerCacheAt = Date.now();

    // Step 3: Check health factors on-chain
    console.log(
      `   Step 3: Checking ${activeBorrowers.length} borrowers for HF < 1...`
    );

    const liquidatable = await withRpcRetry(
      async (provider) => {
        const pool = new ethers.Contract(process.env.POOL_ADDRESS, PoolArtifact.abi, provider);
        const ONE = ethers.parseUnits("1", 18);

        const out = [];
        const CONCURRENCY = Number(process.env.HF_CONCURRENCY || 5);
        let i = 0;
        let hfChecked = 0;
        let liquidatableCount = 0;

        async function worker() {
          while (i < activeBorrowers.length) {
            const idx = i++;
            const user = activeBorrowers[idx];

            try {
              const data = await pool.getUserAccountData(user);
              const hf = data[5];
              hfChecked++;

              if (hf > 0n && hf < ONE) {
                liquidatableCount++;
                out.push({
                  wallet_address: user,
                  health_rate: ethers.formatUnits(hf, 18),
                  total_supply: "0",
                  total_borrow: "0",
                  supplied_assets: [],
                  borrowed_assets: [],
                });
              }
            } catch (err) {
              console.log(
                `     ⚠️  HF check failed for ${user.slice(0, 8)}...: ${err.message}`
              );
            }
          }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        console.log(
          `   ✅ HF check complete: ${liquidatableCount}/${hfChecked} borrowers have 0 < HF < 1`
        );
        return out;
      },
      3,
      "HF check"
    );

    liquidatable.sort((a, b) => parseFloat(a.health_rate) - parseFloat(b.health_rate));

    return liquidatable;
  } catch (error) {
    console.error("❌ Failed to fetch borrowers / check HF:", error.message);
    return [];
  }
}

module.exports = {
  pairLargestSupplyWithLargestBorrow,
  getDetailedPositionFromAPI,
  getLiquidatableWallets,
};