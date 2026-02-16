// bot/src/utils/eventMonitor.js
// Real-time event monitoring for instant liquidation detection

const { ethers } = require("ethers");

class EventMonitor {
  constructor(provider, poolAddress, poolAbi) {
    this.provider = provider;
    this.poolAddress = poolAddress;
    this.pool = new ethers.Contract(poolAddress, poolAbi, provider);
    this.listeners = [];
    this.isActive = false;
    this.onLiquidationCallback = null;
    this.onBorrowCallback = null;
  }

  /**
   * Start monitoring liquidation events
   */
  startLiquidationWatch(callback) {
    if (String(process.env.ENABLE_LIQUIDATION_WATCH || "false").toLowerCase() !== "true") {
      console.log("   ℹ️  Liquidation event monitoring disabled");
      return;
    }

    this.onLiquidationCallback = callback;
    
    const LIQUIDATION_TOPIC = ethers.id(
      "LiquidationCall(address,address,address,uint256,uint256,address,bool)"
    );
    
    const filter = {
      address: this.poolAddress,
      topics: [LIQUIDATION_TOPIC]
    };
    
    const listener = async (log) => {
      try {
        const decoded = this.pool.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        
        const liquidatedUser = decoded.args.user;
        const collateralAsset = decoded.args.collateralAsset;
        const debtAsset = decoded.args.debtAsset;
        const liquidator = decoded.args.liquidator;
        const debtToCover = decoded.args.debtToCover;
        const liquidatedCollateral = decoded.args.liquidatedCollateralAmount;
        
        console.log(`\n   🚨 LIQUIDATION EVENT DETECTED!`);
        console.log(`      User:       ${liquidatedUser}`);
        console.log(`      Liquidator: ${liquidator}`);
        console.log(`      Debt:       ${ethers.formatUnits(debtToCover, 18)} (${debtAsset.slice(0, 10)}...)`);
        console.log(`      Collateral: ${ethers.formatUnits(liquidatedCollateral, 18)} (${collateralAsset.slice(0, 10)}...)`);
        console.log(`   ⚡ Triggering immediate scan for similar positions...\n`);
        
        // Trigger callback (usually calls run())
        if (this.onLiquidationCallback) {
          this.onLiquidationCallback({
            user: liquidatedUser,
            collateralAsset,
            debtAsset,
            liquidator,
            debtToCover,
            liquidatedCollateral
          });
        }
      } catch (e) {
        console.log(`   ⚠️  Error processing liquidation event: ${e.message}`);
      }
    };
    
    this.provider.on(filter, listener);
    this.listeners.push({ filter, listener });
    
    console.log("   👁️  Watching for liquidation events (real-time)");
    this.isActive = true;
  }

  /**
   * Start monitoring borrow events for risky new positions
   */
  startBorrowWatch(callback) {
    if (String(process.env.ENABLE_BORROW_WATCH || "false").toLowerCase() !== "true") {
      console.log("   ℹ️  Borrow event monitoring disabled");
      return;
    }

    this.onBorrowCallback = callback;
    
    const BORROW_TOPIC = ethers.id(
      "Borrow(address,address,address,uint256,uint8,uint256,uint16)"
    );
    
    const filter = {
      address: this.poolAddress,
      topics: [BORROW_TOPIC]
    };
    
    const listener = async (log) => {
      try {
        const decoded = this.pool.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        
        const user = decoded.args.user || decoded.args.onBehalfOf;
        const asset = decoded.args.reserve;
        const amount = decoded.args.amount;
        
        // Check if position is immediately liquidatable
        const data = await this.pool.getUserAccountData(user);
        const hf = data[5];
        const ONE = ethers.parseUnits("1", 18);
        const THRESHOLD = ethers.parseUnits("1.05", 18); // 5% buffer
        
        if (hf < THRESHOLD) {
          const hfStr = ethers.formatUnits(hf, 18);
          
          console.log(`\n   🎯 RISKY BORROW DETECTED!`);
          console.log(`      User:   ${user}`);
          console.log(`      Asset:  ${asset.slice(0, 10)}...`);
          console.log(`      Amount: ${ethers.formatUnits(amount, 18)}`);
          console.log(`      HF:     ${hfStr}`);
          
          if (hf < ONE) {
            console.log(`   🚨 IMMEDIATELY LIQUIDATABLE!`);
            console.log(`   ⚡ Executing instant liquidation...\n`);
          } else {
            console.log(`   ⚠️  Near liquidation threshold, monitoring closely...\n`);
          }
          
          // Trigger callback
          if (this.onBorrowCallback) {
            this.onBorrowCallback({
              user,
              asset,
              amount,
              healthFactor: hfStr,
              liquidatable: hf < ONE
            });
          }
        }
      } catch (e) {
        console.log(`   ⚠️  Error processing borrow event: ${e.message}`);
      }
    };
    
    this.provider.on(filter, listener);
    this.listeners.push({ filter, listener });
    
    console.log("   👁️  Watching for risky borrow events (real-time)");
    this.isActive = true;
  }

  /**
   * Stop all event monitoring
   */
  stop() {
    for (const { filter, listener } of this.listeners) {
      this.provider.off(filter, listener);
    }
    
    this.listeners = [];
    this.isActive = false;
    
    console.log("   ⏹️  Event monitoring stopped");
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      active: this.isActive,
      listeners: this.listeners.length,
      liquidationWatch: this.onLiquidationCallback !== null,
      borrowWatch: this.onBorrowCallback !== null
    };
  }
}

// Track recent events to avoid duplicate processing
const recentEvents = new Set();
const EVENT_DEDUP_WINDOW_MS = 5000; // 5 seconds

function shouldProcessEvent(eventHash) {
  if (recentEvents.has(eventHash)) {
    return false;
  }
  
  recentEvents.add(eventHash);
  
  // Clean up old events
  setTimeout(() => {
    recentEvents.delete(eventHash);
  }, EVENT_DEDUP_WINDOW_MS);
  
  return true;
}

module.exports = {
  EventMonitor,
  shouldProcessEvent
};