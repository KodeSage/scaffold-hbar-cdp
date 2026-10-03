// Publishes the protocol's history to a Hedera Consensus Service (HCS) topic:
//   - every HbarCdpEngine event (deposit, withdraw, mint, repay, liquidation, admin changes), read from the mirror node
//   - every DualOracle status change (Ok -> Frozen -> ...). The oracle computes its status in a view function and
//     emits nothing, so this topic is the only ordered, timestamped record of when the protocol stopped taking risk.
//
// Contracts cannot submit HCS messages (there is no HCS system contract), so this runs off-chain with the Hedera SDK.
// The topic's submit key is the relayer's key: anyone can read it, only the relayer can write to it.
// Each message costs ~$0.0001; the first run backfills the engine's full history.
//
// Usage: yarn foundry:hcs                (catch up once, then exit)
//        yarn foundry:hcs -- --watch     (keep relaying every 15s)
//        optional: --keystore <name> --network hedera_testnet
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ethers } from "ethers";
import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import {
  FOUNDRY_ROOT,
  NETWORKS,
  ORACLE_ABI,
  ORACLE_STATUS,
  getDeployment,
  getProvider,
  loadKeystoreSigner,
  parseCliArgs,
  topicLink,
} from "./hedera.js";

const POLL_INTERVAL_MS = 15_000;
/** Bumped if the message shape changes, so readers can tell old messages from new ones. */
const MESSAGE_VERSION = 1;

const ENGINE_EVENTS = new ethers.utils.Interface([
  "event StablecoinCreated(address indexed token, string name, string symbol)",
  "event Deposited(address indexed owner, uint256 amount)",
  "event Withdrawn(address indexed owner, uint256 amount)",
  "event Minted(address indexed owner, uint256 amount)",
  "event Repaid(address indexed owner, uint256 amount)",
  "event Liquidated(address indexed owner, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized, uint256 priceE18)",
  "event VaultUpdated(address indexed owner, uint256 collateral, uint256 debt)",
  "event DebtCeilingUpdated(uint256 debtCeiling)",
  "event MintingPausedUpdated(bool paused)",
  "event ExcessHbarSwept(address indexed to, uint256 amount)",
]);
/** VaultUpdated repeats what the other events already say; skipping it halves the message count. */
const SKIPPED_EVENTS = new Set(["VaultUpdated"]);

const stateFile = (chainId) =>
  join(FOUNDRY_ROOT, "deployments", `${chainId}-hcs.json`);

function loadState(chainId, engine) {
  const file = stateFile(chainId);
  const saved = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf-8"))
    : null;
  // A new engine deployment gets a new topic: one topic = one engine's history.
  if (saved?.engine === engine) return saved;
  return {
    engine,
    topicId: null,
    cursor: { timestamp: "0", index: -1 },
    oracleStatus: null,
  };
}

function saveState(chainId, state) {
  mkdirSync(join(FOUNDRY_ROOT, "deployments"), { recursive: true });
  writeFileSync(stateFile(chainId), JSON.stringify(state, null, 2) + "\n");
}

/** Event args as JSON: named fields only, uint256 as decimal strings (stable units / tinybars / priceE18). */
function argsToJson(event) {
  return Object.fromEntries(
    event.eventFragment.inputs.map((input, i) => {
      const value = event.args[i];
      return [
        input.name,
        ethers.BigNumber.isBigNumber(value) ? value.toString() : value,
      ];
    })
  );
}

/** Engine logs after `cursor`, oldest first. Logs in one transaction share a timestamp, so the cursor keeps the index too. */
async function fetchEngineLogs(network, engine, cursor) {
  const { mirror } = NETWORKS[network];
  let url = `${mirror}/api/v1/contracts/${engine}/results/logs?timestamp=gte:${cursor.timestamp}&order=asc&limit=100`;
  const logs = [];
  while (url) {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(`Mirror node ${response.status} for ${url}`);
    const page = await response.json();
    logs.push(...page.logs);
    url = page.links?.next ? `${mirror}${page.links.next}` : null;
  }
  return logs.filter(
    (log) =>
      log.timestamp !== cursor.timestamp ||
      Number(log.index) > Number(cursor.index)
  );
}

/** The relayer's Hedera account id (0.0.x) and SDK key, derived from the Foundry keystore. */
async function sdkOperator(network, signer) {
  const response = await fetch(
    `${NETWORKS[network].mirror}/api/v1/accounts/${signer.address}`
  );
  if (response.status === 404) {
    throw new Error(
      `${signer.address} is not a Hedera account yet. Fund it at https://portal.hedera.com/faucet`
    );
  }
  if (!response.ok)
    throw new Error(`Mirror node ${response.status} for ${signer.address}`);
  const { account } = await response.json();
  const key = PrivateKey.fromStringECDSA(signer.privateKey.replace(/^0x/, ""));
  return { accountId: AccountId.fromString(account), key };
}

async function createTopic(client, key, engine) {
  const receipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo(`HbarCdpEngine ${engine} event log`)
      .setSubmitKey(key.publicKey)
      .execute(client)
  ).getReceipt(client);
  return receipt.topicId.toString();
}

async function publish(client, topicId, message) {
  const receipt = await (
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify({ v: MESSAGE_VERSION, ...message }))
      .execute(client)
  ).getReceipt(client);
  return receipt.topicSequenceNumber.toString();
}

async function relayOnce({ network, chainId, client, oracle, state }) {
  let published = 0;

  for (const log of await fetchEngineLogs(
    network,
    state.engine,
    state.cursor
  )) {
    let event;
    try {
      event = ENGINE_EVENTS.parseLog({ data: log.data, topics: log.topics });
    } catch {
      event = null; // not an engine event we know (e.g. an HTS log); skip it but still advance
    }
    if (event && !SKIPPED_EVENTS.has(event.name)) {
      const seq = await publish(client, state.topicId, {
        type: event.name,
        args: argsToJson(event),
        tx: log.transaction_hash,
        ts: log.timestamp,
      });
      console.log(`   #${seq} ${event.name} (${log.transaction_hash})`);
      published++;
    }
    // Saved after every message: a crash re-sends at most one message instead of the whole backlog.
    state.cursor = { timestamp: log.timestamp, index: Number(log.index) };
    saveState(chainId, state);
  }

  const [priceE18, status] = await oracle.latestPrice();
  if (status !== state.oracleStatus) {
    const seq = await publish(client, state.topicId, {
      type: "OracleStatus",
      args: {
        status: ORACLE_STATUS[status],
        previous:
          state.oracleStatus === null
            ? null
            : ORACLE_STATUS[state.oracleStatus],
        priceE18: priceE18.toString(),
      },
      ts: (Date.now() / 1000).toFixed(9),
    });
    console.log(`   #${seq} OracleStatus ${ORACLE_STATUS[status]}`);
    state.oracleStatus = status;
    saveState(chainId, state);
    published++;
  }

  return published;
}

async function main() {
  const { network, keystore } = parseCliArgs();
  const watch = process.argv.includes("--watch");
  const { chainId } = NETWORKS[network];
  const provider = getProvider(network);
  const { HbarCdpEngine: engine, DualOracle: oracleAddress } =
    getDeployment(chainId);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);

  const signer = await loadKeystoreSigner(keystore, provider);
  const { accountId, key } = await sdkOperator(network, signer);
  const client = (
    network === "hedera_mainnet" ? Client.forMainnet() : Client.forTestnet()
  ).setOperator(accountId, key);

  try {
    const state = loadState(chainId, engine);
    if (!state.topicId) {
      state.topicId = await createTopic(client, key, engine);
      saveState(chainId, state);
      console.log(`\n🆕 Created HCS topic ${state.topicId}`);
    }
    console.log(
      `\n📜 Relaying ${engine} to HCS topic ${
        state.topicId
      } as ${accountId}\n   ${topicLink(network, state.topicId)}`
    );
    console.log(
      `   Show it in the UI: NEXT_PUBLIC_HCS_TOPIC_ID=${state.topicId} in packages/nextjs/.env.local\n`
    );

    const context = { network, chainId, client, oracle, state };
    do {
      const published = await relayOnce(context);
      if (!watch) {
        console.log(`✅ Published ${published} message(s)`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } while (watch);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
