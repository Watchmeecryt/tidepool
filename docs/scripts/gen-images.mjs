// One-off generator for favicons + 1200x630 OG image (deep-ocean style). Run: node scripts/gen-images.mjs (outputs committed in public/).
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
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#062a35"/><stop offset="1" stop-color="#020f15"/></linearGradient>
<radialGradient id="a1" cx="0.2" cy="0.15" r="0.6"><stop offset="0" stop-color="#14b8a6" stop-opacity=".45"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0"/></radialGradient>
<radialGradient id="a2" cx="0.85" cy="0.1" r="0.55"><stop offset="0" stop-color="#22d3ee" stop-opacity=".35"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#a1)"/><rect width="1200" height="630" fill="url(#a2)"/>
<path d="${wave(520, 30)}" fill="#14b8a6" opacity=".18"/><path d="${wave(560, 22)}" fill="#22d3ee" opacity=".14"/><path d="${wave(595, 16)}" fill="#5eead4" opacity=".12"/>
<g transform="translate(80,80) scale(3)"><circle cx="16" cy="16" r="15" fill="#d9f0eb"/><path d="M5 17c3-3 5-3 8 0s5 3 8 0 5-3 6-1v6a12 12 0 0 1-22 0z" fill="#0f766e"/><path d="M6 12c2.5-2 4.5-2 7 0s4.5 2 7 0 4.5-2 6 0" stroke="#5eb8a8" stroke-width="2" fill="none" stroke-linecap="round"/></g>
<text x="190" y="150" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="64" fill="#ecfeff">Tidepool</text>
<rect x="525" y="103" rx="20" width="130" height="40" fill="#14b8a6" fill-opacity=".18" stroke="#5eead4" stroke-opacity=".5"/><text x="590" y="130" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#5eead4">testnet</text>
<text x="80" y="290" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="58" fill="#ffffff">NEAR Intents testnet sandbox</text>
<text x="80" y="360" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#a5f3fc">1Click API-compatible · test tokens · faucet</text>
<text x="80" y="410" font-family="DejaVu Sans, sans-serif" font-size="28" fill="#99c9cf">Test swaps end to end without real funds</text>
<text x="80" y="480" font-family="DejaVu Sans Mono, monospace" font-size="24" fill="#5eead4">www.usetidepool.tech</text>
<text x="1120" y="480" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#cbe7ea">${esc(brand.affiliation)}</text>
</svg>`;
await sharp(Buffer.from(og)).png().toFile(path.join(pub, 'og.png'));
console.log('ok');
