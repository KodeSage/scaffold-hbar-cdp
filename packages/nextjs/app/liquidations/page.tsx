"use client";

import type { NextPage } from "next";
import { useAccount } from "wagmi";
import { CdpGate, StablecoinMissing } from "~~/components/cdp/CdpGate";
import { LiquidationsTable } from "~~/components/cdp/LiquidationsTable";
import { OracleCard } from "~~/components/cdp/OracleCard";
import { ProtocolSnapshot, useAccountState } from "~~/hooks/cdp/useCdp";
import { formatRatio } from "~~/utils/cdp/format";

const Board = ({ protocol }: { protocol: ProtocolSnapshot }) => {
  const { address } = useAccount();
  const { data: account } = useAccountState(address, protocol);
  return <LiquidationsTable protocol={protocol} account={account} symbol={protocol.symbol} />;
};

const Liquidations: NextPage = () => (
  <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-6">
    <CdpGate>
      {protocol => (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-3xl font-bold m-0">Liquidations</h1>
            <p className="text-base-content/70 m-0">
              Vaults below {formatRatio(protocol.params.liquidationRatioBps)} can be liquidated by anyone: repay part or
              all of the debt in {protocol.symbol || "stablecoin"} and receive the same value in HBAR plus a{" "}
              {formatRatio(protocol.params.liquidationBonusBps)} bonus. Liquidations pause while the oracle is frozen.
            </p>
          </header>
          <div className="max-w-xl">
            <OracleCard protocol={protocol} />
          </div>
          {protocol.symbol ? <Board protocol={protocol} /> : <StablecoinMissing />}
        </>
      )}
    </CdpGate>
  </div>
);

export default Liquidations;
