import { BRAND, SITE } from '@/lib/seo';

// Header prepended to /llms.txt and /llms-full.txt so an agent understands Tidepool at a glance.
export const llmsHeader = `# ${BRAND.name}: ${BRAND.tagline}

> ${BRAND.description} ${BRAND.affiliationLong} Testnet only: tokens have no value.

- No sign-up, no API key. Call the API directly; any X-API-Key or Bearer value is accepted (it just selects the lower fee tier). Only /v0/account/* needs a token, which you get instantly by signing a message with your own wallet via POST /v0/auth/authenticate. It only ever shows that wallet's own data.
- What: a NEAR Intents 1Click sandbox, a testnet-compatible version of the 1Click API. Use it as a free 1Click testnet endpoint and a 1Click API alternative for development, CI and agents, then switch the base URL to mainnet 1Click for production.
- Status: ${BRAND.affiliation}.
- Base URL: ${SITE} (drop-in for the 1Click API base URL; same 1Click v0 endpoints and field names: tokens, quote, deposit/submit, status, generate-intent, submit-intent, orders, any-input/withdrawals, auth, account)
- Quickstart: ${SITE}/docs/quickstart (Markdown: ${SITE}/docs/quickstart.md)
- Free test tokens: POST ${SITE}/v0/faucet {"accountId":"you.testnet","mode":"wallet"|"intents"}, or {"chain":"base"|"arb"|"eth","address":"0x..."} on EVM testnets
- Test bridges (trusted relayer run by Tidepool, testnet only): Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia. ${SITE}/docs/guides/bridges
- OpenAPI: ${SITE}/openapi.json · Agent rules: ${SITE}/AGENTS.md · Full docs in one file: ${SITE}/llms-full.txt
- Health: ${SITE}/v0/health
- Contact / built by: ${BRAND.builderHandle} (${BRAND.builderUrl})
- Trust model: community-operated testnet; Tidepool runs the only maker and derives deposit-address keys. Never send real assets. ${SITE}/docs/resources/trust-model
- Compatibility vs mainnet 1Click: ${SITE}/docs/resources/compatibility
- Settlement distinction: since 2026-10-27 mainnet 1Click settles every swap confidentially and swapDetails.nearTxHashes lists only shield/unshield (https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md). Tidepool testnet swaps settle publicly, so nearTxHashes includes the swap hash; confidential settlement runs on NEAR's private infrastructure, which isn't exposed to outside builders. Rely on status, not on a swap hash.
- Dev prompt for coding agents: ${SITE}/docs/guides/agents#prompt-snippet
- Runnable examples (MIT): https://github.com/zer0plugyut-afk/tidepool-examples (conformance report: CONFORMANCE.md)

Quick try:
    curl ${SITE}/v0/tokens
    curl -X POST ${SITE}/v0/quote -H 'content-type: application/json' -d '{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":"nep141:usdc.tidepool-sandbox.testnet","depositType":"INTENTS","destinationAsset":"nep141:wnear.tidepool-sandbox.testnet","amount":"10000000","refundTo":"alice.testnet","refundType":"INTENTS","recipient":"alice.testnet","recipientType":"DESTINATION_CHAIN","deadline":"2030-01-01T00:00:00.000Z"}'

`;
