// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { htsSetup } from "hedera-forking/htsSetup.sol";
import { HbarCdpEngine } from "../contracts/HbarCdpEngine.sol";
import { IHederaTokenService } from "../contracts/interfaces/IHederaTokenService.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { MockPriceOracle } from "./mocks/MockFeeds.sol";

/// @dev Shared fixture: engine + HTS emulator (hedera-forking) + settable oracle.
///      Amounts follow on-chain units: HBAR in tinybars (1e8), stablecoin in 6 decimals, price in 1e18.
abstract contract EngineFixture is Test {
    uint256 internal constant HBAR = 1e8;
    uint256 internal constant USD = 1e6;
    uint256 internal constant PRICE = 0.1e18; // $0.10 per HBAR

    uint256 internal constant MCR = 15_000;
    uint256 internal constant LIQ = 12_500;
    uint256 internal constant BONUS = 1_000;
    uint256 internal constant MIN_DEBT = 1 * USD;
    uint256 internal constant CEILING = 1_000_000 * USD;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockPriceOracle internal oracle;
    HbarCdpEngine internal engine;
    IERC20 internal token;

    function setUp() public virtual {
        htsSetup();
        oracle = new MockPriceOracle(PRICE);
        engine = new HbarCdpEngine(owner, IPriceOracle(address(oracle)), MCR, LIQ, BONUS, MIN_DEBT, CEILING);

        vm.deal(owner, 100 * HBAR);
        vm.prank(owner);
        token = IERC20(engine.createStablecoin{ value: 20 * HBAR }("Scaffold CDP Dollar", "SCD", "test"));

        vm.deal(alice, 1_000_000 * HBAR);
        vm.deal(bob, 1_000_000 * HBAR);
    }

    /// @dev 1,000 HBAR at $0.10 = $100 of collateral; at 150% that backs up to $66.666666.
    function _openVault(address user, uint256 collateral, uint256 debt) internal {
        vm.prank(user);
        engine.depositAndMint{ value: collateral }(debt);
    }

    function _approve(address user, uint256 amount) internal {
        vm.prank(user);
        token.approve(address(engine), amount);
    }
}

contract HbarCdpEngineTest is EngineFixture {
    // ---- setup ---------------------------------------------------------------------------------------------

    function test_CreateStablecoin_EngineIsTreasuryAndSupplyKey() public view {
        assertTrue(address(token) != address(0));
        assertEq(engine.stablecoin(), address(token));
        assertEq(token.totalSupply(), 0);
    }

    function test_CreateStablecoin_OnlyOnceAndOnlyOwner() public {
        vm.prank(owner);
        vm.expectRevert(HbarCdpEngine.StablecoinAlreadyCreated.selector);
        engine.createStablecoin{ value: 20 * HBAR }("X", "X", "");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.createStablecoin{ value: 20 * HBAR }("X", "X", "");
    }

    function test_Constructor_RejectsUnsafeRiskParameters() public {
        IPriceOracle o = IPriceOracle(address(oracle));
        vm.expectRevert(HbarCdpEngine.InvalidConfig.selector); // liquidation would leave the vault insolvent
        new HbarCdpEngine(owner, o, MCR, 11_000, 1_000, MIN_DEBT, CEILING);
        vm.expectRevert(HbarCdpEngine.InvalidConfig.selector); // MCR below liquidation ratio
        new HbarCdpEngine(owner, o, 12_000, LIQ, BONUS, MIN_DEBT, CEILING);
        vm.expectRevert(HbarCdpEngine.InvalidConfig.selector); // bonus above cap
        new HbarCdpEngine(owner, o, 20_000, 15_000, 3_000, MIN_DEBT, CEILING);
        vm.expectRevert(HbarCdpEngine.InvalidConfig.selector);
        new HbarCdpEngine(owner, o, MCR, LIQ, BONUS, 0, CEILING);
        vm.expectRevert(HbarCdpEngine.InvalidConfig.selector);
        new HbarCdpEngine(owner, IPriceOracle(address(0)), MCR, LIQ, BONUS, MIN_DEBT, CEILING);
    }

    function test_MintBeforeTokenCreated_Reverts() public {
        HbarCdpEngine fresh =
            new HbarCdpEngine(owner, IPriceOracle(address(oracle)), MCR, LIQ, BONUS, MIN_DEBT, CEILING);
        vm.prank(alice);
        vm.expectRevert(HbarCdpEngine.StablecoinNotCreated.selector);
        fresh.depositAndMint{ value: 1_000 * HBAR }(10 * USD);
    }

    // ---- deposit & mint ------------------------------------------------------------------------------------

    function test_DepositAndMint_UpdatesVaultTotalsAndBalances() public {
        vm.expectEmit(address(engine));
        emit HbarCdpEngine.VaultUpdated(alice, 1_000 * HBAR, 50 * USD);
        _openVault(alice, 1_000 * HBAR, 50 * USD);

        (uint256 collateral, uint256 debt) = engine.vaultOf(alice);
        assertEq(collateral, 1_000 * HBAR);
        assertEq(debt, 50 * USD);
        assertEq(engine.totalCollateral(), 1_000 * HBAR);
        assertEq(engine.totalDebt(), 50 * USD);
        assertEq(token.balanceOf(alice), 50 * USD);
        assertEq(token.totalSupply(), 50 * USD);
        assertEq(engine.vaultCount(), 1);
    }

    function test_Mint_AllowsExactlyTheMinimumCollateralRatio() public {
        // $100 of collateral at 150% supports exactly $66.666666 (rounded down).
        _openVault(alice, 1_000 * HBAR, 66_666_666);
        HbarCdpEngine.VaultView memory v = engine.getVault(alice);
        assertEq(v.maxMintable, 0);
        assertGe(v.collateralRatioBps, MCR);
    }

    function test_Mint_RevertsAboveTheMinimumCollateralRatio() public {
        uint256 required = engine.requiredCollateral(66_666_667, PRICE, MCR);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.Undercollateralised.selector, required));
        engine.depositAndMint{ value: 1_000 * HBAR }(66_666_667);
    }

    function test_Mint_EnforcesMinimumDebtAndCeiling() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.DebtBelowMinimum.selector, MIN_DEBT));
        engine.depositAndMint{ value: 1_000 * HBAR }(MIN_DEBT - 1);

        vm.prank(owner);
        engine.setDebtCeiling(10 * USD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.DebtCeilingExceeded.selector, 10 * USD));
        engine.depositAndMint{ value: 1_000 * HBAR }(11 * USD);
    }

    function test_Mint_RevertsWhilePaused_ButRepayAndWithdrawStillWork() public {
        _openVault(alice, 1_000 * HBAR, 20 * USD);
        vm.prank(owner);
        engine.setMintingPaused(true);

        vm.prank(alice);
        vm.expectRevert(HbarCdpEngine.MintingPaused.selector);
        engine.mint(1 * USD);

        _approve(alice, 20 * USD);
        vm.prank(alice);
        engine.repayAndWithdraw(20 * USD, 1_000 * HBAR);
        (uint256 collateral, uint256 debt) = engine.vaultOf(alice);
        assertEq(collateral + debt, 0);
    }

    function test_Mint_RevertsWhenOracleIsFrozenOrUnavailable() public {
        vm.prank(alice);
        engine.deposit{ value: 1_000 * HBAR }();

        oracle.setStatus(IPriceOracle.Status.Frozen);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.OracleUnusable.selector, IPriceOracle.Status.Frozen));
        engine.mint(10 * USD);

        oracle.setStatus(IPriceOracle.Status.Unavailable);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.OracleUnusable.selector, IPriceOracle.Status.Unavailable));
        engine.mint(10 * USD);
    }

    function test_Mint_AcceptsDegradedButFreshOracle() public {
        oracle.setStatus(IPriceOracle.Status.SecondaryOnly);
        _openVault(alice, 1_000 * HBAR, 10 * USD);
        assertEq(token.balanceOf(alice), 10 * USD);
    }

    function test_Mint_SurfacesMissingTokenAssociation() public {
        vm.prank(alice);
        engine.deposit{ value: 1_000 * HBAR }();
        // The emulator auto-associates, so simulate the real network's TOKEN_NOT_ASSOCIATED_TO_ACCOUNT (184).
        vm.mockCall(
            address(0x167), abi.encodeWithSelector(IHederaTokenService.transferToken.selector), abi.encode(int64(184))
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.NotAssociated.selector, alice));
        engine.mint(10 * USD);
    }

    function test_Mint_SurfacesOtherHtsFailures() public {
        vm.prank(alice);
        engine.deposit{ value: 1_000 * HBAR }();
        vm.mockCall(
            address(0x167),
            abi.encodeWithSelector(IHederaTokenService.mintToken.selector),
            abi.encode(int64(180), int64(0), new int64[](0))
        );
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                HbarCdpEngine.HtsCallFailed.selector, IHederaTokenService.mintToken.selector, int64(180)
            )
        );
        engine.mint(10 * USD);
    }

    // ---- repay ---------------------------------------------------------------------------------------------

    function test_Repay_BurnsSupplyAndReducesDebt() public {
        _openVault(alice, 1_000 * HBAR, 50 * USD);
        _approve(alice, 20 * USD);
        vm.prank(alice);
        engine.repay(20 * USD);

        (, uint256 debt) = engine.vaultOf(alice);
        assertEq(debt, 30 * USD);
        assertEq(token.totalSupply(), 30 * USD);
        assertEq(token.balanceOf(address(engine)), 0, "treasury must not keep repaid tokens");
    }

    function test_Repay_RequiresAllowance() public {
        _openVault(alice, 1_000 * HBAR, 50 * USD);
        vm.prank(alice);
        vm.expectRevert(); // HTS rejects a transferFrom without allowance
        engine.repay(10 * USD);
    }

    function test_Repay_CannotLeaveDustOrOverpay() public {
        _openVault(alice, 1_000 * HBAR, 5 * USD);
        _approve(alice, type(uint64).max);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.DebtBelowMinimum.selector, MIN_DEBT));
        engine.repay(5 * USD - 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.ExceedsDebt.selector, 5 * USD));
        engine.repay(5 * USD + 1);
    }

    // ---- withdraw ------------------------------------------------------------------------------------------

    function test_Withdraw_UpToMaxWithdrawable() public {
        _openVault(alice, 1_000 * HBAR, 50 * USD);
        uint256 maxOut = engine.getVault(alice).maxWithdrawable;
        // 50 USD at 150% needs 750 HBAR.
        assertEq(maxOut, 250 * HBAR);

        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        engine.withdraw(maxOut);
        assertEq(alice.balance, balanceBefore + maxOut);

        uint256 required = engine.requiredCollateral(50 * USD, PRICE, MCR);
        assertEq(required, 750 * HBAR);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.Undercollateralised.selector, required));
        engine.withdraw(1);
    }

    function test_Withdraw_DebtFreeVaultIgnoresOracle() public {
        vm.prank(alice);
        engine.deposit{ value: 1_000 * HBAR }();
        oracle.setStatus(IPriceOracle.Status.Unavailable);

        assertEq(engine.getVault(alice).maxWithdrawable, 1_000 * HBAR);
        vm.prank(alice);
        engine.withdraw(1_000 * HBAR);
        assertEq(engine.totalCollateral(), 0);
    }

    function test_Withdraw_WithDebtNeedsOracle() public {
        _openVault(alice, 1_000 * HBAR, 10 * USD);
        oracle.setStatus(IPriceOracle.Status.Frozen);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.OracleUnusable.selector, IPriceOracle.Status.Frozen));
        engine.withdraw(1 * HBAR);
    }

    function test_Withdraw_MoreThanCollateral_Reverts() public {
        vm.prank(alice);
        engine.deposit{ value: 10 * HBAR }();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.InsufficientCollateral.selector, 10 * HBAR));
        engine.withdraw(10 * HBAR + 1);
    }

    // ---- liquidation ---------------------------------------------------------------------------------------

    function test_Liquidate_HealthyVault_Reverts() public {
        _openVault(alice, 1_000 * HBAR, 60 * USD);
        _openVault(bob, 10_000 * HBAR, 60 * USD);
        _approve(bob, 60 * USD);
        vm.prank(bob);
        vm.expectRevert(HbarCdpEngine.NotLiquidatable.selector);
        engine.liquidate(alice, 60 * USD);
    }

    function test_Liquidate_PaysDebtPlusBonusInCollateral() public {
        _openVault(alice, 1_000 * HBAR, 60 * USD); // CR 166%
        _openVault(bob, 10_000 * HBAR, 60 * USD);

        oracle.setPrice(0.07e18); // collateral now $70 -> CR 116.66% < 125%
        HbarCdpEngine.VaultView memory before = engine.getVault(alice);
        assertTrue(before.liquidatable);
        assertEq(before.collateralRatioBps, 11_666);

        _approve(bob, 30 * USD);
        uint256 bobHbarBefore = bob.balance;
        vm.prank(bob);
        engine.liquidate(alice, 30 * USD);

        // $30 * 1.10 / $0.07 = 471.42857142 HBAR, rounded down to the tinybar.
        uint256 expectedSeized = uint256(30 * USD * 11_000) * 1e20 / (0.07e18 * 10_000);
        assertEq(expectedSeized, 47_142_857_142);
        assertEq(bob.balance - bobHbarBefore, expectedSeized);

        (uint256 collateral, uint256 debt) = engine.vaultOf(alice);
        assertEq(debt, 30 * USD);
        assertEq(collateral, 1_000 * HBAR - expectedSeized);
        assertEq(token.totalSupply(), 90 * USD);
        // Above 110% (1 + bonus) every liquidation strictly improves the vault: 116.66% -> 123.33%.
        assertEq(engine.getVault(alice).collateralRatioBps, 12_333);
        assertGt(engine.getVault(alice).collateralRatioBps, before.collateralRatioBps);
    }

    function test_Liquidate_UnderwaterVault_CapsSeizureAtCollateral() public {
        _openVault(alice, 1_000 * HBAR, 60 * USD);
        _openVault(bob, 100_000 * HBAR, 100 * USD);
        oracle.setPrice(0.05e18); // collateral $50 < debt $60

        _approve(bob, 60 * USD);
        vm.prank(bob);
        engine.liquidate(alice, 60 * USD);

        (uint256 collateral, uint256 debt) = engine.vaultOf(alice);
        assertEq(collateral, 0);
        assertEq(debt, 0);
        assertEq(engine.totalCollateral(), 100_000 * HBAR);
    }

    function test_Liquidate_RejectsDustRemainderAndOverRepay() public {
        _openVault(alice, 1_000 * HBAR, 60 * USD);
        _openVault(bob, 10_000 * HBAR, 100 * USD);
        oracle.setPrice(0.07e18);
        _approve(bob, 100 * USD);

        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.DebtBelowMinimum.selector, MIN_DEBT));
        engine.liquidate(alice, 60 * USD - 1);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.ExceedsDebt.selector, 60 * USD));
        engine.liquidate(alice, 60 * USD + 1);
        vm.stopPrank();
    }

    function test_Liquidate_RequiresUsableOracle() public {
        _openVault(alice, 1_000 * HBAR, 60 * USD);
        oracle.setStatus(IPriceOracle.Status.Frozen);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HbarCdpEngine.OracleUnusable.selector, IPriceOracle.Status.Frozen));
        engine.liquidate(alice, 10 * USD);
    }

    // ---- views ---------------------------------------------------------------------------------------------

    function test_GetVault_ReportsValuesAtCurrentPrice() public {
        _openVault(alice, 1_000 * HBAR, 50 * USD);
        HbarCdpEngine.VaultView memory v = engine.getVault(alice);
        assertEq(v.collateralValue, 100 * USD);
        assertEq(v.collateralRatioBps, 20_000);
        assertEq(v.maxMintable, 16_666_666);
        assertFalse(v.liquidatable);

        HbarCdpEngine.VaultView memory empty = engine.getVault(bob);
        assertEq(empty.collateralRatioBps, type(uint256).max);
        assertEq(empty.maxWithdrawable, 0);
    }

    function test_GetVaults_Paginates() public {
        _openVault(alice, 1_000 * HBAR, 10 * USD);
        _openVault(bob, 1_000 * HBAR, 10 * USD);

        HbarCdpEngine.VaultView[] memory page = engine.getVaults(1, 10);
        assertEq(page.length, 1);
        assertEq(page[0].owner, bob);
        assertEq(engine.getVaults(2, 10).length, 0);
        assertEq(engine.getVaults(0, 1)[0].owner, alice);
        assertEq(engine.getVaults(0, type(uint256).max).length, 2);
        assertEq(engine.getVaults(1, type(uint256).max).length, 1);
    }

    // ---- admin ---------------------------------------------------------------------------------------------

    function test_SweepExcessHbar_NeverTouchesCollateral() public {
        _openVault(alice, 1_000 * HBAR, 10 * USD);
        // Simulate HBAR held above collateral (e.g. an unused token-creation fee refund).
        uint256 excess = 7 * HBAR;
        vm.deal(address(engine), address(engine).balance + excess);

        uint256 before = owner.balance;
        vm.prank(owner);
        engine.sweepExcessHbar(payable(owner));
        assertEq(owner.balance - before, excess);
        assertEq(address(engine).balance, engine.totalCollateral());

        vm.prank(owner);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.sweepExcessHbar(payable(owner));
    }

    function test_AdminFunctions_AreOwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setDebtCeiling(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setMintingPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.sweepExcessHbar(payable(alice));
        vm.stopPrank();
    }

    function test_ZeroAmounts_Revert() public {
        vm.startPrank(alice);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.deposit{ value: 0 }();
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.mint(0);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.repay(0);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.withdraw(0);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.repayAndWithdraw(0, 0);
        vm.expectRevert(HbarCdpEngine.ZeroAmount.selector);
        engine.liquidate(bob, 0);
        vm.stopPrank();
    }

    // ---- fuzz ----------------------------------------------------------------------------------------------

    /// @dev Whatever is minted, the vault is at or above MCR and `maxMintable` agrees with the enforced check.
    function testFuzz_MintBoundIsExact(uint256 collateral, uint256 priceE18) public {
        collateral = bound(collateral, 1 * HBAR, 1_000_000 * HBAR);
        priceE18 = bound(priceE18, 0.001e18, 100e18);
        oracle.setPrice(priceE18);

        vm.prank(alice);
        engine.deposit{ value: collateral }();
        uint256 maxMintable = engine.getVault(alice).maxMintable;
        vm.assume(maxMintable >= MIN_DEBT && maxMintable <= CEILING);

        vm.prank(alice);
        engine.mint(maxMintable);
        assertEq(engine.getVault(alice).maxMintable, 0);
        assertGe(engine.getVault(alice).collateralRatioBps, MCR);

        vm.prank(alice);
        vm.expectRevert();
        engine.mint(1);
    }

    /// @dev Withdrawing exactly `maxWithdrawable` always succeeds and leaves nothing more to withdraw.
    function testFuzz_WithdrawBoundIsExact(uint256 collateral, uint256 debt, uint256 priceE18) public {
        priceE18 = bound(priceE18, 0.001e18, 100e18);
        collateral = bound(collateral, 1 * HBAR, 1_000_000 * HBAR);
        oracle.setPrice(priceE18);
        vm.prank(alice);
        engine.deposit{ value: collateral }();

        uint256 maxMintable = engine.getVault(alice).maxMintable;
        vm.assume(maxMintable >= MIN_DEBT);
        debt = bound(debt, MIN_DEBT, maxMintable < CEILING ? maxMintable : CEILING);
        vm.prank(alice);
        engine.mint(debt);

        uint256 maxOut = engine.getVault(alice).maxWithdrawable;
        if (maxOut > 0) {
            vm.prank(alice);
            engine.withdraw(maxOut);
        }
        assertEq(engine.getVault(alice).maxWithdrawable, 0);
        assertGe(engine.getVault(alice).collateralRatioBps, MCR);
    }
}
