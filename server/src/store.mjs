// Tiny JSON-file store (Railway volume at DATA_DIR). Fine for a sandbox; not for production volume.
import fs from 'node:fs';
const DIR = process.env.DATA_DIR || new URL('../../data/', import.meta.url).pathname;
fs.mkdirSync(DIR, { recursive: true });
const FILE = DIR + '/swaps.json';
export const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { swaps: {}, faucet: {} };
db.faucet ||= {};
let t = null;
export function save() { clearTimeout(t); t = setTimeout(() => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); }, 200); }
