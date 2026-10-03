//SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { HbarCdpEngine } from "../contracts/HbarCdpEngine.sol";
import { DualOracle } from "../contracts/oracle/DualOracle.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { IPriceOracle } from "../contracts/interfaces/IPriceOracle.sol";
import { ISupraSValueFeed } from "../contracts/interfaces/ISupraSValueFeed.sol";

/// @notice Deploys DualOracle + HbarCdpEngine to Hedera testnet (296) or mainnet (295).
/// @dev The HTS stablecoin is created afterwards by `make create-stablecoin` (run automatically by
///      `yarn foundry:deploy`): Forge executes scripts in a local EVM that has no HTS system contract at 0x167,
///      so the token-creation call is sent with `cast` instead.
///
///      Every risk parameter can be overridden with an environment variable (see packages/foundry/.env.example).
contract DeployScript is ScaffoldETHDeploy {
    struct OracleConfig {
        address chainlinkHbarUsd;
        address supraPushOracle;
        uint256 supraHbarUsdtPairId;
    }

    error UnsupportedChain(uint256 chainId);

    // Chainlink Data Feeds on Hedera: https://docs.chain.link/data-feeds/price-feeds/addresses?network=hedera
    address internal constant TESTNET_CHAINLINK_HBAR_USD = 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a;
    address internal constant MAINNET_CHAINLINK_HBAR_USD = 0xAF685FB45C12b92b5054ccb9313e135525F9b5d5;
    // Supra push oracle on Hedera: https://docs.supra.com/oracles/data-feeds/push-oracle/networks
    address internal constant TESTNET_SUPRA_PUSH_ORACLE = 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917;
    address internal constant MAINNET_SUPRA_PUSH_ORACLE = 0xD02cc7a670047b6b012556A88e275c685d25e0c9;
    uint256 internal constant SUPRA_HBAR_USDT_PAIR_ID = 75;

    function run() external ScaffoldEthDeployerRunner {
        OracleConfig memory feeds = oracleConfig(block.chainid);

        DualOracle oracle = new DualOracle(
            IAggregatorV3(feeds.chainlinkHbarUsd),
            vm.envOr("CHAINLINK_MAX_AGE_SECONDS", uint256(4 hours)),
            ISupraSValueFeed(feeds.supraPushOracle),
            feeds.supraHbarUsdtPairId,
            vm.envOr("SUPRA_MAX_AGE_SECONDS", uint256(3 hours)),
            vm.envOr("MAX_ORACLE_DEVIATION_BPS", uint256(300))
        );
        deployments.push(Deployment({ name: "DualOracle", addr: address(oracle) }));

        HbarCdpEngine engine = new HbarCdpEngine(
            deployer,
            IPriceOracle(address(oracle)),
            vm.envOr("MIN_COLLATERAL_RATIO_BPS", uint256(15_000)),
            vm.envOr("LIQUIDATION_RATIO_BPS", uint256(12_500)),
            vm.envOr("LIQUIDATION_BONUS_BPS", uint256(1_000)),
            vm.envOr("MIN_DEBT", uint256(1e6)), // 1 stablecoin (6 decimals)
            vm.envOr("DEBT_CEILING", uint256(1_000_000e6))
        );
        deployments.push(Deployment({ name: "HbarCdpEngine", addr: address(engine) }));
    }

    function oracleConfig(uint256 chainId) public pure returns (OracleConfig memory) {
        if (chainId == 296) {
            return OracleConfig(TESTNET_CHAINLINK_HBAR_USD, TESTNET_SUPRA_PUSH_ORACLE, SUPRA_HBAR_USDT_PAIR_ID);
        }
        if (chainId == 295) {
            return OracleConfig(MAINNET_CHAINLINK_HBAR_USD, MAINNET_SUPRA_PUSH_ORACLE, SUPRA_HBAR_USDT_PAIR_ID);
        }
        // HTS and live price feeds only exist on Hedera networks; a plain local chain cannot run this template.
        revert UnsupportedChain(chainId);
    }
}
