// Read-only protocol status: oracle feeds, risk parameters, totals and the HTS token.
// Usage: yarn foundry:status [--network hedera_testnet]
import { ethers } from "ethers";
import {
  ENGINE_ABI,
  NETWORKS,
  ORACLE_ABI,
  ORACLE_STATUS,
  contractLink,
  entityIdFromLongZero,
  formatPrice,
  formatStable,
  formatTinybars,
  getDeployment,
  getProvider,
  parseCliArgs,
  tokenLink,
} from "./hedera.js";

const age = (seconds) =>
  seconds
    ? `${Math.max(0, Math.round(Date.now() / 1000 - seconds))}s ago`
    : "never";

async function main() {
  const { network } = parseCliArgs();
  const provider = getProvider(network);
  const { HbarCdpEngine: engineAddress, DualOracle: oracleAddress } =
    getDeployment(NETWORKS[network].chainId);
  const engine = new ethers.Contract(engineAddress, ENGINE_ABI, provider);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);

  const [[price, status, updatedAt], chainlink, supra, maxDev] =
    await Promise.all([
      oracle.latestPrice(),
      oracle.readChainlink(),
      oracle.readSupra(),
      oracle.maxDeviationBps(),
    ]);
  console.log(`\n📡 Oracle ${contractLink(network, oracleAddress)}`);
  console.log(
    `   Status:    ${ORACLE_STATUS[status]}  price ${formatPrice(
      price
    )} USD/HBAR (${age(updatedAt.toNumber())})`
  );
  console.log(
    `   Chainlink: ${
      chainlink.ok ? "fresh" : "stale/unavailable"
    }  ${formatPrice(chainlink.priceE18)} (${age(
      chainlink.updatedAt.toNumber()
    )})`
  );
  console.log(
    `   Supra:     ${supra.ok ? "fresh" : "stale/unavailable"}  ${formatPrice(
      supra.priceE18
    )} (${age(supra.updatedAt.toNumber())})`
  );
  console.log(`   Max deviation: ${maxDev / 100}%`);

  const [
    token,
    mcr,
    liq,
    bonus,
    minDebt,
    ceiling,
    paused,
    totalCollateral,
    totalDebt,
    vaults,
  ] = await Promise.all([
    engine.stablecoin(),
    engine.minCollateralRatioBps(),
    engine.liquidationRatioBps(),
    engine.liquidationBonusBps(),
    engine.minDebt(),
    engine.debtCeiling(),
    engine.mintingPaused(),
    engine.totalCollateral(),
    engine.totalDebt(),
    engine.vaultCount(),
  ]);
  console.log(`\n🏦 Engine ${contractLink(network, engineAddress)}`);
  console.log(
    `   Min CR ${mcr / 100}% · liquidation below ${liq / 100}% · bonus ${
      bonus / 100
    }% · min debt ${formatStable(minDebt)}`
  );
  console.log(
    `   Debt ${formatStable(totalDebt)} / ceiling ${formatStable(
      ceiling
    )} · collateral ${formatTinybars(
      totalCollateral
    )} HBAR · ${vaults} vault(s)`
  );
  console.log(`   Minting ${paused ? "PAUSED" : "open"}`);
  if (!price.isZero() && !totalDebt.isZero()) {
    // tinybars * priceE18 / 1e20 = stable units
    const value = totalCollateral
      .mul(price)
      .div(ethers.BigNumber.from(10).pow(20));
    console.log(
      `   System collateral ratio ${(
        value.mul(10000).div(totalDebt).toNumber() / 100
      ).toFixed(2)}%`
    );
  }

  if (token === ethers.constants.AddressZero) {
    console.log(
      "\n🪙 Stablecoin not created yet (run: make create-stablecoin)"
    );
  } else {
    console.log(
      `\n🪙 Stablecoin ${entityIdFromLongZero(
        token
      )} (${token})\n   ${tokenLink(network, token)}`
    );
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
