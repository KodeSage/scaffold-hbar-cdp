import { spawnSync } from "child_process";
import { config } from "dotenv";
import { join, dirname } from "path";
import { readFileSync, existsSync } from "fs";
import { parse } from "toml";
import { fileURLToPath } from "url";
import { selectOrCreateKeystore } from "./selectOrCreateKeystore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config();

const args = process.argv.slice(2);
let fileName = "Deploy.s.sol";
// HTS and the Chainlink/Supra feeds only exist on Hedera networks, so testnet is the default target.
let network = "hedera_testnet";
let keystoreArg = null;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: yarn deploy [options]
Options:
  --network <network>   hedera_testnet (default) or hedera_mainnet
  --keystore <name>     Keystore account to use (skips the selection prompt)
  --file <filename>     Deployment script in script/ (default: Deploy.s.sol)
  --help, -h            Show this help message

Pipeline: forge script (DualOracle + HbarCdpEngine) -> create HTS stablecoin -> generate frontend ABIs
Examples:
  yarn deploy
  yarn deploy --network hedera_testnet --keystore my-account
`);
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--network" && args[i + 1]) {
    network = args[++i];
  } else if (args[i] === "--file" && args[i + 1]) {
    fileName = args[++i];
  } else if (args[i] === "--keystore" && args[i + 1]) {
    keystoreArg = args[++i];
  }
}

try {
  const parsedToml = parse(
    readFileSync(join(__dirname, "..", "foundry.toml"), "utf-8")
  );
  if (!parsedToml.rpc_endpoints[network]) {
    console.log(
      `\n❌ Error: Network '${network}' not found in foundry.toml!`,
      `\nAvailable: ${Object.keys(parsedToml.rpc_endpoints).join(", ")}`
    );
    process.exit(1);
  }
} catch (error) {
  console.error("\n❌ Error reading or parsing foundry.toml:", error);
  process.exit(1);
}

let selectedKeystore;
if (keystoreArg) {
  const keystorePath = join(
    process.env.HOME,
    ".foundry",
    "keystores",
    keystoreArg
  );
  if (!existsSync(keystorePath)) {
    console.log(
      `\n❌ Error: Keystore '${keystoreArg}' not found in ~/.foundry/keystores/`
    );
    process.exit(1);
  }
  selectedKeystore = keystoreArg;
  console.log(`\n🔑 Using keystore: ${selectedKeystore}`);
} else {
  try {
    selectedKeystore = await selectOrCreateKeystore();
  } catch (error) {
    console.error("\n❌ Error selecting keystore:", error);
    process.exit(1);
  }
}

if (selectedKeystore === "scaffold-hbar-default") {
  console.log(`
❌ The scaffold-hbar-default keystore is a well-known local key and cannot deploy to ${network}.
   Generate your own: yarn account:generate, fund it at https://portal.hedera.com/faucet, then deploy again.
`);
  process.exit(1);
}

process.env.DEPLOY_SCRIPT = `script/${fileName}`;
process.env.RPC_URL = network;
process.env.ETH_KEYSTORE_ACCOUNT = selectedKeystore;

const result = spawnSync("make", ["deploy-and-generate-abis"], {
  stdio: "inherit",
  shell: true,
  cwd: join(__dirname, ".."),
});

process.exit(result.status);
