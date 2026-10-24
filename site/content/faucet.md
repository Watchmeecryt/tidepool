# Faucet

Get every Tidepool test token on NEAR testnet. One drip per account and mode per hour.

<div id="faucet-widget"></div>

| Token | Per drip |
| --- | --- |
{{DRIPS}}

**Wallet** mints NEP-141 tokens to your account (the account must exist). **Intents** credits your balance inside the Tidepool verifier `{{VERIFIER}}`, ready for an `INTENTS` deposit. The account does not need to exist on chain for this mode.

API: `POST /v0/faucet` with `{"accountId":"alice.testnet","mode":"wallet"}`. See the [API reference](/docs/api).
