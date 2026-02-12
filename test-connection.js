require("dotenv").config();
const { ethers } = require("ethers");
const PoolArtifact = require('@aave/core-v3/artifacts/contracts/protocol/pool/Pool.sol/Pool.json');

const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';
const WHYPE = '0x5555555555555555555555555555555555555555';

async function test() {
    console.log('🔍 Testing HyperLend connection...\n');
    
    try {
        // Use correct RPC with /evm endpoint
        const provider = new ethers.JsonRpcProvider(
            process.env.SEND_RPC || 'https://rpc.hyperliquid.xyz/evm'
        );
        console.log('📡 Connecting to HYPE RPC...');
        
        const network = await provider.getNetwork();
        console.log('✅ Connected to network! Chain ID:', network.chainId.toString());
        
        const blockNumber = await provider.getBlockNumber();
        console.log('✅ Current block:', blockNumber);
        
        const pool = new ethers.Contract(HYPERLEND_POOL, PoolArtifact.abi, provider);
        console.log('✅ Pool contract instance created');
        
        console.log('\n📊 Fetching wHYPE reserve data...');
        const reserveData = await pool.getReserveData(WHYPE);
        console.log('✅ Pool contract works!');
        console.log('   aToken:', reserveData.aTokenAddress);
        console.log('   Variable Debt Token:', reserveData.variableDebtTokenAddress);
        
        console.log('\n🎉 SUCCESS! Your bot can interact with HyperLend!');
        console.log('\n📝 Network Details:');
        console.log('   Chain ID: 999 (HyperEVM)');
        console.log('   RPC: https://rpc.hyperliquid.xyz/evm');
        console.log('   Pool: 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
    }
}

test();