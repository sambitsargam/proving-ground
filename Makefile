.PHONY: contracts test-core test-contracts checker test-checker checker-eval lint

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
	node services/checker/tests/wasm.mjs $(CHECKER_TEST_DIR)/wasm32-wasip2/release/provingground-checker.wasm

# Spends a little NEAR AI credit. Needs NEAR_AI_API_KEY in the environment.
checker-eval: checker
	node services/checker/tests/wasm.mjs $(CHECKER_WASM) --live

lint:
	cargo fmt --all -- --check
	cargo clippy -p provingground-core --all-targets -- -D warnings
	cargo clippy -p provingground-vault -p mock-outlayer -p mock-token --target wasm32-unknown-unknown -- -D warnings
	cargo clippy -p vault-tests --all-targets -- -D warnings
	cargo clippy -p provingground-checker --all-targets -- -D warnings
	cargo clippy -p provingground-checker --target wasm32-wasip2 -- -D warnings
