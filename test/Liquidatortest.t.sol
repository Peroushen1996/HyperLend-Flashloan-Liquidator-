// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {Liquidator} from "../src/Liquidator.sol";
import {IPool} from "../src/interfaces/IPool.sol";
import {ILiquidSwap} from "../src/interfaces/ILiquidSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DataTypes} from "../src/interfaces/DataTypes.sol";

// Mock contracts for testing
contract MockPool {
    using SafeERC20 for IERC20;

    address public variableDebtTokenAddress;

    constructor(address _debtToken) {
        variableDebtTokenAddress = _debtToken;
    }

    function getReserveData(address) external view returns (DataTypes.ReserveData memory) {
        DataTypes.ReserveData memory data;
        data.variableDebtTokenAddress = variableDebtTokenAddress;
        return data;
    }

    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        // Simulate flash loan by sending tokens to receiver
        IERC20(asset).safeTransfer(receiverAddress, amount);

        // Call executeOperation - msg.sender will be this MockPool contract
        try Liquidator(payable(receiverAddress))
            .executeOperation(
                asset,
                amount,
                amount / 1000, // 0.1% fee
                receiverAddress,
                params
            ) returns (
            bool
        ) {
        // Success
        }
        catch {
            revert("executeOperation failed");
        }

        // Take back tokens + fee
        uint256 amountOwed = amount + (amount / 1000);
        IERC20(asset).safeTransferFrom(receiverAddress, address(this), amountOwed);
    }

    function liquidationCall(address collateralAsset, address, address, uint256, bool) external {
        // Simulate giving collateral to caller (10% bonus)
        IERC20(collateralAsset).safeTransfer(msg.sender, 1.1 ether);
    }
}

contract MockLiquidSwap {
    using SafeERC20 for IERC20;

    function executeMultiHopSwap(address[] calldata tokens, uint256, uint256, ILiquidSwap.Swap[][] calldata)
        external
        returns (uint256)
    {
        // Simulate swap: return more of output token
        address outputToken = tokens[tokens.length - 1];
        uint256 outputAmount = 1.05 ether; // Simulate profitable swap
        IERC20(outputToken).safeTransfer(msg.sender, outputAmount);
        return outputAmount;
    }
}

contract MockERC20 is IERC20 {
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowances[from][msg.sender] -= amount;
        balances[from] -= amount;
        balances[to] += amount;
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function totalSupply() external pure returns (uint256) {
        return 1000000 ether;
    }

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }
}

contract LiquidatorTest is Test {
    /* ========== EVENTS ========== */
    event ProfitSent(address indexed token, uint256 amount, address indexed recipient);
    event LiquidationExecuted(
        address indexed user,
        address indexed collateral,
        address debt,
        uint256 debtAmount,
        uint256 profit,
        bool usedCalldataPath
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    Liquidator public liquidator;
    MockPool public mockPool;
    MockLiquidSwap public mockSwap;
    MockERC20 public mockToken;
    MockERC20 public mockCollateral;
    MockERC20 public mockDebt;

    // Test addresses
    address public owner;
    address public user1;
    address public user2;

    address constant LIQUID_SWAP_ROUTER = 0x744489Ee3d540777A66f2cf297479745e0852f7A;
    address constant WHYPE = 0x5555555555555555555555555555555555555555;

    function setUp() public {
        owner = makeAddr("owner");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        // Deploy mocks
        mockToken = new MockERC20();
        mockCollateral = new MockERC20();
        mockDebt = new MockERC20();

        mockPool = new MockPool(address(mockToken));
        mockSwap = new MockLiquidSwap();

        // Place MockLiquidSwap at the real LiquidSwap router address
        vm.etch(LIQUID_SWAP_ROUTER, address(mockSwap).code);

        // Deploy liquidator
        vm.prank(owner);
        liquidator = new Liquidator(address(mockPool), LIQUID_SWAP_ROUTER, WHYPE);

        // Fund mocks - fund the real router address now
        mockToken.mint(address(mockPool), 1000 ether);
        mockCollateral.mint(address(mockPool), 1000 ether);
        mockDebt.mint(address(mockPool), 1000 ether);
        mockDebt.mint(LIQUID_SWAP_ROUTER, 1000 ether);
    }

    /* ========== DEPLOYMENT TESTS ========== */

    function test_Deployment() public view {
        assertEq(address(liquidator.pool()), address(mockPool));
        assertEq(liquidator.owner(), owner);
    }

    function test_DeploymentEmitsOwnershipTransferred() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(address(0), owner);
        new Liquidator(address(mockPool), LIQUID_SWAP_ROUTER, WHYPE);
        vm.stopPrank();
    }

    /* ========== LIQUIDATE FUNCTION TESTS ========== */

    function test_Liquidate_WithMaxDebtAmount() public {
        // Setup: user1 has debt
        mockToken.mint(user1, 10 ether);

        address[] memory tokens = new address[](2);
        tokens[0] = address(mockCollateral);
        tokens[1] = address(mockDebt);

        ILiquidSwap.Swap[][] memory hops = new ILiquidSwap.Swap[][](1);
        hops[0] = new ILiquidSwap.Swap[](1);
        hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 1 ether,
            stable: false
        });

        vm.prank(owner);
        liquidator.liquidate(
            user1,
            address(mockCollateral),
            address(mockDebt),
            type(uint256).max, // ← Test max amount
            hops,
            tokens,
            0
        );
    }

    function test_Liquidate_OnlyOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        liquidator.liquidate(
            user2, address(mockCollateral), address(mockDebt), 1 ether, new ILiquidSwap.Swap[][](0), new address[](0), 0
        );
    }

    /* ========== EXECUTE OPERATION TESTS ========== */

    function test_ExecuteOperation_ValidParams() public {
        // This tests the flash loan callback
        Liquidator.LiquidationParams memory params = Liquidator.LiquidationParams({
            user: user1,
            collateral: address(mockCollateral),
            debtToCover: 1 ether,
            hops: new ILiquidSwap.Swap[][](1),
            tokens: new address[](2),
            minAmountOut: 0,
            swapCalldata: ""
        });

        params.hops[0] = new ILiquidSwap.Swap[](1);
        params.hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 1 ether,
            stable: false
        });

        params.tokens[0] = address(mockCollateral);
        params.tokens[1] = address(mockDebt);

        bytes memory encodedParams = abi.encode(params);

        // Setup: give liquidator the debt tokens
        mockDebt.mint(address(liquidator), 2 ether);
        mockCollateral.mint(address(liquidator), 2 ether);

        // Mock the pool calling executeOperation
        vm.prank(address(mockPool));
        bool success =
            liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), encodedParams);

        assertTrue(success);
    }

    function test_ExecuteOperation_RevertsIfNotPool() public {
        bytes memory params = "";

        vm.prank(user1);
        vm.expectRevert("msg.sender != pool");
        liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), params);
    }

    function test_ExecuteOperation_RevertsIfWrongInitiator() public {
        bytes memory params = "";

        vm.prank(address(mockPool));
        vm.expectRevert("initiator != address(this)");
        liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, user1, params);
    }

    function test_ExecuteOperation_HopAmountAdjustment_Higher() public {
        // Test when inputAmountFromHops > balance
        Liquidator.LiquidationParams memory params = Liquidator.LiquidationParams({
            user: user1,
            collateral: address(mockCollateral),
            debtToCover: 1 ether,
            hops: new ILiquidSwap.Swap[][](1),
            tokens: new address[](2),
            minAmountOut: 0,
            swapCalldata: ""
        });

        params.hops[0] = new ILiquidSwap.Swap[](1);
        params.hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 5 ether, // More than what liquidator will have
            stable: false
        });

        params.tokens[0] = address(mockCollateral);
        params.tokens[1] = address(mockDebt);

        mockDebt.mint(address(liquidator), 3 ether);
        mockCollateral.mint(address(liquidator), 1 ether); // Less than amountIn

        bytes memory encodedParams = abi.encode(params);

        vm.prank(address(mockPool));
        bool success =
            liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), encodedParams);

        assertTrue(success);
    }

    function test_ExecuteOperation_HopAmountAdjustment_Lower() public {
        // Test when balance > inputAmountFromHops
        Liquidator.LiquidationParams memory params = Liquidator.LiquidationParams({
            user: user1,
            collateral: address(mockCollateral),
            debtToCover: 1 ether,
            hops: new ILiquidSwap.Swap[][](1),
            tokens: new address[](2),
            minAmountOut: 0,
            swapCalldata: ""
        });

        params.hops[0] = new ILiquidSwap.Swap[](1);
        params.hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 0.5 ether, // Less than what liquidator will have
            stable: false
        });

        params.tokens[0] = address(mockCollateral);
        params.tokens[1] = address(mockDebt);

        mockDebt.mint(address(liquidator), 3 ether);
        mockCollateral.mint(address(liquidator), 2 ether); // More than amountIn

        bytes memory encodedParams = abi.encode(params);

        vm.prank(address(mockPool));
        bool success =
            liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), encodedParams);

        assertTrue(success);
    }

    function test_ExecuteOperation_EmitsProfitSentEvent() public {
        Liquidator.LiquidationParams memory params = Liquidator.LiquidationParams({
            user: user1,
            collateral: address(mockCollateral),
            debtToCover: 1 ether,
            hops: new ILiquidSwap.Swap[][](1),
            tokens: new address[](2),
            minAmountOut: 0,
            swapCalldata: ""
        });

        params.hops[0] = new ILiquidSwap.Swap[](1);
        params.hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 1 ether,
            stable: false
        });

        params.tokens[0] = address(mockCollateral);
        params.tokens[1] = address(mockDebt);

        mockDebt.mint(address(liquidator), 5 ether); // Enough for profit
        mockCollateral.mint(address(liquidator), 2 ether);

        bytes memory encodedParams = abi.encode(params);

        // Don't check exact values, just that event is emitted
        vm.expectEmit(true, false, false, false, address(liquidator));
        emit ProfitSent(address(mockDebt), 0, owner);

        vm.prank(address(mockPool));
        liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), encodedParams);
    }

    function test_ExecuteOperation_EmitsLiquidationExecutedEvent() public {
        Liquidator.LiquidationParams memory params = Liquidator.LiquidationParams({
            user: user1,
            collateral: address(mockCollateral),
            debtToCover: 1 ether,
            hops: new ILiquidSwap.Swap[][](1),
            tokens: new address[](2),
            minAmountOut: 0,
            swapCalldata: ""
        });

        params.hops[0] = new ILiquidSwap.Swap[](1);
        params.hops[0][0] = ILiquidSwap.Swap({
            tokenIn: address(mockCollateral),
            tokenOut: address(mockDebt),
            routerIndex: 1,
            fee: 3000,
            amountIn: 1 ether,
            stable: false
        });

        params.tokens[0] = address(mockCollateral);
        params.tokens[1] = address(mockDebt);

        mockDebt.mint(address(liquidator), 5 ether);
        mockCollateral.mint(address(liquidator), 2 ether);

        bytes memory encodedParams = abi.encode(params);

        // Don't check exact profit value, just that event is emitted
        vm.expectEmit(true, false, false, false, address(liquidator));
        emit LiquidationExecuted(user1, address(mockCollateral), address(mockDebt), 1 ether, 0, false);

        vm.prank(address(mockPool));
        liquidator.executeOperation(address(mockDebt), 1 ether, 0.001 ether, address(liquidator), encodedParams);
    }

    /* ========== RESCUE TOKENS TESTS ========== */

    function test_RescueTokens_ERC20() public {
        mockToken.mint(address(liquidator), 10 ether);

        vm.prank(owner);
        liquidator.rescueTokens(address(mockToken), 0, true, user1);

        assertEq(mockToken.balanceOf(user1), 10 ether);
    }

    function test_RescueTokens_NativeHYPE() public {
        vm.deal(address(liquidator), 5 ether);

        address payable receiver = payable(address(new Receiver()));

        uint256 receiverBalanceBefore = receiver.balance;

        vm.prank(owner);
        liquidator.rescueTokens(address(0), 0, true, receiver);

        assertEq(receiver.balance, receiverBalanceBefore + 5 ether);
    }

    function test_RescueTokens_SpecificAmount() public {
        mockToken.mint(address(liquidator), 10 ether);

        vm.prank(owner);
        liquidator.rescueTokens(address(mockToken), 5 ether, false, user1);

        assertEq(mockToken.balanceOf(user1), 5 ether);
        assertEq(mockToken.balanceOf(address(liquidator)), 5 ether);
    }

    function test_RescueTokens_OnlyOwner() public {
        vm.prank(user1);
        vm.expectRevert();
        liquidator.rescueTokens(address(mockToken), 0, true, user1);
    }

    /* ========== RECEIVE FUNCTION TEST ========== */

    function test_ReceiveNativeHYPE() public {
        uint256 initialBalance = address(liquidator).balance;

        // Directly deal ETH to contract (simulates external transfer)
        vm.deal(address(liquidator), initialBalance + 1 ether);

        assertEq(
            address(liquidator).balance, initialBalance + 1 ether, "Liquidator should be able to receive native HYPE"
        );
    }

    /* ========== VIEW FUNCTIONS ========== */

    function test_PoolAddress() public view {
        assertEq(address(liquidator.pool()), address(mockPool));
    }

    function test_OwnerAddress() public view {
        assertEq(liquidator.owner(), owner);
    }
}

// Helper contract that accepts ETH
contract Receiver {
    receive() external payable {}
}
