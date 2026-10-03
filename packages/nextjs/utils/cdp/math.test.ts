import {
  collateralRatioBps,
  collateralValue,
  isLiquidatable,
  liquidationPrice,
  liquidationSeize,
  maxMintable,
  maxWithdrawable,
  previewBorrow,
  previewRepay,
  requiredCollateral,
  tinybarsToWeibars,
} from "./math";
import { describe, expect, it } from "vitest";

// Same vectors as packages/foundry/test/HbarCdpEngine.t.sol, so TS and Solidity math are cross-checked.
const HBAR = 10n ** 8n;
const USD = 10n ** 6n;
const PRICE = 10n ** 17n; // $0.10
const params = {
  minCollateralRatioBps: 15_000n,
  liquidationRatioBps: 12_500n,
  liquidationBonusBps: 1_000n,
  minDebt: 1n * USD,
};

describe("core math (matches HbarCdpEngine)", () => {
  it("requiredCollateral rounds up", () => {
    expect(requiredCollateral(50n * USD, PRICE, 15_000n)).toBe(750n * HBAR);
    expect(requiredCollateral(0n, PRICE, 15_000n)).toBe(0n);
    expect(requiredCollateral(1n, PRICE, 15_000n)).toBe(1_500n);
    // At $0.07 one unit of debt needs 2,142.857… tinybars: must round up, never down.
    expect(requiredCollateral(1n, 7n * 10n ** 16n, 15_000n)).toBe(2_143n);
  });

  it("values, ratios and limits", () => {
    expect(collateralValue(1_000n * HBAR, PRICE)).toBe(100n * USD);
    expect(collateralRatioBps(1_000n * HBAR, 50n * USD, PRICE)).toBe(20_000n);
    expect(collateralRatioBps(1_000n * HBAR, 0n, PRICE)).toBeNull();
    expect(maxMintable(1_000n * HBAR, 0n, PRICE, 15_000n)).toBe(66_666_666n);
    expect(maxMintable(1_000n * HBAR, 50n * USD, PRICE, 15_000n)).toBe(16_666_666n);
    expect(maxWithdrawable(1_000n * HBAR, 50n * USD, PRICE, 15_000n)).toBe(250n * HBAR);
    expect(maxWithdrawable(1_000n * HBAR, 0n, 0n, 15_000n)).toBe(1_000n * HBAR);
  });

  it("liquidation seizure includes the bonus and is capped", () => {
    expect(liquidationSeize(30n * USD, 7n * 10n ** 16n, 1_000n, 10_000n * HBAR)).toBe(47_142_857_142n);
    expect(liquidationSeize(60n * USD, 5n * 10n ** 16n, 1_000n, 1_000n * HBAR)).toBe(1_000n * HBAR);
  });

  it("liquidationPrice is exactly the boundary of isLiquidatable", () => {
    const vaults = [
      [1_000n * HBAR, 60n * USD],
      [123_456_789n, 1_000_001n],
      [7n * HBAR, 1n * USD],
    ] as const;
    for (const [collateral, debt] of vaults) {
      const threshold = liquidationPrice(collateral, debt, params.liquidationRatioBps)!;
      expect(isLiquidatable(collateral, debt, threshold, params.liquidationRatioBps)).toBe(false);
      expect(isLiquidatable(collateral, debt, threshold - 1n, params.liquidationRatioBps)).toBe(true);
    }
  });

  it("converts tinybars to weibars for JSON-RPC value", () => {
    expect(tinybarsToWeibars(1n * HBAR)).toBe(10n ** 18n);
  });
});

describe("previewBorrow", () => {
  const empty = { collateral: 0n, debt: 0n };

  it("accepts a borrow exactly at the minimum ratio", () => {
    const preview = previewBorrow(empty, 1_000n * HBAR, 66_666_666n, PRICE, params, 10n ** 12n);
    expect(preview.error).toBeNull();
    expect(preview.collateralRatioBps).toBeGreaterThanOrEqual(15_000n);
  });

  it("rejects one unit more", () => {
    const preview = previewBorrow(empty, 1_000n * HBAR, 66_666_667n, PRICE, params, 10n ** 12n);
    expect(preview.error).toMatch(/below the minimum/);
  });

  it("enforces minimum debt and the ceiling", () => {
    expect(previewBorrow(empty, 1_000n * HBAR, USD - 1n, PRICE, params, 10n ** 12n).error).toMatch(/minimum/);
    expect(previewBorrow(empty, 1_000n * HBAR, 11n * USD, PRICE, params, 10n * USD).error).toMatch(/ceiling/);
  });

  it("deposit-only needs no price", () => {
    expect(previewBorrow(empty, 5n * HBAR, 0n, 0n, params, 0n).error).toBeNull();
  });
});

describe("previewRepay", () => {
  const vault = { collateral: 1_000n * HBAR, debt: 50n * USD };

  it("full repay unlocks everything even without a price", () => {
    const preview = previewRepay(vault, 50n * USD, 1_000n * HBAR, 0n, params);
    expect(preview.error).toBeNull();
    expect(preview.debt).toBe(0n);
    expect(preview.collateral).toBe(0n);
  });

  it("partial repay cannot leave dust", () => {
    expect(previewRepay(vault, 50n * USD - 1n, 0n, PRICE, params).error).toMatch(/below the minimum/);
  });

  it("withdraw with remaining debt needs a usable price and enough collateral", () => {
    expect(previewRepay(vault, 0n, 1n * HBAR, 0n, params).error).toMatch(/Oracle unavailable/);
    expect(previewRepay(vault, 0n, 250n * HBAR, PRICE, params).error).toBeNull();
    expect(previewRepay(vault, 0n, 250n * HBAR + 1n, PRICE, params).error).toMatch(/below the minimum/);
  });

  it("rejects amounts beyond the vault", () => {
    expect(previewRepay(vault, 51n * USD, 0n, PRICE, params).error).toMatch(/exceeds debt/);
    expect(previewRepay(vault, 0n, 1_001n * HBAR, PRICE, params).error).toMatch(/exceeds collateral/);
  });
});
