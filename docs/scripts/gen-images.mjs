// One-off generator for favicons + 1200x630 OG image (NEAR Private OTC warm palette). Run: node scripts/gen-images.mjs (outputs committed in public/).
import sharp from 'sharp'; import fs from 'node:fs'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname); const pub = path.join(here, '../public');
const brand = JSON.parse(fs.readFileSync(path.join(here, '../brand.json'), 'utf8'));
const svg = fs.readFileSync(path.join(pub, 'favicon.svg'));
for (const [n, s] of [['favicon-16x16.png', 16], ['favicon-32x32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) await sharp(svg, { density: 1200 }).resize(s, s).png().toFile(path.join(pub, n));
// maskable: logo on solid bg with safe padding
await sharp({ create: { width: 512, height: 512, channels: 4, background: brand.backgroundColor } }).composite([{ input: await sharp(svg, { density: 1200 }).resize(340, 340).png().toBuffer(), gravity: 'center' }]).png().toFile(path.join(pub, 'icon-maskable-512.png'));
// favicon.ico (PNG-in-ICO, 32px)
const png32 = await sharp(svg, { density: 1200 }).resize(32, 32).png().toBuffer();
const h = Buffer.alloc(22); h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4); h.writeUInt8(32, 6); h.writeUInt8(32, 7); h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12); h.writeUInt32LE(png32.length, 14); h.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(pub, 'favicon.ico'), Buffer.concat([h, png32]));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const wave = (y, a) => `M0 ${y} C 200 ${y - a}, 400 ${y + a}, 600 ${y} S 1000 ${y - a}, 1200 ${y} V 630 H 0 Z`;
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><radialGradient id="a1" cx="0.85" cy="0" r="0.75"><stop offset="0" stop-color="#3a2a14"/><stop offset=".6" stop-color="#1a1613"/><stop offset="1" stop-color="#12100e"/></radialGradient>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffad24"/><stop offset=".55" stop-color="#ffd078"/><stop offset="1" stop-color="#f3e3c3"/></linearGradient></defs>
<rect width="1200" height="630" fill="#12100e"/><rect width="1200" height="630" fill="url(#a1)"/>
<rect x="0.5" y="0.5" width="1199" height="629" fill="none" stroke="#3a332c"/>
<g transform="translate(80,80) scale(3)"><circle cx="16" cy="16" r="15" fill="url(#g)"/><path d="M5 17c3.5-3 7.5-3 11 0s7.5 3 11 0" fill="none" stroke="#1d1b18" stroke-width="2.4" stroke-linecap="round"/><path d="M8 22c2.7-2 5.3-2 8 0s5.3 2 8 0" fill="none" stroke="#1d1b18" stroke-opacity=".6" stroke-width="2" stroke-linecap="round"/></g>
<text x="190" y="150" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="64" fill="#f3efe8">Tidepool</text>
<rect x="525" y="103" rx="20" width="130" height="40" fill="#ffad24" fill-opacity=".14" stroke="#ffc052" stroke-opacity=".5"/><text x="590" y="130" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#ffc052">testnet</text>
<text x="80" y="290" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="58" fill="#f3efe8">NEAR Intents testnet sandbox</text>
<text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#ffc052">1Click API-compatible · test tokens · faucet</text>
<text x="80" y="410" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#d6d0c6">Test swaps end to end without real funds</text>
<line x1="80" y1="445" x2="1120" y2="445" stroke="#3a332c"/>
<text x="80" y="490" font-family="DejaVu Sans Mono, monospace" font-size="24" fill="#a8a094">www.usetidepool.tech</text>
<text x="1120" y="490" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#a8a094">${esc(brand.affiliation)}</text>
</svg>`;
await sharp(Buffer.from(og)).png().toFile(path.join(pub, 'og.png'));
console.log('ok');
