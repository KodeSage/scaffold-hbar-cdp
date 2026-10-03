# Agent instructions

Briefing for coding agents (Claude Code, Cursor, Codex) working in this repo. Claude Code loads it through `CLAUDE.md`. Read this before changing contracts or money-handling UI code.

## What this is

A Scaffold-HBAR template for an **HBAR-collateralised stablecoin** on Hedera:

- `HbarCdpEngine` (Solidity, Foundry): vaults of HBAR collateral, an HTS stablecoin it creates and controls, and liquidations.
- `DualOracle`: HBAR/USD from Chainlink (primary), cross-checked against Supra, with a status machine instead of reverts.
- `scripts-js/hcsLog.js`: off-chain relayer that publishes engine events and oracle status changes to an HCS topic (contracts cannot write to HCS).
- Next.js frontend: vault dashboard (`/`, including the HCS protocol log), liquidation board (`/liquidations`), Debug Contracts (`/debug`).

Only Foundry exists in this template (`packages/foundry`). There is no Hardhat package and no local chain: HTS and the price feeds only exist on Hedera networks.

## Commands

Use the package manager the project was created with (see `packageManager` in the root `package.json`). Examples use `yarn`; with npm use `npm run <script>`. Pass script flags after `--` (e.g. `yarn foundry:deploy -- --keystore my-key`) so they survive npm.

```bash
yarn foundry:test          # offline unit + fuzz + invariant tests (HTS emulated by hedera-forking)
yarn foundry:test:fork     # DualOracle against live Hedera testnet feeds (network access)
yarn foundry:lint          # forge fmt --check + prettier on scripts-js
yarn foundry:format
yarn foundry:status        # read-only: oracle health, params, totals, token id
yarn foundry:deploy        # testnet deploy -> create HTS token -> regenerate deployedContracts.ts (interactive keystore)
yarn foundry:smoke         # open + close a vault on testnet; prints HashScan/mirror evidence (interactive keystore)
yarn foundry:hcs           # relay engine events + oracle status changes to an HCS topic (interactive keystore; -- --watch)

yarn next:dev              # http://localhost:3000
yarn next:test             # vitest: utils/cdp math/format/HCS parsing
yarn next:lint             # must stay at 0 warnings
yarn next:check-types
yarn next:build
```

Before finishing a change, run: `yarn foundry:test`, `yarn foundry:lint`, `yarn next:lint`, `yarn next:check-types`, `yarn next:test`, `yarn next:build`.

Never run `yarn foundry:deploy`, `yarn foundry:smoke`, `yarn foundry:hcs` or any `cast send` unless the user asks. They spend real testnet HBAR and need the user's keystore password.

## Units: the #1 source of bugs

| Quantity | Unit | Decimals | Where |
| --- | --- | --- | --- |
| HBAR inside the EVM (`msg.value`, `address.balance`, `collateral`, `totalCollateral`) | tinybar | 8 | contracts, `getVault` |
| HBAR over JSON-RPC (`value` of a tx, `eth_getBalance`, wagmi `useBalance`) | weibar | 18 | frontend, scripts |
| Stablecoin amounts (`debt`, `minDebt`, token balances) | stable units | 6 | everywhere |
| Prices (`priceE18`) | USD per 1 HBAR | 18 | oracle, engine |
| Ratios / bonus | basis points | 10000 = 100% | engine params |

- Convert tinybar → weibar with `tinybarsToWeibars` (× 10¹⁰) when sending `value`. Never send a tinybar number as `value`.
- User HBAR input is parsed with `parseHbar` (max 8 decimals). The relay cannot carry sub-tinybar values.
- Value of collateral in stable units = `collateral * priceE18 / 1e20`.

## Contract invariants: do not break these

1. `stablecoin.totalSupply() == totalDebt == Σ vault.debt`. The engine holds 0 SCD between transactions (mint → transfer out; pull → burn).
2. `totalCollateral == Σ vault.collateral <= address(engine).balance`. Never derive collateral from the balance. `sweepExcessHbar` relies on this.
3. Every vault debt is `0` or `>= minDebt`.
4. Health checks use `requiredCollateral(debt, price, ratio)` (rounded **up**). `maxMintable`/`maxWithdrawable` are derived from the same formula, so the UI and the contract agree exactly. Fuzz tests assert it. Keep it that way.
5. A vault with **zero debt never needs the oracle**: deposit, repay and withdraw-all must work when the oracle is `Frozen`/`Unavailable`.
6. `DualOracle.latestPrice()` must never revert. Feed reads use `staticcall` and length checks, not `try/catch` (try/catch does not catch decoding failures).
7. Risk parameters and the oracle are immutable. Owner powers are only: debt ceiling, pause minting, sweep non-collateral HBAR.

`test/HbarCdpEngine.invariant.t.sol` encodes 1–3 plus the ceiling. Run it after any engine change.

## HTS rules

- The engine creates the token in `createStablecoin` via `0x167` and is **treasury, supply key and auto-renew account**. There is no admin key. Do not add keys without a reason the user agrees to.
- Mint path: `mintToken` (to treasury) → `transferToken(engine → user)`. Response `184` means the user is not associated → `NotAssociated`.
- Burn path: user `approve`s the engine on the token's ERC-20 facade (HIP-376) → engine `transferFrom` → `burnToken`.
- HTS returns `int64` response codes. `22` is SUCCESS; anything else must revert (`HtsCallFailed(selector, code)`). Amounts are `int64`: go through `_toInt64`.
- `forge script` cannot execute HTS calls (no `0x167` in Forge's local EVM). Anything touching HTS at deploy time goes in a JS script over JSON-RPC (see `scripts-js/createStablecoin.js`). In tests, call `htsSetup()` from `hedera-forking/htsSetup.sol`; the emulator does **not** enforce association, so mock `0x167` (see `test_Mint_SurfacesMissingTokenAssociation`) to test that path.

## Where things live

| Path | Purpose |
| --- | --- |
| `packages/foundry/contracts/HbarCdpEngine.sol` | Vault logic, HTS integration, liquidation |
| `packages/foundry/contracts/oracle/DualOracle.sol` | Feed validation + status machine |
| `packages/foundry/contracts/interfaces/` | Minimal HTS, Chainlink, Supra and oracle interfaces |
| `packages/foundry/script/Deploy.s.sol` | Feed addresses per chain (296/295), env-driven params |
| `packages/foundry/scripts-js/hedera.js` | Shared script helpers: keystore, units, deployment lookup, links |
| `packages/foundry/test/` | `DualOracle.t.sol`, `HbarCdpEngine.t.sol`, `HbarCdpEngine.invariant.t.sol`, `fork/` |
| `packages/nextjs/utils/cdp/math.ts` | bigint mirror of the engine math. **Change it together with the contract** |
| `packages/nextjs/hooks/cdp/useCdp.ts` | Reads: protocol snapshot + account state (10s polling) |
| `packages/nextjs/hooks/cdp/useCdpActions.ts` | Writes: borrow, repay/withdraw, liquidate, approve, associate |
| `packages/nextjs/utils/cdp/mirrorNode.ts` | Association readiness, activity feed (topic queries need a < 7 day `timestamp` range), HCS log reader |
| `packages/foundry/scripts-js/hcsLog.js` | HCS relayer. Message shape is versioned (`v: 1`); change `parseHcsMessage` in `mirrorNode.ts` together with it |
| `packages/nextjs/contracts/deployedContracts.ts` | Generated by deploy. Do not edit by hand |

## Frontend conventions

- Engine writes use `useScaffoldWriteContract({ contractName: "HbarCdpEngine" })` (it simulates first and decodes custom errors). Token writes use wagmi `useWriteContract` with `chainId` pinned, wrapped in `useTransactor`.
- `borrow()` picks `deposit` / `mint` / `depositAndMint`, because `depositAndMint(0)` reverts with `ZeroAmount`.
- Reads go through one react-query snapshot (parallel `readContract`). viem's Hedera chains have no Multicall3, so do not use `useReadContracts` batching.
- Invalidate with `useRefreshCdp()` after writes. Every CDP query key starts with `CDP_QUERY_KEY`.
- DaisyUI 5 classes, `~~` import alias, `type` over `interface`, `"use client"` on hook-using pages.

## Typical tasks

- **Change a risk parameter default:** `packages/foundry/.env.example` and `Deploy.s.sol` (`vm.envOr` defaults), then the README tables.
- **Add a contract function used by the UI:** implement + test in Foundry, redeploy (user-approved), regenerate ABIs (`make generate-abis` in `packages/foundry`), then use it via `useScaffoldReadContract`/`useScaffoldWriteContract`.
- **Change math:** update `HbarCdpEngine.sol` **and** `utils/cdp/math.ts`, then add matching vectors to both `HbarCdpEngine.t.sol` and `math.test.ts`.
- **Add a network:** feed addresses in `Deploy.s.sol`, `NETWORKS` in `scripts-js/hedera.js`, `targetNetworks` in `scaffold.config.ts`, `MIRROR_NODE`/`HASHSCAN` in `utils/cdp/constants.ts`.

## Style

Do not add Prettier plugins that regenerate code through Babel (e.g. `@trivago/prettier-plugin-sort-imports`): under npm, which has no lockfile in a fresh scaffold, they stripped TypeScript generics during the CLI's format step.

Solidity: `forge fmt` (120 cols), custom errors over strings, NatSpec on public surface, every variable that holds money says its unit. TypeScript: Prettier via `yarn format`, `lowerCamelCase` functions, `CONSTANT_CASE` constants, comments only where they add information.
