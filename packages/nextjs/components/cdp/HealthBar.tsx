import type { RiskParams } from "~~/utils/cdp/math";

/**
 * Collateral-ratio gauge from 100% to 2× the minimum ratio, with markers at the liquidation and
 * minimum ratios. Colour: red = liquidatable, amber = between thresholds, green = safe.
 */
export const HealthBar = ({ ratioBps, params }: { ratioBps: bigint | null; params: RiskParams }) => {
  const min = 10_000;
  const max = Number(params.minCollateralRatioBps) * 2;
  const toPct = (bps: number) => Math.min(100, Math.max(0, ((bps - min) / (max - min)) * 100));

  const value = ratioBps === null ? max : Number(ratioBps);
  const tone =
    ratioBps === null || ratioBps >= params.minCollateralRatioBps
      ? "bg-success"
      : ratioBps >= params.liquidationRatioBps
        ? "bg-warning"
        : "bg-error";

  return (
    <div className="w-full" role="meter" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}>
      <div className="relative h-3 rounded-full bg-base-300 overflow-hidden">
        <div className={`h-full ${tone} transition-all duration-500`} style={{ width: `${toPct(value)}%` }} />
        <div
          className="absolute top-0 h-full w-0.5 bg-error"
          style={{ left: `${toPct(Number(params.liquidationRatioBps))}%` }}
          title="Liquidation ratio"
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-base-content/60"
          style={{ left: `${toPct(Number(params.minCollateralRatioBps))}%` }}
          title="Minimum ratio"
        />
      </div>
    </div>
  );
};
