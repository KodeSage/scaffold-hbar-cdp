import { erc20Abi, parseAbi } from "viem";

/** Mirrors IPriceOracle.Status (uint8). Every status below Frozen yields a usable price. */
export const ORACLE_STATUS = [
  {
    label: "Healthy",
    badge: "badge-success",
    detail: "Chainlink and Supra are fresh and agree within the deviation bound.",
  },
  {
    label: "Chainlink only",
    badge: "badge-warning",
    detail: "Supra is stale or unavailable; the Chainlink price is used without a cross-check.",
  },
  {
    label: "Supra only",
    badge: "badge-warning",
    detail: "Chainlink is stale or unavailable; the Supra price is used as a fallback.",
  },
  {
    label: "Frozen",
    badge: "badge-error",
    detail: "Both feeds are fresh but disagree. Minting, collateral withdrawals and liquidations are paused.",
  },
  {
    label: "Unavailable",
    badge: "badge-error",
    detail: "No fresh price. Deposits and repayments still work; debt-free vaults can still withdraw.",
  },
] as const;

export const ORACLE_FROZEN = 3;

/**
 * HTS fungible tokens expose an ERC-20 facade (HIP-218/376) plus HRC-719 association functions (HIP-719)
 * at their long-zero EVM address, so wallets can approve and associate with plain EVM transactions.
 */
export const htsTokenAbi = [...erc20Abi, ...parseAbi(["function associate() returns (uint256 responseCode)"])] as const;

/** Event ABIs used to decode mirror node logs for the activity feed. */
export const engineEventsAbi = parseAbi([
  "event Deposited(address indexed owner, uint256 amount)",
  "event Withdrawn(address indexed owner, uint256 amount)",
  "event Minted(address indexed owner, uint256 amount)",
  "event Repaid(address indexed owner, uint256 amount)",
  "event Liquidated(address indexed owner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized, uint256 priceE18)",
]);

/** Hedera's EVM gas price is fixed in tinybars; HashScan shows full fee breakdowns per transaction. */
export const HASHSCAN = {
  296: "https://hashscan.io/testnet",
  295: "https://hashscan.io/mainnet",
} as const;

export const MIRROR_NODE = {
  296: "https://testnet.mirrornode.hedera.com",
  295: "https://mainnet.mirrornode.hedera.com",
} as const;

export type HederaChainId = keyof typeof MIRROR_NODE;

export const isHederaChainId = (chainId: number): chainId is HederaChainId => chainId in MIRROR_NODE;
