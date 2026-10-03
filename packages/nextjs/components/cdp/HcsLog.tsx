"use client";

import { useQuery } from "@tanstack/react-query";
import type { ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { CDP_QUERY_KEY } from "~~/hooks/cdp/useCdp";
import { HCS_TOPIC_ID } from "~~/utils/cdp/constants";
import { formatAge, formatHbar, formatStable, formatUsdPrice } from "~~/utils/cdp/format";
import { HcsLogEntry, getHcsLog, hashscanTopic, hashscanTx } from "~~/utils/cdp/mirrorNode";

const short = (address: unknown) => `${String(address).slice(0, 6)}…${String(address).slice(-4)}`;

const describe = ({ type, args }: HcsLogEntry, symbol: string) => {
  const amount = BigInt((args.amount as string | undefined) ?? 0);
  switch (type) {
    case "Deposited":
      return `${short(args.owner)} deposited ${formatHbar(amount)} HBAR`;
    case "Withdrawn":
      return `${short(args.owner)} withdrew ${formatHbar(amount)} HBAR`;
    case "Minted":
      return `${short(args.owner)} minted ${formatStable(amount)} ${symbol}`;
    case "Repaid":
      return `${short(args.owner)} repaid ${formatStable(amount)} ${symbol}`;
    case "Liquidated":
      return `${short(args.liquidator)} liquidated ${short(args.owner)}: ${formatStable(BigInt(args.debtRepaid as string))} ${symbol} for ${formatHbar(BigInt(args.collateralSeized as string))} HBAR at ${formatUsdPrice(BigInt(args.priceE18 as string))}`;
    case "OracleStatus":
      return `Oracle ${args.previous ?? "first seen"} → ${args.status} at ${formatUsdPrice(BigInt(args.priceE18 as string))}`;
    case "StablecoinCreated":
      return `Stablecoin ${args.symbol} created`;
    case "DebtCeilingUpdated":
      return `Debt ceiling set to ${formatStable(BigInt(args.debtCeiling as string))} ${symbol}`;
    case "MintingPausedUpdated":
      return args.paused ? "Minting paused by owner" : "Minting resumed by owner";
    case "ExcessHbarSwept":
      return `Owner swept ${formatHbar(amount)} non-collateral HBAR`;
    default:
      return type;
  }
};

const isAlert = ({ type, args }: HcsLogEntry) =>
  type === "Liquidated" || (type === "OracleStatus" && (args.status === "Frozen" || args.status === "Unavailable"));

/**
 * Protocol history from the Hedera Consensus Service topic written by `yarn foundry:hcs`. Unlike contract logs,
 * it includes oracle status changes, which DualOracle computes in a view and never emits.
 */
export const HcsLog = ({ protocol }: { protocol: ProtocolSnapshot }) => {
  const topicId = HCS_TOPIC_ID[protocol.chainId];
  const { data, isLoading, error } = useQuery({
    queryKey: [CDP_QUERY_KEY, "hcs", protocol.chainId, topicId, protocol.engine],
    queryFn: () => getHcsLog(protocol.chainId, topicId as string, protocol.engine),
    enabled: Boolean(topicId),
    refetchInterval: 15_000,
  });
  if (!topicId) return null;

  return (
    <section className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="card-title text-base">Protocol log</h2>
          <a
            className="link text-xs text-base-content/60"
            href={hashscanTopic(protocol.chainId, topicId)}
            target="_blank"
            rel="noreferrer"
          >
            HCS topic {topicId} ↗
          </a>
        </div>
        {isLoading ? (
          <div className="h-16 rounded bg-base-200 animate-pulse" />
        ) : error || !data ? (
          <p className="text-sm text-error m-0">Could not load HCS topic {topicId} from the mirror node.</p>
        ) : !data.matchesEngine ? (
          <p className="text-sm text-warning m-0">
            Topic {topicId} logs a different engine. Run <code>yarn foundry:hcs</code> and update
            NEXT_PUBLIC_HCS_TOPIC_ID.
          </p>
        ) : !data.entries.length ? (
          <p className="text-sm text-base-content/60 m-0">
            No messages yet. Run <code>yarn foundry:hcs</code> to publish the protocol history.
          </p>
        ) : (
          <ul className="divide-y divide-base-300">
            {data.entries.map(entry => (
              <li key={entry.sequenceNumber} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className={isAlert(entry) ? "text-error" : undefined}>
                  <span className="font-mono text-xs text-base-content/50 mr-2">#{entry.sequenceNumber}</span>
                  {describe(entry, protocol.symbol || "stablecoin")}
                </span>
                {entry.transactionHash ? (
                  <a
                    className="link text-xs shrink-0"
                    href={hashscanTx(protocol.chainId, entry.transactionHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatAge(entry.timestamp)} ↗
                  </a>
                ) : (
                  <span className="text-xs shrink-0 text-base-content/60">{formatAge(entry.timestamp)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};
