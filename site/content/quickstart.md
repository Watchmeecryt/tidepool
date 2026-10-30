# Quickstart

Tidepool speaks the 1Click Swap API (OpenAPI v0.1.10) shape on NEAR testnet. If you already have a 1Click client, change the base URL to `{{ORIGIN}}` and use the testnet asset ids from `/v0/tokens`.

## 1. List tokens

```bash
curl {{ORIGIN}}/v0/tokens
```

Each token has an `assetId` such as `nep141:usdc.{{ROOT}}`. Use those ids in quotes. The complete live response (all tokens, every field) is in the [tokens reference](/docs/api-reference/get-tokens).

## 2. Ask for a dry quote

A dry quote prices the swap without creating a deposit address.

```bash
curl -X POST {{ORIGIN}}/v0/quote \
  -H 'content-type: application/json' \
  -d '{
    "dry": true,
    "swapType": "EXACT_INPUT",
    "slippageTolerance": 100,
    "originAsset": "nep141:usdc.{{ROOT}}",
    "depositType": "INTENTS",
    "destinationAsset": "nep141:wnear.{{ROOT}}",
    "amount": "10000000",
    "refundTo": "alice.testnet",
    "refundType": "INTENTS",
    "recipient": "alice.testnet",
    "recipientType": "DESTINATION_CHAIN",
    "deadline": "2030-01-01T00:00:00.000Z"
  }'
```

`amount` is in base units (USDC has 6 decimals, so `10000000` is 10 USDC). `slippageTolerance` is in basis points.

Real response (a dry quote, taken live on 2026-10-30; prices move, so your numbers will differ):

```json
{
  "correlationId": "a0e51424-8cfa-4fc3-b967-c8ca464a69fa",
  "timestamp": "2026-10-30T16:35:05.469Z",
  "quoteRequest": {
    "dry": true,
    "swapType": "EXACT_INPUT",
    "slippageTolerance": 100,
    "originAsset": "nep141:usdc.{{ROOT}}",
    "depositType": "INTENTS",
    "destinationAsset": "nep141:wnear.{{ROOT}}",
    "amount": "10000000",
    "refundTo": "alice.testnet",
    "refundType": "INTENTS",
    "recipient": "alice.testnet",
    "recipientType": "DESTINATION_CHAIN",
    "deadline": "2030-01-01T00:00:00.000Z"
  },
  "quote": {
    "amountIn": "10000000",
    "amountInFormatted": "10",
    "amountInUsd": "9.9981",
    "minAmountIn": "10000000",
    "amountOut": "2303964921296296107520000",
    "amountOutFormatted": "2.30396492129629610752",
    "amountOutUsd": "9.9531",
    "minAmountOut": "2280925272083333146444800",
    "timeEstimate": 10
  },
  "signature": "ed25519:MjBxpwWWze1Ng4WGtD5euszcGEN1Lgo7eaQQaRTcYV4fdmuTmR8k3wtaZsrB9ES69NFMcydQKaBy6EBYMQGCZqW"
}
```

This is the complete body: `correlationId`, `timestamp`, `quoteRequest` (your request echoed, with defaults filled in), `quote` and `signature`. A dry quote has no `depositAddress`, `deadline` or `timeWhenInactive`. The twelve fields above are the required ones; every optional field (`appFees`, `referral`, `depositMode`, `quoteWaitingTimeMs`, `connectedWallets`, `sessionId`, `virtualChainRecipient`, `virtualChainRefundRecipient`, `customRecipientMsg`, `confidentiality`, `ondoTokens`) is in the [full request on Swap types](/docs/concepts/swap-types#all-request-fields).

## 3. Go live

Send the same request with `"dry": false` and a deadline a few minutes ahead. The response's `quote.depositAddress` is a fresh account that only this quote uses. Deposit `quote.amountIn` of the origin token to it, then poll:

```bash
curl "{{ORIGIN}}/v0/status?depositAddress=<depositAddress>"
```

See [First swap in 5 minutes](/docs/guides/first-swap) for the deposit step.

## Auth

Auth is optional. Any `X-API-Key` header or `Authorization: Bearer <token>` value is accepted, so a dummy JWT works. A key selects the lower fee tier, the same way it does on mainnet 1Click:

| | No key | Any key |
| --- | --- | --- |
| Most pairs | 45 bps | 20 bps |
| Stable to stable (USDC/USDT) | 26 bps | 1 bp |

## How it differs from mainnet

- NEAR tokens are Tidepool test tokens on NEAR testnet. Tokens bridged from Base, Arbitrum and Ethereum Sepolia, Solana devnet, Stellar testnet, Sui testnet, Bitcoin testnet4, XRP Ledger testnet also appear in `/v0/tokens`, with their own `blockchain`.
- Supported: `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, `ANY_INPUT`; deposit and refund types `ORIGIN_CHAIN` and `INTENTS`; recipient types `DESTINATION_CHAIN` and `INTENTS`; `appFees`; `depositMode: MEMO` (NEAR-native, Stellar and XRP `ORIGIN_CHAIN` deposits only; Stellar and XRP require it); `/v0/auth/*`.
- Confidentiality: the `confidentiality` quote parameter is accepted and ignored, so every swap settles publicly on the testnet verifier and `swapDetails.nearTxHashes` includes the swap's own hash. The `CONFIDENTIAL_INTENTS` deposit, refund and recipient types are a separate thing: they are not supported and `POST /v0/quote` returns 400. On mainnet, 1Click now settles every swap confidentially and `nearTxHashes` lists only the shield and unshield transactions ([NEAR's Oct 27, 2026 update](https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md)). Confidential settlement runs on NEAR's private infrastructure, which isn't exposed to outside builders. Rely on `status`, not on a swap hash.
- One maker (Tidepool's) fills every quote. There is no solver competition.
- `signature` on a quote is Tidepool's maker key over the quote body, not 1Click's.
