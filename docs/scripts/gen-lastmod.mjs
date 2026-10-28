// Writes lib/lastmod.json (docs page path -> ISO date of last git commit). Kept committed so builds without .git (Docker) reuse it.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname); const root = path.join(here, '..'); const outFile = path.join(root, 'lib/lastmod.json');
let out = {};
let prev = {}; try { prev = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
try {
  execSync('git rev-parse --git-dir', { cwd: root, stdio: 'ignore' });
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mdx') ? [path.join(d, e.name)] : []);
  for (const f of walk(path.join(root, 'content/docs'))) {
    const rel = path.relative(path.join(root, 'content/docs'), f).replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
    const d = execSync(`git log -1 --format=%cI -- "${f}"`, { cwd: root }).toString().trim();
    if (d || prev[rel]) out[rel] = d || prev[rel]; // never stamp build time
  }
  const h = execSync('git log -1 --format=%cI -- "app/(home)" components/ocean.tsx', { cwd: root }).toString().trim() || prev[':home'];
  if (h) out[':home'] = h;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
} catch { if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, '{}\n'); }
