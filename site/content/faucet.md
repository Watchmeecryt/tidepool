# Faucet

Get Tidepool test tokens on NEAR testnet, or test USDC and USDT on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Solana devnet, Stellar testnet and Sui testnet. Native BTC and ZEC are never dripped: use the external testnet faucets in the [Bitcoin](/docs/guides/bridge-bitcoin-testnet) and [Zcash](/docs/guides/bridge-zcash-testnet) guides. See [How the faucet works](/docs/guides/faucet).

<div id="faucet-widget"></div>

| Token (intents balance; `assets` ids or chain aliases) | Per drip |
| --- | --- |
{{DRIPS}}

**Wallet** mints NEP-141 tokens to your account (the account must exist). **Intents** credits your balance inside the Tidepool verifier `{{VERIFIER}}`, ready for an `INTENTS` deposit. The account does not need to exist on chain for this mode.

Other chains: `{"chain":"base","address":"0x…"}` (also `eth`, `arb`, `sol`, `stellar`, `sui`; `btc` and `zec` are rejected with a pointer to the external faucets) sends 100 USDC and 100 USDT to that address; native gas is never dripped. In intents mode, `assets:["sol"]` (or `stellar`, `sui`, `base`, `arb`, `eth`, `bridged`) credits that chain's bridged test tokens, including verifier-only test SOL (0.05), XLM (5) and SUI (0.5).

API: `POST /v0/faucet` with `{"accountId":"alice.testnet","mode":"wallet"}`. See the [API reference](/docs/api).
