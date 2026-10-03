import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Address, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";
import { useDeployedContractInfo, useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { HederaChainId, ORACLE_FROZEN, htsTokenAbi, isHederaChainId } from "~~/utils/cdp/constants";
import { RiskParams, WEIBARS_PER_TINYBAR } from "~~/utils/cdp/math";
import { TokenReadiness, getTokenReadiness } from "~~/utils/cdp/mirrorNode";

const POLL_MS = 10_000;
export const CDP_QUERY_KEY = "cdp";

export type FeedReading = { ok: boolean; priceE18: bigint; updatedAt: bigint };

export type ProtocolSnapshot = {
  chainId: HederaChainId;
  engine: Address;
  oracle: Address;
  /** Zero address until the deployer runs `make create-stablecoin`. */
  stablecoin: Address;
  /** Token symbol from the HTS token's ERC-20 facade ("" before the token exists). */
  symbol: string;
  params: RiskParams;
  debtCeiling: bigint;
  mintingPaused: boolean;
  totalCollateral: bigint;
  totalDebt: bigint;
  vaultCount: bigint;
  price: { priceE18: bigint; status: number; updatedAt: bigint; usable: boolean };
  chainlink: FeedReading;
  supra: FeedReading;
  oracleConfig: { maxDeviationBps: bigint; chainlinkMaxAge: bigint; supraMaxAge: bigint };
};

/** Engine + oracle contract info for the target network (undefined when not deployed there). */
export function useCdpContracts() {
  const { data: engine, isLoading: engineLoading } = useDeployedContractInfo({ contractName: "HbarCdpEngine" });
  const { data: oracle, isLoading: oracleLoading } = useDeployedContractInfo({ contractName: "DualOracle" });
  return { engine, oracle, isLoading: engineLoading || oracleLoading };
}

/** Protocol-wide state, refreshed every 10 s. All reads run in parallel (Hedera has no Multicall3 in viem). */
export function useProtocol() {
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { engine, oracle } = useCdpContracts();

  return useQuery({
    queryKey: [CDP_QUERY_KEY, "protocol", targetNetwork.id, engine?.address],
    enabled: Boolean(publicClient && engine && oracle && isHederaChainId(targetNetwork.id)),
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<ProtocolSnapshot> => {
      if (!publicClient || !engine || !oracle) throw new Error("Contracts not loaded");
      const e = { address: engine.address, abi: engine.abi } as const;
      const o = { address: oracle.address, abi: oracle.abi } as const;

      const [
        stablecoin,
        minCollateralRatioBps,
        liquidationRatioBps,
        liquidationBonusBps,
        minDebt,
        debtCeiling,
        mintingPaused,
        totalCollateral,
        totalDebt,
        vaultCount,
        latest,
        chainlink,
        supra,
        maxDeviationBps,
        chainlinkMaxAge,
        supraMaxAge,
      ] = await Promise.all([
        publicClient.readContract({ ...e, functionName: "stablecoin" }),
        publicClient.readContract({ ...e, functionName: "minCollateralRatioBps" }),
        publicClient.readContract({ ...e, functionName: "liquidationRatioBps" }),
        publicClient.readContract({ ...e, functionName: "liquidationBonusBps" }),
        publicClient.readContract({ ...e, functionName: "minDebt" }),
        publicClient.readContract({ ...e, functionName: "debtCeiling" }),
        publicClient.readContract({ ...e, functionName: "mintingPaused" }),
        publicClient.readContract({ ...e, functionName: "totalCollateral" }),
        publicClient.readContract({ ...e, functionName: "totalDebt" }),
        publicClient.readContract({ ...e, functionName: "vaultCount" }),
        publicClient.readContract({ ...o, functionName: "latestPrice" }),
        publicClient.readContract({ ...o, functionName: "readChainlink" }),
        publicClient.readContract({ ...o, functionName: "readSupra" }),
        publicClient.readContract({ ...o, functionName: "maxDeviationBps" }),
        publicClient.readContract({ ...o, functionName: "chainlinkMaxAge" }),
        publicClient.readContract({ ...o, functionName: "supraMaxAge" }),
      ]);

      const symbol =
        stablecoin === zeroAddress
          ? ""
          : await publicClient.readContract({ address: stablecoin, abi: htsTokenAbi, functionName: "symbol" });

      const [priceE18, status, updatedAt] = latest;
      return {
        chainId: targetNetwork.id as HederaChainId,
        engine: engine.address,
        oracle: oracle.address,
        stablecoin,
        symbol,
        params: { minCollateralRatioBps, liquidationRatioBps, liquidationBonusBps, minDebt },
        debtCeiling,
        mintingPaused,
        totalCollateral,
        totalDebt,
        vaultCount,
        price: { priceE18, status, updatedAt, usable: status < ORACLE_FROZEN && priceE18 > 0n },
        chainlink: { ok: chainlink[0], priceE18: chainlink[1], updatedAt: chainlink[2] },
        supra: { ok: supra[0], priceE18: supra[1], updatedAt: supra[2] },
        oracleConfig: { maxDeviationBps, chainlinkMaxAge, supraMaxAge },
      };
    },
  });
}

export type AccountSnapshot = {
  collateral: bigint;
  debt: bigint;
  /** Wallet HBAR in tinybars (eth_getBalance returns weibars; converted here). */
  hbarBalance: bigint;
  stableBalance: bigint;
  allowance: bigint;
  readiness: TokenReadiness;
};

/** The connected account's vault, balances, allowance and HTS association readiness. */
export function useAccountState(account: Address | undefined, protocol: ProtocolSnapshot | undefined) {
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient({ chainId: targetNetwork.id });
  const { engine } = useCdpContracts();

  return useQuery({
    queryKey: [CDP_QUERY_KEY, "account", targetNetwork.id, engine?.address, account, protocol?.stablecoin],
    enabled: Boolean(publicClient && engine && account && protocol),
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<AccountSnapshot> => {
      if (!publicClient || !engine || !account || !protocol) throw new Error("Not ready");
      const token = protocol.stablecoin;
      const hasToken = token !== zeroAddress;

      const [[collateral, debt], weibars, stableBalance, allowance, readiness] = await Promise.all([
        publicClient.readContract({
          address: engine.address,
          abi: engine.abi,
          functionName: "vaultOf",
          args: [account],
        }),
        publicClient.getBalance({ address: account }),
        hasToken
          ? publicClient.readContract({ address: token, abi: htsTokenAbi, functionName: "balanceOf", args: [account] })
          : Promise.resolve(0n),
        hasToken
          ? publicClient.readContract({
              address: token,
              abi: htsTokenAbi,
              functionName: "allowance",
              args: [account, engine.address],
            })
          : Promise.resolve(0n),
        hasToken ? getTokenReadiness(protocol.chainId, account, token) : Promise.resolve("ready" as TokenReadiness),
      ]);

      return { collateral, debt, hbarBalance: weibars / WEIBARS_PER_TINYBAR, stableBalance, allowance, readiness };
    },
  });
}

/** Refetch every CDP query, e.g. after a confirmed transaction. */
export function useRefreshCdp() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [CDP_QUERY_KEY] });
}
