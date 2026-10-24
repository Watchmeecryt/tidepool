# Tidepool

**A 1Click-compatible testnet sandbox for NEAR Intents.** Community-built and unaffiliated with NEAR or 1Click.

<div class="features">
<div class="feature"><b>Real verifier</b><span>The official, unmodified intents contract (<a href="{{RELEASE}}">defuse v0.4.2</a>) on NEAR testnet.</span></div>
<div class="feature"><b>Same API shapes</b><span>Tokens, quote, deposit/submit and status match the 1Click Swap API v0.1.10. The official SDK works as is.</span></div>
<div class="feature"><b>Real fills, real refunds</b><span>A live maker fills your quotes on-chain. Missed deadlines refund automatically.</span></div>
<div class="feature"><b>Free test tokens</b><span>USDC, USDT, wNEAR, wBTC, ETH and XAUT from the faucet, to a wallet or straight into the verifier.</span></div>
</div>

## How it works

<figure class="flow">
<svg viewBox="0 0 860 210" role="img" aria-label="Your app asks for a quote, deposits to the quote's address, the verifier settles with the maker, and the output lands with your recipient">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#14a08f"/></marker></defs>
<g font-family="Figtree,sans-serif" text-anchor="middle">
<rect x="10" y="60" width="150" height="80" rx="16" fill="#fff" stroke="#cfe6e1"/><text x="85" y="95" font-size="16" font-weight="600" fill="#0b4f4a">Your app</text><text x="85" y="117" font-size="12.5" fill="#557471">wallet or agent</text>
<rect x="230" y="60" width="160" height="80" rx="16" fill="#fff" stroke="#cfe6e1"/><text x="310" y="95" font-size="16" font-weight="600" fill="#0b4f4a">Deposit address</text><text x="310" y="117" font-size="12.5" fill="#557471">one per quote</text>
<rect x="460" y="50" width="170" height="100" rx="18" fill="#0f766e"/><text x="545" y="95" font-size="16" font-weight="600" fill="#fff">Intents verifier</text><text x="545" y="117" font-size="12.5" fill="#cdeee8">official contract</text>
<rect x="700" y="10" width="150" height="70" rx="16" fill="#e6f4f1" stroke="#cfe6e1"/><text x="775" y="42" font-size="15" font-weight="600" fill="#0b4f4a">Maker</text><text x="775" y="62" font-size="12" fill="#557471">fills the quote</text>
<rect x="700" y="120" width="150" height="70" rx="16" fill="#fff" stroke="#cfe6e1"/><text x="775" y="152" font-size="15" font-weight="600" fill="#0b4f4a">Recipient</text><text x="775" y="172" font-size="12" fill="#557471">wallet or intents</text>
<path d="M160 100H226" stroke="#14a08f" stroke-width="2" marker-end="url(#ar)"/><text x="193" y="88" font-size="12" fill="#0f766e">1 · deposit</text>
<path d="M390 100H456" stroke="#14a08f" stroke-width="2" marker-end="url(#ar)"/><text x="423" y="88" font-size="12" fill="#0f766e">2 · sweep</text>
<path d="M630 80L696 52" stroke="#14a08f" stroke-width="2" marker-end="url(#ar)"/><path d="M698 62L632 90" stroke="#14a08f" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#ar)"/><text x="660" y="40" font-size="12" fill="#0f766e">3 · settle</text>
<path d="M630 125L696 152" stroke="#14a08f" stroke-width="2" marker-end="url(#ar)"/><text x="655" y="165" font-size="12" fill="#0f766e">4 · pay out</text>
</g></svg>
<figcaption>Ask <code>/v0/quote</code> for a price and a deposit address, send tokens there, and poll <code>/v0/status</code>. If the deadline passes or settlement fails, the deposit goes back to <code>refundTo</code>.</figcaption>
</figure>

## Quickstart in 3 steps

<div class="steps">
<div class="step"><i>1</i><b>Get test tokens</b><span>Use the <a href="/faucet">faucet</a> with any testnet account.</span></div>
<div class="step"><i>2</i><b>Ask for a quote</b><span>Same body as 1Click. A live quote returns a deposit address.</span></div>
<div class="step"><i>3</i><b>Deposit and watch</b><span>Send the tokens, then poll status until <code>SUCCESS</code>.</span></div>
</div>

```bash
# 2 · a dry quote: 10 USDC to wNEAR
curl -s {{ORIGIN}}/v0/quote -H 'content-type: application/json' -d '{
  "dry": true, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
  "originAsset": "nep141:usdc.{{ROOT}}", "destinationAsset": "nep141:wnear.{{ROOT}}",
  "amount": "10000000", "depositType": "INTENTS", "refundType": "INTENTS", "recipientType": "INTENTS",
  "refundTo": "you.testnet", "recipient": "you.testnet",
  "deadline": "2030-01-01T00:00:00Z" }'
```

Set `"dry": false` for a deposit address, then follow [First swap in 5 minutes](/docs/guides/first-swap). Prefer TypeScript? The [official 1Click SDK](/docs/guides/sdk) works by changing one line.

## Details

- **Base URL:** `{{ORIGIN}}`
- **Verifier:** [`{{VERIFIER}}`](https://testnet.nearblocks.io/address/{{VERIFIER}}), wasm sha256 `{{SHA}}` (checked live on [status](/status))
- **Network:** NEAR testnet. Test tokens have no value.
- **Machine-readable:** [`/openapi.json`](/openapi.json), [`/llms.txt`](/llms.txt), [`/AGENTS.md`](/AGENTS.md)
