# Tidepool

**A free testnet sandbox for NEAR Intents.** It runs NEAR's official, unmodified Intents verifier (`defuse` v0.4.2) on NEAR testnet and puts an API in front of it that matches the 1Click Swap API (OpenAPI v0.1.10). Point a 1Click client at Tidepool, swap test tokens across NEAR and seven other testnets, and spend no mainnet funds.

- **Live API and docs:** https://www.usetidepool.tech (docs: https://www.usetidepool.tech/docs)
- **Swap app (human UI):** https://app.usetidepool.tech, repo [Watchmeecryt/tidepool-app](https://github.com/Watchmeecryt/tidepool-app)
- **Repo:** https://github.com/Watchmeecryt/tidepool
- **Hackathon:** NEAR HACKATHON, track `open` (Open Innovation; hints: chain abstraction, build your own)
- **License:** MIT ([LICENSE](LICENSE))
- **Built by:** [@realchriswilder](https://x.com/realchriswilder) on X. Community-built, not affiliated with NEAR, Defuse Labs or 1Click. Test tokens have no value.

## Problem

NEAR Intents has no testnet and none is planned (`HACKATHON.md` Q-007). To test an integration against 1Click, a developer has to use mainnet accounts and spend real funds, or only use `dry: true` quotes, which never create a deposit address or settle anything. Tidepool fills that gap: the same request and response shapes, the real verifier contract, real settlement transactions on NEAR testnet, and free tokens from a faucet.

## What is in it

| Piece | Where | What it does |
| --- | --- | --- |
| Verifier | `contracts/verifier/` | NEAR's `defuse` wasm from the `near/intents` `defuse/v0.4.2` release, unmodified, deployed at `verifier.tidepool-sandbox.testnet`. sha256 `f67f9559b3b512c52dfa11723a28b9119bcf773ac01780370d6409e5f1fb20e5`, checked live by `/v0/health`. |
| Test tokens | `contracts/token/` | A minimal NEP-141 token (owner mint, auto storage registration); six NEAR tokens: USDC, USDT, wNEAR, wBTC, ETH, XAUT. |
| API | `server/` | 1Click v0.1.10 shapes: `/v0/tokens`, `/v0/quote`, `/v0/deposit/submit`, `/v0/status`, `/v0/generate-intent`, `/v0/submit-intent`, orders, auth, account and any-input withdrawals, plus `/v0/faucet` and `/v0/health`. Swap types `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, `ANY_INPUT`; `appFees`; `depositMode: MEMO`. |
| Maker | `server/src/engine.mjs` | A real solver that prices from CoinGecko plus a fixed fee and settles each swap with one `execute_intents` call on the verifier. |
| Testnet bridges | `server/src/evm.mjs`, `solana.mjs`, `stellar.mjs`, `sui.mjs`, `utxo.mjs`, `btc.mjs`, `xrp.mjs`, `contracts/evm/`, `scripts/sui-coins/` | Deposits from and payouts to Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Solana devnet, Bitcoin testnet4, Stellar testnet, Sui testnet and XRP Ledger testnet, bridged into the verifier as `nep141:<chain>-….tp-omft.testnet` tokens. 23 tokens in total. |
| Faucet | `server/src/faucet.mjs` | `POST /v0/faucet` drips test tokens to a NEAR account (wallet or verifier balance) or to an address on the other chains. |
| Docs | `docs/` | Fumadocs site (Next.js static export served by the server): quickstart, concepts, one guide per bridge, generated API reference, changelog, trust model. Markdown of every page by appending `.md`. |
| Machine-readable | `site/public/openapi.json`, `server/src/site.mjs` | `/openapi.json`, `/llms.txt`, `/llms-full.txt`, `/AGENTS.md`. |
| Swap app | [tidepool-app](https://github.com/Watchmeecryt/tidepool-app) | Static React client of this API: swap or bridge UI, wallet connect per chain, faucet page. |
| Scripts | `scripts/`, `examples/` | Idempotent testnet bootstrap; `examples/swap.mjs` runs a full swap end to end. |

## Try it (do X - see Y)

Commands call the live API. Supply your own NEAR testnet account (for example `yourname.testnet`) where the steps say `$ME`. Do not use mainnet accounts or assets.

```bash
API=https://www.usetidepool.tech
ME=<your-account>.testnet   # your own NEAR testnet account
```

1. **`curl -s $API/v0/health`** - see `"network":"testnet"`, the verifier account, its wasm sha256 equal to the `defuse` v0.4.2 hash above, and maker and bridge status.
2. **`curl -s $API/v0/tokens`** - see 23 tokens with `assetId` (for example `nep141:usdc.tidepool-sandbox.testnet`), `decimals` and a live USD `price`, across `near`, `eth`, `base`, `arb`, `sol`, `btc`, `stellar`, `sui` and `xrp`.
3. **Get test tokens into your verifier balance:**
   ```bash
   curl -s -X POST $API/v0/faucet -H 'content-type: application/json' \
     -d "{\"accountId\":\"$ME\",\"mode\":\"intents\"}"
   ```
   See a JSON result with `drips` (the six test tokens) and NearBlocks transaction links (one claim per account and mode per hour). Use `"mode":"wallet"` for NEP-141 balances in your wallet instead. Other chains: `{"chain":"base","address":"<your 0x address>"}` (also `eth`, `arb`, `sol`, `stellar`, `sui`); see [Faucet](https://www.usetidepool.tech/docs/guides/faucet).
4. **Price a swap with a dry quote:**
   ```bash
   curl -s -X POST $API/v0/quote -H 'content-type: application/json' -d "{
     \"dry\": true, \"swapType\": \"EXACT_INPUT\", \"slippageTolerance\": 100,
     \"originAsset\": \"nep141:usdc.tidepool-sandbox.testnet\", \"depositType\": \"INTENTS\",
     \"destinationAsset\": \"nep141:wnear.tidepool-sandbox.testnet\", \"amount\": \"10000000\",
     \"refundTo\": \"$ME\", \"refundType\": \"INTENTS\",
     \"recipient\": \"$ME\", \"recipientType\": \"DESTINATION_CHAIN\",
     \"deadline\": \"2030-01-01T00:00:00.000Z\"}"
   ```
   See `quote.amountOut` and `quote.minAmountOut` for 10 USDC (`amount` is in base units) and a `signature`. A dry quote has no `depositAddress`.
5. **Run a full swap in the app.** Open https://app.usetidepool.tech, pick a from-token and a to-token, enter an amount and your own recipient address on the destination chain, connect a wallet (or use the manual deposit address), and confirm. See a live quote and deposit address, then the status move from `PENDING_DEPOSIT` through `PROCESSING` to `SUCCESS`, with a NEAR testnet transaction link. The app's faucet page (https://app.usetidepool.tech/faucet) funds the same accounts.
6. **Run a full swap from the command line (optional).** `cd examples && npm ci && TIDEPOOL_URL=$API node swap.mjs` runs faucet, dry quote, live quote, deposit, `deposit/submit` and status polling until `SUCCESS` (`--origin` for a plain `ft_transfer` deposit, `--refund` to see a `REFUNDED` swap). Set `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY` for your own testnet account; without them the script makes a throwaway testnet account and keeps its key in a gitignored file.
7. **Read the docs:** https://www.usetidepool.tech/docs, then [Quickstart](https://www.usetidepool.tech/docs/quickstart), [First swap](https://www.usetidepool.tech/docs/guides/first-swap), [Bridges](https://www.usetidepool.tech/docs/guides/bridges), [API reference](https://www.usetidepool.tech/docs/api-reference) and [Trust model](https://www.usetidepool.tech/docs/resources/trust-model). Append `.md` to any docs URL for Markdown.
8. **Machine-readable entry points:** `curl -s $API/llms.txt` (index), `$API/llms-full.txt` (all docs in one file), `$API/AGENTS.md` (rules and the swap loop for agents) and `$API/openapi.json` (the spec). No sign-up and no API key; any `X-API-Key` or `Bearer` value is accepted.
9. **See it used by another project:** [NEAR Private OTC](https://github.com/Watchmeecryt/near-private-otc) (live: https://near-private-otc-productio999n.up.railway.app) runs its testnet deals on Tidepool's verifier, faucet and 1Click API (see [Disclosure](#disclosure-q-015)).

## How NEAR fits

- Every swap settles on NEAR testnet through one `execute_intents` call on NEAR's unmodified verifier with two `token_diff` intents, so it is atomic: both legs apply or neither does. Each deposit, settlement and refund is a public testnet transaction listed in `/v0/status`.
- Deposits can arrive on NEAR (`ft_transfer`, `ft_transfer_call`, or a signed intents transfer) or on any of the seven other testnets; payouts can go to any of them. Non-NEAR assets are bridged into the verifier as NEP-141 tokens. This is chain abstraction on a testnet: one API and one verifier balance in front of nine chains.
- Developers can test 1Click clients, `appFees`, `ANY_INPUT`, `MEMO` deposits, refunds and failed swaps (see [Failure cases](https://www.usetidepool.tech/docs/guides/failure-cases)) without mainnet funds. Moving to mainnet is a base-URL and asset-id change ([Mainnet migration](https://www.usetidepool.tech/docs/guides/mainnet-migration)).

## Hackathon track and window

- Track: `open` (Open Innovation). Fits the hints chain abstraction and build your own: a new piece of infrastructure for the NEAR Intents ecosystem that did not exist.
- Window: the hackathon window runs from 2026-10-19 (Q-001) to 2026-11-14. The first commit in this repo is dated 2026-10-24 (`git log --reverse`), so all history is inside the window. There is no pre-hackathon baseline code, except the libraries and upstream contracts listed below.
- Testnet-only projects are eligible (Q-010). The hosted demo (site, API, docs and app) will be kept running until at least 2026-11-18 (Q-012).

## Honest limits

- **Testnet only.** Tokens have no value. Do not send mainnet assets to any address Tidepool shows you.
- **Custodial relayers for non-NEAR chains.** The Ethereum/Base/Arbitrum Sepolia, Solana, Bitcoin, Stellar, Sui and XRP routes use Tidepool-held keys, a vault or treasury and a trusted relayer. No proofs, no light clients. Deposit-address keys are derived on the server. Only the NEAR path is trust-minimized, and even there Tidepool deploys the verifier and the token accounts.
- **Per-chain caps** (a request over the cap answers 400 at quote time): SOL 0.005 per swap, payout or refund; XLM 100; SUI 10; BTC 0.005 (minimum 0.0001); XRP 100. BTC and XRP payout quotes answer 503 while the treasury is low. Native BTC and XRP are never dripped by the faucet.
- **One maker** with finite inventory sets every price (CoinGecko plus a fixed fee); large quotes fail with `Not enough maker liquidity`.
- **Confidentiality is not implemented.** The `confidentiality` request parameter is accepted but ignored: every swap settles publicly. `CONFIDENTIAL_INTENTS` deposit, refund and recipient types answer 400. NEAR's confidential settlement runs on NEAR Private Shard, which is not open to outside builders ([NEAR's update](https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md)). Rely on `status`, not on a swap hash in `swapDetails.nearTxHashes`.
- Faucet limits: one drip per account per mode per hour, one per address per chain per hour, six per IP per hour. State is a JSON file on one server volume; there is no SLA.
- Not affiliated with, endorsed or reviewed by NEAR Foundation, Defuse Labs or 1Click. Full list: [Trust model](https://www.usetidepool.tech/docs/resources/trust-model) and [Compatibility](https://www.usetidepool.tech/docs/resources/compatibility).

## Libraries, templates and upstream code (Q-005)

No project template was used apart from the docs scaffold. Pre-existing and third-party code:

- **NEAR Intents verifier:** `defuse` wasm from [near/intents](https://github.com/near/intents) release `defuse/v0.4.2`, used unmodified (`contracts/verifier/`).
- **Docs** (`docs/package.json`): Next.js 16, React 19, Fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) created with Create Fumadocs, Tailwind CSS 4, Phosphor icons, Biome, `serve`.
- **Server** (`server/package.json`): `near-api-js`, `ethers`, `@mysten/sui`, `@stellar/stellar-base`, `xrpl`, `bitcoinjs-lib`, `bip32`, `ecpair`, `tiny-secp256k1`, `tweetnacl`, `@noble/hashes`, `bs58`, `bs58check`, `@grpc/grpc-js`, `@grpc/proto-loader`, `marked`, `yaml`. Plain Node.js (ESM), no web framework. Prices from CoinGecko.
- **Contracts:** `near-sdk` and `near-contract-standards` 5.29.1 (Rust, NEP-141 token); Solidity 0.8.26 with Foundry (EVM test token and vault); Sui Move (test coins).
- **Scripts and examples:** `near-api-js`, `@mysten/sui`, `@stellar/stellar-base`, `xrpl`, `bs58`, `tweetnacl`.
- **Swap app** ([tidepool-app](https://github.com/Watchmeecryt/tidepool-app)): React 19, Vite, TypeScript, wagmi/viem/RainbowKit, `@hot-labs/near-connect`, Solana wallet adapters, Sui and Stellar SDKs. It is a separate repo created on 2026-10-30.
- **AI assistance:** parts of the code and docs were written with AI coding agents (allowed by Q-005).
- **More examples:** further runnable scripts are in the separate public [tidepool-examples](https://github.com/zer0plugyut-afk/tidepool-examples) repo (not part of this submission).

## Disclosure (Q-015)

The same builder is also submitting a second, independent project to NEAR HACKATHON: **NEAR Private OTC**, track `defi` (a private OTC deal board; repo https://github.com/Watchmeecryt/near-private-otc, live app https://near-private-otc-productio999n.up.railway.app). X handles used: [@realchriswilder](https://x.com/realchriswilder) here, [@log0dev](https://x.com/log0dev) in the OTC README, same person.

They are different products with different problems, users, tracks, code and deployments. Tidepool is general infrastructure any NEAR Intents developer can use. NEAR Private OTC is a separate application that uses Tidepool as its testnet backend, like any other client of the API would. Each repo has its own code, contracts and deployment. This is not the same project submitted twice, and this repo is submitted once.

## Run locally

```bash
cd server && npm ci
TIDEPOOL_KEYS='{"<root>":"ed25519:...","<maker>":"ed25519:..."}' DEPOSIT_MASTER_SEED=<hex> PORT=8787 node src/index.mjs
```

Keys are read from environment variables only (in production, Railway variables). Never commit keys. `scripts/bootstrap.mjs` and `scripts/bridge-*-bootstrap.mjs` set up the testnet accounts and bridges idempotently. Tests: `cd server && npm test`. Docs: `cd docs && npm ci && npm run build`.

## License

MIT, see [LICENSE](LICENSE). Copyright 2026 Akwasi Dodzi.
