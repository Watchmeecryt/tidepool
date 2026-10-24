// Faucet: drips every test token to a testnet account, either to the wallet (mint) or straight into
// the account's balance inside the Tidepool verifier (transfer from maker inventory).
import { call, viewAccount, TGAS } from './near.mjs';
import { ROOT, VERIFIER, MAKER, TOKENS, toUnits } from './config.mjs';
import { db, save } from './store.mjs';
import { withSigner, BadRequest } from './engine.mjs';

const ACCOUNT_COOLDOWN_MS = 60 * 60_000; // one drip per account per hour
const IP_LIMIT = 6; // drips per IP per hour
const ipHits = new Map();

export async function drip({ accountId, mode = 'wallet', assets }, ip) {
  if (typeof accountId !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(accountId)) throw new BadRequest('accountId must be a NEAR testnet account id');
  if (!['wallet', 'intents'].includes(mode)) throw new BadRequest('mode must be "wallet" or "intents"');
  const list = assets?.length ? TOKENS.filter(t => assets.includes(t.assetId) || assets.includes(t.symbol)) : TOKENS;
  if (!list.length) throw new BadRequest('no matching assets');
  const key = `${accountId}:${mode}`;
  const last = db.faucet[key] || 0;
  if (Date.now() - last < ACCOUNT_COOLDOWN_MS) throw new BadRequest(`Rate limited: ${accountId} can use the ${mode} faucet again after ${new Date(last + ACCOUNT_COOLDOWN_MS).toISOString()}`, 429);
  const hits = (ipHits.get(ip) || []).filter(t => Date.now() - t < 3600_000);
  if (hits.length >= IP_LIMIT) throw new BadRequest('Rate limited: too many faucet requests from this IP, try again within the hour', 429);
  if (mode === 'wallet' && !(await viewAccount(accountId))) throw new BadRequest(`${accountId} does not exist on testnet. Create it first (wallet or https://helper.nearprotocol.com) or use mode "intents"`);
  db.faucet[key] = Date.now(); hits.push(Date.now()); ipHits.set(ip, hits); save();

  const out = [];
  try {
    if (mode === 'intents') {
      const r = await withSigner(MAKER, () => call(MAKER, VERIFIER, 'mt_batch_transfer', { receiver_id: accountId, token_ids: list.map(t => t.assetId), amounts: list.map(t => toUnits(t.drip, t.decimals).toString()), memo: 'tidepool faucet' }, { deposit: 1n, gas: 100n * TGAS }));
      if (!r.ok) throw new Error(r.failures.join('; '));
      out.push({ assets: list.map(t => t.assetId), txHash: r.txHash });
    } else {
      for (const t of list) {
        const r = await withSigner(ROOT, () => call(ROOT, t.contractAddress, 'mint', { account_id: accountId, amount: toUnits(t.drip, t.decimals).toString() }));
        if (!r.ok) throw new Error(r.failures.join('; '));
        out.push({ assetId: t.assetId, amount: t.drip, txHash: r.txHash });
      }
    }
  } catch (e) { delete db.faucet[key]; save(); throw new Error('faucet transfer failed: ' + String(e.message).slice(0, 200)); }
  return { accountId, mode, drips: list.map(t => ({ assetId: t.assetId, symbol: t.symbol, amount: t.drip })), transactions: out.map(o => ({ ...o, explorerUrl: `https://testnet.nearblocks.io/txns/${o.txHash}` })) };
}
