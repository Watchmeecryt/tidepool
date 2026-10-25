// Writes lib/lastmod.json (docs page path -> ISO date of last git commit). Kept committed so builds without .git (Docker) reuse it.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname); const root = path.join(here, '..'); const outFile = path.join(root, 'lib/lastmod.json');
let out = {};
try {
  execSync('git rev-parse --git-dir', { cwd: root, stdio: 'ignore' });
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mdx') ? [path.join(d, e.name)] : []);
  for (const f of walk(path.join(root, 'content/docs'))) {
    const rel = path.relative(path.join(root, 'content/docs'), f).replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
    const d = execSync(`git log -1 --format=%cI -- "${f}"`, { cwd: root }).toString().trim();
    out[rel] = d || new Date().toISOString();
  }
  out[':home'] = execSync('git log -1 --format=%cI -- "app/(home)"', { cwd: root }).toString().trim() || new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
} catch { if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, '{}\n'); }
