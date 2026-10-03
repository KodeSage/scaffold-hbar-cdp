import { HASHSCAN, HederaChainId, MIRROR_NODE, engineEventsAbi } from "./constants";
import { Address, Hex, decodeEventLog, pad, toEventSelector } from "viem";

/** Hedera entity id (0.0.x) for a long-zero EVM address, e.g. an HTS token. */
export const entityIdFromLongZero = (address: Address) => `0.0.${BigInt(address).toString()}`;

export const hashscanTx = (chainId: HederaChainId, hash: string) => `${HASHSCAN[chainId]}/transaction/${hash}`;
export const hashscanToken = (chainId: HederaChainId, token: Address) =>
  `${HASHSCAN[chainId]}/token/${entityIdFromLongZero(token)}`;
export const hashscanContract = (chainId: HederaChainId, address: Address) =>
  `${HASHSCAN[chainId]}/contract/${address}`;

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Mirror node ${response.status} for ${url}`);
  return (await response.json()) as T;
}

export type TokenReadiness =
  /** Account does not exist on Hedera yet (fund it first: the first HBAR transfer creates it). */
  | "no-account"
  /** Associated, or auto-association will happen on the first transfer. */
  | "ready"
  /** Must call `associate()` on the token before it can receive it. */
  | "needs-association";

/**
 * Whether `account` can receive `token`. HTS rejects transfers to accounts that are neither associated
 * nor have a free automatic-association slot (HIP-904: -1 = unlimited, the default for EVM-created accounts).
 */
export async function getTokenReadiness(chainId: HederaChainId, account: Address, token: Address) {
  const base = MIRROR_NODE[chainId];
  const info = await getJson<{ max_automatic_token_associations: number }>(`${base}/api/v1/accounts/${account}`);
  if (!info) return "no-account" satisfies TokenReadiness;

  const relationship = await getJson<{ tokens: unknown[] }>(
    `${base}/api/v1/accounts/${account}/tokens?token.id=${entityIdFromLongZero(token)}`,
  );
  if ((relationship?.tokens.length ?? 0) > 0) return "ready" satisfies TokenReadiness;
  // Unlimited auto-associations; for a positive limit the mirror node does not expose free slots,
  // so we conservatively ask for an explicit association.
  return info.max_automatic_token_associations === -1
    ? ("ready" satisfies TokenReadiness)
    : ("needs-association" satisfies TokenReadiness);
}

type MirrorLog = { data: Hex; topics: Hex[]; transaction_hash: Hex; timestamp: string };

export type ActivityItem = {
  event: (typeof engineEventsAbi)[number]["name"];
  args: Record<string, unknown>;
  transactionHash: Hex;
  /** Consensus timestamp, seconds since epoch. */
  timestamp: number;
};

/**
 * The mirror node only accepts topic filters together with a timestamp range shorter than 7 days.
 * We query the most recent window, leaving a minute of margin.
 */
export const ACTIVITY_WINDOW_SECONDS = 7 * 24 * 60 * 60 - 60;

/**
 * Engine events that mention `owner` (as vault owner or liquidator) in the last ~7 days, newest first.
 * Uses topic filters so the query stays cheap regardless of protocol activity.
 */
export async function getVaultActivity(chainId: HederaChainId, engine: Address, owner: Address, limit = 25) {
  const base = MIRROR_NODE[chainId];
  const ownerTopic = pad(owner.toLowerCase() as Hex, { size: 32 });
  const now = Math.floor(Date.now() / 1000);
  const range = `timestamp=gte:${now - ACTIVITY_WINDOW_SECONDS}&timestamp=lte:${now}`;
  const queries = [
    `topic1=${ownerTopic}`, // every event: indexed owner
    `topic0=${toEventSelector(engineEventsAbi[4])}&topic2=${ownerTopic}`, // Liquidated: indexed liquidator
  ];
  const pages = await Promise.all(
    queries.map(query =>
      getJson<{ logs: MirrorLog[] }>(
        `${base}/api/v1/contracts/${engine}/results/logs?${query}&${range}&order=desc&limit=${limit}`,
      ),
    ),
  );

  const items: ActivityItem[] = [];
  const seen = new Set<string>();
  for (const log of pages.flatMap(page => page?.logs ?? [])) {
    const key = `${log.transaction_hash}:${log.topics.join()}:${log.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const decoded = decodeEventLog({ abi: engineEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      items.push({
        event: decoded.eventName,
        args: decoded.args as Record<string, unknown>,
        transactionHash: log.transaction_hash,
        timestamp: Number(log.timestamp.split(".")[0]),
      });
    } catch {
      // VaultUpdated and admin events are not part of the feed.
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}
