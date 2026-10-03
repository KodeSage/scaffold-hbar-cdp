// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Price source consumed by the CDP engine.
interface IPriceOracle {
    /// @dev Ordering matters: every status below `Frozen` yields a usable price.
    enum Status {
        /// Both feeds fresh and within the deviation bound (or the secondary is disabled by config).
        Ok,
        /// Primary fresh, secondary stale or reverting: primary price is used.
        PrimaryOnly,
        /// Primary stale or reverting, secondary fresh: secondary price is used.
        SecondaryOnly,
        /// Both feeds fresh but disagree beyond the deviation bound: no price is trusted.
        Frozen,
        /// No fresh feed at all.
        Unavailable
    }

    /// @notice Latest HBAR/USD price. Never reverts; callers decide what to do with `status`.
    /// @return priceE18 USD per 1 HBAR, 18 decimals. Zero when `status` is `Frozen` or `Unavailable`.
    /// @return status Health of the price sources.
    /// @return updatedAt Unix seconds of the price that was returned (0 when unusable).
    function latestPrice() external view returns (uint256 priceE18, Status status, uint256 updatedAt);
}
