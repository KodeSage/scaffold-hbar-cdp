/**
 * Exact bigint mirror of HbarCdpEngine's math, so UI previews agree with on-chain checks to the last unit.
 *
 * Units (same as the contract):
 * - collateral: tinybars (1 HBAR = 1e8). Note: JSON-RPC `value` and `eth_getBalance` use weibars (1e18).
 * - debt / stablecoin amounts: 6-decimal base units.
 * - prices: USD per HBAR with 18 decimals (priceE18).
 */

export const BPS = 10_000n;
/** tinybars * priceE18 / VALUE_SCALE = stable units (1e8 * 1e18 / 1e6). */
export const VALUE_SCALE = 10n ** 20n;
/** VALUE_SCALE / BPS. */
export const RATIO_SCALE = 10n ** 16n;
export const TINYBAR_DECIMALS = 8;
export const WEIBAR_DECIMALS = 18;
export const STABLE_DECIMALS = 6;
export const WEIBARS_PER_TINYBAR = 10n ** 10n;

export type RiskParams = {
  minCollateralRatioBps: bigint;
  liquidationRatioBps: bigint;
  liquidationBonusBps: bigint;
  minDebt: bigint;
};

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const max0 = (a: bigint) => (a > 0n ? a : 0n);

/** Tinybars needed to back `debt` at `ratioBps` (rounded up, like Math.Rounding.Ceil). */
export function requiredCollateral(debt: bigint, priceE18: bigint, ratioBps: bigint): bigint {
  if (debt === 0n) return 0n;
  return ceilDiv(debt * ratioBps * VALUE_SCALE, priceE18 * BPS);
}

/** Stable-unit value of `collateral` tinybars (rounded down). */
export function collateralValue(collateral: bigint, priceE18: bigint): bigint {
  return (collateral * priceE18) / VALUE_SCALE;
}

/** Collateral ratio in bps, or `null` (infinite) when there is no debt. */
export function collateralRatioBps(collateral: bigint, debt: bigint, priceE18: bigint): bigint | null {
  if (debt === 0n) return null;
  return (collateral * priceE18) / (debt * RATIO_SCALE);
}

export function maxMintable(collateral: bigint, debt: bigint, priceE18: bigint, minCollateralRatioBps: bigint): bigint {
  return max0((collateral * priceE18) / (minCollateralRatioBps * RATIO_SCALE) - debt);
}

export function maxWithdrawable(
  collateral: bigint,
  debt: bigint,
  priceE18: bigint,
  minCollateralRatioBps: bigint,
): bigint {
  if (debt === 0n) return collateral;
  return max0(collateral - requiredCollateral(debt, priceE18, minCollateralRatioBps));
}

/** Same predicate as the contract: collateral < requiredCollateral(debt, price, liquidationRatio). */
export function isLiquidatable(collateral: bigint, debt: bigint, priceE18: bigint, liquidationRatioBps: bigint) {
  return debt > 0n && collateral < requiredCollateral(debt, priceE18, liquidationRatioBps);
}

/**
 * Price (priceE18) below which the vault becomes liquidatable, or `null` without debt or collateral.
 * Liquidatable iff collateral * price < debt * liquidationRatio * RATIO_SCALE.
 */
export function liquidationPrice(collateral: bigint, debt: bigint, liquidationRatioBps: bigint): bigint | null {
  if (debt === 0n || collateral === 0n) return null;
  return ceilDiv(debt * liquidationRatioBps * RATIO_SCALE, collateral);
}

/** Collateral (tinybars) a liquidator receives for repaying `repayAmount`, capped at the vault's collateral. */
export function liquidationSeize(
  repayAmount: bigint,
  priceE18: bigint,
  liquidationBonusBps: bigint,
  vaultCollateral: bigint,
): bigint {
  const seized = (repayAmount * (BPS + liquidationBonusBps) * VALUE_SCALE) / (priceE18 * BPS);
  return seized > vaultCollateral ? vaultCollateral : seized;
}

export type VaultState = { collateral: bigint; debt: bigint };

export type Preview = VaultState & {
  collateralRatioBps: bigint | null;
  liquidationPrice: bigint | null;
  /** Human-readable reason the contract would reject this change, or null if it would succeed. */
  error: string | null;
};

const finishPreview = (state: VaultState, priceE18: bigint, params: RiskParams, error: string | null): Preview => ({
  ...state,
  collateralRatioBps: collateralRatioBps(state.collateral, state.debt, priceE18),
  liquidationPrice: liquidationPrice(state.collateral, state.debt, params.liquidationRatioBps),
  error,
});

/** Mirrors depositAndMint / deposit / mint validation. */
export function previewBorrow(
  vault: VaultState,
  depositTinybars: bigint,
  mintAmount: bigint,
  priceE18: bigint,
  params: RiskParams,
  availableDebt: bigint,
): Preview {
  const next = { collateral: vault.collateral + depositTinybars, debt: vault.debt + mintAmount };
  let error: string | null = null;
  if (depositTinybars === 0n && mintAmount === 0n) error = "Enter an amount";
  else if (mintAmount > 0n && next.debt < params.minDebt) error = "Debt would be below the minimum";
  else if (mintAmount > availableDebt) error = "Exceeds the protocol debt ceiling";
  else if (mintAmount > 0n && next.collateral < requiredCollateral(next.debt, priceE18, params.minCollateralRatioBps)) {
    error = "Collateral ratio would fall below the minimum";
  }
  return finishPreview(next, priceE18, params, error);
}

/** Mirrors repayAndWithdraw validation. `priceE18` may be 0n when the oracle is unusable. */
export function previewRepay(
  vault: VaultState,
  repayAmount: bigint,
  withdrawTinybars: bigint,
  priceE18: bigint,
  params: RiskParams,
): Preview {
  let error: string | null = null;
  const next = { collateral: vault.collateral, debt: vault.debt };
  if (repayAmount === 0n && withdrawTinybars === 0n) error = "Enter an amount";
  else if (repayAmount > vault.debt) error = "Repay exceeds debt";
  else if (withdrawTinybars > vault.collateral) error = "Withdraw exceeds collateral";
  else {
    next.debt = vault.debt - repayAmount;
    next.collateral = vault.collateral - withdrawTinybars;
    if (next.debt !== 0n && next.debt < params.minDebt) error = "Remaining debt would be below the minimum";
    else if (withdrawTinybars > 0n && next.debt > 0n) {
      if (priceE18 === 0n) error = "Oracle unavailable: repay all debt to withdraw";
      else if (next.collateral < requiredCollateral(next.debt, priceE18, params.minCollateralRatioBps)) {
        error = "Collateral ratio would fall below the minimum";
      }
    }
  }
  return finishPreview(next, priceE18, params, error);
}

/** weibars (JSON-RPC value) for a tinybar amount. */
export const tinybarsToWeibars = (tinybars: bigint) => tinybars * WEIBARS_PER_TINYBAR;
