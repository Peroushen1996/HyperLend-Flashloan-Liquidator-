// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILiquidSwap} from "./interfaces/ILiquidSwap.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IWrappedHype} from "./interfaces/IWrappedHype.sol";

contract Liquidator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPool public immutable pool;
    ILiquidSwap public immutable liquidSwapRouter;
    IWrappedHype public immutable wHYPE;

    event ProfitSent(address indexed token, uint256 amount, address indexed recipient);
    event LiquidationExecuted(
        address indexed user,
        address indexed collateral,
        address debt,
        uint256 debtCovered,
        uint256 profit,
        bool usedCalldataPath
    );
    event SwapExecutionFailed(bytes revertReason);

    constructor(
        address _pool,
        address _liquidSwapRouter,
        address _wHYPE
    ) Ownable(msg.sender) {
        pool = IPool(_pool);
        liquidSwapRouter = ILiquidSwap(_liquidSwapRouter);
        wHYPE = IWrappedHype(_wHYPE);
    }

    // Legacy function – compatible with your current bot logic
    function liquidate(
        address _user,
        address _collateral,
        address _debt,
        uint256 _debtAmount,
        ILiquidSwap.Swap[][] calldata _hops,
        address[] calldata _tokens,
        uint256 _minAmountOut
    ) external onlyOwner nonReentrant {
        if (_debtAmount == type(uint256).max) {
            address dToken = pool.getReserveData(_debt).variableDebtTokenAddress;
            _debtAmount = IERC20(dToken).balanceOf(tx.origin) / 2;
        }

        bytes memory params = abi.encode(LiquidationParams({
            user: _user,
            collateral: _collateral,
            debtToCover: _debtAmount,
            hops: _hops,
            tokens: _tokens,
            minAmountOut: _minAmountOut,
            swapCalldata: ""
        }));

        pool.flashLoanSimple(address(this), _debt, _debtAmount, params, 0);
    }

    // New function – recommended for LiquidSwap /v2/route calldata (supports LiquidCore + all DEXes)
    function liquidateWithCalldata(
        address _user,
        address _collateral,
        address _debt,
        uint256 _debtAmount,
        bytes calldata _swapCalldata
    ) external onlyOwner nonReentrant {
        if (_debtAmount == type(uint256).max) {
            address dToken = pool.getReserveData(_debt).variableDebtTokenAddress;
            _debtAmount = IERC20(dToken).balanceOf(tx.origin) / 2;
        }

        bytes memory params = abi.encode(LiquidationParams({
            user: _user,
            collateral: _collateral,
            debtToCover: _debtAmount,
            hops: new ILiquidSwap.Swap[][](0),
            tokens: new address[](0),
            minAmountOut: 0,
            swapCalldata: _swapCalldata
        }));

        pool.flashLoanSimple(address(this), _debt, _debtAmount, params, 0);
    }

    struct LiquidationParams {
        address user;
        address collateral;
        uint256 debtToCover;
        ILiquidSwap.Swap[][] hops;
        address[] tokens;
        uint256 minAmountOut;
        bytes swapCalldata;
    }

    function executeOperation(
        address debtAsset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(pool), "msg.sender != pool");
        require(initiator == address(this), "initiator != address(this)");

        LiquidationParams memory liq = abi.decode(params, (LiquidationParams));

        // Perform liquidation
        IERC20(debtAsset).forceApprove(address(pool), type(uint256).max);
        pool.liquidationCall(liq.collateral, debtAsset, liq.user, liq.debtToCover, false);

        uint256 collateralBalance = IERC20(liq.collateral).balanceOf(address(this));

        if (collateralBalance == 0) {
            uint256 owed = amount + premium;
            if (IERC20(debtAsset).balanceOf(address(this)) >= owed) {
                IERC20(debtAsset).forceApprove(address(pool), owed);
                return true;
            }
            revert("No collateral received and cannot repay");
        }

        IERC20(liq.collateral).forceApprove(address(liquidSwapRouter), collateralBalance);

        bool success;
        bytes memory revertData;

        if (liq.swapCalldata.length > 0) {
            // Direct calldata execution from aggregator API
            (success, revertData) = address(liquidSwapRouter).call(liq.swapCalldata);
        } else if (liq.hops.length > 0) {
            // Legacy multi-hop – adjust first hop amount
            uint256 expectedIn = 0;
            for (uint256 i = 0; i < liq.hops[0].length; i++) {
                expectedIn += liq.hops[0][i].amountIn;
            }

            if (expectedIn != collateralBalance) {
                int256 delta = int256(collateralBalance) - int256(expectedIn);
                if (delta > 0) {
                    liq.hops[0][0].amountIn += uint256(delta);
                } else if (uint256(-delta) <= liq.hops[0][0].amountIn) {
                    liq.hops[0][0].amountIn -= uint256(-delta);
                } else {
                    revert("Cannot adjust hop amount");
                }
            }

            try liquidSwapRouter.executeMultiHopSwap(
                liq.tokens,
                collateralBalance,
                liq.minAmountOut,
                liq.hops
            ) returns (uint256) {
                success = true;
            } catch (bytes memory err) {
                success = false;
                revertData = err;
            }
        } else {
            revert("No swap path provided");
        }

        if (!success) {
            emit SwapExecutionFailed(revertData);
            revert("Swap execution failed");
        }

        // Wrap native HYPE if received
        if (address(this).balance > 0) {
            wHYPE.deposit{value: address(this).balance}();
        }

        uint256 totalDebt = amount + premium;
        uint256 finalBalance = IERC20(debtAsset).balanceOf(address(this));

        require(finalBalance >= totalDebt, "insufficient output to repay flash loan");

        uint256 profit = finalBalance - totalDebt;

        if (profit > 0) {
            IERC20(debtAsset).safeTransfer(owner(), profit);
            emit ProfitSent(debtAsset, profit, owner());
        }

        emit LiquidationExecuted(
            liq.user,
            liq.collateral,
            debtAsset,
            liq.debtToCover,
            profit,
            liq.swapCalldata.length > 0
        );

        return true;
    }

    function rescueTokens(
    address _token,
    uint256 _amount,
    bool _max,
    address _to
) external onlyOwner {
    uint256 sendAmount;

    if (_token == address(0)) {
        // Native HYPE / ETH
        sendAmount = _max ? address(this).balance : _amount;
        require(sendAmount > 0, "No native balance to rescue");

        (bool success,) = payable(_to).call{value: sendAmount}("");
        require(success, "Native transfer failed");

        emit ProfitSent(address(0), sendAmount, _to);
    } else {
        // ERC20 token
        sendAmount = _max ? IERC20(_token).balanceOf(address(this)) : _amount;
        require(sendAmount > 0, "No token balance to rescue");

        IERC20(_token).safeTransfer(_to, sendAmount);
        emit ProfitSent(_token, sendAmount, _to);
    }
}
receive() external payable {}
}
