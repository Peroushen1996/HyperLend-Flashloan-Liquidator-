// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Liquidator} from "../src/Liquidator.sol";

contract DeployLiquidator is Script {
    function run() external {
        // HyperLend Pool address
        address poolAddress = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;

        // LiquidSwap Router (real mainnet address)
        address liquidSwapRouter = 0x744489Ee3d540777A66f2cf297479745e0852f7A;

        // WHYPE (wrapped HYPE)
        address wHYPE = 0x5555555555555555555555555555555555555555;

        console.log("==============================================");
        console.log("Deploying Liquidator contract...");
        console.log("==============================================");
        console.log("Deployer address:", msg.sender);
        console.log("Pool address:", poolAddress);
        console.log("Network: HYPE (Chain ID 999)");
        console.log("");

        vm.startBroadcast();

        Liquidator liquidator = new Liquidator(poolAddress, liquidSwapRouter, wHYPE);

        vm.stopBroadcast();

        console.log("");
        console.log("==============================================");
        console.log("SUCCESS! Liquidator deployed at:");
        console.log(address(liquidator));
        console.log("==============================================");
        console.log("");
        console.log("Add this to your bot's .env file:");
        console.log("LIQUIDATOR=%s", address(liquidator));
        console.log("");
        console.log("==============================================");
        console.log("Contract Details:");
        console.log("- Owner:", msg.sender);
        console.log("- Pool:", poolAddress);
        console.log("- LiquidSwap Router:", liquidSwapRouter);
        console.log("- WHYPE:", wHYPE);
        console.log("==============================================");
    }
}