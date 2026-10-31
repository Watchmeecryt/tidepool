// One-call demo: POST /v0/demo/run walks the whole 1Click flow (swap and LIMIT order) with an EXISTING, already-funded
// testnet account whose key is configured on the server (DEMO_ACCOUNT_ID, default: the maker account). It creates no
// wallets and no accounts. The key stays in the in-memory key store: it is only used to sign, and never appears in a
// response, a log line or this repo. Each step calls the server's own public API over loopback, so the step log shows
// the exact public request and the real response.
import bs58 from 'bs58';
import { keyStore, NETWORK, view, txUrl } from './near.mjs';
import { nep413Hash, signIntents } from './near.mjs';
import { VERIFIER, MAKER, TOKENS, fromUnits } from './config.mjs';

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
export const DEMO = {
  enabled: process.env.DEMO_ENABLED !== '0',
  account: process.env.DEMO_ACCOUNT_ID || MAKER,
  perIpPerHour: num('DEMO_IP_LIMIT', 3),
  globalPerHour: num('DEMO_GLOBAL_LIMIT', 20),
  timeoutMs: num('DEMO_TIMEOUT_MS', 150_000),
  minUsdc: num('DEMO_MIN_USDC', 20), // refuse once the demo account holds less than this much USDC (and USDT) in the verifier
  amount: '1000000', // 1 USDC (6 decimals): fixed, never taken from the request
};
const FLOWS = ['swap', 'order', 'all'];
const FINAL_SWAP = ['SUCCESS', 'REFUNDED', 'FAILED'];
const FINAL_ORDER = ['FILLED', 'CANCELED', 'EXPIRED'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const bySym = (s) => TOKENS.find(t => t.symbol === s && !t.chain);

class DemoRefused extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra; } }

// ---- limits: per IP and global, sliding one hour window; one run at a time ----
const hits = new Map(); let global = []; let running = null;
const HOUR = 3600_000;
function admit(ip) {
  const now = Date.now();
  global = global.filter(t => t > now - HOUR);
  const mine = (hits.get(ip) || []).filter(t => t > now - HOUR);
  for (const [k, v] of hits) if (!v.some(t => t > now - HOUR)) hits.delete(k);
  if (mine.length >= DEMO.perIpPerHour) throw new DemoRefused(429, `Rate limited: ${DEMO.perIpPerHour} demo runs per hour per IP. Try again after ${new Date(mine[0] + HOUR).toISOString()}.`, { retryAfterSeconds: Math.ceil((mine[0] + HOUR - now) / 1000) });
  if (global.length >= DEMO.globalPerHour) throw new DemoRefused(429, `Rate limited: the demo allows ${DEMO.globalPerHour} runs per hour in total. Try again after ${new Date(global[0] + HOUR).toISOString()}.`, { retryAfterSeconds: Math.ceil((global[0] + HOUR - now) / 1000) });
  if (running) throw new DemoRefused(409, 'A demo run is already in progress (one at a time). Retry in about a minute.', { retryAfterSeconds: 60 });
  mine.push(now); hits.set(ip, mine); global.push(now);
}

export function demoInfo() {
  return {
    endpoint: 'POST /v0/demo/run', body: { flow: 'swap | order | all (default all)' },
    what: 'Runs the 1Click flow end to end on NEAR testnet with a funded demo account held by the server: GET /v0/tokens, dry quote, live quote, generate-intent, signed submit-intent, deposit/submit, status polling, authenticate, balances, history; then a LIMIT order (create, fund, read, cancel). Returns a JSON step log with the equivalent public request for every step.',
    try: 'curl -X POST https://www.usetidepool.tech/v0/demo/run',
    getAlias: 'GET /v0/demo/run?flow=all also runs it; a bare GET only returns this description',
    limits: { amountPerSwap: '1 USDC → USDT (fixed)', perIpPerHour: DEMO.perIpPerHour, globalPerHour: DEMO.globalPerHour, concurrent: 1, timeoutSeconds: DEMO.timeoutMs / 1000 },
    enabled: DEMO.enabled, network: 'testnet', docs: 'https://www.usetidepool.tech/docs/api-reference/tidepool-demo-run',
  };
}

// ---- redaction: the step log must never carry a secret ----
const SIG = '<signature made with the signer\'s own key (redacted)>';
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'accessToken' || k === 'refreshToken') o[k] = `<${k}: a JWT for the demo account (redacted)>`;
      else if (k === 'signature') o[k] = SIG;
      else o[k] = scrub(x);
    }
    return o;
  }
  return v;
}

export async function runDemo({ body, ip, origin, base }) {
  if (!DEMO.enabled) throw new DemoRefused(503, 'The demo endpoint is disabled on this server.');
  const flow = body?.flow === undefined ? 'all' : String(body.flow);
  if (!FLOWS.includes(flow)) throw new DemoRefused(400, `flow must be one of ${FLOWS.join(', ')}`);
  const id = DEMO.account;
  const kp = await keyStore.getKey(NETWORK, id);
  if (!kp) throw new DemoRefused(503, 'The demo account is not configured on this server.');
  const usdc = bySym('USDC'), usdt = bySym('USDT');
  if (!usdc || !usdt) throw new DemoRefused(503, 'Demo tokens are not available.');
  admit(ip);
  running = Date.now();
  const t0 = Date.now(), deadline = t0 + DEMO.timeoutMs;
  const steps = [], links = [], summary = {};
  const addLink = (label, url) => { if (url && !links.some(l => l.url === url)) links.push({ label, url }); };
  const left = () => deadline - Date.now();
  let failed = null, timedOut = false, token = null, tokenStep = null, orderId = null, orderFinal = false;

  // one public API call: executed over loopback, logged as the public request
  async function api(title, method, path, reqBody, { auth = false, flowName, log = true } = {}) {
    if (left() <= 0) { timedOut = true; throw new Error('demo timeout'); }
    const headers = { 'content-type': 'application/json', 'x-api-key': 'demo' };
    if (auth) headers.authorization = `Bearer ${token}`;
    const started = Date.now();
    let status, data;
    try {
      const r = await fetch(base + path, { method, headers, body: reqBody === undefined ? undefined : JSON.stringify(reqBody), signal: AbortSignal.timeout(Math.min(60_000, left())) });
      status = r.status; const t = await r.text(); try { data = JSON.parse(t); } catch { data = t.slice(0, 500); }
    } catch (e) { status = 0; data = { message: 'request failed: ' + String(e.name === 'TimeoutError' ? 'timeout' : 'network error') }; }
    const pub = { method, url: origin + path, headers: { 'content-type': 'application/json', 'x-api-key': '<any value>', ...(auth ? { authorization: `Bearer <accessToken from step ${tokenStep}>` } : {}) } };
    if (method === 'GET') delete pub.headers['content-type'];
    const step = { step: steps.length + 1, flow: flowName, title, request: { ...pub, ...(reqBody !== undefined ? { body: scrub(reqBody) } : {}) }, response: { status, body: scrub(data) }, ms: Date.now() - started };
    if (log) steps.push(step);
    if (status < 200 || status >= 300) { failed = { step: step.step, title, status, message: data?.message || data?.errors?.[0]?.detail || 'request failed' }; if (!log) steps.push(step); throw new Error(`step ${step.step} failed`); }
    return { data, step };
  }
  const note = (title, flowName, text, extra = {}) => steps.push({ step: steps.length + 1, flow: flowName, title, note: text, ...extra });
  const signMessage = (message, nonceB64, recipient) => 'ed25519:' + bs58.encode(Buffer.from(kp.sign(nep413Hash(message, Buffer.from(nonceB64, 'base64'), recipient)).signature));
  const nearLink = (label, h) => h && addLink(label, txUrl(h));

  // sign a generate-intent response with the demo key and submit it (the same two calls any wallet makes)
  async function fund(flowName, depositAddress, what) {
    const gen = await api(`Generate the transfer intent that funds the ${what} deposit address`, 'POST', '/v0/generate-intent', { type: 'swap_transfer', standard: 'nep413', signerId: id, depositAddress }, { flowName });
    const p = gen.data.intent.payload;
    note('Sign the intent (client side, nothing is sent)', flowName, `Sign step ${gen.step.step}'s intent.payload.message with a NEP-413 ed25519 key that is registered for the signer account on the verifier. The demo signs with the demo account's key, which stays on the server and is not shown.`);
    const signedData = { standard: 'nep413', payload: p, public_key: kp.getPublicKey().toString(), signature: signMessage(p.message, p.nonce, p.recipient) };
    const sub = await api(`Submit the signed intent: ${VERIFIER} executes the transfer into the ${what} deposit address`, 'POST', '/v0/submit-intent', { type: 'swap_transfer', signedData }, { flowName });
    nearLink(`${what}: signed deposit transfer`, sub.data.tidepool?.txHash);
    return sub.data;
  }
  async function authenticate() {
    if (token) return;
    const signed = signIntents({ signerId: id, verifier: VERIFIER, intents: [], keyPair: kp, ttlMs: 120_000 });
    const r = await api('Authenticate: exchange a signed message for a JWT (needed for /v0/account/* and /v0/orders)', 'POST', '/v0/auth/authenticate', { signedData: signed });
    token = r.data.accessToken; tokenStep = r.step.step;
  }

  try {
    // refuse when the demo account's funds are low (checked on the verifier, right before spending)
    const bal = async (t) => Number(fromUnits(BigInt(await view(VERIFIER, 'mt_balance_of', { account_id: id, token_id: t.assetId })), t.decimals));
    const [bu, bt] = await Promise.all([bal(usdc), bal(usdt)]);
    if (bu < DEMO.minUsdc || bt < DEMO.minUsdc) { global.pop(); const m = hits.get(ip); m?.pop(); throw new DemoRefused(503, `The demo account is low on test funds (below ${DEMO.minUsdc} USDC/USDT); refusing to run. Tell the Tidepool owner to top it up.`); }

    if (flow === 'swap' || flow === 'all') {
      const F = 'swap';
      const toks = await api('List supported tokens', 'GET', '/v0/tokens', undefined, { flowName: F, log: false });
      const last = steps.length;
      steps.push({ step: last + 1, flow: F, title: 'List supported tokens', request: { method: 'GET', url: origin + '/v0/tokens', headers: { 'x-api-key': '<any value>' } }, response: { status: 200, body: { count: toks.data.length, shown: toks.data.filter(t => [usdc, usdt].some(x => x.assetId === t.assetId)), note: 'trimmed: the real response lists every token' } }, ms: toks.step.ms });
      const sw = { swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: usdc.assetId, depositType: 'INTENTS', destinationAsset: usdt.assetId, amount: DEMO.amount, refundTo: id, refundType: 'INTENTS', recipient: id, recipientType: 'INTENTS' };
      await api('Dry quote: price only, nothing is reserved', 'POST', '/v0/quote', { ...sw, dry: true, deadline: new Date(Date.now() + 10 * 60_000).toISOString() }, { flowName: F });
      const live = await api('Live quote: reserves a deposit address (dry:false)', 'POST', '/v0/quote', { ...sw, dry: false, deadline: new Date(Date.now() + 10 * 60_000).toISOString() }, { flowName: F });
      const dep = live.data.quote.depositAddress;
      summary.swap = { depositAddress: dep, amountIn: live.data.quote.amountInFormatted + ' USDC', quotedAmountOut: live.data.quote.amountOutFormatted + ' USDT' };
      const sub = await fund(F, dep, 'swap');
      await api('Tell Tidepool about the deposit (optional with INTENTS: submit-intent already registered it)', 'POST', '/v0/deposit/submit', { txHash: sub.tidepool.txHash, depositAddress: dep }, { flowName: F });
      // poll status until final
      const path = `/v0/status?depositAddress=${encodeURIComponent(dep)}`;
      const seen = []; let st, first;
      for (;;) {
        const r = await api('Poll status', 'GET', path, undefined, { flowName: F, log: false });
        st = r.data; first ||= r;
        if (seen.at(-1)?.status !== st.status) seen.push({ status: st.status, atMs: Date.now() - t0 });
        if (FINAL_SWAP.includes(st.status)) break;
        if (left() <= 0) { timedOut = true; break; }
        await sleep(2500);
      }
      steps.push({ step: steps.length + 1, flow: F, title: `Poll status until final (repeat every 2 to 5 s): ${st.status}`, request: { method: 'GET', url: origin + path, headers: { 'x-api-key': '<any value>' } }, statusesSeen: seen, response: { status: 200, body: st }, ms: Date.now() - t0 });
      for (const e of st.tidepool?.explorer || []) addLink(`swap: ${e.label}`, e.url);
      Object.assign(summary.swap, { status: st.status, amountOut: st.swapDetails?.amountOutFormatted && st.swapDetails.amountOutFormatted + ' USDT' });
      if (timedOut) throw new Error('demo timeout');
      if (st.status !== 'SUCCESS') { failed = { step: steps.length, title: 'swap did not succeed', status: 200, message: `swap ended ${st.status}` }; throw new Error('swap not successful'); }
      await authenticate();
      const q = `tokenIds=${encodeURIComponent(usdc.assetId)},${encodeURIComponent(usdt.assetId)}`;
      await api('Balances of the account (verifier balances)', 'GET', `/v0/account/balances?${q}`, undefined, { auth: true, flowName: F });
      const h = await api('Swap history of the account (newest first)', 'GET', '/v0/account/history?limit=2', undefined, { auth: true, flowName: F });
      steps.at(-1).response.body = scrub({ items: h.data.items.slice(0, 2), note: 'trimmed to 2 items' });
    }

    if (flow === 'order' || flow === 'all') {
      const F = 'order';
      await authenticate();
      const attributes = { orderType: 'LIMIT', side: 'SELL', baseAsset: usdc.assetId, quoteAsset: usdt.assetId, quantity: DEMO.amount, price: '1.5', timeInForce: 'GTC', depositType: 'INTENTS', refundTo: id, refundType: 'INTENTS', recipient: id, recipientType: 'INTENTS', confidentiality: 'public', deadline: new Date(Date.now() + 20 * 60_000).toISOString() };
      const c = await api('Create a LIMIT order: SELL 1 USDC for USDT at 1.5 (far above market, so it waits instead of filling)', 'POST', '/v0/orders', { data: { type: 'orders', attributes } }, { auth: true, flowName: F });
      orderId = c.data.data.id; const dep = c.data.data.attributes.depositAddress;
      summary.order = { id: orderId, depositAddress: dep, fillStatus: c.data.data.attributes.fillStatus };
      await fund(F, dep, 'order');
      let o;
      for (;;) {
        const r = await api('Read the order', 'GET', `/v0/orders/${orderId}`, undefined, { auth: true, flowName: F, log: false });
        o = r.data.data;
        if (o.attributes.fillStatus !== 'AWAITING_DEPOSIT' || left() <= 0) { steps.push({ ...r.step, step: steps.length + 1, title: `Read the order: ${o.attributes.fillStatus} (funded, waiting for the limit price)` }); break; }
        await sleep(2500);
      }
      const can = await api('Cancel the order (the deposit is refunded)', 'POST', `/v0/orders/${orderId}/cancel`, undefined, { auth: true, flowName: F });
      void can;
      for (;;) {
        const r = await api('Read the order', 'GET', `/v0/orders/${orderId}`, undefined, { auth: true, flowName: F, log: false });
        o = r.data.data;
        const done = FINAL_ORDER.includes(o.attributes.fillStatus) && (o.attributes.isPayoutStatusFinal || left() < 5000);
        if (done || left() <= 0) { steps.push({ ...r.step, step: steps.length + 1, title: `Read the order again: ${o.attributes.fillStatus}, payout ${o.attributes.payoutStatus}` }); break; }
        await sleep(2500);
      }
      orderFinal = FINAL_ORDER.includes(o.attributes.fillStatus);
      for (const w of o.attributes.payouts?.allWithdrawals || []) nearLink('order: fill', w.txHash);
      if (o.attributes.payouts?.refund?.txHash) nearLink('order: refund of the canceled order', o.attributes.payouts.refund.txHash);
      Object.assign(summary.order, { fillStatus: o.attributes.fillStatus, payoutStatus: o.attributes.payoutStatus, refundTx: o.attributes.payouts?.refund?.txHash && txUrl(o.attributes.payouts.refund.txHash) });
      if (!orderFinal) { timedOut = true; throw new Error('demo timeout'); }
    }
  } catch (e) {
    if (e instanceof DemoRefused) throw e;
    if (!failed && !timedOut) failed = { message: 'internal error during the demo run' };
    if (!(e.message || '').startsWith('step ') && !failed?.step && !timedOut) console.error('demo', e.message);
  } finally {
    // never leave a funded order behind
    if (orderId && !orderFinal && token) { try { await fetch(base + `/v0/orders/${orderId}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-api-key': 'demo' }, signal: AbortSignal.timeout(15_000) }); } catch {} }
    running = null;
  }
  const ok = !failed && !timedOut;
  return {
    code: ok ? 200 : timedOut ? 504 : 502,
    body: {
      ok, flow, network: 'testnet', demoAccount: id, durationMs: Date.now() - t0,
      ...(timedOut ? { error: `Timed out after ${DEMO.timeoutMs / 1000}s; the steps so far are below.` } : {}), ...(failed && !timedOut ? { error: failed } : {}),
      summary, explorerLinks: links,
      about: 'Every step lists the exact public request (method, url, headers, body) and the real response. Replay them with any HTTP client and your own testnet account (the demo signs with the server-held demo account; signatures and tokens are redacted). Amounts are fixed at 1 USDC.',
      steps,
      limits: { perIpPerHour: DEMO.perIpPerHour, globalPerHour: DEMO.globalPerHour, concurrent: 1, timeoutSeconds: DEMO.timeoutMs / 1000 },
      docs: 'https://www.usetidepool.tech/docs/api-reference/tidepool-demo-run',
    },
  };
}
export { DemoRefused };
