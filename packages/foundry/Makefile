.PHONY: deploy deploy-and-generate-abis create-stablecoin generate-abis account get-address compile flatten format lint test test-fork verify

DEPLOY_SCRIPT ?= script/Deploy.s.sol
HEDERA_TESTNET_RPC ?= https://testnet.hashio.io/api
HEDERA_MAINNET_RPC ?= https://mainnet.hashio.io/api

# Deploy DualOracle + HbarCdpEngine. This template needs HTS and live price feeds, so only Hedera networks work.
deploy:
	@if [ ! -f "$(DEPLOY_SCRIPT)" ]; then echo "Error: Deploy script '$(DEPLOY_SCRIPT)' not found"; exit 1; fi
	@mkdir -p deployments
	@if [ "$(RPC_URL)" = "hedera_testnet" ]; then \
		forge script $(DEPLOY_SCRIPT) --rpc-url $(HEDERA_TESTNET_RPC) --account $(ETH_KEYSTORE_ACCOUNT) --broadcast --slow --legacy; \
	elif [ "$(RPC_URL)" = "hedera_mainnet" ]; then \
		forge script $(DEPLOY_SCRIPT) --rpc-url $(HEDERA_MAINNET_RPC) --account $(ETH_KEYSTORE_ACCOUNT) --broadcast --slow --legacy; \
	else \
		echo "Error: unsupported network '$(RPC_URL)'. Use --network hedera_testnet or --network hedera_mainnet."; exit 1; \
	fi

# Full pipeline used by `yarn foundry:deploy`: contracts -> HTS stablecoin -> frontend ABIs.
deploy-and-generate-abis: deploy create-stablecoin generate-abis

# Creates the HTS token through the engine. Runs outside `forge script` because Forge's local EVM
# has no HTS system contract (0x167). Idempotent: does nothing if the token already exists.
create-stablecoin:
	node scripts-js/createStablecoin.js

# Generate TypeScript ABIs for the Next.js frontend
generate-abis:
	node scripts-js/generateTsAbis.js

account:
	@node scripts-js/checkAccountBalance.js

get-address:
	@cast wallet address --account $(ACCOUNT_NAME)

compile:
	forge compile

flatten:
	forge flatten

format:
	forge fmt && prettier --write ./scripts-js/**/*.js

lint:
	forge fmt --check && prettier --check ./scripts-js/**/*.js

# Unit, fuzz and invariant tests. Offline: HTS is emulated by hashgraph/hedera-forking.
test:
	forge test

# Fork tests: read the live Chainlink and Supra feeds on Hedera testnet (set HEDERA_RPC_URL to override).
test-fork:
	forge test --match-path "test/fork/*" --fork-url $${HEDERA_RPC_URL:-$(HEDERA_TESTNET_RPC)}

# Verify on Sourcify (HashScan reads Sourcify verification).
# Usage: make verify CONTRACT=0xAddress CONTRACT_PATH=contracts/HbarCdpEngine.sol:HbarCdpEngine CHAIN_ID=296
verify:
	@if [ -z "$(CONTRACT)" ] || [ -z "$(CONTRACT_PATH)" ]; then \
		echo "Usage: make verify CONTRACT=0xAddress CONTRACT_PATH=contracts/HbarCdpEngine.sol:HbarCdpEngine CHAIN_ID=296"; \
		exit 1; \
	fi
	forge verify-contract $(CONTRACT) $(CONTRACT_PATH) --chain-id $(CHAIN_ID) --verifier sourcify
