// Faucet: drips every test token to a testnet account, either to the wallet (mint) or straight into
// the account's balance inside the Tidepool verifier (transfer from maker inventory).
import { call, TGAS } from './near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, NEAR_TOKENS, EVM_CHAINS, SOL_CHAIN, STELLAR_CHAIN, SUI_CHAIN, BTC_CHAIN, ZEC_CHAIN, XRP_CHAIN, isXrpAddress, isBtcAddress, isZecAddress, chainOf, isEvmAddress, isSolAddress, isStellarAddress, isSuiAddress, normSuiAddress, toUnits } from './config.mjs';
import { faucetMint, txUrl as solTxUrl } from './solana.mjs';
import * as stellar from './stellar.mjs';
import * as sui from './sui.mjs';
import { mintErc20, evmTxUrl } from './evm.mjs';
import { db, save } from './store.mjs';
import { withSigner, BadRequest } from './engine.mjs';
import { assertNearEligible, assertEvmEligible } from './faucet-guard.js';
import { resolveIntentAssets, isBridgedToken, CHAIN_ALIASES } from './faucet-assets.mjs';

const ACCOUNT_COOLDOWN_MS = 7 * 24 * 60 * 60_000; // one claim per address across all faucet variants per 7 days
const INTENTS_CHUNK = 6;
const IP_LIMIT = 2; // drips per IP per 24h
const IP_WINDOW_MS = 24 * 60 * 60_000;
const ipHits = new Map();

/** Normalize an address/account so EVM/Sui 0x… compare case-insensitively; NEAR/Sol/Stellar stay as given. */
function normAddr(a) {
  if (typeof a !== 'string') return a;
  if (/^0x[0-9a-fA-F]+$/.test(a)) return a.toLowerCase();
  return a;
}

/** Most recent claim timestamp for this address across every faucet variant (persisted in db.faucet). */
function lastClaimFor(addr) {
  const id = normAddr(addr);
  let last = 0;
  for (const [k, t] of Object.entries(db.faucet || {})) {
    const i = k.lastIndexOf(':');
    const w = i >= 0 ? k.slice(0, i) : k;
    if (w === id || (id.startsWith('0x') && w.toLowerCase() === id)) last = Math.max(last, Number(t) || 0);
  }
  return last;
}

/** Throw 429 if this address claimed within 7 days (any variant) or the IP hit its 24h cap. Returns { id, hits, key }. */
function assertClaimAllowed(addr, variant, ip) {
  const id = normAddr(addr);
  const last = lastClaimFor(id);
  if (Date.now() - last < ACCOUNT_COOLDOWN_MS) {
    const available_at = new Date(last + ACCOUNT_COOLDOWN_MS).toISOString();
    const retryAfterSeconds = Math.max(1, Math.ceil((last + ACCOUNT_COOLDOWN_MS - Date.now()) / 1000));
    throw new BadRequest(
      `Rate limited: ${addr} can use the faucet again after ${available_at} (one claim per address every 7 days).`,
      429,
      { available_at, retryAfter: available_at, retryAfterSeconds },
    );
  }
  const hits = (ipHits.get(ip) || []).filter(t => Date.now() - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) { const available_at = new Date(hits[0] + IP_WINDOW_MS).toISOString(); throw new BadRequest(`Rate limited: ${IP_LIMIT} faucet claims per IP every 24 hours; try again after ${available_at}.`, 429, { available_at, retryAfter: available_at, retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + IP_WINDOW_MS - Date.now()) / 1000)) }); }
  return { id, hits, key: `${id}:${variant}` };
}

function markClaim(key, ip, hits) {
  db.faucet[key] = Date.now();
  hits.push(Date.now());
  ipHits.set(ip, hits);
  save();
}

/** Undo markClaim only if the slot still holds this request's reservation (never wipe a newer or older successful claim). */
function unmarkClaim(key, ip, hits) {
  const t = db.faucet[key]; const i = hits.lastIndexOf(t); if (i >= 0) hits.splice(i, 1);
  delete db.faucet[key]; save();
}

function clearClaim(key) {
  delete db.faucet[key];
  save();
}

// Direct-chain cooldown keys are `<address>:<chain>` (like the intents-mode keys `<account>:<mode>`), so the admin wallets list shows the
// recipient. Older builds stored `<chain>:<address>`: rename those once at startup so existing cooldowns keep working.
for (const k of Object.keys(db.faucet || {})) { const m = /^(base|arb|eth|bsc|sol|stellar):(.+)$/.exec(k); if (m) { db.faucet[`${m[2]}:${m[1]}`] = db.faucet[k]; delete db.faucet[k]; } }

// Native BTC (testnet4) and ZEC (testnet) are never dripped (small public faucets fund the treasuries): answer with where to get them.
const UTXO_FAUCETS = {
  btc: `Tidepool does not drip native testnet BTC (the ${BTC_CHAIN.name} treasury is funded by public faucets). Get tBTC from ${BTC_CHAIN.faucet} (CypherFaucet) or https://testnet4.info, then deposit it to a quote's depositAddress (originAsset nep141:btc.tp-omft.testnet).`,
  xrp: `Tidepool does not drip native testnet XRP (the ${XRP_CHAIN.name} treasury is funded by the official faucet, and so can you). Get free test XRP from ${XRP_CHAIN.faucet} (the official XRPL Testnet faucet, no captcha: POST {"destination": "r..."} or use https://xrpl.org/resources/dev-tools/xrp-faucets), then deposit it to a quote's depositAddress with depositMode MEMO and the quote's depositMemo as the DestinationTag (originAsset nep141:xrp.tp-omft.testnet).`,
  zec: `Tidepool does not drip native testnet ZEC (the ${ZEC_CHAIN.name} treasury is funded by public faucets). Get TAZ from ${ZEC_CHAIN.faucet} (Valar Group faucet) to a tm... transparent address, then deposit it to a quote's depositAddress (originAsset nep141:zec.tp-omft.testnet).`,
};
// opts.trusted: server-owned wallets (Agent API agents) skip the wallet-age check; caps and the 7-day limit still apply.
export async function drip(body, ip, opts = {}) {
  if (body.chain === 'xrp' || body.chain === 'ripple' || (!body.chain && (isXrpAddress(body.address) || isXrpAddress(body.accountId)))) throw new BadRequest(UTXO_FAUCETS.xrp, 400, { faucet: XRP_CHAIN.faucet, chain: 'xrp' });
  const utxo = ['btc', 'zec'].filter(k => k === 'btc' || ZEC_CHAIN.deployed).find(k => body.chain === k || (!body.chain && (k === 'btc' ? isBtcAddress(body.address) || isBtcAddress(body.accountId) : isZecAddress(body.address) || isZecAddress(body.accountId))));
  if (utxo) throw new BadRequest(UTXO_FAUCETS[utxo], 400, { faucet: utxo === 'btc' ? BTC_CHAIN.faucet : ZEC_CHAIN.faucet, chain: utxo });
  if (body.chain === 'sui' || (!body.chain && (isSuiAddress(body.address) || isSuiAddress(body.accountId)))) return suiDrip(body, ip);
  if (body.chain === 'stellar' || body.chain === 'xlm' || (!body.chain && (isStellarAddress(body.address) || isStellarAddress(body.accountId)))) return stellarDrip(body, ip);
  if (body.chain === 'sol' || body.chain === 'solana' || (!body.chain && isSolAddress(body.address))) return solDrip(body, ip);
  if (body.chain || isEvmAddress(body.accountId) || isEvmAddress(body.address)) return evmDrip(body, ip);
  return nearDrip(body, ip, opts);
}

// Per-chain EVM faucet: the relayer mints the test ERC-20s (USDC, USDT) on that chain to an address.
// Gas (testnet ETH) is not dripped: use the chain's public faucet.
async function evmDrip({ chain = 'base', address, accountId, assets }, ip) {
  const to = address || accountId;
  const c = chainOf(chain);
  if (!c || !c.deployed) throw new BadRequest(`chain must be one of: ${EVM_CHAINS.filter(c => c.deployed).map(c => c.key).join(', ')}`);
  if (!isEvmAddress(to)) throw new BadRequest(`address must be a ${c.name} address (0x...)`);
  // Default drip: bridged stables only. Pass assets:["ondo"] or specific Ondo symbols to include tokenized stocks/RWAs.
  let list = assets?.length
    ? c.tokens.filter(t => assets.includes(t.assetId) || assets.includes(t.symbol) || (assets.includes('ondo') && t.ondo))
    : c.tokens.filter(t => !t.ondo);
  list = list.filter(t => t.drip && t.drip !== '0');
  if (!list.length) throw new BadRequest('no matching assets');
  const { hits, key } = assertClaimAllowed(to, c.key, ip);
  markClaim(key, ip, hits); // reserve the slot before any await so concurrent requests for the same address get 429
  try { await assertEvmEligible(c.key, to); } catch (e) { unmarkClaim(key, ip, hits); throw e; }
  const out = [];
  try {
    for (const t of list) out.push({ assetId: t.assetId, symbol: t.symbol, token: t.evmAddress, amount: t.drip, txHash: await mintErc20(c.key, t.evmAddress, to, toUnits(t.drip, t.decimals)) });
  } catch (e) { if (!out.length) clearClaim(key); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { chain: c.key, address: to, mode: 'wallet', drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, token: t.evmAddress, amount: t.drip })), transactions: out.map(o => ({ ...o, explorerUrl: evmTxUrl(c.key, o.txHash) })), note: `Gas is not included: get ${c.key === 'bsc' ? 'BSC Testnet tBNB' : c.name + ' ETH'} from a public faucet.` };
}

// Solana devnet faucet: the relayer (mint authority) mints the test SPL tokens (USDC, USDT) to a wallet's associated token accounts.
// It does NOT drip SOL (devnet SOL is scarce; use your own devnet airdrop for fees). Creating the recipient ATAs costs the treasury ~0.004 SOL
// per new wallet, so there is also a global daily cap.
const SOL_FAUCET_DAILY_MAX = Number(process.env.SOL_FAUCET_DAILY_MAX || 150);
const solDrips = [];
async function solDrip({ address, accountId, assets }, ip) {
  const to = address || accountId;
  if (!SOL_CHAIN.deployed) throw new BadRequest('Solana devnet bridge is not enabled on this server');
  if (!isSolAddress(to)) throw new BadRequest(`address must be a ${SOL_CHAIN.name} address (base58 public key)`);
  const pool = SOL_CHAIN.tokens.filter(t => !t.native);
  const list = assets?.length ? pool.filter(t => assets.includes(t.assetId) || assets.includes(t.symbol)) : pool;
  if (!list.length) throw new BadRequest('no matching assets (Solana faucet drips USDC and USDT only, not SOL)');
  const { hits, key } = assertClaimAllowed(to, 'sol', ip);
  while (solDrips.length && Date.now() - solDrips[0] > 86_400_000) solDrips.shift();
  if (solDrips.length >= SOL_FAUCET_DAILY_MAX) throw new BadRequest('The Solana devnet faucet hit its daily limit (it spends treasury SOL on token accounts). Try again tomorrow.', 429);
  markClaim(key, ip, hits); solDrips.push(Date.now());
  let sig;
  try { sig = await faucetMint(to, list.map(t => ({ ...t, dripUnits: toUnits(t.drip, t.decimals) }))); }
  catch (e) { clearClaim(key); solDrips.pop(); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { chain: 'sol', address: to, mode: 'wallet', drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, mint: t.mint, amount: t.drip })), transactions: [{ txHash: sig, explorerUrl: solTxUrl(sig) }], note: 'Solana devnet test tokens, no value. SOL is not dripped; request a devnet airdrop for transaction fees.' };
}

// Stellar testnet faucet: the treasury pays issued USDC/USDT to an existing account that already trusts them (XLM comes from Friendbot).
const XLM_FAUCET_DAILY_MAX = Number(process.env.STELLAR_FAUCET_DAILY_MAX || 300);
const stellarDrips = [];
async function stellarDrip({ address, accountId, assets }, ip) {
  const to = address || accountId;
  if (!STELLAR_CHAIN.deployed) throw new BadRequest('Stellar testnet bridge is not enabled on this server');
  if (!isStellarAddress(to)) throw new BadRequest(`address must be a ${STELLAR_CHAIN.name} address (G... public key)`);
  const pool = STELLAR_CHAIN.tokens.filter(t => !t.native);
  const list = assets?.length ? pool.filter(t => assets.includes(t.assetId) || assets.includes(t.symbol)) : pool;
  if (!list.length) throw new BadRequest('no matching assets (the Stellar faucet drips USDC and USDT only, not XLM; get XLM from Friendbot)');
  const acc = await stellar.account(to).catch(() => undefined);
  if (acc === null) throw new BadRequest(`${to} does not exist on ${STELLAR_CHAIN.name} yet. Fund it with Friendbot first: ${STELLAR_CHAIN.friendbot}/?addr=${to} (10,000 test XLM), then add trustlines and retry.`);
  if (acc) { const miss = list.filter(t => !stellar.hasTrustline(acc, t)); if (miss.length) throw new BadRequest(`${to} has no trustline for ${miss.map(t => `${t.symbol} (${t.code}:${t.issuer})`).join(', ')}. Add a changeTrust operation for each, then retry.`); }
  const { hits, key } = assertClaimAllowed(to, 'stellar', ip);
  while (stellarDrips.length && Date.now() - stellarDrips[0] > 86_400_000) stellarDrips.shift();
  if (stellarDrips.length >= XLM_FAUCET_DAILY_MAX) throw new BadRequest('The Stellar testnet faucet hit its daily limit. Try again tomorrow.', 429);
  markClaim(key, ip, hits); stellarDrips.push(Date.now());
  let hash;
  try { hash = await stellar.faucetPay(to, list.map(t => ({ ...t, dripUnits: toUnits(t.drip, t.decimals) }))); }
  catch (e) { clearClaim(key); stellarDrips.pop(); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { chain: 'stellar', address: to, mode: 'wallet', drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, asset: `${t.code}:${t.issuer}`, amount: t.drip })), transactions: [{ txHash: hash, explorerUrl: stellar.txUrl(hash) }], note: 'Stellar testnet issued test assets, no value. XLM is not dripped; use Friendbot for XLM.' };
}

// Sui testnet faucet: the treasury (holder of the TreasuryCaps of Tidepool's Move test coins) mints USDC/USDT straight to a wallet in one
// transaction. It does NOT drip SUI: get gas from the Sui testnet faucet (https://faucet.sui.io).
const SUI_FAUCET_DAILY_MAX = Number(process.env.SUI_FAUCET_DAILY_MAX || 300);
const suiDrips = [];
async function suiDrip({ address, accountId, assets }, ip) {
  const to = address || accountId;
  if (!SUI_CHAIN.deployed) throw new BadRequest('Sui testnet bridge is not enabled on this server');
  if (!isSuiAddress(to)) throw new BadRequest(`address must be a ${SUI_CHAIN.name} address (0x + 64 hex characters)`);
  if (!sui.relayerConfigured()) throw new BadRequest('Sui testnet bridge is not configured on this server', 503);
  const addr = normSuiAddress(to);
  const pool = SUI_CHAIN.tokens.filter(t => !t.native);
  const list = assets?.length ? pool.filter(t => assets.includes(t.assetId) || assets.includes(t.symbol)) : pool;
  if (!list.length) throw new BadRequest('no matching assets (the Sui faucet drips USDC and USDT only, not SUI; get SUI from https://faucet.sui.io)');
  const { hits, key } = assertClaimAllowed(addr, 'sui', ip);
  while (suiDrips.length && Date.now() - suiDrips[0] > 86_400_000) suiDrips.shift();
  if (suiDrips.length >= SUI_FAUCET_DAILY_MAX) throw new BadRequest('The Sui testnet faucet hit its daily limit (it spends treasury SUI on gas). Try again tomorrow.', 429);
  markClaim(key, ip, hits); suiDrips.push(Date.now());
  let digest;
  try { digest = await sui.faucetMint(addr, list.map(t => ({ ...t, dripUnits: toUnits(t.drip, t.decimals) }))); }
  catch (e) { clearClaim(key); suiDrips.pop(); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { chain: 'sui', address: addr, mode: 'wallet', drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, coinType: t.coinType, amount: t.drip })), transactions: [{ txHash: digest, explorerUrl: sui.txUrl(digest) }], note: `Sui testnet test coins, no value. SUI is not dripped; get gas from ${SUI_CHAIN.faucet}.` };
}

/** Synchronous pre-check for the Agent API faucet deposit (default NEAR tokens into an intents balance): throws the same 429 drip() would. */
export function nearDripCheck(accountId, ip) {
  assertClaimAllowed(accountId, 'intents', ip);
}

async function nearDrip({ accountId, mode = 'wallet', assets }, ip, { trusted = false } = {}) {
  if (typeof accountId !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(accountId)) throw new BadRequest('accountId must be a NEAR testnet account id');
  if (!['wallet', 'intents'].includes(mode)) throw new BadRequest('mode must be "wallet" or "intents"');
  // NEAR faucet: native Tidepool tokens by default; bridged test tokens (USDC/USDT on every chain, plus verifier-only test SOL and XLM)
  // go only into the verifier (intents mode) and only on request: asset ids or chain aliases (sol, stellar, base, arb, eth, bridged).
  if (mode === 'wallet' && assets?.some(a => CHAIN_ALIASES.includes(String(a).toLowerCase()) || String(a).includes('tp-omft'))) throw new BadRequest('Bridged test tokens can only be sent to an intents balance: use mode "intents", or pass chain and address to receive USDC/USDT on that chain');
  const list = assets?.length ? resolveIntentAssets(assets, mode === 'intents' ? TOKENS : NEAR_TOKENS) : NEAR_TOKENS.filter(t => Number(t.drip) > 0);
  if (!list.length && assets?.length && assets.every(a => ['btc', 'xrp', 'ripple', ...(ZEC_CHAIN.deployed ? ['zec'] : [])].includes(String(a).toLowerCase()) || (ZEC_CHAIN.deployed ? /^nep141:(btc|xrp|zec)\.tp-omft/ : /^nep141:(btc|xrp)\.tp-omft/).test(String(a)))) throw new BadRequest(UTXO_FAUCETS[/xrp|ripple/i.test(String(assets[0])) ? 'xrp' : /zec/i.test(String(assets[0])) ? 'zec' : 'btc']);
  if (!list.length) throw new BadRequest(`no matching assets${mode === 'intents' ? ` (use asset ids, NEAR symbols, or chain aliases: ${CHAIN_ALIASES.join(', ')})` : ''}`);
  // One claim per account every 7 days across wallet, intents and bridged drips.
  const variant = list.some(isBridgedToken) ? 'intents-bridged' : mode;
  const { hits, key } = assertClaimAllowed(accountId, variant, ip);
  markClaim(key, ip, hits); // reserve before any await (see evmDrip)
  if (!trusted) { try { await assertNearEligible(accountId); } catch (e) { unmarkClaim(key, ip, hits); throw e; } }

  const out = [];
  try {
    if (mode === 'intents') {
      // One mt_batch_transfer per chunk of up to 6 tokens (the default six-token drip stays a single tx); 200 Tgas per call.
      for (let i = 0; i < list.length; i += INTENTS_CHUNK) {
        const part = list.slice(i, i + INTENTS_CHUNK);
        const r = await withSigner(MAKER, () => call(MAKER, VERIFIER, 'mt_batch_transfer', { receiver_id: accountId, token_ids: part.map(t => t.assetId), amounts: part.map(t => toUnits(t.drip, t.decimals).toString()), memo: 'tidepool faucet' }, { deposit: 1n, gas: 200n * TGAS }));
        if (!r.ok) throw new Error(r.failures.join('; '));
        out.push({ assets: part.map(t => t.assetId), txHash: r.txHash });
      }
    } else {
      for (const t of list) {
        const r = await withSigner(ROOT, () => call(ROOT, t.nearContract, 'mint', { account_id: accountId, amount: toUnits(t.drip, t.decimals).toString() }));
        if (!r.ok) throw new Error(r.failures.join('; '));
        out.push({ assetId: t.assetId, amount: t.drip, txHash: r.txHash });
      }
    }
  } catch (e) { if (!out.length) clearClaim(key); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { accountId, mode, drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, amount: t.drip })), transactions: out.map(o => ({ ...o, explorerUrl: `https://testnet.nearblocks.io/txns/${o.txHash}` })) };
}
