# First swap in 5 minutes

You need a NEAR testnet account. If you do not have one, create it in a testnet wallet or with `near-cli-rs`.

## 1. Get test tokens (30 seconds)

Claim test tokens on the [faucet page](/docs/guides/faucet) or at [app.usetidepool.tech/faucet](https://app.usetidepool.tech/faucet). Direct `POST /v0/faucet` calls answer **403 `site_only`**.

`mode: "wallet"` mints every test token to your account. `mode: "intents"` credits your balance inside the Tidepool verifier instead, so you can deposit with an in-verifier transfer.

## 2. Get a live quote

```bash
DEADLINE=$(date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST {{ORIGIN}}/v0/quote -H 'content-type: application/json' -d '{
  "dry": false, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
  "originAsset": "nep141:usdc.{{ROOT}}", "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "nep141:wnear.{{ROOT}}", "amount": "5000000",
  "refundTo": "alice.testnet", "refundType": "ORIGIN_CHAIN",
  "recipient": "alice.testnet", "recipientType": "DESTINATION_CHAIN",
  "deadline": "'$DEADLINE'"}' | tee quote.json
```


Real response (live, 2026-10-30; the quote expired unpaid after its ten-minute deadline):

```json
{
  "correlationId": "fa54c0a7-b72d-44f0-925b-7a16c57db9fb",
  "timestamp": "2026-10-30T16:35:05.964Z",
  "quoteRequest": {
    "dry": false,
    "swapType": "EXACT_INPUT",
    "slippageTolerance": 100,
    "originAsset": "nep141:usdc.{{ROOT}}",
    "depositType": "ORIGIN_CHAIN",
    "destinationAsset": "nep141:wnear.{{ROOT}}",
    "amount": "5000000",
    "refundTo": "alice.testnet",
    "refundType": "ORIGIN_CHAIN",
    "recipient": "alice.testnet",
    "recipientType": "DESTINATION_CHAIN",
    "deadline": "2026-10-30T16:45:05Z"
  },
  "quote": {
    "amountIn": "5000000",
    "amountInFormatted": "5",
    "amountInUsd": "4.9991",
    "minAmountIn": "5000000",
    "amountOut": "1151982460648148053760000",
    "amountOutFormatted": "1.15198246064814805376",
    "amountOutUsd": "4.9766",
    "minAmountOut": "1140462636041666573222400",
    "timeEstimate": 10,
    "depositAddress": "c15f995960c9d8070ad228d7868662672dfc06c1d30397417e859c8733722f1b",
    "deadline": "2026-10-30T16:45:05.000Z",
    "timeWhenInactive": "2026-10-30T16:45:05.000Z"
  },
  "signature": "ed25519:55u8wcnQSLLmBWRUeP7VkdXNP3gT68tQn1uohU7j3cx7wjJnCmwbYLbzXvWvhMeNG1dhV39BfLBUB4Ux8iz5kD11"
}
```

The request has all twelve required fields. For the optional ones see [Swap types](/docs/concepts/swap-types#all-request-fields). `quote.depositAddress` is where you send `quote.amountIn` of the origin token.

## 3. Deposit

With `depositType: "ORIGIN_CHAIN"`, send the origin token straight to the deposit address. Register its storage first (it is a fresh account):

```bash
near contract call-function as-transaction usdc.{{ROOT}} storage_deposit \
  json-args '{"account_id":"<depositAddress>","registration_only":true}' \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as alice.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction usdc.{{ROOT}} ft_transfer \
  json-args '{"receiver_id":"<depositAddress>","amount":"5000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as alice.testnet network-config testnet sign-with-keychain send
```

Or, with `depositType: "INTENTS"`, deposit into the verifier for the deposit address in one call, no storage step needed:

```bash
near contract call-function as-transaction usdc.{{ROOT}} ft_transfer_call \
  json-args '{"receiver_id":"{{VERIFIER}}","amount":"5000000","msg":"<depositAddress>"}' \
  prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as alice.testnet network-config testnet sign-with-keychain send
```

Optionally tell Tidepool about the tx:

```bash
curl -X POST {{ORIGIN}}/v0/deposit/submit -H 'content-type: application/json' \
  -d '{"txHash":"<hash>","depositAddress":"<depositAddress>"}'
```

Optional body fields: `memo` (the quote's `depositMemo`, for MEMO deposits) and `nearSenderAccount` (NEAR-native MEMO deposits). A real, complete response, with the full SUCCESS status object, is in the [deposit/submit reference](/docs/api-reference/submit-deposit-tx).

## 4. Watch it settle

```bash
curl "{{ORIGIN}}/v0/status?depositAddress=<depositAddress>"
```

Real response right after the quote above, before any deposit:

```json
{
  "correlationId": "fa54c0a7-b72d-44f0-925b-7a16c57db9fb",
  "quoteResponse": {
    "correlationId": "fa54c0a7-b72d-44f0-925b-7a16c57db9fb",
    "timestamp": "2026-10-30T16:35:05.964Z",
    "quoteRequest": {
      "dry": false,
      "swapType": "EXACT_INPUT",
      "slippageTolerance": 100,
      "originAsset": "nep141:usdc.{{ROOT}}",
      "depositType": "ORIGIN_CHAIN",
      "destinationAsset": "nep141:wnear.{{ROOT}}",
      "amount": "5000000",
      "refundTo": "alice.testnet",
      "refundType": "ORIGIN_CHAIN",
      "recipient": "alice.testnet",
      "recipientType": "DESTINATION_CHAIN",
      "deadline": "2026-10-30T16:45:05Z"
    },
    "quote": {
      "amountIn": "5000000",
      "amountInFormatted": "5",
      "amountInUsd": "4.9991",
      "minAmountIn": "5000000",
      "amountOut": "1151982460648148053760000",
      "amountOutFormatted": "1.15198246064814805376",
      "amountOutUsd": "4.9766",
      "minAmountOut": "1140462636041666573222400",
      "timeEstimate": 10,
      "depositAddress": "c15f995960c9d8070ad228d7868662672dfc06c1d30397417e859c8733722f1b",
      "deadline": "2026-10-30T16:45:05.000Z",
      "timeWhenInactive": "2026-10-30T16:45:05.000Z"
    },
    "signature": "ed25519:55u8wcnQSLLmBWRUeP7VkdXNP3gT68tQn1uohU7j3cx7wjJnCmwbYLbzXvWvhMeNG1dhV39BfLBUB4Ux8iz5kD11"
  },
  "status": "PENDING_DEPOSIT",
  "updatedAt": "2026-10-30T16:35:05.979Z",
  "swapDetails": {
    "intentHashes": [],
    "nearTxHashes": [],
    "originChainTxHashes": [],
    "destinationChainTxHashes": [],
    "withdrawFee": "0"
  },
  "tidepool": {
    "explorer": [],
    "intentsAccount": "c15f995960c9d8070ad228d7868662672dfc06c1d30397417e859c8733722f1b"
  }
}
```

You will see `PENDING_DEPOSIT` or `KNOWN_DEPOSIT_TX`, then `PROCESSING`, then `SUCCESS` with `swapDetails.nearTxHashes`. Open them on [NearBlocks testnet](https://testnet.nearblocks.io).

## What happens if it goes wrong

- **Deposit too small or late:** when the deadline passes, everything deposited goes back to `refundTo` and the status becomes `REFUNDED` with `refundReason: "PARTIAL_DEPOSIT"`.
- **Price moved past your slippage:** refunded with `SLIPPAGE_EXCEEDED` (Tidepool-specific reason).
- **More than `amountIn` deposited:** the swap uses `amountIn` and the excess is refunded in the same transaction.
