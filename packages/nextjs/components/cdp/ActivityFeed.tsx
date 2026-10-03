"use client";

import { useQuery } from "@tanstack/react-query";
import { Address } from "viem";
import type { ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { CDP_QUERY_KEY } from "~~/hooks/cdp/useCdp";
import { formatAge, formatHbar, formatStable, formatUsdPrice } from "~~/utils/cdp/format";
import { ActivityItem, getVaultActivity, hashscanTx } from "~~/utils/cdp/mirrorNode";

const describe = (item: ActivityItem, account: Address, symbol: string) => {
  const a = item.args as Record<string, bigint | Address>;
  switch (item.event) {
    case "Deposited":
      return `Deposited ${formatHbar(a.amount as bigint)} HBAR`;
    case "Withdrawn":
      return `Withdrew ${formatHbar(a.amount as bigint)} HBAR`;
    case "Minted":
      return `Minted ${formatStable(a.amount as bigint)} ${symbol}`;
    case "Repaid":
      return `Repaid ${formatStable(a.amount as bigint)} ${symbol}`;
    case "Liquidated": {
      const asLiquidator = (a.liquidator as Address).toLowerCase() === account.toLowerCase();
      const detail = `${formatStable(a.debtRepaid as bigint)} ${symbol} for ${formatHbar(a.collateralSeized as bigint)} HBAR at ${formatUsdPrice(a.priceE18 as bigint)}`;
      return asLiquidator ? `Liquidated a vault: ${detail}` : `Your vault was liquidated: ${detail}`;
    }
  }
};

/** The account's engine events from the Hedera mirror node, each linked to HashScan. */
export const ActivityFeed = ({
  protocol,
  account,
  symbol,
}: {
  protocol: ProtocolSnapshot;
  account: Address;
  symbol: string;
}) => {
  const { data, isLoading, error } = useQuery({
    queryKey: [CDP_QUERY_KEY, "activity", protocol.chainId, protocol.engine, account],
    queryFn: () => getVaultActivity(protocol.chainId, protocol.engine, account),
    refetchInterval: 15_000,
  });

  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-2">
        <div className="flex items-center justify-between">
          <h2 className="card-title text-base">Activity</h2>
          <span className="text-xs text-base-content/60">Mirror node · last 7 days</span>
        </div>
        {isLoading ? (
          <div className="h-16 rounded bg-base-200 animate-pulse" />
        ) : error ? (
          <p className="text-sm text-error m-0">Could not load activity from the mirror node.</p>
        ) : !data?.length ? (
          <p className="text-sm text-base-content/60 m-0">
            No activity yet. Mirror node data lags consensus by a few seconds.
          </p>
        ) : (
          <ul className="divide-y divide-base-300">
            {data.map(item => (
              <li
                key={`${item.transactionHash}-${item.event}`}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span>{describe(item, account, symbol)}</span>
                <a
                  className="link text-xs shrink-0"
                  href={hashscanTx(protocol.chainId, item.transactionHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {formatAge(item.timestamp)} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
