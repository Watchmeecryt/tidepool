import fs from 'node:fs';
import bs58 from 'bs58';
import { keccak256 } from 'ethers';
import bs58check from 'bs58check';
import * as bitcoin from 'bitcoinjs-lib';
import { Asset, Networks, StrKey } from '@stellar/stellar-base';
import { isValidClassicAddress, isValidXAddress, xAddressToClassicAddress } from 'xrpl';
// Tidepool deployment config: testnet accounts and the test token list.
export const ROOT = process.env.TIDEPOOL_ROOT || 'tidepool-sandbox.testnet';
export const VERIFIER = `verifier.${ROOT}`;
export const MAKER = `maker.${ROOT}`;
export const VERIFIER_WASM_SHA256 = 'a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547'; // near/intents tag defuse/v0.4.5 (commit 16d04f6), reproducible build; NEAR publishes no wasm for this version
export const VERIFIER_RELEASE = 'https://github.com/near/intents/tree/defuse/v0.4.5';

// Test tokens mirror common 1Click assets. Testnet only, no value, not bridged.
export const TOKENS = [
  { sub: 'usdc', symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', fallback: 1, drip: '100', inventory: '2000000' },
  { sub: 'usdt', symbol: 'USDT', decimals: 6, coingeckoId: 'tether', fallback: 1, drip: '100', inventory: '2000000' },
  { sub: 'wnear', symbol: 'wNEAR', decimals: 24, coingeckoId: 'near', fallback: 2.5, drip: '40', inventory: '800000' },
  { sub: 'wbtc', symbol: 'wBTC', decimals: 8, coingeckoId: 'bitcoin', fallback: 100000, drip: '0.001', inventory: '20' },
  { sub: 'eth', symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', fallback: 3500, drip: '0.03', inventory: '600' },
  { sub: 'xaut', symbol: 'XAUT', decimals: 6, coingeckoId: 'tether-gold', fallback: 3000, drip: '0.03', inventory: '600' },
].map(t => ({ ...t, contractAddress: `${t.sub}.${ROOT}`, nearContract: `${t.sub}.${ROOT}`, assetId: `nep141:${t.sub}.${ROOT}`, name: `Tidepool Testnet ${t.symbol} (no value)`, blockchain: 'near' }));
export const NEAR_TOKENS = TOKENS.slice();

// ---- Testnet EVM bridges (trusted relayer run by Tidepool; testnet only) ----
// Bridged assets mirror 1Click's omft naming: nep141:<chain>-<erc20 address>.<OMFT>, e.g.
// nep141:base-0xabc...def.tp-omft.testnet  (mainnet: nep141:base-0x8335...omft.near).
export const OMFT = process.env.TIDEPOOL_OMFT || 'tp-omft.testnet';
export const BRIDGE_ACCOUNT = ROOT; // receives ft_withdraw from the verifier for EVM payouts
export const EVM_CHAINS = [
  { key: 'base', blockchain: 'base', name: 'Base Sepolia', chainId: 84532, rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
  { key: 'arb', blockchain: 'arb', name: 'Arbitrum Sepolia', chainId: 421614, rpc: process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io' },
  { key: 'eth', blockchain: 'eth', name: 'Ethereum Sepolia', chainId: 11155111, rpc: process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
];
const DEPLOYED = JSON.parse(fs.readFileSync(new URL('./bridge-deployments.json', import.meta.url), 'utf8'));
const BRIDGED = [
  { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin', fallback: 1, drip: '100', inventory: '200000' },
  { symbol: 'USDT', decimals: 6, coingeckoId: 'tether', fallback: 1, drip: '100', inventory: '200000' },
];
for (const c of EVM_CHAINS) {
  const d = DEPLOYED[c.key];
  c.deployed = Boolean(d?.vault && d.live);
  if (!d?.vault) continue;
  Object.assign(c, { vault: d.vault, deployBlock: d.deployBlock, forwarderInitCodeHash: d.forwarderInitCodeHash });
  for (const b of BRIDGED) {
    const evm = d.tokens?.[b.symbol];
    if (!evm) continue;
    const near = `${c.key}-${evm.toLowerCase()}.${OMFT}`;
    const t = { ...b, kind: 'evm', sub: `${c.key}-${b.symbol.toLowerCase()}`, chain: c.key, blockchain: c.blockchain, evmAddress: evm, contractAddress: evm, nearContract: near, assetId: `nep141:${near}`, name: `Tidepool Testnet ${b.symbol} on ${c.name} (bridged, no value)` };
    if (c.deployed) TOKENS.push(t);
    c.tokens = [...(c.tokens || []), t];
  }
  // Native ETH: 1Click lists native ETH as nep141:eth.omft.near / base.omft.near / arb.omft.near (18 decimals, no contractAddress);
  // Tidepool mirrors them as nep141:<chain>.tp-omft.testnet. ORIGIN_CHAIN deposits use a per-quote derived EOA swept into the relayer;
  // payouts are plain ETH transfers from the same relayer. Capped per swap (ETH_CAP_WEI); payouts refused below ETH_RESERVE_WEI. Not in c.tokens: no ERC-20.
  if (d.nativeEth?.live) {
    const near = `${c.key}.${OMFT}`;
    const eth = { symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum', fallback: 3500, drip: '0', inventory: d.nativeEth.inventory || '0.02', kind: 'evm', native: true, sub: `${c.key}-eth`, chain: c.key, blockchain: c.blockchain,
      nearContract: near, assetId: `nep141:${near}`, name: `Tidepool Testnet ETH on ${c.name} (bridged, no value)` };
    if (c.deployed) TOKENS.push(eth);
    c.nativeEth = eth;
  }
}
export const ETH_CAP_WEI = BigInt(process.env.ETH_CAP_WEI || 6_000_000_000_000_000); // 0.006 ETH cap on any native ETH swap leg or payout (enforced at quote time)
export const ETH_RESERVE_WEI = BigInt(process.env.ETH_RESERVE_WEI || 5_000_000_000_000_000); // the relayer keeps >= 0.005 ETH for gas after a native ETH payout

// NOTE: the SOL/XLM `drip` values below apply ONLY to the verifier (intents-mode) test tokens nep141:sol.<OMFT> / nep141:stellar.<OMFT>.
// Native SOL/XLM are never dripped to wallets (solDrip/stellarDrip skip `native`): gas comes from each chain's own faucet.
// ---- Solana devnet bridge (trusted relayer run by Tidepool; devnet only) ----
// Official 1Click/omft naming for Solana: native SOL is nep141:sol.omft.near; an SPL token is
// nep141:sol-<last 20 bytes of keccak256(mint pubkey bytes), hex>.omft.near. We mirror it under tp-omft.testnet.
export const solOmftSub = (mint) => 'sol-' + keccak256(bs58.decode(mint)).slice(-40);
export const SOL_PAYOUT_CAP_LAMPORTS = BigInt(process.env.SOL_PAYOUT_CAP_LAMPORTS || 5_000_000); // 0.005 SOL cap on any SOL swap leg, payout or refund (enforced at quote time)
export const SOL_RENT_MIN_LAMPORTS = 890_880n; // rent-exempt minimum of a 0-data account: smaller SOL transfers to a fresh address fail on-chain
export const SOL_CHAIN = { key: 'sol', blockchain: 'sol', kind: 'sol', name: 'Solana Devnet', cluster: 'devnet', explorer: 'https://explorer.solana.com' };
export const isSolAddress = (s) => {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
};
const SD = DEPLOYED.sol;
SOL_CHAIN.deployed = Boolean(SD?.relayer && SD.live && SD.tokens?.USDC && SD.tokens?.USDT);
if (SD?.relayer) {
  SOL_CHAIN.relayer = SD.relayer;
  SOL_CHAIN.tokens = [];
  const common = { chain: 'sol', kind: 'sol', blockchain: 'sol' };
  const sol = { ...common, sub: 'sol', symbol: 'SOL', decimals: 9, coingeckoId: 'solana', fallback: 150, drip: '0.05', inventory: SD.inventory?.SOL || '1', native: true,
    nearContract: `sol.${OMFT}`, assetId: `nep141:sol.${OMFT}`, name: 'Tidepool Testnet SOL on Solana Devnet (bridged, no value)' };
  const spl = BRIDGED.filter(b => SD.tokens?.[b.symbol]).map(b => { const mint = SD.tokens[b.symbol], sub = solOmftSub(mint);
    return { ...b, ...common, sub: `sol-${b.symbol.toLowerCase()}`, mint, contractAddress: mint, nearContract: `${sub}.${OMFT}`, assetId: `nep141:${sub}.${OMFT}`, name: `Tidepool Testnet ${b.symbol} on Solana Devnet (bridged, no value)` }; });
  for (const t of [sol, ...spl]) { if (SOL_CHAIN.deployed) TOKENS.push(t); SOL_CHAIN.tokens.push(t); }
}
// ---- Stellar testnet bridge (trusted relayer run by Tidepool; testnet only) ----
// 1Click lists Stellar as nep245 (HOT) assets and requires depositMode MEMO (one shared deposit address + a numeric memo). Tidepool
// keeps the memo model but uses OMFT-style nep141 ids like the other bridges: native XLM is nep141:stellar.<OMFT>; a classic
// issued asset is nep141:stellar-<last 20 bytes of keccak256(32-byte Stellar Asset Contract id, hex)>.<OMFT> (the SAC id is the
// stellar analogue of a Solana mint address: C... strkey of sha256 over the network id and the asset).
export const STELLAR_DECIMALS = 7;
export const stellarSacId = (code, issuer) => new Asset(code, issuer).contractId(Networks.TESTNET);
export const stellarOmftSub = (code, issuer) => 'stellar-' + keccak256(StrKey.decodeContract(stellarSacId(code, issuer))).slice(-40);
export const XLM_CAP_STROOPS = BigInt(process.env.STELLAR_XLM_CAP_STROOPS || 1_000_000_000); // 100 XLM cap on any XLM swap leg, payout or refund (enforced at quote time)
export const XLM_CREATE_MIN_STROOPS = 10_000_000n; // a payout to a not-yet-existing account must fund it with >= 1 XLM (2 x base reserve)
export const STELLAR_CHAIN = { key: 'stellar', blockchain: 'stellar', kind: 'stellar', name: 'Stellar Testnet', network: 'testnet', explorer: 'https://stellar.expert/explorer/testnet', friendbot: 'https://friendbot.stellar.org' };
export const isStellarAddress = (s) => typeof s === 'string' && StrKey.isValidEd25519PublicKey(s);
const XD = DEPLOYED.stellar;
STELLAR_CHAIN.deployed = Boolean(XD?.treasury && XD.live && XD.tokens?.USDC && XD.tokens?.USDT);
if (XD?.treasury) {
  STELLAR_CHAIN.treasury = XD.treasury; STELLAR_CHAIN.issuer = XD.issuer;
  STELLAR_CHAIN.tokens = [];
  const common = { chain: 'stellar', kind: 'stellar', blockchain: 'stellar' };
  const xlm = { ...common, sub: 'stellar', symbol: 'XLM', decimals: STELLAR_DECIMALS, coingeckoId: 'stellar', fallback: 0.17, drip: '5', inventory: XD.inventory?.XLM || '1', native: true,
    nearContract: `stellar.${OMFT}`, assetId: `nep141:stellar.${OMFT}`, name: 'Tidepool Testnet XLM on Stellar Testnet (bridged, no value)' };
  const classic = BRIDGED.filter(b => XD.tokens?.[b.symbol]).map(b => { const { code, issuer } = XD.tokens[b.symbol], sub = stellarOmftSub(code, issuer);
    return { ...b, ...common, decimals: STELLAR_DECIMALS, inventory: XD.inventory?.[b.symbol] || b.inventory, sub: `stellar-${b.symbol.toLowerCase()}`, code, issuer, contractAddress: issuer, sacId: stellarSacId(code, issuer), nearContract: `${sub}.${OMFT}`, assetId: `nep141:${sub}.${OMFT}`, name: `Tidepool Testnet ${b.symbol} on Stellar Testnet (bridged, no value)` }; });
  for (const t of [xlm, ...classic]) { if (STELLAR_CHAIN.deployed) TOKENS.push(t); STELLAR_CHAIN.tokens.push(t); }
}
// ---- Sui testnet bridge (trusted relayer run by Tidepool; testnet only) ----
// Same shape as the Solana bridge: a PER-QUOTE deposit address (Sui needs no memo, and 1Click uses plain deposit addresses for Sui),
// swept into the treasury with gas sponsored by the treasury. Native SUI is nep141:sui.<OMFT>; a Move coin is
// nep141:sui-<last 20 bytes of keccak256(utf8 coin type "0x<package>::<module>::<NAME>")>.<OMFT> (this reproduces 1Click's mainnet
// id for Sui USDC). Test USDC/USDT are Tidepool's own Move coins (the treasury holds the TreasuryCaps and mints payouts).
export const SUI_DECIMALS = 9;
export const SUI_COIN_TYPE = '0x2::sui::SUI';
export const suiOmftSub = (coinType) => 'sui-' + keccak256(Buffer.from(coinType, 'utf8')).slice(-40);
export const SUI_CAP_MIST = BigInt(process.env.SUI_CAP_MIST || 5_000_000); // 0.005 SUI cap on any SUI swap leg, payout or refund (enforced at quote time)
export const SUI_CHAIN = { key: 'sui', blockchain: 'sui', kind: 'sui', name: 'Sui Testnet', network: 'testnet', explorer: 'https://suiscan.xyz/testnet', faucet: 'https://faucet.sui.io' };
export const isSuiAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
export const normSuiAddress = (s) => s.toLowerCase();
const UD = DEPLOYED.sui;
SUI_CHAIN.deployed = Boolean(UD?.treasury && UD.live && UD.tokens?.USDC && UD.tokens?.USDT);
if (UD?.treasury) {
  SUI_CHAIN.treasury = UD.treasury; SUI_CHAIN.package = UD.package;
  SUI_CHAIN.tokens = [];
  const common = { chain: 'sui', kind: 'sui', blockchain: 'sui' };
  const sui = { ...common, sub: 'sui', symbol: 'SUI', decimals: SUI_DECIMALS, coingeckoId: 'sui', fallback: 3, drip: '0.005', inventory: UD.inventory?.SUI || '1', native: true, coinType: SUI_COIN_TYPE,
    nearContract: `sui.${OMFT}`, assetId: `nep141:sui.${OMFT}`, name: 'Tidepool Testnet SUI on Sui Testnet (bridged, no value)' };
  const coins = BRIDGED.filter(b => UD.tokens?.[b.symbol]).map(b => { const { coinType, treasuryCap } = UD.tokens[b.symbol], sub = suiOmftSub(coinType);
    return { ...b, ...common, inventory: UD.inventory?.[b.symbol] || b.inventory, sub: `sui-${b.symbol.toLowerCase()}`, coinType, treasuryCap, contractAddress: coinType, nearContract: `${sub}.${OMFT}`, assetId: `nep141:${sub}.${OMFT}`, name: `Tidepool Testnet ${b.symbol} on Sui Testnet (bridged, no value)` }; });
  for (const t of [sui, ...coins]) { if (SUI_CHAIN.deployed) TOKENS.push(t); SUI_CHAIN.tokens.push(t); }
}

// ---- XRP Ledger testnet bridge (trusted relayer run by Tidepool; testnet only) ----
// 1Click lists native XRP as nep141:xrp.omft.near (6 decimals) and requires depositMode MEMO: ONE shared deposit address plus a
// numeric destination tag as the memo. Tidepool mirrors the Stellar bridge: native XRP is nep141:xrp.tp-omft.testnet, the treasury
// credits a deposit when a validated Payment carries the quote's destination tag (no sweep), and payouts/refunds are signed by the
// treasury. Native XRP only: 1Click has no issued XRPL tokens, so Tidepool has no test USDC/USDT on XRPL either.
export const XRP_DECIMALS = 6;
export const XRP_CAP_DROPS = BigInt(process.env.XRP_CAP_DROPS || 100_000_000); // 100 XRP cap on any XRP swap leg, payout or refund (enforced at quote time)
export const XRP_RESERVE_DROPS = 1_000_000n; // base reserve on XRPL testnet: a payout to a not-yet-existing account must deliver >= 1 XRP
export const XRP_CHAIN = { key: 'xrp', blockchain: 'xrp', kind: 'xrp', name: 'XRP Ledger Testnet', network: 'testnet', explorer: 'https://testnet.xrpl.org', faucet: 'https://faucet.altnet.rippletest.net/accounts', symbol: 'XRP' };
// Classic r... addresses, or testnet X-addresses (T..., a classic address plus an optional destination tag in one string, as 1Click accepts).
export const parseXrpAddress = (s) => {
  if (typeof s !== 'string') return null;
  try {
    if (isValidClassicAddress(s)) return { address: s, tag: undefined };
    if (isValidXAddress(s)) { const x = xAddressToClassicAddress(s); return x.test ? { address: x.classicAddress, tag: x.tag === false ? undefined : x.tag } : null; }
  } catch { /* invalid */ }
  return null;
};
export const isXrpAddress = (s) => Boolean(parseXrpAddress(s));
const XRD = DEPLOYED.xrp;
XRP_CHAIN.deployed = Boolean(XRD?.treasury && XRD.live);
if (XRD?.treasury) {
  XRP_CHAIN.treasury = XRD.treasury;
  XRP_CHAIN.tokens = [];
  const xrp = { chain: 'xrp', kind: 'xrp', blockchain: 'xrp', sub: 'xrp', symbol: 'XRP', decimals: XRP_DECIMALS, coingeckoId: 'ripple', fallback: 2, drip: '0', inventory: XRD.inventory?.XRP || '1', native: true,
    nearContract: `xrp.${OMFT}`, assetId: `nep141:xrp.${OMFT}`, name: 'Tidepool Testnet XRP on XRP Ledger Testnet (bridged, no value)' };
  if (XRP_CHAIN.deployed) TOKENS.push(xrp);
  XRP_CHAIN.tokens.push(xrp);
}

// ---- Bitcoin testnet4 and Zcash testnet bridges (trusted relayer run by Tidepool; testnet only) ----
// Same shape as the Sui bridge and as 1Click's mainnet BTC/ZEC support: NATIVE only, a PER-QUOTE plain deposit address (no memo), swept
// into the treasury by the relayer. Ids mirror 1Click's nep141:btc.omft.near / nep141:zec.omft.near under tp-omft.testnet. Both
// assets have 8 decimals. Native testnet coins are never dripped by the Tidepool faucet: get them from the public faucets
// (tBTC: https://cypherfaucet.com/btc-testnet or https://mempool.space/testnet4/faucet; TAZ: https://faucet.testnet.valargroup.dev/).
export const BTC_DECIMALS = 8, ZEC_DECIMALS = 8;
export const BTC_CAP_SATS = BigInt(process.env.BTC_CAP_SATS || 500_000); // 0.005 tBTC cap on any BTC swap leg, payout or refund (enforced at quote time)
export const BTC_MIN_SATS = BigInt(process.env.BTC_MIN_SATS || 10_000); // 0.0001 tBTC minimum (a sweep and a payout each pay a network fee)
export const ZEC_CAP_ZAT = BigInt(process.env.ZEC_CAP_ZAT || 50_000_000); // 0.5 TAZ cap
export const ZEC_MIN_ZAT = BigInt(process.env.ZEC_MIN_ZAT || 200_000); // 0.002 TAZ minimum (ZIP-317 fees are 0.0001 TAZ per transparent action)
export const BTC_CHAIN = { key: 'btc', blockchain: 'btc', kind: 'btc', name: 'Bitcoin Testnet4', network: 'testnet4', explorer: 'https://mempool.space/testnet4', faucet: 'https://cypherfaucet.com/btc-testnet', confirmations: 1, symbol: 'BTC' };
export const ZEC_CHAIN = { key: 'zec', blockchain: 'zec', kind: 'zec', name: 'Zcash Testnet', network: 'testnet', explorer: 'https://testnet.zcashexplorer.app', faucet: 'https://faucet.testnet.valargroup.dev/', confirmations: 1, symbol: 'ZEC' };
// tb1q... (native segwit p2wpkh, testnet/testnet4) and bech32 taproot tb1p...; legacy m/n and 2... addresses are accepted too (base58check).
export const isBtcAddress = (s) => {
  if (typeof s !== 'string' || s.length < 26 || s.length > 90) return false;
  try { bitcoin.address.toOutputScript(s, bitcoin.networks.testnet); return true; } catch { return false; }
};
// Zcash TRANSPARENT testnet addresses only: tm... (p2pkh, 0x1D25) and t2... (p2sh, 0x1CBA). Shielded (ztestsapling/utest) are not supported.
export const ZEC_P2PKH = Buffer.from([0x1d, 0x25]), ZEC_P2SH = Buffer.from([0x1c, 0xba]);
export const decodeZecAddress = (s) => {
  if (typeof s !== 'string' || !/^t[m2][1-9A-HJ-NP-Za-km-z]{32,36}$/.test(s)) return null;
  try { const b = Buffer.from(bs58check.decode(s)); if (b.length !== 22) return null; const p = b.subarray(0, 2); return p.equals(ZEC_P2PKH) ? { type: 'p2pkh', hash: b.subarray(2) } : p.equals(ZEC_P2SH) ? { type: 'p2sh', hash: b.subarray(2) } : null; } catch { return null; }
};
export const isZecAddress = (s) => Boolean(decodeZecAddress(s));
const UTXO_NATIVE = [[BTC_CHAIN, 'btc', 'BTC', 'bitcoin', 100000, 'Bitcoin Testnet4'], [ZEC_CHAIN, 'zec', 'ZEC', 'zcash', 40, 'Zcash Testnet']];
for (const [C, k, symbol, coingeckoId, fallback, label] of UTXO_NATIVE) {
  const D = DEPLOYED[k];
  // Zcash is built but DISABLED unless ZEC_ENABLED=1 (no public TAZ faucet could fund the treasury, so it is not listed anywhere)
  C.deployed = Boolean(D?.treasury && D.live && (k !== 'zec' || process.env.ZEC_ENABLED === '1'));
  if (!D?.treasury) continue;
  C.treasury = D.treasury; C.tokens = [];
  const t = { chain: k, kind: k, blockchain: k, sub: k, symbol, decimals: 8, coingeckoId, fallback, drip: '0', inventory: D.inventory?.[symbol] || '1', native: true,
    nearContract: `${k}.${OMFT}`, assetId: `nep141:${k}.${OMFT}`, name: `Tidepool Testnet ${symbol} on ${label} (bridged, no value)` };
  if (C.deployed) TOKENS.push(t);
  C.tokens.push(t);
}

// ---- Ondo tokenized stocks/RWAs (testnet mirrors of 1Click ondoTokens=1; live on Base Sepolia) ----
// Mainnet lists these under blockchain "bsc" with nep141:bnb-<addr>.omdep.near. Tidepool has no BSC
// testnet gas, so ERC-20s live on Base Sepolia (chain key "base") while the API shape keeps blockchain "bsc"
// and nep141:bnb-<addr>.tp-omdep.testnet. Gated behind GET /v0/tokens?ondoTokens=1 (omitted otherwise, like mainnet).
export const OMDEP = process.env.TIDEPOOL_OMDEP || 'tp-omdep.testnet';
const ONDO_DEP = JSON.parse(fs.readFileSync(new URL('./ondo-deployments.json', import.meta.url), 'utf8'));
const ONDO_CAT = JSON.parse(fs.readFileSync(new URL('./ondo-catalog.json', import.meta.url), 'utf8'));
export const ONDO_TOKENS = [];
if (ONDO_DEP.live && ONDO_DEP.tokens) {
  const base = EVM_CHAINS.find(c => c.key === 'base');
  for (const meta of ONDO_CAT) {
    const d = ONDO_DEP.tokens[meta.symbol];
    if (!d?.address || !d.nearReady) continue;
    const evm = d.address.toLowerCase();
    const near = d.nearContract || `bnb-${evm}.${OMDEP}`;
    const t = {
      symbol: meta.symbol, decimals: meta.decimals, coingeckoId: meta.coingeckoId, fallback: meta.fallback,
      drip: '0', inventory: '10000', kind: 'evm', ondo: true, sub: `bnb-${meta.symbol.toLowerCase()}`,
      chain: 'base', blockchain: 'bsc', evmAddress: evm, contractAddress: evm,
      nearContract: near, assetId: `nep141:${near}`,
      name: `Tidepool Testnet ${meta.symbol} (Ondo on Base Sepolia, no value)`,
    };
    ONDO_TOKENS.push(t);
    if (base) base.tokens = [...(base.tokens || []), t];
  }
}
// Ondo tokens are NOT pushed into TOKENS by default; tokens() adds them when ondoTokens=1.

export const chainOf = (key) => key === 'sol' ? SOL_CHAIN : key === 'stellar' ? STELLAR_CHAIN : key === 'sui' ? SUI_CHAIN : key === 'btc' ? BTC_CHAIN : key === 'zec' ? ZEC_CHAIN : key === 'xrp' ? XRP_CHAIN : EVM_CHAINS.find(c => c.key === key);
export const isEvmAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

export const toUnits = (s, d) => { const [i, f = ''] = String(s).split('.'); return BigInt(i + (f + '0'.repeat(d)).slice(0, d)); };
export const fromUnits = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'); const i = s.slice(0, -d) || '0'; const f = s.slice(-d).replace(/0+$/, ''); return d ? (f ? `${i}.${f}` : i) : s; };
