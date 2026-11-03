// Free self-serve partner keys (naa_...) plus per-key and per-IP rate limits. Only the SHA-256 of a key is stored.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { fail } from './errors.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEYS_PER_IP_PER_DAY = 5;
const KEYS_PER_DAY_TOTAL = 2000;
export const REQUESTS_PER_MIN = 600;
export const MAX_AGENTS_PER_KEY = 25;

const ipHash = (ip) => sha256('tidepool-agent-ip:' + ip).slice(0, 24);
const bearer = (req) => {
  const h = req.headers.authorization;
  if (h && /^bearer /i.test(h)) return h.slice(7).trim();
  return String(req.headers['x-api-key'] || '').trim();
};

export function issueKey({ name } = {}, ip) {
  if (name !== undefined && (typeof name !== 'string' || name.length > 64)) throw fail(400, 'validation_failed', 'request', 'name must be a string of at most 64 characters');
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const mine = sql.prepare('SELECT COUNT(*) n FROM partner_keys WHERE ip_hash = ? AND created_at > ?').get(ipHash(ip), since).n;
  if (mine >= KEYS_PER_IP_PER_DAY) throw fail(429, 'rate_limited', 'request', `At most ${KEYS_PER_IP_PER_DAY} keys per IP per 24 hours. Reuse an existing key: keys do not expire.`, { retry_after_seconds: 3600 });
  if (sql.prepare('SELECT COUNT(*) n FROM partner_keys WHERE created_at > ?').get(since).n >= KEYS_PER_DAY_TOTAL) throw fail(429, 'rate_limited', 'request', 'Key issuance is temporarily at capacity, try again later', { retry_after_seconds: 3600 });
  const key = 'naa_' + crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(12).toString('hex');
  const created_at = new Date().toISOString();
  sql.prepare('INSERT INTO partner_keys (id, key_hash, prefix, name, ip_hash, created_at) VALUES (?,?,?,?,?,?)').run(id, sha256(key), key.slice(0, 8), name || null, ipHash(ip), created_at);
  return { api_key: key, api_key_id: id, tenant_id: id, name: name || null, created_at, limits: { requests_per_minute: REQUESTS_PER_MIN, max_agents: MAX_AGENTS_PER_KEY }, notes: 'Store this key now: it is shown once and only its hash is kept. Testnet only; no cost.' };
}

const hits = new Map();
export function authenticate(req) {
  const key = bearer(req);
  if (!key.startsWith('naa_')) throw fail(401, 'invalid_api_key', 'auth', 'Missing or malformed API key. Send "Authorization: Bearer naa_..." (get a free key with POST /v1/keys).');
  const row = sql.prepare('SELECT id, name FROM partner_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(key));
  if (!row) throw fail(401, 'invalid_api_key', 'auth', 'Unknown or revoked API key. Get a free key with POST /v1/keys.');
  const minute = Math.floor(Date.now() / 60_000);
  const h = hits.get(row.id);
  if (!h || h.minute !== minute) hits.set(row.id, { minute, n: 1 });
  else if (++h.n > REQUESTS_PER_MIN) throw fail(429, 'rate_limited', 'request', `Rate limit of ${REQUESTS_PER_MIN} requests per minute exceeded`, { retry_after_seconds: 60 - (Math.floor(Date.now() / 1000) % 60) });
  if (hits.size > 5000) for (const [k, v] of hits) if (v.minute !== minute) hits.delete(k);
  return { tenantId: row.id, keyName: row.name, requestsThisMinute: hits.get(row.id).n };
}
