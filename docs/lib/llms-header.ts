import { BRAND, SITE } from '@/lib/seo';

// Header prepended to /llms.txt and /llms-full.txt so an agent understands Tidepool at a glance.
export const llmsHeader = `# ${BRAND.name}: ${BRAND.tagline}

> ${BRAND.description} ${BRAND.affiliationLong} Testnet only: tokens have no value.

- No sign-up, no API key. Call the API directly; any X-API-Key or Bearer value is accepted (it just selects the lower fee tier). Only /v0/account/* needs a real token (/v0/orders needs a token or any X-API-Key value), which you get instantly by signing a message with your own wallet via POST /v0/auth/authenticate. It only ever shows that wallet's own data.
- What: a NEAR Intents 1Click sandbox, a testnet-compatible version of the 1Click API. Use it as a free 1Click testnet endpoint and a 1Click API alternative for development, CI and agents, then switch the base URL to mainnet 1Click for production.
- Status: ${BRAND.affiliation}.
- Base URL: ${SITE} (drop-in for the 1Click API base URL; same 1Click v0 endpoints and field names: tokens, quote, deposit/submit, status, generate-intent, submit-intent, orders, any-input/withdrawals, auth, account)
- Agent API (free key, no human needed): POST ${SITE}/v1/keys returns an naa_ key instantly. Testnet policy-bound agent wallets (swap, transfer, deposit, balances, history, withdraw to NEAR or, for bridged USDC/USDT, to Base/Arbitrum/Ethereum Sepolia) with owner-signed grants and policies, plus /v1/releases/latest; not supported: confidential mode, passkey/EVM owners, shielding, approvals, scheduled executions, withdraws to Solana/Stellar/Sui/BTC/XRP; works with the official @near-intents-agent-api/sdk by setting baseUrl to ${SITE}. Quickstart with curl: ${SITE}/docs/guides/agent-api (Markdown: ${SITE}/docs/guides/agent-api.md). Spec: ${SITE}/v1/openapi.json. One-command end-to-end test: curl -s ${SITE}/v1/e2e.js -o e2e.mjs && node e2e.mjs ${SITE}
- Quickstart: ${SITE}/docs/quickstart (Markdown: ${SITE}/docs/quickstart.md)
- Free test tokens: POST ${SITE}/v0/faucet {"accountId":"you.testnet","mode":"wallet"|"intents"}, or {"chain":"base"|"arb"|"eth","address":"0x..."} on EVM testnets, {"chain":"sol","address":"<base58>"} on Solana devnet (USDC/USDT, not SOL), {"chain":"stellar","address":"G..."} on Stellar testnet (USDC/USDT, needs trustlines), {"chain":"sui","address":"0x<64 hex>"} on Sui testnet (USDC/USDT). Native BTC and XRP are never dripped (chain btc answers 400 with the external faucet: cypherfaucet.com/btc-testnet or testnet4.info for tBTC; chain xrp answers 400 and points to the official faucet faucet.altnet.rippletest.net)
- Test bridges (trusted relayer run by Tidepool, testnet only): Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia, plus Solana devnet (custodial, SOL capped at 0.005 SOL; listed only while live: ${SITE}/docs/guides/bridge-solana-devnet), and Stellar testnet (custodial, XLM capped at 100 XLM, depositMode MEMO; listed only while live: ${SITE}/docs/guides/bridge-stellar-testnet), and Sui testnet (custodial, SUI capped at 10 SUI, per-quote deposit addresses, no memo; listed only while live: ${SITE}/docs/guides/bridge-sui-testnet), and Bitcoin testnet4 (native tBTC, nep141:btc.tp-omft.testnet, capped at 0.005 BTC, per-quote tb1q... deposit addresses, no memo, 1 confirmation: ${SITE}/docs/guides/bridge-bitcoin-testnet), and XRP Ledger testnet (native XRP, nep141:xrp.tp-omft.testnet, capped at 100 XRP, depositMode MEMO required with the depositMemo as the Payment DestinationTag: ${SITE}/docs/guides/bridge-xrp-testnet). ${SITE}/docs/guides/bridges
- OpenAPI: ${SITE}/openapi.json · Agent rules: ${SITE}/AGENTS.md · Full docs in one file: ${SITE}/llms-full.txt
- Health: ${SITE}/v0/health
- Web app (testnet swap/bridge UI built on this API, https://app.usetidepool.tech): not needed for API use; humans can use it to try swaps and the faucet in a browser.
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
