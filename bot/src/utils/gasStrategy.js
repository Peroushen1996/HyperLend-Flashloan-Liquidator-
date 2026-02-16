// bot/src/utils/gasStrategy.js
// Advanced gas pricing to WIN liquidations

const { ethers } = require("ethers");

class CompetitiveGasStrategy {
  constructor() {
    this.competitorGasData = [];
    this.lastAnalysis = 0;
  }

  /**
   * Get competitive gas price based on profit and market conditions
   */
  async getCompetitiveGas(provider, profitBps, urgency = null) {
    const feeData = await provider.getFeeData();
    
    // Auto-determine urgency based on profit if not provided
    if (!urgency) {
      if (profitBps > 1000) urgency = 'extreme';      // >10% profit
      else if (profitBps > 500) urgency = 'urgent';   // >5% profit
      else if (profitBps > 200) urgency = 'high';     // >2% profit
      else urgency = 'medium';
    }
    
    const urgencyMultipliers = {
      low: 1.05,      // 5% boost - not recommended for liquidations
      medium: 1.20,   // 20% boost - conservative
      high: 1.35,     // 35% boost - RECOMMENDED DEFAULT
      urgent: 1.60,   // 60% boost - high profit opportunities
      extreme: 2.00   // 100% boost - extraordinary profit
    };
    
    const multiplier = urgencyMultipliers[urgency] || urgencyMultipliers.high;
    
    let maxPriorityFeePerGas, maxFeePerGas;
    
    if (feeData.maxPriorityFeePerGas && feeData.maxFeePerGas) {
      // EIP-1559 network
      maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * BigInt(Math.round(multiplier * 100))) / 100n;
      
      // Ensure maxFee covers priority + base
      const baseFee = feeData.maxFeePerGas - feeData.maxPriorityFeePerGas;
      maxFeePerGas = baseFee + maxPriorityFeePerGas;
      
      // Safety: maxFee should be at least 2x base fee during high congestion
      const minMaxFee = baseFee * 2n;
      if (maxFeePerGas < minMaxFee) {
        maxFeePerGas = minMaxFee;
      }
      
      console.log(`   ⛽ Gas [${urgency}]: priority=${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} gwei, ` +
                  `maxFee=${ethers.formatUnits(maxFeePerGas, "gwei")} gwei (${Math.round((multiplier - 1) * 100)}% boost)`);
      
      return { maxPriorityFeePerGas, maxFeePerGas };
    } else {
      // Legacy network
      maxFeePerGas = (feeData.gasPrice * BigInt(Math.round(multiplier * 100))) / 100n;
      
      console.log(`   ⛽ Gas [${urgency}]: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei (${Math.round((multiplier - 1) * 100)}% boost)`);
      
      return { maxPriorityFeePerGas: null, maxFeePerGas };
    }
  }

  /**
   * Analyze competitor gas prices from recent liquidations
   */
  async analyzeCompetitorGas(provider, poolAddress) {
    const now = Date.now();
    const cacheTime = 60 * 60 * 1000; // 1 hour cache
    
    if (now - this.lastAnalysis < cacheTime) {
      return this.competitorGasData;
    }
    
    try {
      const latest = await provider.getBlockNumber();
      const lookback = 500; // Last 500 blocks
      
      const LIQUIDATION_TOPIC = ethers.id(
        "LiquidationCall(address,address,address,uint256,uint256,address,bool)"
      );
      
      const logs = await provider.getLogs({
        address: poolAddress,
        fromBlock: Math.max(0, latest - lookback),
        toBlock: latest,
        topics: [LIQUIDATION_TOPIC]
      });
      
      const gasPrices = [];
      
      for (const log of logs) {
        try {
          const tx = await provider.getTransaction(log.transactionHash);
          if (tx?.gasPrice) {
            gasPrices.push(tx.gasPrice);
          } else if (tx?.maxFeePerGas) {
            gasPrices.push(tx.maxFeePerGas);
          }
        } catch {
          // Skip failed TX lookups
        }
      }
      
      if (gasPrices.length > 0) {
        gasPrices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        
        const min = gasPrices[0];
        const max = gasPrices[gasPrices.length - 1];
        const median = gasPrices[Math.floor(gasPrices.length / 2)];
        const p75 = gasPrices[Math.floor(gasPrices.length * 0.75)];
        const p90 = gasPrices[Math.floor(gasPrices.length * 0.90)];
        
        this.competitorGasData = {
          min,
          max,
          median,
          p75,
          p90,
          count: gasPrices.length,
          timestamp: now
        };
        
        console.log(`   📊 Competitor gas analysis (${gasPrices.length} liquidations in last ${lookback} blocks):`);
        console.log(`      Min:    ${ethers.formatUnits(min, "gwei")} gwei`);
        console.log(`      Median: ${ethers.formatUnits(median, "gwei")} gwei`);
        console.log(`      75th:   ${ethers.formatUnits(p75, "gwei")} gwei`);
        console.log(`      90th:   ${ethers.formatUnits(p90, "gwei")} gwei`);
        console.log(`      Max:    ${ethers.formatUnits(max, "gwei")} gwei`);
        
        this.lastAnalysis = now;
        
        return this.competitorGasData;
      }
    } catch (e) {
      console.log(`   ⚠️  Could not analyze competitor gas: ${String(e?.message || "").slice(0, 100)}`);
    }
    
    return null;
  }

  /**
   * Get recommended urgency based on market conditions
   */
  getRecommendedUrgency(profitBps, competitorData) {
    // Very high profit = go aggressive
    if (profitBps > 1000) return 'extreme';
    if (profitBps > 500) return 'urgent';
    
    // If we have competitor data, adjust based on competition
    if (competitorData) {
      // High competition (many recent liquidations) = be more aggressive
      if (competitorData.count > 20) {
        return profitBps > 200 ? 'urgent' : 'high';
      }
      
      // Low competition = can be less aggressive
      if (competitorData.count < 5) {
        return profitBps > 200 ? 'high' : 'medium';
      }
    }
    
    // Default: high urgency for liquidations
    return profitBps > 200 ? 'high' : 'medium';
  }

  /**
   * Calculate if a liquidation is profitable after gas costs
   */
  isProfitableAfterGas(profitBI, gasLimit, gasPriceBI) {
    const gasCost = gasLimit * gasPriceBI;
    return profitBI > gasCost;
  }

  /**
   * Get gas estimate with profitability check
   */
  async getGasWithProfitCheck(provider, profitBI, estimatedGasLimit, profitBps) {
    const gasPrice = await this.getCompetitiveGas(provider, profitBps);
    
    const gasCost = estimatedGasLimit * (gasPrice.maxFeePerGas || gasPrice.gasPrice || 0n);
    const profitable = profitBI > gasCost;
    
    if (!profitable) {
      const gasCostETH = ethers.formatEther(gasCost);
      const profitETH = ethers.formatEther(profitBI);
      console.log(`   ⚠️  NOT PROFITABLE after gas: profit=${profitETH} HYPE < gas=${gasCostETH} HYPE`);
      return null;
    }
    
    const netProfitBI = profitBI - gasCost;
    const netProfitETH = ethers.formatEther(netProfitBI);
    console.log(`   💰 Net profit after gas: ${netProfitETH} HYPE`);
    
    return gasPrice;
  }
}

// Singleton instance
let gasStrategyInstance = null;

function getGasStrategy() {
  if (!gasStrategyInstance) {
    gasStrategyInstance = new CompetitiveGasStrategy();
  }
  return gasStrategyInstance;
}

module.exports = {
  CompetitiveGasStrategy,
  getGasStrategy
};