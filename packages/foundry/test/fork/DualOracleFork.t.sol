// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { DualOracle } from "../../contracts/oracle/DualOracle.sol";
import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { IPriceOracle } from "../../contracts/interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../../contracts/interfaces/ISupraSValueFeed.sol";
import { DeployScript } from "../../script/Deploy.s.sol";

/// @notice Reads the real Chainlink and Supra feeds on a Hedera fork.
/// @dev Skipped unless forked: `yarn foundry:test:fork` (Hedera testnet via Hashio).
contract DualOracleForkTest is Test {
    DualOracle internal oracle;

    function setUp() public {
        if (block.chainid != 296 && block.chainid != 295) vm.skip(true);

        DeployScript.OracleConfig memory feeds = new DeployScript().oracleConfig(block.chainid);
        oracle = new DualOracle(
            IAggregatorV3(feeds.chainlinkHbarUsd),
            4 hours,
            ISupraSValueFeed(feeds.supraPushOracle),
            feeds.supraHbarUsdtPairId,
            3 hours,
            300
        );
    }

    function test_Fork_ChainlinkFeedIsHbarUsdWith8Decimals() public view {
        assertEq(oracle.chainlinkDecimals(), 8);
        assertEq(oracle.chainlinkFeed().description(), "HBAR / USD");
    }

    function test_Fork_FeedsReturnSaneHbarPrices() public view {
        (, uint256 clPrice, uint256 clAt) = oracle.readChainlink();
        (, uint256 supraPrice, uint256 supraAt) = oracle.readSupra();
        assertGt(clAt, 0, "chainlink never updated");
        assertGt(supraAt, 0, "supra never updated");
        // Freshness depends on the live feeds; when fresh, prices must be in a plausible HBAR range.
        if (clPrice > 0) _assertPlausible(clPrice);
        if (supraPrice > 0) _assertPlausible(supraPrice);
    }

    function test_Fork_LatestPriceIsUsableAndCrossChecked() public view {
        (uint256 price, IPriceOracle.Status status, uint256 updatedAt) = oracle.latestPrice();
        assertTrue(status < IPriceOracle.Status.Frozen, "live feeds should be usable and agree");
        _assertPlausible(price);
        assertGt(updatedAt, 0);

        (bool clOk, uint256 clPrice,) = oracle.readChainlink();
        (bool supraOk, uint256 supraPrice,) = oracle.readSupra();
        if (clOk && supraOk) assertLe(oracle.deviationBps(clPrice, supraPrice), oracle.maxDeviationBps());
    }

    function _assertPlausible(uint256 priceE18) internal pure {
        assertGt(priceE18, 0.001e18, "HBAR below $0.001");
        assertLt(priceE18, 100e18, "HBAR above $100");
    }
}
