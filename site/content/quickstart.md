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

- NEAR tokens are Tidepool test tokens on NEAR testnet. Tokens bridged from Base, Arbitrum and Ethereum Sepolia, Solana devnet, Stellar testnet, Sui testnet, Bitcoin testnet4 also appear in `/v0/tokens`, with their own `blockchain`.
- Supported: `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, `ANY_INPUT`; deposit and refund types `ORIGIN_CHAIN` and `INTENTS`; recipient types `DESTINATION_CHAIN` and `INTENTS`; `appFees`; `depositMode: MEMO` (NEAR-native and Stellar `ORIGIN_CHAIN` deposits only; Stellar requires it); `/v0/auth/*`.
- Confidentiality: the `confidentiality` quote parameter is accepted and ignored, so every swap settles publicly on the testnet verifier and `swapDetails.nearTxHashes` includes the swap's own hash. The `CONFIDENTIAL_INTENTS` deposit, refund and recipient types are a separate thing: they are not supported and `POST /v0/quote` returns 400. On mainnet, 1Click now settles every swap confidentially and `nearTxHashes` lists only the shield and unshield transactions ([NEAR's Oct 27, 2026 update](https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md)). Confidential settlement runs on NEAR's private infrastructure, which isn't exposed to outside builders. Rely on `status`, not on a swap hash.
- One maker (Tidepool's) fills every quote. There is no solver competition.
- `signature` on a quote is Tidepool's maker key over the quote body, not 1Click's.
