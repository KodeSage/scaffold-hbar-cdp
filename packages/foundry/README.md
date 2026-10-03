# Foundry package: HBAR CDP contracts

Contracts, deploy tooling and tests for the HBAR CDP stablecoin template. The full guide (architecture, oracle status machine, Hedera specifics, troubleshooting) is in the [root README](../../README.md).

## Contracts

| File | Purpose |
| --- | --- |
| `contracts/HbarCdpEngine.sol` | Vaults (HBAR collateral in tinybars), HTS stablecoin creation/mint/burn, liquidations |
| `contracts/oracle/DualOracle.sol` | Chainlink HBAR/USD (primary) cross-checked by Supra HBAR/USDT; never reverts, reports a status |
| `contracts/interfaces/` | Minimal `IHederaTokenService`, `IAggregatorV3`, `ISupraSValueFeed`, `IPriceOracle` |

## Tests

```bash
yarn test         # unit + fuzz + invariant tests, offline (HTS emulated by hashgraph/hedera-forking)
yarn test:fork    # DualOracle against the live Chainlink + Supra feeds on Hedera testnet
```

| Suite | Covers |
| --- | --- |
| `test/DualOracle.t.sol` | Status transitions, staleness, deviation, broken/malformed feeds, decimals, overflow |
| `test/HbarCdpEngine.t.sol` | Mint/repay/withdraw/liquidate rules, HTS error surfacing, views, admin |
| `test/HbarCdpEngine.invariant.t.sol` | supply = debt, collateral fully backed, no dust, debt ≤ ceiling |
| `test/fork/DualOracleFork.t.sol` | Real feeds on a Hedera fork (skipped when not forked) |

## Deploy

This template needs HTS and live price feeds, so it targets Hedera networks only. There is no local-chain deploy.

```bash
yarn account:generate   # encrypted keystore in ~/.foundry/keystores
yarn deploy             # testnet: forge script -> create HTS token (make create-stablecoin) -> ABIs for Next.js
yarn smoke              # open + close a vault, print HashScan / mirror node evidence
yarn status             # read-only protocol status
```

`forge script` runs in a local EVM that has no HTS system contract (`0x167`), so token creation is a separate JSON-RPC step (`scripts-js/createStablecoin.js`), run automatically by `yarn deploy`.

Risk parameters and oracle bounds come from `.env` (see `.env.example`); feed addresses per network are in `script/Deploy.s.sol`.

## Verify

```bash
forge verify-contract <address> contracts/HbarCdpEngine.sol:HbarCdpEngine --chain-id 296 --verifier sourcify
forge verify-contract <address> contracts/oracle/DualOracle.sol:DualOracle --chain-id 296 --verifier sourcify
```
