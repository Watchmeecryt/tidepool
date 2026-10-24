# Quickstart

Tidepool speaks the 1Click Swap API (OpenAPI v0.1.10) shape on NEAR testnet. If you already have a 1Click client, change the base URL to `{{ORIGIN}}` and use the testnet asset ids from `/v0/tokens`.

## 1. List tokens

```bash
curl {{ORIGIN}}/v0/tokens
```

Each token has an `assetId` such as `nep141:usdc.{{ROOT}}`. Use those ids in quotes.

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

- Tokens are Tidepool test tokens on NEAR testnet, not bridged assets. Only `blockchain: "near"` exists.
- Supported: `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`; deposit and refund types `ORIGIN_CHAIN` and `INTENTS`; recipient types `DESTINATION_CHAIN` and `INTENTS`. `ANY_INPUT`, `CONFIDENTIAL_INTENTS`, `appFees`, `depositMode: MEMO` and `/v0/auth/*` return 400 or 404.
- One maker (Tidepool's) fills every quote. There is no solver competition.
- `signature` on a quote is Tidepool's maker key over the quote body, not 1Click's.
