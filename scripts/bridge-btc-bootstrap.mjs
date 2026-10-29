// Thin wrapper: node scripts/bridge-btc-bootstrap.mjs  (see bridge-utxo-bootstrap.mjs)
process.argv[2] = 'btc';
await import('./bridge-utxo-bootstrap.mjs');
