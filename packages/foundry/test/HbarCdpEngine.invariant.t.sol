// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { HbarCdpEngine } from "../contracts/HbarCdpEngine.sol";
import { EngineFixture } from "./HbarCdpEngine.t.sol";
import { MockPriceOracle } from "./mocks/MockFeeds.sol";

/// @dev Drives the engine with bounded random actions from a fixed set of actors.
contract EngineHandler is Test {
    uint256 internal constant HBAR = 1e8;

    HbarCdpEngine public immutable engine;
    MockPriceOracle public immutable oracle;
    IERC20 public immutable token;
    address[] public actors;

    /// @dev Ghost counters: inspect with `forge test --match-contract Invariant -vv` to confirm coverage.
    uint256 public successfulMints;
    uint256 public successfulLiquidations;

    constructor(HbarCdpEngine engine_, MockPriceOracle oracle_, IERC20 token_, address[] memory actors_) {
        engine = engine_;
        oracle = oracle_;
        token = token_;
        actors = actors_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1, 50_000 * HBAR);
        vm.deal(actor, actor.balance + amount);
        vm.prank(actor);
        engine.deposit{ value: amount }();
    }

    function mint(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 maxMintable = engine.getVault(actor).maxMintable;
        (, uint256 debt) = engine.vaultOf(actor);
        // Mint at least what keeps the vault above minDebt, so calls exercise real state, not dust rejections.
        uint256 minAmount = debt >= engine.minDebt() ? 1 : engine.minDebt() - debt;
        if (maxMintable < minAmount) return;
        amount = bound(amount, minAmount, maxMintable);
        vm.prank(actor);
        try engine.mint(amount) {
            ++successfulMints;
        } catch { } // minDebt / ceiling rejections are expected
    }

    function repay(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        (, uint256 debt) = engine.vaultOf(actor);
        uint256 balance = token.balanceOf(actor);
        uint256 maxRepay = debt < balance ? debt : balance;
        if (maxRepay == 0) return;
        amount = bound(amount, 1, maxRepay);
        vm.startPrank(actor);
        token.approve(address(engine), amount);
        try engine.repay(amount) { } catch { }
        vm.stopPrank();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 maxOut = engine.getVault(actor).maxWithdrawable;
        if (maxOut == 0) return;
        amount = bound(amount, 1, maxOut);
        vm.prank(actor);
        engine.withdraw(amount); // must never revert within maxWithdrawable
    }

    function liquidate(uint256 liquidatorSeed, uint256 ownerSeed, uint256 amount) external {
        address liquidator = _actor(liquidatorSeed);
        address owner = _actor(ownerSeed);
        if (!engine.getVault(owner).liquidatable) return;
        (, uint256 debt) = engine.vaultOf(owner);
        uint256 balance = token.balanceOf(liquidator);
        // Valid repay amounts: the full debt, or anything that leaves at least minDebt behind.
        if (balance >= debt) {
            amount = debt;
        } else {
            uint256 maxPartial = debt - engine.minDebt();
            uint256 cap = balance < maxPartial ? balance : maxPartial;
            if (cap == 0) return;
            amount = bound(amount, 1, cap);
        }
        vm.startPrank(liquidator);
        token.approve(address(engine), amount);
        try engine.liquidate(owner, amount) {
            ++successfulLiquidations;
        } catch { }
        vm.stopPrank();
    }

    function movePrice(uint256 priceE18) external {
        oracle.setPrice(bound(priceE18, 0.01e18, 1e18));
    }
}

contract HbarCdpEngineInvariantTest is EngineFixture {
    EngineHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");
        handler = new EngineHandler(engine, oracle, token, actors);
        targetContract(address(handler));
    }

    function _sumVaults() internal view returns (uint256 collateral, uint256 debt) {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            (uint256 c, uint256 d) = engine.vaultOf(handler.actors(i));
            collateral += c;
            debt += d;
        }
    }

    /// Every stablecoin in circulation is backed by recorded debt, and nothing lingers in the treasury.
    function invariant_SupplyEqualsDebt() public view {
        (, uint256 debt) = _sumVaults();
        assertEq(token.totalSupply(), engine.totalDebt());
        assertEq(engine.totalDebt(), debt);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    /// Tracked collateral matches the vaults and is always fully held by the engine.
    function invariant_CollateralIsFullyBacked() public view {
        (uint256 collateral,) = _sumVaults();
        assertEq(engine.totalCollateral(), collateral);
        assertGe(address(engine).balance, engine.totalCollateral());
    }

    /// No vault ever carries unliquidatable dust debt.
    function invariant_NoDustDebt() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            (, uint256 debt) = engine.vaultOf(handler.actors(i));
            assertTrue(debt == 0 || debt >= engine.minDebt());
        }
    }

    function invariant_DebtWithinCeiling() public view {
        assertLe(engine.totalDebt(), engine.debtCeiling());
    }
}
