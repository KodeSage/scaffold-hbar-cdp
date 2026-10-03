// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { DualOracle } from "../contracts/oracle/DualOracle.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../contracts/interfaces/ISupraSValueFeed.sol";
import { MalformedFeed, MockAggregator, MockSupra } from "./mocks/MockFeeds.sol";

contract DualOracleTest is Test {
    uint256 internal constant CL_MAX_AGE = 4 hours;
    uint256 internal constant SUPRA_MAX_AGE = 3 hours;
    uint256 internal constant MAX_DEV_BPS = 300;
    uint256 internal constant NOW = 1_800_000_000;

    MockAggregator internal chainlink;
    MockSupra internal supra;
    DualOracle internal oracle;

    function setUp() public {
        vm.warp(NOW);
        chainlink = new MockAggregator(8, 0.1e8, NOW); // $0.10, 8 decimals
        supra = new MockSupra(0.1e18, 18, NOW * 1000); // $0.10, 18 decimals, ms timestamp
        oracle = _deploy(address(supra));
    }

    function _deploy(address supraFeed) internal returns (DualOracle) {
        return new DualOracle(
            IAggregatorV3(address(chainlink)), CL_MAX_AGE, ISupraSValueFeed(supraFeed), 75, SUPRA_MAX_AGE, MAX_DEV_BPS
        );
    }

    function _assertLatest(uint256 expectedPrice, IPriceOracle.Status expectedStatus) internal view {
        (uint256 price, IPriceOracle.Status status,) = oracle.latestPrice();
        assertEq(uint256(status), uint256(expectedStatus), "status");
        assertEq(price, expectedPrice, "price");
    }

    // ---- status machine -------------------------------------------------------------------------------------

    function test_BothFreshAndAgreeing_ReturnsChainlinkPrice() public {
        supra.set(0.101e18, NOW * 1000); // 1% apart
        _assertLatest(0.1e18, IPriceOracle.Status.Ok);
    }

    function test_DeviationAtBound_IsStillOk() public {
        supra.set(0.103e18, NOW * 1000); // exactly 3.00%
        _assertLatest(0.1e18, IPriceOracle.Status.Ok);
    }

    function test_DeviationBeyondBound_Freezes() public {
        supra.set(0.1031e18, NOW * 1000); // 3.1%
        _assertLatest(0, IPriceOracle.Status.Frozen);
    }

    function test_DeviationIsMeasuredAgainstTheLowerPrice_InBothDirections() public {
        supra.set(0.097e18, NOW * 1000); // chainlink is 3.09% above supra
        _assertLatest(0, IPriceOracle.Status.Frozen);
    }

    function test_StaleSupra_FallsBackToPrimaryOnly() public {
        supra.set(0.2e18, (NOW - SUPRA_MAX_AGE - 1) * 1000); // stale and wildly off: must be ignored
        _assertLatest(0.1e18, IPriceOracle.Status.PrimaryOnly);
    }

    function test_StaleChainlink_FallsBackToSecondaryOnly() public {
        chainlink.set(0.1e8, NOW - CL_MAX_AGE - 1);
        supra.set(0.105e18, NOW * 1000);
        _assertLatest(0.105e18, IPriceOracle.Status.SecondaryOnly);
    }

    function test_FreshnessBoundaryIsInclusive() public {
        chainlink.set(0.1e8, NOW - CL_MAX_AGE);
        supra.set(0.1e18, (NOW - SUPRA_MAX_AGE) * 1000);
        _assertLatest(0.1e18, IPriceOracle.Status.Ok);
    }

    function test_BothStale_Unavailable() public {
        chainlink.set(0.1e8, NOW - CL_MAX_AGE - 1);
        supra.set(0.1e18, (NOW - SUPRA_MAX_AGE - 1) * 1000);
        _assertLatest(0, IPriceOracle.Status.Unavailable);
    }

    function test_RevertingFeeds_DegradeInsteadOfReverting() public {
        chainlink.setRevert(true);
        _assertLatest(0.1e18, IPriceOracle.Status.SecondaryOnly);
        supra.setRevert(true);
        _assertLatest(0, IPriceOracle.Status.Unavailable);
    }

    function test_FeedWithoutCodeOrMalformedReturn_DoesNotRevert() public {
        oracle = _deploy(address(0xBEEF)); // no code at the Supra address
        _assertLatest(0.1e18, IPriceOracle.Status.PrimaryOnly);

        oracle = _deploy(address(new MalformedFeed()));
        _assertLatest(0.1e18, IPriceOracle.Status.PrimaryOnly);
    }

    function test_NonPositiveAnswers_AreRejected() public {
        chainlink.set(0, NOW);
        _assertLatest(0.1e18, IPriceOracle.Status.SecondaryOnly);
        chainlink.set(-1, NOW);
        _assertLatest(0.1e18, IPriceOracle.Status.SecondaryOnly);
        supra.set(0, NOW * 1000);
        _assertLatest(0, IPriceOracle.Status.Unavailable);
    }

    function test_FutureTimestamps_CountAsFresh() public {
        chainlink.set(0.1e8, NOW + 30);
        supra.set(0.1e18, (NOW + 30) * 1000);
        _assertLatest(0.1e18, IPriceOracle.Status.Ok);
    }

    function test_SingleSourceMode_ReportsOk() public {
        oracle = _deploy(address(0));
        _assertLatest(0.1e18, IPriceOracle.Status.Ok);
        chainlink.set(0.1e8, NOW - CL_MAX_AGE - 1);
        _assertLatest(0, IPriceOracle.Status.Unavailable);
    }

    // ---- decimals ------------------------------------------------------------------------------------------

    function test_ScalesAnyFeedDecimalsTo18() public {
        supra = new MockSupra(1e5, 6, NOW * 1000); // $0.10 with 6 decimals
        oracle = _deploy(address(supra));
        (bool ok, uint256 price,) = oracle.readSupra();
        assertTrue(ok);
        assertEq(price, 0.1e18);

        supra = new MockSupra(1e23, 24, NOW * 1000); // $0.10 with 24 decimals
        oracle = _deploy(address(supra));
        (ok, price,) = oracle.readSupra();
        assertTrue(ok);
        assertEq(price, 0.1e18);
    }

    function test_PriceThatOverflowsWhenScaled_IsRejected() public {
        chainlink = new MockAggregator(0, type(int256).max, NOW);
        oracle = _deploy(address(supra));
        (bool ok,,) = oracle.readChainlink();
        assertFalse(ok);
        _assertLatest(0.1e18, IPriceOracle.Status.SecondaryOnly);
    }

    function test_PriceThatRoundsToZero_IsRejected() public {
        supra = new MockSupra(1, 36, NOW * 1000);
        oracle = _deploy(address(supra));
        (bool ok,,) = oracle.readSupra();
        assertFalse(ok);
    }

    // ---- constructor validation ----------------------------------------------------------------------------

    function test_Constructor_RejectsInvalidConfig() public {
        IAggregatorV3 cl = IAggregatorV3(address(chainlink));
        ISupraSValueFeed sp = ISupraSValueFeed(address(supra));

        vm.expectRevert(DualOracle.InvalidConfig.selector);
        new DualOracle(IAggregatorV3(address(0)), CL_MAX_AGE, sp, 75, SUPRA_MAX_AGE, MAX_DEV_BPS);
        vm.expectRevert(DualOracle.InvalidConfig.selector);
        new DualOracle(cl, 0, sp, 75, SUPRA_MAX_AGE, MAX_DEV_BPS);
        vm.expectRevert(DualOracle.InvalidConfig.selector);
        new DualOracle(cl, CL_MAX_AGE, sp, 75, 0, MAX_DEV_BPS);
        vm.expectRevert(DualOracle.InvalidConfig.selector);
        new DualOracle(cl, CL_MAX_AGE, sp, 75, SUPRA_MAX_AGE, 0);
        vm.expectRevert(DualOracle.InvalidConfig.selector);
        new DualOracle(cl, CL_MAX_AGE, sp, 75, SUPRA_MAX_AGE, 10_000);
    }

    // ---- fuzz ----------------------------------------------------------------------------------------------

    function testFuzz_DeviationIsSymmetric(uint128 a, uint128 b) public view {
        assertEq(oracle.deviationBps(a, b), oracle.deviationBps(b, a));
    }

    function testFuzz_LatestPriceNeverReverts(int256 clAnswer, uint256 supraPrice, uint64 clAge, uint64 supraAge)
        public
    {
        chainlink.set(clAnswer, NOW - bound(clAge, 0, NOW));
        supra.set(supraPrice, (NOW - bound(supraAge, 0, NOW)) * 1000);
        (uint256 price, IPriceOracle.Status status,) = oracle.latestPrice();
        if (status >= IPriceOracle.Status.Frozen) assertEq(price, 0);
        else assertGt(price, 0);
    }
}
