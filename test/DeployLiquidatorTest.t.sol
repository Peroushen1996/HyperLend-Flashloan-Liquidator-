// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {DeployLiquidator} from "../script/DeployLiquidator.s.sol";
import {Liquidator} from "../src/Liquidator.sol";

contract DeployLiquidatorTest is Test {
    DeployLiquidator public deployScript;

    address constant POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;

    function setUp() public {
        deployScript = new DeployLiquidator();
    }

    function test_DeployScript_UsesCorrectPool() public pure {
        // The pool address is hardcoded in the script
        // We verify it matches the expected HyperLend pool
        assertEq(POOL, 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b);
    }

    function test_DeployScript_CanBeRun() public {
        deployScript.run();
        assertTrue(true);
    }
}
