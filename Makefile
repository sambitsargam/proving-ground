.PHONY: contracts test-core test-contracts checker test-checker checker-eval attacks-wasm deps ts test-ts test-sandbox attack verify testnet-check testnet-deploy demo-reset lint

CHECKER_WASM := target/wasm32-wasip2/release/provingground-checker.wasm
CHECKER_TEST_DIR := target/checker-test

contracts:
	cd contracts/mock-outlayer && cargo near build non-reproducible-wasm
	cd contracts/mock-token && cargo near build non-reproducible-wasm
	cd contracts/vault && cargo near build non-reproducible-wasm

test-core:
	cargo test -p provingground-core

test-contracts: contracts
	cargo test -p vault-tests -- --test-threads=4

checker:
	cargo build -p provingground-checker --target wasm32-wasip2 --release
	shasum -a 256 $(CHECKER_WASM)

test-checker:
	cargo test -p provingground-checker
	cargo build -p provingground-checker --target wasm32-wasip2 --release --features local-model --target-dir $(CHECKER_TEST_DIR)
	@if command -v $${WASMTIME:-wasmtime} >/dev/null 2>&1; then \
		node services/checker/tests/wasm.mjs $(CHECKER_TEST_DIR)/wasm32-wasip2/release/provingground-checker.wasm; \
	else \
		echo "Skipping the WASM run: Wasmtime 27 is not installed. See services/checker/README.md."; \
	fi

# Spends a little NEAR AI credit. Needs NEAR_AI_API_KEY in the environment.
checker-eval: checker
	node services/checker/tests/wasm.mjs $(CHECKER_WASM) --live

# The attack suite runs these. It takes the real contract, built the way it is deployed.
attacks-wasm: contracts
	cargo build -p provingground-checker-abi --target wasm32-unknown-unknown --release
	mkdir -p attacks/wasm
	cp target/near/provingground_vault/provingground_vault.wasm attacks/wasm/vault.wasm
	cp target/wasm32-unknown-unknown/release/provingground_checker_abi.wasm attacks/wasm/checker.wasm

deps:
	npm ci --no-audit --no-fund

ts: deps
	npm run build

test-ts: ts attacks-wasm
	npm test

# The guard SDK's chain client on a local node, using the sandbox from test-contracts.
test-sandbox: ts contracts
	node scripts/sandbox-check.mjs

attack: ts attacks-wasm
	node attacks/dist/cli.js test --report attacks/report.json

testnet-check: ts
	node scripts/testnet-check.mjs

# Needs CHECKER_WASM_URL. See docs/DEPLOY.md.
testnet-deploy: ts contracts checker
	node scripts/testnet-deploy.mjs

demo-reset: ts
	node scripts/demo-reset.mjs

# Everything, with no keys. The last line it prints is the suite's summary.
verify: lint test-core test-contracts test-sandbox test-checker test-ts attack

lint: deps
	npx biome check .
	cargo fmt --all -- --check
	cargo clippy -p provingground-core --all-targets -- -D warnings
	cargo clippy -p provingground-vault -p mock-outlayer -p mock-token --target wasm32-unknown-unknown -- -D warnings
	cargo clippy -p vault-tests --all-targets -- -D warnings
	cargo clippy -p provingground-checker --all-targets -- -D warnings
	cargo clippy -p provingground-checker --target wasm32-wasip2 -- -D warnings
