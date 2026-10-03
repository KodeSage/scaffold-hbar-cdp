"use client";

import type { ReactNode } from "react";
import type { ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { useCdpContracts, useProtocol } from "~~/hooks/cdp/useCdp";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="card bg-base-100 border border-base-300 shadow-sm max-w-2xl mx-auto">
    <div className="card-body">
      <h2 className="card-title">{title}</h2>
      <div className="text-sm text-base-content/80 flex flex-col gap-2">{children}</div>
    </div>
  </div>
);

/** Shown in place of vault actions until the owner has created the HTS token. */
export const StablecoinMissing = () => (
  <Panel title="Stablecoin not created yet">
    <p className="m-0">The engine is deployed but its HTS token does not exist. As the engine owner, run:</p>
    <pre className="bg-base-200 rounded-box p-3 m-0 overflow-x-auto">
      <code>
        cd packages/foundry{"\n"}RPC_URL=hedera_testnet ETH_KEYSTORE_ACCOUNT=&lt;keystore&gt; make create-stablecoin
      </code>
    </pre>
  </Panel>
);

/**
 * Renders `children` with a loaded protocol snapshot, or explains what is missing
 * (contracts not deployed on this network, RPC errors).
 */
export const CdpGate = ({ children }: { children: (protocol: ProtocolSnapshot) => ReactNode }) => {
  const { targetNetwork } = useTargetNetwork();
  const { engine, oracle, isLoading: contractsLoading } = useCdpContracts();
  const { data: protocol, error, isLoading } = useProtocol();

  if (contractsLoading || (engine && oracle && isLoading)) {
    return (
      <div className="grid gap-6 md:grid-cols-2" aria-busy>
        <div className="h-64 rounded-box bg-base-200 animate-pulse" />
        <div className="h-64 rounded-box bg-base-200 animate-pulse" />
      </div>
    );
  }

  if (!engine || !oracle) {
    return (
      <Panel title={`Not deployed on ${targetNetwork.name}`}>
        <p className="m-0">Deploy the oracle, engine and HTS stablecoin, then reload:</p>
        <pre className="bg-base-200 rounded-box p-3 m-0 overflow-x-auto">
          <code>yarn foundry:account:generate{"\n"}yarn foundry:deploy --network hedera_testnet</code>
        </pre>
      </Panel>
    );
  }

  if (error || !protocol) {
    return (
      <Panel title="Could not read the protocol">
        <p className="m-0">The JSON-RPC relay did not answer. Check your connection or RPC override and retry.</p>
        <p className="m-0 font-mono text-xs text-error">{error?.message}</p>
      </Panel>
    );
  }

  return <>{children(protocol)}</>;
};
