# Tidepool for agents

Tidepool is built to be read and used by coding agents and autonomous agents.

## Files for agents

- [`/llms.txt`](/llms.txt): an index of every page with a one-line summary.
- [`/llms-full.txt`](/llms-full.txt): every page in one plain-text file.
- [`/AGENTS.md`](/AGENTS.md): rules of the road for agents that call the API.
- [`/openapi.json`](/openapi.json): the machine-readable API.
- Any docs page as Markdown: add `.md` to its URL, for example [`/docs/quickstart.md`](/docs/quickstart.md).

## A full swap from a script

The public [tidepool-examples](https://github.com/Watchmeecryt/tidepool-examples) repo ships `npm run first-swap`. It uses a fresh testnet account, so it needs no setup beyond Node 20:

```bash
git clone https://github.com/Watchmeecryt/tidepool-examples && cd tidepool-examples && npm install
npm run first-swap              # faucet → quote → deposit → status → SUCCESS
npm run failure-cases partial   # deposit too little, wait for REFUNDED
```

What it does:

1. Creates a throwaway testnet account through the public testnet helper.
2. Expects test tokens to already be in the account (claim them on the [site faucet](https://app.usetidepool.tech/faucet); `POST /v0/faucet` answers 403 `site_only`).
3. Calls `POST /v0/quote` with `dry: false` and `depositType: "INTENTS"`.
4. Deposits with a signed NEP-413 `transfer` intent to the deposit address. The script submits it with `execute_intents` from its own account, so it pays its own gas.
5. Calls `POST /v0/deposit/submit`, then polls `GET /v0/status` until `SUCCESS` or `REFUNDED`.

## Rules for agents

- Always get a dry quote first and check `amountOut` and `minAmountOut` before going live.
- Deposit exactly `quote.amountIn`. Under `minAmountIn` waits for more until the deadline, then refunds.
- Poll `/v0/status` every 2 to 5 seconds. Stop on `SUCCESS`, `REFUNDED` or `FAILED`.
- Faucet: claim on the site only (https://app.usetidepool.tech/faucet). Direct API calls answer 403 `site_only`. One Tokens claim per address every 7 days, plus a separate Stocks & RWAs slot. Do not loop on it.
- Native ETH on Ethereum, Base and Arbitrum Sepolia (`nep141:eth.tp-omft.testnet`, `nep141:base.tp-omft.testnet`, `nep141:arb.tp-omft.testnet`) is **capped at 0.006 ETH per swap, payout or refund** (400 at quote time, same cap on `/v1` withdraw; 503 while the treasury is low). ORIGIN_CHAIN deposits and DESTINATION_CHAIN payouts are supported; `ANY_INPUT` ETH origin/destination payouts are rejected. Ask for a small amount, for example gas for a fresh address.
- Never send real assets. Tidepool is testnet only.
