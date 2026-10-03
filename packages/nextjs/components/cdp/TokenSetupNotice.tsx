"use client";

import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import type { AccountSnapshot, ProtocolSnapshot } from "~~/hooks/cdp/useCdp";
import { useCdpActions } from "~~/hooks/cdp/useCdpActions";
import { entityIdFromLongZero } from "~~/utils/cdp/mirrorNode";

/**
 * Hedera-specific account setup the user may need before minting:
 * - the account must exist on Hedera (an EVM address becomes an account on its first HBAR receipt), and
 * - the account must be associated with the HTS token unless it has free auto-association slots (HIP-904).
 */
export const TokenSetupNotice = ({
  protocol,
  account,
  symbol,
}: {
  protocol: ProtocolSnapshot;
  account: AccountSnapshot;
  symbol: string;
}) => {
  const { associate, pending } = useCdpActions();

  if (account.readiness === "no-account") {
    return (
      <div role="alert" className="alert alert-info">
        <div>
          <p className="font-semibold m-0">This address is not a Hedera account yet</p>
          <p className="text-sm m-0">
            Send it testnet HBAR from the faucet; the first transfer creates the account (HIP-583).
          </p>
        </div>
        <HederaPortalFaucet variant="button" />
      </div>
    );
  }

  if (account.readiness === "needs-association") {
    return (
      <div role="alert" className="alert alert-warning">
        <div>
          <p className="font-semibold m-0">
            Associate {symbol} ({entityIdFromLongZero(protocol.stablecoin)}) to receive it
          </p>
          <p className="text-sm m-0">
            Your account has no free automatic token associations, so HTS would reject the mint. One transaction calls
            the token&apos;s HIP-719 <code>associate()</code> function.
          </p>
        </div>
        <button className="btn btn-sm" disabled={pending !== null} onClick={() => associate(protocol.stablecoin)}>
          {pending === "associate" ? <span className="loading loading-spinner loading-sm" /> : `Associate ${symbol}`}
        </button>
      </div>
    );
  }

  return null;
};
