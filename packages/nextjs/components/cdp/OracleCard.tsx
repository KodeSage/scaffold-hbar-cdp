"use client";

import type { FeedReading, ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { ORACLE_STATUS } from "~~/utils/cdp/constants";
import { formatAge, formatRatio, formatUsdPrice } from "~~/utils/cdp/format";
import { hashscanContract } from "~~/utils/cdp/mirrorNode";

const FeedRow = ({ name, feed, maxAge }: { name: string; feed: FeedReading; maxAge: bigint }) => (
  <div className="flex items-center justify-between gap-3 py-2 border-b border-base-300 last:border-0">
    <div className="flex items-center gap-2">
      <span className={`status ${feed.ok ? "status-success" : "status-error"}`} aria-hidden />
      <span className="font-medium">{name}</span>
    </div>
    <div className="text-right">
      <div className="font-mono">{feed.ok ? formatUsdPrice(feed.priceE18) : "—"}</div>
      <div className="text-xs text-base-content/60">
        {feed.updatedAt > 0n ? `updated ${formatAge(feed.updatedAt)}` : "no data"} · max {Number(maxAge) / 3600}h
      </div>
    </div>
  </div>
);

/** Live view of DualOracle: final status/price plus each underlying feed. */
export const OracleCard = ({ protocol }: { protocol: ProtocolSnapshot }) => {
  const status = ORACLE_STATUS[protocol.price.status] ?? ORACLE_STATUS[4];
  const { chainlink, supra, oracleConfig } = protocol;
  // Same measure DualOracle uses: |a - b| in bps of the lower price.
  const [lo, hi] =
    chainlink.priceE18 < supra.priceE18 ? [chainlink.priceE18, supra.priceE18] : [supra.priceE18, chainlink.priceE18];
  const spreadBps = chainlink.ok && supra.ok && lo > 0n ? ((hi - lo) * 10_000n) / lo : null;

  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-3">
        <div className="flex items-center justify-between">
          <h2 className="card-title text-base">HBAR / USD oracle</h2>
          <span className={`badge ${status.badge}`}>{status.label}</span>
        </div>
        <div>
          <div className="text-3xl font-bold font-mono">
            {protocol.price.usable ? formatUsdPrice(protocol.price.priceE18) : "No price"}
          </div>
          <p className="text-sm text-base-content/70 m-0 mt-1">{status.detail}</p>
        </div>
        <div>
          <FeedRow name="Chainlink (primary)" feed={chainlink} maxAge={oracleConfig.chainlinkMaxAge} />
          <FeedRow name="Supra (cross-check)" feed={supra} maxAge={oracleConfig.supraMaxAge} />
        </div>
        <div className="flex items-center justify-between text-xs text-base-content/60">
          <span>
            Spread {spreadBps === null ? "—" : formatRatio(spreadBps)} · freeze above{" "}
            {formatRatio(oracleConfig.maxDeviationBps)}
          </span>
          <a
            className="link"
            href={hashscanContract(protocol.chainId, protocol.oracle)}
            target="_blank"
            rel="noreferrer"
          >
            DualOracle ↗
          </a>
        </div>
      </div>
    </section>
  );
};
