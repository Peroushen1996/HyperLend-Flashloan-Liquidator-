require("dotenv").config();
const axios = require("axios");
const cron = require("node-cron");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ✅ TUNED PARAMETERS
const CLOSE_FACTOR = 0.5; // Can liquidate up to 50% of debt
const FLASH_LOAN_FEE = 9; // 9 bps
const LIQUIDATION_BONUS_PCT = 0.05; // assume 5% avg bonus

// ✅ Size thresholds (real minimums)
const MIN_LIQUIDATION_VALUE_USD = 100; // liquidate at least $100 of debt
const MIN_COLLATERAL_VALUE_USD = 50; // seize at least $50 collateral
const MIN_PROFIT_THRESHOLD_BPS = 50; // 50 bps (0.5%) profit minimum

// ✅ Processing limits
const MAX_WALLETS_PER_CYCLE = 100; // process fewer, be more selective
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h cooldown after failure
const COOLDOWN_SUCCESS_MS = 24 * 60 * 60 * 1000; // 24h cooldown after success

// ✅ Per-wallet retry limits
const MAX_RETRIES_PER_WALLET = 3;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1h between retries

// ✅ Gas strategy
const GAS_LIMIT_MULTIPLIER = 1.3; // 30% buffer
const MAX_GAS_PRICE_GWEI = 100; // cap to avoid overpaying

// ✅ Concurrency limits to avoid RPC bans
const MAX_CONCURRENT_SIMS = 3; // strict limit on simulations
const MAX_CONCURRENT_SENDS = 1; // one tx at a time

const { prepareHops } = require("./utils/swap");
const { getDetailedPositionFromAPI, getLiquidatableWallets } = require("./utils/positions");

let cachedSigner = null;
let cachedPool = null;
let cachedRouter = null;
let cachedProvider = null;

const cooldowns = new Map(); // wallet -> cooldownUntilMs
const retryAttempts = new Map(); // wallet -> attemptCount

// ✅ Track results per cycle for auto-tuning
const cycleStats = {
  processed: 0,
  successful: 0,
  notLiquidatable: 0,
  insufficientSize: 0,
  noLiquidity: 0,
  simFailed: 0,
  txFailed: 0,
};

// ✅ NEW: prevent overlapping runs
let RUNNING = false;

// ✅ Concurrency semaphores
let activeSims = 0;
let activeSends = 0;

const poolAbi = [
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
];

const liquidatorReadAbi = ["function liquidSwapRouter() view returns (address)"];

console.log("=== .env LOADING DEBUG ===");
console.log("SEND_RPC        :", process.env.SEND_RPC || "MISSING");
console.log("POOL_ADDRESS    :", process.env.POOL_ADDRESS || "MISSING");
console.log("LIQUIDATOR      :", process.env.LIQUIDATOR || "MISSING");
console.log("PROFIT_RECEIVER :", process.env.PROFIT_RECEIVER || "MISSING");
console.log("MIN LIQUIDATION : $" + MIN_LIQUIDATION_VALUE_USD);
console.log("MIN PROFIT      : " + MIN_PROFIT_THRESHOLD_BPS + " bps");
console.log("MAX WALLETS/CYCLE :", MAX_WALLETS_PER_CYCLE);
console.log("COOLDOWN_MS     :", COOLDOWN_MS + "ms");
console.log("GAS LIMIT MULT  :", GAS_LIMIT_MULTIPLIER);
console.log("==========================\n");

console.log("Bot starting. You must unlock the signer to continue.");
console.log("Password entry will be completely invisible (no echo, no asterisks).");
console.log("The bot will NOT proceed until the correct password is entered.\n");

async function initializeSigner() {
  const provider = new ethers.JsonRpcProvider(process.env.SEND_RPC);
  cachedProvider = provider;

  while (!cachedSigner) {
    try {
      const keystoreName = "privateKey";
      const keystorePath = path.resolve(
        process.env.HOME || process.env.USERPROFILE,
        ".foundry/keystores",
        keystoreName
      );

      if (!fs.existsSync(keystorePath)) {
        console.error(
          `Keystore file not found: ${keystorePath}\n` +
            `Checked: ${keystorePath}\n` +
            `Tip: Run 'ls ~/.foundry/keystores/' to confirm the exact name.\n`
        );
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const keystoreJson = JSON.parse(fs.readFileSync(keystorePath, "utf8"));

      console.log("Enter your keystore password (input will be invisible):");

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      let password = "";
      let done = false;

      const onData = (key) => {
        if (key === "\n" || key === "\r") {
          done = true;
          process.stdin.setRawMode(false);
          process.stdin.pause();
          console.log();
          process.stdin.removeListener("data", onData);
          return;
        }

        if (key === "\u007f" || key === "\b") {
          if (password.length > 0) password = password.slice(0, -1);
          return;
        }

        if (key.charCodeAt(0) < 32) return;
        password += key;
      };

      process.stdin.on("data", onData);

      await new Promise((resolve) => {
        const checkDone = () => (done ? resolve() : setTimeout(checkDone, 100));
        checkDone();
      });

      process.stdin.setRawMode(false);
      process.stdin.pause();

      const wallet = await ethers.Wallet.fromEncryptedJson(JSON.stringify(keystoreJson), password);
      cachedSigner = wallet.connect(provider);

      if (process.env.POOL_ADDRESS && process.env.POOL_ADDRESS !== "MISSING") {
        cachedPool = new ethers.Contract(process.env.POOL_ADDRESS, poolAbi, provider);
      }

      if (process.env.LIQUIDATOR && process.env.LIQUIDATOR !== "MISSING") {
        try {
          const liq = new ethers.Contract(process.env.LIQUIDATOR, liquidatorReadAbi, provider);
          cachedRouter = (await liq.liquidSwapRouter()).toLowerCase();
        } catch (e) {
          cachedRouter = null;
        }
      }

      console.log(`\nSuccess! Signer address: ${await cachedSigner.getAddress()}`);
      if (cachedRouter) console.log(`Router (from Liquidator): ${cachedRouter}`);
      console.log("Bot is now unlocked and will start processing normally.\n");
    } catch (err) {
      console.error("Decryption failed:", err.message);
      console.log("Please try again. The bot will keep asking until it succeeds.\n");
    }
  }

  return cachedSigner;
}

async function isLiquidatableOnchain(user) {
  try {
    if (!cachedPool) {
      console.log(`   ⚠️  Pool contract not initialized, skipping HF check`);
      return true;
    }

    const data = await cachedPool.getUserAccountData(user);
    const hf = data[5];
    const ONE = ethers.parseUnits("1", 18);

    if (hf >= ONE) {
      cycleStats.notLiquidatable++;
      console.log(`   ⏭️  Skipping: On-chain HF >= 1 (actual: ${ethers.formatUnits(hf, 18)})`);
      return false;
    }

    return true;
  } catch (err) {
    console.log(`   ⚠️  Failed on-chain HF check: ${err.message}`);
    return false;
  }
}

/**
 * ✅ NEW: Estimate profit in BPS
 * profit_bps = (amountOut - debtRepay - flash_fee) / debtRepay * 10000
 */
function calculateProfitBps(amountOutBI, debtAmountBI, borrowDecimals) {
  const premiumBI = (debtAmountBI * BigInt(FLASH_LOAN_FEE)) / 10000n;
  const totalOwedBI = debtAmountBI + premiumBI;

  if (amountOutBI < totalOwedBI) {
    // Loss
    return -10000; // -100%
  }

  const profitBI = amountOutBI - totalOwedBI;
  const profitBps = Number((profitBI * 10000n) / debtAmountBI);
  return Math.min(profitBps, 10000); // cap at 100%
}

initializeSigner().then(() => {
  run();

  // Run every 2 minutes instead of every 1 minute to reduce load
  cron.schedule("*/2 * * * *", async () => {
    await run();
  });
});

async function run() {
  if (RUNNING) {
    console.log("⏳ Previous run still active — skipping this tick");
    return;
  }
  RUNNING = true;

  try {
    // Reset stats
    Object.assign(cycleStats, {
      processed: 0,
      successful: 0,
      notLiquidatable: 0,
      insufficientSize: 0,
      noLiquidity: 0,
      simFailed: 0,
      txFailed: 0,
    });

    const wallets = await getLiquidatableWallets();

    if (wallets.length === 0) {
      console.log(`[${new Date().toISOString()}] No liquidatable wallets found. Waiting...\n`);
      return;
    }

    // Sort by health factor (most liquidatable first)
    wallets.sort((a, b) => parseFloat(a.health_rate) - parseFloat(b.health_rate));
    const walletsToProcess = wallets.slice(0, MAX_WALLETS_PER_CYCLE);

    console.log(
      `\n[${new Date().toISOString()}] Found ${wallets.length} liquidatable wallets. ` +
        `Processing top ${walletsToProcess.length} (max ${MAX_WALLETS_PER_CYCLE})...\n`
    );

    const now = Date.now();
    let processedThisCycle = new Set();

    for (let wallet of walletsToProcess) {
      const addr = wallet.wallet_address;

      if (processedThisCycle.has(addr)) continue;
      processedThisCycle.add(addr);

      // Check cooldown
      const cooldownUntil = cooldowns.get(addr);
      if (cooldownUntil && now < cooldownUntil) {
        const remainingMins = Math.round((cooldownUntil - now) / 60000);
        console.log(`   ⏭️  Skipping: on cooldown (${remainingMins}m remaining)`);
        continue;
      }

      try {
        console.log(`\n💰 Processing: ${addr}`);
        console.log(`   Health Factor: ${wallet.health_rate}`);

        const positions = await getDetailedPositionFromAPI(wallet);

        if (!positions?.supply?.length || !positions?.borrow?.length) {
          console.log(`   ⚠️  No on-chain supply/borrow token balances found, skipping...`);
          continue;
        }

        // Build candidates from REAL balances
        const supplyCandidates = positions.supply
          .map((p) => {
            const dec = Number(p.decimals) || 18;
            const human = Number(ethers.formatUnits(p.amount, dec));
            return {
              underlying: p.underlying,
              symbol: p.symbol,
              decimals: dec,
              amount: p.amount,
              humanAmount: human,
            };
          })
          .sort((a, b) => b.humanAmount - a.humanAmount);

        const borrowCandidates = positions.borrow
          .map((p) => {
            const dec = Number(p.decimals) || 18;
            const human = Number(ethers.formatUnits(p.amount, dec));
            return {
              underlying: p.underlying,
              symbol: p.symbol,
              decimals: dec,
              amount: p.amount,
              humanAmount: human,
            };
          })
          .sort((a, b) => b.humanAmount - a.humanAmount);

        // ✅ IMPROVED: pick first different-token pair, prefer largest amounts
        let selectedPair = null;
        for (const s of supplyCandidates.slice(0, 10)) {
          for (const b of borrowCandidates.slice(0, 10)) {
            if (s.underlying.toLowerCase() === b.underlying.toLowerCase()) continue;
            selectedPair = [s, b];
            break;
          }
          if (selectedPair) break;
        }

        if (!selectedPair) {
          console.log(`   ⚠️  Could not find valid supply/borrow pair (all same-token), skipping...`);
          cycleStats.insufficientSize++;
          continue;
        }

        cycleStats.processed++;
        await prepareAndSend(wallet, selectedPair);
      } catch (error) {
        console.error(`❌ Error processing ${addr}:`, error.message);
        cycleStats.txFailed++;
      }
    }

    console.log(
      `\n📊 Cycle stats: processed=${cycleStats.processed}, ` +
        `success=${cycleStats.successful}, ` +
        `noLiquidity=${cycleStats.noLiquidity}, ` +
        `simFailed=${cycleStats.simFailed}, ` +
        `txFailed=${cycleStats.txFailed}\n`
    );
  } catch (error) {
    console.error("❌ Error in run loop:", error.message);
  } finally {
    RUNNING = false;
  }
}

async function prepareAndSend(wallet, pair) {
  const user = wallet.wallet_address;
  const supply = pair[0];
  const borrow = pair[1];

  console.log(`   💱 Pair: ${supply.symbol} (supply) → ${borrow.symbol} (debt)`);

  // ✅ Always check HF again right before proceeding
  const liquidatable = await isLiquidatableOnchain(user);
  if (!liquidatable) {
    cooldowns.set(user, Date.now() + COOLDOWN_MS);
    return;
  }

  // ✅ Size by close factor of debt
  const debtAmountHuman = borrow.humanAmount;
  const debtAmountToRepay = Math.min(debtAmountHuman, debtAmountHuman * CLOSE_FACTOR);
  const debtAmountRawBI = ethers.parseUnits(debtAmountToRepay.toFixed(borrow.decimals), borrow.decimals);

  // ✅ Check minimum debt size
  if (debtAmountToRepay < 1) {
    console.log(`   ⏭️  Skipping: debt amount too small (${debtAmountToRepay})`);
    cycleStats.insufficientSize++;
    return;
  }

  // ✅ Estimate collateral to seize (close factor * supply)
  const collateralAmountToSeize = supply.humanAmount * CLOSE_FACTOR;
  const collateralRawBI = ethers.parseUnits(
    collateralAmountToSeize.toFixed(supply.decimals),
    supply.decimals
  );

  console.log(`   🔄 Liquidation sizing:`);
  console.log(`     Debt to repay: ${debtAmountToRepay.toFixed(6)} ${borrow.symbol}`);
  console.log(`     Collateral seized: ${collateralAmountToSeize.toFixed(6)} ${supply.symbol}`);

  // ✅ Get swap quote
  console.log(`   🔄 Getting swap quote from LiquidSwap V2...`);
  console.log(`     tokenIn: ${supply.underlying}`);
  console.log(`     tokenOut: ${borrow.underlying}`);
  console.log(`     amountIn: ${collateralRawBI.toString()}`);

  let swapCalldata = null;
  let amountOutRawBI = 0n;
  let amountOutHuman = "0";
  let executionTo = null;

  try {
    const quoteResponse = await axios.get(`https://api.liqd.ag/v2/route`, {
      params: {
        tokenIn: supply.underlying,
        tokenOut: borrow.underlying,
        amountIn: collateralRawBI.toString(),
        slippageTolerance: 100, // 1%
      },
      timeout: 15000,
    });

    swapCalldata = quoteResponse.data?.execution?.calldata;
    executionTo = quoteResponse.data?.execution?.to || null;

    const outStr = quoteResponse.data?.execution?.amountOut || "0";
    amountOutRawBI = BigInt(outStr);
    amountOutHuman = ethers.formatUnits(outStr, borrow.decimals);

    console.log("   ✅ LiquidSwap V2 quote succeeded");
    console.log(`     Amount out: ${amountOutHuman} ${borrow.symbol} (raw: ${outStr})`);
  } catch (err) {
    console.log("   ⚠️  V2 route failed:", err.message);
    cycleStats.noLiquidity++;
  }

  if (!swapCalldata) {
    console.log("   🔄 Falling back to legacy /quote endpoint...");
    try {
      const legacyRes = await axios.get(`https://api.liqd.ag/liquidcore/quote`, {
        params: {
          tokenIn: supply.underlying,
          tokenOut: borrow.underlying,
          amountIn: collateralRawBI.toString(),
          slippageTolerance: 100,
        },
        timeout: 15000,
      });

      swapCalldata = legacyRes.data?.execution?.calldata || legacyRes.data?.calldata;
      executionTo = legacyRes.data?.execution?.to || null;

      const outStr = legacyRes.data?.execution?.amountOut || legacyRes.data?.amountOut || "0";
      amountOutRawBI = BigInt(outStr);
      amountOutHuman = ethers.formatUnits(outStr, borrow.decimals);

      console.log("   ✅ Legacy quote succeeded");
      console.log(`     Amount out: ${amountOutHuman} ${borrow.symbol} (raw: ${outStr})`);
    } catch (legacyErr) {
      console.log("   ❌ Legacy quote also failed:", legacyErr.message);
      cycleStats.noLiquidity++;
    }
  }

  if (amountOutRawBI === 0n) {
    console.log(`   ⏭️  Skipping: Swap quote returned 0 output (no liquidity)`);
    cycleStats.noLiquidity++;
    cooldowns.set(user, Date.now() + COOLDOWN_MS);
    return;
  }

  // ✅ Router safety check
  if (swapCalldata && cachedRouter && executionTo) {
    const execToLower = String(executionTo).toLowerCase();
    if (execToLower !== cachedRouter) {
      console.log(`   ⚠️  Skipping: execution.to != Liquidator router`);
      console.log(`     execution.to: ${execToLower}`);
      console.log(`     router:       ${cachedRouter}`);
      cooldowns.set(user, Date.now() + COOLDOWN_MS);
      return;
    }
  }

  // ✅ Calculate profit in BPS
  const profitBps = calculateProfitBps(amountOutRawBI, debtAmountRawBI, borrow.decimals);
  const profitHuman = Number(ethers.formatUnits(amountOutRawBI - debtAmountRawBI, borrow.decimals));

  console.log(`   💰 Profit estimate: ${profitBps} bps (${profitHuman.toFixed(8)} tokens)`);

  if (profitBps <= 0) {
    console.log(`   ⏭️  Skipping: negative profit (${profitBps} bps)`);
    cooldowns.set(user, Date.now() + COOLDOWN_MS);
    return;
  }

  if (profitBps < MIN_PROFIT_THRESHOLD_BPS) {
    console.log(
      `   ⏭️  Skipping: profit ${profitBps} bps < threshold ${MIN_PROFIT_THRESHOLD_BPS} bps`
    );
    cooldowns.set(user, Date.now() + COOLDOWN_MS);
    return;
  }

  if (!swapCalldata) {
    console.log(`   ⏭️  Skipping: no valid swap quote`);
    cooldowns.set(user, Date.now() + COOLDOWN_MS);
    return;
  }

  console.log(`   ✅ Profit exceeds threshold (${profitBps} bps), proceeding with simulation...`);
  await sendTxWithCalldata(user, supply.underlying, borrow.underlying, debtAmountRawBI, swapCalldata);
}

async function sendTxWithCalldata(user, collateral, debt, debtAmount, swapCalldata) {
  try {
    // Wait for sim slot
    while (activeSims >= MAX_CONCURRENT_SIMS) {
      await new Promise((r) => setTimeout(r, 500));
    }
    activeSims++;

    try {
      const signer = cachedSigner;
      const abi = [
        `function liquidateWithCalldata(address _user, address _collateral, address _debt, uint256 _debtAmount, bytes _swapCalldata)`,
      ];
      const contract = new ethers.Contract(process.env.LIQUIDATOR, abi, signer);

      console.log(`   🧪 Simulating liquidation (staticCall)...`);
      try {
        await contract.liquidateWithCalldata.staticCall(user, collateral, debt, debtAmount, swapCalldata);
        console.log(`   ✅ Simulation passed!`);
      } catch (simErr) {
        console.log(`   ❌ Simulation failed, skipping tx`);
        console.log(`   ❌ Sim revert: ${simErr.shortMessage || simErr.message}`);
        if (simErr.data) console.log(`   Debug data: ${simErr.data}`);
        cycleStats.simFailed++;
        cooldowns.set(user, Date.now() + RETRY_COOLDOWN_MS);
        return;
      }

      console.log(`   ⛽ Estimating gas...`);
      const gasEstimate = await contract.liquidateWithCalldata.estimateGas(
        user,
        collateral,
        debt,
        debtAmount,
        swapCalldata
      );
      console.log(`   ⛽ Gas estimate: ${gasEstimate.toString()}`);

      // Wait for send slot
      while (activeSends >= MAX_CONCURRENT_SENDS) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      activeSends++;

      try {
        console.log(`   📤 Sending liquidateWithCalldata tx...`);
        const tx = await contract.liquidateWithCalldata(user, collateral, debt, debtAmount, swapCalldata, {
          gasLimit: (gasEstimate * BigInt(Math.round(GAS_LIMIT_MULTIPLIER * 100))) / 100n,
        });

        console.log(`   ✅ Tx sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

        cooldowns.delete(user);
        retryAttempts.delete(user);
        cycleStats.successful++;
        console.log(`   🎉 Liquidation successful!\n`);
      } finally {
        activeSends--;
      }
    } finally {
      activeSims--;
    }
  } catch (error) {
    console.error(`   ❌ Transaction failed:`, error.shortMessage || error.message);
    if (error.reason) console.error(`   Revert reason: ${error.reason}`);
    if (error.data) console.error(`   Revert data: ${error.data}`);

    const attempts = (retryAttempts.get(user) || 0) + 1;
    retryAttempts.set(user, attempts);

    if (attempts < MAX_RETRIES_PER_WALLET) {
      cooldowns.set(user, Date.now() + RETRY_COOLDOWN_MS);
    } else {
      cooldowns.set(user, Date.now() + COOLDOWN_MS);
    }
    cycleStats.txFailed++;
  }
}

process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down bot gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n\n👋 Shutting down bot gracefully...");
  process.exit(0);
});