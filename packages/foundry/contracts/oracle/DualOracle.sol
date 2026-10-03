// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAggregatorV3 } from "../interfaces/IAggregatorV3.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../interfaces/ISupraSValueFeed.sol";

/// @title DualOracle
/// @notice HBAR/USD price from a Chainlink feed (primary), cross-checked against a Supra push feed (secondary).
/// @dev Design rules:
///      - Never reverts on a bad feed: every external read is wrapped in try/catch and validated, so a broken
///        or deprecated feed degrades the status instead of bricking the protocol that depends on it.
///      - When both feeds are fresh, the primary price is returned only if the two agree within
///        `maxDeviationBps`; otherwise the status is `Frozen` and no price is returned.
///      - When exactly one feed is fresh, its price is returned with a degraded status so consumers can choose
///        a policy (the CDP engine accepts it; a stricter consumer may not).
///      - Supra quotes HBAR/USDT. Treating USDT as USD is a deliberate approximation for the cross-check only;
///        the deviation bound absorbs normal USDT peg noise.
///      Configuration is immutable: to change feeds or bounds, deploy a new oracle and point consumers at it.
contract DualOracle is IPriceOracle {
    uint256 private constant BPS = 10_000;
    uint256 private constant TARGET_DECIMALS = 18;
    /// @dev Upper bound on feed decimals we accept; keeps the scaling factor within uint256.
    uint256 private constant MAX_FEED_DECIMALS = 36;

    IAggregatorV3 public immutable chainlinkFeed;
    uint8 public immutable chainlinkDecimals;
    uint256 public immutable chainlinkMaxAge;

    /// @notice Zero address disables the cross-check (single-source mode, status is `Ok` when the primary is fresh).
    ISupraSValueFeed public immutable supraFeed;
    uint256 public immutable supraPairId;
    uint256 public immutable supraMaxAge;

    uint256 public immutable maxDeviationBps;

    error InvalidConfig();

    /// @param chainlinkFeed_ Chainlink HBAR/USD aggregator.
    /// @param chainlinkMaxAge_ Max seconds since the Chainlink answer was updated (match the feed heartbeat + margin).
    /// @param supraFeed_ Supra push oracle, or address(0) to disable the cross-check.
    /// @param supraPairId_ Supra pair index for HBAR/USDT.
    /// @param supraMaxAge_ Max seconds since the Supra price was updated.
    /// @param maxDeviationBps_ Max allowed disagreement between feeds, in basis points of the lower price.
    constructor(
        IAggregatorV3 chainlinkFeed_,
        uint256 chainlinkMaxAge_,
        ISupraSValueFeed supraFeed_,
        uint256 supraPairId_,
        uint256 supraMaxAge_,
        uint256 maxDeviationBps_
    ) {
        if (address(chainlinkFeed_) == address(0) || chainlinkMaxAge_ == 0) {
            revert InvalidConfig();
        }
        if (address(supraFeed_) != address(0) && (supraMaxAge_ == 0 || maxDeviationBps_ == 0)) revert InvalidConfig();
        if (maxDeviationBps_ >= BPS) revert InvalidConfig();

        uint8 decimals_ = chainlinkFeed_.decimals();
        if (decimals_ > MAX_FEED_DECIMALS) revert InvalidConfig();

        chainlinkFeed = chainlinkFeed_;
        chainlinkDecimals = decimals_;
        chainlinkMaxAge = chainlinkMaxAge_;
        supraFeed = supraFeed_;
        supraPairId = supraPairId_;
        supraMaxAge = supraMaxAge_;
        maxDeviationBps = maxDeviationBps_;
    }

    /// @inheritdoc IPriceOracle
    function latestPrice() external view returns (uint256 priceE18, Status status, uint256 updatedAt) {
        (bool primaryOk, uint256 primaryPrice, uint256 primaryAt) = readChainlink();

        if (address(supraFeed) == address(0)) {
            return primaryOk ? (primaryPrice, Status.Ok, primaryAt) : (0, Status.Unavailable, 0);
        }

        (bool secondaryOk, uint256 secondaryPrice, uint256 secondaryAt) = readSupra();

        if (primaryOk && secondaryOk) {
            if (deviationBps(primaryPrice, secondaryPrice) > maxDeviationBps) return (0, Status.Frozen, 0);
            return (primaryPrice, Status.Ok, primaryAt);
        }
        if (primaryOk) return (primaryPrice, Status.PrimaryOnly, primaryAt);
        if (secondaryOk) return (secondaryPrice, Status.SecondaryOnly, secondaryAt);
        return (0, Status.Unavailable, 0);
    }

    /// @notice Validated Chainlink read. `ok` is false when the call fails, the answer is non-positive or stale.
    /// @dev Low-level staticcall rather than try/catch: try/catch cannot catch return-data decoding failures
    ///      (e.g. a feed address without code), which would make this view revert.
    function readChainlink() public view returns (bool ok, uint256 priceE18, uint256 updatedAt) {
        (bool success, bytes memory data) =
            address(chainlinkFeed).staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!success || data.length < 5 * 32) return (false, 0, 0);

        (, int256 answer,, uint256 updatedAt_,) = abi.decode(data, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || updatedAt_ == 0 || _age(updatedAt_) > chainlinkMaxAge) return (false, 0, updatedAt_);

        // forge-lint: disable-next-line(unsafe-typecast) answer > 0 was checked above, so the cast is lossless.
        (ok, priceE18) = _scale(uint256(answer), chainlinkDecimals);
        return (ok, priceE18, updatedAt_);
    }

    /// @notice Validated Supra read. Supra timestamps are milliseconds and are converted to seconds here.
    function readSupra() public view returns (bool ok, uint256 priceE18, uint256 updatedAt) {
        if (address(supraFeed) == address(0)) return (false, 0, 0);

        (bool success, bytes memory data) =
            address(supraFeed).staticcall(abi.encodeCall(ISupraSValueFeed.getSvalue, (supraPairId)));
        if (!success || data.length < 4 * 32) return (false, 0, 0);

        ISupraSValueFeed.PriceFeed memory feed = abi.decode(data, (ISupraSValueFeed.PriceFeed));
        uint256 updatedAt_ = feed.time / 1000;
        if (feed.price == 0 || updatedAt_ == 0 || feed.decimals > MAX_FEED_DECIMALS) return (false, 0, updatedAt_);
        if (_age(updatedAt_) > supraMaxAge) return (false, 0, updatedAt_);

        (ok, priceE18) = _scale(feed.price, feed.decimals);
        return (ok, priceE18, updatedAt_);
    }

    /// @notice |a - b| as basis points of the smaller value. Symmetric, so feed order does not matter.
    function deviationBps(uint256 a, uint256 b) public pure returns (uint256) {
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        if (lo == 0 || hi - lo > type(uint256).max / BPS) return type(uint256).max;
        return ((hi - lo) * BPS) / lo;
    }

    /// @dev A timestamp slightly ahead of the chain clock counts as fresh rather than underflowing.
    ///      On Hedera `block.timestamp` is hashgraph consensus time, not a value chosen by a block producer.
    function _age(uint256 timestamp) private view returns (uint256) {
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp > timestamp ? block.timestamp - timestamp : 0;
    }

    /// @dev Rescales to 18 decimals. Reports failure instead of reverting on overflow or a zero result,
    ///      so a misreporting feed is treated as unavailable rather than bricking `latestPrice`.
    function _scale(uint256 value, uint256 decimals) private pure returns (bool ok, uint256 scaled) {
        if (decimals == TARGET_DECIMALS) {
            scaled = value;
        } else if (decimals < TARGET_DECIMALS) {
            uint256 factor = 10 ** (TARGET_DECIMALS - decimals);
            if (value > type(uint256).max / factor) return (false, 0);
            scaled = value * factor;
        } else {
            scaled = value / 10 ** (decimals - TARGET_DECIMALS);
        }
        ok = scaled != 0;
    }
}
