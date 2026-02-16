const { ethers } = require("ethers");

function prepareHops(apiResponse) {
  const hops = [];

  const decimals = {};
  decimals[ethers.getAddress(apiResponse.tokenInfo.tokenIn.address)] = Number(apiResponse.tokenInfo.tokenIn.decimals);
  decimals[ethers.getAddress(apiResponse.tokenInfo.tokenOut.address)] = Number(apiResponse.tokenInfo.tokenOut.decimals);

  if (apiResponse.tokenInfo.intermediate) {
    decimals[ethers.getAddress(apiResponse.tokenInfo.intermediate.address)] = Number(
      apiResponse.tokenInfo.intermediate.decimals
    );
  }

  for (const hop of apiResponse.bestPath.hop) {
    const allocations = hop.allocations.map((alloc) => {
      const tokenIn = ethers.getAddress(alloc.tokenIn);
      const tokenOut = ethers.getAddress(alloc.tokenOut);

      const dec = decimals[tokenIn];
      if (dec === undefined) {
        throw new Error(`Missing decimals for tokenIn ${tokenIn}`);
      }

      // alloc.amountIn is expected as a human-readable decimal string (e.g. "1.2345")
      // Use parseUnits to avoid precision loss.
      const amountIn = ethers.parseUnits(String(alloc.amountIn), dec);

      return {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        routerIndex: alloc.routerIndex,
        fee: alloc.fee,
        amountIn: amountIn, // BigInt
        stable: alloc.stable,
      };
    });

    hops.push(allocations);
  }

  return hops;
}

module.exports.prepareHops = prepareHops;