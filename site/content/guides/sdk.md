# Use the official 1Click SDK

The official TypeScript client, [`@defuse-protocol/one-click-sdk-typescript`](https://www.npmjs.com/package/@defuse-protocol/one-click-sdk-typescript), works against Tidepool unchanged. Point `OpenAPI.BASE` at Tidepool and use the same calls. We tested `getTokens`, `getQuote` and `getExecutionStatus` with SDK version 0.1.26. To verify a quote, call `verifyQuoteSignature` with [Tidepool's maker public key](/docs/guides/verify-quote-signatures); the SDK default is 1Click's key and will not match.

```bash
npm i @defuse-protocol/one-click-sdk-typescript
```

```ts
import { OpenAPI, OneClickService, QuoteRequest } from '@defuse-protocol/one-click-sdk-typescript';

OpenAPI.BASE = '{{ORIGIN}}';          // the only change; remove it to go to mainnet
// OpenAPI.TOKEN = 'any-dummy-jwt';   // optional: selects the lower fee tier

const tokens = await OneClickService.getTokens();

const quote = await OneClickService.getQuote({
  dry: false,
  swapType: QuoteRequest.swapType.EXACT_INPUT,
  slippageTolerance: 100,
  originAsset: 'nep141:usdc.{{ROOT}}',
  destinationAsset: 'nep141:wnear.{{ROOT}}',
  amount: '5000000',
  depositType: QuoteRequest.depositType.INTENTS,
  refundTo: 'you.testnet',
  refundType: QuoteRequest.refundType.INTENTS,
  recipient: 'you.testnet',
  recipientType: QuoteRequest.recipientType.INTENTS,
  deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
});

// Deposit to quote.quote.depositAddress (see First swap), then:
await OneClickService.submitDepositTx({ txHash: '<your tx hash>', depositAddress: quote.quote.depositAddress! });
const status = await OneClickService.getExecutionStatus(quote.quote.depositAddress!);
console.log(status.status); // PENDING_DEPOSIT → PROCESSING → SUCCESS | REFUNDED
```

> Asset ids differ from mainnet: Tidepool tokens live under `{{ROOT}}`. Read them from `getTokens()` instead of hardcoding mainnet ids.
