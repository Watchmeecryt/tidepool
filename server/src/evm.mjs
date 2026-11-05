// EVM side of the Tidepool testnet bridges: providers, the relayer wallet, deposit-address derivation,
// sweeps and payouts. The relayer key comes from TIDEPOOL_EVM_RELAYER_KEY and is never logged.
// Trusted relayer run by Tidepool. Testnet only.
import { ethers } from 'ethers';
import { EVM_CHAINS, chainOf, ETH_RESERVE_WEI } from './config.mjs';
import { withSigner } from './engine.mjs';
import { exclusive } from './guard.mjs';

const VAULT_ABI = [
  'function depositAddress(bytes32 salt) view returns (address)',
  'function sweep(bytes32 salt, address token) returns (uint256)',
  'function release(bytes32 id, address token, address to, uint256 amount)',
  'function released(bytes32) view returns (bool)',
  'event Swept(bytes32 indexed salt, address indexed depositAddress, address indexed token, uint256 amount)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function mint(address to, uint256 v)', 'event Transfer(address indexed from, address indexed to, uint256 value)'];
const KEY = process.env.TIDEPOOL_EVM_RELAYER_KEY;
const providers = {}, wallets = {};
export const provider = (key) => providers[key] ||= new ethers.JsonRpcProvider(chainOf(key).rpc, chainOf(key).chainId, { staticNetwork: true });
export const relayer = (key) => { if (!KEY) throw new Error('EVM relayer key not configured'); return wallets[key] ||= new ethers.Wallet(KEY, provider(key)); };
export const relayerAddress = () => (KEY ? new ethers.Wallet(KEY).address : null);
export const evmTxUrl = (key, h) => `${chainOf(key).explorer}/tx/${h}`;
export const saltOf = (correlationId) => ethers.keccak256(ethers.toUtf8Bytes(`tidepool-deposit:${correlationId}`));

/** CREATE2 deposit address for a quote; computed locally, matches TidepoolVault.depositAddress(salt). */
export function depositAddressFor(chainKey, correlationId) {
  const c = chainOf(chainKey);
  return ethers.getCreate2Address(c.vault, saltOf(correlationId), c.forwarderInitCodeHash);
}
export async function erc20Balance(chainKey, token, holder) {
  return BigInt(await new ethers.Contract(token, ERC20_ABI, provider(chainKey)).balanceOf(holder));
}
// Serialise relayer txs per chain so nonces never collide.
const send = (chainKey, fn) => withSigner(`evm:${chainKey}`, async () => {
  const tx = await fn(relayer(chainKey));
  const rc = await tx.wait(1, 180_000);
  if (rc.status !== 1) throw new Error(`EVM tx reverted ${tx.hash}`);
  return rc;
});
export async function sweep(chainKey, correlationId, token) {
  const c = chainOf(chainKey);
  const rc = await send(chainKey, (w) => new ethers.Contract(c.vault, VAULT_ABI, w).sweep(saltOf(correlationId), token));
  const ev = rc.logs.map(l => { try { return new ethers.Interface(VAULT_ABI).parseLog(l); } catch { return null; } }).find(e => e?.name === 'Swept');
  return { hash: rc.hash, amount: BigInt(ev.args.amount) };
}
export const releaseId = (tag) => ethers.keccak256(ethers.toUtf8Bytes(`tidepool-release:${tag}`));
export async function isReleased(chainKey, id) { return new ethers.Contract(chainOf(chainKey).vault, VAULT_ABI, provider(chainKey)).released(id); }
export async function release(chainKey, id, token, to, amount) {
  const c = chainOf(chainKey);
  const rc = await send(chainKey, (w) => new ethers.Contract(c.vault, VAULT_ABI, w).release(id, token, to, amount));
  return rc.hash;
}
// ---- native ETH payouts (delivery only), sent by the same relayer wallet ----
export const relayerEth = (chainKey) => provider(chainKey).getBalance(relayerAddress());
/** The relayer's ETH balance when it cannot pay `amount` and still keep ETH_RESERVE_WEI for gas, else null. */
export async function nativeShortfall(chainKey, amount) { const have = await relayerEth(chainKey); return have < BigInt(amount) + ETH_RESERVE_WEI ? have : null; }
const ALREADY_KNOWN = /already known|known transaction|nonce too low|already imported|replacement transaction underpriced/i;
/**
 * Sign-first, idempotent native ETH transfer: the signed raw tx (+ hash, nonce) is persisted in `rec` BEFORE broadcast, so a retry only ever
 * rebroadcasts the same bytes. A new tx is signed only when the old one was provably dropped (its nonce was used by another tx).
 * Returns 'confirmed' | 'pending'; throws if the transfer reverted on-chain or the relayer cannot cover it.
 */
export async function driveNative(chainKey, rec, to, amount, persist) {
  return exclusive(rec, async () => {
    const p = provider(chainKey), me = relayerAddress();
    if (rec.hash) {
      const rc = await p.getTransactionReceipt(rec.hash);
      if (rc) { if (rc.status === 1) return 'confirmed'; throw new Error(`native ETH payout reverted on ${chainOf(chainKey).name} (${rec.hash}); needs operator attention`); }
      try { await p.broadcastTransaction(rec.raw); } catch (e) { if (!ALREADY_KNOWN.test(String(e.message))) console.error('evm native rebroadcast:', String(e.message).slice(0, 120)); }
      if (Date.now() - rec.at > 120_000 && !(await p.getTransaction(rec.hash)) && (await p.getTransactionCount(me, 'latest')) > rec.nonce && !(await p.getTransactionReceipt(rec.hash))) {
        for (const k of ['raw', 'hash', 'nonce', 'at']) delete rec[k]; persist(); // dropped: nonce consumed by another tx, free to re-sign
      } else return (await p.waitForTransaction(rec.hash, 1, 20_000).catch(() => null))?.status === 1 ? 'confirmed' : 'pending';
    }
    const short = await nativeShortfall(chainKey, amount);
    if (short !== null) throw new Error(`The ${chainOf(chainKey).name} treasury is low on ETH (${ethers.formatEther(short)} ETH); payout waits until it is refilled`);
    await withSigner(`evm:${chainKey}`, async () => { // one signer per chain: nonces never collide with sweeps/releases
      const w = relayer(chainKey);
      const nonce = await p.getTransactionCount(me, 'pending');
      const raw = await w.signTransaction(await w.populateTransaction({ to, value: BigInt(amount), nonce }));
      Object.assign(rec, { raw, hash: ethers.keccak256(raw), nonce, at: Date.now() }); persist(); // persist BEFORE sending
      try { await p.broadcastTransaction(raw); } catch (e) { if (!ALREADY_KNOWN.test(String(e.message))) console.error('evm native broadcast:', String(e.message).slice(0, 120)); }
    });
    return (await p.waitForTransaction(rec.hash, 1, 30_000).catch(() => null))?.status === 1 ? 'confirmed' : 'pending';
  });
}
export async function mintErc20(chainKey, token, to, amount) {
  const rc = await send(chainKey, (w) => new ethers.Contract(token, ERC20_ABI, w).mint(to, amount));
  return rc.hash;
}
/** Best effort: find the user's ERC-20 transfer(s) into a deposit address in recent blocks. */
export async function findDepositTxs(chainKey, token, to, lookback = 5000) {
  try {
    const p = provider(chainKey);
    const head = await p.getBlockNumber();
    const topics = [ethers.id('Transfer(address,address,uint256)'), null, ethers.zeroPadValue(to, 32)];
    const out = new Set();
    for (let from = Math.max(0, head - lookback); from <= head; from += 1000) {
      const logs = await p.getLogs({ address: token, topics, fromBlock: from, toBlock: Math.min(head, from + 999) });
      logs.forEach(l => out.add(l.transactionHash));
    }
    return [...out];
  } catch { return []; }
}
export async function evmHealth() {
  const out = {};
  for (const c of EVM_CHAINS.filter(c => c.deployed)) {
    try {
      const p = provider(c.key);
      const [height, gas] = await Promise.all([p.getBlockNumber(), KEY ? p.getBalance(relayerAddress()) : 0n]);
      const vault = {};
      for (const t of c.tokens) vault[t.symbol] = ethers.formatUnits(await erc20Balance(c.key, t.evmAddress, c.vault), t.decimals);
      out[c.key] = { ok: Boolean(KEY) && gas > 0n, name: c.name, chainId: c.chainId, height, vault: c.vault, relayer: relayerAddress(), relayerGasEth: ethers.formatEther(gas), vaultBalances: vault, ...(c.nativeEth ? { nativeEth: c.nativeEth.assetId, nativeEthReserve: ethers.formatEther(ETH_RESERVE_WEI), nativeEthPayable: gas >= ETH_RESERVE_WEI } : {}) };
    } catch (e) { out[c.key] = { ok: false, name: c.name, error: String(e.message).slice(0, 200) }; }
  }
  return out;
}
