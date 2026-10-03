"use client";

import { useState } from "react";
import { AmountInput } from "./AmountInput";
import { useQuery } from "@tanstack/react-query";
import { Address } from "viem";
import { usePublicClient } from "wagmi";
import { HederaAddress } from "~~/components/scaffold-hbar";
import type { AccountSnapshot, ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { CDP_QUERY_KEY, useCdpContracts } from "~~/hooks/cdp/useCdp";
import { useCdpActions } from "~~/hooks/cdp/useCdpActions";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { formatHbar, formatRatio, formatStable, parseStable, toInput } from "~~/utils/cdp/format";
import { STABLE_DECIMALS, collateralRatioBps, isLiquidatable, liquidationSeize } from "~~/utils/cdp/math";

const PAGE_SIZE = 100n;

type VaultRow = { owner: Address; collateral: bigint; debt: bigint };

/** All vaults with debt, paged through `getVaults` (on-chain enumeration, no indexer needed). */
function useAllVaults(protocol: ProtocolSnapshot) {
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { engine } = useCdpContracts();

  return useQuery({
    queryKey: [CDP_QUERY_KEY, "vaults", protocol.chainId, protocol.engine, protocol.vaultCount.toString()],
    enabled: Boolean(publicClient && engine),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!publicClient || !engine) return [];
      const rows: VaultRow[] = [];
      for (let offset = 0n; offset < protocol.vaultCount; offset += PAGE_SIZE) {
        const page = await publicClient.readContract({
          address: engine.address,
          abi: engine.abi,
          functionName: "getVaults",
          args: [offset, PAGE_SIZE],
        });
        rows.push(...page.map(v => ({ owner: v.owner, collateral: v.collateral, debt: v.debt })));
      }
      return rows.filter(row => row.debt > 0n);
    },
  });
}

const LiquidateForm = ({
  vault,
  protocol,
  account,
  symbol,
}: {
  vault: VaultRow;
  protocol: ProtocolSnapshot;
  account: AccountSnapshot | undefined;
  symbol: string;
}) => {
  const { liquidate, approve, pending } = useCdpActions();
  const [input, setInput] = useState("");
  const repay = parseStable(input);
  const { params, price } = protocol;

  const balance = account?.stableBalance ?? 0n;
  const maxRepay = vault.debt < balance ? vault.debt : balance;
  const remaining = vault.debt - (repay.value <= vault.debt ? repay.value : vault.debt);
  const seized = price.usable
    ? liquidationSeize(repay.value, price.priceE18, params.liquidationBonusBps, vault.collateral)
    : 0n;
  const needsApproval = repay.value > 0n && (account?.allowance ?? 0n) < repay.value;

  let blocker = repay.error;
  if (!blocker && repay.value === 0n) blocker = "Enter an amount";
  if (!blocker && !account) blocker = "Connect a wallet";
  if (!blocker && repay.value > vault.debt) blocker = "Exceeds the vault's debt";
  if (!blocker && repay.value > balance) blocker = `Not enough ${symbol}`;
  if (!blocker && remaining !== 0n && remaining < params.minDebt) {
    blocker = `Leave 0 or at least ${formatStable(params.minDebt)} ${symbol} of debt`;
  }

  return (
    <form
      className="flex flex-col gap-2 min-w-64"
      onSubmit={async event => {
        event.preventDefault();
        if (needsApproval) await approve(protocol.stablecoin, protocol.engine, repay.value);
        else if (await liquidate(vault.owner, repay.value)) setInput("");
      }}
    >
      <AmountInput
        label="Repay"
        unit={symbol}
        value={input}
        onChange={setInput}
        error={repay.error}
        hint={`Wallet: ${formatStable(balance)}`}
        onMax={() => setInput(toInput(maxRepay, STABLE_DECIMALS))}
      />
      {repay.value > 0n && !blocker && (
        <p className="text-xs text-base-content/70 m-0">
          You receive ≈ {formatHbar(seized)} HBAR (includes {formatRatio(params.liquidationBonusBps)} bonus)
        </p>
      )}
      {blocker && input !== "" && <p className="text-xs text-error m-0">{blocker}</p>}
      <button type="submit" className="btn btn-error btn-sm" disabled={Boolean(blocker) || pending !== null}>
        {pending ? (
          <span className="loading loading-spinner loading-xs" />
        ) : needsApproval ? (
          `Approve ${symbol}`
        ) : (
          "Liquidate"
        )}
      </button>
    </form>
  );
};

/** Every open vault sorted by collateral ratio, with an inline liquidation form for unsafe ones. */
export const LiquidationsTable = ({
  protocol,
  account,
  symbol,
}: {
  protocol: ProtocolSnapshot;
  account: AccountSnapshot | undefined;
  symbol: string;
}) => {
  const { targetNetwork } = useTargetNetwork();
  const { data: vaults, isLoading } = useAllVaults(protocol);
  const { params, price } = protocol;

  const rows = (vaults ?? [])
    .map(vault => ({
      ...vault,
      ratio: price.usable ? collateralRatioBps(vault.collateral, vault.debt, price.priceE18) : null,
      liquidatable:
        price.usable && isLiquidatable(vault.collateral, vault.debt, price.priceE18, params.liquidationRatioBps),
    }))
    .sort((a, b) => (a.ratio === null || b.ratio === null ? 0 : a.ratio < b.ratio ? -1 : a.ratio > b.ratio ? 1 : 0));

  if (isLoading) return <div className="h-32 rounded-box bg-base-200 animate-pulse" />;
  if (!rows.length) return <p className="text-base-content/60">No open vaults with debt.</p>;

  return (
    <div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
      <table className="table">
        <thead>
          <tr>
            <th>Owner</th>
            <th className="text-right">Collateral</th>
            <th className="text-right">Debt</th>
            <th className="text-right">Ratio</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.owner} className={row.liquidatable ? "bg-error/5" : undefined}>
              <td>
                <HederaAddress address={row.owner} chain={targetNetwork} />
              </td>
              <td className="text-right font-mono">{formatHbar(row.collateral, 2)} HBAR</td>
              <td className="text-right font-mono">
                {formatStable(row.debt)} {symbol}
              </td>
              <td className="text-right font-mono">
                {row.ratio === null ? "—" : formatRatio(row.ratio)}
                {row.liquidatable && <span className="badge badge-error badge-sm ml-2">unsafe</span>}
              </td>
              <td className="text-right">
                {row.liquidatable ? (
                  <LiquidateForm vault={row} protocol={protocol} account={account} symbol={symbol} />
                ) : (
                  <span className="text-xs text-base-content/50">safe</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
