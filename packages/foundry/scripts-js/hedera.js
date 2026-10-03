// Shared helpers for scripts that talk to a live Hedera network (create token, smoke test, status).
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { ethers } from "ethers";
import { parse } from "toml";
import dotenv from "dotenv";
import { listKeystores } from "./listKeystores.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FOUNDRY_ROOT = join(__dirname, "..");
dotenv.config({ path: join(FOUNDRY_ROOT, ".env") });

export const NETWORKS = {
  hedera_testnet: {
    chainId: 296,
    hashscan: "https://hashscan.io/testnet",
    mirror: "https://testnet.mirrornode.hedera.com",
  },
  hedera_mainnet: {
    chainId: 295,
    hashscan: "https://hashscan.io/mainnet",
    mirror: "https://mainnet.mirrornode.hedera.com",
  },
};

/** 1 HBAR = 1e8 tinybars (EVM-internal unit) = 1e18 weibars (JSON-RPC unit). */
export const WEIBARS_PER_TINYBAR = 10n ** 10n;

export const ENGINE_ABI = [
  "function stablecoin() view returns (address)",
  "function owner() view returns (address)",
  "function oracle() view returns (address)",
  "function minCollateralRatioBps() view returns (uint256)",
  "function liquidationRatioBps() view returns (uint256)",
  "function liquidationBonusBps() view returns (uint256)",
  "function minDebt() view returns (uint256)",
  "function debtCeiling() view returns (uint256)",
  "function mintingPaused() view returns (bool)",
  "function totalCollateral() view returns (uint256)",
  "function totalDebt() view returns (uint256)",
  "function vaultCount() view returns (uint256)",
  "function vaultOf(address) view returns (uint256 collateral, uint256 debt)",
  "function getVault(address) view returns (tuple(address owner, uint256 collateral, uint256 debt, uint256 collateralValue, uint256 collateralRatioBps, uint256 maxMintable, uint256 maxWithdrawable, bool liquidatable))",
  "function createStablecoin(string name, string symbol, string memo) payable returns (address)",
  "function sweepExcessHbar(address to)",
  "function depositAndMint(uint256 amount) payable",
  "function repayAndWithdraw(uint256 repayAmount, uint256 withdrawAmount)",
];

export const ORACLE_ABI = [
  "function latestPrice() view returns (uint256 priceE18, uint8 status, uint256 updatedAt)",
  "function readChainlink() view returns (bool ok, uint256 priceE18, uint256 updatedAt)",
  "function readSupra() view returns (bool ok, uint256 priceE18, uint256 updatedAt)",
  "function maxDeviationBps() view returns (uint256)",
];

export const TOKEN_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

export const ORACLE_STATUS = [
  "Ok",
  "PrimaryOnly",
  "SecondaryOnly",
  "Frozen",
  "Unavailable",
];

/** Parses `--network <name>` and `--keystore <name>` from argv. */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    network: process.env.RPC_URL || "hedera_testnet",
    keystore: process.env.ETH_KEYSTORE_ACCOUNT,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--network" && argv[i + 1]) args.network = argv[++i];
    else if (argv[i] === "--keystore" && argv[i + 1]) args.keystore = argv[++i];
  }
  if (!NETWORKS[args.network]) {
    throw new Error(
      `Unsupported network "${args.network}". Use one of: ${Object.keys(
        NETWORKS
      ).join(", ")}`
    );
  }
  return args;
}

export function getProvider(network) {
  const toml = parse(readFileSync(join(FOUNDRY_ROOT, "foundry.toml"), "utf-8"));
  const url =
    process.env.HEDERA_RPC_URL && network === "hedera_testnet"
      ? process.env.HEDERA_RPC_URL
      : toml.rpc_endpoints[network];
  return new ethers.providers.StaticJsonRpcProvider(
    url,
    NETWORKS[network].chainId
  );
}

/**
 * Contract addresses for `chainId`: `deployments/<chainId>.json` from your own deploy, falling back to the
 * addresses committed in packages/nextjs/contracts/deployedContracts.ts (the reference testnet deployment),
 * so scripts and the UI always agree on which contracts they talk to.
 */
export function getDeployment(chainId) {
  const file = join(FOUNDRY_ROOT, "deployments", `${chainId}.json`);
  const byName = {};
  if (existsSync(file)) {
    const byAddress = JSON.parse(readFileSync(file, "utf-8"));
    for (const [address, name] of Object.entries(byAddress)) {
      if (address !== "networkName") byName[name] = address;
    }
  } else {
    const generated = join(
      FOUNDRY_ROOT,
      "..",
      "nextjs",
      "contracts",
      "deployedContracts.ts"
    );
    const source = existsSync(generated)
      ? readFileSync(generated, "utf-8")
      : "";
    const chainBlock = source.split(/^\s{2}(\d+): \{/m);
    const index = chainBlock.indexOf(String(chainId));
    const block = index >= 0 ? chainBlock[index + 1] : "";
    for (const name of ["DualOracle", "HbarCdpEngine"]) {
      const match = block.match(
        new RegExp(`${name}: \\{\\s*address: "(0x[0-9a-fA-F]{40})"`)
      );
      if (match) byName[name] = ethers.utils.getAddress(match[1]);
    }
  }
  if (!byName.HbarCdpEngine || !byName.DualOracle) {
    throw new Error(
      `No deployment found for chain ${chainId}. Run: yarn foundry:deploy`
    );
  }
  return byName;
}

/**
 * Hidden password prompt. For non-interactive use set ETH_PASSWORD to a password *file* path,
 * the same convention `forge`/`cast --password-file` use, so one variable unlocks both.
 */
function promptHidden(question) {
  if (process.env.ETH_PASSWORD)
    return Promise.resolve(
      readFileSync(process.env.ETH_PASSWORD, "utf-8").trim()
    );
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.stdoutMuted = true;
    rl._writeToOutput = (text) => {
      if (!rl.stdoutMuted || text.includes(question)) rl.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Decrypts a Foundry keystore (~/.foundry/keystores/<name>) into an ethers signer.
 * Without a name, lists the available keystores and asks which one to use.
 */
export async function loadKeystoreSigner(keystoreName, provider) {
  const name =
    keystoreName ||
    (await listKeystores(
      "Select the keystore to sign with (enter the number): "
    ));
  const file = join(process.env.HOME, ".foundry", "keystores", name);
  if (!existsSync(file))
    throw new Error(`Keystore "${name}" not found in ~/.foundry/keystores`);
  const password = await promptHidden(`🔑 Password for keystore "${name}": `);
  process.stdout.write("   Decrypting keystore…\n");
  const wallet = await ethers.Wallet.fromEncryptedJson(
    readFileSync(file, "utf-8"),
    password
  );
  return wallet.connect(provider);
}

/** Hedera entity id (0.0.x) for a long-zero EVM address such as an HTS token address. */
export function entityIdFromLongZero(address) {
  return `0.0.${BigInt(address).toString()}`;
}

export const txLink = (network, hash) =>
  `${NETWORKS[network].hashscan}/transaction/${hash}`;
export const contractLink = (network, address) =>
  `${NETWORKS[network].hashscan}/contract/${address}`;
export const tokenLink = (network, tokenAddress) =>
  `${NETWORKS[network].hashscan}/token/${entityIdFromLongZero(tokenAddress)}`;
export const topicLink = (network, topicId) =>
  `${NETWORKS[network].hashscan}/topic/${topicId}`;
export const mirrorResultLink = (network, hash) =>
  `${NETWORKS[network].mirror}/api/v1/contracts/results/${hash}`;

/** Converts an HBAR decimal string to the weibar value expected by JSON-RPC `value`. */
export const hbarToWeibar = (hbar) => ethers.utils.parseUnits(String(hbar), 18);
export const formatTinybars = (tinybars) =>
  ethers.utils.formatUnits(tinybars, 8);
export const formatStable = (units) => ethers.utils.formatUnits(units, 6);
export const formatPrice = (priceE18) => ethers.utils.formatUnits(priceE18, 18);

/**
 * Gas limit from eth_estimateGas (+20%), or `fallback` when estimation fails.
 * Hedera charges for at least 80% of the gas limit, so an oversized limit costs real HBAR.
 */
export async function gasLimitFor(contract, method, args, overrides, fallback) {
  try {
    const estimate = await contract.estimateGas[method](...args, overrides);
    return estimate.mul(120).div(100);
  } catch {
    return ethers.BigNumber.from(fallback);
  }
}

/** Sends a transaction and waits for the receipt, printing HashScan + mirror node evidence links. */
export async function sendAndReport(network, label, txPromise) {
  const tx = await txPromise;
  process.stdout.write(`⏳ ${label}: ${tx.hash}\n`);
  const receipt = await tx.wait();
  if (receipt.status !== 1)
    throw new Error(`${label} failed: ${txLink(network, tx.hash)}`);
  process.stdout.write(
    `✅ ${label}\n   HashScan:    ${txLink(
      network,
      tx.hash
    )}\n   Mirror node: ${mirrorResultLink(network, tx.hash)}\n`
  );
  return {
    label,
    hash: tx.hash,
    hashscan: txLink(network, tx.hash),
    mirror: mirrorResultLink(network, tx.hash),
    receipt,
  };
}
