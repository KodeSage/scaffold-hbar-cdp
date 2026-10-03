// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Supra push-oracle read interface.
/// @dev https://docs.supra.com/oracles/data-feeds/push-oracle
///      `time` is a Unix timestamp in MILLISECONDS; `price` is scaled by `10 ** decimals`.
interface ISupraSValueFeed {
    struct PriceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    function getSvalue(uint256 pairIndex) external view returns (PriceFeed memory);
}
