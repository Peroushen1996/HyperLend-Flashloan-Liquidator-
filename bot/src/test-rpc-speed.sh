#!/bin/bash
# test-rpc-speed.sh
# Comprehensive RPC latency testing for HyperEVM

echo "╔══════════════════════════════════════════════════════════╗"
echo "║           HyperEVM RPC LATENCY TESTER                    ║"
echo "║     Find the fastest RPC for your liquidation bot        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# RPC endpoints to test
declare -a rpcs=(
  "https://rpc.hyperlend.finance"
  "https://api.hyperliquid.xyz/evm"
  "https://rpc.hyperliquid.xyz/evm"
  "https://1rpc.io/hyperliquid"
  "https://hyperliquid-mainnet.core.chainstack.com/19e01a5b7605b84cb769f71a18521cc6/evm"
)

# Test configuration
TESTS_PER_RPC=10
TIMEOUT=5

# Results storage
declare -A results
declare -A failed

echo "Configuration:"
echo "  Tests per RPC: $TESTS_PER_RPC"
echo "  Timeout: ${TIMEOUT}s"
echo ""
echo "Testing ${#rpcs[@]} RPC endpoints..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to test a single RPC
test_rpc() {
  local rpc=$1
  local times=()
  local success=0
  local failed_count=0
  
  echo "Testing: $rpc"
  
  for i in $(seq 1 $TESTS_PER_RPC); do
    # Test eth_blockNumber call
    start=$(date +%s%N)
    response=$(curl -X POST -H "Content-Type: application/json" \
      --max-time $TIMEOUT \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      -s -w "%{http_code}" \
      "$rpc" 2>/dev/null)
    end=$(date +%s%N)
    
    http_code="${response: -3}"
    
    if [[ "$http_code" == "200" ]] && [[ "$response" =~ "result" ]]; then
      elapsed=$(echo "scale=3; ($end - $start) / 1000000000" | bc)
      times+=($elapsed)
      success=$((success + 1))
      echo -n "."
    else
      failed_count=$((failed_count + 1))
      echo -n "x"
    fi
  done
  
  echo ""
  
  if [ $success -gt 0 ]; then
    # Calculate statistics
    local sum=0
    local min=${times[0]}
    local max=${times[0]}
    
    for time in "${times[@]}"; do
      sum=$(echo "$sum + $time" | bc)
      
      # Update min
      if (( $(echo "$time < $min" | bc -l) )); then
        min=$time
      fi
      
      # Update max
      if (( $(echo "$time > $max" | bc -l) )); then
        max=$time
      fi
    done
    
    local avg=$(echo "scale=3; $sum / $success" | bc)
    
    # Sort times for median
    IFS=$'\n' sorted_times=($(sort -n <<<"${times[*]}"))
    unset IFS
    local median_idx=$((success / 2))
    local median=${sorted_times[$median_idx]}
    
    results[$rpc]=$avg
    
    echo "  ✅ Success rate: $success/$TESTS_PER_RPC"
    echo "  📊 Average: ${avg}s"
    echo "  📊 Median:  ${median}s"
    echo "  📊 Min:     ${min}s"
    echo "  📊 Max:     ${max}s"
  else
    failed[$rpc]=1
    echo "  ❌ All tests failed"
  fi
  
  echo ""
}

# Test all RPCs
for rpc in "${rpcs[@]}"; do
  test_rpc "$rpc"
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                    FINAL RESULTS                         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Sort results by latency
sorted_rpcs=()
for rpc in "${!results[@]}"; do
  sorted_rpcs+=("${results[$rpc]} $rpc")
done

IFS=$'\n' sorted=($(sort -n <<<"${sorted_rpcs[*]}"))
unset IFS

echo "Rankings (fastest to slowest):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rank=1
for entry in "${sorted[@]}"; do
  latency=$(echo "$entry" | cut -d' ' -f1)
  rpc=$(echo "$entry" | cut -d' ' -f2-)
  
  # Medal emoji for top 3
  medal=""
  if [ $rank -eq 1 ]; then
    medal="🥇"
  elif [ $rank -eq 2 ]; then
    medal="🥈"
  elif [ $rank -eq 3 ]; then
    medal="🥉"
  else
    medal="  "
  fi
  
  # Calculate latency in ms for readability
  latency_ms=$(echo "scale=0; $latency * 1000" | bc)
  
  echo "$medal #$rank - ${latency}s (${latency_ms}ms)"
  echo "     $rpc"
  echo ""
  
  rank=$((rank + 1))
done

# Show failed RPCs
if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed RPCs:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  for rpc in "${!failed[@]}"; do
    echo "❌ $rpc"
  done
  echo ""
fi

# Recommendations
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 RECOMMENDATIONS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ ${#sorted[@]} -gt 0 ]; then
  fastest=$(echo "${sorted[0]}" | cut -d' ' -f2-)
  fastest_latency=$(echo "${sorted[0]}" | cut -d' ' -f1)
  
  echo "🏆 FASTEST RPC:"
  echo "   $fastest"
  echo "   Latency: ${fastest_latency}s"
  echo ""
  echo "✅ Use this in your .env:"
  echo "   SEND_RPC=$fastest"
  echo ""
  
  if [ ${#sorted[@]} -gt 1 ]; then
    echo "📋 RECOMMENDED FALLBACKS (in order):"
    for i in {1..3}; do
      if [ $i -lt ${#sorted[@]} ]; then
        fallback=$(echo "${sorted[$i]}" | cut -d' ' -f2-)
        echo "   $((i)). $fallback"
      fi
    done
    echo ""
    echo "✅ Use these in your .env:"
    fallback_list=""
    for i in {1..3}; do
      if [ $i -lt ${#sorted[@]} ]; then
        fallback=$(echo "${sorted[$i]}" | cut -d' ' -f2-)
        if [ -z "$fallback_list" ]; then
          fallback_list="$fallback"
        else
          fallback_list="$fallback_list,$fallback"
        fi
      fi
    done
    echo "   RPC_FALLBACKS=$fallback_list"
  fi
  
  echo ""
  
  # Performance analysis
  fastest_ms=$(echo "scale=0; $fastest_latency * 1000" | bc)
  
  echo "🎯 LATENCY ANALYSIS:"
  if (( $(echo "$fastest_latency < 0.050" | bc -l) )); then
    echo "   ⚡ EXCELLENT (< 50ms) - You're co-located or very close to validators!"
    echo "   💡 You have a major competitive advantage."
  elif (( $(echo "$fastest_latency < 0.100" | bc -l) )); then
    echo "   ✅ GOOD (50-100ms) - Competitive for liquidations."
    echo "   💡 You can win most liquidations with proper gas pricing."
  elif (( $(echo "$fastest_latency < 0.200" | bc -l) )); then
    echo "   ⚠️  ACCEPTABLE (100-200ms) - You'll win some, lose some."
    echo "   💡 Consider deploying bot to cloud (AWS US-EAST-1) for 20-50ms latency."
  else
    echo "   ❌ SLOW (> 200ms) - You're at a major disadvantage."
    echo "   💡 STRONGLY RECOMMEND deploying to cloud near validators."
    echo "   💡 AWS US-EAST-1 or EU-WEST-1 will give you 20-50ms latency."
  fi
else
  echo "❌ No working RPCs found. Check your network connection."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Testing complete! Update your .env with the fastest RPC."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"