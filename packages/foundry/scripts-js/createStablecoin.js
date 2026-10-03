// Creates the HTS stablecoin through HbarCdpEngine.createStablecoin and returns unused HBAR to the deployer.
// Runs after `forge script` (see Makefile: create-stablecoin) because Forge's local EVM has no HTS at 0x167.
import { ethers } from "ethers";
import {
  ENGINE_ABI,
  NETWORKS,
  ORACLE_ABI,
  contractLink,
  entityIdFromLongZero,
  formatPrice,
  formatTinybars,
  getDeployment,
  gasLimitFor,
  getProvider,
  hbarToWeibar,
  loadKeystoreSigner,
  parseCliArgs,
  sendAndReport,
  tokenLink,
} from "./hedera.js";

const NAME = process.env.STABLECOIN_NAME || "Scaffold CDP Dollar";
const SYMBOL = process.env.STABLECOIN_SYMBOL || "SCD";
const MEMO =
  process.env.STABLECOIN_MEMO ||
  "HBAR-collateralised stablecoin (scaffold-hbar CDP template)";
// HTS TokenCreate costs about 1 USD, paid in HBAR. Send a margin; the engine returns the rest right after.
const CREATE_FEE_BUDGET_USD = Number(
  process.env.STABLECOIN_CREATE_BUDGET_USD || 2
);

async function main() {
  const { network, keystore } = parseCliArgs();
  const provider = getProvider(network);
  const { HbarCdpEngine: engineAddress, DualOracle: oracleAddress } =
    getDeployment(NETWORKS[network].chainId);
  const engine = new ethers.Contract(engineAddress, ENGINE_ABI, provider);

  const existing = await engine.stablecoin();
  if (existing !== ethers.constants.AddressZero) {
    console.log(
      `ℹ️  Stablecoin already created: ${entityIdFromLongZero(
        existing
      )} (${tokenLink(network, existing)})`
    );
    return;
  }

  // Size the HBAR payment from the live oracle price so the fee budget is stable in USD terms.
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
  const [priceE18] = await oracle.latestPrice();
  if (priceE18.isZero())
    throw new Error(
      "Oracle has no usable price; cannot size the token-creation payment."
    );
  const budgetHbar = Math.ceil(
    CREATE_FEE_BUDGET_USD / Number(formatPrice(priceE18))
  );
  console.log(
    `\n🪙 Creating HTS stablecoin "${NAME}" (${SYMBOL}) via ${contractLink(
      network,
      engineAddress
    )}`
  );
  console.log(
    `   HBAR/USD ${formatPrice(
      priceE18
    )} → sending ${budgetHbar} HBAR (≈ $${CREATE_FEE_BUDGET_USD}) for the HTS fee`
  );

  const signer = await loadKeystoreSigner(keystore, provider);
  const engineAsOwner = engine.connect(signer);
  const owner = await engine.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Keystore ${signer.address} is not the engine owner (${owner}).`
    );
  }

  const value = hbarToWeibar(budgetHbar); // JSON-RPC value is in weibars; the contract sees tinybars
  const createArgs = [NAME, SYMBOL, MEMO];
  const gasLimit = await gasLimitFor(
    engineAsOwner,
    "createStablecoin",
    createArgs,
    { value },
    1_000_000
  );
  await sendAndReport(
    network,
    "createStablecoin",
    engineAsOwner.createStablecoin(...createArgs, { value, gasLimit })
  );
  const token = await engine.stablecoin();
  console.log(
    `   Token: ${entityIdFromLongZero(token)} (${token})\n   ${tokenLink(
      network,
      token
    )}`
  );

  // `address(this).balance` and `totalCollateral` are tinybars on-chain; eth_getBalance reports weibars.
  const balanceTinybars = (await provider.getBalance(engineAddress)).div(
    ethers.BigNumber.from(10).pow(10)
  );
  const excess = balanceTinybars.sub(await engine.totalCollateral());
  if (excess.gt(0)) {
    console.log(
      `\n↩️  Returning ${formatTinybars(excess)} unused HBAR to ${
        signer.address
      }`
    );
    const gasLimit = await gasLimitFor(
      engineAsOwner,
      "sweepExcessHbar",
      [signer.address],
      {},
      200_000
    );
    await sendAndReport(
      network,
      "sweepExcessHbar",
      engineAsOwner.sweepExcessHbar(signer.address, { gasLimit })
    );
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
