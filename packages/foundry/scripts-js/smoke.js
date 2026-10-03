// End-to-end vault lifecycle on a live Hedera network, printing HashScan + mirror node evidence:
//   (associate if needed) -> depositAndMint -> approve -> repayAndWithdraw
// Net cost is gas only: the vault is fully closed at the end.
//
// Usage: yarn foundry:smoke   (prompts for the keystore; optional: -- --keystore <name> --network hedera_testnet)
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ethers } from "ethers";
import {
  ENGINE_ABI,
  FOUNDRY_ROOT,
  NETWORKS,
  ORACLE_ABI,
  ORACLE_STATUS,
  TOKEN_ABI,
  entityIdFromLongZero,
  formatPrice,
  formatStable,
  formatTinybars,
  gasLimitFor,
  getDeployment,
  getProvider,
  hbarToWeibar,
  loadKeystoreSigner,
  parseCliArgs,
  sendAndReport,
  tokenLink,
} from "./hedera.js";

/** Collateral ratio the smoke vault is opened at (above the 150% minimum, with room for price moves). */
const TARGET_RATIO = 1.6;
/** HBAR kept for gas: wallets must hold value + gasLimit * maxFeePerGas up front, even though less is charged. */
const GAS_BUFFER_HBAR = 4;

async function isAssociated(network, account, token) {
  const { mirror } = NETWORKS[network];
  const accountInfo = await fetch(`${mirror}/api/v1/accounts/${account}`).then(
    (r) => r.json()
  );
  // HIP-904: -1 means unlimited automatic associations, so the first incoming transfer associates.
  if (accountInfo.max_automatic_token_associations === -1) return true;
  const tokenId = entityIdFromLongZero(token);
  const rel = await fetch(
    `${mirror}/api/v1/accounts/${account}/tokens?token.id=${tokenId}`
  ).then((r) => r.json());
  return (rel.tokens ?? []).length > 0;
}

async function main() {
  const { network, keystore } = parseCliArgs();
  const provider = getProvider(network);
  const { chainId } = NETWORKS[network];
  const { HbarCdpEngine: engineAddress, DualOracle: oracleAddress } =
    getDeployment(chainId);

  const engineRead = new ethers.Contract(engineAddress, ENGINE_ABI, provider);
  const oracle = new ethers.Contract(oracleAddress, ORACLE_ABI, provider);
  const token = await engineRead.stablecoin();
  if (token === ethers.constants.AddressZero)
    throw new Error("Stablecoin not created yet. Run: make create-stablecoin");

  const [priceE18, status] = await oracle.latestPrice();
  console.log(
    `\n📈 Oracle: HBAR/USD ${formatPrice(priceE18)} (${ORACLE_STATUS[status]})`
  );
  if (status >= 3)
    throw new Error("Oracle is not usable right now; minting would revert.");

  const signer = await loadKeystoreSigner(keystore, provider);
  const engine = engineRead.connect(signer);
  const stable = new ethers.Contract(token, TOKEN_ABI, signer);
  const evidence = [];

  const vault = await engine.vaultOf(signer.address);
  if (!vault.debt.isZero() || !vault.collateral.isZero()) {
    throw new Error(
      `Vault for ${signer.address} is not empty; the smoke test needs a fresh vault.`
    );
  }

  // 1. Association: HTS refuses transfers to accounts that are not associated with the token.
  if (!(await isAssociated(network, signer.address, token))) {
    const hrc719 = new ethers.Contract(
      token,
      ["function associate() returns (uint256)"],
      signer
    );
    evidence.push(
      await sendAndReport(
        network,
        "associate (HIP-719)",
        hrc719.associate({ gasLimit: 1_000_000 })
      )
    );
  }

  // 2. Open a vault at TARGET_RATIO with the minimum debt.
  const mintAmount = await engine.minDebt(); // stable units (6 decimals)
  const usd = Number(formatStable(mintAmount));
  const collateralHbar = Math.ceil(
    (usd * TARGET_RATIO) / Number(formatPrice(priceE18))
  );
  console.log(
    `\n🏦 Opening vault: ${collateralHbar} HBAR collateral, minting ${usd} ${await symbolOf(
      token,
      provider
    )}`
  );
  const value = hbarToWeibar(collateralHbar);
  const balance = await provider.getBalance(signer.address); // weibars
  const needed = hbarToWeibar(collateralHbar + GAS_BUFFER_HBAR);
  if (balance.lt(needed)) {
    throw new Error(
      `Need ~${
        collateralHbar + GAS_BUFFER_HBAR
      } HBAR (collateral is returned at the end), have ${ethers.utils.formatEther(
        balance
      )}. Fund ${signer.address} at https://portal.hedera.com/faucet`
    );
  }
  let gasLimit = await gasLimitFor(
    engine,
    "depositAndMint",
    [mintAmount],
    { value },
    600_000
  );
  evidence.push(
    await sendAndReport(
      network,
      "depositAndMint",
      engine.depositAndMint(mintAmount, { value, gasLimit })
    )
  );

  const opened = await engine.getVault(signer.address);
  console.log(
    `   Vault: ${formatTinybars(opened.collateral)} HBAR / ${formatStable(
      opened.debt
    )} debt / CR ${(opened.collateralRatioBps.toNumber() / 100).toFixed(2)}%`
  );

  // 3. Allow the engine to pull the repayment (HIP-376 allowance via the token's ERC-20 facade).
  gasLimit = await gasLimitFor(
    stable,
    "approve",
    [engineAddress, mintAmount],
    {},
    800_000
  );
  evidence.push(
    await sendAndReport(
      network,
      "approve",
      stable.approve(engineAddress, mintAmount, { gasLimit })
    )
  );

  // 4. Close the vault: burn the debt and take all collateral back.
  gasLimit = await gasLimitFor(
    engine,
    "repayAndWithdraw",
    [mintAmount, opened.collateral],
    {},
    600_000
  );
  evidence.push(
    await sendAndReport(
      network,
      "repayAndWithdraw",
      engine.repayAndWithdraw(mintAmount, opened.collateral, { gasLimit })
    )
  );

  const closed = await engine.vaultOf(signer.address);
  if (!closed.debt.isZero() || !closed.collateral.isZero())
    throw new Error("Vault did not close cleanly.");
  console.log(
    `\n🎉 Vault opened and closed on ${network}. Token: ${tokenLink(
      network,
      token
    )}`
  );

  const outDir = join(FOUNDRY_ROOT, "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${chainId}-smoke.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        network,
        engine: engineAddress,
        oracle: oracleAddress,
        token,
        tokenId: entityIdFromLongZero(token),
        account: signer.address,
        priceE18: priceE18.toString(),
        transactions: evidence.map(({ label, hash, hashscan, mirror }) => ({
          label,
          hash,
          hashscan,
          mirror,
        })),
      },
      null,
      2
    )
  );
  console.log(`📝 Evidence written to ${outFile}`);
}

async function symbolOf(token, provider) {
  return new ethers.Contract(
    token,
    ["function symbol() view returns (string)"],
    provider
  ).symbol();
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exit(1);
});
