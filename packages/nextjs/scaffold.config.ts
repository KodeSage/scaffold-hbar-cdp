import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly [chains.Chain, ...chains.Chain[]];
  pollingInterval: number;
  rpcOverrides?: Record<number, string>;
  enableBurnerWallet: boolean;
  walletConnectProjectId: string;
};

// HTS and the Chainlink/Supra feeds only exist on Hedera networks; testnet is the default target.
// Add `chains.hedera` after deploying to mainnet (see README "Going to mainnet").
const targetNetworks = [chains.hederaTestnet] as const satisfies readonly [chains.Chain, ...chains.Chain[]];

const scaffoldConfig = {
  targetNetworks,

  pollingInterval: 10000,

  enableBurnerWallet: true,

  rpcOverrides: {
    [chains.hedera.id]: process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api",
    [chains.hederaTestnet.id]: process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api",
  },

  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
