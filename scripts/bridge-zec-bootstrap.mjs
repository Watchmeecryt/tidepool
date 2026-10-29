// Thin wrapper: node scripts/bridge-zec-bootstrap.mjs  (see bridge-utxo-bootstrap.mjs)
process.argv[2] = 'zec';
await import('./bridge-utxo-bootstrap.mjs');
