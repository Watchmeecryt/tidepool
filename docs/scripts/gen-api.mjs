// Generates content/docs/api-reference/*.mdx from ../site/public/openapi.json (+ captured examples).
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const spec = JSON.parse(fs.readFileSync(path.join(here, '../../site/public/openapi.json'), 'utf8'));
const examples = JSON.parse(fs.readFileSync(path.join(here, 'examples.json'), 'utf8'));
const out = path.join(here, '../content/docs/api-reference');
const ORIGIN = spec.servers?.[0]?.url || 'https://www.usetidepool.tech';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const deref = s => { while (s?.$ref) s = s.$ref.split('/').slice(1).reduce((o, k) => o[k], spec); return s; };
const ICONS = { authenticate: 'Key', refresh: 'ArrowsClockwise', 'get-balances': 'Wallet', 'get-history': 'Receipt', 'get-tokens': 'CurrencyCircleDollar', 'get-quote': 'Calculator', 'get-execution-status': 'Pulse', 'get-any-input-quote-withdrawals': 'HandWithdraw', 'submit-deposit-tx': 'PaperPlaneTilt', 'generate-intent': 'MagicWand', 'submit-intent': 'PaperPlaneRight', 'create-order': 'PlusCircle', 'list-orders': 'ListBullets', 'cancel-order': 'XCircle', 'get-order': 'FileText', 'tidepool-faucet': 'Drop', 'tidepool-health': 'Heartbeat' }; // Phosphor names, resolved in lib/icons.tsx
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').replace(/[{}<>]/g, c => `&#${c.charCodeAt(0)};`);
const tname = s => { const r = s.$ref?.split('/').pop(); s = deref(s); if (r) return r; if (s.type === 'array') return `${tname(s.items || {})}[]`; if (s.enum) return s.enum.map(e => `"${e}"`).join(' \\| '); if (s.oneOf || s.anyOf) return (s.oneOf || s.anyOf).map(tname).join(' \\| '); return s.type || 'object'; };

function example(s, depth = 0) {
  s = deref(s);
  if (!s || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map(x => example(x, depth + 1)));
  if (s.oneOf || s.anyOf) return example((s.oneOf || s.anyOf)[0], depth + 1);
  if (s.type === 'array') return [example(s.items, depth + 1)];
  if (s.type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, example(v, depth + 1)]));
  return { string: 'string', integer: 0, number: 0, boolean: true }[s.type] ?? null;
}

function fields(s, prefix = '', rows = [], depth = 0, seen = new Set()) {
  const ref = s.$ref; s = deref(s);
  if (!s || depth > 3 || (ref && seen.has(ref))) return rows;
  if (ref) seen = new Set([...seen, ref]);
  if (s.type === 'array') return fields(s.items || {}, prefix + '[]', rows, depth, seen);
  if (s.allOf) { for (const x of s.allOf) fields(x, prefix, rows, depth, seen); return rows; }
  const req = new Set(s.required || []);
  for (const [k, v] of Object.entries(s.properties || {})) {
    if (k === 'simulate' && /quoteRequest\.$/.test(prefix)) continue; // Tidepool strips simulate from the echoed quoteRequest
    const d = deref(v);
    rows.push(`| \`${prefix}${k}\` | ${esc(tname(v))} | ${req.has(k) ? 'yes' : ''} | ${esc(d.description || v.description)} |`);
    const inner = d.type === 'array' ? deref(d.items || {}) : d;
    if (inner?.properties || inner?.allOf) fields(v, `${prefix}${k}${d.type === 'array' ? '[]' : ''}.`, rows, depth + 1, seen);
  }
  return rows;
}
const table = rows => rows.length ? `| Field | Type | Required | Description |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n` : '';
const json = v => '```json\n' + JSON.stringify(v, null, 2) + '\n```';

const pages = [];
for (const [p, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(ops)) {
  const slug = kebab(op.operationId);
  const ex = examples[op.operationId] || {};
  const M = method.toUpperCase();
  const tidepoolOnly = op.operationId.startsWith('Tidepool');
  const body = op.requestBody?.content?.['application/json']?.schema;
  const reqEx = ex.request ?? (body ? example(body) : undefined);
  const query = (op.parameters || []).filter(x => x.in === 'query');
  const qs = ex.query ? '?' + new URLSearchParams(ex.query) : '';
  const auth = op.security?.length || spec.security?.length;
  let curl = `curl${M === 'GET' ? '' : ` -X ${M}`} "${ORIGIN}${p}${qs}"`;
  if (body) curl += ` \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(reqEx, null, 2).replace(/'/g, "'\\''")}'`;
  const fetchJs = `const res = await fetch('${ORIGIN}${p}${qs}'${body ? `, {\n  method: '${M}',\n  headers: { 'content-type': 'application/json' },\n  body: JSON.stringify(${JSON.stringify(reqEx, null, 2).replace(/\n/g, '\n  ')}),\n}` : (M !== 'GET' ? `, { method: '${M}' }` : '')});\nconst data = await res.json();`;
  let md = `---\ntitle: ${JSON.stringify((op.summary || op.operationId).replace(/ \(.*\)$/, ""))}\nicon: ${ICONS[slug] || 'Code'}\ndescription: ${JSON.stringify(`${M} ${p}${tidepoolOnly ? ' · Tidepool extension' : ' · 1Click-compatible'}`)}\n---\n\n`;
  md += `<p><span className="tp-method tp-${method}">${M}</span><code>{${JSON.stringify(p)}}</code></p>\n\n`;
  if (tidepoolOnly) md += `<Callout title="Tidepool extension">This endpoint is not part of the 1Click API. Do not call it on mainnet.</Callout>\n\n`;
  if (ex.notes) md += ex.notes + '\n\n';
  if (op.description) md += esc(op.description).replace(/&#96;/g, '`') + '\n\n';
  md += `**Operation id:** \`${op.operationId}\`${auth ? ' · **Auth:** optional (`X-API-Key` or `Authorization: Bearer`, any value)' : ''}\n\n`;
  md += `## Request\n\n<Tabs items={['curl', 'JavaScript']}>\n<Tab value="curl">\n\n\`\`\`bash\n${curl}\n\`\`\`\n\n</Tab>\n<Tab value="JavaScript">\n\n\`\`\`ts\n${fetchJs}\n\`\`\`\n\n</Tab>\n</Tabs>\n\n`;
  if (ex.tryIt) md += `### Try it\n\n<TryIt method="${M}" path={${JSON.stringify(p + qs)}}${body ? ` body={${JSON.stringify(JSON.stringify(reqEx, null, 2))}}` : ''} />\n\n`;
  if (query.length) md += `### Query parameters\n\n| Name | Type | Required | Description |\n| --- | --- | --- | --- |\n${query.map(q => `| \`${q.name}\` | ${tname(q.schema || {})} | ${q.required ? 'yes' : ''} | ${esc(q.description)} |`).join('\n')}\n\n`;
  if (body) md += `### Body\n\n${table(fields(body))}\n`;
  md += `## Responses\n\n`;
  for (const [code, r] of Object.entries(op.responses)) {
    const sch = r.content?.['application/json']?.schema;
    md += `### ${code} ${esc(r.description || '')}\n\n`;
    const rex = ex.responses?.[code] ?? (sch ? example(sch) : null);
    if (rex != null) md += json(rex) + '\n\n';
    if (sch && code.startsWith('2')) { const t = fields(sch); if (t.length) md += `<Accordions><Accordion title="Response fields">\n\n${table(t)}\n</Accordion></Accordions>\n\n`; }
  }
  fs.writeFileSync(path.join(out, slug + '.mdx'), md);
  pages.push({ slug, M, p, summary: op.summary, tidepoolOnly });
}

let idx = `---\ntitle: API reference\nicon: BookOpen\ndescription: Every Tidepool endpoint, generated from openapi.json.\n---\n\nBase URL: \`${ORIGIN}\` · Spec: [\`/openapi.json\`](/openapi.json) (the full 1Click Swap API v0.1.10 surface, plus two Tidepool extensions).\n\nAll amounts are strings in the token's base units. Errors on the swap, auth and account endpoints return \`{ "message": "…" }\` with HTTP 400 (bad input), 401 (\`/v0/account/*\` without a valid token), 404 (unknown deposit address), 429 (rate limited) or 503 (a bridge route is not configured, or its treasury is low); quote 400s also carry \`hint\`, \`field\` and \`exampleRequest\`. \`/v0/orders\` follows 1Click and returns JSON:API \`{ "errors": [{ "status", "code", "title", "detail" }] }\` (400, 401, 403, 404, 409 or 500). CORS is open (\`*\`).\n\n| Method | Path | What it does | |\n| --- | --- | --- | --- |\n`;
idx += pages.map(x => `| <span className="tp-method tp-${x.M.toLowerCase()}">${x.M}</span> | [\`${x.p}\`](/docs/api-reference/${x.slug}) | ${x.summary.replace(/ \(.*\)$/, "")} | ${x.tidepoolOnly ? 'Tidepool only' : '1Click'} |`).join('\n') + '\n\n## Authentication\n\nOptional for swaps. Send any `X-API-Key: <anything>` or `Authorization: Bearer <anything>` to get the lower fee tier. See [Quotes](/docs/concepts/quotes#fees). `/v0/account/*` needs a free JWT from [`/v0/auth/authenticate`](/docs/api-reference/authenticate); `/v0/orders` needs a JWT or any `X-API-Key`.\n';
fs.writeFileSync(path.join(out, 'index.mdx'), idx);
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ title: 'API reference', pages: ['index', ...pages.map(x => x.slug)] }, null, 2));
console.log(`generated ${pages.length} endpoint pages`);
