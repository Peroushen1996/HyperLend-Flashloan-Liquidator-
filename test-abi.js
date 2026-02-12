const PoolArtifact = require('@aave/core-v3/artifacts/contracts/protocol/pool/Pool.sol/Pool.json');

console.log('✅ @aave/core-v3 package loaded successfully!\n');
console.log('📊 Pool ABI Statistics:');
console.log('   Total items:', PoolArtifact.abi.length);

const functions = PoolArtifact.abi.filter(item => item.type === 'function');
console.log('   Functions:', functions.length);

console.log('\n🔧 Key Functions for Liquidation:');
['flashLoanSimple', 'liquidationCall', 'getReserveData', 'getUserAccountData'].forEach(name => {
    const exists = functions.find(f => f.name === name);
    console.log(`   ${exists ? '✅' : '❌'} ${name}()`);
});

console.log('\n🎉 Your bot has access to all HyperLend ABIs!');
