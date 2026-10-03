// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Chainlink Data Feed read interface (AggregatorV3Interface).
/// @dev https://docs.chain.link/data-feeds/api-reference
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
