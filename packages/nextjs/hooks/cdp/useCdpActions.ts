import { useState } from "react";
import { Address } from "viem";
import { useWriteContract } from "wagmi";
import { useRefreshCdp } from "~~/hooks/cdp/useCdp";
import { useScaffoldWriteContract, useTargetNetwork, useTransactor } from "~~/hooks/scaffold-hbar";
import { htsTokenAbi } from "~~/utils/cdp/constants";
import { tinybarsToWeibars } from "~~/utils/cdp/math";

/**
 * Every state-changing call the UI makes. Engine calls go through `useScaffoldWriteContract`
 * (simulates first, so custom errors like `Undercollateralised` surface before signing);
 * token calls (approve / HIP-719 associate) use wagmi + the scaffold transactor for the same notifications.
 */
export function useCdpActions() {
  const refresh = useRefreshCdp();
  const { writeContractAsync: writeEngine } = useScaffoldWriteContract({ contractName: "HbarCdpEngine" });
  const { writeContractAsync: writeToken } = useWriteContract();
  const transactor = useTransactor();
  // Pinning chainId makes wagmi reject the write if the wallet is on another network.
  const { targetNetwork } = useTargetNetwork();
  const chainId = targetNetwork.id;
  const [pending, setPending] = useState<string | null>(null);

  /** Resolves true only when a transaction hash came back (helpers return undefined when they bail out early). */
  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    try {
      return (await action()) !== undefined;
    } catch {
      // Notifications already explain the failure (rejected signature, revert reason, …).
      return false;
    } finally {
      setPending(null);
      await refresh();
    }
  };

  return {
    pending,

    /** Picks deposit / mint / depositAndMint so a zero amount never reaches the contract. */
    borrow: (depositTinybars: bigint, mintAmount: bigint) =>
      run("borrow", () => {
        // msg.value is sent in weibars over JSON-RPC; the relay converts it to tinybars for the EVM.
        const value = tinybarsToWeibars(depositTinybars);
        if (mintAmount === 0n) return writeEngine({ functionName: "deposit", value });
        if (depositTinybars === 0n) return writeEngine({ functionName: "mint", args: [mintAmount] });
        return writeEngine({ functionName: "depositAndMint", args: [mintAmount], value });
      }),

    repayAndWithdraw: (repayAmount: bigint, withdrawTinybars: bigint) =>
      run("repay", () => writeEngine({ functionName: "repayAndWithdraw", args: [repayAmount, withdrawTinybars] })),

    liquidate: (owner: Address, repayAmount: bigint) =>
      run(`liquidate:${owner}`, () => writeEngine({ functionName: "liquidate", args: [owner, repayAmount] })),

    /** HIP-376 allowance so the engine can pull stablecoins for repay/liquidate. */
    approve: (token: Address, spender: Address, amount: bigint) =>
      run("approve", () =>
        transactor(() =>
          writeToken({ chainId, address: token, abi: htsTokenAbi, functionName: "approve", args: [spender, amount] }),
        ),
      ),

    /** HIP-719: associate the caller's account with the HTS token so it can receive it. */
    associate: (token: Address) =>
      run("associate", () =>
        transactor(() => writeToken({ chainId, address: token, abi: htsTokenAbi, functionName: "associate" })),
      ),
  };
}
