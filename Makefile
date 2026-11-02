.PHONY: contracts test-core test-contracts lint

contracts:
	cd contracts/mock-outlayer && cargo near build non-reproducible-wasm
	cd contracts/mock-token && cargo near build non-reproducible-wasm
	cd contracts/vault && cargo near build non-reproducible-wasm

test-core:
	cargo test -p provingground-core

test-contracts: contracts
	cargo test -p vault-tests -- --test-threads=4

lint:
	cargo fmt --all -- --check
	cargo clippy -p provingground-core --all-targets -- -D warnings
	cargo clippy -p provingground-vault -p mock-outlayer -p mock-token --target wasm32-unknown-unknown -- -D warnings
	cargo clippy -p vault-tests --all-targets -- -D warnings
