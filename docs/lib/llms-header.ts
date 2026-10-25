import { BRAND, SITE } from '@/lib/seo';

// Header prepended to /llms.txt and /llms-full.txt so an agent understands Tidepool at a glance.
export const llmsHeader = `# ${BRAND.name}: ${BRAND.tagline}

> ${BRAND.description} ${BRAND.affiliationLong} Testnet only: tokens have no value.

- What: a NEAR Intents 1Click sandbox, a testnet-compatible version of the 1Click API. Use it as a free 1Click testnet endpoint and a 1Click API alternative for development, CI and agents, then switch the base URL to mainnet 1Click for production.
- Status: ${BRAND.affiliation}.
- Base URL: ${SITE} (drop-in for the 1Click API base URL; same /v0/tokens, /v0/quote, /v0/deposit/submit, /v0/status endpoints and field names)
- Quickstart: ${SITE}/docs/quickstart (Markdown: ${SITE}/docs/quickstart.md)
- Free test tokens: POST ${SITE}/v0/faucet {"accountId":"you.testnet","mode":"wallet"|"intents"}
- OpenAPI: ${SITE}/openapi.json · Agent rules: ${SITE}/AGENTS.md · Full docs in one file: ${SITE}/llms-full.txt
- Health: ${SITE}/v0/health

Quick try:
    curl ${SITE}/v0/tokens
    curl -X POST ${SITE}/v0/quote -H 'content-type: application/json' -d '{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":"nep141:usdc.tidepool-sandbox.testnet","depositType":"INTENTS","destinationAsset":"nep141:wnear.tidepool-sandbox.testnet","amount":"10000000","refundTo":"alice.testnet","refundType":"INTENTS","recipient":"alice.testnet","recipientType":"DESTINATION_CHAIN","deadline":"2030-01-01T00:00:00.000Z"}'

`;
