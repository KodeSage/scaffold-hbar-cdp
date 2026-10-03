"use client";

import type { ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { formatHbar, formatRatio, formatStable } from "~~/utils/cdp/format";
import { collateralRatioBps, collateralValue } from "~~/utils/cdp/math";
import { entityIdFromLongZero, hashscanContract, hashscanToken } from "~~/utils/cdp/mirrorNode";

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div className="flex flex-col">
    <span className="text-xs uppercase tracking-wide text-base-content/60">{label}</span>
    <span className="text-lg font-semibold font-mono">{value}</span>
    {hint && <span className="text-xs text-base-content/60">{hint}</span>}
  </div>
);

/** System-wide totals, risk parameters and links to the HTS token and engine on HashScan. */
export const ProtocolStats = ({ protocol, symbol }: { protocol: ProtocolSnapshot; symbol: string }) => {
  const { params, price, totalCollateral, totalDebt, debtCeiling } = protocol;
  const systemRatio = price.usable ? collateralRatioBps(totalCollateral, totalDebt, price.priceE18) : null;
  const ceilingUsedPct = debtCeiling > 0n ? Number((totalDebt * 10_000n) / debtCeiling) / 100 : 100;

  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-4">
        <div className="flex items-center justify-between">
          <h2 className="card-title text-base">Protocol</h2>
          {protocol.mintingPaused && <span className="badge badge-warning">Minting paused</span>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Collateral"
            value={`${formatHbar(totalCollateral, 2)} HBAR`}
            hint={price.usable ? `≈ $${formatStable(collateralValue(totalCollateral, price.priceE18))}` : undefined}
          />
          <Stat label={`${symbol} supply`} value={formatStable(totalDebt)} hint={`${protocol.vaultCount} vault(s)`} />
          <Stat label="System ratio" value={totalDebt === 0n ? "—" : formatRatio(systemRatio)} />
          <Stat label="Debt ceiling" value={formatStable(debtCeiling, 0)} hint={`${ceilingUsedPct.toFixed(2)}% used`} />
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="badge badge-ghost">Min ratio {formatRatio(params.minCollateralRatioBps)}</span>
          <span className="badge badge-ghost">Liquidation &lt; {formatRatio(params.liquidationRatioBps)}</span>
          <span className="badge badge-ghost">Bonus {formatRatio(params.liquidationBonusBps)}</span>
          <span className="badge badge-ghost">
            Min debt {formatStable(params.minDebt)} {symbol}
          </span>
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-base-content/60">
          {protocol.stablecoin !== "0x0000000000000000000000000000000000000000" ? (
            <a
              className="link"
              href={hashscanToken(protocol.chainId, protocol.stablecoin)}
              target="_blank"
              rel="noreferrer"
            >
              HTS token {entityIdFromLongZero(protocol.stablecoin)} ↗
            </a>
          ) : (
            <span>Stablecoin not created yet</span>
          )}
          <a
            className="link"
            href={hashscanContract(protocol.chainId, protocol.engine)}
            target="_blank"
            rel="noreferrer"
          >
            HbarCdpEngine ↗
          </a>
        </div>
      </div>
    </section>
  );
};
