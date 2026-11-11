# Faucet

Get Tidepool test tokens on NEAR testnet, or test USDC and USDT on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, BSC Testnet, Aurora Testnet, Solana devnet, Stellar testnet and Sui testnet (Ondo on BSC via assets:["ondo"]). Native BTC and XRP are never dripped: use the external testnet faucets in the [Bitcoin](/docs/guides/bridge-bitcoin-testnet) guide, and the official [XRPL testnet faucet](https://faucet.altnet.rippletest.net/accounts) for XRP ([guide](/docs/guides/bridge-xrp-testnet)). See [How the faucet works](/docs/guides/faucet).

<div id="faucet-widget"></div>

| Token (intents balance; `assets` ids or chain aliases) | Per drip |
| --- | --- |
{{DRIPS}}

**Wallet** mints NEP-141 tokens to your account (the account must exist). **Intents** credits your balance inside the Tidepool verifier `{{VERIFIER}}`, ready for an `INTENTS` deposit. The account does not need to exist on chain for this mode.

Other chains: `{"chain":"base","address":"0x…"}` (also `eth`, `arb`, `sol`, `stellar`, `sui`; `btc` and `xrp` are rejected with a pointer to the external faucets) sends 100 USDC and 100 USDT to that address; native gas is never dripped. In intents mode, `assets:["sol"]` (or `stellar`, `sui`, `base`, `arb`, `eth`, `bridged`) credits that chain's bridged test tokens, including verifier-only test SOL (0.05), XLM (5) and SUI (0.5).

Claim on this page or at https://app.usetidepool.tech/faucet. Direct `POST /v0/faucet` calls answer **403 `site_only`**. See the [API reference](/docs/api-reference/tidepool-faucet).
