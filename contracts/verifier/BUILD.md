# Rebuilding the verifier wasm

`defuse.wasm` is an unmodified build of https://github.com/near/intents tag `defuse/v0.4.5`
(commit 16d04f6ec4401263f8914638710260da50bb46b0). NEAR publishes no wasm for this version.

    git clone https://github.com/near/intents && cd intents && git checkout defuse/v0.4.5
    cd contracts/defuse && cargo near build reproducible-wasm

The pinned image is in `contracts/defuse/Cargo.toml` (`reproducible_build`). The result must
match `defuse.sha256`. Before upgrading a live contract, run `sandbox/upgrade-test.mjs`.
