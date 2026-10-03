"use client";

import type { NextPage } from "next";
import { useAccount } from "wagmi";
import { ActivityFeed } from "~~/components/cdp/ActivityFeed";
import { CdpGate, StablecoinMissing } from "~~/components/cdp/CdpGate";
import { OracleCard } from "~~/components/cdp/OracleCard";
import { ProtocolStats } from "~~/components/cdp/ProtocolStats";
import { TokenSetupNotice } from "~~/components/cdp/TokenSetupNotice";
import { VaultActions } from "~~/components/cdp/VaultActions";
import { VaultSummary } from "~~/components/cdp/VaultSummary";
import { ProtocolSnapshot, useAccountState } from "~~/hooks/cdp/useCdp";

const AccountSection = ({ protocol }: { protocol: ProtocolSnapshot }) => {
  const { address } = useAccount();
  const { data: account, isLoading } = useAccountState(address, protocol);

  if (!address) {
    return (
      <div className="card bg-base-100 border border-base-300 shadow-sm">
        <div className="card-body items-center text-center">
          <h2 className="card-title">Connect a wallet to open a vault</h2>
          <p className="text-sm text-base-content/70 m-0">
            Lock HBAR, mint {protocol.symbol} against it, repay any time. Use MetaMask on Hedera Testnet or the burner
            wallet (fund it from the faucet first).
          </p>
        </div>
      </div>
    );
  }
  if (isLoading || !account) return <div className="h-72 rounded-box bg-base-200 animate-pulse" />;

  return (
    <div className="flex flex-col gap-6">
      <TokenSetupNotice protocol={protocol} account={account} symbol={protocol.symbol} />
      <div className="grid gap-6 lg:grid-cols-2">
        <VaultSummary protocol={protocol} account={account} symbol={protocol.symbol} />
        <VaultActions protocol={protocol} account={account} symbol={protocol.symbol} />
      </div>
      <ActivityFeed protocol={protocol} account={address} symbol={protocol.symbol} />
    </div>
  );
};

const Home: NextPage = () => (
  <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-6">
    <header className="flex flex-col gap-1">
      <h1 className="text-3xl font-bold m-0">HBAR-backed stablecoin</h1>
      <p className="text-base-content/70 m-0">
        Collateralised debt positions on Hedera: an HTS stablecoin minted against HBAR, priced by Chainlink and
        cross-checked by Supra.
      </p>
    </header>
    <CdpGate>
      {protocol => (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <OracleCard protocol={protocol} />
            <ProtocolStats protocol={protocol} symbol={protocol.symbol || "stablecoin"} />
          </div>
          {protocol.symbol ? <AccountSection protocol={protocol} /> : <StablecoinMissing />}
        </>
      )}
    </CdpGate>
  </div>
);

export default Home;
