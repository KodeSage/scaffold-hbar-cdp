// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPriceOracle } from "../../contracts/interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../../contracts/interfaces/ISupraSValueFeed.sol";

/// @dev Chainlink-shaped feed with a settable answer, timestamp and failure mode.
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public shouldRevert;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function description() external pure returns (string memory) {
        return "HBAR / USD";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Supra-shaped push feed. `timeMs` is in milliseconds, like the real oracle.
contract MockSupra {
    uint256 public price;
    uint256 public decimals;
    uint256 public timeMs;
    bool public shouldRevert;

    constructor(uint256 price_, uint256 decimals_, uint256 timeMs_) {
        price = price_;
        decimals = decimals_;
        timeMs = timeMs_;
    }

    function set(uint256 price_, uint256 timeMs_) external {
        price = price_;
        timeMs = timeMs_;
    }

    function setRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function getSvalue(uint256) external view returns (ISupraSValueFeed.PriceFeed memory) {
        require(!shouldRevert, "feed down");
        return ISupraSValueFeed.PriceFeed({ round: 1, decimals: decimals, time: timeMs, price: price });
    }
}

/// @dev Returns a malformed (too short) payload to exercise the oracle's decoding guard.
contract MalformedFeed {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

/// @dev Directly settable IPriceOracle for engine tests.
contract MockPriceOracle is IPriceOracle {
    uint256 public price;
    Status public status;

    constructor(uint256 priceE18) {
        price = priceE18;
    }

    function setPrice(uint256 priceE18) external {
        price = priceE18;
    }

    function setStatus(Status status_) external {
        status = status_;
    }

    function latestPrice() external view returns (uint256, Status, uint256) {
        if (status >= Status.Frozen) return (0, status, 0);
        return (price, status, block.timestamp);
    }
}
