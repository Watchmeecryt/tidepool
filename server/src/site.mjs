// Docs site: Markdown pages rendered into a light teal layout, plus the agent files.
import fs from 'node:fs';
import { marked } from 'marked';
import { ROOT, VERIFIER, TOKENS, VERIFIER_WASM_SHA256, VERIFIER_RELEASE } from './config.mjs';

const CONTENT = new URL('../../site/content/', import.meta.url).pathname;
// Branding / affiliation wording lives in docs/brand.json (single source of truth).
const BRAND = JSON.parse(fs.readFileSync(new URL('../../docs/brand.json', import.meta.url)));
const SPEC = JSON.parse(fs.readFileSync(new URL('../../site/public/openapi.json', import.meta.url)));
const NAV = [
  ['/', 'Overview', 'What Tidepool is and what it gives you', 'index.md'],
  ['/docs/quickstart', 'Quickstart', 'Your first quote with curl, auth and fee tiers, and differences from mainnet', 'quickstart.md'],
  ['/docs/guides/first-swap', 'First swap in 5 minutes', 'Faucet, live quote, deposit, status and refunds step by step', 'guides/first-swap.md'],
  ['/docs/guides/agents', 'For agents', 'Agent files, the end-to-end example script and rules for agents', 'guides/agents.md'],
  ['/docs/guides/sdk', 'Official 1Click SDK', 'Use @defuse-protocol/one-click-sdk-typescript against Tidepool by changing the base URL', 'guides/sdk.md'],
  ['/docs/api-reference', 'API reference', 'Every endpoint, parameter and schema, generated from openapi.json', null],
  ['/faucet', 'Faucet', 'Get test tokens to a wallet or into the verifier', 'faucet.md'],
  ['/status', 'Status', 'Live health of the RPC, verifier, price feed and maker', 'status.md'],
];

function fill(md, origin) {
  return md.replaceAll('{{ORIGIN}}', origin).replaceAll('{{ROOT}}', ROOT).replaceAll('{{VERIFIER}}', VERIFIER).replaceAll('{{SHA}}', VERIFIER_WASM_SHA256).replaceAll('{{RELEASE}}', VERIFIER_RELEASE)
    .replaceAll('{{DRIPS}}', TOKENS.map(t => `| ${t.symbol} (\`${t.assetId}\`) | ${t.drip} |`).join('\n'));
}

function schemaRef(s) { return s?.$ref ? s.$ref.split('/').pop() : s?.allOf?.[0]?.$ref ? s.allOf[0].$ref.split('/').pop() : null; }
function typeOf(s) { const r = schemaRef(s); if (r) return `[${r}](#schema-${r.toLowerCase()})`; if (s.type === 'array') return `array of ${typeOf(s.items || {})}`; return s.enum ? `${s.type} (${s.enum.map(e => '`' + e + '`').join(', ')})` : (s.type || 'object'); }
const oneLine = (t = '') => String(t).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
function apiMd(origin) {
  let md = `# API reference\n\nGenerated from [\`/openapi.json\`](/openapi.json) (${SPEC.info.version}). Base URL: \`${origin}\`.\n\n${SPEC.info.description}\n\n## Auth\n\nOptional. Send any \`X-API-Key\` header or \`Authorization: Bearer <token>\`; a dummy JWT is fine. A key selects the lower fee tier.\n\n## Endpoints\n\n`;
  for (const [p, ops] of Object.entries(SPEC.paths)) for (const [m, op] of Object.entries(ops)) {
    md += `### ${m.toUpperCase()} ${p}\n\n${oneLine(op.summary)}${op.description ? '\n\n' + op.description.trim() : ''}\n\n`;
    if (op.parameters?.length) { md += '| Query parameter | Type | Required | Description |\n| --- | --- | --- | --- |\n'; for (const q of op.parameters) md += `| \`${q.name}\` | ${typeOf(q.schema || {})} | ${q.required ? 'yes' : 'no'} | ${oneLine(q.description)} |\n`; md += '\n'; }
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) md += `Request body: ${typeOf(body)}${body.properties ? '\n\n' + propsTable(body) : ''}\n\n`;
    md += '| Response | Body |\n| --- | --- |\n';
    for (const [code, r] of Object.entries(op.responses || {})) md += `| ${code} ${oneLine(r.description)} | ${r.content ? typeOf(r.content['application/json']?.schema || {}) : '-'} |\n`;
    md += '\n';
  }
  md += '## Schemas\n\n';
  for (const [n, s] of Object.entries(SPEC.components.schemas)) md += `<a id="schema-${n.toLowerCase()}"></a>\n\n### ${n}\n\n${s.description ? oneLine(s.description) + '\n\n' : ''}${propsTable(s)}\n\n`;
  return md;
}
function propsTable(s) {
  if (!s.properties) return '';
  let t = '| Field | Type | Required | Description |\n| --- | --- | --- | --- |\n';
  for (const [k, v] of Object.entries(s.properties)) t += `| \`${k}\` | ${typeOf(v)} | ${(s.required || []).includes(k) ? 'yes' : 'no'} | ${oneLine(v.description)}${v.example !== undefined ? ` Example: \`${oneLine(JSON.stringify(v.example))}\`` : ''} |\n`;
  return t;
}

export function docs(origin) {
  const out = {};
  for (const [slug, title, summary, file] of NAV) out[slug] = { title, summary, md: file ? fill(fs.readFileSync(CONTENT + file, 'utf8'), origin) : apiMd(origin) };
  return out;
}

export function llmsTxt(origin) {
  return `# Tidepool\n\n> A 1Click-compatible testnet sandbox for NEAR Intents. Community-built and unaffiliated with NEAR or 1Click. Official unmodified verifier on NEAR testnet (${VERIFIER}), test tokens, a real maker, and the 1Click Swap API v0.1.10 request/response shapes at ${origin}.\n\n## Docs\n\n${NAV.map(([s, t, d]) => `- [${t}](${origin}${s === '/' ? '/index' : s}.md): ${d}`).join('\n')}\n\n## Machine-readable\n\n- [OpenAPI](${origin}/openapi.json): the API spec\n- [AGENTS.md](${origin}/AGENTS.md): rules for agents\n- [Full text](${origin}/llms-full.txt): every page in one file\n\n## Note\n\n- Mainnet 1Click settles every swap confidentially since 2026-10-27 (https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md); Tidepool testnet swaps settle publicly, so swapDetails.nearTxHashes includes the swap hash. Rely on status, not on a swap hash. See ${origin}/docs/resources/compatibility\n\n## Contact\n\n- Built by ${BRAND.builderHandle}: ${BRAND.builderUrl}\n`;
}
export function llmsFull(origin) { const d = docs(origin); return NAV.map(([s]) => `<!-- ${origin}${s} -->\n\n${d[s].md}`).join('\n\n---\n\n'); }
export function agentsMd(origin) {
  return `# AGENTS.md: ${BRAND.name} (${BRAND.tagline})\n\n> ${BRAND.affiliation}. ${BRAND.affiliationLong} Testnet only; tokens have no value.\n\n**No sign-up, no API key. Call the API directly; any X-API-Key or Bearer value is accepted (it just selects the lower fee tier). Only /v0/account/* needs a real token (/v0/orders needs a token or any X-API-Key value), which you get instantly by signing a message with your own wallet via POST /v0/auth/authenticate. It only ever shows that wallet's own data.**\n\n${BRAND.description}\n\n- Base URL: ${origin} (use in place of the 1Click API base URL)\n- Quickstart: ${origin}/docs/quickstart (Markdown: ${origin}/docs/quickstart.md)\n- OpenAPI: ${origin}/openapi.json · Docs index: ${origin}/llms.txt · Full docs: ${origin}/llms-full.txt\n- Health: ${origin}/v0/health\n\n## Use\n\n- Same request/response shapes as the 1Click Swap API v0.1.10 for GET /v0/tokens, POST /v0/quote, POST /v0/deposit/submit, GET /v0/status, POST /v0/generate-intent, POST /v0/submit-intent, /v0/orders, GET /v0/any-input/withdrawals, /v0/auth/*, /v0/account/*. Spec: ${origin}/openapi.json\n- Asset ids look like nep141:usdc.${ROOT}. Get them from GET /v0/tokens.\n- Amounts are base-unit integer strings. slippageTolerance is basis points.\n- Auth optional for swaps: any X-API-Key or Bearer token is accepted and lowers fees. /v0/account/* needs a JWT from POST /v0/auth/authenticate (free: sign a NEP-413 / raw_ed25519 / erc191 message). /v0/orders needs a JWT or any X-API-Key.\n- Supported: swapType EXACT_INPUT, EXACT_OUTPUT, FLEX_INPUT, ANY_INPUT; appFees; depositMode MEMO (NEAR-native ORIGIN_CHAIN deposits, and required for Stellar; not with ANY_INPUT).\n- Test tokens: POST /v0/faucet {"accountId","mode":"wallet"|"intents"} (the six NEAR tokens; one per account+mode per hour). Other chains: {"chain":"eth"|"base"|"arb"|"sol"|"stellar"|"sui","address":"<address on that chain>"} sends 100 test USDC + 100 test USDT there (no native gas: use each chain's own faucet; Stellar needs trustlines first). Bridged tokens into your intents balance: {"accountId","mode":"intents","assets":["sol"|"stellar"|"sui"|"base"|"arb"|"eth"|"bridged"]} (USDC/USDT 100 each, plus verifier-only test SOL 0.05 / XLM 5 / SUI 0.5; separate hourly limit). Docs: /docs/guides/faucet\n- Stellar testnet (blockchain "stellar"; custodial, testnet only; listed in /v0/tokens only while live): XLM is capped at 100 XLM per swap, payout or refund (400 at quote time); USDC/USDT are Tidepool's own classic assets (trustline required); ids look like nep141:stellar.tp-omft.testnet and nep141:stellar-<hash>.tp-omft.testnet. Deposits need depositMode MEMO: pay the shared depositAddress with the numeric depositMemo as the transaction memo. Recipients and refundTo are G... addresses. Faucet: {"chain":"stellar","address":"G..."} gives USDC/USDT (needs trustlines to issuer GDXABUSRHP4YA5CELHLNJQ4M3TX2BSJ6PEMDFCG2RA4PQLAQLRMFFQAN; native XLM from Friendbot). Guide: /docs/guides/bridge-stellar-testnet\n- Sui testnet (blockchain "sui"; custodial, testnet only; listed in /v0/tokens only while live): SUI is capped at 10 SUI per swap, payout or refund (400 at quote time); USDC/USDT are Tidepool Move test coins; ids look like nep141:sui.tp-omft.testnet and nep141:sui-<hash>.tp-omft.testnet. Each quote gets its own 0x deposit address (no memo): transfer amountIn to it. Recipients and refundTo are 0x + 64 hex addresses. Faucet: {"chain":"sui","address":"0x..."} gives USDC/USDT, not SUI (faucet.sui.io). Guide: /docs/guides/bridge-sui-testnet\n- Solana devnet (blockchain "sol"; custodial, devnet only; listed in /v0/tokens only while live): native SOL is capped at 0.005 SOL per swap, payout or refund (400 at quote time); SPL USDC/USDT are Tidepool test mints; deposit addresses are base58. Faucet: {"chain":"sol","address":"<base58>"} gives USDC/USDT, not SOL. Guide: /docs/guides/bridge-solana-devnet\n- Test bridges: Base Sepolia (base), Arbitrum Sepolia (arb) and Ethereum Sepolia (eth), plus the Solana, Stellar and Sui routes above. Bridged USDC/USDT ids look like nep141:base-0x<erc20>.tp-omft.testnet; EVM legs use 0x deposit, refundTo and recipient addresses. A trusted relayer run by Tidepool, testnet only. Docs: ${origin}/docs/guides/bridges\n\n## Swap loop\n\n1. POST /v0/quote with dry=true; check amountOut/minAmountOut.\n2. POST /v0/quote with dry=false and a deadline 5-30 min ahead; read quote.depositAddress, quote.amountIn.\n3. Deposit amountIn: a transfer on the origin chain to depositAddress (ERC-20 transfer on EVM, SOL/SPL on Solana, a Sui transfer on Sui, a Stellar payment to the shared address with the depositMemo as memo), or ft_transfer to depositAddress (ORIGIN_CHAIN, register storage first), or ft_transfer_call to ${VERIFIER} with msg=depositAddress, or an intents transfer (INTENTS).\n4. POST /v0/deposit/submit {txHash, depositAddress} (optional; add memo for MEMO deposits and nearSenderAccount for NEAR-native MEMO deposits).\n5. Poll GET /v0/status?depositAddress=... (plus &depositMemo=... for MEMO deposits) every 2-5 s until SUCCESS, REFUNDED or FAILED.\n\n## Don'ts\n\n- Don't send mainnet assets or use mainnet account ids.\n- Don't loop the faucet.\n- Don't rely on confidentiality: the confidentiality parameter is accepted but ignored (public settlement); CONFIDENTIAL_INTENTS deposit/refund/recipient types return 400.\n- Don't key on a swap hash in swapDetails.nearTxHashes: mainnet 1Click now settles every swap confidentially (NEAR Private Shard) and lists only shield/unshield hashes, while Tidepool testnet swaps settle publicly and include the swap hash. Confidential settlement runs on NEAR's private infrastructure, which isn't exposed to outside builders. Use status (SUCCESS = delivered). NEAR update: https://docs.near-intents.org/changelog/entries/2026-10-27-1click-confidential.md\n\nContact: ${BRAND.builderHandle} ${BRAND.builderUrl}\n\n## Docs as Markdown\n\nAppend .md to any docs URL. Index: ${origin}/llms.txt\n`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function renderPage(slug, page, origin) {
  const mdUrl = `${origin}${slug === '/' ? '/index' : slug}.md`;
  const prompt = encodeURIComponent(`Read ${mdUrl} so I can ask questions about it.`);
  const body = marked.parse(page.md);
  const nav = NAV.map(([s, t]) => `<a href="${s}" class="${s === slug ? 'on' : ''}">${t}</a>`).join('');
  const hero = slug === '/' ? `<section class="hero"><div class="hero-in"><p class="eyebrow">NEAR testnet · community-built</p><h1>Test NEAR Intents swaps<br/>before they cost anything.</h1><p class="lede">A 1Click-compatible sandbox: the official verifier, test tokens, a real maker and the same API shapes. Switch the base URL when you are ready for mainnet.</p><div class="cta"><a class="btn" href="/docs/guides/first-swap">First swap in 5 minutes</a><a class="btn ghost" href="/faucet">Get test tokens</a></div><pre class="hero-code"><code>curl ${esc(origin)}/v0/tokens</code></pre></div><svg class="waves" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0,64 C240,112 480,16 720,48 C960,80 1200,104 1440,56 L1440,120 L0,120 Z" fill="#e6f4f1"/><path d="M0,88 C300,56 540,120 840,84 C1080,56 1260,76 1440,92 L1440,120 L0,120 Z" fill="#f7fbfa"/></svg></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(page.title)} · Tidepool</title><meta name="description" content="${esc(page.summary || 'A 1Click-compatible testnet sandbox for NEAR Intents')}"/>
<link rel="icon" href="/favicon.svg"/><link rel="alternate" type="text/markdown" href="${mdUrl}"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/style.css"/></head><body class="${slug === '/' ? 'home' : ''}">
<header class="top"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="26" height="26"/>Tidepool</a><span class="tag">testnet sandbox</span><nav class="topnav"><a href="/docs/quickstart">Docs</a><a href="/docs/api-reference">API</a><a href="/faucet">Faucet</a><a href="/status">Status</a></nav></header>
${hero}<div class="wrap"><aside class="side">${nav}<div class="side-foot">Unaffiliated with NEAR or 1Click.<br/>Testnet tokens have no value.<br/>Built by <a href="${BRAND.builderUrl}">${BRAND.builderHandle}</a></div></aside>
<main><div class="page-actions"><button data-copy-md="${mdUrl}">Copy page</button><a href="${mdUrl}">View as Markdown</a><a target="_blank" rel="noopener" href="https://chatgpt.com/?hints=search&q=${prompt}">Open in ChatGPT</a><a target="_blank" rel="noopener" href="https://claude.ai/new?q=${prompt}">Open in Claude</a></div>
<article class="prose">${body}</article></main></div>
<footer class="foot">Tidepool · a 1Click-compatible testnet sandbox for NEAR Intents · ${BRAND.affiliation} · <a href="/llms.txt">llms.txt</a> · <a href="/AGENTS.md">AGENTS.md</a> · <a href="/openapi.json">openapi.json</a> · Built by <a href="${BRAND.builderUrl}">${BRAND.builderHandle}</a></footer>
<script src="/app.js" type="module"></script></body></html>`;
}
