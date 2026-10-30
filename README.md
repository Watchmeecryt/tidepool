# Tidepool

A 1Click-compatible testnet sandbox for NEAR Intents. Community-built and not affiliated with NEAR or 1Click. Testnet tokens have no value.

- `contracts/verifier/`: the official, unmodified `defuse` wasm from the near/intents `defuse/v0.4.2` release, with its sha256.
- `contracts/token/`: a minimal NEP-141 test token (owner mint, auto storage registration).
- `server/`: the HTTP API (1Click v0.1.10 shapes: `/v0/tokens`, `/v0/quote`, `/v0/deposit/submit`, `/v0/status`, plus intents, orders, auth and account endpoints), the maker/settlement worker, the faucet and the testnet bridges (Base, Arbitrum and Ethereum Sepolia, Solana devnet, Stellar testnet, Sui testnet, Bitcoin testnet4 and XRP Ledger testnet).
- `docs/`: the docs site (Next.js + Fumadocs, static export served by the server). The API reference pages are generated from `site/public/openapi.json` at build time.
- `site/`: `openapi.json` and static assets, plus Markdown that is only a fallback if the docs build is missing.
- `scripts/`: idempotent testnet bootstrap.
- Web app: [app.usetidepool.tech](https://app.usetidepool.tech), a swap/bridge UI for the testnet (separate repo, a static client of this API).
- `examples/swap.mjs`: an end-to-end swap (intents, `--origin`, `--refund`). More runnable scripts are in the public [tidepool-examples](https://github.com/zer0plugyut-afk/tidepool-examples) repo.

## Run

```bash
cd server && npm ci
TIDEPOOL_KEYS='{"<root>":"ed25519:...","<maker>":"ed25519:..."}' DEPOSIT_MASTER_SEED=<hex> PORT=8787 node src/index.mjs
```

Keys are read from environment variables only (in production, Railway variables). Never commit keys.
