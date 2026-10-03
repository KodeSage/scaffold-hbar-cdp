"use client";

import { HealthBar } from "./HealthBar";
import type { AccountSnapshot, ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { formatHbar, formatRatio, formatStable, formatUsdPrice } from "~~/utils/cdp/format";
import {
  collateralRatioBps,
  collateralValue,
  isLiquidatable,
  liquidationPrice,
  maxMintable,
  maxWithdrawable,
} from "~~/utils/cdp/math";

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-4 py-1.5 text-sm">
    <span className="text-base-content/70">{label}</span>
    <span className="font-mono">{value}</span>
  </div>
);

/** The connected account's vault, computed with the same math the engine enforces. */
export const VaultSummary = ({
  protocol,
  account,
  symbol,
}: {
  protocol: ProtocolSnapshot;
  account: AccountSnapshot;
  symbol: string;
}) => {
  const { collateral, debt } = account;
  const { params, price } = protocol;
  const ratio = price.usable ? collateralRatioBps(collateral, debt, price.priceE18) : null;
  const liqPrice = liquidationPrice(collateral, debt, params.liquidationRatioBps);
  const liquidatable = price.usable && isLiquidatable(collateral, debt, price.priceE18, params.liquidationRatioBps);

  if (collateral === 0n && debt === 0n) {
    return (
      <section className="card bg-base-100 border border-base-300 shadow-sm">
        <div className="card-body">
          <h2 className="card-title text-base">Your vault</h2>
          <p className="text-sm text-base-content/70 m-0">
            No vault yet. Deposit HBAR and mint {symbol} to open one. Minting requires a collateral ratio of at least{" "}
            {formatRatio(params.minCollateralRatioBps)}.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-3">
        <div className="flex items-center justify-between">
          <h2 className="card-title text-base">Your vault</h2>
          {liquidatable ? (
            <span className="badge badge-error">Liquidatable</span>
          ) : debt > 0n ? (
            <span className="badge badge-success">Healthy</span>
          ) : (
            <span className="badge badge-ghost">No debt</span>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-base-content/70">Collateral ratio</span>
            <span className="text-2xl font-bold font-mono">
              {debt === 0n ? "∞" : price.usable ? formatRatio(ratio) : "—"}
            </span>
          </div>
          <HealthBar ratioBps={debt === 0n ? null : ratio} params={params} />
        </div>
        <div className="divide-y divide-base-300">
          <Row
            label="Collateral"
            value={`${formatHbar(collateral)} HBAR${price.usable ? ` ($${formatStable(collateralValue(collateral, price.priceE18))})` : ""}`}
          />
          <Row label="Debt" value={`${formatStable(debt)} ${symbol}`} />
          <Row label="Liquidation price" value={liqPrice === null ? "—" : `${formatUsdPrice(liqPrice)} / HBAR`} />
          <Row
            label="Can still mint"
            value={
              price.usable
                ? `${formatStable(maxMintable(collateral, debt, price.priceE18, params.minCollateralRatioBps))} ${symbol}`
                : "—"
            }
          />
          <Row
            label="Can withdraw"
            value={
              debt === 0n || price.usable
                ? `${formatHbar(maxWithdrawable(collateral, debt, price.priceE18, params.minCollateralRatioBps))} HBAR`
                : "—"
            }
          />
        </div>
        <div className="text-xs text-base-content/60">
          Wallet: {formatHbar(account.hbarBalance, 2)} HBAR · {formatStable(account.stableBalance)} {symbol}
        </div>
      </div>
    </section>
  );
};
