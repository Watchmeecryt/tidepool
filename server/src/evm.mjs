// EVM side of the Tidepool testnet bridges: providers, the relayer wallet, deposit-address derivation,
// sweeps and payouts. The relayer key comes from TIDEPOOL_EVM_RELAYER_KEY and is never logged.
// Trusted relayer run by Tidepool. Testnet only.
import crypto from 'node:crypto';
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

/** CREATE2 deposit address for a quote; computed locally, matches TidepoolVault.depositAddress(salt). ERC-20 only. */
export function depositAddressFor(chainKey, correlationId) {
  const c = chainOf(chainKey);
  return ethers.getCreate2Address(c.vault, saltOf(correlationId), c.forwarderInitCodeHash);
}
/** Per-quote EOA for native ETH deposits (vault forwarder only sweeps ERC-20). HMAC-SHA256(master, "tidepool-evm-eth-deposit:<id>") as secp256k1 key. */
export function nativeDepositWallet(master, correlationId) {
  const sk = crypto.createHmac('sha256', master).update(`tidepool-evm-eth-deposit:${correlationId}`).digest();
  return new ethers.Wallet('0x' + sk.toString('hex'));
}
export const nativeDepositAddressFor = (master, correlationId) => nativeDepositWallet(master, correlationId).address;
export const ethBalance = (chainKey, holder) => provider(chainKey).getBalance(holder);
export async function erc20Balance(chainKey, token, holder) {
  return BigInt(await new ethers.Contract(token, ERC20_ABI, provider(chainKey)).balanceOf(holder));
}
// Serialise relayer txs per chain so nonces never collide.
// Relayer sends are serialized per chain (withSigner) and use a locally tracked nonce, so concurrent faucet claims or a lagging
// RPC node can't hand two txs the same nonce; on "nonce already used / too low" we resync from the chain and retry once.
const nextNonce = {};
const NONCE_ERR = /nonce (has )?already (been )?used|nonce too low|NONCE_EXPIRED|replacement transaction underpriced/i;
const send = (chainKey, fn) => withSigner(`evm:${chainKey}`, async () => {
  const w = relayer(chainKey);
  let tx;
  for (let attempt = 0; ; attempt++) {
    const chainNonce = await w.provider.getTransactionCount(w.address, 'pending');
    const nonce = Math.max(chainNonce, nextNonce[chainKey] ?? 0);
    const sw = w.connect(w.provider); sw.getNonce = async () => nonce; // pin the nonce for this one tx
    try { tx = await fn(sw); nextNonce[chainKey] = nonce + 1; break; }
    catch (e) { if (attempt === 0 && NONCE_ERR.test(String(e?.message || e))) { nextNonce[chainKey] = Math.max(chainNonce + 1, nonce + 1); continue; } throw e; }
  }
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
// ---- native ETH: payouts from the relayer; ORIGIN_CHAIN deposits use derived EOAs swept into the relayer ----
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
/**
 * Sweep native ETH from a per-quote deposit EOA into the relayer. Sign-first/idempotent like driveNative.
 * Relayer tops up gas on the deposit address when needed so the full `amount` (snapshotted before top-up) can be transferred.
 */
export async function driveNativeSweep(chainKey, master, correlationId, rec, amount, persist) {
  return exclusive(rec, async () => {
    const p = provider(chainKey), amt = BigInt(amount);
    const dep = nativeDepositWallet(master, correlationId).connect(p);
    const to = relayerAddress();
    if (!to) throw new Error('EVM relayer key not configured');
    if (rec.hash) {
      const rc = await p.getTransactionReceipt(rec.hash);
      if (rc) { if (rc.status === 1) return 'confirmed'; throw new Error(`native ETH sweep reverted on ${chainOf(chainKey).name} (${rec.hash}); needs operator attention`); }
      try { await p.broadcastTransaction(rec.raw); } catch (e) { if (!ALREADY_KNOWN.test(String(e.message))) console.error('evm native sweep rebroadcast:', String(e.message).slice(0, 120)); }
      if (Date.now() - rec.at > 120_000 && !(await p.getTransaction(rec.hash)) && (await p.getTransactionCount(dep.address, 'latest')) > rec.nonce && !(await p.getTransactionReceipt(rec.hash))) {
        for (const k of ['raw', 'hash', 'nonce', 'at']) delete rec[k]; persist();
      } else return (await p.waitForTransaction(rec.hash, 1, 20_000).catch(() => null))?.status === 1 ? 'confirmed' : 'pending';
    }
    const fee = await p.getFeeData();
    const gasLimit = 21_000n;
    const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 1_000_000_000n;
    const gasCost = gasLimit * maxFee * 15n / 10n; // 50% headroom so the transfer lands
    const bal = await p.getBalance(dep.address);
    if (bal < amt + gasCost) {
      const need = amt + gasCost - bal;
      const short = await nativeShortfall(chainKey, need);
      if (short !== null) throw new Error(`The ${chainOf(chainKey).name} treasury is low on ETH for a deposit gas top-up (${ethers.formatEther(short)} ETH); sweep waits until it is refilled`);
      const top = await send(chainKey, (w) => w.sendTransaction({ to: dep.address, value: need }));
      rec.gasTopUp = top.hash; persist();
    }
    await withSigner(`evm-dep:${dep.address.toLowerCase()}`, async () => {
      const nonce = await p.getTransactionCount(dep.address, 'pending');
      const raw = await dep.signTransaction(await dep.populateTransaction({ to, value: amt, nonce, gasLimit }));
      Object.assign(rec, { raw, hash: ethers.keccak256(raw), nonce, at: Date.now() }); persist();
      try { await p.broadcastTransaction(raw); } catch (e) { if (!ALREADY_KNOWN.test(String(e.message))) console.error('evm native sweep broadcast:', String(e.message).slice(0, 120)); }
    });
    return (await p.waitForTransaction(rec.hash, 1, 30_000).catch(() => null))?.status === 1 ? 'confirmed' : 'pending';
  });
}
export async function mintErc20(chainKey, token, to, amount) {
  const rc = await send(chainKey, (w) => new ethers.Contract(token, ERC20_ABI, w).mint(to, amount));
  return rc.hash;
}
/** Best effort: find native value transfers into a deposit address in recent blocks (no Transfer logs). */
export async function findNativeDepositTxs(chainKey, to, lookback = 64) {
  try {
    const p = provider(chainKey), head = await p.getBlockNumber(), out = new Set();
    const want = to.toLowerCase();
    for (let n = Math.max(0, head - lookback); n <= head; n++) {
      const b = await p.getBlock(n, true);
      if (!b?.prefetchedTransactions) continue;
      for (const tx of b.prefetchedTransactions) if (tx.to && tx.to.toLowerCase() === want && tx.value > 0n) out.add(tx.hash);
    }
    return [...out];
  } catch { return []; }
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
